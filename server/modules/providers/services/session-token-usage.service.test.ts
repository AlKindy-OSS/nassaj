/**
 * B-1643 / T-2034: GET /api/projects/:projectId/sessions/:sessionId/token-usage.
 *
 * The defect: `sessionId=.` matched the first rollout file whose NAME contained
 * a dot (every one), so a member read another session's usage; Codex and
 * OpenCode never bound the session to the project; the whole file was read; a
 * 404 echoed an absolute path. These tests drive the real service with the real
 * pinned transcript reader and real files (Codex record shapes copied from a
 * live 2026-10-16 rollout; ids keep the live shapes), and compare valid Codex
 * answers with the pre-fix full-file algorithm, kept verbatim below.
 *
 * Scratch lives under /var/tmp — never /tmp, which is tmpfs on this host.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';

import Database from 'better-sqlite3';

import { extractCodexTokenBudget } from '../list/codex/codex-token-budget.js';
import { TRANSCRIPT_TAIL_MAX_BYTES } from '../shared/pinned-tail.js';

import {
  CODEX_USAGE_INITIAL_WINDOW_BYTES,
  readSessionTokenUsage,
  type TokenUsageDeps,
  type TokenUsageReply,
} from './session-token-usage.service.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_PATH = '/var/tmp/b1643/repo';
const OTHER_PROJECT_PATH = '/var/tmp/b1643/other-repo';
const CODEX_ID = '11111111-2222-7333-8444-555555555555';
const OTHER_CODEX_ID = '66666666-7777-7888-9999-aaaaaaaaaaaa';
const OPENCODE_ID = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_OPENCODE_ID = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const WINDOW = 258400;

type Row = { session_id: string; provider: string; project_path: string | null; jsonl_path: string | null };

let scratch = '';
let codexHome = '';
let previousCodexHome: string | undefined;

before(async () => {
  scratch = await fsp.realpath(await fsp.mkdtemp('/var/tmp/b1643-token-usage-'));
  codexHome = path.join(scratch, 'codex');
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
});

after(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await fsp.rm(scratch, { recursive: true, force: true });
});

beforeEach(() => mock.restoreAll());

// ------------------------------------------------------------------ records

const meta = (id: string) => ({
  timestamp: '2026-10-16T07:24:37.961Z', ordinal: 0, type: 'session_meta',
  payload: { session_id: id, id, timestamp: '2026-10-16T07:24:37.961Z', cwd: PROJECT_PATH, originator: 'codex_exec' },
});
const turnContext = (model: string) => ({
  timestamp: '2026-10-16T07:24:38.000Z', type: 'turn_context',
  payload: { turn_id: 'turn-1', cwd: PROJECT_PATH, model, effort: 'medium', approval_policy: 'never' },
});
let tick = 0;
const tokenCount = (total: number) => {
  tick += 1;
  const usage = { input_tokens: total - 229, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 229,
    reasoning_output_tokens: 0, total_tokens: total };
  return {
    timestamp: `2026-10-16T07:25:${String(tick % 60).padStart(2, '0')}.456Z`, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage, model_context_window: WINDOW },
      rate_limits: { limit_id: 'codex', primary: null, secondary: null } },
  };
};
const compacted = () => ({ timestamp: '2026-10-16T07:30:00.000Z', type: 'compacted', payload: { message: '' } });
const message = (bytes: number) => ({
  timestamp: '2026-10-16T07:26:00.000Z', type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(bytes) }] },
});
/** Filler records totalling about `bytes`. */
const filler = (bytes: number) => Array.from({ length: Math.ceil(bytes / (256 * 1024)) }, () => message(256 * 1024));

