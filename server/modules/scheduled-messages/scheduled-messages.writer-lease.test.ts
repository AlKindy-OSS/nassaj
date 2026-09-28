import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

import { createUpdateMaintenanceGate } from '../../services/update-maintenance-gate.js';
import { acquireApplicationWriterLease, setApplicationWriterGateForTests } from '../../services/update-writer-lease.js';

import { createScheduledTurnDispatcher } from './scheduled-messages.dispatch.js';
import { ACCEPTANCE_UNOBSERVED, createScheduledMessagesService } from './scheduled-messages.service.js';

const previous = { mode: process.env.NASSAJ_UPDATE_MODE, environment: process.env.NODE_ENV };
process.env.NODE_ENV = 'test';
process.env.NASSAJ_UPDATE_MODE = 'local-main';
after(() => {
  setApplicationWriterGateForTests(null);
  for (const [key, value] of [['NASSAJ_UPDATE_MODE', previous.mode], ['NODE_ENV', previous.environment]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function gate() {
  const state = {
    acquired: 0, released: 0, closed: false, refusedKinds: new Map<string, string>(),
    acquiredKinds: [] as string[], releasedKinds: [] as string[],
  };
  setApplicationWriterGateForTests({ async acquireWriterLease({ kind }: { kind: string }) {
    if (state.closed) throw new Error('update_maintenance_active');
    const refusal = state.refusedKinds.get(kind);
    if (refusal) throw new Error(refusal);
    state.acquired += 1;
    state.acquiredKinds.push(kind);
    return { release() { state.released += 1; state.releasedKinds.push(kind); } };
  } });
  return state;
}

function service(dispatch: () => Promise<unknown>, claims: Array<Record<string, unknown>>) {
  let claimCalls = 0;
  const settled: string[] = [];
  const instance = createScheduledMessagesService({
    repository: {
      failExpiredExhausted: () => [],
      claimDue: () => { claimCalls += 1; return claims.shift() ?? null; },
      renewLease: () => true,
      settle: (id: string) => { settled.push(id); return true; },
    },
    getActiveUser: (id: number) => ({ id, role: 'user', authorization_generation: 1 }),
    sessionExists: () => true,
    canWriteSession: () => true,
    dispatch,
    audit: () => {},
    now: () => Date.parse('2026-09-03T09:00:00.000Z'),
  } as never);
  return { instance, settled, claimCalls: () => claimCalls };
}

test('B-1390: the update-writer lease is released at acceptance, not held for the turn', async () => {
  const state = gate();
  let turnDone = false;
  const neverEnding = new Promise<void>(() => {});
  const h = service(async () => ({ success: true, retryable: false, completion: neverEnding.then(() => { turnDone = true; }) }), [
    { id: 'm-1', userId: 1, sessionId: 's-1', attempts: 1, leaseToken: 'lease-1' },
  ]);

  await h.instance.tick();

  assert.deepEqual(h.settled, ['m-1']);
  assert.equal(turnDone, false);
  assert.equal(state.acquired, 1);
  assert.equal(state.released, 1, 'the writer lease is still held by a running turn');
});

test('B-1390: a maintenance window defers the poll before any row is claimed', async () => {
  const state = gate();
  state.closed = true;
  const h = service(async () => ({ success: true, retryable: false }), [
    { id: 'm-2', userId: 1, sessionId: 's-2', attempts: 1, leaseToken: 'lease-2' },
  ]);

  await h.instance.tick();

  assert.equal(h.claimCalls(), 0);
  assert.deepEqual(h.settled, []);
});

type Writer = { send(payload: unknown): void };

/**
 * The real service wired to the real dispatcher; only the provider command and
 * the repository are fakes. `runTurn` plays the provider for one turn.
 */
function composed(runTurn: (writer: Writer) => Promise<void>, acceptanceTimeoutMs?: number) {
  const settled: Array<{ id: string; outcome: Record<string, unknown> }> = [];
  const claims: Array<Record<string, unknown>> = [
    { id: 'c-1', userId: 1, sessionId: 's-c', content: 'go', options: {}, attempts: 1, leaseToken: 'lease-c' },
  ];
  const dispatch = createScheduledTurnDispatcher<Writer>({
    getSession: () => ({ project_path: '/p', provider: 'codex' }),
    createWriter: () => ({ send() {} }),
    dispatchProviderCommand: (_type, _data, writer) => runTurn(writer),
    isAcceptanceFrame: (payload) => payload.kind === 'stream_delta',
    // The production wiring (server/index.js), through the same lease module.
    acquireWriterLease: (kind) => acquireApplicationWriterLease(kind, { waitMs: 30 }),
    logger: { error() {} },
  });
  const instance = createScheduledMessagesService({
    repository: {
      failExpiredExhausted: () => [],
      claimDue: () => claims.shift() ?? null,
      renewLease: () => true,
      settle: (id: string, _token: string, outcome: Record<string, unknown>) => { settled.push({ id, outcome }); return true; },
    },
    getActiveUser: (id: number) => ({ id, role: 'user', authorization_generation: 1 }),
    sessionExists: () => true,
    canWriteSession: () => true,
    dispatch,
    audit: () => {},
    now: () => Date.parse('2026-09-03T09:00:00.000Z'),
    ...(acceptanceTimeoutMs ? { acceptanceTimeoutMs } : {}),
  } as never);
  return { instance, settled };
}

/** Resolves once `predicate` holds, polling the event loop (bounded). */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let spins = 0; spins < 200; spins += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  assert.fail(`timed out waiting for: ${label}`);
}

test('B-1390: composed — the tick lease is released at acceptance while the turn holds its own lease', async () => {
  const state = gate();
  let endTurn!: () => void;
  const turnEnds = new Promise<void>((resolve) => { endTurn = resolve; });
  const { instance, settled } = composed(async (writer) => {
    writer.send({ kind: 'stream_delta', content: 'x' });
    await turnEnds;
  });

  await instance.tick();

  assert.deepEqual(settled, [{ id: 'c-1', outcome: { success: true, retryable: false } }]);
  assert.deepEqual(state.acquiredKinds, ['scheduled-message', 'provider-turn'],
    'the turn piggybacked on the tick lease instead of acquiring its own');
  assert.deepEqual(state.releasedKinds, ['scheduled-message'],
    'the tick lease must be released at acceptance while the turn lease is still held');

  endTurn();
  await until(() => state.releasedKinds.length === 2, 'the turn lease to be released');
  assert.deepEqual(state.releasedKinds, ['scheduled-message', 'provider-turn']);
});

test('B-1390: composed — a turn that never shows acceptance releases the tick lease at the timeout', async () => {
  const state = gate();
  let endTurn!: () => void;
  const { instance, settled } = composed(async () => {
    await new Promise<void>((resolve) => { endTurn = resolve; });
  }, 25);

  await instance.tick();

  assert.deepEqual(settled, [{
    id: 'c-1', outcome: { success: true, retryable: false, errorCode: ACCEPTANCE_UNOBSERVED },
  }]);
  assert.deepEqual(state.releasedKinds, ['scheduled-message']);
  endTurn();
  await until(() => state.acquired === state.released, 'every writer lease to be released');
});

test('B-1390: composed — an update-gate refusal leaves the row pending, never sent or failed', async () => {
  const state = gate();
  state.refusedKinds.set('provider-turn', 'update_lock_contended');
  let dispatched = false;
  const { instance, settled } = composed(async () => { dispatched = true; });

  await instance.tick();

  assert.equal(dispatched, false);
  assert.deepEqual(settled, [{
    id: 'c-1',
    outcome: {
      success: false, retryable: true, errorCode: 'update_maintenance_active', refundAttempt: true,
      retryAt: '2026-09-03T09:01:00.000Z',
    },
  }]);
  assert.deepEqual(state.releasedKinds, ['scheduled-message']);
  assert.equal(state.acquired, state.released);
});

test('B-1390: a real update gate cannot begin while a scheduled turn runs, and can after it ends', async (t) => {
  const root = fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TEMP_ROOT || '/var/tmp', 'nassaj-scheduled-turn-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const realGate = createUpdateMaintenanceGate({ projectPath: root });
  setApplicationWriterGateForTests(realGate);
  const identity = {
    transactionId: 'update-transaction-1390', expectedVersion: '1.44.0.2',
    originalHead: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
  };
  let endTurn!: () => void;
  let turnEnded = false;
  const turnEnds = new Promise<void>((resolve) => { endTurn = resolve; });
  const { instance, settled } = composed(async (writer) => {
    writer.send({ kind: 'stream_delta', content: 'x' });
    await turnEnds;
    turnEnded = true;
  });

  await instance.tick();
  assert.deepEqual(settled, [{ id: 'c-1', outcome: { success: true, retryable: false } }]);
  await assert.rejects(realGate.beginUpdate(identity, { waitMs: 30 }), /update_lock_contended/,
    'a source update began while a scheduled turn was still running');

  endTurn();
  await until(() => turnEnded, 'the scheduled turn to end');
  await new Promise((resolve) => { setImmediate(resolve); });
  const update = await realGate.beginUpdate(identity, { waitMs: 100 });
  assert.equal(realGate.readPublicStatus().state, 'UPDATING');
  update.transition(['PREPARED'], 'SOURCE_APPLYING');
  update.transition(['SOURCE_APPLYING'], 'SOURCE_APPLIED');
  update.complete();
  update.release();
});
