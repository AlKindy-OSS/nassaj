/**
 * Agent-progress study P0 (§3.2, H1, N3, N6): sub-agent outcome states on the
 * Claude path. Fixtures are synthetic CLI-shaped JSONL rows (see `_provenance`).
 *
 * (a) CLI-format `<task-notification>` per status → completed / failed / stopped;
 * (b) a background agent launched in turn 1 and settled in turn 2 reads
 *     `running` then `completed`, never `unknown`;
 * (c) process exit with an unsettled agent → `unknown (process-exit)`, also
 *     when the history snapshot is served from cache (N3);
 * (d) owner stop → `stopped (owner)` (live STOP and history interrupt marker);
 * (e) a late terminal event overrides `unknown`.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, participantsDb, sessionsDb } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/no-unknown -- shared test fixture helper (same seam as sandbox-home)
import { claudeProjectsSandbox } from '@/shared/__tests__/provider-root-sandbox.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { projectLightHistory, resetHistorySnapshotCacheForTests } from '../../../services/session-history-light.service.js';
import { resetSessionLivenessProbes, setSessionLivenessProbes } from '../../../services/session-activity.service.js';
import { sessionsService } from '../../../services/sessions.service.js';
import { claudeSettlements, createClaudeProgressFold, isClaudeInterruptMarker } from '../claude-progress-fold.js';
import { ClaudeSessionsProvider } from '../claude-sessions.provider.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SID = '00000000-0000-4000-8000-0000000000b0';
const AGENT = 'toolu_synthetic_agent';

type Row = Record<string, any>;
type Fixture = { turn1: Row[]; turn2: Row[]; notification: Row; interruptMarker: Row; notificationTexts: Record<string, string> };

async function fixture(): Promise<Fixture> {
  return JSON.parse(await readFile(path.join(HERE, '__fixtures__', 'claude-subagent-outcomes.synthetic.json'), 'utf8'));
}

function notificationRow(text: string): Row {
  return { type: 'user', isSidechain: false, origin: { kind: 'task-notification', producer: 'session-task' },
    uuid: `n-${text.length}`, timestamp: '2026-10-10T21:00:00.000Z', message: { role: 'user', content: text } };
}

/** The agent's last lifecycle record in a history page (what the client reads). */
function lastState(messages: NormalizedMessage[]): { state?: string; inferredCause?: string } {
  const rows = messages.filter((m) => m.subagent?.id === AGENT);
  const last = rows.at(-1)?.subagent;
  return { state: last?.state, inferredCause: last?.inferredCause };
}

