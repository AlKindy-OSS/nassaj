import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/* eslint-disable boundaries/dependencies -- deterministic lease fixture verifies the capability probe's cross-module admission contract. */
import { installFakeHarnessBinary } from '@/shared/__tests__/harness-binary-fixtures.js';

import {
  acquireHarnessLease, releaseHarnessLease,
} from '../providers/harness-update/lease.js';
/* eslint-enable boundaries/dependencies */

import {
  CLI_HARNESS_MATRIX, CliTurnSupervisorRuntime, isCliTurnSupervisorArmed, isCliTurnSupervisorEnabled,
} from './cli-turn-supervisor.service.js';
import { cliCapabilityInternals } from './cli-capability.js';
import { createCodexCliAdapter } from './adapters/codex-cli-adapter.js';

const inertAdapter = () => createCodexCliAdapter({
  governanceProbe: () => true,
  executableProbe: async () => true,
  spawnCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
});

describe('CLI Turn Supervisor capability gate', () => {
  it('routes the live runtime through the conformance gate, never a private orchestrator bypass', () => {
    const source = fs.readFileSync(new URL('./cli-turn-supervisor.service.ts', import.meta.url), 'utf8');
    assert.match(source, /await executeConformantTurn\(/u);
    assert.doesNotMatch(source, /new TurnOrchestrator\(/u);
  });
  it('is server-authoritative and exact to the three chat flags', () => {
    const env = {
      NASSAJ_TURN_SUPERVISOR_CODEX_CHAT: 'true', NASSAJ_TURN_SUPERVISOR_QWEN_CHAT: '1',
      NASSAJ_TURN_SUPERVISOR_OPENCODE_CHAT: 'yes', NASSAJ_TURN_SUPERVISOR_HERMES_CHAT: 'on',
    };
    for (const provider of ['codex', 'qwen', 'opencode']) {
      assert.equal(isCliTurnSupervisorEnabled(provider, 'chat', env, () => true), true, provider);
      assert.equal(isCliTurnSupervisorEnabled(provider, 'agent', env), false, provider);
      assert.equal(isCliTurnSupervisorEnabled(provider, 'chat', {}), false, provider);
    }
    assert.equal(isCliTurnSupervisorEnabled('cursor', 'chat', env), false);
    // T-1953: the hermes cell is deleted; its old flag arms nothing.
    assert.equal(isCliTurnSupervisorArmed('hermes', 'chat', env), false);
    assert.equal(isCliTurnSupervisorEnabled('hermes', 'chat', env, () => true), false);
  });

  it('the installed Qwen help probe denies the current binary', () => {
    assert.equal(cliCapabilityInternals.qwenProbe(process.env), false);
    const env = {
      ...process.env,
      NASSAJ_TURN_SUPERVISOR_QWEN_CHAT: '1',
    };
    assert.equal(isCliTurnSupervisorArmed('qwen', 'chat', env), true);
    assert.equal(isCliTurnSupervisorEnabled('qwen', 'chat', env), false);
    assert.equal(CLI_HARNESS_MATRIX.find(({ provider }) => provider === 'qwen')?.supported, false);
    assert.equal(CLI_HARNESS_MATRIX.some(({ provider }) => (provider as string) === 'hermes'), false);
  });

  it('refuses capability child creation during update without caching a denial', () => {
    // T-1873: the probe runs the registry qwen (operator HOME), never a member
    // QWEN_PATH; a stub that prints nothing keeps the probe hermetic (→ false).
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-capability-home-'));
    process.env.HOME = home;
    const stub = installFakeHarnessBinary(home, 'qwen');
    const env = { ...process.env, QWEN_PATH: '/definitely/not/a/qwen-binary' };
    const key = `qwen:${stub}`;
    cliCapabilityInternals.clearProbeCache();
    assert.ok('lease' in acquireHarnessLease('qwen', 'capability-test'));
    try {
      assert.throws(() => cliCapabilityInternals.qwenProbe(env), /being updated/u);
      assert.equal(cliCapabilityInternals.hasCachedProbe(key), false);
    } finally {
      releaseHarnessLease('qwen', 'capability-test');
    }
    assert.equal(isCliTurnSupervisorEnabled('qwen', 'chat', {
      ...env, NASSAJ_TURN_SUPERVISOR_QWEN_CHAT: '1',
    }), false);
    assert.equal(cliCapabilityInternals.hasCachedProbe(key), true);
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('requires an independent configured reviewer for delegate_review', () => {
    const base = { NASSAJ_TURN_SUPERVISOR_CODEX_CHAT: '1' };
    const withoutReviewer = new CliTurnSupervisorRuntime(base, inertAdapter());
    assert.equal(withoutReviewer.supports({
      provider: 'codex', mode: 'chat', coordinationLevel: 'delegate_review', model: 'root',
    }), false);
    const sameReviewer = new CliTurnSupervisorRuntime({
      ...base, NASSAJ_TURN_SUPERVISOR_CODEX_REVIEW_MODEL: 'root',
    }, inertAdapter());
    assert.equal(sameReviewer.supports({
      provider: 'codex', mode: 'chat', coordinationLevel: 'delegate_review', model: 'root',
    }), false);
    const independent = new CliTurnSupervisorRuntime({
      ...base, NASSAJ_TURN_SUPERVISOR_CODEX_REVIEW_MODEL: 'reviewer-model',
    }, inertAdapter());
    assert.equal(independent.supports({
      provider: 'codex', mode: 'chat', coordinationLevel: 'delegate_review', model: 'root',
    }), true);
    assert.equal(independent.supports({
      provider: 'codex', mode: 'chat', coordinationLevel: 'delegate', model: 'root',
    }), true);
  });

  describe('B-1550: spawn-only opencode models route to spawnOpenCode', () => {
    const cell = { NASSAJ_TURN_SUPERVISOR_OPENCODE_CHAT: '1' };
    const turn = (model?: string) => ({
      provider: 'opencode', mode: 'chat', coordinationLevel: 'direct' as const, model,
    });
    const VENDOR_MODELS = ['deepseek/deepseek-v4-pro', 'moonshot/kimi-k2.6'];

    it('flag on: deepseek/, moonshot/ and qwen-plan/ are neither supported nor a cell turn', () => {
      const runtime = new CliTurnSupervisorRuntime({ ...cell, NASSAJ_OPENCODE_SPAWN_VENDORS: '1' }, inertAdapter());
      for (const model of [...VENDOR_MODELS, 'qwen-plan/qwen3-coder-plus']) {
        assert.equal(runtime.supports(turn(model)), false, model);
        assert.equal(runtime.enabledCell({ provider: 'opencode', mode: 'chat', model }), false, model);
      }
      for (const model of [undefined, 'opencode/default', 'glm/glm-5']) {
        assert.equal(runtime.supports(turn(model)), true, String(model));
        assert.equal(runtime.enabledCell({ provider: 'opencode', mode: 'chat', model }), true);
      }
    });

    it('flag off: vendor models keep the cell; qwen-plan/ still routes away', () => {
      const runtime = new CliTurnSupervisorRuntime(cell, inertAdapter());
      for (const model of VENDOR_MODELS) {
        assert.equal(runtime.supports(turn(model)), true, model);
        assert.equal(runtime.enabledCell({ provider: 'opencode', mode: 'chat', model }), true);
      }
      assert.equal(runtime.supports(turn('qwen-plan/qwen3-coder-plus')), false);
    });

    it('a spawn-only reviewer model makes delegate_review unsupported', () => {
      const runtime = new CliTurnSupervisorRuntime({
        ...cell, NASSAJ_OPENCODE_SPAWN_VENDORS: '1',
        NASSAJ_TURN_SUPERVISOR_OPENCODE_REVIEW_MODEL: 'deepseek/deepseek-v4-flash',
      }, inertAdapter());
      assert.equal(runtime.supports({ ...turn('glm/glm-5'), coordinationLevel: 'delegate_review' }), false);
    });

    it('other providers are unaffected by the model rule', () => {
      const runtime = new CliTurnSupervisorRuntime({
        NASSAJ_TURN_SUPERVISOR_CODEX_CHAT: '1', NASSAJ_OPENCODE_SPAWN_VENDORS: '1',
      }, inertAdapter());
      assert.equal(runtime.enabledCell({ provider: 'codex', mode: 'chat', model: 'deepseek/x' }), true);
    });
  });
});
