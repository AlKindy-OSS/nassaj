import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

const databaseExports = await import('@/modules/database/index.js');
const workspaceExports = await import('@/modules/session-workspaces/index.js');

let ingressClaim: () => { action: string } = () => ({ action: 'dispatch' });

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...databaseExports,
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
mock.module('@/modules/session-workspaces/index.js', { namedExports: { ...workspaceExports, ...createPermissionTestWorkspaceModule() } });

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
  const spawn = async (command: string, options: Record<string, unknown>) => { calls.legacy += 1; calls.input = { prompt: command, ...options }; };
  const dependencies = {
    queryClaudeSDK: spawn, queryCodex: spawn, spawnCursor: spawn, spawnGemini: spawn,
    spawnAntigravity: spawn, spawnHermes: spawn, spawnQwen: spawn, spawnOpenCode: spawn,
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


const { readVendorReceiptInvocation } = await import('@/modules/providers/index.js');
const manifest = { version: 1, kind: 'text', imageCount: 0, fileCount: 0 };
for (const provider of ['qwen', 'hermes', 'kimi', 'deepseek', 'glm']) {
  test(`${provider}: dispatch mints owner-bound text receipt and rejects raw capabilities/attachments`, async () => {
    for (const valid of [true, false]) {
      const ctx = harness({ enabled: true, supported: true });
      await dispatchProviderCommand(`${provider}-command`, {
        command: 'unchanged complete prompt',
        options: { clientMsgId: 'client-id', coordinationLevel: 'delegate', mode: 'chat',
          receiptPayload: manifest, vendorReceiptInvocation: { userId: 999, clientMsgId: 'spoof', textOnly: true },
          ...(valid ? {} : { images: [{ path: '/unrepresented.png' }] }),
        },
      } as never, ctx.writer as never, ctx.dependencies as never, 77);
      const invocation = ctx.calls.input?.vendorReceiptInvocation;
      if (!valid) {
        assert.equal(ctx.calls.execute + ctx.calls.legacy, 0, 'invalid attachments must never reach a provider');
        assert.equal(invocation, undefined);
        assert.ok(ctx.sent.some(event => event.kind === 'complete'
          && event.code === 'invalid_image_attachments' && event.notStarted === true && event.success === false));
        continue;
      }
      assert.equal(ctx.calls.execute + ctx.calls.legacy, 1, JSON.stringify(ctx.sent));
      const receipt = readVendorReceiptInvocation(invocation, 'unchanged complete prompt', 77);
      assert.deepEqual(receipt, valid ? { userId: 77, clientMsgId: 'client-id', textOnly: true } : undefined);
      assert.equal(readVendorReceiptInvocation(invocation, 'changed', 77), undefined);
      assert.equal(readVendorReceiptInvocation(invocation, 'unchanged complete prompt', 999), undefined);
      assert.doesNotMatch(JSON.stringify(invocation) ?? '', /client-id|userId/);
    }
  });
}
