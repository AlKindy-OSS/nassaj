import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeConformantTurn,
  getServerHarnessConformance,
  HOSTED_HARNESS_CONFORMANCE,
  ServerAuthoritativeResultGate,
  type HarnessCoordinates,
} from './conformance.js';
import type { AdmissionVerdict } from './resource-admission.js';
import type { OrchestratorConfig, OrchestratorInput } from './orchestrator.js';
import type { RunRecord, TurnRecord } from './types.js';
import { createHostedVendorAdapter } from './adapters/hosted-vendor-adapter.js';
import { createExtendedCliAdapter, extendedCliAdapterInternals, type ExtendedCliProvider } from './adapters/extended-cli-adapter.js';
import type { EphemeralRoleHome } from './adapters/isolated-cli-cage.js';
import { TurnAdapterRegistry } from './adapters/registry.js';

const createdAt = '2026-08-19T00:00:00.000Z';

function turnInput(
  coordinationLevel: OrchestratorInput['coordinationLevel'],
  signal?: AbortSignal,
): OrchestratorInput {
  return {
    coordinationLevel,
    prompt: 'answer the request',
    userId: 7,
    writerEpoch: 1,
    signal,
    turn: {
      turnId: 'turn-7', userId: 7, clientMsgId: 'client-7', requestFingerprint: 'fp',
      sessionId: 'session-7', state: 'accepted', epoch: 0, terminalOutcome: null,
      createdAt, updatedAt: createdAt,
    },
    run: {
      runId: 'run-7', turnId: 'turn-7', attempt: 1, state: 'claimed', epoch: 0,
      terminalOutcome: null, createdAt, updatedAt: createdAt,
    },
  };
}

function config(provider: 'kimi' | 'deepseek' | 'glm'): OrchestratorConfig {
  return {
    root: { provider, model: `${provider}-root` },
    planner: { provider, model: `${provider}-planner` },
    synthesis: { provider, model: `${provider}-synthesis` },
    reviewer: { provider, model: `${provider}-independent-reviewer` },
    workers: [{ id: 'worker-1', provider, model: `${provider}-worker` }],
  };
}

function coordinates(provider: string): HarnessCoordinates {
  return { provider, mode: 'chat', runtime: 'hosted_vendor_ephemeral' };
}

function testRepository() {
  return {
    startExecution(input: {
      turnId: string; runId: string; expectedTurnEpoch: number; expectedRunEpoch: number;
    }): { turn: TurnRecord; run: RunRecord } {
      return {
        run: { ...turnInput('direct').run, state: 'running', epoch: input.expectedRunEpoch + 1 },
        turn: { ...turnInput('direct').turn, state: 'running', epoch: input.expectedTurnEpoch + 1 },
      };
    },
    finishExecution(input: {
      turnId: string; runId: string; expectedTurnEpoch: number; expectedRunEpoch: number;
      terminalOutcome: NonNullable<RunRecord['terminalOutcome']>;
    }): { turn: TurnRecord; run: RunRecord } {
      return {
        run: {
          ...turnInput('direct').run, state: 'terminal', epoch: input.expectedRunEpoch + 1,
          terminalOutcome: input.terminalOutcome,
        },
        turn: {
          ...turnInput('direct').turn, state: 'terminal', epoch: input.expectedTurnEpoch + 1,
          terminalOutcome: input.terminalOutcome,
        },
      };
    },
  };
}

function admitted(): AdmissionVerdict {
  return {
    admitted: true,
    idempotent: false,
    lease: {
      leaseId: 'lease-7', turnId: 'turn-7', userId: 7, ownerId: 'supervisor', ownerPid: 70,
      cpuReserved: 1, memoryReserved: 1, heartbeatAtMs: 1,
    },
  };
}

type WireCall = { readonly model: string; readonly body: Record<string, unknown> };

function hostedHarness(options: {
  readonly malformedPlanner?: boolean;
  readonly admission?: AdmissionVerdict;
  readonly holdFetch?: boolean;
} = {}) {
  const calls: WireCall[] = [];
  const adapter = createHostedVendorAdapter({
    resolveCredential: () => 'server-secret',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ content: string }>;
      };
      calls.push({ model: body.model, body });
      if (options.holdFetch) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        });
      }
      let text = 'root answer';
      if (body.model.endsWith('-planner')) {
        text = options.malformedPlanner
          ? 'not-json'
          : JSON.stringify({
            version: 1,
            workers: [{ workerId: 'worker-1', task: 'supervised task' }],
            synthesisInstructions: 'merge evidence',
          });
      } else if (body.model.endsWith('-worker')) {
        text = 'worker artifact';
      } else if (body.model.endsWith('-synthesis')) {
        text = 'synthesized artifact';
      } else if (body.model.endsWith('-independent-reviewer')) {
        const hash = body.messages[0].content.match(/CURRENT ARTIFACT SHA256: ([a-f0-9]{64})/)?.[1];
        text = JSON.stringify({ verdict: 'pass', artifactHash: hash, feedback: '' });
      }
      return Response.json({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
    },
  });
  let admissions = 0;
  return {
    calls,
    admissions: () => admissions,
    dependencies: {
      registry: new TurnAdapterRegistry([adapter]),
      repository: testRepository(),
      admitRun: async () => {
        admissions += 1;
        return options.admission ?? admitted();
      },
      releaseRun: async () => {},
      writerFence: { accepts: () => true },
    },
  };
}

