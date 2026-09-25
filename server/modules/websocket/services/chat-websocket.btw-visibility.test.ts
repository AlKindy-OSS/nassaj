/**
 * chat-websocket.btw-visibility.test.ts — T-881 (/btw side-query WS gate).
 *
 * Drives the REAL handleChatConnection dispatcher (as the session-visibility and
 * attach integration tests do) with the database index and websocket-writer
 * module-mocked, asserting the /btw gate ordering BEFORE any fork is spawned:
 *
 *   - an OUTSIDER asking /btw on a PRIVATE-project session gets btw-error
 *     `not_visible` and spawnClaudeSideQuery is NEVER called (C3 visibility);
 *   - a non-claude session yields `unsupported_provider` and no fork;
 *   - an unknown session yields `session_not_found` and no fork;
 *   - a second concurrent /btw on the same socket is refused `busy` (flood guard)
 *     while the first is still in flight;
 *   - the happy path forwards {sessionId, userId=requester, cwd=project_path} to
 *     spawnClaudeSideQuery and relays its onChunk/onComplete as btw-chunk /
 *     btw-complete to the requesting socket, each carrying the client btwId.
 *
 * Runner: node:test with --experimental-test-module-mocks (no vitest).
 */

import assert from 'node:assert/strict';
import { test, describe, mock, beforeEach } from 'node:test';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

const PRIVATE_PATH = '/workspace/private-project';
const PUBLIC_PATH = '/workspace/public-project';
const PRIVATE_PROJECT_ID = 'proj-private';
const PUBLIC_PROJECT_ID = 'proj-public';

const OWNER_USER_ID = 1; // member of the private project
const OUTSIDER_USER_ID = 2; // NOT a member of the private project

// sessionId → project_path (sessions table) and the provider persisted for it.
const SESSION_PROJECT: Record<string, string> = {
  'sess-private-claude': PRIVATE_PATH,
  'sess-public-claude': PUBLIC_PATH,
  'sess-public-codex': PUBLIC_PATH,
};
const SESSION_PROVIDER: Record<string, string> = {
  'sess-private-claude': 'claude',
  'sess-public-claude': 'claude',
  'sess-public-codex': 'codex',
};

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    sessionsDb: {
      getSessionById: (sessionId: string) =>
        SESSION_PROJECT[sessionId]
          ? {
              session_id: sessionId,
              provider: SESSION_PROVIDER[sessionId],
              project_path: SESSION_PROJECT[sessionId],
            }
          : null,
    },
    projectsDb: {
      getProjectPath: (projectPath: string) =>
        projectPath === PRIVATE_PATH
          ? { project_id: PRIVATE_PROJECT_ID }
          : projectPath === PUBLIC_PATH
            ? { project_id: PUBLIC_PROJECT_ID }
            : null,
      isProjectVisibleToUser: (projectId: string, userId: number | null) =>
        projectId === PUBLIC_PROJECT_ID ||
        (projectId === PRIVATE_PROJECT_ID && userId === OWNER_USER_ID),
      getVisibleProjectPaths: () => [],
      // T-1090 write gate: the outsider can SEE the public project but is a member
      // of neither, so they may ask /btw there and may NOT fork into it.
      isProjectWritableByUser: (_projectId: string, userId: number | null) =>
        userId === OWNER_USER_ID,
    },
    // Same gate's first membership probe. No one is a session participant here, so
    // the project-level predicate above is what decides.
    participantsDb: {
      isParticipant: () => false,
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
    sessionOutcomesDb: {
      getOutcomeForBroadcast: () => null,
    },
  },
});

mock.module('@/modules/websocket/services/websocket-writer.service.js', {
  namedExports: {
    addSessionMirror: () => {},
    WebSocketWriter: class {
      ws: { readyState?: number; send?: (data: string) => void } | null;
      sessionId: string | null = null;
      userId: unknown;
      constructor(ws: { readyState?: number; send?: (data: string) => void } | null, userId: unknown = null) {
        this.ws = ws;
        this.userId = userId;
      }
      send(data: unknown): void {
        if (this.ws?.readyState === 1) {
          this.ws.send?.(JSON.stringify(data));
        }
      }
      setSessionId(id: string): void {
        this.sessionId = id;
      }
      getSessionId(): string | null {
        return this.sessionId;
      }
      updateWebSocket(ws: { readyState?: number; send?: (data: string) => void } | null): void {
        this.ws = ws;
      }
      isPrimarySocketAlive(): boolean {
        return this.ws?.readyState === 1;
      }
    },
  },
});

const { handleChatConnection, __resetBtwFloodStateForTests } = await import('./chat-websocket.service.js');

const WS_OPEN_STATE = 1;

function makeFakeWs() {
  const sent: Array<Record<string, unknown>> = [];
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  return {
    readyState: WS_OPEN_STATE,
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    on(event: string, cb: (arg: unknown) => void) {
      (listeners[event] ||= []).push(cb);
    },
    emit(event: string, arg: unknown) {
      (listeners[event] || []).forEach((cb) => cb(arg));
    },
  };
}

type SideQueryCall = {
  params: Record<string, unknown>;
  callbacks: {
    onStarted?: (handle: { interrupt: () => void }) => void;
    onChunk: (text: string) => void;
    onError: (code: string, message: string) => void;
    onComplete: (fullAnswer?: string) => void;
  };
};

