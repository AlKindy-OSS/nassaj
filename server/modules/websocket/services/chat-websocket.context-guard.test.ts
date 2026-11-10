/* eslint-disable boundaries/dependencies -- the acceptance harness builds the real adapters from their leaf modules under partial module mocks. */
/**
 * chat-websocket.context-guard.test.ts — T-2087 (A), ADR-223 acceptance.
 *
 * A conversation pinned to a model whose window cannot hold it is refused at
 * dispatch, before anything reaches the model. Drives the real dispatcher with
 * the real guard and the real adapters; only their file/database seams point
 * at fixtures derived from recorded data (see context-guard/__fixtures__).
 *
 * A2 switch then send → refused, nothing spawned; switching back works.
 * A3 `/compact` (bare and with instructions) is never refused; next send passes.
 * A4 OpenCode fill ~150k → 64k model refused; A4b large history, small last fill → passes.
 * A5 fits → passes; the same model next turn reads no transcript and no database.
 * A6 providers and engines without a usage source → unknown, never blocked.
 * +  restart with a pre-pinned small model; a client-sent compactionModel is dropped.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import Database from 'better-sqlite3';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';
import { chatImageStoreDatabaseLinkStubs } from '../../../../tests/helpers/chat-image-store-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    ...chatImageStoreDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: () => ({ project_id: 'test-project' }),
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: () => true,
    },
    sessionsDb: {
      getSessionById: (sessionId: string) => ({ session_id: sessionId, provider: 'claude', project_path: process.cwd() }),
    },
    participantsDb: { isParticipant: () => true },
    sessionWorkspaceModesDb: { readLegacyEligibility: () => ({ eligible: true }), markOverlay: () => undefined },
    sessionOutcomesDb: { getOutcomeForBroadcast: () => null },
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});
mock.module('@/modules/session-workspaces/index.js', {
  namedExports: { ...createPermissionTestWorkspaceModule(), logicalProjectPathForWorkspace: (cwd: string) => cwd },
});

const { dispatchProviderCommand: rawDispatch } = await import('./chat-websocket.service.js');
const { createContextGuard } = await import('@/modules/context-guard/context-guard.service.js');
const { createClaudeContextAdapter } = await import('@/modules/context-guard/adapters/claude.adapter.js');
const { createOpenCodeContextAdapter } = await import('@/modules/context-guard/adapters/opencode.adapter.js');
const dispatch = dispatchAuthorizedProviderCommand.bind(null, rawDispatch as never);

const FIXTURES = path.resolve(import.meta.dirname, '../../context-guard/__fixtures__');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'context-guard-accept-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

type Frame = { kind?: string; code?: string; notStarted?: boolean; contextGuard?: Record<string, unknown> };
type Session = { sessionId: string; provider: string; jsonlPath: string | null; engineProvider: string | null };

/** One world: sessions, pins, transcript text per session and spies on every read seam. */
function world() {
  const sessions = new Map<string, Session>();
  const pins = new Map<string, string>();
  const transcripts = new Map<string, { text: string; mtime: number }>();
  const reads = { transcriptKey: 0, transcriptTail: 0, openCodeDb: 0 };
  let openCodeDbPath: string | null = null;
  const claude = createClaudeContextAdapter({
    transcriptKey: async (session) => {
      reads.transcriptKey += 1;
      const entry = transcripts.get(session.sessionId);
      return entry ? `mtime:${entry.mtime}` : null;
    },
    readTranscriptTail: async (session) => {
      reads.transcriptTail += 1;
      return transcripts.get(session.sessionId)?.text ?? null;
    },
    catalogOptions: async () => JSON.parse(fixture('claude-catalog.json')),
  });
  const opencode = createOpenCodeContextAdapter({
    findDatabase: () => { reads.openCodeDb += 1; return openCodeDbPath; },
    modelsJsonPath: () => path.join(FIXTURES, 'opencode-models.json'),
    localModels: () => [],
  });
  const newGuard = () => createContextGuard({
    adapters: { claude, opencode },
    readPin: async (provider, sessionId) => pins.get(`${provider}:${sessionId}`) ?? null,
    readSession: (sessionId) => sessions.get(sessionId) ?? null,
  });
  return {
    sessions, pins, transcripts, reads, newGuard,
    setOpenCodeDb: (dbPath: string) => { openCodeDbPath = dbPath; },
  };
}

async function send(
  guard: unknown, provider: string, sessionId: string, command: string, extra: Record<string, unknown> = {},
) {
  const sent: Frame[] = [];
  const spawned: Array<{ command: string; options: Record<string, unknown> }> = [];
  const writer = { send: (frame: unknown) => { sent.push(frame as Frame); } } as unknown as WebSocketWriter;
  const spawn = async (cmd: string, options: Record<string, unknown>) => { spawned.push({ command: cmd, options }); };
  await dispatch(`${provider}-command`, { command, options: { sessionId, ...extra } }, writer, {
    queryClaudeSDK: spawn, spawnOpenCode: spawn, spawnAntigravity: spawn, queryCodex: spawn,
    getSessionProvider: () => provider,
    contextGuard: guard,
  });
  return { sent, spawned, refusal: sent.find((frame) => frame.code === 'context_guard_window_too_small') };
}

