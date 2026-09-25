import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import Database from 'better-sqlite3';

import type {
  ShadowLegacyTurnHandle,
  UniversalConversationShadowHook,
} from '@/modules/conversations/index.js';
import {
  issueTrustedShadowAuthorization,
  UNIVERSAL_CONVERSATION_SHADOW_FLAG,
  UniversalConversationShadowRuntime,
} from '@/modules/conversations/index.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: () => ({ project_id: 'test-project' }),
      isProjectWritableByUser: () => true,
    },
    sessionsDb: { getSessionById: (sessionId: string) => ({
      session_id: sessionId, provider: 'codex', project_path: process.cwd(),
    }) },
    participantsDb: { isParticipant: () => true },
    sessionWorkspaceModesDb: { readLegacyEligibility: () => ({ mode: 'legacy_shared' }) },
    messageCoordinationDb: {
      claim: () => ({ action: 'dispatch' }),
      bindSession: () => true,
      markStarted: () => undefined,
      recordVerdict: () => undefined,
    },
  },
});

const chatModule = await import('./chat-websocket.service.js').catch((error) => {
  console.error('chat-websocket.shadow module import failed', error);
  throw error;
});
const { dispatchProviderCommand: dispatchProviderCommandRuntime, withUniversalConversationShadow } = chatModule;

const dispatchProviderCommand = (
  messageType: string,
  data: Record<string, any>,
  writer: unknown,
  dependencySet: unknown,
  userId: number,
  authenticatedPrincipal: unknown = {
    id: userId, role: 'user', authenticationKind: 'session', authorizationGeneration: 1,
  },
) => dispatchProviderCommandRuntime(
  messageType,
  {
    ...data,
    options: { cwd: process.cwd(), projectPath: process.cwd(), ...(data.options ?? {}) },
  },
  writer as never,
  dependencySet as never,
  userId,
  authenticatedPrincipal,
);

type Payload = Record<string, unknown>;

function fakeWriter(): { writer: Record<string, unknown>; sent: Payload[] } {
  const sent: Payload[] = [];
  const writer = {
    sessionId: null as string | null,
    userId: 41,
    isWebSocketWriter: true,
    send(payload: unknown) {
      sent.push(payload as Payload);
    },
    setSessionId(sessionId: string) {
      this.sessionId = sessionId;
    },
    getSessionId() {
      return this.sessionId;
    },
  };
  return { writer, sent };
}

function shadowHarness(overrides: {
  begin?: () => ShadowLegacyTurnHandle | null;
  recordFailure?: () => void;
} = {}): { shadow: UniversalConversationShadowHook; counts: Record<string, number> } {
  const counts = {
    begin: 0,
    observe: 0,
    dispatch: 0,
    finish: 0,
    providerFailure: 0,
    hookFailure: 0,
  };
  const handle: ShadowLegacyTurnHandle = {
    conversationId: 'conversation-shadow',
    runId: 'run-shadow',
    reused: false,
    observeLegacyPayload: () => {
      counts.observe += 1;
    },
    markLegacyDispatchStarted: () => {
      counts.dispatch += 1;
    },
    finishLegacyDispatch: () => {
      counts.finish += 1;
    },
    recordLegacyFailure: () => {
      counts.providerFailure += 1;
    },
  };
  return {
    counts,
    shadow: {
      isEnabled: () => true,
      beginLegacyTurn: () => {
        counts.begin += 1;
        return overrides.begin ? overrides.begin() : handle;
      },
      recordHookFailure: () => {
        counts.hookFailure += 1;
        overrides.recordFailure?.();
      },
    },
  };
}

function dependencies(input: {
  shadow: UniversalConversationShadowHook;
  codex: (writer: { send(payload: unknown): void }) => Promise<unknown>;
  cursor?: (options: unknown) => Promise<unknown>;
}) {
  const unused = async () => undefined;
  return {
    authorizeProviderExecution: () => ({
      kind: 'authorized',
      execution: {
        decisionId: 'decision-default', leaseId: 'lease-default', mode: 'legacy',
        consume: () => ({}), markStarted: () => undefined,
        settle: () => undefined, notStarted: () => undefined,
      },
    }),
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
        authorizationProvenance: 'chat-test',
      }),
    attestUniversalConversationLegacySession: () => null,
    getSessionProvider: () => null,
    queryCodex: async (_command: string, _options: unknown, writer: { send(payload: unknown): void }) =>
      input.codex(writer),
    queryClaudeSDK: unused,
    spawnCursor: async (_command: string, options: unknown) => input.cursor?.(options),
    spawnGemini: unused,
    spawnAntigravity: unused,
    spawnOpenCode: unused,
    spawnHermes: unused,
    spawnKimi: unused,
    spawnDeepSeek: unused,
    spawnGlm: unused,
  } as never;
}

