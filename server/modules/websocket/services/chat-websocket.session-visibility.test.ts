/**
 * chat-websocket.session-visibility.test.ts — B-137 / B-144 (review 2026-07-09).
 *
 * B-137 (high): `check-session-status` took a client-supplied sessionId and
 * registered a read-only live mirror + replayed the session's buffered payloads
 * (and, for claude, could swap the writer) with NO ownership/membership check —
 * so any authenticated user could live-stream another user's private-project
 * session (its transcript, permission prompts and tool/file output).
 *
 * B-144 (low): `get-active-sessions` returned every user's active session ids
 * unfiltered, and omitted the kimi/deepseek/glm providers.
 *
 * These integration tests drive the REAL `handleChatConnection` dispatcher (as
 * chat-websocket.attach.test.ts does) with the database index and the
 * websocket-writer service module-mocked, asserting the visibility gate:
 *   - an OUTSIDER requesting a PRIVATE-project session gets NO mirror and NO
 *     attach/replay/reconnect, and a 404-equivalent session-status;
 *   - the owner/a member is allowed, and any team member is allowed a PUBLIC
 *     project's session (the legitimate multi-viewer case the mirror exists for);
 *   - get-active-sessions hides private-project ids from non-members and now
 *     surfaces kimi/deepseek/glm.
 *
 * Runner: node:test with --experimental-test-module-mocks (no vitest).
 */

import assert from 'node:assert/strict';
import { test, describe, mock } from 'node:test';

// --- Fixtures & module mocks (registered before importing the service) -------

const PRIVATE_PATH = '/workspace/private-project';
const PUBLIC_PATH = '/workspace/public-project';
const PRIVATE_PROJECT_ID = 'proj-private';
const PUBLIC_PROJECT_ID = 'proj-public';

const OWNER_USER_ID = 1; // a member of the private project
const OUTSIDER_USER_ID = 2; // NOT a member of the private project

// sessionId -> project_path the sessions table would resolve.
const SESSION_PROJECT: Record<string, string> = {
  'sess-private': PRIVATE_PATH,
  'sess-public': PUBLIC_PATH,
};

// addSessionMirror spy (the websocket-writer service is mocked below).
const mirrorCalls: string[] = [];