const fakeRole: EphemeralRoleHome = Object.freeze({
  id: 'conformance-role', directory: '/var/tmp/nassaj-turn-supervisor-roles/conformance-role',
  home: '/var/tmp/nassaj-turn-supervisor-roles/conformance-role/home',
  xdgConfig: '/var/tmp/nassaj-turn-supervisor-roles/conformance-role/config',
  xdgData: '/var/tmp/nassaj-turn-supervisor-roles/conformance-role/data',
  xdgState: '/var/tmp/nassaj-turn-supervisor-roles/conformance-role/state',
  xdgCache: '/var/tmp/nassaj-turn-supervisor-roles/conformance-role/cache',
  hermesHome: '/var/tmp/nassaj-turn-supervisor-roles/conformance-role/hermes', manifestPath: '/manifest',
});

function extendedCliHarness(provider: ExtendedCliProvider) {
  const calls: string[] = [];
  const adapter = createExtendedCliAdapter(provider, {
    executableProbe: async () => true,
    versionProbe: async () => extendedCliAdapterInternals.EXACT_VERSIONS[provider],
    qwenCapabilityProbe: async () => true,
    hermesToolDefinitionProbe: async () => 0,
    resolveEnv: () => ({}), createRoleHome: async () => fakeRole, cleanupRoleHome: async () => {},
    spawnCapture: async ({ args }) => {
      const model = args[args.indexOf('--model') + 1] ?? '';
      const prompt = provider === 'qwen' ? args[args.indexOf('--prompt') + 1]
        : provider === 'hermes' ? args[args.indexOf('--oneshot') + 1] : args.at(-1) ?? '';
      calls.push(model);
      let text = 'root answer';
      if (model.endsWith('-planner')) text = JSON.stringify({
        version: 1, workers: [{ workerId: 'worker-1', task: 'bounded work' }],
        synthesisInstructions: 'merge',
      });
      else if (model.endsWith('-worker')) text = 'worker artifact';
      else if (model.endsWith('-synthesis')) text = 'synthesized artifact';
      else if (model.endsWith('-reviewer')) {
        const artifactHash = prompt.match(/CURRENT ARTIFACT SHA256: ([a-f0-9]{64})/u)?.[1];
        text = JSON.stringify({ verdict: 'pass', artifactHash, feedback: '' });
      }
      const stdout = provider === 'qwen'
        ? `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: text } })}\n`
        : provider === 'opencode'
          ? `${JSON.stringify({ type: 'text', part: { type: 'text', text } })}\n` : `${text}\n`;
      return { code: 0, stdout, stderr: '' };
    },
  });
  return {
    calls,
    dependencies: {
      registry: new TurnAdapterRegistry([adapter]), repository: testRepository(),
      admitRun: async () => admitted(), releaseRun: async () => {},
      writerFence: { accepts: () => true },
    },
  };
}

test('server matrix initially enables only hosted Kimi, DeepSeek, and GLM chat harnesses', () => {
  assert.deepEqual(HOSTED_HARNESS_CONFORMANCE.map(({ provider, mode, runtime }) => (
    `${provider}:${mode}:${runtime}`
  )), [
    'kimi:chat:hosted_vendor_ephemeral',
    'deepseek:chat:hosted_vendor_ephemeral',
    'glm:chat:hosted_vendor_ephemeral',
  ]);
  assert.ok(HOSTED_HARNESS_CONFORMANCE.every((entry) => (
    entry.enforcement === 'mechanical'
    && entry.execution === 'capture_only'
    && entry.spawnAuthority === 'supervisor_only'
  )));
});

