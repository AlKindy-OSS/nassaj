import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import type {
  ShadowContentIntegritySummary,
  ShadowLegacyTurnInput,
  ShadowLegacyTurnHandle,
  UniversalConversationShadowHook,
} from '@/modules/conversations/index.js';
import {
  issueTrustedShadowAuthorization,
  ShadowContentIntegrityAccumulator,
} from '@/modules/conversations/index.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getProjectPath: () => ({ project_id: 'test-project' }),
      isProjectVisibleToUser: () => true,
    },
    sessionsDb: { getSessionById: () => null },
    sessionWorkspaceModesDb: { markOverlay: () => undefined },
    sessionOutcomesDb: {
      clearOutcome: () => undefined,
      setOutcome: () => undefined,
      getOutcome: () => null,
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

function dependencies(input: {
  shadow: UniversalConversationShadowHook;
  codex: (writer: Record<string, unknown>) => Promise<unknown>;
}) {
  const unused = async () => undefined;
  return {
    universalConversationShadow: input.shadow,
    authorizeUniversalConversationShadow: (authorizationInput: {
      principalId: string | number | null;
      clientMsgId: string;
    }) => authorizationInput.principalId === null
      ? null
      : issueTrustedShadowAuthorization({
        kind: 'fresh',
        projectId: 'project-1',
        principalId: authorizationInput.principalId,
        clientMsgId: authorizationInput.clientMsgId,
        canSubmit: true,
        authorizationProvenance: 'tester-chat-jwt+project-write:v1',
      }),
    attestUniversalConversationLegacySession: () => null,
    getSessionProvider: () => null,
    queryCodex: async (_command: string, _options: unknown, writer: Record<string, unknown>) =>
      input.codex(writer),
    queryClaudeSDK: unused,
    spawnCursor: unused,
    spawnGemini: unused,
    spawnAntigravity: unused,
    spawnOpenCode: unused,
    spawnHermes: unused,
    spawnKimi: unused,
    spawnDeepSeek: unused,
    spawnGlm: unused,
  } as never;
}

function shadowHarness(onBegin: (input: ShadowLegacyTurnInput) => void): UniversalConversationShadowHook {
  const handle: ShadowLegacyTurnHandle = {
    conversationId: 'logical-nassaj-conversation',
    runId: 'logical-run',
    reused: false,
    observeLegacyPayload: () => undefined,
    markLegacyDispatchStarted: () => undefined,
    recordLegacyFailure: () => undefined,
  };
  return {
    isEnabled: () => true,
    beginLegacyTurn: (input) => {
      onBegin(input);
      return handle;
    },
    recordHookFailure: () => undefined,
  };
}

describe('chat Phase-0 shadow adversarial integration', () => {
  it('uses only the JWT principal and ignores actor-like client fields', async () => {
    let accepted: ShadowLegacyTurnInput | null = null;
    const writer = { send: () => undefined };
    await dispatchProviderCommand(
      'codex-command',
      {
        command: 'hello',
        userId: 'client-forgery',
        coordinatorId: 'client-forgery',
        options: { clientMsgId: 'client-1', userId: 'client-forgery' },
      },
      writer as never,
      dependencies({
        shadow: shadowHarness((input) => { accepted = input; }),
        codex: async () => undefined,
      }),
      41,
    );
    assert.ok(accepted);
    assert.equal(accepted.principalId, 41);
  });

  it('preserves the underlying legacy writer session state and method receiver', async () => {
    const receiverLog: object[] = [];
    const firstSocket = { name: 'first-socket' };
    const replacementSocket = { name: 'replacement-socket' };
    const writer = {
      ws: firstSocket,
      sessionId: null as string | null,
      send: () => undefined,
      setSessionId(this: { sessionId: string | null }, sessionId: string) {
        receiverLog.push(this);
        this.sessionId = sessionId;
      },
      getSessionId(this: { sessionId: string | null }) {
        return this.sessionId;
      },
      updateWebSocket(this: { ws: object }, next: object) {
        receiverLog.push(this);
        this.ws = next;
      },
    };
    await dispatchProviderCommand(
      'codex-command',
      { command: 'hello', options: { clientMsgId: 'client-2' } },
      writer as never,
      dependencies({
        shadow: shadowHarness(() => undefined),
        codex: async (providerWriter) => {
          (providerWriter.setSessionId as (id: string) => void)('physical-thread');
          assert.equal(
            (providerWriter.getSessionId as () => string | null)(),
            'physical-thread',
          );
          (providerWriter.updateWebSocket as (socket: object) => void)(replacementSocket);
        },
      }),
      41,
    );
    assert.equal(writer.sessionId, 'physical-thread');
    assert.equal(writer.ws, replacementSocket);
    assert.deepEqual(receiverLog, [writer, writer]);
  });

  it('forwards overflow, schema-gap, and reentrant payload objects unchanged while failing evidence closed', async () => {
    async function runFault(
      clientMsgId: string,
      payloadFactory: (
        current: () => ShadowContentIntegrityAccumulator,
      ) => Record<string, unknown>,
    ): Promise<{
      summary: ShadowContentIntegritySummary;
      sentPayload: Record<string, unknown>;
      originalPayload: Record<string, unknown>;
    }> {
      let accumulator: ShadowContentIntegrityAccumulator | null = null;
      let summary: ShadowContentIntegritySummary | null = null;
      const terminal = { kind: 'complete', provider: 'codex', success: true, exitCode: 0 };
      const shadow: UniversalConversationShadowHook = {
        isEnabled: () => true,
        beginLegacyTurn: () => ({
          conversationId: 'logical-conversation',
          runId: `run-${clientMsgId}`,
          reused: false,
          markLegacyDispatchStarted: () => {
            accumulator = new ShadowContentIntegrityAccumulator({
              runId: `run-${clientMsgId}`,
              dispatchGeneration: 1,
              referenceKeyVersion: 1,
              referenceKey: Buffer.from('tester-content-key-0123456789abcdef', 'utf8'),
              trustedSourceSequence: false,
            });
          },
          observeLegacyPayload: (payload) => {
            assert.ok(accumulator);
            accumulator.observe(payload);
          },
          finishLegacyDispatch: () => {
            assert.ok(accumulator);
            summary = accumulator.finalize('success');
          },
          recordLegacyFailure: () => undefined,
        }),
        recordHookFailure: () => undefined,
      };
      const sent: Record<string, unknown>[] = [];
      const writer = { send: (payload: unknown) => sent.push(payload as Record<string, unknown>) };
      let originalPayload: Record<string, unknown> | null = null;
      await dispatchProviderCommand(
        'codex-command',
        { command: 'fault fixture', options: { clientMsgId } },
        writer as never,
        dependencies({
          shadow,
          codex: async (providerWriter) => {
            originalPayload = payloadFactory(() => {
              assert.ok(accumulator);
              return accumulator;
            });
            providerWriter.send(originalPayload);
            providerWriter.send(terminal);
          },
        }),
        41,
      );
      assert.ok(originalPayload && summary);
      return { summary, sentPayload: sent[0]!, originalPayload };
    }

    const overflow = await runFault('overflow', () => ({
      kind: 'stream_delta',
      content: 'x'.repeat(524_289),
    }));
    assert.deepEqual(overflow.sentPayload, {
      ...overflow.originalPayload,
      clientMsgId: 'overflow',
      coordinationLevel: 'delegate',
    });
    assert.equal(overflow.summary.integrityState, 'unknown');
    assert.equal(overflow.summary.overflow, true);

    const schemaGap = await runFault('schema-gap', () => ({
      kind: 'future_visible_kind',
      content: 'unsupported visible content',
    }));
    assert.deepEqual(schemaGap.sentPayload, {
      ...schemaGap.originalPayload,
      coordinationLevel: 'delegate',
    });
    assert.equal(schemaGap.summary.integrityState, 'unknown');
    assert.equal(schemaGap.summary.schemaGap, true);

    const reentrant = await runFault('reentrant', (current) => {
      let descriptorChecks = 0;
      return new Proxy({ kind: 'stream_delta', content: 'outer' }, {
        getOwnPropertyDescriptor(target, property) {
          descriptorChecks += 1;
          // The WebSocket pre-inspector performs the first three checks. Trigger
          // only once the accumulator itself is inspecting the outer payload.
          if (descriptorChecks === 4) {
            current().observe({ kind: 'stream_delta', content: 'nested' });
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });
    });
    assert.deepEqual(reentrant.sentPayload, {
      ...reentrant.originalPayload,
      clientMsgId: 'reentrant',
      coordinationLevel: 'delegate',
    });
    assert.equal(reentrant.summary.integrityState, 'unknown');
    assert.equal(reentrant.summary.reentrant, true);
  });
});
