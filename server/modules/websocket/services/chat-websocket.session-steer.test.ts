/**
 * chat-websocket.session-steer.test.ts — T-1903 M4: the `session-steer` socket
 * handler through the REAL handleChatConnection dispatcher.
 *
 *   - the sender identity is the JWT-authenticated presence identity; any
 *     identity field in the payload is ignored;
 *   - a member who may not write the session is refused `not_writable` before
 *     anything reveals whether a run exists (the run registry is never asked);
 *   - the verdict goes to the requesting socket only.
 */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

const PATH = '/workspace/team';
const WRITER = 1;
const READER = 2;
const STARTER = 3;
const SID = 'sess-steer';
const TURN = 'a1111111-2222-4333-8444-555555555555';
const inserts: Array<Record<string, unknown>> = [];
let policyValue: string | null = null;
let starterConsents = true;
const audits: Array<Record<string, unknown>> = [];

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    sessionsDb: { getSessionById: (id: string) => (id === SID || id === 'sess-codex'
      ? { session_id: id, provider: id === SID ? 'claude' : 'codex', project_path: PATH } : null) },
    projectsDb: {
      getProjectPath: () => ({ project_id: 'p1' }),
      isProjectVisibleToUser: () => true,
      getVisibleProjectPaths: () => [],
      isProjectWritableByUser: (_p: string, userId: number | null) => userId === WRITER || userId === STARTER,
    },
    participantsDb: { isParticipant: () => false },
    userDb: { getUserById: (id: number) => ({ id, username: `user${id}` }), getFirstUser: () => null },
    sessionOutcomesDb: { getOutcomeForBroadcast: () => null },
    appConfigDb: { get: () => policyValue, set: () => {} },
    uiPreferencesDb: { getSteerConsent: (id: number) => id === STARTER && starterConsents },
    auditLogDb: { recordStrict: (_a: string, o: Record<string, unknown>) => { audits.push(o); }, record: () => {} },
    messageCoordinationDb: {
      insertSteer: (row: Record<string, unknown>) => { inserts.push(row); return true; },
      updateSteerStatus: () => true,
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

const { handleChatConnection } = await import('./chat-websocket.service.js');
const steer = await import('@/modules/session-steer/index.js');

function makeFakeWs() {
  const sent: Array<Record<string, any>> = [];
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  return {
    readyState: 1, sent,
    send(data: string) { sent.push(JSON.parse(data)); },
    on(event: string, cb: (arg: unknown) => void) { (listeners[event] ||= []).push(cb); },
    once(event: string, cb: (arg: unknown) => void) { (listeners[event] ||= []).push(cb); },
    emit(event: string, arg: unknown) { (listeners[event] || []).forEach(cb => cb(arg)); },
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
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
    getActiveAntigravitySessions: () => [],
    getActiveOpenCodeSessions: () => [],
    getActiveHermesSessions: () => [],
    getActiveKimiSessions: () => [],
    getActiveDeepSeekSessions: () => [],
    getActiveGlmSessions: () => [],
    acquireWriterLease: async () => ({ release: () => {} }),
    ...overrides,
  };
  return deps as unknown as Parameters<typeof handleChatConnection>[2];
}

function connect(userId: number, overrides: Record<string, unknown> = {}) {
  const ws = makeFakeWs();
  handleChatConnection(ws as never, { user: { id: userId, role: 'user', authenticationKind: 'session',
    authorizationGeneration: 1 } } as never, makeDeps(overrides));
  return ws;
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
let findRunCalls = 0;
let armedRun = true;
let run: ReturnType<typeof steer.createSteerRun>;
const events: Array<Record<string, unknown>> = [];

beforeEach(() => {
  inserts.length = 0; audits.length = 0; events.length = 0; findRunCalls = 0;
  policyValue = null; starterConsents = true; armedRun = true;
  run = steer.createSteerRun({
    sessionId: () => SID, turnId: TURN, starterUserId: STARTER, permissionMode: () => 'bypassPermissions',
    injectionArmed: () => true, taintHookArmed: () => true, broadcast: (e) => { events.push(e as never); }, persistStatus: () => {},
    confirmDelivery: async () => true,
  });
  steer.registerMidTurnInjection('claude', {
    findRun: () => { findRunCalls++; return armedRun ? run : null; },
    payloadHash: () => 'f'.repeat(64),
  });
});

const steerMsg = (extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'session-steer', sessionId: SID, turnId: TURN, clientMsgId: `m-${Math.random().toString(36).slice(2)}`,
  text: 'please use tabs', ...extra,
});

test('sender identity is the JWT principal; payload identity fields are ignored', async () => {
  const ws = connect(WRITER);
  ws.emit('message', steerMsg({ userId: STARTER, senderUserId: STARTER, user: { id: STARTER } }));
  await flush();
  const result = ws.sent.find(m => m.type === 'session-steer-result');
  assert.deepEqual([result?.ok, result?.status], [true, 202], JSON.stringify(result));
  assert.equal(inserts[0].userId, WRITER, 'the row is bound to the authenticated sender');
  assert.equal(audits[0].userId, WRITER);
  assert.equal((events[0] as { sender: { userId: number } }).sender.userId, WRITER);
});

test('the starter steers his own turn as himself: payload identity cannot pose as another member', async () => {
  starterConsents = false;
  const ws = connect(STARTER);
  ws.emit('message', steerMsg({ userId: WRITER, senderUserId: WRITER }));
  await flush();
  const result = ws.sent.find(m => m.type === 'session-steer-result');
  assert.deepEqual([result?.ok, result?.status], [true, 202], JSON.stringify(result));
  assert.equal(inserts[0].userId, STARTER, 'bound to the JWT principal, never the payload');
  assert.equal(run.isTainted(), false, 'a self-steer never taints the turn');
});

test('a non-writer is refused not_writable before any run lookup or disclosure', async () => {
  const ws = connect(READER);
  ws.emit('message', steerMsg());
  await flush();
  const result = ws.sent.find(m => m.type === 'session-steer-result');
  assert.deepEqual([result?.code, result?.status], ['not_writable', 403]);
  assert.equal(findRunCalls, 0, 'the run registry was never consulted');
  assert.equal(inserts.length + audits.length + events.length, 0);
  assert.ok(!ws.sent.some(m => m.type === 'steer-turn-state' || m.type === 'steer-queued'));
});

test('an unknown session answers exactly like a forbidden one', async () => {
  const ws = connect(READER);
  ws.emit('message', steerMsg({ sessionId: 'no-such-session' }));
  await flush();
  assert.equal(ws.sent.find(m => m.type === 'session-steer-result')?.code, 'not_writable');
  assert.equal(findRunCalls, 0);
});

const live = (provider: 'claude' | 'codex') => ({
  isClaudeSDKSessionActive: (id: string) => provider === 'claude' && id === SID,
  isCodexSessionActive: (id: string) => provider === 'codex' && id === 'sess-codex',
  isPrimarySocketAlive: () => true,
  getProviderRunWriter: () => ({ userId: STARTER }),
});

async function join(userId: number, sessionId: string, provider: 'claude' | 'codex') {
  const ws = connect(userId, live(provider));
  ws.emit('message', JSON.stringify({ type: 'check-session-status', sessionId, provider }));
  await flush();
  return ws.sent.filter(m => m.type === 'steer-turn-state');
}

test('late joiner during the first turn learns the starter; steerable is computed per viewer', async () => {
  const [writer] = await join(WRITER, SID, 'claude');
  assert.deepEqual([writer.starterUserId, writer.forViewerUserId, writer.steerable, writer.turnId, writer.capability],
    [STARTER, WRITER, true, TURN, { midTurnInjection: true }]);
  const [reader] = await join(READER, SID, 'claude');
  assert.deepEqual([reader.starterUserId, reader.steerable], [STARTER, false], 'no write access → not steerable');
  const [starter] = await join(STARTER, SID, 'claude');
  assert.deepEqual([starter.starterUserId, starter.forViewerUserId, starter.steerable, starter.starterSteerable],
    [STARTER, STARTER, true, true], 'the starter sees himself as starter and may steer his own turn');
  starterConsents = false;
  const [noConsent] = await join(WRITER, SID, 'claude');
  assert.deepEqual([noConsent.steerable, noConsent.starterSteerable], [false, true], 'starter consent off: others only');
  assert.equal((await join(STARTER, SID, 'claude'))[0].steerable, true, 'consent never gates the starter');
  starterConsents = true; policyValue = '{"mode":"off"}';
  assert.equal((await join(WRITER, SID, 'claude'))[0].steerable, false, 'global policy off');
  const [starterOff] = await join(STARTER, SID, 'claude');
  assert.deepEqual([starterOff.steerable, starterOff.starterSteerable], [false, false], 'policy off gates the starter too');
});

test('every provider run announces its starter; non-steerable runs say so', async () => {
  const [codex] = await join(WRITER, 'sess-codex', 'codex');
  assert.deepEqual([codex.starterUserId, codex.steerable, codex.turnId, codex.capability],
    [STARTER, false, null, { midTurnInjection: false }]);
  armedRun = false;
  const [unarmed] = await join(WRITER, SID, 'claude');
  assert.deepEqual([unarmed.starterUserId, unarmed.steerable, unarmed.turnId], [STARTER, false, null],
    'an unarmed Claude first turn still names its starter from the run registry');
});

test('no frame for an idle session', async () => {
  const ws = connect(WRITER, { isClaudeSDKSessionActive: () => false });
  ws.emit('message', JSON.stringify({ type: 'check-session-status', sessionId: SID, provider: 'claude' }));
  await flush();
  assert.equal(ws.sent.filter(m => m.type === 'steer-turn-state').length, 0);
});