async function writeRollout(id: string, records: unknown[]): Promise<string> {
  const dir = path.join(codexHome, 'sessions', '2026', '10', '16');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-16T10-24-37-${id}.jsonl`);
  await fsp.writeFile(file, `${[meta(id), ...records].map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

/** The pre-fix Codex parse (server/index.js before B-1643), verbatim, over the WHOLE file. */
function legacyCodexBody(fileContent: string, safeSessionId: string) {
  let budget = null;
  let modelId = null;
  for (const line of fileContent.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'turn_context') {
      if (modelId !== (entry.payload?.model ?? null)) budget = null;
      modelId = entry.payload?.model ?? null;
    }
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      budget = extractCodexTokenBudget(entry, modelId, safeSessionId, 'history');
    }
    if (entry.type === 'compacted' || entry.payload?.type === 'context_compacted') {
      budget = null;
    }
  }
  return budget ?? { used: null, total: null, contextSnapshot: null, cacheSnapshot: null };
}

// ------------------------------------------------------------------ harness

function depsFor(rows: Row[], extra: Partial<TokenUsageDeps> = {}) {
  const lookups: string[] = [];
  const deps: TokenUsageDeps = {
    getSessionById: (id) => {
      lookups.push(id);
      return rows.find((row) => row.session_id === id) ?? null;
    },
    getProjectPathById: (id) => (id === PROJECT_ID ? PROJECT_PATH : null),
    openCodeDatabasePaths: () => [],
    ...extra,
  };
  return { deps, lookups };
}

const codexRow = (id: string, file: string | null, projectPath = PROJECT_PATH): Row => ({
  session_id: id, provider: 'codex', project_path: projectPath, jsonl_path: file,
});

const ask = (deps: TokenUsageDeps, sessionId: unknown, provider: unknown = undefined) =>
  readSessionTokenUsage({ projectId: PROJECT_ID, sessionId, provider }, deps);

/** receivedAt is stamped at read time; drop it on both sides before comparing. */
function stable(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body), (key, value) => (key === 'receivedAt' ? null : value));
}

function assertNoPath(replyValue: TokenUsageReply) {
  const text = JSON.stringify(replyValue.body);
  assert.ok(!text.includes(scratch) && !/"path"/.test(text) && !text.includes('/var/tmp'), `path leaked: ${text}`);
}

