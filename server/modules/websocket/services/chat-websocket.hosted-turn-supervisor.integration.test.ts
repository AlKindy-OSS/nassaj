import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

let ingressClaim: () => { action: string } = () => ({ action: 'dispatch' });

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: { getProjectPath: () => ({ project_id: 'test-project' }), isProjectVisibleToUser: () => true },
    sessionsDb: { getSessionById: () => null },
    sessionWorkspaceModesDb: { markOverlay: () => undefined },
    sessionOutcomesDb: {},
    messageCoordinationDb: {
      claim: () => ingressClaim(), bindSession: () => true,
      markStarted: () => undefined, recordVerdict: () => undefined,
    },
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { abortHostedSupervisedTurn, dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

function harness(options: { enabled: boolean; supported: boolean }) {
  const sent: Record<string, unknown>[] = [];
  const calls = {
    legacy: 0, enabled: 0, supports: 0, execute: 0,
    input: null as Record<string, unknown> | null,
  };
  const writer = {
    sessionId: null as string | null,
    send(payload: unknown) { sent.push(payload as Record<string, unknown>); },
    setSessionId(sessionId: string) { this.sessionId = sessionId; },
  };
  const spawn = async () => { calls.legacy += 1; };
  const dependencies = {
    queryClaudeSDK: spawn, queryCodex: spawn, spawnCursor: spawn,
    spawnAntigravity: spawn, spawnHermes: spawn, spawnOpenCode: spawn,
    spawnKimi: spawn, spawnDeepSeek: spawn, spawnGlm: spawn,
    getSessionProvider: () => null,
    hostedTurnSupervisor: {
      enabled() { calls.enabled += 1; return options.enabled; },
      supports() { calls.supports += 1; return options.supported; },
      async execute(input: Record<string, unknown>) {
        calls.execute += 1;
        calls.input = input;
        const provider = String(input.provider);
        (input.onSession as (id: string, isNew: boolean) => void)(`${provider}_supervised_1`, true);
        return {
          text: 'final synthesis only', model: 'kimi-k2.6',
          sessionId: `${provider}_supervised_1`, isNewSession: true,
        };
      },
      cancel() { return false; },
    },
  };
  return { sent, calls, writer, dependencies };
}

test('delegate hosted turn routes exclusively through supervisor and emits only outer result', async () => {
  const ctx = harness({ enabled: true, supported: true });
  await dispatchProviderCommand('kimi-command', {
    command: 'outer user request',
    options: {
      clientMsgId: 'cmid-hosted-1', coordinationLevel: 'delegate',
      model: 'kimi-k2.6', mode: 'chat',
    },
  } as never, ctx.writer as never, ctx.dependencies as never, 77);

  assert.equal(ctx.calls.legacy, 0);
  assert.equal(ctx.calls.execute, 1);
  assert.equal(ctx.calls.input?.prompt, 'outer user request');
  assert.equal(ctx.sent[0]?.code, undefined, JSON.stringify(ctx.sent));
  assert.deepEqual(ctx.sent.map((frame) => frame.kind), ['session_created', 'text', 'complete']);
  assert.equal(ctx.sent[1].content, 'final synthesis only');
  assert.ok(ctx.sent.every((frame) => !JSON.stringify(frame).includes('worker-')));
  assert.ok(ctx.sent.every((frame) => !JSON.stringify(frame).includes('planner')));
});

test('unsupported delegated hosted turn fails closed with no textual or legacy fallback', async () => {
  const ctx = harness({ enabled: true, supported: false });
  await dispatchProviderCommand('kimi-command', {
    command: 'request',
    options: { clientMsgId: 'cmid-hosted-2', coordinationLevel: 'delegate_review' },
  } as never, ctx.writer as never, ctx.dependencies as never, 77);

  assert.equal(ctx.calls.execute, 0);
  assert.equal(ctx.calls.legacy, 0);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].code, 'hosted_turn_supervisor_unsupported');
  assert.equal(ctx.sent[0].notStarted, true);
});

