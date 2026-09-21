import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { AdmissionVerdict } from './resource-admission.js';
import type { RunRecord, TurnRecord } from './types.js';
import type { TurnAdapterInvoke, TurnAdapterResult, TurnCapabilityToken } from './adapters/types.js';
import { TurnOrchestrator, TurnOrchestratorError, type OrchestratorConfig } from './orchestrator.js';

const stamp = '2026-08-19T00:00:00.000Z';
const turn = (): TurnRecord => ({
  turnId: 'turn-1', userId: 1, clientMsgId: 'client-1', requestFingerprint: 'fp', sessionId: 's1',
  state: 'accepted', epoch: 0, terminalOutcome: null, createdAt: stamp, updatedAt: stamp,
});
const run = (): RunRecord => ({
  runId: 'run-1', turnId: 'turn-1', attempt: 1, state: 'claimed', epoch: 0,
  terminalOutcome: null, createdAt: stamp, updatedAt: stamp,
});
const target = (provider: 'kimi' | 'deepseek' | 'glm', model: string) => ({ provider, model });
const config: OrchestratorConfig = {
  root: target('kimi', 'root'),
  planner: target('deepseek', 'planner'),
  synthesis: target('glm', 'synthesis'),
  reviewer: target('kimi', 'reviewer'),
  workers: [
    { id: 'research', ...target('deepseek', 'worker-a') },
    { id: 'analysis', ...target('glm', 'worker-b') },
  ],
};

function harness(outputs: readonly string[], options: {
  admit?: boolean; casFailure?: boolean; writerAccepted?: boolean;
  onInvoke?: () => void;
} = {}) {
  const calls: TurnAdapterInvoke[] = [];
  const transitions: Array<{ aggregate: 'run' | 'turn'; state: string; epoch: number }> = [];
  const releases: string[] = [];
  let index = 0;
  const registry = {
    async probe() {
      return { available: true, capability: Object.freeze({}) as TurnCapabilityToken };
    },
    async invoke(input: TurnAdapterInvoke): Promise<TurnAdapterResult> {
      calls.push(input);
      const text = outputs[index++];
      if (text === undefined) throw new Error('unexpected invocation');
      options.onInvoke?.();
      return { provider: 'kimi', model: input.model, text };
    },
  };
  const repository = {
    startExecution(args: {
      runId: string; turnId: string; expectedRunEpoch: number; expectedTurnEpoch: number;
    }) {
      if (options.casFailure) throw new Error('CAS_FAILED');
      transitions.push({ aggregate: 'run', state: 'running', epoch: args.expectedRunEpoch });
      transitions.push({ aggregate: 'turn', state: 'running', epoch: args.expectedTurnEpoch });
      return {
        run: { ...run(), state: 'running' as const, epoch: args.expectedRunEpoch + 1 },
        turn: { ...turn(), state: 'running' as const, epoch: args.expectedTurnEpoch + 1 },
      };
    },
    finishExecution(args: {
      runId: string; turnId: string; expectedRunEpoch: number; expectedTurnEpoch: number;
      terminalOutcome: RunRecord['terminalOutcome'];
    }) {
      transitions.push({ aggregate: 'run', state: 'terminal', epoch: args.expectedRunEpoch });
      transitions.push({ aggregate: 'turn', state: 'terminal', epoch: args.expectedTurnEpoch });
      return {
        run: { ...run(), state: 'terminal' as const, epoch: args.expectedRunEpoch + 1,
          terminalOutcome: args.terminalOutcome },
        turn: { ...turn(), state: 'terminal' as const, epoch: args.expectedTurnEpoch + 1,
          terminalOutcome: args.terminalOutcome },
      };
    },
  };
  const admission: AdmissionVerdict = options.admit === false
    ? { admitted: false, code: 'capacity', reason: 'full' }
    : { admitted: true, idempotent: false, lease: {
      leaseId: 'lease', turnId: 'turn-1', userId: 1, ownerId: 'owner', ownerPid: 1,
      cpuReserved: 1, memoryReserved: 1, heartbeatAtMs: 1,
    } };
  const orchestrator = new TurnOrchestrator({
    registry, repository, admitRun: async () => admission,
    releaseRun: async (_input, _admission, outcome) => { releases.push(outcome); },
    writerFence: { accepts: () => options.writerAccepted !== false },
  }, config);
  return { orchestrator, calls, transitions, releases };
}

const input = (coordinationLevel: 'direct' | 'delegate' | 'delegate_review') => ({
  coordinationLevel, prompt: 'user prompt', userId: 1, turn: turn(), run: run(), writerEpoch: 1,
});

test('direct reserves and invokes the root exactly once with capture-only persistence', async () => {
  const h = harness(['root answer']);
  const result = await h.orchestrator.execute(input('direct'));
  assert.equal(result.text, 'root answer');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].model, 'root');
  assert.equal(h.calls[0].prompt, 'user prompt');
  assert.equal(h.calls[0].persist, false);
  assert.deepEqual(h.calls[0].effects, []);
  assert.equal('send' in h.calls[0].writer, false);
  assert.deepEqual(h.transitions.map(({ aggregate, state }) => `${aggregate}:${state}`), [
    'run:running', 'turn:running', 'run:terminal', 'turn:terminal',
  ]);
  assert.deepEqual(h.releases, ['succeeded']);
});

