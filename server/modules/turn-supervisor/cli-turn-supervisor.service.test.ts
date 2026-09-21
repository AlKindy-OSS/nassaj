import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

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
  it('is server-authoritative and exact to the four chat flags', () => {
    const env = {
      NASSAJ_TURN_SUPERVISOR_CODEX_CHAT: 'true', NASSAJ_TURN_SUPERVISOR_QWEN_CHAT: '1',
      NASSAJ_TURN_SUPERVISOR_OPENCODE_CHAT: 'yes', NASSAJ_TURN_SUPERVISOR_HERMES_CHAT: 'on',
    };
    for (const provider of ['codex', 'qwen', 'opencode', 'hermes']) {
      assert.equal(isCliTurnSupervisorEnabled(provider, 'chat', env, () => true), true, provider);
      assert.equal(isCliTurnSupervisorEnabled(provider, 'agent', env), false, provider);
      assert.equal(isCliTurnSupervisorEnabled(provider, 'chat', {}), false, provider);
    }
    assert.equal(isCliTurnSupervisorEnabled('cursor', 'chat', env), false);
  });

  it('installed Qwen help and Hermes zero-tool probes deny the current binaries', () => {
    assert.equal(cliCapabilityInternals.qwenProbe(process.env), false);
    assert.equal(cliCapabilityInternals.hermesProbe(process.env), false);
    const env = {
      ...process.env,
      NASSAJ_TURN_SUPERVISOR_QWEN_CHAT: '1', NASSAJ_TURN_SUPERVISOR_HERMES_CHAT: '1',
    };
    assert.equal(isCliTurnSupervisorArmed('qwen', 'chat', env), true);
    assert.equal(isCliTurnSupervisorEnabled('qwen', 'chat', env), false);
    assert.equal(isCliTurnSupervisorArmed('hermes', 'chat', env), true);
    assert.equal(isCliTurnSupervisorEnabled('hermes', 'chat', env), false);
    assert.equal(CLI_HARNESS_MATRIX.find(({ provider }) => provider === 'qwen')?.supported, false);
    assert.equal(CLI_HARNESS_MATRIX.find(({ provider }) => provider === 'hermes')?.supported, false);
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
});
