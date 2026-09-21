import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

let ingressClaim: () => { action: string } = () => ({ action: 'dispatch' });

mock.module('@/modules/database/index.js', {
  namedExports: {
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

function harness(options: { enabled: boolean; supported?: boolean }) {
  const sent: Record<string, unknown>[] = [];
  const calls = {
    legacy: 0, enabled: 0, supports: 0, execute: 0,
    levels: [] as string[], cancel: [] as unknown[],
  };
  const writer = {
    sessionId: null as string | null,
    send(payload: unknown) { sent.push(payload as Record<string, unknown>); },
    setSessionId(sessionId: string) { this.sessionId = sessionId; },
  };
  const legacy = async () => { calls.legacy += 1; };
  const dependencies = {
    queryClaudeSDK: legacy, queryCodex: legacy, spawnCursor: legacy, spawnGemini: legacy,
    spawnAntigravity: legacy, spawnHermes: legacy, spawnOpenCode: legacy,
    spawnKimi: legacy, spawnDeepSeek: legacy, spawnGlm: legacy,
    getSessionProvider: () => null,
    hostedTurnSupervisor: {
      enabled() { calls.enabled += 1; return options.enabled; },
      supports(input: { coordinationLevel: string }) {
        calls.supports += 1;
        calls.levels.push(input.coordinationLevel);
        return options.supported ?? true;
      },
      async execute(input: Record<string, unknown>) {
        calls.execute += 1;
        (input.onSession as (id: string, isNew: boolean) => void)('claude_supervised_1', true);
        return {
          text: 'outer claude answer', model: 'sonnet',
          sessionId: 'claude_supervised_1', isNewSession: true,
        };
      },
      cancel(input: unknown) { calls.cancel.push(input); return true; },
    },
  };
  return { sent, calls, writer, dependencies };
}

async function dispatch(
  level: 'direct' | 'delegate' | 'delegate_review',
  ctx: ReturnType<typeof harness>,
  clientMsgId = `cmid-claude-${level}`,
): Promise<void> {
  await dispatchProviderCommand('claude-command', {
    command: 'outer user request',
    options: { clientMsgId, coordinationLevel: level, model: 'sonnet' },
  } as never, ctx.writer as never, ctx.dependencies as never, 77);
}

for (const level of ['direct', 'delegate', 'delegate_review'] as const) {
  test(`armed Claude ${level} routes exclusively through mechanical supervisor`, async () => {
    const ctx = harness({ enabled: true });
    await dispatch(level, ctx);
    assert.equal(ctx.calls.legacy, 0);
    assert.equal(ctx.calls.execute, 1);
    assert.deepEqual(ctx.calls.levels, [level]);
    assert.deepEqual(ctx.sent.map(({ kind }) => kind), ['session_created', 'text', 'complete']);
    assert.equal(ctx.sent[1].content, 'outer claude answer');
    const wire = JSON.stringify(ctx.sent);
    assert.doesNotMatch(wire, /planner|worker|reviewer|private supervisor/i);
  });
}

test('Claude supervisor flag OFF is inert and preserves legacy dispatch', async () => {
  for (const level of ['direct', 'delegate', 'delegate_review'] as const) {
    const ctx = harness({ enabled: false });
    await dispatch(level, ctx, `cmid-claude-off-${level}`);
    assert.equal(ctx.calls.enabled, 1);
    assert.equal(ctx.calls.supports, 0);
    assert.equal(ctx.calls.execute, 0);
    assert.equal(ctx.calls.legacy, 1);
  }
});

test('armed but unsupported Claude cell refuses before legacy/textual fallback', async () => {
  const ctx = harness({ enabled: true, supported: false });
  await dispatch('delegate_review', ctx);
  assert.equal(ctx.calls.execute, 0);
  assert.equal(ctx.calls.legacy, 0);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].code, 'hosted_turn_supervisor_unsupported');
  assert.equal(ctx.sent[0].notStarted, true);
});

test('ambiguous Claude ingress is handed to durable supervisor replay', async () => {
  ingressClaim = () => ({ action: 'ambiguous_started' });
  try {
    const ctx = harness({ enabled: true });
    await dispatch('delegate', ctx, 'cmid-claude-replay');
    assert.equal(ctx.calls.execute, 1);
    assert.equal(ctx.calls.legacy, 0);
    assert.deepEqual(ctx.sent.map(({ kind }) => kind), ['session_created', 'text', 'complete']);
  } finally {
    ingressClaim = () => ({ action: 'dispatch' });
  }
});

test('Claude stop is ownership-bound and cascades through the supervisor first', () => {
  const ctx = harness({ enabled: true });
  assert.equal(abortHostedSupervisedTurn(
    ctx.dependencies.hostedTurnSupervisor as never,
    'claude',
    'claude_supervised_1',
    77,
  ), true);
  assert.deepEqual(ctx.calls.cancel, [{
    provider: 'claude', sessionId: 'claude_supervised_1', userId: 77,
  }]);
});
