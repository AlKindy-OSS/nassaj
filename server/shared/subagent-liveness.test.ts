import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProgressSubagent, boundProgressSubagent } from './progress-normalize.js';
import { applySubagentLiveness } from './subagent-liveness.js';
import type { NormalizedMessage } from './types.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-18T12:00:00.000Z');

function row(fields: Partial<NormalizedMessage> & { state?: string; id?: string }): NormalizedMessage {
  const { state, id = 'a1', ...rest } = fields;
  const subagent = state ? buildProgressSubagent({ id, label: 'job', state }) ?? undefined : undefined;
  return { id: `${rest.kind}-${id}-${state}`, sessionId: 's', provider: 'codex', kind: 'status',
    timestamp: new Date(NOW - HOUR).toISOString(), ...rest, ...(subagent ? { subagent } : {}) } as NormalizedMessage;
}

test('alive: running stays running; the session timeout settles a silent delegation as unknown (timeout)', () => {
  const fresh = [row({ kind: 'status', state: 'running' })];
  assert.equal(applySubagentLiveness(fresh, { alive: true, timeoutMs: 6 * HOUR, now: NOW }), 0);
  assert.equal(fresh[0].subagent?.state, 'running');
  const silent = [row({ kind: 'status', state: 'running', timestamp: new Date(NOW - 7 * HOUR).toISOString() })];
  assert.equal(applySubagentLiveness(silent, { alive: true, timeoutMs: 6 * HOUR, now: NOW }), 1);
  assert.deepEqual([silent[0].subagent?.state, silent[0].subagent?.inferredCause], ['unknown', 'timeout']);
  const claude = [row({ kind: 'status', state: 'running', timestamp: new Date(NOW - 7 * HOUR).toISOString() })];
  assert.equal(applySubagentLiveness(claude, { alive: true, timeoutMs: null, now: NOW }), 0, 'N6: no timeout on Claude');
});

test('dead: unsettled → unknown (process-exit) or stopped (owner); ended rows untouched', () => {
  const rows = [
    row({ kind: 'tool_use', toolId: 'a1', id: 'a1', state: 'started' }),
    row({ kind: 'tool_use', toolId: 'a2', id: 'a2', state: 'started' }),
    row({ kind: 'tool_use', toolId: 'a3', id: 'a3', state: 'started' }),
    row({ kind: 'tool_result', toolId: 'a3', id: 'a3', state: 'failed' }),
    row({ kind: 'status', id: 'a3', state: 'running' }),
    row({ kind: 'tool_use', toolId: 'a4', id: 'a4', state: 'started' }),
    { id: 'r4', sessionId: 's', provider: 'codex', kind: 'tool_result', toolId: 'a4', timestamp: '' } as NormalizedMessage,
  ];
  assert.equal(applySubagentLiveness(rows, { alive: false, timeoutMs: null, ownerStoppedIds: ['a2'], now: NOW }), 2);
  assert.deepEqual([rows[0].subagent?.state, rows[0].subagent?.inferredCause], ['unknown', 'process-exit']);
  assert.deepEqual([rows[1].subagent?.state, rows[1].subagent?.inferredCause], ['stopped', 'owner']);
  assert.equal(rows[3].subagent?.state, 'failed');
  assert.equal(rows[4].subagent?.state, 'running', 'a later non-terminal row never reopens; no overlay on it');
  assert.equal(rows[5].subagent?.state, 'started', 'a plain tool_result resolved it, as the client reads it');
});

test('unknown liveness skips the overlay; bounds keep the inferred cause', () => {
  const rows = [row({ kind: 'status', state: 'running' })];
  assert.equal(applySubagentLiveness(rows, { alive: null, timeoutMs: 1, now: NOW }), 0);
  assert.equal(rows[0].subagent?.state, 'running');
  const bounded = boundProgressSubagent({ id: 'x', label: 'l', state: 'unknown', inferredCause: 'process-exit' });
  assert.equal(bounded?.inferredCause, 'process-exit');
  assert.equal(boundProgressSubagent({ id: 'x', label: 'l', state: 'completed', inferredCause: 'owner' })?.inferredCause,
    undefined, 'a measured state never carries a cause');
  assert.equal(boundProgressSubagent({ id: 'x', label: 'l', state: 'killed' }), null);
});
