/**
 * ADR-205 stage 2 end to end: the live projection over transcripts in the
 * on-disk shapes of ten providers (see __fixtures__/session-share-live/README.md
 * and __fixtures__/session-share/README.md). Each case lays the fixture where
 * the provider reads it, registers the session in a database, and runs the
 * production read path (owner read gate, unleased provider reader, author
 * stamping) through the projection. It also covers readFailed at the provider
 * failure sites, peek === fetch revision, N1 identity stability, and guests
 * staying off the bounded member history runner.
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  closeConnection, getConnection, initializeDatabase, messageAuthorsDb, participantsDb, sessionsDb, userDb,
} from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { historyAdmission } from '@/modules/providers/services/history-budget.service.js';
import { peekHistoryRevision } from '@/modules/providers/services/session-history-light.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { vendorProjectHash } from '@/modules/providers/shared/vendor/vendor-transcript.js';

import { createBoundedSemaphore } from './bounded-semaphore.js';
import {
  LIVE_PROJECTION_LIMITS, LiveProjectionError, createLiveProjection, defaultLiveProjectionDeps, type LiveMessagesResponse,
} from './session-share-live-projection.js';

const BASE = path.join(import.meta.dirname, '__fixtures__', 'session-share');
const LIVE = path.join(import.meta.dirname, '__fixtures__', 'session-share-live');
const PROJECT = '/home/operator/Project/demo';
// Assembled at runtime so no literal token sits in the tree (leak gates).
const SECRET = ['gh', 'p_', 'Ab1'.repeat(12)].join('');
const PNG = `data:image/png;base64,${Buffer.from('fixture-png').toString('base64')}`;
const share = { shareId: 'd'.repeat(32), refKey: randomBytes(32) };

await initializeDatabase();
const ownerId = userDb.createUser('live-owner', 'hash-o', 'user').id;
const memberId = userDb.createUser('live-member', 'hash-m', 'user').id;

const newProjection = () => createLiveProjection({
  ...defaultLiveProjectionDeps, home: () => '/home/operator',
  semaphore: createBoundedSemaphore(LIVE_PROJECTION_LIMITS.semaphore),
});

function write(target: string, lines: string[]): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.join('\n')}\n`);
  return target;
}
/** Fixture lines with the secret placeholder filled and the recorded session id rebound to `sessionId`. */
const fixtureLines = (dir: string, name: string, recordedId?: string, sessionId?: string) => fs.readFileSync(path.join(dir, name), 'utf8')
  .split('\n').filter(Boolean).map((line) => line.replaceAll('__SECRET__', SECRET))
  .map((line) => (recordedId && sessionId ? line.replaceAll(recordedId, sessionId) : line));

function register(sessionId: string, provider: string, projectPath: string, jsonlPath?: string): void {
  sessionsDb.createSession(sessionId, provider, projectPath, undefined, undefined, undefined, jsonlPath ?? null);
  participantsDb.recordSpawn(sessionId, ownerId);
}

/** Every message of a live projection, oldest first, through the guest paging contract. */
async function readAll(projection: ReturnType<typeof newProjection>, sessionId: string): Promise<LiveMessagesResponse['messages']> {
  let page = await projection.readMessages({ sessionId, ownerUserId: ownerId, share });
  const all = [...page.messages];
  while (page.moreBefore) {
    page = await projection.readMessages({ sessionId, ownerUserId: ownerId, share, before: page.messages[0].c });
    all.unshift(...page.messages);
  }
  return all;
}

type Summary = { role: string; author: string; text: string; parts: string[] };
const summarize = (messages: LiveMessagesResponse['messages']): Summary[] => messages.map((message) => ({
  role: message.role, author: message.author,
  text: message.parts.map((part) => ('text' in part && part.t === 'text' ? part.text : '')).join(''),
  parts: message.parts.filter((part) => part.t !== 'text').map((part) => (part.t === 'redacted' ? `redacted:${part.cat}` : part.t)),
}));

/** Invariants for every provider: no tool payloads, thinking, harness tags, raw secret or locator detail. */
function assertClean(messages: LiveMessagesResponse['messages'], sessionId: string): void {
  const json = JSON.stringify(messages);
  for (const leaked of [SECRET, sessionId, 'system-reminder', 'command-name', 'fixture: tool output', 'fixture-signature',
    'fixture-encrypted', 'chat-images', 'base64', '/home/operator', '"userId"', '"id"', '"toolName"']) {
    assert.ok(!json.includes(leaked), `projection leaks ${leaked}`);
  }
  assert.ok(messages.some((m) => m.parts.some((part) => part.t === 'redacted' && part.cat === 'secret')), 'the secret is redacted');
}