describe('chat Phase-0 shadow hook', () => {
  it('is an exact no-op and never authorizes while the stable façade is disabled', () => {
    const { writer } = fakeWriter();
    let authorizationCalls = 0;
    const shadow: UniversalConversationShadowHook = {
      isEnabled: () => false,
      beginLegacyTurn: () => {
        throw new Error('disabled shadow must not begin');
      },
      recordHookFailure: () => {
        throw new Error('disabled shadow must not record');
      },
    };
    const dependencySet = dependencies({ shadow, codex: async () => undefined }) as unknown as {
      authorizeUniversalConversationShadow: () => null;
    };
    dependencySet.authorizeUniversalConversationShadow = () => {
      authorizationCalls += 1;
      return null;
    };
    const result = withUniversalConversationShadow(
      'codex-command',
      { command: 'disabled', options: { clientMsgId: 'disabled-client' } },
      writer as never,
      41,
      dependencySet as never,
    );
    assert.equal(result, writer);
    assert.equal(authorizationCalls, 0);
  });

  it('begins exactly once after preflight and preserves legacy payload delivery', async () => {
    const { shadow, counts } = shadowHarness();
    const { writer, sent } = fakeWriter();
    await dispatchProviderCommand(
      'codex-command',
      { command: 'hello', options: { clientMsgId: 'client-1' } },
      writer as never,
      dependencies({
        shadow,
        codex: async (providerWriter) => {
          providerWriter.send({ kind: 'complete', provider: 'codex', success: true });
        },
      }),
      41,
    );
    assert.equal(counts.begin, 1);
    assert.equal(counts.dispatch, 1);
    assert.equal(counts.observe, 1);
    assert.equal(counts.finish, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].clientMsgId, 'client-1');
  });

  it('passes a server-authorized one-use execution handle to the Codex seam', async () => {
    const { shadow } = shadowHarness();
    const { writer } = fakeWriter();
    let authorizedContext: Record<string, unknown> | null = null;
    let receivedExecution: { consume(): unknown } | null = null;
    const dependencySet = dependencies({
      shadow,
      codex: async () => undefined,
    }) as unknown as Record<string, any>;
    dependencySet.authorizeProviderExecution = (
      principal: unknown,
      context: Record<string, unknown>,
    ) => {
      assert.deepEqual(principal, {
        id: 41, role: 'user', authenticationKind: 'session', authorizationGeneration: 3,
      });
      authorizedContext = context;
      return {
        kind: 'authorized',
        execution: {
          decisionId: 'decision-1', leaseId: 'lease-1', mode: 'legacy',
          consume: () => ({ decisionId: 'decision-1' }),
          markStarted: () => undefined,
          settle: () => undefined,
        },
      };
    };
    dependencySet.queryCodex = async (
      _command: string,
      options: { permissionExecution?: { consume(): unknown } },
    ) => {
      receivedExecution = options.permissionExecution ?? null;
    };
    await dispatchProviderCommand(
      'codex-command',
      { command: 'hello', options: {
        clientMsgId: 'permission-client-1', sessionId: 'session-1', cwd: process.cwd(),
      } },
      writer as never,
      dependencySet as never,
      41,
      { id: 41, role: 'user', authenticationKind: 'session', authorizationGeneration: 3 },
    );
    assert.equal(authorizedContext?.provider, 'codex');
    assert.equal(authorizedContext?.principalId, 'user:41');
    assert.equal(authorizedContext?.sessionId, 'session-1');
    assert.equal(typeof receivedExecution?.consume, 'function');
  });

  it('consumes and settles a permit around a legacy CLI adapter', async () => {
    const { shadow } = shadowHarness();
    const { writer } = fakeWriter();
    const trace: string[] = [];
    const dependencySet = dependencies({
      shadow,
      codex: async () => undefined,
      cursor: async () => { trace.push('adapter'); },
    }) as unknown as Record<string, any>;
    dependencySet.authorizeProviderExecution = () => ({
      kind: 'authorized',
      execution: {
        decisionId: 'decision-cursor', leaseId: 'lease-cursor', mode: 'legacy',
        consume: () => { trace.push('consume'); return {}; },
        markStarted: () => { trace.push('started'); },
        settle: (outcome: string) => { trace.push(`settle:${outcome}`); },
        notStarted: () => { trace.push('not-started'); },
      },
    });
    await dispatchProviderCommand(
      'cursor-command',
      { command: 'hello', options: { clientMsgId: 'cursor-1', cwd: process.cwd() } },
      writer as never,
      dependencySet as never,
      41,
      { id: 41, role: 'user', authenticationKind: 'session', authorizationGeneration: 3 },
    );
    assert.deepEqual(trace, ['consume', 'started', 'adapter', 'settle:succeeded']);
  });

  it('keeps legacy redispatch behavior visible to shadow evidence for the same client message', async () => {
    const { shadow, counts } = shadowHarness();
    const { writer } = fakeWriter();
    let providerCalls = 0;
    const dependencySet = dependencies({
      shadow,
      codex: async (providerWriter) => {
        providerCalls += 1;
        providerWriter.send({ kind: 'complete', provider: 'codex', success: true });
      },
    });
    const message = { command: 'same ingress', options: { clientMsgId: 'client-redispatch' } };
    await dispatchProviderCommand('codex-command', message, writer as never, dependencySet, 41);
    await dispatchProviderCommand('codex-command', message, writer as never, dependencySet, 41);
    assert.equal(providerCalls, 2, 'Phase 0 does not alter legacy provider dispatch semantics');
    assert.equal(counts.begin, 2);
    assert.equal(counts.dispatch, 2);
    assert.equal(counts.observe, 2);
    assert.equal(counts.finish, 2);
  });

  it('persists a terminal content summary for each real provider redispatch generation', async () => {
    const directory = await mkdtemp('/tmp/nassaj-shadow-ws-');
    const databasePath = path.join(directory, 'auth.db');
    const lockPath = path.join(directory, 'universal-conversations.lock');
    const db = new Database(databasePath);
    const runtime = UniversalConversationShadowRuntime.boot(db, {
      env: { [UNIVERSAL_CONVERSATION_SHADOW_FLAG]: '1' },
      lockPath,
      referenceKey: 'phase-0-websocket-reference-key-0123456789abcdef',
    });
    try {
      assert.ok(runtime);
      const { writer } = fakeWriter();
      let providerCalls = 0;
      const dependencySet = dependencies({
        shadow: runtime,
        codex: async (providerWriter) => {
          providerCalls += 1;
          providerWriter.send({
            kind: 'stream_delta',
            provider: 'codex',
            content: `generation-${providerCalls}`,
          });
          providerWriter.send({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });
        },
      });
      const message = { command: 'same ingress', options: { clientMsgId: 'real-redispatch' } };
      await dispatchProviderCommand('codex-command', message, writer as never, dependencySet, 41);
      await dispatchProviderCommand('codex-command', message, writer as never, dependencySet, 41);

      assert.equal(providerCalls, 2);
      assert.deepEqual(
        db.prepare(
          `SELECT dispatch_generation, source_chunk_count, terminal_outcome
             FROM conversation_shadow_content_summaries ORDER BY dispatch_generation`,
        ).all(),
        [
          { dispatch_generation: 1, source_chunk_count: 1, terminal_outcome: 'success' },
          { dispatch_generation: 2, source_chunk_count: 1, terminal_outcome: 'success' },
        ],
      );
      assert.deepEqual(
        db.prepare(
          `SELECT legacy_dispatch_count, order_state
             FROM conversation_shadow_parity`,
        ).get(),
        { legacy_dispatch_count: 2, order_state: 'diverged' },
      );
      assert.equal(
        (db.prepare(
          "SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE legacy_kind NOT IN ('session_created', 'complete', 'error')",
        ).get() as { count: number }).count,
        0,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('settles a resolved provider call without a verdict as uncertain evidence', async () => {
    const directory = await mkdtemp('/tmp/nassaj-shadow-ws-');
    const db = new Database(path.join(directory, 'auth.db'));
    const runtime = UniversalConversationShadowRuntime.boot(db, {
      env: { [UNIVERSAL_CONVERSATION_SHADOW_FLAG]: '1' },
      lockPath: path.join(directory, 'universal-conversations.lock'),
      referenceKey: 'phase-0-websocket-reference-key-0123456789abcdef',
    });
    try {
      assert.ok(runtime);
      const { writer, sent } = fakeWriter();
      await dispatchProviderCommand(
        'codex-command',
        { command: 'resolve without verdict', options: { clientMsgId: 'resolved-no-verdict' } },
        writer as never,
        dependencies({
          shadow: runtime,
          codex: async (providerWriter) => {
            providerWriter.send({ kind: 'stream_delta', content: 'partial output' });
          },
        }),
        41,
      );
      assert.equal(sent.length, 1);
      const parity = db.prepare(
        `SELECT legacy_terminal_outcome, content_integrity_state, divergence_codes_json
           FROM conversation_shadow_parity`,
      ).get() as {
        legacy_terminal_outcome: string;
        content_integrity_state: string;
        divergence_codes_json: string;
      };
      assert.equal(parity.legacy_terminal_outcome, 'unknown');
      assert.equal(parity.content_integrity_state, 'unknown');
      assert.ok(JSON.parse(parity.divergence_codes_json)
        .includes('LEGACY_PROVIDER_RETURNED_WITHOUT_VERDICT'));
      assert.equal(
        (db.prepare('SELECT terminal_outcome FROM conversation_shadow_content_summaries').get() as {
          terminal_outcome: string;
        }).terminal_outcome,
        'unknown',
      );
      assert.deepEqual(
        db.prepare('SELECT state FROM conversation_commands').get(),
        { state: 'uncertain' },
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('forwards an asynchronous post-finish payload and records its anomaly once', async () => {
    const directory = await mkdtemp('/tmp/nassaj-shadow-ws-');
    const db = new Database(path.join(directory, 'auth.db'));
    const runtime = UniversalConversationShadowRuntime.boot(db, {
      env: { [UNIVERSAL_CONVERSATION_SHADOW_FLAG]: '1' },
      lockPath: path.join(directory, 'universal-conversations.lock'),
      referenceKey: 'phase-0-websocket-reference-key-0123456789abcdef',
    });
    let capturedWriter: { send(payload: unknown): void } | null = null;
    try {
      assert.ok(runtime);
      const { writer, sent } = fakeWriter();
      await dispatchProviderCommand(
        'codex-command',
        { command: 'delayed send', options: { clientMsgId: 'delayed-send' } },
        writer as never,
        dependencies({
          shadow: runtime,
          codex: async (providerWriter) => {
            capturedWriter = providerWriter;
            providerWriter.send({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });
          },
        }),
        41,
      );
      assert.ok(capturedWriter);
      const firstLate = { kind: 'stream_delta', content: 'late-1' };
      const secondLate = { kind: 'stream_delta', content: 'late-2' };
      (capturedWriter as { send(payload: unknown): void }).send(firstLate);
      (capturedWriter as { send(payload: unknown): void }).send(secondLate);
      assert.deepEqual(sent.at(-2), {
        ...firstLate, clientMsgId: 'delayed-send', coordinationLevel: 'delegate',
      });
      assert.deepEqual(sent.at(-1), {
        ...secondLate, clientMsgId: 'delayed-send', coordinationLevel: 'delegate',
      });
      const parity = db.prepare('SELECT divergence_codes_json FROM conversation_shadow_parity')
        .get() as { divergence_codes_json: string };
      assert.deepEqual(
        JSON.parse(parity.divergence_codes_json)
          .filter((code: string) => code === 'LEGACY_PAYLOAD_AFTER_DISPATCH_FINISH'),
        ['LEGACY_PAYLOAD_AFTER_DISPATCH_FINISH'],
      );
      assert.equal(runtime.getContentAccumulatorDiagnostics().active, 0);
    } finally {
      runtime?.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('forwards multi-megabyte identity claims unchanged while persisting only bounded evidence', async () => {
    const directory = await mkdtemp('/tmp/nassaj-shadow-ws-');
    const db = new Database(path.join(directory, 'auth.db'));
    const runtime = UniversalConversationShadowRuntime.boot(db, {
      env: { [UNIVERSAL_CONVERSATION_SHADOW_FLAG]: '1' },
      lockPath: path.join(directory, 'universal-conversations.lock'),
      referenceKey: 'phase-0-websocket-reference-key-0123456789abcdef',
    });
    const rawClaim = `SECRET_${'x'.repeat(2 * 1024 * 1024)}`;
    const payload = {
      kind: 'complete',
      provider: rawClaim,
      clientMsgId: rawClaim,
      sessionId: rawClaim,
      success: true,
      exitCode: 0,
    };
    try {
      assert.ok(runtime);
      const { writer, sent } = fakeWriter();
      await dispatchProviderCommand(
        'codex-command',
        { command: 'huge identity output', options: { clientMsgId: 'bounded-ingress' } },
        writer as never,
        dependencies({
          shadow: runtime,
          codex: async (providerWriter) => providerWriter.send(payload),
        }),
        41,
      );
      assert.deepEqual(sent[0], {
        ...payload,
        coordinationLevel: 'delegate',
        sameClientMsgIdRetryable: false,
      });
      assert.deepEqual(
        db.prepare(
          `SELECT integrity_state, schema_gap
             FROM conversation_shadow_content_summaries`,
        ).get(),
        { integrity_state: 'unknown', schema_gap: 1 },
      );
      assert.doesNotMatch(JSON.stringify({
        observations: db.prepare('SELECT * FROM conversation_shadow_observations').all(),
        parity: db.prepare('SELECT * FROM conversation_shadow_parity').all(),
        summaries: db.prepare('SELECT * FROM conversation_shadow_content_summaries').all(),
      }), /SECRET_/);
    } finally {
      runtime?.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves exact serialized bytes and getter counts when shadow inspection is enabled', async () => {
    const directory = await mkdtemp('/tmp/nassaj-shadow-ws-');
    const db = new Database(path.join(directory, 'auth.db'));
    const runtime = UniversalConversationShadowRuntime.boot(db, {
      env: { [UNIVERSAL_CONVERSATION_SHADOW_FLAG]: '1' },
      lockPath: path.join(directory, 'universal-conversations.lock'),
      referenceKey: 'phase-0-websocket-reference-key-0123456789abcdef',
    });
    const disabledShadow: UniversalConversationShadowHook = {
      isEnabled: () => false,
      beginLegacyTurn: () => {
        throw new Error('disabled');
      },
      recordHookFailure: () => undefined,
    };
    const run = async (shadow: UniversalConversationShadowHook) => {
      const serialized: string[] = [];
      let kindReads = 0;
      let contentReads = 0;
      const writer = {
        sessionId: null as string | null,
        userId: 41,
        isWebSocketWriter: true,
        send(payload: unknown) {
          serialized.push(JSON.stringify(payload));
        },
        setSessionId(sessionId: string) {
          this.sessionId = sessionId;
        },
        getSessionId() {
          return this.sessionId;
        },
      };
      const payload = {
        provider: 'codex',
        clientMsgId: 'getter-client',
        success: true,
        exitCode: 0,
        get kind() {
          kindReads += 1;
          return kindReads === 1 ? 'complete' : 'error';
        },
        get content() {
          contentReads += 1;
          return `wire-content-${contentReads}`;
        },
      };
      await dispatchProviderCommand(
        'codex-command',
        { command: 'getter equivalence', options: { clientMsgId: 'getter-client' } },
        writer as never,
        dependencies({
          shadow,
          codex: async (providerWriter) => providerWriter.send(payload),
        }),
        41,
      );
      return { serialized, kindReads, contentReads };
    };
    try {
      assert.ok(runtime);
      const disabled = await run(disabledShadow);
      const enabled = await run(runtime);
      assert.deepEqual(enabled, disabled);
      assert.equal(enabled.serialized.length, 1);
    } finally {
      runtime?.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('forwards exact wire bytes and marks evidence unknown after a payload descriptor trap fails', async () => {
    const directory = await mkdtemp('/tmp/nassaj-shadow-ws-');
    const db = new Database(path.join(directory, 'auth.db'));
    const runtime = UniversalConversationShadowRuntime.boot(db, {
      env: { [UNIVERSAL_CONVERSATION_SHADOW_FLAG]: '1' },
      lockPath: path.join(directory, 'universal-conversations.lock'),
      referenceKey: 'phase-0-websocket-reference-key-0123456789abcdef',
    });
    let observedContext: { preInspectionFailed?: boolean } | undefined;
    let observedAttestation: unknown = 'not-called';
    const observingShadow: UniversalConversationShadowHook = {
      isEnabled: () => true,
      beginLegacyTurn: (input) => {
        const handle = runtime?.beginLegacyTurn(input) ?? null;
        if (!handle) return null;
        return {
          conversationId: handle.conversationId,
          runId: handle.runId,
          reused: handle.reused,
          observeLegacyPayload(payload, attestation, context) {
            observedContext = context;
            observedAttestation = attestation;
            handle.observeLegacyPayload(payload, attestation, context);
          },
          markLegacyDispatchStarted: () => handle.markLegacyDispatchStarted(),
          finishLegacyDispatch: () => handle.finishLegacyDispatch?.(),
          recordLegacyFailure: (code) => handle.recordLegacyFailure(code),
        };
      },
      recordHookFailure: (failure) => runtime?.recordHookFailure(failure),
    };
    const serialized: string[] = [];
    const writer = {
      sessionId: null as string | null,
      userId: 41,
      send(payload: unknown) {
        serialized.push(JSON.stringify(payload));
      },
      setSessionId(sessionId: string) {
        this.sessionId = sessionId;
      },
      getSessionId() {
        return this.sessionId;
      },
    };
    const target = {
      kind: 'complete',
      provider: 'codex',
      clientMsgId: 'proxy-descriptor',
      success: true,
      exitCode: 0,
    };
    let descriptorFailures = 0;
    const payload = new Proxy(target, {
      getOwnPropertyDescriptor(inner, property) {
        if (property === 'kind' && descriptorFailures === 0) {
          descriptorFailures += 1;
          throw new Error('descriptor unavailable once');
        }
        return Reflect.getOwnPropertyDescriptor(inner, property);
      },
    });
    try {
      assert.ok(runtime);
      await dispatchProviderCommand(
        'codex-command',
        { command: 'descriptor trap', options: { clientMsgId: 'proxy-descriptor' } },
        writer as never,
        dependencies({
          shadow: observingShadow,
          codex: async (providerWriter) => providerWriter.send(payload),
        }),
        41,
      );
      assert.equal(descriptorFailures, 1);
      assert.deepEqual(serialized, [JSON.stringify({
        ...target,
        coordinationLevel: 'delegate',
        sameClientMsgIdRetryable: false,
      })]);
      assert.equal(observedContext?.preInspectionFailed, true);
      assert.equal(observedAttestation, null);
      assert.deepEqual(
        db.prepare(
          `SELECT integrity_state, schema_gap
             FROM conversation_shadow_content_summaries`,
        ).get(),
        { integrity_state: 'unknown', schema_gap: 1 },
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('forwards toJSON-transformed wire payloads but never verifies their shadow evidence', async () => {
    const directory = await mkdtemp('/tmp/nassaj-shadow-ws-');
    const db = new Database(path.join(directory, 'auth.db'));
    const runtime = UniversalConversationShadowRuntime.boot(db, {
      env: { [UNIVERSAL_CONVERSATION_SHADOW_FLAG]: '1' },
      lockPath: path.join(directory, 'universal-conversations.lock'),
      referenceKey: 'phase-0-websocket-reference-key-0123456789abcdef',
    });
    const serialized: string[] = [];
    const writer = {
      sessionId: null as string | null,
      userId: 41,
      send(payload: unknown) {
        serialized.push(JSON.stringify(payload));
      },
      setSessionId(sessionId: string) {
        this.sessionId = sessionId;
      },
      getSessionId() {
        return this.sessionId;
      },
    };
    const topLevelPayload = {
      kind: 'stream_delta',
      content: 'safe-top-level',
      clientMsgId: 'top-level-to-json',
    };
    Object.defineProperty(topLevelPayload, 'toJSON', {
      value: () => 'DANGER_ON_WIRE',
    });
    const nestedInput = { path: '/safe' };
    Object.defineProperty(nestedInput, 'toJSON', {
      value: () => ({ path: '/nested-danger-on-wire' }),
    });
    const nestedPayload = {
      kind: 'tool_use',
      toolId: 'nested-to-json-tool',
      toolName: 'Read',
      toolInput: nestedInput,
      clientMsgId: 'nested-to-json',
    };
    try {
      assert.ok(runtime);
      for (const [clientMsgId, payload] of [
        ['top-level-to-json', topLevelPayload],
        ['nested-to-json', nestedPayload],
      ] as const) {
        await dispatchProviderCommand(
          'codex-command',
          { command: clientMsgId, options: { clientMsgId } },
          writer as never,
          dependencies({
            shadow: runtime,
            codex: async (providerWriter) => providerWriter.send(payload),
          }),
          41,
        );
      }
      assert.equal(serialized[0], JSON.stringify({
        ...topLevelPayload,
        coordinationLevel: 'delegate',
      }));
      assert.match(serialized[1], /nested-danger-on-wire/);
      assert.deepEqual(
        db.prepare(
          `SELECT integrity_state, schema_gap
             FROM conversation_shadow_content_summaries
            ORDER BY created_at, run_id`,
        ).all(),
        [
          { integrity_state: 'unknown', schema_gap: 1 },
          { integrity_state: 'unknown', schema_gap: 1 },
        ],
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('still observes and sends a resumed session verdict when attestation throws', async () => {
    const observed: Array<{ payload: unknown; attestation: unknown }> = [];
    const failureCodes: string[] = [];
    const handle: ShadowLegacyTurnHandle = {
      conversationId: 'conversation-attester',
      runId: 'run-attester',
      reused: false,
      observeLegacyPayload(payload, attestation) {
        observed.push({ payload, attestation });
      },
      markLegacyDispatchStarted: () => undefined,
      finishLegacyDispatch: () => undefined,
      recordLegacyFailure: () => undefined,
    };
    const shadow: UniversalConversationShadowHook = {
      isEnabled: () => true,
      beginLegacyTurn: () => handle,
      recordHookFailure: (failure) => failureCodes.push(failure.code),
    };
    const dependencySet = dependencies({
      shadow,
      codex: async (providerWriter) => providerWriter.send({
        kind: 'session_created',
        provider: 'codex',
        sessionId: 'legacy-attester',
      }),
    }) as unknown as {
      authorizeUniversalConversationShadow: () => unknown;
      attestUniversalConversationLegacySession: () => unknown;
    };
    dependencySet.authorizeUniversalConversationShadow = () => issueTrustedShadowAuthorization({
      kind: 'resume',
      projectId: 'project-1',
      principalId: 41,
      clientMsgId: 'attester-throw',
      canSubmit: true,
      authorizationProvenance: 'chat-test-resume',
      legacyProvider: 'codex',
      legacySessionId: 'legacy-attester',
    });
    dependencySet.attestUniversalConversationLegacySession = () => {
      throw new Error('attester unavailable');
    };
    const { writer, sent } = fakeWriter();
    await dispatchProviderCommand(
      'codex-command',
      {
        command: 'resume',
        options: { clientMsgId: 'attester-throw', sessionId: 'legacy-attester' },
      },
      writer as never,
      dependencySet as never,
      41,
    );
    assert.equal(observed.length, 1);
    assert.equal(observed[0].attestation, null);
    assert.equal((observed[0].payload as Payload).sessionId, 'legacy-attester');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sessionId, 'legacy-attester');
    assert.deepEqual(failureCodes, ['SHADOW_ATTESTER_FAILED']);
  });

  it('keeps nested writer wrappers transparent for arbitrary state and method receivers', async () => {
    const { shadow } = shadowHarness();
    const receiverLog: object[] = [];
    const writer = {
      sessionId: null as string | null,
      rawSocket: null as object | null,
      arbitraryState: 'before',
      send: () => undefined,
      setSessionId(this: { sessionId: string | null }, sessionId: string) {
        receiverLog.push(this);
        this.sessionId = sessionId;
      },
      getSessionId(this: { sessionId: string | null }) {
        receiverLog.push(this);
        return this.sessionId;
      },
      updateWebSocket(this: { rawSocket: object | null }, rawSocket: object) {
        receiverLog.push(this);
        this.rawSocket = rawSocket;
      },
      arbitraryMethod(this: { arbitraryState: string }, next: string) {
        receiverLog.push(this);
        this.arbitraryState = next;
      },
    };
    const replacementSocket = {};
    await dispatchProviderCommand(
      'codex-command',
      { command: 'writer transparency', options: { clientMsgId: 'client-proxy' } },
      writer as never,
      dependencies({
        shadow,
        codex: async (providerWriter) => {
          const wrapped = providerWriter as unknown as typeof writer;
          wrapped.setSessionId('physical-thread');
          assert.equal(wrapped.getSessionId(), 'physical-thread');
          wrapped.updateWebSocket(replacementSocket);
          wrapped.arbitraryMethod('after');
          wrapped.arbitraryState = 'final';
        },
      }),
      41,
    );
    assert.equal(writer.sessionId, 'physical-thread');
    assert.equal(writer.rawSocket, replacementSocket);
    assert.equal(writer.arbitraryState, 'final');
    assert.deepEqual(receiverLog, [writer, writer, writer, writer]);
  });

  it('does not shadow-accept a globally disabled provider preflight rejection', async () => {
    const { shadow, counts } = shadowHarness();
    const { writer, sent } = fakeWriter();
    await dispatchProviderCommand(
      'deepseek-command',
      { command: 'blocked', options: { clientMsgId: 'client-disabled' } },
      writer as never,
      dependencies({
        shadow,
        codex: async () => {
          throw new Error('provider must not run');
        },
      }),
      41,
    );
    assert.equal(counts.begin, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].notStarted, true);
  });

  it('isolates both acceptance and metrics failures from legacy dispatch', async () => {
    const { shadow, counts } = shadowHarness({
      begin: () => {
        throw new Error('shadow database unavailable');
      },
      recordFailure: () => {
        throw new Error('metrics unavailable too');
      },
    });
    const { writer, sent } = fakeWriter();
    let legacyCalls = 0;
    await dispatchProviderCommand(
      'codex-command',
      { command: 'still dispatch', options: { clientMsgId: 'client-failure' } },
      writer as never,
      dependencies({
        shadow,
        codex: async (providerWriter) => {
          legacyCalls += 1;
          providerWriter.send({ kind: 'complete', provider: 'codex', success: true });
        },
      }),
      41,
    );
    assert.equal(counts.begin, 1);
    assert.equal(counts.hookFailure, 1);
    assert.equal(legacyCalls, 1);
    assert.equal(sent.length, 1);
  });

  it('fails open when the shadow enablement check throws for provider success and failure', async () => {
    const failureCodes: string[] = [];
    const shadow: UniversalConversationShadowHook = {
      isEnabled: () => {
        throw new Error('enablement backend unavailable');
      },
      beginLegacyTurn: () => {
        throw new Error('must not begin after an enablement failure');
      },
      recordHookFailure: (failure) => {
        failureCodes.push(failure.code);
      },
    };
    const { writer, sent } = fakeWriter();
    let providerCalls = 0;
    await dispatchProviderCommand(
      'codex-command',
      { command: 'success', options: { clientMsgId: 'enablement-success' } },
      writer as never,
      dependencies({
        shadow,
        codex: async (providerWriter) => {
          providerCalls += 1;
          providerWriter.send({ kind: 'complete', provider: 'codex', success: true });
          return 'provider-result';
        },
      }),
      41,
    );
    const providerError = new Error('same provider error');
    await assert.rejects(
      dispatchProviderCommand(
        'codex-command',
        { command: 'failure', options: { clientMsgId: 'enablement-failure' } },
        writer as never,
        dependencies({
          shadow,
          codex: async () => {
            providerCalls += 1;
            throw providerError;
          },
        }),
        41,
      ),
      (error) => error === providerError,
    );
    assert.equal(providerCalls, 2);
    assert.equal(sent.length, 1);
    assert.deepEqual(failureCodes, [
      'SHADOW_ENABLEMENT_CHECK_FAILED',
      'SHADOW_ENABLEMENT_CHECK_FAILED',
    ]);
  });

  it('never invokes a finish accessor and isolates a throwing finish method', async () => {
    let finishAccessorReads = 0;
    const accessorHandle: ShadowLegacyTurnHandle = {
      conversationId: 'conversation-accessor',
      runId: 'run-accessor',
      reused: false,
      observeLegacyPayload: () => undefined,
      markLegacyDispatchStarted: () => undefined,
      recordLegacyFailure: () => undefined,
    };
    Object.defineProperty(accessorHandle, 'finishLegacyDispatch', {
      enumerable: true,
      get() {
        finishAccessorReads += 1;
        throw new Error('finish accessor must stay inert');
      },
    });
    const accessorShadow = shadowHarness({ begin: () => accessorHandle });
    const accessorWriter = fakeWriter();
    await dispatchProviderCommand(
      'codex-command',
      { command: 'accessor', options: { clientMsgId: 'finish-accessor' } },
      accessorWriter.writer as never,
      dependencies({
        shadow: accessorShadow.shadow,
        codex: async (providerWriter) => {
          providerWriter.send({ kind: 'complete', provider: 'codex', success: true });
          return 'provider-result';
        },
      }),
      41,
    );
    assert.equal(finishAccessorReads, 0);
    assert.equal(accessorWriter.sent.length, 1);

    let finishCalls = 0;
    const methodHandle: ShadowLegacyTurnHandle = {
      conversationId: 'conversation-method',
      runId: 'run-method',
      reused: false,
      observeLegacyPayload: () => undefined,
      markLegacyDispatchStarted: () => undefined,
      finishLegacyDispatch: () => {
        finishCalls += 1;
        throw new Error('finish method unavailable');
      },
      recordLegacyFailure: () => undefined,
    };
    const methodShadow = shadowHarness({ begin: () => methodHandle });
    const methodWriter = fakeWriter();
    await dispatchProviderCommand(
      'codex-command',
      { command: 'success', options: { clientMsgId: 'finish-success' } },
      methodWriter.writer as never,
      dependencies({
        shadow: methodShadow.shadow,
        codex: async (providerWriter) => {
          providerWriter.send({ kind: 'complete', provider: 'codex', success: true });
        },
      }),
      41,
    );
    const providerError = new Error('provider failure survives finish failure');
    await assert.rejects(
      dispatchProviderCommand(
        'codex-command',
        { command: 'failure', options: { clientMsgId: 'finish-failure' } },
        methodWriter.writer as never,
        dependencies({
          shadow: methodShadow.shadow,
          codex: async () => {
            throw providerError;
          },
        }),
        41,
      ),
      (error) => error === providerError,
    );
    assert.equal(finishCalls, 2);
    assert.equal(methodShadow.counts.hookFailure, 2);
  });

  it('does not execute or persist a hostile acceptance-error code accessor', async () => {
    const secret = `SECRET_${'x'.repeat(256 * 1024)}`;
    let codeAccessorReads = 0;
    const hostileError = { secret } as { secret: string; code?: string };
    Object.defineProperty(hostileError, 'code', {
      enumerable: true,
      get() {
        codeAccessorReads += 1;
        throw new Error('hostile code accessor');
      },
    });
    const failureCodes: string[] = [];
    const shadow: UniversalConversationShadowHook = {
      isEnabled: () => true,
      beginLegacyTurn: () => {
        throw hostileError;
      },
      recordHookFailure: (failure) => {
        failureCodes.push(failure.code);
      },
    };
    const { writer, sent } = fakeWriter();
    let providerCalls = 0;
    await dispatchProviderCommand(
      'codex-command',
      { command: 'hostile acceptance', options: { clientMsgId: 'hostile-acceptance' } },
      writer as never,
      dependencies({
        shadow,
        codex: async (providerWriter) => {
          providerCalls += 1;
          providerWriter.send({ kind: 'complete', provider: 'codex', success: true });
        },
      }),
      41,
    );
    assert.equal(codeAccessorReads, 0);
    assert.equal(providerCalls, 1);
    assert.equal(sent.length, 1);
    assert.deepEqual(failureCodes, ['SHADOW_ACCEPT_FAILED']);
    assert.doesNotMatch(JSON.stringify(failureCodes), /SECRET_/);
  });

  it('records a provider throw without verdict and rethrows the same error', async () => {
    const { shadow, counts } = shadowHarness();
    const { writer } = fakeWriter();
    const providerError = new Error('original provider failure');
    await assert.rejects(
      dispatchProviderCommand(
        'codex-command',
        { command: 'throw', options: { clientMsgId: 'client-throw' } },
        writer as never,
        dependencies({
          shadow,
          codex: async () => {
            throw providerError;
          },
        }),
        41,
      ),
      (error) => error === providerError,
    );
    assert.equal(counts.providerFailure, 1);
  });

  it('does not create a user run for cursor-resume attachment without a turn', () => {
    const { shadow, counts } = shadowHarness();
    const { writer } = fakeWriter();
    const original = writer as never;
    const result = withUniversalConversationShadow(
      'cursor-resume',
      { sessionId: 'native-cursor', options: { sessionId: 'native-cursor' } },
      original,
      41,
      dependencies({ shadow, codex: async () => undefined }),
    );
    assert.equal(result, original);
    assert.equal(counts.begin, 0);
  });

  it('forwards legacy output even when the shadow observer and metrics both throw', async () => {
    const { shadow } = shadowHarness({
      begin: () => ({
        conversationId: 'conversation-shadow',
        runId: 'run-shadow',
        reused: false,
        observeLegacyPayload: () => {
          throw new Error('observer down');
        },
        markLegacyDispatchStarted: () => undefined,
        recordLegacyFailure: () => undefined,
      }),
      recordFailure: () => {
        throw new Error('metrics down');
      },
    });
    const { writer, sent } = fakeWriter();
    await dispatchProviderCommand(
      'codex-command',
      { command: 'deliver', options: { clientMsgId: 'client-deliver' } },
      writer as never,
      dependencies({
        shadow,
        codex: async (providerWriter) => {
          providerWriter.send({ kind: 'complete', provider: 'codex', success: true });
        },
      }),
      41,
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'complete');
  });
});
