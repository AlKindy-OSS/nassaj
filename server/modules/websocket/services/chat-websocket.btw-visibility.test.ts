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
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
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
    onComplete: () => void;
  };
};

// Full deps with a spawnClaudeSideQuery spy and a configurable getSessionProvider.
function makeDeps(overrides: Record<string, unknown> = {}) {
  const sideQueryCalls: SideQueryCall[] = [];
  // Default: a pending (never-resolving) promise so the in-flight slot stays held
  // — individual tests override the behaviour via `sideQueryImpl`.
  const state: { sideQueryImpl: (c: SideQueryCall) => Promise<void> } = {
    sideQueryImpl: () => new Promise<void>(() => {}),
  };
  const deps = {
    queryClaudeSDK: async () => {},
    spawnClaudeSideQuery: async (
      params: Record<string, unknown>,
      callbacks: SideQueryCall['callbacks']
    ) => {
      const call = { params, callbacks };
      sideQueryCalls.push(call);
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
    ...overrides,
  };
  return {
    deps: deps as unknown as Parameters<typeof handleChatConnection>[2],
    sideQueryCalls,
    state,
  };
}

function connect(userId: number, overrides?: Record<string, unknown>) {
  const ws = makeFakeWs();
  const { deps, sideQueryCalls, state } = makeDeps(overrides);
  handleChatConnection(ws as never, { user: { id: userId } } as never, deps);
  return { ws, sideQueryCalls, state };
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

  test('member IS allowed the same private session (fork spawned, params correct)', () => {
    const { ws, sideQueryCalls } = connect(OWNER_USER_ID);
    emitBtw(ws, { btwId: 'btw-ok', sessionId: 'sess-private-claude', question: 'why did it fail?' });

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

  test('non-claude session → unsupported_provider, no fork', () => {
    // Public project ⇒ visible to the outsider, but the session runs on codex.
    const { ws, sideQueryCalls } = connect(OUTSIDER_USER_ID);
    emitBtw(ws, { btwId: 'btw-2', sessionId: 'sess-public-codex', question: 'hi' });

    const err = findSent(ws, 'btw-error');
    assert.ok(err);
    assert.equal(err.code, 'unsupported_provider', 'non-claude session refused');
    assert.equal(sideQueryCalls.length, 0, 'no fork for a non-claude session');
  });

  test('unknown session → session_not_found, no fork', () => {
    const { ws, sideQueryCalls } = connect(OUTSIDER_USER_ID);
    emitBtw(ws, { btwId: 'btw-3', sessionId: 'sess-does-not-exist', question: 'hi' });

    const err = findSent(ws, 'btw-error');
    assert.ok(err);
    assert.equal(err.code, 'session_not_found');
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

  test('a second concurrent /btw on the same socket is refused busy', () => {
    const { ws, sideQueryCalls } = connect(OWNER_USER_ID);
    // First /btw stays in flight (default pending impl) → holds the slot.
    emitBtw(ws, { btwId: 'btw-a', sessionId: 'sess-public-claude', question: 'first' });
    assert.equal(sideQueryCalls.length, 1, 'first fork started');

    emitBtw(ws, { btwId: 'btw-b', sessionId: 'sess-public-claude', question: 'second' });
    const err = findSent(ws, 'btw-error');
    assert.ok(err);
    assert.equal(err.btwId, 'btw-b', 'the SECOND request is the one refused');
    assert.equal(err.code, 'busy');
    assert.equal(sideQueryCalls.length, 1, 'the second /btw never reached the fork');
  });

  test('happy path relays onChunk/onComplete as btw-chunk/btw-complete with the btwId', () => {
    const { ws, sideQueryCalls, state } = connect(OWNER_USER_ID, {});
    // Impl that drives the streaming callbacks synchronously to completion.
    state.sideQueryImpl = async (call: SideQueryCall) => {
      call.callbacks.onChunk('The failure was a missing env var.');
      call.callbacks.onComplete();
    };
    emitBtw(ws, { btwId: 'btw-h', sessionId: 'sess-public-claude', question: 'why?' });

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

  test('after a /btw completes, the slot is freed for the next one', () => {
    const { ws, sideQueryCalls, state } = connect(OWNER_USER_ID, {});
    state.sideQueryImpl = async (call: SideQueryCall) => {
      call.callbacks.onComplete();
    };
    emitBtw(ws, { btwId: 'btw-1st', sessionId: 'sess-public-claude', question: 'a' });
    emitBtw(ws, { btwId: 'btw-2nd', sessionId: 'sess-public-claude', question: 'b' });

    assert.equal(sideQueryCalls.length, 2, 'the second /btw runs after the first frees the slot');
    assert.equal(findSent(ws, 'btw-error'), undefined, 'no busy error when serialized');
  });

  test('(A-2.3) a claude session with no resolvable project path → sdk_error, no fork/accept', () => {
    // getSessionById returns null for an unpersisted id (⇒ null project_path), but
    // the provider gate is forced to claude, so the fork reaches the project-path
    // gate. It must refuse rather than let the fork inherit the server cwd.
    const { ws, sideQueryCalls } = connect(OWNER_USER_ID, { getSessionProvider: () => 'claude' });
    emitBtw(ws, { btwId: 'np', sessionId: 'sess-unpersisted', question: 'hi' });

    const err = findSent(ws, 'btw-error');
    assert.ok(err, 'a btw-error is returned');
    assert.equal(err.code, 'sdk_error', 'a missing project path is refused with sdk_error');
    assert.equal(err.btwId, 'np');
    assert.equal(sideQueryCalls.length, 0, 'no fork spawned without a project path');
    assert.equal(findSent(ws, 'btw-accepted'), undefined, 'no accept frame when the project-path gate fails');
  });

  test('(A-4) a third concurrent /btw for the SAME user (across sockets) is refused busy', () => {
    // Two sockets for the same user each hold one in-flight fork (default pending impl).
    const a = connect(OWNER_USER_ID);
    emitBtw(a.ws, { btwId: 'u1', sessionId: 'sess-public-claude', question: 'q1' });
    assert.equal(a.sideQueryCalls.length, 1, 'first user fork started');

    const b = connect(OWNER_USER_ID);
    emitBtw(b.ws, { btwId: 'u2', sessionId: 'sess-public-claude', question: 'q2' });
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
    assert.equal(other.sideQueryCalls.length, 1, 'another user is unaffected by this user\'s cap');
    assert.equal(findSent(other.ws, 'btw-error'), undefined, 'no busy for a different user');
  });

  test('(A-1) closing the socket mid-fork interrupts the fork and frees the user slot', () => {
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
    const q = connect(OWNER_USER_ID);
    emitBtw(q.ws, { btwId: 'q1', sessionId: 'sess-public-claude', question: 'b' });
    assert.equal(p.sideQueryCalls.length, 1, 'the first post-close fork ran');
    assert.equal(q.sideQueryCalls.length, 1, 'A-1: the second slot is free again — close released the in-flight one');
    assert.equal(findSent(q.ws, 'btw-error'), undefined, 'no busy — close freed the user slot');
  });
});