const CLAUDE_SID = '11111111-1111-4111-8111-111111111111';

function claudeWorld(transcript = 'claude-tail.jsonl') {
  const w = world();
  w.sessions.set(CLAUDE_SID, { sessionId: CLAUDE_SID, provider: 'claude', jsonlPath: null, engineProvider: 'anthropic' });
  w.transcripts.set(CLAUDE_SID, { text: fixture(transcript).replaceAll('SESSION_ID', CLAUDE_SID), mtime: 1 });
  return w;
}

test('A2: switching a 239k conversation to Haiku is refused before the model; switching back works', async () => {
  const w = claudeWorld();
  const guard = w.newGuard();
  w.pins.set(`claude:${CLAUDE_SID}`, 'haiku');

  const refused = await send(guard, 'claude', CLAUDE_SID, 'continue please');
  assert.equal(refused.spawned.length, 0, 'nothing reaches the model (so no transcript line is written)');
  assert.ok(refused.refusal, 'a typed refusal frame is sent');
  assert.equal(refused.refusal.kind, 'complete');
  assert.equal(refused.refusal.notStarted, true);
  assert.deepEqual(refused.refusal.contextGuard, {
    used: 238894, budget: 180000, model: 'haiku', previousModel: 'claude-opus-5-5', canCompactOnPrevious: true,
  });

  w.pins.set(`claude:${CLAUDE_SID}`, 'claude-opus-5-5');
  const back = await send(guard, 'claude', CLAUDE_SID, 'continue please');
  assert.equal(back.refusal, undefined);
  assert.equal(back.spawned.length, 1, 'the turn runs once the model can hold the conversation');
});

test('A3: /compact and /compact <instructions> are never refused; the next send passes (unknown)', async () => {
  const w = claudeWorld();
  const guard = w.newGuard();
  w.pins.set(`claude:${CLAUDE_SID}`, 'haiku');

  for (const command of ['/compact', '  /compact keep the API notes']) {
    const before = { ...w.reads };
    const result = await send(guard, 'claude', CLAUDE_SID, command);
    assert.equal(result.refusal, undefined, `${command.trim()} is exempt`);
    assert.equal(result.spawned.length, 1);
    assert.deepEqual(w.reads, before, 'the exemption measures nothing');
  }
  assert.ok((await send(guard, 'claude', CLAUDE_SID, '/compaction-report')).refusal,
    'only the exact /compact command is exempt');

  w.transcripts.set(CLAUDE_SID, {
    text: fixture('claude-compacted-tail.jsonl').replaceAll('SESSION_ID', CLAUDE_SID), mtime: 2,
  });
  const next = await send(guard, 'claude', CLAUDE_SID, 'now continue on haiku');
  assert.equal(next.refusal, undefined, 'after a compaction the fill is unknown until fresh, so it passes');
  assert.equal(next.spawned.length, 1);
});

test('A3+: a client-sent compactionModel never reaches the provider', async () => {
  const w = claudeWorld();
  const result = await send(w.newGuard(), 'claude', CLAUDE_SID, '/compact', { compactionModel: 'haiku' });
  assert.equal(result.spawned.length, 1);
  assert.equal('compactionModel' in result.spawned[0].options, false);
});

const OPENCODE_SID = 'ses_fixture0123456789abcdefABCD';