const claudeDir = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(SANDBOX_HOME, '.claude'), 'projects');
const vendorFile = (provider: string, sessionId: string) =>
  path.join(SANDBOX_HOME, '.nassaj-vendor-sessions', provider, vendorProjectHash(PROJECT), `${sessionId}.jsonl`);

/** Claude: the base fixture plus a files-note prompt with a secret, an image fence reply, and a timestamp-less row. */
function placeClaude(sessionId: string): string {
  const lines = fixtureLines(BASE, 'claude.jsonl', '00000000-0000-4000-a000-000000000013', sessionId);
  const user = JSON.parse(lines[0]);
  const reply = JSON.parse(lines[5]);
  const files = { ...user, uuid: '00000000-0000-4000-9000-000000000101', timestamp: undefined, message: { role: 'user',
    content: `خذ هذا التقرير، ومفتاحي ${SECRET}\n\n[Files provided at the following paths:]\n1. .nassaj-uploads/inbox/report.pdf` } };
  const fence = { ...reply, uuid: '00000000-0000-4000-9000-000000000102', parentUuid: files.uuid,
    message: { ...reply.message, id: 'msg_10000000-0101', content: [{ type: 'text',
      text: 'هذا الرسم:\n```image\n/home/operator/Project/General/out/chart.png\n```' }] } };
  const target = path.join(claudeDir(), '-home-operator-Project-General', `${sessionId}.jsonl`);
  return write(target, [...lines, JSON.stringify(files), JSON.stringify(fence)]);
}

function placeCodex(sessionId: string): string {
  const lines = fixtureLines(BASE, 'codex.jsonl', '00000000-0000-7000-9000-000000000001', sessionId);
  const prompt = JSON.parse(lines[3]);
  const withImage = { ...prompt, timestamp: '2026-09-01T15:20:00.000Z', payload: { ...prompt.payload,
    content: [{ type: 'input_text', text: `هذه لقطة الشاشة، والمفتاح ${SECRET}` }, { type: 'input_image', image_url: PNG }] } };
  return write(path.join(SANDBOX_HOME, '.codex', 'sessions', '2026', '09', '01', `rollout-2026-09-01T17-24-33-${sessionId}.jsonl`),
    [...lines, JSON.stringify(withImage)]);
}

function placeAntigravity(sessionId: string): string {
  const lines = fixtureLines(BASE, 'antigravity.jsonl', '00000000-0000-4000-9000-000000000017', sessionId);
  const last = JSON.parse(lines[5]);
  const extra = { ...last, step_index: 6, content: `Done. The leaked key ${SECRET} should be rotated.` };
  return write(path.join(SANDBOX_HOME, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs',
    'transcript.jsonl'), [...lines, JSON.stringify(extra)]);
}

function placeVendor(provider: string, sessionId: string, dir: string, name: string): void {
  const lines = fixtureLines(dir, name);
  if (provider === 'kimi') {
    lines.push(JSON.stringify({ type: 'message', message: { role: 'assistant', content: `جرّب تسجيل الدخول مجدداً، ولا تشارك ${SECRET}` } }));
  }
  write(vendorFile(provider, sessionId), lines);
}