/** A sandboxed Claude session whose transcript holds `rows`; returns a writer and a cleanup. */
async function historySession(rows: Row[], { spawned = true } = {}) {
  const dir = await mkdtemp('/var/tmp/claude-outcomes-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  resetHistorySnapshotCacheForTests();
  const file = path.join(claudeProjectsSandbox('claude-outcomes-'), `${SID}.jsonl`);
  const write = (all: Row[]) => writeFile(file, `${all.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await write(rows);
  getConnection().prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'h', 'user')").run();
  sessionsDb.createSession(SID, 'claude', dir, undefined, undefined, undefined, file);
  if (spawned) participantsDb.recordSpawn(SID, 1);
  return {
    write,
    fetch: () => sessionsService.fetchHistory(SID, 1, {}),
    async cleanup() {
      resetSessionLivenessProbes();
      resetHistorySnapshotCacheForTests();
      closeConnection();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function setAlive(alive: boolean): void {
  setSessionLivenessProbes({ claude: () => alive });
}

test('(a) <task-notification> rows: completed, failed, killed and stopped map to their own outcomes', async () => {
  const { notification, notificationTexts } = await fixture();
  assert.deepEqual(claudeSettlements(notification), [{ toolUseId: AGENT, state: 'completed' }]);
  assert.deepEqual(claudeSettlements(notificationRow(notificationTexts.failed)),
    [{ toolUseId: 'toolu_synthetic_failed', state: 'failed' }]);
  assert.deepEqual(claudeSettlements(notificationRow(notificationTexts.killed)),
    [{ toolUseId: 'toolu_synthetic_killed', state: 'stopped' }], 'killed is a stop, not a failure');
  assert.deepEqual(claudeSettlements(notificationRow(notificationTexts.stopped)),
    [{ toolUseId: 'toolu_synthetic_stopped', state: 'stopped' }]);
  assert.deepEqual(claudeSettlements({ type: 'system', subtype: 'task_notification', tool_use_id: AGENT, status: 'killed' }),
    [{ toolUseId: AGENT, state: 'stopped' }], 'the SDK event uses the same mapping');
});

test('(b) background agent launched in turn 1 settles in turn 2: running, then completed, never unknown', async () => {
  const fx = await fixture();
  const session = await historySession([...fx.turn1, ...fx.turn2]);
  try {
    setAlive(true);
    assert.deepEqual(lastState((await session.fetch()).messages), { state: 'running', inferredCause: undefined },
      'turn end is not settlement while the process lives');
    await session.write([...fx.turn1, ...fx.turn2, fx.notification]);
    assert.equal(lastState((await session.fetch()).messages).state, 'completed');
    setAlive(false);
    assert.equal(lastState((await session.fetch()).messages).state, 'completed', 'a settled agent never turns unknown');
  } finally {
    await session.cleanup();
  }
});

test('(c) process exit with an unsettled agent → unknown (process-exit), also from a cached snapshot (N3)', async () => {
  const fx = await fixture();
  const session = await historySession([...fx.turn1, ...fx.turn2]);
  try {
    setAlive(true);
    assert.equal(lastState((await session.fetch()).messages).state, 'running', 'first read caches the snapshot');
    setAlive(false);
    const history = await session.fetch();
    assert.deepEqual(lastState(history.messages), { state: 'unknown', inferredCause: 'process-exit' },
      'the exit wrote nothing to the transcript, yet the cached snapshot is not served stale');
    assert.equal('subagentOwnerStops' in history, false);
    const light = projectLightHistory(history);
    assert.deepEqual(lastState(light.messages), { state: 'unknown', inferredCause: 'process-exit' });
    setAlive(true);
    assert.equal(lastState((await session.fetch()).messages).state, 'running', 'the cache never holds the overlay');
  } finally {
    await session.cleanup();
  }
});

test('(c) unwired liveness leaves history untouched', async () => {
  const fx = await fixture();
  const session = await historySession([...fx.turn1]);
  try {
    resetSessionLivenessProbes();
    assert.equal(lastState((await session.fetch()).messages).state, 'running');
  } finally {
    await session.cleanup();
  }
});

test('(c) external run (no spawn by this server): no process-exit inference, only the session timeout', async () => {
  const fx = await fixture();
  const fresh = (rows: Row[]) => rows.map((row) => ({ ...row, timestamp: new Date().toISOString() }));
  const session = await historySession(fresh([...fx.turn1, ...fx.turn2]), { spawned: false });
  try {
    setAlive(false);
    assert.deepEqual(lastState((await session.fetch()).messages), { state: 'running', inferredCause: undefined },
      'a probe that cannot see an external process is not evidence of its exit');
    await session.write([...fx.turn1, ...fx.turn2]);
    resetHistorySnapshotCacheForTests();
    assert.deepEqual(lastState((await session.fetch()).messages), { state: 'unknown', inferredCause: 'timeout' });
  } finally {
    await session.cleanup();
  }
});

test('(d) history: an owner interrupt marker after the launch, then exit → stopped (owner)', async () => {
  const fx = await fixture();
  assert.equal(isClaudeInterruptMarker(fx.interruptMarker), true);
  assert.equal(isClaudeInterruptMarker({ ...fx.interruptMarker, isSidechain: true }), false);
  assert.equal(isClaudeInterruptMarker(fx.turn2[0]), false);
  const session = await historySession([...fx.turn1, fx.interruptMarker]);
  try {
    setAlive(false);
    const history = await session.fetch();
    assert.deepEqual(lastState(history.messages), { state: 'stopped', inferredCause: 'owner' });
    assert.equal('subagentOwnerStops' in history, false, 'the internal hint never leaves the server');
  } finally {
    await session.cleanup();
  }
});

/** Replays the fixture's turn-1 rows through a live fold, as server/claude-sdk.js does. */
function liveRun(rows: Row[]) {
  const provider = new ClaudeSessionsProvider();
  const fold = createClaudeProgressFold('live', SID);
  for (const raw of rows) fold.observe(raw, provider.normalizeMessage(raw, SID));
  return fold;
}

test('(d) live: owner STOP at process exit → stopped (owner); idempotent', async () => {
  const fx = await fixture();
  const fold = liveRun(fx.turn1);
  const rows = fold.processExit('owner', SID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'status');
  assert.equal(rows[0].sessionId, SID);
  assert.deepEqual([rows[0].subagent?.id, rows[0].subagent?.state, rows[0].subagent?.inferredCause],
    [AGENT, 'stopped', 'owner']);
  assert.deepEqual(fold.processExit('owner', SID), [], 'a second exit settles nothing');
});

test('(c/e) live: process exit → unknown; a late notification still settles it as completed', async () => {
  const fx = await fixture();
  const fold = liveRun(fx.turn1);
  const exitRows = fold.processExit('process-exit', SID);
  assert.deepEqual([exitRows[0].subagent?.state, exitRows[0].subagent?.inferredCause], ['unknown', 'process-exit']);
  const late = fold.observe(fx.notification, new ClaudeSessionsProvider().normalizeMessage(fx.notification, SID));
  assert.equal(late.find((row) => row.subagent?.id === AGENT)?.subagent?.state, 'completed');
  assert.equal(late.find((row) => row.subagent?.id === AGENT)?.subagent?.inferredCause, undefined);
});

test('live: a settled or seeded delegation is never settled again at exit', async () => {
  const fx = await fixture();
  const settledFold = liveRun([...fx.turn1, fx.notification]);
  assert.deepEqual(settledFold.processExit('process-exit', SID), []);
  const provider = new ClaudeSessionsProvider();
  const seeded = createClaudeProgressFold('live', SID);
  for (const raw of fx.turn1) seeded.seed(raw, provider.normalizeMessage(raw, SID));
  assert.deepEqual(seeded.processExit('process-exit', SID), [], 'a seeded launch belongs to an earlier process');
});