/** Records fs directory scans and positional reads made while `run` executes. */
async function observeFs<T>(run: () => Promise<T>) {
  const readdirs: string[] = [];
  const opendirs: string[] = [];
  const reads: Array<{ position: number; length: number }> = [];
  const probe = await fsp.open(path.join(scratch, '.probe'), 'w');
  const handleProto = Object.getPrototypeOf(probe);
  await probe.close();
  const realRead = handleProto.read;
  mock.method(handleProto, 'read', function (this: unknown, ...args: unknown[]) {
    const [, , length, position] = args as [Buffer, number, number, number];
    if (typeof position === 'number') reads.push({ position, length });
    return realRead.apply(this, args);
  });
  for (const target of [fs, fsp]) {
    const realReaddir = target.readdir as (...a: unknown[]) => unknown;
    mock.method(target, 'readdir', (...args: unknown[]) => { readdirs.push(String(args[0])); return realReaddir.apply(target, args); });
  }
  const realReaddirSync = fs.readdirSync;
  mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    readdirs.push(String(args[0]));
    return (realReaddirSync as (...a: unknown[]) => unknown).apply(fs, args);
  });
  const realOpendir = fsp.opendir;
  mock.method(fsp, 'opendir', (...args: unknown[]) => {
    opendirs.push(String(args[0]));
    return (realOpendir as (...a: unknown[]) => unknown).apply(fsp, args);
  });
  syncBuiltinESMExports();
  try {
    return { result: await run(), readdirs, opendirs, reads };
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

// ------------------------------------------------------------------ invalid ids

const INVALID_IDS = ['.', '..', '.x', 'a..b', 'a/b', '%2F', '/', ' ', ` ${CODEX_ID}`, `${CODEX_ID}\n`, 'x'.repeat(129), ''];

test('rejects every malformed session id with 400 before any lookup or read', async () => {
  const victim = await writeRollout(OTHER_CODEX_ID, [turnContext('gpt-6-luna'), tokenCount(23705)]);
  const { deps, lookups } = depsFor([codexRow(OTHER_CODEX_ID, victim)]);
  for (const id of INVALID_IDS) {
    for (const provider of [undefined, 'codex', 'opencode', 'claude']) {
      const observed = await observeFs(() => ask(deps, id, provider));
      assert.deepEqual(observed.result, { status: 400, body: { error: 'Invalid sessionId' } }, JSON.stringify(id));
      assert.equal(observed.reads.length, 0);
      assert.deepEqual(observed.readdirs, []);
    }
  }
  assert.deepEqual(lookups, [], 'no malformed id reaches the session table');
});

test('short ids that are valid grammar but name no session answer 404, never another session', async () => {
  const victim = await writeRollout(OTHER_CODEX_ID, [turnContext('gpt-6-luna'), tokenCount(23705)]);
  const { deps } = depsFor([codexRow(OTHER_CODEX_ID, victim)]);
  for (const id of ['-', 'a', '1', 'rollout', 'jsonl']) {
    const answer = await ask(deps, id, 'codex');
    assert.deepEqual(answer, { status: 404, body: { error: 'Session not found' } }, id);
  }
});

// ------------------------------------------------------------------ binding

test('a Codex session of another project answers 404 without opening its rollout', async () => {
  const file = await writeRollout(OTHER_CODEX_ID, [turnContext('gpt-6-luna'), tokenCount(23705)]);
  const { deps } = depsFor([codexRow(OTHER_CODEX_ID, file, OTHER_PROJECT_PATH)]);
  const observed = await observeFs(() => ask(deps, OTHER_CODEX_ID, 'codex'));
  assert.deepEqual(observed.result, { status: 404, body: { error: 'Session not found' } });
  assert.equal(observed.reads.length, 0);
});

test('an unknown project answers 404 Project not found', async () => {
  const { deps } = depsFor([]);
  const answer = await readSessionTokenUsage({ projectId: 'nope', sessionId: CODEX_ID, provider: 'codex' }, deps);
  assert.deepEqual(answer, { status: 404, body: { error: 'Project not found' } });
});

test('the provider comes from the row: a different query provider is refused', async () => {
  const file = await writeRollout(CODEX_ID, [turnContext('gpt-6-luna'), tokenCount(23705)]);
  const { deps } = depsFor([codexRow(CODEX_ID, file)]);
  for (const provider of ['claude', 'opencode', 'cursor', ['codex', 'codex']]) {
    assert.deepEqual(await ask(deps, CODEX_ID, provider), { status: 400, body: { error: 'Provider does not match session' } });
  }
});

test('a row whose recorded rollout belongs to another thread is refused (pinned binder)', async () => {
  const foreign = await writeRollout(OTHER_CODEX_ID, [turnContext('gpt-6-luna'), tokenCount(23705)]);
  const { deps } = depsFor([codexRow(CODEX_ID, foreign)]);
  const answer = await ask(deps, CODEX_ID, 'codex');
  assert.deepEqual(answer, { status: 404, body: { error: 'Session file not found', reason: 'transcript_unavailable' } });
});

test('a Codex row without a recorded path answers transcript_unavailable with no path and no scan', async () => {
  await writeRollout(CODEX_ID, [turnContext('gpt-6-luna'), tokenCount(23705)]);
  const { deps } = depsFor([codexRow(CODEX_ID, null)]);
  const observed = await observeFs(() => ask(deps, CODEX_ID, 'codex'));
  assert.deepEqual(observed.result, { status: 404, body: { error: 'Session file not found', reason: 'transcript_unavailable' } });
  assert.deepEqual(observed.readdirs, []);
  assertNoPath(observed.result);
});

// ------------------------------------------------------------------ Codex parity

async function assertCodexParity(records: unknown[]) {
  const file = await writeRollout(CODEX_ID, records);
  const { deps } = depsFor([codexRow(CODEX_ID, file)]);
  const observed = await observeFs(() => ask(deps, CODEX_ID, 'codex'));
  assert.equal(observed.result.status, 200);
  assert.deepEqual(stable(observed.result.body), stable(legacyCodexBody(fs.readFileSync(file, 'utf8'), CODEX_ID)));
  assert.deepEqual(observed.readdirs, [], 'no directory walk');
  assert.ok(observed.reads.length > 0, 'the spy saw the pinned reads');
  for (const dir of observed.opendirs) assert.equal(dir, path.dirname(file), 'only the pinned file\'s own directory is settled');
  assertNoPath(observed.result);
  return observed;
}

test('own-project Codex session: identical body to the pre-fix reader (last token_count)', async () => {
  const observed = await assertCodexParity([turnContext('gpt-6-luna'), tokenCount(23705), message(200), tokenCount(31000)]);
  const body = observed.result.body as Record<string, any>;
  assert.equal(body.used, 31000);
  assert.equal(body.total, WINDOW);
  assert.equal(body.contextSnapshot.modelId, 'gpt-6-luna');
  assert.equal(body.contextSnapshot.sessionId, CODEX_ID);
});

test('Codex compaction after the last token_count voids the window, as before', async () => {
  const observed = await assertCodexParity([turnContext('gpt-6-luna'), tokenCount(23705), compacted()]);
  assert.deepEqual(observed.result.body, { used: null, total: null, contextSnapshot: null, cacheSnapshot: null });
  await assertCodexParity([turnContext('gpt-6-luna'), tokenCount(23705), compacted(), tokenCount(5000)]);
});

test('Codex model switch resets the window and relabels the next count, as before', async () => {
  const reset = await assertCodexParity([turnContext('gpt-6-luna'), tokenCount(23705), turnContext('gpt-6-sol')]);
  assert.deepEqual(reset.result.body, { used: null, total: null, contextSnapshot: null, cacheSnapshot: null });
  const relabelled = await assertCodexParity([
    turnContext('gpt-6-luna'), tokenCount(23705), turnContext('gpt-6-sol'), tokenCount(4000),
  ]);
  assert.equal((relabelled.result.body as any).contextSnapshot.modelId, 'gpt-6-sol');
  // Same model again: no reset, as before.
  await assertCodexParity([turnContext('gpt-6-luna'), tokenCount(23705), turnContext('gpt-6-luna')]);
});

test('a turn_context outside the first tail window is found by widening backwards', async () => {
  const observed = await assertCodexParity([
    turnContext('gpt-6-luna'), ...filler(CODEX_USAGE_INITIAL_WINDOW_BYTES * 2), tokenCount(23705),
  ]);
  assert.equal((observed.result.body as any).contextSnapshot.modelId, 'gpt-6-luna');
  const size = fs.statSync(path.join(codexHome, 'sessions', '2026', '10', '16',
    `rollout-2026-10-16T10-24-37-${CODEX_ID}.jsonl`)).size;
  // Header binding reads in 64 KiB chunks; a widened tail step is one larger positional read.
  const widened = observed.reads.some((r) => r.length > 64 * 1024 && r.position < size - CODEX_USAGE_INITIAL_WINDOW_BYTES);
  assert.ok(widened, 'the window was widened past the first step');
});

test('the fs observer itself records directory scans and positional reads', async () => {
  const file = await writeRollout(OTHER_CODEX_ID, [tokenCount(1)]);
  const observed = await observeFs(async () => {
    await fsp.readdir(path.dirname(file));
    fs.readdirSync(path.dirname(file));
    const handle = await fsp.open(file, 'r');
    try { await handle.read(Buffer.alloc(8), 0, 8, 3); } finally { await handle.close(); }
  });
  assert.equal(observed.readdirs.length, 2);
  assert.deepEqual(observed.reads, [{ position: 3, length: 8 }]);
});

// ------------------------------------------------------------------ bounded read

test('an oversized rollout is read only within the pinned-tail cap', async () => {
  const gap = 4 * 1024 * 1024;
  const file = await writeRollout(CODEX_ID, [
    turnContext('gpt-6-luna'), ...filler(TRANSCRIPT_TAIL_MAX_BYTES + gap), turnContext('gpt-6-luna'), tokenCount(23705),
  ]);
  const size = fs.statSync(file).size;
  const { deps } = depsFor([codexRow(CODEX_ID, file)]);
  const observed = await observeFs(() => ask(deps, CODEX_ID, 'codex'));

  assert.equal(observed.result.status, 200);
  assert.deepEqual(stable(observed.result.body), stable(legacyCodexBody(fs.readFileSync(file, 'utf8'), CODEX_ID)));
  const tailStart = size - TRANSCRIPT_TAIL_MAX_BYTES;
  const headEnd = 1024 * 1024; // header binding reads the leading record only
  const total = observed.reads.reduce((sum, r) => sum + (r.position >= tailStart ? r.length : 0), 0);
  for (const r of observed.reads) {
    assert.ok(r.position + r.length <= headEnd || r.position >= tailStart, `read in the gap at ${r.position}`);
  }
  assert.ok(total <= TRANSCRIPT_TAIL_MAX_BYTES, `tail reads ${total} exceed the cap`);
  assert.deepEqual(observed.readdirs, []);
});

test('a count read before the window\'s first turn_context keeps its usage when no later count exists', async () => {
  const file = await writeRollout(CODEX_ID, [
    turnContext('gpt-6-luna'), ...filler(TRANSCRIPT_TAIL_MAX_BYTES + 1024 * 1024),
    tokenCount(23705), turnContext('gpt-6-luna'),
  ]);
  const { deps } = depsFor([codexRow(CODEX_ID, file)]);
  const body = (await ask(deps, CODEX_ID, 'codex')).body as Record<string, any>;
  // The pre-fix full read returns this count (same model before and after it).
  const legacy = legacyCodexBody(fs.readFileSync(file, 'utf8'), CODEX_ID) as Record<string, any>;
  assert.equal(legacy.used, 23705);
  assert.equal(body.used, 23705, 'usage is kept, not zeroed by the unknown-to-known model step');
  assert.equal(body.total, WINDOW);
  assert.equal(body.contextSnapshot.modelId, null);
});

test('when the model lies beyond the cap the window is still bounded and only the label is lost', async () => {
  const file = await writeRollout(CODEX_ID, [
    turnContext('gpt-6-luna'), ...filler(TRANSCRIPT_TAIL_MAX_BYTES + 1024 * 1024), tokenCount(23705),
  ]);
  const size = fs.statSync(file).size;
  const { deps } = depsFor([codexRow(CODEX_ID, file)]);
  const observed = await observeFs(() => ask(deps, CODEX_ID, 'codex'));
  const body = observed.result.body as Record<string, any>;
  assert.equal(body.used, 23705);
  assert.equal(body.total, WINDOW);
  assert.equal(body.contextSnapshot.modelId, null, 'documented degradation: model id unknown past the cap');
  for (const r of observed.reads) {
    assert.ok(r.position + r.length <= 1024 * 1024 || r.position >= size - TRANSCRIPT_TAIL_MAX_BYTES);
  }
});

// ------------------------------------------------------------------ OpenCode

function openCodeDb(rows: Array<{ id: string; input: number }>): string {
  const file = path.join(scratch, `opencode-${rows.map((r) => r.id).join('-') || 'empty'}.db`);
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)`);
  const insert = db.prepare('INSERT INTO session VALUES (?, ?, 50, 5, 100, 10)');
  for (const row of rows) insert.run(row.id, row.input);
  db.close();
  return file;
}

const openCodeRow = (id: string, projectPath = PROJECT_PATH): Row => ({
  session_id: id, provider: 'opencode', project_path: projectPath, jsonl_path: null,
});

const OPENCODE_BODY = { used: 1165, inputTokens: 1100, outputTokens: 50, breakdown: { input: 1100, output: 50 } };

test('own-project OpenCode session is found in whichever known database holds it', async () => {
  const operatorDb = openCodeDb([{ id: OTHER_OPENCODE_ID, input: 9 }]);
  const memberDb = openCodeDb([{ id: OPENCODE_ID, input: 1000 }]);
  const { deps } = depsFor([openCodeRow(OPENCODE_ID)], { openCodeDatabasePaths: () => [operatorDb, memberDb] });
  assert.deepEqual(await ask(deps, OPENCODE_ID, 'opencode'), { status: 200, body: OPENCODE_BODY });
});

test('an older-schema or unreadable OpenCode database does not hide a later match', async () => {
  const legacy = path.join(scratch, 'opencode-legacy.db');
  fs.rmSync(legacy, { force: true });
  const db = new Database(legacy);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY)');
  db.close();
  const broken = path.join(scratch, 'opencode-broken.db');
  fs.writeFileSync(broken, 'not a database');
  const memberDb = openCodeDb([{ id: OPENCODE_ID, input: 1000 }]);
  const { deps } = depsFor([openCodeRow(OPENCODE_ID)], { openCodeDatabasePaths: () => [legacy, broken, memberDb] });
  assert.deepEqual(await ask(deps, OPENCODE_ID, 'opencode'), { status: 200, body: OPENCODE_BODY });
  const { deps: onlyLegacy } = depsFor([openCodeRow(OPENCODE_ID)], { openCodeDatabasePaths: () => [legacy] });
  const unsupported = await ask(onlyLegacy, OPENCODE_ID, 'opencode');
  assert.equal(unsupported.status, 200);
  assert.equal(unsupported.body.unsupported, true);
});

test('an OpenCode session of another project answers 404 before any database is opened', async () => {
  const dbPath = openCodeDb([{ id: OTHER_OPENCODE_ID, input: 9 }]);
  let resolved = 0;
  const { deps } = depsFor([openCodeRow(OTHER_OPENCODE_ID, OTHER_PROJECT_PATH)], {
    openCodeDatabasePaths: () => { resolved += 1; return [dbPath]; },
  });
  assert.deepEqual(await ask(deps, OTHER_OPENCODE_ID, 'opencode'), { status: 404, body: { error: 'Session not found' } });
  assert.equal(resolved, 0);
});

test('OpenCode: missing database or missing row answer 404 without a path or id echo', async () => {
  const { deps: none } = depsFor([openCodeRow(OPENCODE_ID)], { openCodeDatabasePaths: () => [] });
  const noDb = await ask(none, OPENCODE_ID, 'opencode');
  assert.deepEqual(noDb, { status: 404, body: { error: 'OpenCode database not found' } });
  const dbPath = openCodeDb([{ id: OTHER_OPENCODE_ID, input: 9 }]);
  const { deps } = depsFor([openCodeRow(OPENCODE_ID)], { openCodeDatabasePaths: () => [dbPath] });
  const noRow = await ask(deps, OPENCODE_ID, 'opencode');
  assert.deepEqual(noRow, { status: 404, body: { error: 'OpenCode session not found' } });
  assertNoPath(noRow);
});

// ------------------------------------------------------------------ other providers

test('Cursor keeps its unsupported answer; providers without a usage reader answer transcript_unavailable', async () => {
  const { deps } = depsFor([
    { session_id: 'cursor-0a1b', provider: 'cursor', project_path: PROJECT_PATH, jsonl_path: null },
    { session_id: 'agy_1789388813511_sccibe98', provider: 'antigravity', project_path: PROJECT_PATH, jsonl_path: null },
  ]);
  const cursor = await ask(deps, 'cursor-0a1b', 'cursor');
  assert.equal(cursor.status, 200);
  assert.equal(cursor.body.unsupported, true);
  assert.deepEqual(await ask(deps, 'agy_1789388813511_sccibe98', 'antigravity'), {
    status: 404, body: { error: 'Session file not found', reason: 'transcript_unavailable' },
  });
});
