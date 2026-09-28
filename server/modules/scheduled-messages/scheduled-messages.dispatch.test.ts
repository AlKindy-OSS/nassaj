import assert from 'node:assert/strict';
import test from 'node:test';

import { createScheduledTurnDispatcher, verdictFromTerminal } from './scheduled-messages.dispatch.js';

const USER = { id: 7, role: 'user', authorization_generation: 3 };
const MESSAGE = {
  id: 'scheduled-9', userId: 7, sessionId: 'session-9', content: 'hello', options: { model: 'm' },
  scheduledFor: '', availableAt: '', status: 'running', attempts: 1, maxAttempts: 3, leaseToken: 'lease',
  leaseExpiresAt: null, lastErrorCode: null, sentAt: null, createdAt: '', updatedAt: '',
} as never;

type Writer = { send(payload: unknown): void; sent: unknown[] };

type Leases = { acquired: string[]; released: number; refuseWith: string | null };

function build(run: (writer: Writer, finish: Promise<void>) => Promise<void>) {
  const leases: Leases = { acquired: [], released: 0, refuseWith: null };
  let finishTurn!: () => void;
  const finish = new Promise<void>((resolve) => { finishTurn = resolve; });
  const calls: Array<{ messageType: string; data: Record<string, unknown>; principal: unknown }> = [];
  const dispatch = createScheduledTurnDispatcher<Writer>({
    getSession: () => ({ project_path: '/p', provider: 'codex' }),
    createWriter: () => {
      const writer: Writer = { sent: [], send(payload) { writer.sent.push(payload); } };
      return writer;
    },
    dispatchProviderCommand: (messageType, data, writer, _userId, principal) => {
      calls.push({ messageType, data, principal });
      return run(writer, finish);
    },
    isAcceptanceFrame: (payload) => payload.kind === 'stream_delta',
    acquireWriterLease: async (kind) => {
      if (leases.refuseWith) throw new Error(leases.refuseWith);
      leases.acquired.push(kind);
      return { release() { leases.released += 1; } };
    },
    logger: { error() {} },
  });
  return { dispatch, calls, finishTurn, leases };
}

test('resolves as delivered at the first model-activity frame while the turn keeps running', async () => {
  let turnEnded = false;
  const { dispatch, calls, finishTurn } = build(async (writer, finish) => {
    writer.send({ kind: 'status' });
    writer.send({ kind: 'stream_delta', content: 'x' });
    await finish;
    writer.send({ kind: 'complete', success: false, code: 'late_failure' });
    turnEnded = true;
  });

  const verdict = await dispatch(MESSAGE, USER);
  assert.equal(verdict.success, true);
  assert.equal(verdict.retryable, false);
  assert.equal(turnEnded, false, 'dispatch waited for the whole turn');
  assert.equal(calls[0].messageType, 'codex-command');
  assert.equal((calls[0].data.options as Record<string, unknown>).clientMsgId, 'scheduled:scheduled-9');

  finishTurn();
  await verdict.completion;
  assert.equal(turnEnded, true);
});

test('a terminal refusal before acceptance maps to the existing retry verdicts', async () => {
  const busy = build(async (writer) => {
    writer.send({ kind: 'complete', success: false, code: 'session_busy', notStarted: true });
  });
  assert.deepEqual(
    { ...(await busy.dispatch(MESSAGE, USER)), completion: undefined },
    { success: false, retryable: true, errorCode: 'session_busy', completion: undefined },
  );

  const refused = build(async (writer) => {
    writer.send({ kind: 'error', success: false });
  });
  const verdict = await refused.dispatch(MESSAGE, USER);
  assert.equal(verdict.success, false);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.errorCode, 'provider_failed');
});

test('a run that ends with no frames is retryable, and a throw before acceptance rejects', async () => {
  const silent = build(async () => {});
  const verdict = await silent.dispatch(MESSAGE, USER);
  assert.equal(verdict.errorCode, 'missing_terminal_verdict');
  assert.equal(verdict.retryable, true);

  const broken = build(async () => { throw new Error('spawn failed'); });
  await assert.rejects(() => broken.dispatch(MESSAGE, USER), /spawn failed/);
});

