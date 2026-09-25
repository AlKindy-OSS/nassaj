import assert from 'node:assert/strict';
import test from 'node:test';

import { runPermissionExecutionAdapter } from './adapter.js';

const handle = (trace: string[]) => ({
  decisionId: 'decision', leaseId: 'lease', mode: 'legacy' as const,
  consume: () => { trace.push('consume'); return {} as never; },
  markStarted: () => { trace.push('started'); },
  attachChildIdentity: () => { trace.push('attached'); },
  settle: (outcome: string) => { trace.push(`settle:${outcome}`); },
  notStarted: () => { trace.push('not-started'); },
});

test('legacy adapter is enclosed by consume, start, and terminal success', async () => {
  const trace: string[] = [];
  await runPermissionExecutionAdapter(handle(trace), async () => { trace.push('adapter'); });
  assert.deepEqual(trace, ['consume', 'started', 'adapter', 'settle:succeeded']);
});

test('synchronous adapter throw is a failed durably-started effect', async () => {
  const trace: string[] = [];
  await assert.rejects(
    runPermissionExecutionAdapter(handle(trace), () => {
      trace.push('adapter');
      throw new Error('refused');
    }),
    /refused/,
  );
  assert.deepEqual(trace, ['consume', 'started', 'adapter', 'settle:failed']);
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
  assert.deepEqual(trace, ['consume', 'started', 'adapter', 'settle:failed']);
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
    'consume', 'start-failed', 'settle:reconciled_unknown',
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

test('failed markStarted never invokes the effect', async () => {
  const trace: string[] = [];
  let invoked = false;
  const execution = { ...handle(trace), markStarted: () => { throw new Error('start evidence unavailable'); },
    settle: (outcome: string) => { trace.push(`settle:${outcome}`); throw new Error('receipt unavailable'); } };
  await assert.rejects(runPermissionExecutionAdapter(execution, async () => { invoked = true; }), /start evidence unavailable/);
  assert.equal(invoked, false);
  assert.deepEqual(trace, ['consume', 'settle:reconciled_unknown']);
});

test('synchronous throw after entering the claimed effect settles failed', async () => {
  const trace: string[] = [];
  let effects = 0;
  await assert.rejects(runPermissionExecutionAdapter(handle(trace), () => {
    effects++; throw new Error('thrown after effect');
  }), /thrown after effect/);
  assert.equal(effects, 1);
  assert.deepEqual(trace, ['consume', 'started', 'settle:failed']);
});

test('consumption refusal never invokes adapter or records terminal effect', async () => {
  const trace: string[] = [];
  const execution = { ...handle(trace), consume: () => { throw new Error('permit refused'); } };
  await assert.rejects(runPermissionExecutionAdapter(execution, async () => { trace.push('effect'); }), /permit refused/);
  assert.deepEqual(trace, []);
});