function openCodeDb(fills: Array<{ input: number; cacheRead: number; summary?: boolean }>, sessionTokens = 0): string {
  const dbPath = path.join(scratch, `opencode-${Math.random().toString(16).slice(2)}.db`);
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE session (id text PRIMARY KEY, tokens_input integer DEFAULT 0 NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
      time_updated integer NOT NULL, data text NOT NULL);`);
  db.prepare('INSERT INTO session (id, tokens_input) VALUES (?, ?)').run(OPENCODE_SID, sessionTokens);
  const base = JSON.parse(fixture('opencode-assistant-message.json'));
  fills.forEach((fill, index) => {
    const data = fill.summary
      ? { ...base, mode: 'compaction', agent: 'compaction', summary: true,
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
      : { ...base, tokens: { ...base.tokens, input: fill.input, cache: { read: fill.cacheRead, write: 0 } } };
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
      .run(`msg_${index}`, OPENCODE_SID, 1_793_000_000_000 + index, 1_793_000_000_000 + index, JSON.stringify(data));
  });
  db.close();
  return dbPath;
}

function openCodeWorld(dbPath: string) {
  const w = world();
  w.sessions.set(OPENCODE_SID, { sessionId: OPENCODE_SID, provider: 'opencode', jsonlPath: null, engineProvider: null });
  w.setOpenCodeDb(dbPath);
  return w;
}

test('A4: an OpenCode GLM conversation filled to ~150k is refused on a 64k model', async () => {
  const w = openCodeWorld(openCodeDb([{ input: 120_000, cacheRead: 30_000 }]));
  w.pins.set(`opencode:${OPENCODE_SID}`, 'zai/glm-4.5v');
  const result = await send(w.newGuard(), 'opencode', OPENCODE_SID, 'next step');
  assert.equal(result.spawned.length, 0);
  assert.deepEqual(result.refusal?.contextGuard, {
    used: 150_000, budget: 64_000 - 16_384, model: 'zai/glm-4.5v', previousModel: 'opencode/glm-5.3-flash-free',
    canCompactOnPrevious: false,
  });
});

test('A4b: a cumulative total above the window does not refuse when the last fill is smaller', async () => {
  const w = openCodeWorld(openCodeDb(
    [{ input: 140_000, cacheRead: 0 }, { input: 0, cacheRead: 0, summary: true }, { input: 25_000, cacheRead: 5_000 }],
    5_000_000,
  ));
  w.pins.set(`opencode:${OPENCODE_SID}`, 'zai/glm-4.5v');
  const result = await send(w.newGuard(), 'opencode', OPENCODE_SID, 'next step');
  assert.equal(result.refusal, undefined);
  assert.equal(result.spawned.length, 1);
});

test('A4c: an OpenCode compaction after the last usage makes the fill unknown', async () => {
  const w = openCodeWorld(openCodeDb([{ input: 150_000, cacheRead: 0 }, { input: 0, cacheRead: 0, summary: true }]));
  w.pins.set(`opencode:${OPENCODE_SID}`, 'zai/glm-4.5v');
  const result = await send(w.newGuard(), 'opencode', OPENCODE_SID, 'next step');
  assert.equal(result.refusal, undefined);
});

test('A5: a fitting switch passes and the next turn on the same model reads nothing', async () => {
  const w = claudeWorld();
  const guard = w.newGuard();
  w.pins.set(`claude:${CLAUDE_SID}`, 'default');
  assert.equal((await send(guard, 'claude', CLAUDE_SID, 'one')).spawned.length, 1);
  const afterFirst = { ...w.reads };
  assert.ok(afterFirst.transcriptTail >= 1, 'the switch itself was measured');
  assert.equal((await send(guard, 'claude', CLAUDE_SID, 'two')).spawned.length, 1);
  assert.deepEqual(w.reads, afterFirst, 'no transcript read on an unchanged model');

  const o = openCodeWorld(openCodeDb([{ input: 20_000, cacheRead: 0 }]));
  const openGuard = o.newGuard();
  o.pins.set(`opencode:${OPENCODE_SID}`, 'zai/glm-5.3');
  assert.equal((await send(openGuard, 'opencode', OPENCODE_SID, 'one')).spawned.length, 1);
  const openReads = o.reads.openCodeDb;
  assert.equal((await send(openGuard, 'opencode', OPENCODE_SID, 'two')).spawned.length, 1);
  assert.equal(o.reads.openCodeDb, openReads, 'no opencode.db read on an unchanged model');

  const n = claudeWorld();
  assert.equal((await send(n.newGuard(), 'claude', CLAUDE_SID, 'no pin')).spawned.length, 1);
  assert.deepEqual(n.reads, { transcriptKey: 0, transcriptTail: 0, openCodeDb: 0 }, 'no pin → no check at all');
});

test('A6: providers and engines without a usage source are unknown and never blocked', async () => {
  const w = claudeWorld();
  w.sessions.set(CLAUDE_SID, { sessionId: CLAUDE_SID, provider: 'claude', jsonlPath: null, engineProvider: 'kimi' });
  w.pins.set(`claude:${CLAUDE_SID}`, 'haiku');
  const vendorEngine = await send(w.newGuard(), 'claude', CLAUDE_SID, 'hi');
  assert.equal(vendorEngine.refusal, undefined);
  assert.equal(vendorEngine.spawned.length, 1);
  assert.equal(w.reads.transcriptTail, 0, 'a vendor engine is not measured');

  const agy = world();
  const agySid = '22222222-2222-4222-8222-222222222222';
  agy.sessions.set(agySid, { sessionId: agySid, provider: 'antigravity', jsonlPath: null, engineProvider: null });
  agy.pins.set(`antigravity:${agySid}`, 'gemini-3.6-flash-high');
  const agyRun = await send(agy.newGuard(), 'antigravity', agySid, 'hi');
  assert.equal(agyRun.refusal, undefined);
  assert.equal(agyRun.spawned.length, 1);
});

test('restart: a model pinned before the restart is still checked against the observed model', async () => {
  const w = claudeWorld();
  w.pins.set(`claude:${CLAUDE_SID}`, 'haiku');
  const freshProcessGuard = w.newGuard();
  const result = await send(freshProcessGuard, 'claude', CLAUDE_SID, 'hello again');
  assert.ok(result.refusal, 'no remembered admission → compare with the observed transcript model');
  assert.equal(result.spawned.length, 0);
});

test('a guard failure never refuses the turn', async () => {
  const w = claudeWorld();
  w.pins.set(`claude:${CLAUDE_SID}`, 'haiku');
  const broken = { checkTurn: async () => { throw new Error('boom'); } };
  const result = await send(broken, 'claude', CLAUDE_SID, 'hi');
  assert.equal(result.refusal, undefined);
  assert.equal(result.spawned.length, 1);
});
