/**
 * turn-scoped-control.test.ts — T-2093 (ADR-TURN-SCOPED-CONTROL).
 *
 * Unit tests of the stop / approval command flow with injected ports: write
 * check first, then the per-user LRU, then the registry-scoped target.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ActiveTurnRegistry } from './active-turn-registry.js';
import { ControlCommandLru } from './control-command-lru.js';
import {
  classifyAbortOutcome,
  executeTurnScopedAbort,
  executeTurnScopedApproval,
  readControlCommandId,
  readTurnKey,
  type ControlReceipt,
  type TurnAbortOutcome,
  type TurnScopedAbortPorts,
} from './turn-scoped-control.js';

const SOCKET = { name: 'this-socket' };
const OTHER_SOCKET = { name: 'other-socket' };

function outcome(partial: Partial<TurnAbortOutcome>): TurnAbortOutcome {
  return {
    provider: 'codex', success: false, resolvedSessionId: null, abortReason: null, staleTarget: false,
    notRunning: false, ...partial,
  };
}

function makePorts(overrides: Partial<TurnScopedAbortPorts> = {}) {
  const receipts: ControlReceipt[] = [];
  const turnFrames: Array<{ sessionId: string; outcome: TurnAbortOutcome }> = [];
  const refusals: string[] = [];
  const aborts: Array<{ sessionId: string; key: string | null }> = [];
  const ports: TurnScopedAbortPorts = {
    lru: new ControlCommandLru(),
    registry: new ActiveTurnRegistry(),
    connectionWriter: SOCKET,
    isWritable: () => true,
    abort: async (sessionId, key) => {
      aborts.push({ sessionId, key });
      return outcome({ success: true, resolvedSessionId: sessionId });
    },
    sendTurnFrame: (sessionId, result) => { turnFrames.push({ sessionId, outcome: result }); },
    sendRefusal: (sessionId) => { refusals.push(sessionId); },
    sendReceipt: (receipt) => { receipts.push(receipt); },
    ...overrides,
  };
  return { ports, receipts, turnFrames, refusals, aborts };
}

test('ids: only bounded opaque identifiers are accepted', () => {
  assert.equal(readControlCommandId('cmd_1-a.b:c'), 'cmd_1-a.b:c');
  assert.equal(readControlCommandId(''), null);
  assert.equal(readControlCommandId('x'.repeat(129)), null);
  assert.equal(readControlCommandId({ id: 1 }), null);
  assert.equal(readControlCommandId('-leading'), null);
  assert.equal(readTurnKey('cmid_abc'), 'cmid_abc');
  assert.equal(readTurnKey(42), null);
});

test('classifyAbortOutcome maps every outcome to a final status', () => {
  assert.equal(classifyAbortOutcome(outcome({ success: true })), 'stopped');
  assert.equal(classifyAbortOutcome(outcome({ staleTarget: true })), 'stale_target');
  assert.equal(classifyAbortOutcome(outcome({ notRunning: true })), 'not_running');
  assert.equal(classifyAbortOutcome(outcome({ abortReason: 'interrupt() failed: x' })), 'failed');
});

test('double stop with one commandId: bridge called once, second receipt duplicate:true', async () => {
  const { ports, receipts, aborts, turnFrames } = makePorts();
  const request = { userId: 1, commandId: 'stop-1', sessionId: 's1', targetTurnKey: 'k1' };
  await executeTurnScopedAbort(request, ports);
  await executeTurnScopedAbort(request, ports);
  assert.equal(aborts.length, 1);
  assert.equal(turnFrames.length, 1, 'the broadcast complete is not repeated on replay');
  assert.deepEqual(receipts.map((r) => [r.status, r.duplicate]), [['stopped', false], ['stopped', true]]);
  assert.equal(receipts[0].type, 'control-command-receipt');
  assert.equal(receipts[0].kind, 'abort');
  assert.equal(receipts[0].commandId, 'stop-1');
});

test('write check precedes the LRU: a refused requester never gets the stored result', async () => {
  let writable = true;
  const { ports, receipts, refusals, aborts } = makePorts({ isWritable: () => writable });
  const request = { userId: 1, commandId: 'stop-1', sessionId: 's1', targetTurnKey: 'k1' };
  await executeTurnScopedAbort(request, ports);
  writable = false;
  await executeTurnScopedAbort(request, ports);
  assert.equal(aborts.length, 1);
  assert.deepEqual(refusals, ['s1']);
  assert.equal(receipts[1].status, 'refused');
  assert.equal(receipts[1].duplicate, false);
  assert.deepEqual(receipts[1].result, { sessionId: 's1' }, 'nothing from the stored result leaks');
});

test('ADR-173 stop right: a refused stop is answered refused and never stored', async () => {
  let allowed = false;
  const { ports, receipts, aborts } = makePorts({ authorizeStop: () => allowed });
  const request = { userId: 2, commandId: 'c', sessionId: 's1', targetTurnKey: 'k1' };
  await executeTurnScopedAbort(request, ports);
  assert.equal(aborts.length, 0);
  assert.equal(receipts[0].status, 'refused');
  allowed = true;
  await executeTurnScopedAbort(request, ports);
  assert.equal(aborts.length, 1);
  assert.deepEqual([receipts[1].status, receipts[1].duplicate], ['stopped', false]);
});

test('a stale target kills nothing visible: no broadcast complete, status stale_target', async () => {
  const { ports, receipts, turnFrames } = makePorts({
    abort: async () => outcome({ staleTarget: true, resolvedSessionId: 's1', abortReason: 'stale_target' }),
  });
  await executeTurnScopedAbort({ userId: 1, commandId: 'c', sessionId: 's1', targetTurnKey: 'old' }, ports);
  assert.equal(turnFrames.length, 0, 'the newer turn keeps its spinner on every viewer');
  assert.equal(receipts[0].status, 'stale_target');
});

test('nothing running is a final not_running receipt that clears the spinner', async () => {
  const { ports, receipts, turnFrames } = makePorts({
    abort: async () => outcome({ notRunning: true, abortReason: 'no run' }),
  });
  await executeTurnScopedAbort({ userId: 1, commandId: 'c', sessionId: 's1', targetTurnKey: 'k' }, ports);
  assert.equal(receipts[0].status, 'not_running');
  assert.equal(turnFrames.length, 1, 'the legacy complete still reaches the viewers');
});

test('the stop fingerprint covers the target: same commandId for another turn is reused', async () => {
  const { ports, receipts, aborts } = makePorts();
  await executeTurnScopedAbort({ userId: 1, commandId: 'c', sessionId: 's1', targetTurnKey: 'k1' }, ports);
  await executeTurnScopedAbort({ userId: 1, commandId: 'c', sessionId: 's1', targetTurnKey: 'k2' }, ports);
  assert.equal(aborts.length, 1);
  assert.equal(receipts[1].status, 'command_id_reused');
});

test('cross-user: the same commandId from another user executes independently', async () => {
  const { ports, aborts, receipts } = makePorts();
  await executeTurnScopedAbort({ userId: 1, commandId: 'c', sessionId: 's1', targetTurnKey: 'k1' }, ports);
  await executeTurnScopedAbort({ userId: 2, commandId: 'c', sessionId: 's1', targetTurnKey: 'k1' }, ports);
  assert.equal(aborts.length, 2);
  assert.equal(receipts[1].duplicate, false);
});

test('empty id: resolves the starter\'s own turn on THIS connection through the registry', async () => {
  const { ports, aborts } = makePorts();
  ports.registry.register({ sessionId: 's-new', turnKey: 'k1', starterUserId: 1, writer: SOCKET });
  await executeTurnScopedAbort({ userId: 1, commandId: 'c', sessionId: '', targetTurnKey: 'k1' }, ports);
  assert.deepEqual(aborts, [{ sessionId: 's-new', key: 'k1' }]);
});

test('empty id: another connection or another starter never resolves the session', async () => {
  const { ports, aborts } = makePorts();
  ports.registry.register({ sessionId: 's-a', turnKey: 'k1', starterUserId: 1, writer: OTHER_SOCKET });
  ports.registry.register({ sessionId: 's-b', turnKey: 'k2', starterUserId: 2, writer: SOCKET });
  await executeTurnScopedAbort({ userId: 1, commandId: 'c1', sessionId: '', targetTurnKey: 'k1' }, ports);
  await executeTurnScopedAbort({ userId: 1, commandId: 'c2', sessionId: '', targetTurnKey: 'k2' }, ports);
  assert.deepEqual(aborts, [{ sessionId: '', key: 'k1' }, { sessionId: '', key: 'k2' }],
    'the empty id stays empty: only the connection-scoped provider fallback may act');
});

test('empty id: a resolved session that is not writable is not targeted', async () => {
  const { ports, aborts } = makePorts({ isWritable: (sessionId) => sessionId !== 's-new' });
  ports.registry.register({ sessionId: 's-new', turnKey: 'k1', starterUserId: 1, writer: SOCKET });
  await executeTurnScopedAbort({ userId: 1, commandId: 'c', sessionId: '', targetTurnKey: 'k1' }, ports);
  assert.deepEqual(aborts, [{ sessionId: '', key: 'k1' }]);
});

function makeApprovalPorts(resolveResult: { resolved: boolean; sessionId: string | null }) {
  const receipts: ControlReceipt[] = [];
  const resolvedSessions: string[] = [];
  let calls = 0;
  return {
    receipts,
    resolvedSessions,
    calls: () => calls,
    ports: {
      lru: new ControlCommandLru(),
      resolve: () => { calls += 1; return resolveResult; },
      onResolved: (sessionId: string) => { resolvedSessions.push(sessionId); },
      sendReceipt: (receipt: ControlReceipt) => { receipts.push(receipt); },
    },
  };
}

test('approval: first answer applied, replay of the same commandId duplicate without re-resolving', async () => {
  const harness = makeApprovalPorts({ resolved: true, sessionId: 's1' });
  const request = { userId: 1, commandId: 'ap-1', requestId: 'req-1', allow: true };
  await executeTurnScopedApproval(request, harness.ports);
  await executeTurnScopedApproval(request, harness.ports);
  assert.equal(harness.calls(), 1);
  assert.deepEqual(harness.resolvedSessions, ['s1']);
  assert.deepEqual(harness.receipts.map((r) => [r.status, r.duplicate]), [['applied', false], ['applied', true]]);
  assert.deepEqual(harness.receipts[0].result, { requestId: 'req-1' }, 'reveals nothing about who or what');
});

test('approval: a second answer (new commandId) on a resolved request is already_resolved', async () => {
  const harness = makeApprovalPorts({ resolved: false, sessionId: 's1' });
  await executeTurnScopedApproval({ userId: 2, commandId: 'ap-2', requestId: 'req-1', allow: false }, harness.ports);
  assert.equal(harness.receipts[0].status, 'already_resolved');
  assert.deepEqual(harness.receipts[0].result, { requestId: 'req-1' });
  assert.deepEqual(harness.resolvedSessions, [], 'no broadcast for an unresolved answer');
});

test('condition 6: a flipped allow under the same commandId is command_id_reused', async () => {
  const harness = makeApprovalPorts({ resolved: true, sessionId: 's1' });
  await executeTurnScopedApproval({ userId: 1, commandId: 'ap', requestId: 'req-1', allow: true }, harness.ports);
  await executeTurnScopedApproval({ userId: 1, commandId: 'ap', requestId: 'req-1', allow: false }, harness.ports);
  assert.equal(harness.calls(), 1);
  assert.equal(harness.receipts[1].status, 'command_id_reused');
});