test('a throw after acceptance is contained and still completes the turn', async () => {
  const { dispatch, finishTurn } = build(async (writer, finish) => {
    writer.send({ kind: 'stream_delta' });
    await finish;
    throw new Error('provider crashed mid-turn');
  });
  const verdict = await dispatch(MESSAGE, USER);
  assert.equal(verdict.success, true);
  finishTurn();
  await assert.doesNotReject(() => verdict.completion!);
});

test('an unusable session is refused without dispatching', async () => {
  const dispatch = createScheduledTurnDispatcher<Writer>({
    getSession: () => null,
    createWriter: () => { throw new Error('must not create'); },
    dispatchProviderCommand: () => { throw new Error('must not dispatch'); },
    isAcceptanceFrame: () => true,
    acquireWriterLease: () => { throw new Error('must not lease'); },
  });
  assert.deepEqual(await dispatch(MESSAGE, USER), {
    success: false, retryable: false, errorCode: 'session_unavailable',
  });
  assert.deepEqual(verdictFromTerminal({ kind: 'complete', exitCode: 0 }), { success: true, retryable: false });
});

test('B-1390: the provider-turn lease is held for the whole turn and released at completion', async () => {
  const { dispatch, finishTurn, leases } = build(async (writer, finish) => {
    writer.send({ kind: 'stream_delta' });
    await finish;
  });
  const verdict = await dispatch(MESSAGE, USER);
  assert.equal(verdict.success, true);
  assert.deepEqual(leases.acquired, ['provider-turn']);
  assert.equal(leases.released, 0, 'the lease was released at acceptance, before the turn ended');

  finishTurn();
  assert.deepEqual(await verdict.completion, { success: true });
  assert.equal(leases.released, 1);
});

test('B-1390: the lease is released once when an accepted turn fails', async () => {
  const { dispatch, finishTurn, leases } = build(async (writer, finish) => {
    writer.send({ kind: 'stream_delta' });
    await finish;
    throw new Error('provider crashed mid-turn');
  });
  const verdict = await dispatch(MESSAGE, USER);
  finishTurn();
  assert.deepEqual(await verdict.completion, { success: false, errorCode: 'turn_failed' });
  assert.equal(leases.released, 1);
});

test('B-1390: the lease is released once when the turn throws before acceptance', async () => {
  const { dispatch, leases } = build(async () => { throw new Error('spawn failed'); });
  await assert.rejects(() => dispatch(MESSAGE, USER), /spawn failed/);
  assert.deepEqual(leases.acquired, ['provider-turn']);
  assert.equal(leases.released, 1);
});

test('B-1390: a transient gate refusal is a retryable pre-acceptance verdict that refunds the attempt', async () => {
  for (const code of ['update_lock_contended', 'update_maintenance_active']) {
    const { dispatch, calls, leases } = build(async () => { throw new Error('must not dispatch'); });
    leases.refuseWith = code;
    const verdict = await dispatch(MESSAGE, USER);
    assert.deepEqual({ ...verdict, completion: undefined }, {
      success: false, retryable: true, errorCode: 'update_maintenance_active', refundAttempt: true,
      completion: undefined,
    });
    assert.equal(calls.length, 0, `the provider was dispatched despite ${code}`);
    assert.deepEqual(await verdict.completion, { success: false, errorCode: 'update_maintenance_active' });
  }
});

test('B-1390: a non-transient gate code is retryable but spends its attempt; other failures reject', async () => {
  const faulted = build(async () => {});
  faulted.leases.refuseWith = 'update_journal_invalid';
  const verdict = await faulted.dispatch(MESSAGE, USER);
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.errorCode, 'update_maintenance_active');
  assert.equal(verdict.refundAttempt, undefined);

  const broken = build(async () => {});
  broken.leases.refuseWith = 'gate constructor exploded';
  await assert.rejects(() => broken.dispatch(MESSAGE, USER), /gate constructor exploded/);
  assert.equal(broken.calls.length, 0);
});