// Full deps with a spawnClaudeSideQuery spy and a configurable getSessionProvider.
function makeDeps(overrides: Record<string, unknown> = {}) {
  const sideQueryCalls: SideQueryCall[] = [];
  const codexSideQueryCalls: SideQueryCall[] = [];
  // Default: a pending (never-resolving) promise so the in-flight slot stays held
  // — individual tests override the behaviour via `sideQueryImpl`.
  const state: { sideQueryImpl: (c: SideQueryCall) => Promise<void> } = {
    sideQueryImpl: () => new Promise<void>(() => {}),
  };
  const forkCalls: Array<Record<string, unknown>> = [];
  const messageForkCalls: Array<Record<string, unknown>> = [];
  const forkState: { impl: (params: Record<string, unknown>) => Promise<unknown> } = {
    impl: async (params: Record<string, unknown>) => ({
      sessionId: `forked-of-${String(params.sessionId)}`,
      title: 'btw: q',
      projectPath: PUBLIC_PATH,
    }),
  };
  const deps = {
    authorizeProviderExecution: () => ({
      kind: 'authorized',
      execution: {
        decisionId: 'decision-btw', leaseId: 'lease-btw', mode: 'legacy',
        consume: () => ({}), markStarted: () => undefined,
        settle: () => undefined, notStarted: () => undefined,
      },
    }),
    queryClaudeSDK: async () => {},
    forkSessionFromSideQuery: async (params: Record<string, unknown>) => {
      forkCalls.push(params);
      return forkState.impl(params);
    },
    forkSessionAtMessage: async (params: Record<string, unknown>) => {
      messageForkCalls.push(params);
      return {
        sessionId: `forked-at-${String(params.upToMessageId)}`,
        title: 'Forked conversation',
        projectPath: PUBLIC_PATH,
      };
    },
    spawnClaudeSideQuery: async (
      params: Record<string, unknown>,
      callbacks: SideQueryCall['callbacks']
    ) => {
      const call = { params, callbacks };
      sideQueryCalls.push(call);
      return state.sideQueryImpl(call);
    },
    spawnCodexSideQuery: async (
      params: Record<string, unknown>,
      callbacks: SideQueryCall['callbacks']
    ) => {
      const call = { params, callbacks };
      codexSideQueryCalls.push(call);
      return state.sideQueryImpl(call);
    },
    spawnCursor: async () => {},
    queryCodex: async () => {},
    spawnGemini: async () => {},
    spawnAntigravity: async () => {},
    spawnOpenCode: async () => {},
    spawnHermes: async () => {},
    spawnKimi: async () => {},
    spawnDeepSeek: async () => {},
    spawnGlm: async () => {},
    getSessionProvider: (sid: string) => SESSION_PROVIDER[sid] ?? null,
    abortClaudeSDKSession: async () => false,
    abortCursorSession: () => false,
    abortCodexSession: () => false,
    abortGeminiSession: () => false,
    abortAntigravitySession: () => false,
    abortOpenCodeSession: () => false,
    abortHermesSession: () => false,
    abortKimiSession: () => false,
    abortDeepSeekSession: () => false,
    abortGlmSession: () => false,
    resolveToolApproval: () => {},
    isClaudeSDKSessionActive: () => false,
    isCursorSessionActive: () => false,
    isCodexSessionActive: () => false,
    isGeminiSessionActive: () => false,
    isAntigravitySessionActive: () => false,
    isOpenCodeSessionActive: () => false,
    isHermesSessionActive: () => false,
    isKimiSessionActive: () => false,
    isDeepSeekSessionActive: () => false,
    isGlmSessionActive: () => false,
    reconnectSessionWriter: () => true,
    attachAntigravitySession: () => 0,
    attachClaudeSDKSession: () => 0,
    getPendingApprovalsForSession: () => [],
    getActiveClaudeSDKSessions: () => [],
    getActiveCursorSessions: () => [],
    getActiveCodexSessions: () => [],
    getActiveGeminiSessions: () => [],
    getActiveAntigravitySessions: () => [],
    getActiveOpenCodeSessions: () => [],
    getActiveHermesSessions: () => [],
    getActiveKimiSessions: () => [],
    getActiveDeepSeekSessions: () => [],
    getActiveGlmSessions: () => [],
    acquireWriterLease: async () => ({ release: () => {} }),
    ...overrides,
  };
  return {
    deps: deps as unknown as Parameters<typeof handleChatConnection>[2],
    sideQueryCalls,
    codexSideQueryCalls,
    state,
    forkCalls,
    messageForkCalls,
    forkState,
  };
}

function connect(userId: number, overrides?: Record<string, unknown>) {
  const ws = makeFakeWs();
  const { deps, sideQueryCalls, codexSideQueryCalls, state, forkCalls, messageForkCalls, forkState } = makeDeps(overrides);
  handleChatConnection(ws as never, { user: {
    id: userId,
    role: 'user',
    authenticationKind: 'session',
    authorizationGeneration: 1,
  } } as never, deps);
  return { ws, sideQueryCalls, codexSideQueryCalls, state, forkCalls, messageForkCalls, forkState };
}