test('Codex mechanical cell appears only behind its exact server flag', () => {
  const coordinates = (env: NodeJS.ProcessEnv) => getServerHarnessConformance(env)
    .map(({ provider, mode, runtime }) => `${provider}:${mode}:${runtime}`);
  assert.equal(coordinates({}).includes('codex:chat:codex_cli_ephemeral'), false);
  assert.equal(coordinates({ NASSAJ_TURN_SUPERVISOR_CODEX_CHAT: '1' })
    .includes('codex:chat:codex_cli_ephemeral'), true);
  assert.equal(coordinates({ NASSAJ_TURN_SUPERVISOR_CODEX_AGENT: '1' })
    .includes('codex:chat:codex_cli_ephemeral'), false);
  const withoutReview = getServerHarnessConformance({ NASSAJ_TURN_SUPERVISOR_CODEX_CHAT: '1' })
    .find(({ provider }) => provider === 'codex');
  assert.deepEqual(withoutReview?.supportedLevels, ['direct', 'delegate']);
  const withReview = getServerHarnessConformance({
    NASSAJ_TURN_SUPERVISOR_CODEX_CHAT: '1',
    NASSAJ_TURN_SUPERVISOR_CODEX_REVIEW_MODEL: 'gpt-5.3-codex-high',
  }).find(({ provider }) => provider === 'codex');
  assert.deepEqual(withReview?.supportedLevels, ['direct', 'delegate', 'delegate_review']);
});

test('Qwen, OpenCode, and Hermes mechanical cells are server-authoritative and default OFF', () => {
  const proved = () => true;
  const listed = (env: NodeJS.ProcessEnv) => new Set(getServerHarnessConformance(env, proved)
    .map(({ provider, runtime }) => `${provider}:${runtime}`));
  const off = listed({});
  assert.equal(off.has('qwen:qwen_cli_ephemeral'), false);
  assert.equal(off.has('opencode:opencode_cli_ephemeral'), false);
  assert.equal(off.has('hermes:hermes_cli_ephemeral'), false);
  const on = listed({
    NASSAJ_TURN_SUPERVISOR_QWEN_CHAT: '1',
    NASSAJ_TURN_SUPERVISOR_OPENCODE_CHAT: 'true',
    NASSAJ_TURN_SUPERVISOR_HERMES_CHAT: 'on',
  });
  assert.equal(on.has('qwen:qwen_cli_ephemeral'), true);
  assert.equal(on.has('opencode:opencode_cli_ephemeral'), true);
  assert.equal(on.has('hermes:hermes_cli_ephemeral'), true);
  assert.equal(listed({ NASSAJ_TURN_SUPERVISOR_QWEN_AGENT: '1' }).has('qwen:qwen_cli_ephemeral'), false);
});

test('Qwen and Hermes are absent from the mechanical matrix when installed-binary proof fails', () => {
  const env = {
    NASSAJ_TURN_SUPERVISOR_QWEN_CHAT: '1', NASSAJ_TURN_SUPERVISOR_HERMES_CHAT: '1',
  };
  const cells = getServerHarnessConformance(env, (provider) => provider !== 'qwen' && provider !== 'hermes');
  assert.equal(cells.some(({ provider }) => provider === 'qwen'), false);
  assert.equal(cells.some(({ provider }) => provider === 'hermes'), false);
});

for (const provider of ['qwen', 'opencode', 'hermes'] as const) {
  test(`${provider} CLI conformance crosses executeConformantTurn for all three levels`, async () => {
    const flag = `NASSAJ_TURN_SUPERVISOR_${provider.toUpperCase()}_CHAT`;
    for (const level of ['direct', 'delegate', 'delegate_review'] as const) {
      const harness = extendedCliHarness(provider);
      const providerConfig: OrchestratorConfig = {
        root: { provider, model: `${provider}-root` },
        planner: { provider, model: `${provider}-planner` },
        synthesis: { provider, model: `${provider}-synthesis` },
        reviewer: { provider, model: `${provider}-reviewer` },
        workers: [{ id: 'worker-1', provider, model: `${provider}-worker` }],
      };
      const result = await executeConformantTurn({
        coordinates: { provider, mode: 'chat', runtime: `${provider}_cli_ephemeral` },
        turn: turnInput(level), config: providerConfig, dependencies: harness.dependencies,
        env: { [flag]: '1' },
        cliProbe: () => true,
      });
      assert.equal(result.status, 'succeeded', `${provider}/${level}/${result.reason ?? ''}`);
      assert.equal(result.fallbackUsed, false);
      assert.equal(result.childCount, level === 'direct' ? 0 : 1);
      if (level === 'delegate_review') {
        assert.equal(result.workers[0].review?.artifactHash, result.workers[0].artifactHash);
        assert.equal(result.synthesis?.review?.artifactHash, result.synthesis?.artifactHash);
      }
    }
  });
}

