/**
 * ADR-196 / T-1970 stage 3: the snapshot builder end to end on transcripts
 * in the on-disk shapes of five providers (see
 * __fixtures__/session-share/README.md). Each case lays the fixture where the
 * live provider reads it, registers the session and its spawn owner in a real
 * database, and runs the production pipeline (read gate, provider reader,
 * strict author stamping, sanitizer). The assertions are invariants: no tool
 * payloads, thinking, harness tags, paths or ids reach the snapshot, while the
 * human and assistant text does.
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  closeConnection,
  initializeDatabase,
  messageAuthorsDb,
  participantsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { vendorProjectHash } from '@/modules/providers/shared/vendor/vendor-transcript.js';

import { buildSessionShareSnapshot, defaultSnapshotDeps, type ShareSnapshotResult } from './session-share-snapshot.js';

const FIXTURES = path.join(import.meta.dirname, '__fixtures__', 'session-share');
const FIXTURE_HOME = '/home/operator';
const deps = { ...defaultSnapshotDeps, home: () => FIXTURE_HOME };

await initializeDatabase();
const ownerId = userDb.createUser('share-owner', 'hash-o', 'user').id;
const memberId = userDb.createUser('share-member', 'hash-m', 'user').id;

function place(target: string, fixture: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, fixture), target);
  return target;
}

function register(sessionId: string, provider: string, projectPath: string, jsonlPath?: string): void {
  sessionsDb.createSession(sessionId, provider, projectPath, undefined, undefined, undefined, jsonlPath ?? null);
  participantsDb.recordSpawn(sessionId, ownerId);
}

function snapshotText(result: ShareSnapshotResult): string {
  return JSON.stringify(result.snapshot);
}

/** Invariants every provider's snapshot must hold. */
function assertClean(result: ShareSnapshotResult, sessionId: string): void {
  assert.deepEqual(result.blockers, []);
  assert.ok(result.snapshot && result.snapshot.messages.length > 0, 'something is shared');
  const json = snapshotText(result);
  for (const leaked of [FIXTURE_HOME, sessionId, 'system-reminder', 'command-name', 'fixture: tool output',
    'fixture-signature', 'fixture-encrypted', 'chat-images', '"model"', '"userId"', '"id"']) {
    assert.ok(!json.includes(leaked), `snapshot leaks ${leaked}`);
  }
  assert.match(result.sha256 ?? '', /^[a-f0-9]{64}$/);
}

const claudeDir = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(SANDBOX_HOME, '.claude'), 'projects');

test('claude: tool rows, thinking, slash commands, sidechain and image paths are dropped', async () => {
  const sessionId = '00000000-0000-4000-a000-000000000013';
  const file = place(path.join(claudeDir(), '-home-operator-Project-General', `${sessionId}.jsonl`), 'claude.jsonl');
  register(sessionId, 'claude', '/home/operator/Project/General', file);
  const result = await buildSessionShareSnapshot({ sessionId, readerUserId: ownerId }, deps);
  assertClean(result, sessionId);
  const json = snapshotText(result);
  assert.ok(json.includes('كيف استفيد من هذي وانا داخل نساج'), 'the human prompt survives');
  assert.ok(json.includes('مخصص لجلسات Claude السحابية'), 'the assistant answer survives');
  assert.ok(!json.includes('SubagentHandback'), 'sidechain row is dropped');
  assert.ok(result.counts.toolCount >= 1);
  assert.ok(result.counts.image >= 1);
  assert.equal(result.snapshot?.providerLabel, 'Claude');
  assert.ok(result.snapshot?.messages.every((m) => m.author === (m.role === 'user' ? 'owner' : 'assistant')));
});

test('claude: the bounded history reader feeds the memory sink to the same snapshot', async () => {
  const sessionId = '00000000-0000-4000-a000-000000000013';
  const unbounded = await buildSessionShareSnapshot({ sessionId, readerUserId: ownerId }, deps);
  process.env.NASSAJ_BOUNDED_HISTORY = '1';
  try {
    const bounded = await buildSessionShareSnapshot({ sessionId, readerUserId: ownerId }, deps);
    assert.equal(bounded.sha256, unbounded.sha256);
  } finally {
    delete process.env.NASSAJ_BOUNDED_HISTORY;
  }
});

test('claude: a second participant turns unattributed prompts into a blocker', async () => {
  const sessionId = '00000000-0000-4000-a000-000000000013';
  participantsDb.recordSpawn(sessionId, memberId);
  try {
    const result = await buildSessionShareSnapshot({ sessionId, readerUserId: ownerId }, deps);
    assert.equal(result.snapshot, null);
    assert.equal(result.blockers[0]?.code, 'UNATTRIBUTED_MULTI_PARTICIPANT');
  } finally {
    sessionsDb.deleteSessionById(sessionId);
  }
});

