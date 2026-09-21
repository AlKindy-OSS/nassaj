import assert from 'node:assert/strict';
import test from 'node:test';

import { runPermissionExecutionAdapter } from './adapter.js';

const handle = (trace: string[]) => ({
  decisionId: 'decision', leaseId: 'lease', mode: 'legacy' as const,
  consume: () => { trace.push('consume'); return {} as never; },
  markStarted: () => { trace.push('started'); },
  settle: (outcome: string) => { trace.push(`settle:${outcome}`); },
  notStarted: () => { trace.push('not-started'); },
});

test('legacy adapter is enclosed by consume, start, and terminal success', async () => {
  const trace: string[] = [];
  await runPermissionExecutionAdapter(handle(trace), async () => { trace.push('adapter'); });
  assert.deepEqual(trace, ['consume', 'adapter', 'started', 'settle:succeeded']);
});

test('synchronous adapter throw leaves effect unknown without a not-started contract', async () => {
  const trace: string[] = [];
  await assert.rejects(
    runPermissionExecutionAdapter(handle(trace), () => {
      trace.push('adapter');
      throw new Error('refused');
    }),
    /refused/,
  );
  assert.deepEqual(trace, ['consume', 'adapter', 'settle:reconciled_unknown']);
});

test('asynchronous adapter rejection is terminal failed after start evidence', async () => {
  const trace: string[] = [];
  await assert.rejects(
    runPermissionExecutionAdapter(handle(trace), async () => {
      trace.push('adapter');
      throw new Error('async failure');
    }),
    /async failure/,
  );
  assert.deepEqual(trace, ['consume', 'adapter', 'started', 'settle:failed']);
});

test('start-evidence failure records unknown rather than a false spawn failure', async () => {
  const trace: string[] = [];
  const execution = {
    ...handle(trace),
    markStarted: () => { trace.push('start-failed'); throw new Error('audit unavailable'); },
  };
  await assert.rejects(
    runPermissionExecutionAdapter(execution, async () => { trace.push('adapter'); }),
    /audit unavailable/,
  );
  assert.deepEqual(trace, [
    'consume', 'adapter', 'start-failed', 'settle:reconciled_unknown',
  ]);
});

test('successful effect with failed receipt persistence settles succeeded only once', async () => {
  const trace: string[] = [];
  let effects = 0;
  const execution = { ...handle(trace), settle: (outcome: string) => {
    trace.push(`settle:${outcome}`); throw new Error('receipt storage unavailable');
  } };
  await assert.rejects(runPermissionExecutionAdapter(execution, async () => { effects++; return 'result'; }), /receipt storage unavailable/);
  assert.equal(effects, 1);
  assert.deepEqual(trace, ['consume', 'started', 'settle:succeeded']);
});

test('provider failure with failed settlement preserves cause and attempts settlement once', async () => {
  const trace: string[] = [];
  const execution = { ...handle(trace), settle: (outcome: string) => {
    trace.push(`settle:${outcome}`); throw new Error('receipt storage unavailable');
  } };
  await assert.rejects(runPermissionExecutionAdapter(execution, async () => { throw new Error('provider failed'); }), /provider failed/);
  assert.deepEqual(trace, ['consume', 'started', 'settle:failed']);
});

test('failed markStarted observes later rejection while keeping effect unknown', async () => {
  const trace: string[] = [];
  let rejectEffect!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectEffect = reject; });
  const execution = { ...handle(trace), markStarted: () => { throw new Error('start evidence unavailable'); },
    settle: (outcome: string) => { trace.push(`settle:${outcome}`); throw new Error('receipt unavailable'); } };
  await assert.rejects(runPermissionExecutionAdapter(execution, () => pending), /start evidence unavailable/);
  rejectEffect(new Error('late provider failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(trace, ['consume', 'settle:reconciled_unknown']);
});

test('synchronous throw after an effect does not claim spawn_failed or notStarted', async () => {
  const trace: string[] = [];
  let effects = 0;
  await assert.rejects(runPermissionExecutionAdapter(handle(trace), () => {
    effects++; throw new Error('thrown after effect');
  }), /thrown after effect/);
  assert.equal(effects, 1);
  assert.deepEqual(trace, ['consume', 'settle:reconciled_unknown']);
});

test('consumption refusal never invokes adapter or records terminal effect', async () => {
  const trace: string[] = [];
  const execution = { ...handle(trace), consume: () => { throw new Error('permit refused'); } };
  await assert.rejects(runPermissionExecutionAdapter(execution, async () => { trace.push('effect'); }), /permit refused/);
  assert.deepEqual(trace, []);
});