mock.module('@/modules/database/index.js', {
  namedExports: {
    sessionsDb: {
      getSessionById: (sessionId: string) =>
        SESSION_PROJECT[sessionId]
          ? { session_id: sessionId, provider: 'claude', project_path: SESSION_PROJECT[sessionId] }
          : null,
    },
    projectsDb: {
      getProjectPath: (projectPath: string) =>
        projectPath === PRIVATE_PATH
          ? { project_id: PRIVATE_PROJECT_ID }
          : projectPath === PUBLIC_PATH
            ? { project_id: PUBLIC_PROJECT_ID }
            : null,
      // Public project: visible to everyone. Private project: only its member.
      isProjectVisibleToUser: (projectId: string, userId: number | null) =>
        projectId === PUBLIC_PROJECT_ID ||
        (projectId === PRIVATE_PROJECT_ID && userId === OWNER_USER_ID),
      // Consumed only by the debounced presence broadcast; stub to keep it inert.
      getVisibleProjectPaths: () => [],
    },
    // presence.service.ts (in the chat service import graph) destructures userDb.
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});

mock.module('@/modules/websocket/services/websocket-writer.service.js', {
  namedExports: {
    addSessionMirror: (sessionId: string) => {
      mirrorCalls.push(sessionId);
    },
    // Minimal WebSocketWriter matching the surface handleChatConnection touches.
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

const { handleChatConnection } = await import('./chat-websocket.service.js');

const WS_OPEN_STATE = 1;

// Minimal raw-socket double matching the surface handleChatConnection touches.
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

// Full deps object with call counters on the paths the gate must (not) reach.
function makeDeps(overrides: Record<string, unknown> = {}) {
  const calls = { attachClaude: 0, attachAgy: 0, reconnect: 0, isClaudeActive: 0 };
  const deps = {
    queryClaudeSDK: async () => {},
    spawnCursor: async () => {},
    queryCodex: async () => {},
    spawnGemini: async () => {},
    spawnAntigravity: async () => {},
    spawnOpenCode: async () => {},
    spawnHermes: async () => {},
    spawnKimi: async () => {},
    spawnDeepSeek: async () => {},
    spawnGlm: async () => {},
    getSessionProvider: () => null,
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
    isClaudeSDKSessionActive: () => {
      calls.isClaudeActive += 1;
      return true;
    },
    isCursorSessionActive: () => false,
    isCodexSessionActive: () => false,
    isGeminiSessionActive: () => false,
    isAntigravitySessionActive: () => true,
    isOpenCodeSessionActive: () => false,
    isHermesSessionActive: () => false,
    isKimiSessionActive: () => false,
    isDeepSeekSessionActive: () => false,
    isGlmSessionActive: () => false,
    reconnectSessionWriter: () => {
      calls.reconnect += 1;
      return true;
    },
    attachAntigravitySession: () => {
      calls.attachAgy += 1;
      return 0;
    },
    attachClaudeSDKSession: () => {
      calls.attachClaude += 1;
      return 0;
    },
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
  return { deps: deps as unknown as Parameters<typeof handleChatConnection>[2], calls };
}

// Connects a fresh authenticated socket and returns the socket + call counters.
function connect(userId: number, overrides?: Record<string, unknown>) {
  mirrorCalls.length = 0;
  const ws = makeFakeWs();
  const { deps, calls } = makeDeps(overrides);
  handleChatConnection(ws as never, { user: { id: userId } } as never, deps);
  return { ws, calls };
}

function findSent(ws: ReturnType<typeof makeFakeWs>, type: string): Record<string, unknown> | undefined {
  return ws.sent.find((m) => m.type === type);
}

describe('B-137 check-session-status visibility gate', () => {
  test('outsider requesting a PRIVATE-project session gets no mirror and no attach', () => {
    const { ws, calls } = connect(OUTSIDER_USER_ID);
    ws.emit(
      'message',
      JSON.stringify({ type: 'check-session-status', provider: 'claude', sessionId: 'sess-private' })
    );

    assert.deepEqual(mirrorCalls, [], 'no read-only mirror registered for a hidden session');
    assert.equal(calls.attachClaude, 0, 'no buffered-payload replay for a hidden session');
    assert.equal(calls.reconnect, 0, 'no writer swap for a hidden session');
    assert.equal(calls.isClaudeActive, 0, 'gate returns before the session activity is even probed');

    const status = findSent(ws, 'session-status');
    assert.ok(status, '404-equivalent session-status still returned');
    assert.equal(status.sessionId, 'sess-private');
    assert.equal(status.isProcessing, false, 'hidden session reported not-processing');
  });

  test('owner/member requesting the same PRIVATE-project session is allowed', () => {
    const { ws, calls } = connect(OWNER_USER_ID);
    ws.emit(
      'message',
      JSON.stringify({ type: 'check-session-status', provider: 'claude', sessionId: 'sess-private' })
    );

    assert.deepEqual(mirrorCalls, ['sess-private'], 'member gets a live read-only mirror');
    assert.equal(calls.attachClaude, 1, 'member gets differential replay');
    assert.equal(calls.isClaudeActive, 1, 'activity is probed for a visible session');

    const status = findSent(ws, 'session-status');
    assert.ok(status);
    assert.equal(status.isProcessing, true);
  });

  test('any team member is allowed a PUBLIC-project session (the multi-viewer case)', () => {
    // OUTSIDER is not a private member, but public projects are team-visible.
    const { ws, calls } = connect(OUTSIDER_USER_ID);
    ws.emit(
      'message',
      JSON.stringify({ type: 'check-session-status', provider: 'claude', sessionId: 'sess-public' })
    );

    assert.deepEqual(mirrorCalls, ['sess-public'], 'public session still mirrors for the team');
    assert.equal(calls.attachClaude, 1);
  });

  test('antigravity path is gated too — outsider gets no mirror and no agy replay', () => {
    const { ws, calls } = connect(OUTSIDER_USER_ID);
    ws.emit(
      'message',
      JSON.stringify({ type: 'check-session-status', provider: 'antigravity', sessionId: 'sess-private' })
    );

    assert.deepEqual(mirrorCalls, [], 'no mirror on the antigravity branch either');
    assert.equal(calls.attachAgy, 0, 'no antigravity differential replay for a hidden session');

    const status = findSent(ws, 'session-status');
    assert.ok(status);
    assert.equal(status.isProcessing, false);
  });
});

describe('B-144 get-active-sessions membership filter + provider coverage', () => {
  test('private-project ids are hidden from non-members; public ids pass through', () => {
    const { ws } = connect(OUTSIDER_USER_ID, {
      getActiveClaudeSDKSessions: () => ['sess-private', 'sess-public'],
    });
    ws.emit('message', JSON.stringify({ type: 'get-active-sessions' }));

    const msg = findSent(ws, 'active-sessions') as { sessions: Record<string, string[]> } | undefined;
    assert.ok(msg, 'active-sessions returned');
    assert.deepEqual(msg.sessions.claude, ['sess-public'], 'outsider never sees the private id');
  });

  test('the owner/member sees the private id in the active list', () => {
    const { ws } = connect(OWNER_USER_ID, {
      getActiveClaudeSDKSessions: () => ['sess-private', 'sess-public'],
    });
    ws.emit('message', JSON.stringify({ type: 'get-active-sessions' }));

    const msg = findSent(ws, 'active-sessions') as { sessions: Record<string, string[]> } | undefined;
    assert.ok(msg);
    assert.deepEqual([...msg.sessions.claude].sort(), ['sess-private', 'sess-public']);
  });

  test('kimi/deepseek/glm are now included in the response and filtered', () => {
    const { ws } = connect(OUTSIDER_USER_ID, {
      getActiveKimiSessions: () => ['sess-public'],
      getActiveDeepSeekSessions: () => ['sess-private'],
      getActiveGlmSessions: () => ['sess-public', 'sess-private'],
    });
    ws.emit('message', JSON.stringify({ type: 'get-active-sessions' }));

    const msg = findSent(ws, 'active-sessions') as { sessions: Record<string, string[]> } | undefined;
    assert.ok(msg);
    assert.ok('kimi' in msg.sessions, 'kimi provider now present');
    assert.ok('deepseek' in msg.sessions, 'deepseek provider now present');
    assert.ok('glm' in msg.sessions, 'glm provider now present');
    assert.deepEqual(msg.sessions.kimi, ['sess-public']);
    assert.deepEqual(msg.sessions.deepseek, [], 'private deepseek id hidden from the outsider');
    assert.deepEqual(msg.sessions.glm, ['sess-public'], 'only the public glm id survives the filter');
  });
});