function placeOpenCode(): string {
  const data = JSON.parse(fs.readFileSync(path.join(BASE, 'opencode.json'), 'utf8')) as {
    sessionId: string;
    messages: Array<{ id: string; time_created: number; data: unknown }>;
    parts: Array<{ id: string; message_id: string; time_created: number; data: { type: string; text?: string } & Record<string, unknown> }>;
  };
  // D9: the user's first prompt carried an image and a file, recorded as OpenCode `file` parts.
  const userMessages = new Set(data.messages.filter((m) => (m.data as { role?: string }).role === 'user').map((m) => m.id));
  const firstPrompt = data.parts.find((part) => part.data.type === 'text' && userMessages.has(part.message_id))!;
  data.parts.push(
    { id: 'prt_fixture_file_img', message_id: firstPrompt.message_id, time_created: firstPrompt.time_created - 1,
      data: { type: 'file', mime: 'image/png', filename: 'mockup.png', url: 'file:///tmp/opencode-img/mockup.png' } },
    { id: 'prt_fixture_file_doc', message_id: firstPrompt.message_id, time_created: firstPrompt.time_created + 1,
      data: { type: 'file', mime: 'application/pdf', filename: 'brief.pdf', url: 'file:///srv/demo/.nassaj-uploads/inbox/brief.pdf' } },
  );
  const lastText = [...data.parts].reverse().find((part) => part.data.type === 'text')!;
  data.parts.push({ ...lastText, id: 'prt_fixture_secret', time_created: lastText.time_created + 1,
    data: { type: 'text', text: `ملاحظة: المفتاح ${SECRET} مكشوف.` } });
  const dbDir = path.join(SANDBOX_HOME, '.local', 'share', 'opencode');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new Database(path.join(dbDir, 'opencode.db'));
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);`);
  for (const m of data.messages) db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(m.id, data.sessionId, m.time_created, JSON.stringify(m.data));
  for (const p of data.parts) {
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(p.id, data.sessionId, p.message_id, p.time_created, JSON.stringify(p.data));
  }
  db.close();
  return data.sessionId;
}

function placeCursor(sessionId: string): void {
  const { blobs } = JSON.parse(fs.readFileSync(path.join(LIVE, 'cursor.json'), 'utf8').replaceAll('__SECRET__', SECRET)) as { blobs: unknown[] };
  const dir = path.join(SANDBOX_HOME, '.cursor', 'chats', createHash('md5').update(PROJECT).digest('hex'), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'store.db'));
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  for (const blob of blobs) {
    const data = Buffer.from(JSON.stringify(blob));
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(createHash('sha256').update(data).digest('hex'), data);
  }
  db.close();
}

const SESSIONS = {
  claude: '00000000-0000-4000-a000-000000000201',
  codex: '00000000-0000-4000-9000-000000000202',
  antigravity: '00000000-0000-4000-9000-000000000203',
  kimi: 'kimi_00000000-0000-4000-8000-000000000204',
  qwen: '00000000-0000-4000-8000-000000000205',
  hermes: '00000000-0000-4000-8000-000000000206',
  glm: '00000000-0000-4000-8000-000000000207',
  deepseek: '00000000-0000-4000-8000-000000000208',
  cursor: '00000000-0000-4000-8000-000000000209',
} as const;

/** Lays out every provider fixture once; returns provider → session id. */
function placeAll(): Record<string, string> {
  register(SESSIONS.claude, 'claude', '/home/operator/Project/General', placeClaude(SESSIONS.claude));
  register(SESSIONS.codex, 'codex', PROJECT, placeCodex(SESSIONS.codex));
  register(SESSIONS.antigravity, 'antigravity', PROJECT, placeAntigravity(SESSIONS.antigravity));
  placeVendor('kimi', SESSIONS.kimi, BASE, 'kimi.jsonl');
  for (const provider of ['qwen', 'hermes', 'glm', 'deepseek'] as const) placeVendor(provider, SESSIONS[provider], LIVE, `${provider}.jsonl`);
  for (const provider of ['kimi', 'qwen', 'hermes', 'glm', 'deepseek'] as const) register(SESSIONS[provider], provider, PROJECT);
  placeCursor(SESSIONS.cursor);
  register(SESSIONS.cursor, 'cursor', PROJECT);
  const opencode = placeOpenCode();
  register(opencode, 'opencode', PROJECT);
  return { ...SESSIONS, opencode };
}

const placed = placeAll();

type Expected = Array<[role: 'user' | 'assistant', has: string, parts?: string[]]>;
const SECRET_PART = ['redacted:secret'];
const EXPECTED: Record<string, Expected> = {
  // The inbox file of the note is not on disk here: policy (a) withholds it (N2).
  claude: [['user', 'خذ هذا التقرير', ['redacted:secret', 'attachment-unavailable']], ['user', 'كيف استفيد من هذي', ['image']],
    ['assistant', 'مخصص لجلسات Claude السحابية'], ['assistant', 'هذا الرسم:', ['image']],
    ['user', 'يعني اذا طلبت منك'], ['assistant', 'نعم، عن طريق وكيل سحابي']],
  codex: [['user', 'ليش ماني قادر ابدأ محادثة'], ['assistant', 'سأفحص حالة مشروع'], ['assistant', 'فحصت البيئة'],
    ['assistant', 'السبب واضح'], ['assistant', 'تم التحقق'], ['user', 'هذه لقطة الشاشة', ['redacted:secret', 'image']]],
  antigravity: [['user', 'Do not modify'], ['assistant', 'Waiting for the subagent'], ['assistant', 'Successfully read marker'],
    ['assistant', 'The leaked key', SECRET_PART]],
  kimi: [['user', 'تسجيل دخول من هيرميز'], ['assistant', 'جرّب تسجيل الدخول', SECRET_PART]],
  qwen: [['user', 'راجع ملف الإعدادات'], ['assistant', 'الملف سليم', SECRET_PART], ['user', 'شكراً']],
  hermes: [['user', 'مرحبا'], ['assistant', 'أهلاً!'], ['user', 'خطوات تثبيت'], ['assistant', 'استنسخ المستودع', SECRET_PART],
    ['user', 'مرحبا']],
  glm: [['user', 'لخص ملف README'], ['assistant', 'الملف يشرح طريقة التشغيل. وفيه مفتاح ظاهر', SECRET_PART]],
  deepseek: [['user', 'لخص ملف README'], ['assistant', 'الملف يشرح طريقة التشغيل. وفيه مفتاح ظاهر', SECRET_PART]],
  cursor: [['user', 'أين تُعرّف إعدادات الخادم'], ['assistant', 'server/config.js', SECRET_PART], ['user', 'انقله إلى متغيّر بيئة'],
    ['assistant', 'صار يُقرأ من متغيّر البيئة']],
  opencode: [['user', 'تصميم موقع', ['attachment-unavailable', 'attachment-unavailable']], ['assistant', 'حسب نوع الموقع'], ['user', 'تصميم موقع'], ['assistant', 'نفس الخطوات السابقة'],
    ['user', 'ردود ديب سيك ما تظهر'], ['assistant', 'مشكلة معروفة في opencode'], ['assistant', 'ملاحظة: المفتاح', SECRET_PART]],
};

for (const [provider, expected] of Object.entries(EXPECTED)) {
  test(`${provider}: the projection keeps exactly the user and main-agent text; attachments match the inventory`, async () => {
    const messages = await readAll(newProjection(), placed[provider]);
    assertClean(messages, placed[provider]);
    const summary = summarize(messages);
    assert.equal(summary.length, expected.length, JSON.stringify(summary.map((m) => [m.role, m.text.slice(0, 30)])));
    expected.forEach(([role, has, parts = []], index) => {
      assert.equal(summary[index].role, role, `${provider} #${index} role`);
      assert.ok(summary[index].text.includes(has), `${provider} #${index} text: ${summary[index].text.slice(0, 60)}`);
      assert.deepEqual(summary[index].parts, parts, `${provider} #${index} parts`);
    });
  });
}