test('delegate retries one malformed plan then runs allowlisted workers and synthesis', async () => {
  const plan = JSON.stringify({
    version: 1,
    workers: [{ workerId: 'research', task: 'research task' }],
    synthesisInstructions: 'merge',
  });
  const h = harness(['not json', plan, 'worker result', 'synthesis result']);
  const result = await h.orchestrator.execute(input('delegate'));
  assert.equal(result.text, 'synthesis result');
  assert.deepEqual(h.calls.map(({ model }) => model), ['planner', 'planner', 'worker-a', 'synthesis']);
  assert.match(h.calls[1].prompt, /Retry once/);
  assert.equal(result.workerResults.length, 1);
});

test('a second malformed or non-allowlisted plan fails without root fallback', async () => {
  const h = harness(['bad', JSON.stringify({
    version: 1, workers: [{ workerId: 'escape', task: 'x' }], synthesisInstructions: 'x',
  })]);
  await assert.rejects(
    h.orchestrator.execute(input('delegate')),
    (error: unknown) => error instanceof TurnOrchestratorError && error.code === 'PLAN_FAILED',
  );
  assert.deepEqual(h.calls.map(({ model }) => model), ['planner', 'planner']);
  assert.deepEqual(h.transitions.slice(-2).map(({ aggregate, state }) => `${aggregate}:${state}`), [
    'run:terminal', 'turn:terminal',
  ]);
});

test('an allowlist violation fails immediately instead of granting a retry', async () => {
  const h = harness([JSON.stringify({
    version: 1, workers: [{ workerId: 'escape', task: 'x' }], synthesisInstructions: 'x',
  })]);
  await assert.rejects(
    h.orchestrator.execute(input('delegate')),
    (error: unknown) => error instanceof TurnOrchestratorError && error.code === 'PLAN_FAILED',
  );
  assert.deepEqual(h.calls.map(({ model }) => model), ['planner']);
});

test('delegate_review independently reviews each worker and the synthesis with current hashes', async () => {
  const plan = JSON.stringify({
    version: 1,
    workers: [{ workerId: 'research', task: 'a' }, { workerId: 'analysis', task: 'b' }],
    synthesisInstructions: 'merge',
  });
  const review = (artifact: string) => JSON.stringify({
    verdict: 'pass', artifactHash: createHash('sha256').update(artifact).digest('hex'), feedback: '',
  });
  const h = harness([
    plan, 'worker one', review('worker one'), 'worker two', review('worker two'),
    'merged', review('merged'),
  ]);
  const result = await h.orchestrator.execute(input('delegate_review'));
  assert.equal(result.synthesisReview?.verdict, 'pass');
  assert.deepEqual(h.calls.map(({ model }) => model), [
    'planner', 'worker-a', 'reviewer', 'worker-b', 'reviewer', 'synthesis', 'reviewer',
  ]);
});

test('stale hash or changes_required closes the review gate and prevents synthesis', async () => {
  for (const verdict of [
    JSON.stringify({ verdict: 'pass', artifactHash: 'stale', feedback: '' }),
    JSON.stringify({
      verdict: 'changes_required',
      artifactHash: createHash('sha256').update('worker').digest('hex'), feedback: 'revise',
    }),
  ]) {
    const plan = JSON.stringify({
      version: 1, workers: [{ workerId: 'research', task: 'a' }], synthesisInstructions: 'merge',
    });
    const h = harness([plan, 'worker', verdict]);
    await assert.rejects(
      h.orchestrator.execute(input('delegate_review')),
      (error: unknown) => error instanceof TurnOrchestratorError && error.code === 'REVIEW_FAILED',
    );
    assert.equal(h.calls.some(({ model }) => model === 'synthesis'), false);
  }
});

test('resource denial and stale CAS prevent every external invocation', async () => {
  for (const options of [{ admit: false }, { casFailure: true }]) {
    const h = harness([], options);
    await assert.rejects(h.orchestrator.execute(input('direct')));
    assert.equal(h.calls.length, 0);
  }
});

test('a stale writer epoch blocks invocation and still releases admitted capacity', async () => {
  const h = harness([], { writerAccepted: false });
  await assert.rejects(
    h.orchestrator.execute(input('direct')),
    (error: unknown) => error instanceof TurnOrchestratorError && error.code === 'STALE_WRITER',
  );
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.releases, ['failed']);
});

test('cancellation observed after adapter settle wins before success terminalization', async () => {
  const controller = new AbortController();
  const h = harness(['settled'], { onInvoke: () => controller.abort('cancelled') });
  await assert.rejects(
    h.orchestrator.execute({ ...input('direct'), signal: controller.signal }),
    (error: unknown) => error instanceof TurnOrchestratorError && error.code === 'ABORTED',
  );
  assert.deepEqual(h.releases, ['cancelled']);
  assert.equal(h.transitions.at(-2)?.state, 'terminal');
});

test('reviewer must be independent from every producing role', () => {
  assert.throws(
    () => new TurnOrchestrator(harness([]).orchestrator.deps, {
      ...config, reviewer: config.workers[0],
    }),
    (error: unknown) => error instanceof TurnOrchestratorError && error.code === 'INVALID_CONFIG',
  );
});
