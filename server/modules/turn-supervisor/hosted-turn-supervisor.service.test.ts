import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostedVendorAdapter } from './adapters/hosted-vendor-adapter.js';
import { createClaudeSdkTurnAdapter } from './adapters/claude-sdk-adapter.js';
import { HostedTurnSupervisorRuntime, isHostedTurnSupervisorEnabled } from './hosted-turn-supervisor.service.js';

test('hosted capability flags are server-owned and scoped by provider x mode', () => {
  const env = {
    NASSAJ_TURN_SUPERVISOR_KIMI_CHAT: 'true',
    NASSAJ_TURN_SUPERVISOR_DEEPSEEK_CHAT: '1',
    NASSAJ_TURN_SUPERVISOR_GLM_CHAT: 'off',
    NASSAJ_TURN_SUPERVISOR_KIMI_AGENT: 'true',
  };
  assert.equal(isHostedTurnSupervisorEnabled('kimi', 'chat', env), true);
  assert.equal(isHostedTurnSupervisorEnabled('deepseek', 'chat', env), true);
  assert.equal(isHostedTurnSupervisorEnabled('glm', 'chat', env), false);
  assert.equal(
    isHostedTurnSupervisorEnabled('kimi', 'agent', env),
    false,
    'external completion adapter must never impersonate a native agent mode',
  );
});

test('live preflight requires matrix cell, env arm, and server credential', async () => {
  const env = { NASSAJ_TURN_SUPERVISOR_KIMI_CHAT: 'true' };
  const allowed = new HostedTurnSupervisorRuntime(env, createHostedVendorAdapter({
    resolveCredential: (_provider, userId) => userId === 7 ? 'secret' : null,
    fetchImpl: async () => { throw new Error('preflight must not dispatch'); },
  }));
  assert.equal(await allowed.preflight({
    provider: 'kimi', mode: 'chat', coordinationLevel: 'delegate', userId: 7,
  }), true);
  assert.equal(await allowed.preflight({
    provider: 'kimi', mode: 'chat', coordinationLevel: 'delegate', userId: 8,
  }), false);
  assert.equal(await allowed.preflight({
    provider: 'kimi', mode: 'agent', coordinationLevel: 'delegate', userId: 7,
  }), false);
  assert.equal(await allowed.preflight({
    provider: 'deepseek', mode: 'chat', coordinationLevel: 'delegate', userId: 7,
  }), false);
});

test('armed direct is a conformant mechanical cell for every hosted provider', async () => {
  const runtime = new HostedTurnSupervisorRuntime({
    NASSAJ_TURN_SUPERVISOR_KIMI_CHAT: 'true',
    NASSAJ_TURN_SUPERVISOR_DEEPSEEK_CHAT: 'true',
    NASSAJ_TURN_SUPERVISOR_GLM_CHAT: 'true',
  }, createHostedVendorAdapter({
    resolveCredential: () => 'secret',
    fetchImpl: async () => { throw new Error('preflight must not dispatch'); },
  }));

  for (const provider of ['kimi', 'deepseek', 'glm'] as const) {
    assert.equal(runtime.supports({
      provider, mode: 'chat', coordinationLevel: 'direct',
    }), true, `${provider}/chat/direct must be advertised only as mechanical`);
    assert.equal(await runtime.preflight({
      provider, mode: 'chat', coordinationLevel: 'direct', userId: 7,
    }), true);
  }
});

test('Claude runtime arms direct/delegate/review only through its SDK capability cell', async () => {
  const hosted = createHostedVendorAdapter({
    resolveCredential: () => null,
    fetchImpl: async () => { throw new Error('hosted adapter must not run'); },
  });
  const claude = createClaudeSdkTurnAdapter({
    enabled: () => true,
    getAuthStatus: async (userId) => ({ installed: true, authenticated: userId === 7 }),
    resolveEnvironment: () => ({ PATH: process.env.PATH }),
    queryFactory: () => { throw new Error('preflight must not spawn Claude'); },
  });
  const armed = new HostedTurnSupervisorRuntime({
    NASSAJ_TURN_SUPERVISOR_CLAUDE_CHAT_SDK_MECHANICAL: '1',
  }, hosted, claude);
  for (const coordinationLevel of ['direct', 'delegate', 'delegate_review'] as const) {
    assert.equal(armed.supports({
      provider: 'claude', mode: 'chat', coordinationLevel, model: 'sonnet',
    }), true);
    assert.equal(await armed.preflight({
      provider: 'claude', mode: 'chat', coordinationLevel, model: 'sonnet', userId: 7,
    }), true);
  }
  assert.equal(await armed.preflight({
    provider: 'claude', mode: 'chat', coordinationLevel: 'direct', userId: 8,
  }), false);

  const off = new HostedTurnSupervisorRuntime({}, hosted, claude);
  assert.equal(off.enabled({ provider: 'claude', mode: 'chat' }), false);
  assert.equal(off.supports({
    provider: 'claude', mode: 'chat', coordinationLevel: 'delegate',
  }), false);
});
