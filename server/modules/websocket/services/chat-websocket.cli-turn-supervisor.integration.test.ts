import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
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
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { abortCliSupervisedTurn, dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

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
    spawnAntigravity: spawn, spawnHermes: spawn, spawnOpenCode: spawn,
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

test('Qwen, OpenCode and Hermes enabled cells use the same capture-only WS seam', async () => {
  for (const [messageType, provider] of [
    ['qwen-command', 'qwen'], ['opencode-command', 'opencode'], ['hermes-command', 'hermes'],
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
    ['codex-command', 'codex'], ['cursor-command', 'cursor'],
    ['antigravity-command', 'antigravity'], ['opencode-command', 'opencode'],
    ['hermes-command', 'hermes'], ['qwen-command', 'qwen'],
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

test('armed Qwen/Hermes cells with failed binary probes refuse before legacy invocation', async () => {
  for (const [messageType, provider] of [['qwen-command', 'qwen'], ['hermes-command', 'hermes']] as const) {
    const ctx = harness(false, true);
    await dispatchProviderCommand(messageType, {
      command: 'request', options: { clientMsgId: `cmid-${provider}-probe-refusal`, coordinationLevel: 'delegate' },
    } as never, ctx.writer as never, ctx.dependencies as never, 41);
    assert.equal(ctx.calls.legacy, 0, provider);
    assert.equal(ctx.calls.execute, 0, provider);
    assert.equal(ctx.sent[0]?.code, 'cli_turn_supervisor_unsupported', provider);
    assert.equal(ctx.sent[0]?.notStarted, true, provider);
  }
});

test('CLI abort bridge is identity scoped to the four supervised providers', () => {
  const seen: unknown[] = [];
  const supervisor = {
    supports: () => true, execute: async () => { throw new Error('unused'); },
    cancel(input: unknown) { seen.push(input); return true; },
  };
  assert.equal(abortCliSupervisedTurn(supervisor as never, 'codex', 's-1', 41), true);
  assert.deepEqual(seen, [{ provider: 'codex', sessionId: 's-1', userId: 41 }]);
  assert.equal(abortCliSupervisedTurn(supervisor as never, 'qwen', 's-2', 41), true);
  assert.equal(abortCliSupervisedTurn(supervisor as never, 'opencode', 's-3', 41), true);
  assert.equal(abortCliSupervisedTurn(supervisor as never, 'hermes', 's-4', 41), true);
  assert.equal(abortCliSupervisedTurn(supervisor as never, 'cursor', 's-1', 41), false);
});
