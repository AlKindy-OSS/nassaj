/**
 * ADR-199 P1: the Claude adapter attaches the neutral `plan` and `subagent`
 * fields on the live SDK path and on the JSONL history path.
 *
 * Fixtures are real captures, scrubbed (see each file's `_provenance`): a live
 * SDK stream-json run with two TodoWrite snapshots, a background Agent launch
 * and its child row, plus recorded transcript rows for a completed foreground
 * Agent call and a denied background one.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { claudeProjectsSandbox } from '@/shared/__tests__/provider-root-sandbox.js';

import { closeConnection, getConnection, initializeDatabase, participantsDb, sessionsDb } from '@/modules/database/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { projectLightHistory, resetHistorySnapshotCacheForTests } from '../../../services/session-history-light.service.js';
import { sessionsService } from '../../../services/sessions.service.js';
import { createClaudeSubagentTracker } from '../claude-progress.js';
import { claudeSettlements, createClaudeProgressFold } from '../claude-progress-fold.js';
import { ClaudeSessionsProvider } from '../claude-sessions.provider.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SID = '00000000-0000-4000-8000-000000000001';

async function fixture(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(HERE, '__fixtures__', name), 'utf8'));
}

/** Mirrors the per-run composition in server/claude-sdk.js: normalize, then pair. */
function runLive(events: Array<Record<string, unknown>>): NormalizedMessage[] {
  const provider = new ClaudeSessionsProvider();
  const tracker = createClaudeSubagentTracker();
  const out: NormalizedMessage[] = [];
  for (const event of events) {
    const rows = provider.normalizeMessage(event, SID);
    tracker.observe(event, rows);
    out.push(...rows);
  }
  return out;
}

test('live: TodoWrite snapshots become neutral plans, latest snapshot last', async () => {
  const { events } = await fixture('claude-progress-sdk-stream.real.json');
  const plans = runLive(events).filter((m) => m.plan).map((m) => m.plan);
  assert.deepEqual(plans, [
    { source: 'tool', items: [
      { id: '0', label: 'Say hello', status: 'in_progress' }, { id: '1', label: 'Say bye', status: 'pending' },
    ], counts: { done: 0, total: 2 } },
    { source: 'tool', items: [
      { id: '0', label: 'Say hello', status: 'completed' }, { id: '1', label: 'Say bye', status: 'completed' },
    ], counts: { done: 2, total: 2 } },
  ]);
});

test('live: an Agent launch is started then running; its child row carries the parent id only', async () => {
  const { events } = await fixture('claude-progress-sdk-stream.real.json');
  const rows = runLive(events);
  const agentId = 'toolu_01WcE3ua1KLZd5XE3Etd6sPo';
  const lifecycle = rows.filter((m) => m.subagent).map((m) => [m.kind, m.subagent]);
  assert.deepEqual(lifecycle, [
    ['tool_use', { id: agentId, parentId: null, label: 'Reply OK', state: 'started' }],
    ['tool_result', { id: agentId, parentId: null, label: 'Reply OK', state: 'running' }],
  ]);
  const child = rows.find((m) => m.kind === 'text' && m.content === 'OK');
  assert.equal(child?.parentToolUseId, agentId);
  assert.equal(child?.isSidechain, true);
  assert.equal(child?.subagent, undefined, 'subagent prose is not a lifecycle row');
  const todoResult = rows.find((m) => m.kind === 'tool_result' && m.toolId === 'toolu_01NQReCbsFjRsqPEtViRc7uM');
  assert.equal(todoResult?.subagent, undefined, 'non-delegation results stay untouched');
});

test('history: recorded transcript rows yield completed and failed lifecycles; light projection round-trips', async () => {
  const { rows } = await fixture('claude-progress-history.real.json');
  const dir = await mkdtemp('/var/tmp/claude-progress-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  resetHistorySnapshotCacheForTests();
  try {
    const file = path.join(claudeProjectsSandbox('claude-progress-'), `${SID}.jsonl`);
    await writeFile(file, `${rows.map((row: unknown) => JSON.stringify(row)).join('\n')}\n`);
    getConnection().prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'h', 'user')").run();
    sessionsDb.createSession(SID, 'claude', dir, undefined, undefined, undefined, file);
    participantsDb.recordSpawn(SID, 1);
    const history = await sessionsService.fetchHistory(SID, 1, {});
    const states = history.messages.filter((m) => m.subagent)
      .map((m) => [m.kind, m.subagent?.label, m.subagent?.state]);
    assert.deepEqual(states, [
      ['tool_use', 'Diagnose send failure', 'started'],
      ['tool_result', 'Diagnose send failure', 'completed'],
      ['tool_use', 'Design activation change', 'started'],
      ['tool_result', 'Design activation change', 'failed'],
    ]);
    const light = projectLightHistory(history);
    const carriers = light.messages.filter((m) => m.subagent);
    assert.deepEqual(carriers.map((m) => m.subagent), history.messages.filter((m) => m.subagent).map((m) => m.subagent));
    for (const message of carriers) {
      const deferred = (message as { deferredPayload?: { fields: string[] } }).deferredPayload?.fields ?? [];
      assert.ok(!deferred.includes('subagent'), 'subagent is inline, never deferred');
    }
  } finally {
    resetHistorySnapshotCacheForTests();
    closeConnection();
    await rm(dir, { recursive: true, force: true });
  }
});

test('live: the SDK system/task_notification event settles a background Agent (real capture)', async () => {
  const { events } = await fixture('claude-bg-task-notification.real.json');
  const note = events.find((e: Record<string, unknown>) => e.subtype === 'task_notification');
  const launch = events[0].message.content[0];
  assert.equal(launch.input.run_in_background, true);
  assert.deepEqual(claudeSettlements(note), [{ toolUseId: launch.id, state: 'completed' }]);
  assert.deepEqual(claudeSettlements({ ...note, status: 'paused' }), [], 'unknown status settles nothing');
  assert.deepEqual(claudeSettlements({ ...note, subtype: 'task_updated' }), []);

  const provider = new ClaudeSessionsProvider();
  const fold = createClaudeProgressFold('live', SID);
  const out: NormalizedMessage[] = [];
  for (const event of events) {
    const rows = provider.normalizeMessage(event, SID);
    out.push(...rows, ...fold.observe(event, rows));
  }
  const states = out.filter((m) => m.subagent?.id === launch.id).map((m) => m.subagent?.state);
  assert.equal(states.at(-1), 'completed');
  assert.ok(states.includes('running') || states.includes('started'));
  const settled = out.filter((m) => m.kind === 'status' && m.subagent?.state === 'completed');
  assert.equal(settled.length, 1, 'one settlement for one notification');
  assert.equal(settled[0].subagent?.label, 'Bg demo');
});
