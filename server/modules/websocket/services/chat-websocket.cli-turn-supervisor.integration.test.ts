import assert from 'node:assert/strict';
import test, { after, mock } from 'node:test';

// B-1544: must stay the first app-side import — DATABASE_PATH, HOME and the
// harness roots point into a private sandbox, never the worktree database/.
// eslint-disable-next-line boundaries/dependencies -- test-only sandbox helper, no barrel by design.
import { removeSandbox } from '@/modules/providers/tests/helpers/hermetic-sandbox.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

// The real exports (sandboxed DATABASE_PATH) back every name this test does not
// stub, so the real CLI supervisor runtime can load for its routing.
const realDatabase = await import('@/modules/database/index.js');
mock.module('@/modules/database/index.js', {
  namedExports: {
    ...realDatabase,
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: { getProjectPath: () => ({ project_id: 'test-project' }), isProjectVisibleToUser: () => true },
    sessionsDb: { getSessionById: () => null }, sessionOutcomesDb: {},
    sessionWorkspaceModesDb: { markOverlay: () => undefined },
    messageCoordinationDb: {
      claim: () => ({ action: 'dispatch' }), bindSession: () => true,
      markStarted: () => undefined, recordVerdict: () => undefined,
    },
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});
const realWorkspaces = await import('@/modules/session-workspaces/index.js');
mock.module('@/modules/session-workspaces/index.js', {
  namedExports: { ...realWorkspaces, ...createPermissionTestWorkspaceModule() },
});

const { abortCliSupervisedTurn, dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);
// eslint-disable-next-line boundaries/dependencies -- the real runtime's routing is the subject under test.
const { CliTurnSupervisorRuntime } = await import('@/modules/turn-supervisor/cli-turn-supervisor.service.js');

after(() => removeSandbox());

function harness(supported: boolean, enabled = supported) {
  const sent: Record<string, unknown>[] = [];
  const calls = { legacy: 0, execute: 0, input: null as Record<string, unknown> | null };
  const spawn = async () => { calls.legacy += 1; };
  const writer = {
    send(payload: unknown) { sent.push(payload as Record<string, unknown>); },
    setSessionId() {},
  };
  const dependencies = {
    queryClaudeSDK: spawn, queryCodex: spawn, spawnCursor: spawn,
    spawnAntigravity: spawn, spawnOpenCode: spawn,
    spawnKimi: spawn, spawnDeepSeek: spawn, spawnGlm: spawn, spawnQwen: spawn,
    getSessionProvider: () => null,
    cliTurnSupervisor: {
      enabledCell: () => enabled,
      supports: () => supported,
      async execute(input: Record<string, unknown>) {
        calls.execute += 1; calls.input = input;
        (input.onSession as (id: string, isNew: boolean) => void)('codex_supervised_1', true);
        return { text: 'outer only', model: 'gpt-5.3-codex', sessionId: 'codex_supervised_1', isNewSession: true };
      },
      cancel: () => false,
    },
  };
  return { sent, calls, writer, dependencies };
}

test('Codex direct/delegate/delegate_review route exclusively through mechanical CLI supervisor', async () => {
  for (const coordinationLevel of ['direct', 'delegate', 'delegate_review'] as const) {
    const ctx = harness(true);
    await dispatchProviderCommand('codex-command', {
      command: 'user request',
      options: { clientMsgId: `cmid-${coordinationLevel}`, coordinationLevel, model: 'gpt-5.3-codex' },
    } as never, ctx.writer as never, ctx.dependencies as never, 41);
    assert.equal(ctx.calls.legacy, 0);
    assert.equal(ctx.calls.execute, 1);
    assert.equal(ctx.calls.input?.coordinationLevel, coordinationLevel);
    assert.deepEqual(ctx.sent.map(({ kind }) => kind), ['session_created', 'text', 'complete']);
  }
});

// hermes and qwen are globally disabled (owner decision 2026-09-28): refused before any cell.
test('the OpenCode enabled cell uses the same capture-only WS seam', async () => {
  for (const [messageType, provider] of [
    ['opencode-command', 'opencode'],
  ] as const) {
    const ctx = harness(true, true);
    await dispatchProviderCommand(messageType, {
      command: 'user request',
      options: { clientMsgId: `cmid-${provider}-supervised`, coordinationLevel: 'delegate', model: 'pinned' },
    } as never, ctx.writer as never, ctx.dependencies as never, 41);
    assert.equal(ctx.calls.legacy, 0, provider);
    assert.equal(ctx.calls.execute, 1, provider);
    assert.equal(ctx.calls.input?.provider, provider);
    assert.deepEqual(ctx.sent.map(({ kind }) => kind), ['session_created', 'text', 'complete']);
  }
});

test('disabled or unsupported CLI cells preserve legacy dispatch', async () => {
  const cases = [
    ['codex-command', 'codex'],
    ['antigravity-command', 'antigravity'], ['opencode-command', 'opencode'],
  ] as const;
  for (const [messageType, provider] of cases) {
    const ctx = harness(false, false);
    await dispatchProviderCommand(messageType, {
      command: 'request', options: { clientMsgId: `cmid-${provider}`, coordinationLevel: 'delegate' },
    } as never, ctx.writer as never, ctx.dependencies as never, 41);
    assert.equal(ctx.calls.legacy, 1, provider);
    assert.equal(ctx.calls.execute, 0, provider);
  }
});

// cursor is globally disabled (owner decision 2026-09-29): an OFF cell leaves it on
// the legacy path, which is now the disable wall — refused, never launched.
test('an OFF CLI cell leaves retired cursor refused before any launcher', async () => {
  const ctx = harness(false, false);
  await dispatchProviderCommand('cursor-command', {
    command: 'request', options: { clientMsgId: 'cmid-cursor', coordinationLevel: 'delegate' },
  } as never, ctx.writer as never, ctx.dependencies as never, 41);
  assert.equal(ctx.calls.legacy, 0);
  assert.equal(ctx.calls.execute, 0);
  assert.equal(ctx.sent[0]?.notStarted, true);
  // T-1953: cursor is retired as a body; the typed refusal replaces the disabled wording.
  assert.equal(ctx.sent[0]?.code, 'provider_removed');
});

test('an enabled Codex cell never falls back when its requested level lacks capability', async () => {
  const ctx = harness(false, true);
  await dispatchProviderCommand('codex-command', {
    command: 'request', options: { clientMsgId: 'cmid-enabled-refusal', coordinationLevel: 'delegate_review' },
  } as never, ctx.writer as never, ctx.dependencies as never, 41);
  assert.equal(ctx.calls.legacy, 0);
  assert.equal(ctx.calls.execute, 0);
  assert.equal(ctx.sent[0]?.code, 'cli_turn_supervisor_unsupported');
  assert.equal(ctx.sent[0]?.notStarted, true);
});

test('armed Qwen/Hermes cells are unreachable: the retired refusal precedes the supervisor (T-1953)', async () => {
  for (const [messageType, provider] of [['qwen-command', 'qwen'], ['hermes-command', 'hermes']] as const) {
    const ctx = harness(false, true);
    await dispatchProviderCommand(messageType, {
      command: 'request', options: { clientMsgId: `cmid-${provider}-probe-refusal`, coordinationLevel: 'delegate' },
    } as never, ctx.writer as never, ctx.dependencies as never, 41);
    assert.equal(ctx.calls.legacy, 0, provider);
    assert.equal(ctx.calls.execute, 0, provider);
    // Both bodies are retired: the refusal is decided before any CLI cell is
    // consulted, so an armed cell can no longer start (or even probe) them.
    assert.equal(ctx.sent[0]?.code, 'provider_removed', provider);
    assert.equal(ctx.sent[0]?.notStarted, true, provider);
  }
});

test('CLI abort bridge is identity scoped to the three supervised providers', () => {
  const seen: unknown[] = [];
  const supervisor = {
    supports: () => true, execute: async () => { throw new Error('unused'); },
    cancel(input: unknown) { seen.push(input); return true; },
  };
  assert.equal(abortCliSupervisedTurn(supervisor as never, 'codex', 's-1', 41), true);
  assert.deepEqual(seen, [{ provider: 'codex', sessionId: 's-1', userId: 41 }]);
  assert.equal(abortCliSupervisedTurn(supervisor as never, 'qwen', 's-2', 41), true);
  assert.equal(abortCliSupervisedTurn(supervisor as never, 'opencode', 's-3', 41), true);
  assert.equal(abortCliSupervisedTurn(supervisor as never, 'hermes', 's-4', 41), false, 'the hermes cell is deleted');
  assert.equal(abortCliSupervisedTurn(supervisor as never, 'cursor', 's-1', 41), false);
});

/**
 * B-1550 / B-1551 (G3 r2): an ARMED opencode cell with the spawn-vendor flag on.
 * The cell's routing is the REAL CliTurnSupervisorRuntime (enabledCell); only
 * the installed-binary probe in supports() is replaced by that same routing, so
 * a cell turn is executable here. Moonshot/DeepSeek (any case, the models.dev
 * aliases) and qwen-plan go to spawnOpenCode — every coordination level, with
 * the textual directive — and never to execute(); glm/* stays on the cell.
 */
test('armed opencode cell: spawn-vendor models dispatch to spawnOpenCode, glm stays on the cell', async () => {
  const runtime = new CliTurnSupervisorRuntime({
    NASSAJ_TURN_SUPERVISOR_OPENCODE_CHAT: 'true', NASSAJ_OPENCODE_SPAWN_VENDORS: 'true',
  }, []);
  const spawnOnly = [
    'moonshot/kimi-k2.6', 'deepseek/deepseek-v4-pro', 'moonshotai/kimi-k2.6',
    'MoonshotAI-CN/kimi-k3', 'DEEPSEEK/deepseek-v4-flash', 'qwen-plan/qwen3.7-plus',
  ];
  for (const model of spawnOnly) {
    for (const coordinationLevel of ['direct', 'delegate', 'delegate_review'] as const) {
      const input = { provider: 'opencode', mode: 'chat', coordinationLevel, model };
      assert.equal(runtime.enabledCell(input), false, model);
      assert.equal(runtime.supports(input), false, model);
      const ctx = harness(false, false);
      const launched: Record<string, unknown>[] = [];
      Object.assign(ctx.dependencies, {
        spawnOpenCode: async (_command: string, options: Record<string, unknown>) => { launched.push(options); },
        cliTurnSupervisor: {
          ...ctx.dependencies.cliTurnSupervisor,
          enabledCell: (cell: typeof input) => runtime.enabledCell(cell),
          supports: (cell: typeof input) => runtime.enabledCell(cell),
        },
      });
      await dispatchProviderCommand('opencode-command', {
        command: 'user request',
        options: { clientMsgId: `cmid-s8-${model}-${coordinationLevel}`, coordinationLevel, model },
      } as never, ctx.writer as never, ctx.dependencies as never, 41);
      const label = `${model} ${coordinationLevel}`;
      assert.equal(launched.length, 1, label);
      assert.equal(launched[0].model, model, label);
      assert.equal(launched[0].coordinationLevel, coordinationLevel, `${label}: textual directive level`);
      assert.equal(ctx.calls.execute, 0, label);
      assert.ok(!ctx.sent.some((frame) => frame.code === 'cli_turn_supervisor_unsupported'), label);
    }
  }

  const glm = { provider: 'opencode', mode: 'chat', coordinationLevel: 'delegate' as const, model: 'glm/glm-5.2' };
  assert.equal(runtime.enabledCell(glm), true);
  const ctx = harness(true, true);
  let launched = 0;
  Object.assign(ctx.dependencies, {
    spawnOpenCode: async () => { launched += 1; },
    cliTurnSupervisor: {
      ...ctx.dependencies.cliTurnSupervisor,
      enabledCell: (cell: typeof glm) => runtime.enabledCell(cell),
      supports: (cell: typeof glm) => runtime.enabledCell(cell),
    },
  });
  await dispatchProviderCommand('opencode-command', {
    command: 'user request', options: { clientMsgId: 'cmid-s8-glm', coordinationLevel: 'delegate', model: 'glm/glm-5.2' },
  } as never, ctx.writer as never, ctx.dependencies as never, 41);
  assert.equal(launched, 0, 'glm never reaches spawnOpenCode while the cell is armed');
  assert.equal(ctx.calls.execute, 1);
  assert.equal(ctx.calls.input?.model, 'glm/glm-5.2');
});