for (const provider of ['kimi', 'deepseek', 'glm'] as const) {
  test(`${provider} hosted conformance: direct has zero children and denies root spawn/effects`, async () => {
    const harness = hostedHarness();
    const result = await executeConformantTurn({
      coordinates: coordinates(provider), turn: turnInput('direct'), config: config(provider),
      dependencies: harness.dependencies,
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.childCount, 0);
    assert.deepEqual(result.root, { effects: 'denied', spawn: 'denied' });
    assert.deepEqual(harness.calls.map(({ model }) => model), [`${provider}-root`]);
    assert.equal(harness.admissions(), 1);
    assert.equal(result.fallbackUsed, false);
  });

  test(`${provider} hosted conformance: delegate launches a supervised worker then synthesis`, async () => {
    const harness = hostedHarness();
    const result = await executeConformantTurn({
      coordinates: coordinates(provider), turn: turnInput('delegate'), config: config(provider),
      dependencies: harness.dependencies,
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.childCount, 1);
    assert.equal(result.root.effects, 'denied');
    assert.deepEqual(harness.calls.map(({ model }) => model), [
      `${provider}-planner`, `${provider}-worker`, `${provider}-synthesis`,
    ]);
    assert.equal(result.workers[0].workerId, 'worker-1');
    assert.equal(result.fallbackUsed, false);
  });

  test(`${provider} hosted conformance: review is independent and hash-bound`, async () => {
    const harness = hostedHarness();
    const providerConfig = config(provider);
    const result = await executeConformantTurn({
      coordinates: coordinates(provider), turn: turnInput('delegate_review'), config: providerConfig,
      dependencies: harness.dependencies,
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.workers[0].review?.verdict, 'pass');
    assert.equal(result.workers[0].review?.artifactHash, result.workers[0].artifactHash);
    assert.deepEqual(result.workers[0].review?.reviewer, providerConfig.reviewer);
    assert.notEqual(result.workers[0].review?.reviewer.model, providerConfig.workers[0].model);
    assert.equal(result.synthesis?.review?.artifactHash, result.synthesis?.artifactHash);
    assert.equal(harness.calls.filter(({ model }) => model.endsWith('-independent-reviewer')).length, 2);
  });
}

test('malformed plan retries once and returns server failure without root fallback', async () => {
  const harness = hostedHarness({ malformedPlanner: true });
  const result = await executeConformantTurn({
    coordinates: coordinates('kimi'), turn: turnInput('delegate'), config: config('kimi'),
    dependencies: harness.dependencies,
  });
  assert.deepEqual({ status: result.status, reason: result.reason, fallback: result.fallbackUsed }, {
    status: 'failed', reason: 'plan_failed', fallback: false,
  });
  assert.deepEqual(harness.calls.map(({ model }) => model), ['kimi-planner', 'kimi-planner']);
});

test('unsupported harness and resource denial never call any provider or fallback', async () => {
  const unsupported = hostedHarness();
  const unsupportedResult = await executeConformantTurn({
    coordinates: { provider: 'claude', mode: 'agent', runtime: 'native_cli' },
    turn: turnInput('delegate'), config: config('kimi'), dependencies: unsupported.dependencies,
  });
  assert.equal(unsupportedResult.reason, 'unsupported_harness');
  assert.equal(unsupportedResult.fallbackUsed, false);
  assert.equal(unsupported.calls.length, 0);
  assert.equal(unsupported.admissions(), 0);

  const denied = hostedHarness({ admission: { admitted: false, code: 'capacity', reason: 'full' } });
  const deniedResult = await executeConformantTurn({
    coordinates: coordinates('glm'), turn: turnInput('direct'), config: config('glm'),
    dependencies: denied.dependencies,
  });
  assert.equal(deniedResult.reason, 'resource_denied');
  assert.equal(deniedResult.fallbackUsed, false);
  assert.equal(denied.calls.length, 0);
});

test('cancel returns an authoritative cancelled result without fallback', async () => {
  const harness = hostedHarness({ holdFetch: true });
  const controller = new AbortController();
  const pending = executeConformantTurn({
    coordinates: coordinates('deepseek'), turn: turnInput('direct', controller.signal),
    config: config('deepseek'), dependencies: harness.dependencies,
  });
  while (harness.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  controller.abort('cancelled by user');
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'aborted');
  assert.equal(result.fallbackUsed, false);
  assert.equal(harness.calls.length, 1);
});

test('server result gate rejects stale epochs and every late event after terminal acceptance', async () => {
  const harness = hostedHarness();
  const result = await executeConformantTurn({
    coordinates: coordinates('kimi'), turn: turnInput('direct'), config: config('kimi'),
    dependencies: harness.dependencies,
  });
  const gate = new ServerAuthoritativeResultGate('run-7', 4);
  assert.equal(gate.accept({ runId: 'run-7', writerEpoch: 3, result }), false);
  assert.equal(gate.accept({ runId: 'run-7', writerEpoch: 4, result }), true);
  assert.equal(gate.accept({ runId: 'run-7', writerEpoch: 4, result }), false);
  assert.equal(gate.accept({ runId: 'other', writerEpoch: 4, result }), false);
  assert.equal(gate.snapshot(), result);
  assert.equal(result.fallbackUsed, false);
});