test('codex: injected context, reasoning, tool calls and agent traffic are dropped', async () => {
  const sessionId = '00000000-0000-7000-9000-000000000001';
  const file = place(path.join(SANDBOX_HOME, '.codex', 'sessions', '2026', '09', '01',
    `rollout-2026-09-01T17-24-33-${sessionId}.jsonl`), 'codex.jsonl');
  register(sessionId, 'codex', '/home/operator/Project/nassaj-dev', file);
  const blocked = await buildSessionShareSnapshot({ sessionId, readerUserId: ownerId }, deps);
  assert.equal(blocked.blockers[0]?.code, 'UNATTRIBUTED_NEEDS_CONFIRMATION');
  const result = await buildSessionShareSnapshot({ sessionId, readerUserId: ownerId, confirmUnattributed: true }, deps);
  assertClean(result, sessionId);
  const json = snapshotText(result);
  assert.ok(json.includes('ليش ماني قادر ابدأ محادثة'), 'the human prompt survives');
  assert.ok(json.includes('السبب واضح'), 'the assistant answer survives');
  for (const leaked of ['recommended_plugins', 'AGENTS.md', 'environment_context', 'Message Type:', 'permissions instructions']) {
    assert.ok(!json.includes(leaked), `snapshot leaks ${leaked}`);
  }
  assert.equal(result.snapshot?.providerLabel, 'Codex');
});

test('codex: a recorded owner prompt is attributed; a member prompt blocks', async () => {
  const sessionId = '00000000-0000-7000-9000-000000000001';
  messageAuthorsDb.recordUserMessage(sessionId, memberId, 'ليش ماني قادر ابدأ محادثة في مشروع نساج-اب ؟ ');
  try {
    const result = await buildSessionShareSnapshot({ sessionId, readerUserId: ownerId, confirmUnattributed: true }, deps);
    assert.equal(result.snapshot, null);
    assert.ok(result.blockers.some((blocker) => blocker.code === 'FOREIGN_AUTHOR'));
  } finally {
    sessionsDb.deleteSessionById(sessionId);
  }
});

test('antigravity: planner thinking, tool calls and system messages are dropped', async () => {
  const sessionId = '00000000-0000-4000-9000-000000000017';
  const file = place(path.join(SANDBOX_HOME, '.gemini', 'antigravity-cli', 'brain', sessionId,
    '.system_generated', 'logs', 'transcript.jsonl'), 'antigravity.jsonl');
  register(sessionId, 'antigravity', '/var/tmp/adr191-agy-real-smoke', file);
  const result = await buildSessionShareSnapshot({ sessionId, readerUserId: ownerId, confirmUnattributed: true }, deps);
  assertClean(result, sessionId);
  const json = snapshotText(result);
  assert.ok(json.includes('Waiting for the subagent'), 'the assistant answer survives');
  for (const leaked of ['USER_REQUEST', 'SYSTEM_MESSAGE', 'logAbsoluteUri', 'The objective is to leverage']) {
    assert.ok(!json.includes(leaked), `snapshot leaks ${leaked}`);
  }
});

test('kimi: the vendor transcript shares the owner prompt', async () => {
  const sessionId = 'kimi_1c3f9036-33ed-48c2-81ca-c90e435f2ef6';
  const projectPath = '/home/operator/Project/nassaj-dev';
  place(path.join(SANDBOX_HOME, '.nassaj-vendor-sessions', 'kimi', vendorProjectHash(projectPath), `${sessionId}.jsonl`),
    'kimi.jsonl');
  register(sessionId, 'kimi', projectPath);
  const result = await buildSessionShareSnapshot({ sessionId, readerUserId: ownerId, confirmUnattributed: true }, deps);
  assertClean(result, sessionId);
  assert.ok(snapshotText(result).includes('تسجيل دخول من هيرميز'));
  assert.equal(result.snapshot?.providerLabel, 'Kimi');
});

test('opencode: reasoning, step and tool parts are dropped', async () => {
  const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'opencode.json'), 'utf8')) as {
    sessionId: string;
    messages: Array<{ id: string; time_created: number; data: unknown }>;
    parts: Array<{ id: string; message_id: string; time_created: number; data: unknown }>;
  };
  const dbDir = path.join(SANDBOX_HOME, '.local', 'share', 'opencode');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new Database(path.join(dbDir, 'opencode.db'));
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);`);
  for (const m of data.messages) {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(m.id, data.sessionId, m.time_created, JSON.stringify(m.data));
  }
  for (const p of data.parts) {
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
      .run(p.id, data.sessionId, p.message_id, p.time_created, JSON.stringify(p.data));
  }
  db.close();
  register(data.sessionId, 'opencode', '/home/operator/Project/nassaj-dev');
  const result = await buildSessionShareSnapshot(
    { sessionId: data.sessionId, readerUserId: ownerId, confirmUnattributed: true }, deps,
  );
  assertClean(result, data.sessionId);
  const json = snapshotText(result);
  assert.ok(json.includes('ردود ديب سيك ما تظهر'), 'the human prompt survives');
  assert.ok(json.includes('مشكلة معروفة في opencode'), 'the assistant answer survives');
  for (const leaked of ['The user is asking', 'webfetch', 'step-start', 'deepseek-v4-flash-free']) {
    assert.ok(!json.includes(leaked), `snapshot leaks ${leaked}`);
  }
  assert.ok(result.counts.toolCount >= 1);
});

test.after(() => closeConnection());