function connectUnverifiedPlatform(overrides?: Record<string, unknown>) {
  const ws = makeFakeWs();
  const result = makeDeps(overrides);
  handleChatConnection(ws as never, {
    user: { id: OWNER_USER_ID, authenticationKind: 'platform_unverified' },
  } as never, result.deps);
  return { ws, ...result };
}

function connectAuthenticated(overrides?: Record<string, unknown>) {
  const ws = makeFakeWs();
  const result = makeDeps(overrides);
  handleChatConnection(ws as never, {
    user: {
      id: OWNER_USER_ID,
      role: 'owner',
      authenticationKind: 'session',
      authorizationGeneration: 4,
    },
  } as never, result.deps);
  return { ws, ...result };
}

function emitBtw(
  ws: ReturnType<typeof makeFakeWs>,
  payload: { btwId: string; sessionId?: string; question?: string; upToMessageId?: string }
) {
  ws.emit('message', JSON.stringify({ type: 'btw-query', ...payload }));
}

function findSent(ws: ReturnType<typeof makeFakeWs>, type: string): Record<string, unknown> | undefined {
  return ws.sent.find((m) => m.type === type);
}

/** Wait for the async writer-lease boundary before asserting its ACK/dispatch. */
function waitForWriterLease(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('T-881 /btw WS gate', () => {
  // A-4: the per-user flood counter is module-level shared state. Tests that leave
  // a fork "in flight" (the default never-resolving spy) would leak a slot into the
  // next test, so reset it before each.
  beforeEach(() => {
    __resetBtwFloodStateForTests();
  });

  test('(b) outsider /btw on a PRIVATE-project session → not_visible, no fork', () => {
    const { ws, sideQueryCalls } = connect(OUTSIDER_USER_ID);
    emitBtw(ws, { btwId: 'btw-1', sessionId: 'sess-private-claude', question: 'summarize this' });

    const err = findSent(ws, 'btw-error');
    assert.ok(err, 'a btw-error is returned');
    assert.equal(err.btwId, 'btw-1', 'error echoes the client btwId');
    assert.equal(err.code, 'not_visible', 'hidden private session → not_visible');
    assert.equal(sideQueryCalls.length, 0, 'the fork is NEVER spawned for a hidden session');
    assert.equal(findSent(ws, 'btw-chunk'), undefined, 'no answer streamed');
    assert.equal(findSent(ws, 'btw-complete'), undefined, 'no completion streamed');
  });

  test('unverified platform actor is denied before every /btw provider effect', () => {
    const { ws, sideQueryCalls, codexSideQueryCalls } = connectUnverifiedPlatform();
    emitBtw(ws, {
      btwId: 'btw-platform', sessionId: 'sess-public-claude', question: 'hi',
    });
    assert.equal(findSent(ws, 'btw-error')?.code, 'platform_actor_unverified');
    assert.equal(sideQueryCalls.length, 0);
    assert.equal(codexSideQueryCalls.length, 0);
  });

  test('member IS allowed the same private session (fork spawned, params correct)', async () => {
    const { ws, sideQueryCalls } = connect(OWNER_USER_ID);
    emitBtw(ws, { btwId: 'btw-ok', sessionId: 'sess-private-claude', question: 'why did it fail?' });
    await waitForWriterLease();

    assert.equal(findSent(ws, 'btw-error'), undefined, 'no error for a member');
    const accepted = findSent(ws, 'btw-accepted');
    assert.ok(accepted, 'A-3: an accept frame is sent once the gates pass');
    assert.equal(accepted.btwId, 'btw-ok', 'the accept frame echoes the client btwId');
    assert.equal(sideQueryCalls.length, 1, 'exactly one fork spawned');
    const { params } = sideQueryCalls[0];
    assert.equal(params.sessionId, 'sess-private-claude');
    assert.equal(params.question, 'why did it fail?');
    assert.equal(params.userId, OWNER_USER_ID, 'the REQUESTER is the env owner, not the session owner (C3)');
    assert.equal(params.cwd, PRIVATE_PATH, 'fork cwd = the session project_path');
  });

  test('side query consumes, starts, and settles the server permit', async () => {
    const trace: string[] = [];
    const connected = connectAuthenticated({
      authorizeProviderExecution: (_actor: unknown, context: Record<string, unknown>) => {
        assert.equal(context.entrypoint, 'ws.btw');
        assert.equal(context.purpose, 'sdk_turn');
        return {
          kind: 'authorized',
          execution: {
            decisionId: 'btw-decision', leaseId: 'btw-lease', mode: 'legacy',
            consume: () => { trace.push('consume'); return {}; },
            markStarted: () => { trace.push('started'); },
            settle: (outcome: string) => { trace.push(`settle:${outcome}`); },
            notStarted: () => { trace.push('not-started'); },
          },
        };
      },
    });
    connected.state.sideQueryImpl = async call => {
      call.callbacks.onStarted?.({ interrupt: () => {} });
      call.callbacks.onComplete('done');
    };
    emitBtw(connected.ws, {
      btwId: 'btw-permission', sessionId: 'sess-private-claude', question: 'why?',
    });
    await waitForWriterLease();
    await waitForWriterLease();
    assert.deepEqual(trace, ['consume', 'started', 'settle:succeeded']);
  });

  test('Codex session routes to the native Codex side-query adapter', async () => {
    const { ws, sideQueryCalls, codexSideQueryCalls } = connect(OUTSIDER_USER_ID);
    emitBtw(ws, { btwId: 'btw-2', sessionId: 'sess-public-codex', question: 'hi' });
    await waitForWriterLease();

    assert.equal(findSent(ws, 'btw-error'), undefined);
    assert.ok(findSent(ws, 'btw-accepted'));
    assert.equal(sideQueryCalls.length, 0, 'Claude adapter is not used');
    assert.equal(codexSideQueryCalls.length, 1, 'Codex adapter receives the query');
    assert.equal(codexSideQueryCalls[0].params.sessionId, 'sess-public-codex');
    assert.equal(codexSideQueryCalls[0].params.cwd, PUBLIC_PATH);
  });

  // 5ec5556c5: the visibility gate fails closed on an unknown id before the provider lookup.
  test('unknown session → not_visible (fail-closed), no fork', () => {
    const { ws, sideQueryCalls } = connect(OUTSIDER_USER_ID);
    emitBtw(ws, { btwId: 'btw-3', sessionId: 'sess-does-not-exist', question: 'hi' });

    const err = findSent(ws, 'btw-error');
    assert.ok(err);
    assert.equal(err.code, 'not_visible');
    assert.equal(sideQueryCalls.length, 0, 'no fork for an unknown session');
  });

  test('missing btwId is dropped (no reply, no fork)', () => {
    const { ws, sideQueryCalls } = connect(OWNER_USER_ID);
    // Ignore the connection-time open_sessions_count message; assert only that the
    // btw-query itself produced NO btw-* reply and started NO fork.
    const before = ws.sent.length;
    ws.emit(
      'message',
      JSON.stringify({ type: 'btw-query', sessionId: 'sess-public-claude', question: 'hi' })
    );
    assert.equal(ws.sent.length, before, 'no additional message for a btw-query with no correlation id');
    assert.equal(findSent(ws, 'btw-error'), undefined, 'no btw-error for a missing btwId');
    assert.equal(sideQueryCalls.length, 0, 'no fork for a missing btwId');
  });

  test('btwId and question limits are measured in UTF-8 bytes at their boundaries', async () => {
    const exactId = 'س'.repeat(64); // 128 UTF-8 bytes
    const exactQuestion = 'س'.repeat(16 * 1024); // 32 KiB UTF-8
    const exact = connect(OWNER_USER_ID);
    emitBtw(exact.ws, {
      btwId: exactId,
      sessionId: 'sess-public-claude',
      question: exactQuestion,
    });
    await waitForWriterLease();
    assert.ok(findSent(exact.ws, 'btw-accepted'), 'the exact byte ceilings are accepted');
    assert.equal(exact.sideQueryCalls.length, 1);

    const longId = connect(OWNER_USER_ID);
    emitBtw(longId.ws, {
      btwId: `${exactId}س`,
      sessionId: 'sess-public-claude',
      question: 'q',
    });
    const idError = findSent(longId.ws, 'btw-error');
    assert.equal(idError?.code, 'invalid_request');
    assert.equal(idError?.btwId, '', 'the oversized attacker id is not reflected');
    assert.equal(longId.sideQueryCalls.length, 0);

    const longQuestion = connect(OWNER_USER_ID);
    emitBtw(longQuestion.ws, {
      btwId: 'bounded-id',
      sessionId: 'sess-public-claude',
      question: `${exactQuestion}س`,
    });
    const questionError = findSent(longQuestion.ws, 'btw-error');
    assert.equal(questionError?.code, 'invalid_request');
    assert.equal(questionError?.btwId, 'bounded-id');
    assert.equal(findSent(longQuestion.ws, 'btw-accepted'), undefined);
    assert.equal(longQuestion.sideQueryCalls.length, 0);
  });

  test('a second concurrent /btw on the same socket is refused busy', async () => {
    const { ws, sideQueryCalls } = connect(OWNER_USER_ID);
    // First /btw stays in flight (default pending impl) → holds the slot.
    emitBtw(ws, { btwId: 'btw-a', sessionId: 'sess-public-claude', question: 'first' });
    await waitForWriterLease();
    assert.equal(sideQueryCalls.length, 1, 'first fork started');

    emitBtw(ws, { btwId: 'btw-b', sessionId: 'sess-public-claude', question: 'second' });
    const err = findSent(ws, 'btw-error');
    assert.ok(err);
    assert.equal(err.btwId, 'btw-b', 'the SECOND request is the one refused');
    assert.equal(err.code, 'busy');
    assert.equal(sideQueryCalls.length, 1, 'the second /btw never reached the fork');
  });

  test('happy path relays onChunk/onComplete as btw-chunk/btw-complete with the btwId', async () => {
    const { ws, sideQueryCalls, state } = connect(OWNER_USER_ID, {});
    // Impl that drives the streaming callbacks synchronously to completion.
    state.sideQueryImpl = async (call: SideQueryCall) => {
      call.callbacks.onChunk('The failure was a missing env var.');
      call.callbacks.onComplete();
    };
    emitBtw(ws, { btwId: 'btw-h', sessionId: 'sess-public-claude', question: 'why?' });
    await waitForWriterLease();

    assert.equal(sideQueryCalls.length, 1);
    // A-3: the accept frame precedes the first streamed chunk.
    const acceptedIdx = ws.sent.findIndex((m) => m.type === 'btw-accepted');
    const chunkIdx = ws.sent.findIndex((m) => m.type === 'btw-chunk');
    assert.ok(acceptedIdx >= 0, 'a btw-accepted was relayed');
    assert.equal((ws.sent[acceptedIdx] as { btwId?: string }).btwId, 'btw-h');
    assert.ok(acceptedIdx < chunkIdx, 'btw-accepted arrives BEFORE the first btw-chunk');
    const chunk = findSent(ws, 'btw-chunk');
    assert.ok(chunk, 'a btw-chunk was relayed');
    assert.equal(chunk.btwId, 'btw-h');
    assert.equal(chunk.text, 'The failure was a missing env var.');
    const done = findSent(ws, 'btw-complete');
    assert.ok(done, 'a btw-complete was relayed');
    assert.equal(done.btwId, 'btw-h');
    assert.equal(findSent(ws, 'btw-error'), undefined, 'no error on the happy path');
  });

  test('after a /btw completes, the slot is freed for the next one', async () => {
    const { ws, sideQueryCalls, state } = connect(OWNER_USER_ID, {});
    state.sideQueryImpl = async (call: SideQueryCall) => {
      call.callbacks.onComplete();
    };
    emitBtw(ws, { btwId: 'btw-1st', sessionId: 'sess-public-claude', question: 'a' });
    await waitForWriterLease();
    emitBtw(ws, { btwId: 'btw-2nd', sessionId: 'sess-public-claude', question: 'b' });
    await waitForWriterLease();

    assert.equal(sideQueryCalls.length, 2, 'the second /btw runs after the first frees the slot');
    assert.equal(findSent(ws, 'btw-error'), undefined, 'no busy error when serialized');
  });

  test('(A-2.3) a claude session with no resolvable project path → refused, no fork/accept', () => {
    // getSessionById returns null for an unpersisted id (⇒ null project_path). Since
    // 5ec5556c5 the visibility gate fails closed on it before the project-path gate,
    // so the fork never inherits the server cwd.
    const { ws, sideQueryCalls } = connect(OWNER_USER_ID, { getSessionProvider: () => 'claude' });
    emitBtw(ws, { btwId: 'np', sessionId: 'sess-unpersisted', question: 'hi' });

    const err = findSent(ws, 'btw-error');
    assert.ok(err, 'a btw-error is returned');
    assert.equal(err.code, 'not_visible', 'an unpersisted session is refused before any fork');
    assert.equal(err.btwId, 'np');
    assert.equal(sideQueryCalls.length, 0, 'no fork spawned without a project path');
    assert.equal(findSent(ws, 'btw-accepted'), undefined, 'no accept frame when the project-path gate fails');
  });

  test('(A-4) a third concurrent /btw for the SAME user (across sockets) is refused busy', async () => {
    // Two sockets for the same user each hold one in-flight fork (default pending impl).
    const a = connect(OWNER_USER_ID);
    emitBtw(a.ws, { btwId: 'u1', sessionId: 'sess-public-claude', question: 'q1' });
    await waitForWriterLease();
    assert.equal(a.sideQueryCalls.length, 1, 'first user fork started');

    const b = connect(OWNER_USER_ID);
    emitBtw(b.ws, { btwId: 'u2', sessionId: 'sess-public-claude', question: 'q2' });
    await waitForWriterLease();
    assert.equal(b.sideQueryCalls.length, 1, 'second user fork started (at the per-user cap of 2)');

    // A third socket for the same user is OVER the per-user cap → busy, no fork.
    const c = connect(OWNER_USER_ID);
    emitBtw(c.ws, { btwId: 'u3', sessionId: 'sess-public-claude', question: 'q3' });
    const err = findSent(c.ws, 'btw-error');
    assert.ok(err, 'the third concurrent user fork is refused');
    assert.equal(err.code, 'busy', 'over the per-user cap → busy');
    assert.equal(err.btwId, 'u3', 'the THIRD request is the one refused');
    assert.equal(c.sideQueryCalls.length, 0, 'no fork spawned over the per-user cap');
    assert.equal(findSent(c.ws, 'btw-accepted'), undefined, 'no accept frame when refused');

    // A DIFFERENT user has their own independent per-user cap.
    const other = connect(OUTSIDER_USER_ID);
    emitBtw(other.ws, { btwId: 'o1', sessionId: 'sess-public-claude', question: 'q' });
    await waitForWriterLease();
    assert.equal(other.sideQueryCalls.length, 1, 'another user is unaffected by this user\'s cap');
    assert.equal(findSent(other.ws, 'btw-error'), undefined, 'no busy for a different user');
  });

  test('(A-1) closing the socket mid-fork interrupts the fork and frees the user slot', async () => {
    const { ws, sideQueryCalls, state } = connect(OWNER_USER_ID);
    let interrupts = 0;
    // A fork that reports it started (handing back an interrupt handle) and then
    // stays in flight forever.
    state.sideQueryImpl = (call: SideQueryCall) => {
      call.callbacks.onStarted?.({
        interrupt: () => {
          interrupts += 1;
        },
      });
      return new Promise<void>(() => {});
    };
    emitBtw(ws, { btwId: 'live', sessionId: 'sess-public-claude', question: 'running' });
    await waitForWriterLease();
    assert.equal(sideQueryCalls.length, 1, 'the fork started');
    assert.ok(findSent(ws, 'btw-accepted'), 'A-3: accept frame sent before the fork');

    // The requesting socket dies mid-fork.
    ws.emit('close', 1006);
    assert.equal(interrupts, 1, 'A-1: the in-flight fork was interrupted on socket close');

    // The per-user slot must have been released on close. Prove it: the same user
    // can now run the FULL per-user cap (2) again, across two fresh sockets (the
    // per-socket guard caps each socket at one, so two sockets are needed). A
    // leaked slot would leave room for only ONE, refusing the second as busy.
    const p = connect(OWNER_USER_ID);
    emitBtw(p.ws, { btwId: 'p1', sessionId: 'sess-public-claude', question: 'a' });
    await waitForWriterLease();
    const q = connect(OWNER_USER_ID);
    emitBtw(q.ws, { btwId: 'q1', sessionId: 'sess-public-claude', question: 'b' });
    await waitForWriterLease();
    assert.equal(p.sideQueryCalls.length, 1, 'the first post-close fork ran');
    assert.equal(q.sideQueryCalls.length, 1, 'A-1: the second slot is free again — close released the in-flight one');
    assert.equal(findSent(q.ws, 'btw-error'), undefined, 'no busy — close freed the user slot');
  });
});

/**
 * T-1090 — the `/btw` FORK gate. Asking a side question is a READ of a session;
 * forking CREATES a session inside that session's project, so this path takes the
 * WRITE gate (visibility, then B-105/B-138 membership) rather than the read gate.
 * These tests pin that difference, the reply contract, and the flood guards.
 */
describe('T-1090 /btw fork WS gate', () => {
  beforeEach(() => {
    __resetBtwFloodStateForTests();
  });

  const FORK_PAYLOAD = {
    sessionId: 'sess-public-claude',
    question: 'why is it slow?',
    answer: 'because the docs symlink is re-bundled',
  };

  function emitFork(
    ws: ReturnType<typeof makeFakeWs>,
    payload: {
      btwId: string;
      sessionId?: string;
      question?: string;
      answer?: string;
      upToMessageId?: string;
      mode?: string;
    }
  ) {
    ws.emit('message', JSON.stringify({ type: 'btw-fork', ...payload }));
  }

  test('a VIEWER of a public project may ask /btw but may NOT fork it', async () => {
    // The very asymmetry this gate exists for: same session, same user, same
    // socket — the read passes and the write is refused.
    const { ws, sideQueryCalls, forkCalls } = connect(OUTSIDER_USER_ID);
    emitBtw(ws, { btwId: 'read', sessionId: 'sess-public-claude', question: 'q' });
    await waitForWriterLease();
    assert.equal(sideQueryCalls.length, 1, 'the READ (side query) is allowed');

    emitFork(ws, { btwId: 'write', ...FORK_PAYLOAD });
    const err = findSent(ws, 'btw-fork-error');
    assert.ok(err, 'a btw-fork-error is returned');
    assert.equal(err.btwId, 'write', 'the error echoes the client btwId');
    assert.equal(err.code, 'not_writable', 'a non-member cannot create a session in the project');
    assert.equal(forkCalls.length, 0, 'the fork service is NEVER reached');
  });

  test('a member forks: the service gets the exchange and the reply carries the new id', async () => {
    const { ws, forkCalls } = connect(OWNER_USER_ID);
    emitFork(ws, { btwId: 'f-ok', ...FORK_PAYLOAD, upToMessageId: 'msg-7' });
    await waitForWriterLease();

    assert.equal(forkCalls.length, 1, 'exactly one fork');
    assert.equal(forkCalls[0].sessionId, 'sess-public-claude');
    assert.equal(forkCalls[0].question, 'why is it slow?');
    assert.equal(forkCalls[0].answer, 'because the docs symlink is re-bundled');
    assert.equal(forkCalls[0].userId, OWNER_USER_ID, 'the REQUESTER owns the branch');
    assert.equal(forkCalls[0].upToMessageId, 'msg-7', 'the context pin is forwarded');
  });

  test('the chosen branch mode is forwarded, and anything unrecognised falls back to full', async () => {
    // Each fork is awaited to settle before the next: three back-to-back forks by
    // ONE user would otherwise hit the per-user cap of 2 (which is the intended
    // behaviour, asserted in its own test below — not what this one is about).
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    const a = connect(OWNER_USER_ID);
    emitFork(a.ws, { btwId: 'm-fresh', ...FORK_PAYLOAD, mode: 'fresh' });
    await settle();
    assert.equal(a.forkCalls[0].mode, 'fresh');

    const b = connect(OWNER_USER_ID);
    emitFork(b.ws, { btwId: 'm-default', ...FORK_PAYLOAD });
    await settle();
    assert.equal(b.forkCalls[0].mode, 'full', 'no mode ⇒ the CLI-faithful full branch');

    const c = connect(OWNER_USER_ID);
    emitFork(c.ws, { btwId: 'm-bogus', ...FORK_PAYLOAD, mode: 'shallow' });
    await settle();
    assert.equal(c.forkCalls[0].mode, 'full', 'an unknown mode is never passed through');
  });

  test('the btw-forked reply carries forkedSessionId and NO sessionId key (C2)', async () => {
    const { ws } = connect(OWNER_USER_ID);
    emitFork(ws, { btwId: 'f-reply', ...FORK_PAYLOAD });
    await new Promise((resolve) => setImmediate(resolve));

    const done = findSent(ws, 'btw-forked');
    assert.ok(done, 'a btw-forked frame is relayed');
    assert.equal(done.btwId, 'f-reply');
    assert.equal(done.forkedSessionId, 'forked-of-sess-public-claude');
    assert.equal(done.title, 'btw: q');
    assert.equal(
      Object.prototype.hasOwnProperty.call(done, 'sessionId'),
      false,
      'C2: no btw frame may carry a sessionId key (never a fan-out target)'
    );
    assert.equal(findSent(ws, 'btw-fork-error'), undefined, 'no error on the happy path');
  });

  test('a non-claude session is refused, and the service is never called', () => {
    const { ws, forkCalls } = connect(OWNER_USER_ID);
    emitFork(ws, { btwId: 'f-codex', ...FORK_PAYLOAD, sessionId: 'sess-public-codex' });

    const err = findSent(ws, 'btw-fork-error');
    assert.ok(err);
    assert.equal(err.code, 'unsupported_provider');
    assert.equal(forkCalls.length, 0);
  });

  // 5ec5556c5: the write gate fails closed on an unknown id before the provider lookup.
  test('an unknown session is refused not_writable (fail-closed)', () => {
    const { ws, forkCalls } = connect(OWNER_USER_ID);
    emitFork(ws, { btwId: 'f-unknown', ...FORK_PAYLOAD, sessionId: 'sess-does-not-exist' });

    const err = findSent(ws, 'btw-fork-error');
    assert.ok(err);
    assert.equal(err.code, 'not_writable');
    assert.equal(forkCalls.length, 0);
  });

  test('a half exchange (no answer) is refused invalid_request', () => {
    const { ws, forkCalls } = connect(OWNER_USER_ID);
    emitFork(ws, { btwId: 'f-half', sessionId: 'sess-public-claude', question: 'q', answer: '   ' });

    const err = findSent(ws, 'btw-fork-error');
    assert.ok(err);
    assert.equal(err.code, 'invalid_request', 'a branch tip must not be a dangling question');
    assert.equal(forkCalls.length, 0);
  });

  test('a fork with no btwId is dropped silently (no reply, no fork)', () => {
    const { ws, forkCalls } = connect(OWNER_USER_ID);
    const before = ws.sent.length;
    ws.emit('message', JSON.stringify({ type: 'btw-fork', ...FORK_PAYLOAD }));

    assert.equal(ws.sent.length, before, 'no reply without a correlation id');
    assert.equal(forkCalls.length, 0);
  });

  test('a service failure is relayed with ITS code, not a generic one', async () => {
    const { ws, forkState } = connect(OWNER_USER_ID);
    forkState.impl = async () => {
      const error = new Error('This conversation is too large to fork.') as Error & { code: string };
      error.code = 'source_too_large';
      throw error;
    };
    emitFork(ws, { btwId: 'f-err', ...FORK_PAYLOAD });
    await new Promise((resolve) => setImmediate(resolve));

    const err = findSent(ws, 'btw-fork-error');
    assert.ok(err);
    assert.equal(err.code, 'source_too_large');
    assert.equal(err.message, 'This conversation is too large to fork.');
    assert.equal(findSent(ws, 'btw-forked'), undefined, 'no success frame after a failure');
  });

  test('a second concurrent fork on the same socket is refused busy, and the slot frees', async () => {
    const { ws, forkState, forkCalls } = connect(OWNER_USER_ID);
    let release: (() => void) | null = null;
    forkState.impl = () =>
      new Promise((resolve) => {
        release = () => resolve({ sessionId: 'forked-slow', title: 'btw: q', projectPath: PUBLIC_PATH });
      });

    emitFork(ws, { btwId: 'f-1', ...FORK_PAYLOAD });
    await waitForWriterLease();
    assert.equal(forkCalls.length, 1, 'the first fork started');
    emitFork(ws, { btwId: 'f-2', ...FORK_PAYLOAD });

    const err = findSent(ws, 'btw-fork-error');
    assert.ok(err);
    assert.equal(err.btwId, 'f-2', 'the SECOND request is the one refused');
    assert.equal(err.code, 'busy');
    assert.equal(forkCalls.length, 1, 'the second fork never reached the service');

    // Finish the first; the socket must accept a fork again.
    release?.();
    await new Promise((resolve) => setImmediate(resolve));
    forkState.impl = async () => ({ sessionId: 'forked-after', title: 'btw: q', projectPath: PUBLIC_PATH });
    emitFork(ws, { btwId: 'f-3', ...FORK_PAYLOAD });
    await waitForWriterLease();
    assert.equal(forkCalls.length, 2, 'the slot was freed when the first fork settled');
  });

  test('forks and side queries do not consume each other\'s slots', async () => {
    // A fork is disk work and a side query is model work; one must never block the
    // other (they are separate counters by design).
    const { ws, forkState, forkCalls, sideQueryCalls } = connect(OWNER_USER_ID);
    forkState.impl = () => new Promise(() => {}); // stays in flight
    emitFork(ws, { btwId: 'f-hold', ...FORK_PAYLOAD });
    await waitForWriterLease();
    assert.equal(forkCalls.length, 1);

    emitBtw(ws, { btwId: 'q-while-forking', sessionId: 'sess-public-claude', question: 'q' });
    await waitForWriterLease();
    assert.equal(sideQueryCalls.length, 1, 'a side query still runs while a fork is in flight');
    assert.equal(findSent(ws, 'btw-error'), undefined, 'the side query was not refused busy');
  });

  test('a third concurrent fork for the SAME user (across sockets) is refused busy', async () => {
    const a = connect(OWNER_USER_ID);
    a.forkState.impl = () => new Promise(() => {});
    emitFork(a.ws, { btwId: 'uf1', ...FORK_PAYLOAD });
    await waitForWriterLease();
    assert.equal(a.forkCalls.length, 1);

    const b = connect(OWNER_USER_ID);
    b.forkState.impl = () => new Promise(() => {});
    emitFork(b.ws, { btwId: 'uf2', ...FORK_PAYLOAD });
    await waitForWriterLease();
    assert.equal(b.forkCalls.length, 1, 'at the per-user cap of 2');

    const c = connect(OWNER_USER_ID);
    emitFork(c.ws, { btwId: 'uf3', ...FORK_PAYLOAD });
    const err = findSent(c.ws, 'btw-fork-error');
    assert.ok(err);
    assert.equal(err.code, 'busy');
    assert.equal(c.forkCalls.length, 0, 'no fork over the per-user cap');
  });
});

describe('message-fork WS gate', () => {
  beforeEach(() => {
    __resetBtwFloodStateForTests();
  });

  const emitMessageFork = (ws: ReturnType<typeof makeFakeWs>, payload: Record<string, unknown>) => {
    ws.emit('message', JSON.stringify({ type: 'message-fork', ...payload }));
  };

  test('branches from an assistant UUID with a requestId-correlated, isolated reply', async () => {
    const { ws, messageForkCalls } = connect(OWNER_USER_ID);
    emitMessageFork(ws, {
      requestId: 'reply-fork-1',
      sessionId: 'sess-public-claude',
      upToMessageId: 'assistant-uuid-9',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(messageForkCalls, [{
      sessionId: 'sess-public-claude',
      upToMessageId: 'assistant-uuid-9',
      userId: OWNER_USER_ID,
      requestId: 'reply-fork-1',
      authenticatedPrincipal: { id: OWNER_USER_ID, role: 'user', authenticationKind: 'session', authorizationGeneration: 1 },
      retryRegistrationOnly: false,
      expectedForkedSessionId: undefined,
    }]);
    const done = findSent(ws, 'message-forked');
    assert.ok(done);
    assert.equal(done.requestId, 'reply-fork-1');
    assert.equal(done.forkedSessionId, 'forked-at-assistant-uuid-9');
    assert.equal(Object.hasOwn(done, 'sessionId'), false, 'unicast reply cannot be a writer target');
  });

  test('Codex uses the authenticated connection principal and ignores client target authority', async () => {
    const { ws, messageForkCalls } = connect(OWNER_USER_ID);
    emitMessageFork(ws, { requestId: 'codex-fork', sessionId: 'sess-public-codex', upToMessageId: 'msg_final',
      userId: 99, authenticatedPrincipal: { id: 99 }, path: '/foreign', turnId: 'future' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messageForkCalls.length, 1);
    assert.deepEqual(messageForkCalls[0], {
      sessionId: 'sess-public-codex', upToMessageId: 'msg_final', userId: OWNER_USER_ID, requestId: 'codex-fork',
      authenticatedPrincipal: { id: OWNER_USER_ID, role: 'user', authenticationKind: 'session', authorizationGeneration: 1 },
      retryRegistrationOnly: false,
      expectedForkedSessionId: undefined,
    });
    assert.ok(findSent(ws, 'message-forked'));
  });

  test('requires requestId and an assistant cutoff before calling the fork service', () => {
    const { ws, messageForkCalls } = connect(OWNER_USER_ID);
    emitMessageFork(ws, { sessionId: 'sess-public-claude', upToMessageId: 'a-1' });
    assert.equal(messageForkCalls.length, 0, 'missing correlation id is dropped');

    emitMessageFork(ws, { requestId: 'missing-target', sessionId: 'sess-public-claude' });
    const error = findSent(ws, 'message-fork-error');
    assert.ok(error);
    assert.equal(error.requestId, 'missing-target');
    assert.equal(error.code, 'message_not_found');
    assert.equal(messageForkCalls.length, 0);
  });

  test('enforces the write gate before the service', () => {
    const { ws, messageForkCalls } = connect(OUTSIDER_USER_ID);
    emitMessageFork(ws, {
      requestId: 'outsider',
      sessionId: 'sess-public-claude',
      upToMessageId: 'assistant-uuid-9',
    });
    const error = findSent(ws, 'message-fork-error');
    assert.ok(error);
    assert.equal(error.code, 'not_writable');
    assert.equal(messageForkCalls.length, 0);
  });
});