for (const provider of ['kimi', 'deepseek', 'glm'] as const) {
  test(`armed ${provider} direct turn routes through the mechanical supervisor`, async () => {
    const ctx = harness({ enabled: true, supported: true });
    await dispatchProviderCommand(`${provider}-command` as never, {
      command: 'direct request',
      options: {
        clientMsgId: `cmid-hosted-direct-${provider}`, coordinationLevel: 'direct',
      },
    } as never, ctx.writer as never, ctx.dependencies as never, 77);

    assert.equal(ctx.calls.enabled, 1);
    assert.equal(ctx.calls.supports, 1);
    assert.equal(ctx.calls.execute, 1);
    assert.equal(ctx.calls.legacy, 0);
    assert.equal(ctx.calls.input?.provider, provider);
    assert.equal(ctx.calls.input?.coordinationLevel, 'direct');
  });

  test(`flags OFF leaves ${provider} on its unchanged legacy policy path`, async () => {
    const ctx = harness({ enabled: false, supported: false });
    await dispatchProviderCommand(`${provider}-command` as never, {
      command: 'legacy request',
      options: {
        clientMsgId: `cmid-hosted-off-${provider}`, coordinationLevel: 'delegate',
      },
    } as never, ctx.writer as never, ctx.dependencies as never, 77);

    assert.equal(ctx.calls.enabled, 1);
    assert.equal(ctx.calls.supports, 0);
    assert.equal(ctx.calls.execute, 0);
    if (provider === 'kimi') {
      assert.equal(ctx.calls.legacy, 1);
    } else {
      assert.equal(ctx.calls.legacy, 0);
      assert.match(String(ctx.sent[0]?.error), /disabled on this deployment/);
    }
    assert.notEqual(ctx.sent[0]?.code, 'hosted_turn_supervisor_unsupported');
  });
}

test('hosted supervisor flag OFF in agent mode is inert and preserves legacy dispatch', async () => {
  const ctx = harness({ enabled: false, supported: false });
  await dispatchProviderCommand('kimi-command', {
    command: 'agent request',
    options: {
      clientMsgId: 'cmid-hosted-4', coordinationLevel: 'delegate', mode: 'agent',
    },
  } as never, ctx.writer as never, ctx.dependencies as never, 77);

  assert.equal(ctx.calls.execute, 0);
  assert.equal(ctx.calls.supports, 0);
  assert.equal(ctx.calls.legacy, 1);
  assert.notEqual(ctx.sent[0]?.code, 'hosted_turn_supervisor_unsupported');
});

test('abort bridge forwards authenticated ownership and falls back only on false', () => {
  const seen: unknown[] = [];
  const supervisor = {
    enabled: () => true,
    supports: () => true,
    execute: async () => { throw new Error('unused'); },
    cancel(input: unknown) { seen.push(input); return true; },
  };
  assert.equal(abortHostedSupervisedTurn(supervisor as never, 'kimi', 's-1', 77), true);
  assert.deepEqual(seen, [{ provider: 'kimi', sessionId: 's-1', userId: 77 }]);
  assert.equal(abortHostedSupervisedTurn(supervisor as never, 'claude', 's-1', 77), true);
  assert.deepEqual(seen[1], { provider: 'claude', sessionId: 's-1', userId: 77 });
  assert.equal(abortHostedSupervisedTurn(supervisor as never, 'kimi', '', 77), false);
});

test('ambiguous hosted ingress reaches durable supervisor replay instead of dying at WS gate', async () => {
  ingressClaim = () => ({ action: 'ambiguous_started' });
  try {
    const ctx = harness({ enabled: true, supported: true });
    await dispatchProviderCommand('kimi-command', {
      command: 'replay me',
      options: {
        clientMsgId: 'cmid-hosted-replay', coordinationLevel: 'delegate', mode: 'chat',
      },
    } as never, ctx.writer as never, ctx.dependencies as never, 77);
    assert.equal(ctx.calls.execute, 1);
    assert.equal(ctx.calls.legacy, 0);
    assert.equal(ctx.sent[0]?.code, undefined, JSON.stringify(ctx.sent));
    assert.deepEqual(ctx.sent.map((frame) => frame.kind), ['session_created', 'text', 'complete']);
  } finally {
    ingressClaim = () => ({ action: 'dispatch' });
  }
});
