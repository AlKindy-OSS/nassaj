import assert from 'node:assert/strict';
import test from 'node:test';

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeSdkTurnAdapter } from './adapters/claude-sdk-adapter.js';
import { TurnAdapterRegistry } from './adapters/registry.js';
import { executeConformantTurn, getServerHarnessConformance } from './conformance.js';
import type { OrchestratorConfig, OrchestratorInput } from './orchestrator.js';
import type { AdmissionVerdict } from './resource-admission.js';
import type { RunRecord, TurnRecord } from './types.js';

const createdAt = '2026-08-19T00:00:00.000Z';
const enabledEnv = { NASSAJ_TURN_SUPERVISOR_CLAUDE_CHAT_SDK_MECHANICAL: '1' };

function input(level: OrchestratorInput['coordinationLevel']): OrchestratorInput {
  return {
    coordinationLevel: level, prompt: 'answer the request', userId: 19, writerEpoch: 4,
    turn: {
      turnId: 'turn-claude', userId: 19, clientMsgId: 'client-claude', requestFingerprint: 'fp',
      sessionId: 'session-claude', state: 'accepted', epoch: 0, terminalOutcome: null,
      createdAt, updatedAt: createdAt,
    },
    run: {
      runId: 'run-claude', turnId: 'turn-claude', attempt: 1, state: 'claimed', epoch: 0,
      terminalOutcome: null, createdAt, updatedAt: createdAt,
    },
  };
}

const config: OrchestratorConfig = {
  root: { provider: 'claude', model: 'claude-root' },
  planner: { provider: 'claude', model: 'claude-planner' },
  synthesis: { provider: 'claude', model: 'claude-synthesis' },
  reviewer: { provider: 'claude', model: 'claude-independent-reviewer' },
  workers: [{ id: 'worker-1', provider: 'claude', model: 'claude-worker' }],
};

function repository() {
  return {
    startExecution(args: {
      turnId: string; runId: string; expectedTurnEpoch: number; expectedRunEpoch: number;
    }): { turn: TurnRecord; run: RunRecord } {
      return {
        turn: { ...input('direct').turn, state: 'running', epoch: args.expectedTurnEpoch + 1 },
        run: { ...input('direct').run, state: 'running', epoch: args.expectedRunEpoch + 1 },
      };
    },
    finishExecution(args: {
      turnId: string; runId: string; expectedTurnEpoch: number; expectedRunEpoch: number;
      terminalOutcome: NonNullable<RunRecord['terminalOutcome']>;
    }): { turn: TurnRecord; run: RunRecord } {
      return {
        turn: {
          ...input('direct').turn, state: 'terminal', epoch: args.expectedTurnEpoch + 1,
          terminalOutcome: args.terminalOutcome,
        },
        run: {
          ...input('direct').run, state: 'terminal', epoch: args.expectedRunEpoch + 1,
          terminalOutcome: args.terminalOutcome,
        },
      };
    },
  };
}

function admission(): AdmissionVerdict {
  return {
    admitted: true, idempotent: false,
    lease: {
      leaseId: 'lease-claude', turnId: 'turn-claude', userId: 19,
      ownerId: 'supervisor', ownerPid: 91, cpuReserved: 1, memoryReserved: 1, heartbeatAtMs: 1,
    },
  };
}

function terminal(text: string): SDKMessage {
  return {
    type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
  } as unknown as SDKMessage;
}

function harness() {
  const calls: Array<{ model: string; prompt: string; options: Options }> = [];
  const adapter = createClaudeSdkTurnAdapter({
    enabled: () => true,
    getAuthStatus: async () => ({ installed: true, authenticated: true }),
    resolveEnvironment: () => ({ PATH: process.env.PATH }),
    queryFactory: ({ prompt, options }) => {
      calls.push({ model: String(options.model), prompt, options });
      let text = 'root artifact';
      if (options.model === 'claude-planner') {
        text = JSON.stringify({
          version: 1,
          workers: [{ workerId: 'worker-1', task: 'bounded supervised task' }],
          synthesisInstructions: 'merge the worker evidence',
        });
      } else if (options.model === 'claude-worker') {
        text = 'worker artifact';
      } else if (options.model === 'claude-synthesis') {
        text = 'synthesis artifact';
      } else if (options.model === 'claude-independent-reviewer') {
        const artifactHash = prompt.match(/CURRENT ARTIFACT SHA256: ([a-f0-9]{64})/)?.[1];
        text = JSON.stringify({ verdict: 'pass', artifactHash, feedback: '' });
      }
      return (async function* stream() { yield terminal(text); })();
    },
  });
  let admissions = 0;
  let releases = 0;
  return {
    calls,
    counts: () => ({ admissions, releases }),
    dependencies: {
      registry: new TurnAdapterRegistry([adapter]), repository: repository(),
      admitRun: async () => { admissions += 1; return admission(); },
      releaseRun: async () => { releases += 1; },
      writerFence: { accepts: () => true },
    },
  };
}

test('Claude conformance cell is absent by default and appears only behind its server flag', () => {
  assert.equal(getServerHarnessConformance({}).some(({ provider }) => provider === 'claude'), false);
  assert.equal(getServerHarnessConformance(enabledEnv).some((cell) => (
    cell.provider === 'claude'
    && cell.mode === 'chat'
    && cell.runtime === 'claude_agent_sdk_ephemeral'
    && cell.enforcement === 'mechanical'
  )), true);
});

for (const level of ['direct', 'delegate', 'delegate_review'] as const) {
  test(`Claude SDK mechanical ${level} conformance`, async () => {
    const run = harness();
    const result = await executeConformantTurn({
      coordinates: { provider: 'claude', mode: 'chat', runtime: 'claude_agent_sdk_ephemeral' },
      turn: input(level), config, dependencies: run.dependencies, env: enabledEnv,
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.root.effects, 'denied');
    assert.equal(result.root.spawn, level === 'direct' ? 'denied' : 'supervisor_only');
    assert.equal(result.childCount, level === 'direct' ? 0 : 1);
    assert.deepEqual(run.counts(), { admissions: 1, releases: 1 });
    assert.ok(run.calls.every(({ options }) => (
      options.persistSession === false
      && Array.isArray(options.tools) && options.tools.length === 0
      && options.disallowedTools?.includes('Agent')
      && options.disallowedTools?.includes('Task')
    )));
    if (level === 'direct') {
      assert.deepEqual(run.calls.map(({ model }) => model), ['claude-root']);
    } else if (level === 'delegate') {
      assert.deepEqual(run.calls.map(({ model }) => model), [
        'claude-planner', 'claude-worker', 'claude-synthesis',
      ]);
    } else {
      assert.deepEqual(run.calls.map(({ model }) => model), [
        'claude-planner', 'claude-worker', 'claude-independent-reviewer',
        'claude-synthesis', 'claude-independent-reviewer',
      ]);
      assert.equal(result.workers[0].review?.artifactHash, result.workers[0].artifactHash);
      assert.equal(result.synthesis?.review?.artifactHash, result.synthesis?.artifactHash);
    }
  });
}

test('Claude conformance refuses the cell with no provider call when its flag is off', async () => {
  const run = harness();
  const result = await executeConformantTurn({
    coordinates: { provider: 'claude', mode: 'chat', runtime: 'claude_agent_sdk_ephemeral' },
    turn: input('delegate'), config, dependencies: run.dependencies, env: {},
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'unsupported_harness');
  assert.equal(result.enforcement, 'none');
  assert.equal(result.fallbackUsed, false);
  assert.equal(run.calls.length, 0);
  assert.deepEqual(run.counts(), { admissions: 0, releases: 0 });
});