test('authors come from recorded attribution: owner for the owner, member for anyone else or nobody', async () => {
  const sessionId = placed.qwen;
  messageAuthorsDb.recordUserMessage(sessionId, ownerId, 'شكراً');
  messageAuthorsDb.recordUserMessage(sessionId, memberId, 'راجع ملف الإعدادات واخبرني إن كان فيه مشكلة');
  const summary = summarize(await readAll(newProjection(), sessionId));
  assert.deepEqual(summary.map((m) => m.author), ['member', 'assistant', 'owner']);
});

test('a failed author load makes every human row «member», never «owner»', async (t) => {
  const sessionId = placed.qwen;
  messageAuthorsDb.recordUserMessage(sessionId, ownerId, 'شكراً');
  t.mock.method(messageAuthorsDb, 'listBySession', () => { throw new Error('authors table unavailable'); });
  t.mock.method(console, 'error', () => {});
  const summary = summarize(await readAll(newProjection(), sessionId));
  assert.ok(summary.some((m) => m.role === 'user'));
  assert.deepEqual([...new Set(summary.filter((m) => m.role === 'user').map((m) => m.author))], ['member']);
});

test('N1: two parses of Cursor (parse-time timestamps), Hermes and Claude (timestamp-less rows) yield the same keys', async () => {
  for (const provider of ['cursor', 'hermes', 'claude']) {
    const first = (await readAll(newProjection(), placed[provider])).map((m) => m.k);
    const second = (await readAll(newProjection(), placed[provider])).map((m) => m.k);
    assert.deepEqual(second, first, provider);
    assert.equal(new Set(first).size, first.length);
  }
});

test('peek === fetch revision on an idle transcript, for every provider', async () => {
  for (const [provider, sessionId] of Object.entries(placed)) {
    const peek = await peekHistoryRevision(sessionId, ownerId);
    const fetched = await sessionsService.fetchHistory(sessionId, ownerId, { limit: null, snapshotCache: 'coalesce-only' });
    assert.ok(!peek.readFailed, provider);
    assert.equal(peek.revision, fetched.revision, provider);
  }
});

const isUnavailable = (error: unknown) => error instanceof LiveProjectionError && error.code === 'HISTORY_UNAVAILABLE';

test('readFailed: a rebound transcript is 503 for guests and flagged for members, never an empty conversation', async () => {
  const sessionId = '00000000-0000-4000-a000-000000000301';
  const foreign = path.join(claudeDir(), '-home-operator-Project-General', `${sessionId}.jsonl`);
  write(foreign, fixtureLines(BASE, 'claude.jsonl'));
  register(sessionId, 'claude', '/home/operator/Project/General', foreign);
  assert.equal((await peekHistoryRevision(sessionId, ownerId)).readFailed, true);
  const member = await sessionsService.fetchHistory(sessionId, ownerId, {});
  assert.equal(member.readFailed, true);
  assert.deepEqual(member.messages, []);
  await assert.rejects(newProjection().readMessages({ sessionId, ownerUserId: ownerId, share }), isUnavailable);
});

test('readFailed at provider failure sites: missing vendor transcript, missing brain, missing cursor store, catch on a dead fd', async () => {
  const cases = [['qwen', '00000000-0000-4000-8000-000000000302'], ['antigravity', '00000000-0000-4000-9000-000000000303'],
    ['cursor', '00000000-0000-4000-8000-000000000304']] as const;
  for (const [provider, sessionId] of cases) {
    register(sessionId, provider, PROJECT);
    assert.equal((await sessionsService.fetchHistory(sessionId, ownerId, {})).readFailed, true, provider);
  }
  const rollout = path.join(SANDBOX_HOME, 'dead-fd.jsonl');
  write(rollout, fixtureLines(BASE, 'codex.jsonl'));
  const fd = await fs.promises.open(rollout, 'r');
  const stat = await fd.stat({ bigint: true });
  await fd.close();
  const dead = { fd, realpath: rollout, stat, sessionId: 'dead', provider: 'codex' };
  const result = await providerRegistry.resolveHistorySessions('codex').fetchHistory('dead', { transcript: dead, limit: null });
  assert.equal(result.readFailed, true, 'the read error is a failed read, not an empty conversation');
});

test('readFailed when the OpenCode database is absent', async () => {
  const dbFile = path.join(SANDBOX_HOME, '.local', 'share', 'opencode', 'opencode.db');
  fs.renameSync(dbFile, `${dbFile}.away`);
  try {
    assert.equal((await sessionsService.fetchHistory(placed.opencode, ownerId, {})).readFailed, true);
  } finally {
    fs.renameSync(`${dbFile}.away`, dbFile);
  }
});

test('bounded mode: guests never take historyAdmission while members still read; sourceOversized is a guest 503', async (t) => {
  process.env.NASSAJ_BOUNDED_HISTORY = '1';
  t.after(() => { delete process.env.NASSAJ_BOUNDED_HISTORY; });
  const acquire = historyAdmission.acquire.bind(historyAdmission);
  let admissions = 0;
  t.mock.method(historyAdmission, 'acquire', (...args: Parameters<typeof acquire>) => { admissions += 1; return acquire(...args); });
  const projection = newProjection();
  const guests = Array.from({ length: 6 }, () => readAll(projection, placed.claude));
  let memberRows = 0;
  await sessionsService.withHistoryLeaseCallback(placed.claude, ownerId, { payloadMode: 'full' }, new AbortController().signal,
    (payload) => { memberRows = payload.messages.length; });
  assert.ok((await Promise.all(guests)).every((messages) => messages.length === EXPECTED.claude.length));
  assert.equal(admissions, 1, 'only the member read took the bounded runner');
  assert.ok(memberRows > 0);
  getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run(`/${'p'.repeat(5000)}`, placed.kimi);
  await assert.rejects(newProjection().readMessages({ sessionId: placed.kimi, ownerUserId: ownerId, share }), isUnavailable);
});

test.after(() => closeConnection());
