/**
 * chat-websocket.turn-scoped-control.acceptance.test.ts — T-2093
 * (ADR-TURN-SCOPED-CONTROL), acceptance in the owner's terms:
 *
 *   "Stop and approve/deny are safe against double-press, reconnect resend and
 *    races: a stop never kills a newer turn than the one the user saw, and a
 *    needed stop is never refused."
 *
 * Drives the REAL `handleChatConnection` (turn launch AND stop go through the
 * same socket handler) with the database, the workspace binder and the writer
 * class module-mocked. Provider runs are fakes that behave like the real
 * launchers (a second run on a busy session is refused with `session_busy`, a
 * run blocks until its abort bridge fires) and stream run frames produced by the
 * REAL Claude normalizer over the recorded SDK capture
 * `claude-progress-sdk-stream.real.json` (Claude Code 2.1.289) — not invented
 * shapes.
 *
 * Runner: node:test with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { mock } from 'node:test';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';
import { chatImageStoreDatabaseLinkStubs } from '../../../../tests/helpers/chat-image-store-link-stubs.js';

import { authorizeTestProviderExecution, createPermissionTestWorkspaceModule } from './chat-websocket.permission-test-helper.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = process.cwd();
const MEMBER_A = 1;
const MEMBER_B = 2;
const OUTSIDER = 3;
const WRITERS = new Set([MEMBER_A, MEMBER_B]);
const SESSIONS = new Map<string, { session_id: string; provider: string; project_path: string }>();

// The real exports (the runner's per-case DATABASE_PATH) back every unstubbed name.
const realDatabase = await import('@/modules/database/index.js');
mock.module('@/modules/database/index.js', {
  namedExports: {
    ...realDatabase,
    ...reviewEnvelopeDatabaseLinkStubs(),
    ...chatImageStoreDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: () => ({ project_id: 'shared-project' }),
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: (_projectId: string, userId: number) => WRITERS.has(userId),
      getVisibleProjectPaths: () => [],
    },
    sessionsDb: { getSessionById: (id: string) => SESSIONS.get(id) ?? null },
    sessionWorkspaceModesDb: { markOverlay: () => undefined, readLegacyEligibility: () => null },
    participantsDb: { isParticipant: () => false, hasSpawnConsent: () => false },
    sessionOutcomesDb: {},
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
mock.module('@/modules/websocket/services/websocket-writer.service.js', {
  namedExports: {
    setSocketViewMirror: () => undefined,
    WebSocketWriter: class {
      ws: { readyState?: number; send?: (data: string) => void } | null;
      sessionId: string | null = null;
      userId: unknown;
      constructor(ws: { readyState?: number; send?: (data: string) => void } | null, userId: unknown = null) {
        this.ws = ws;
        this.userId = userId;
      }
      send(data: unknown): void {
        if (this.ws?.readyState === 1) this.ws.send?.(JSON.stringify(data));
      }
      setSessionId(id: string): void { this.sessionId = id; }
      getSessionId(): string | null { return this.sessionId; }
      updateWebSocket(ws: { readyState?: number; send?: (data: string) => void } | null): void { this.ws = ws; }
      isPrimarySocketAlive(): boolean { return this.ws?.readyState === 1; }
    },
  },
});

// eslint-disable-next-line boundaries/dependencies -- test-only: the real Claude normalizer turns the recorded SDK capture into run frames; the barrel does not export it.
const { ClaudeSessionsProvider } = await import('@/modules/providers/list/claude/claude-sessions.provider.js');
const { handleChatConnection, withTurnKey } = await import('./chat-websocket.service.js');
const { activeTurnRegistry, ActiveTurnRegistry } = await import('./active-turn-registry.js');
const { requestParityPermission, resolveParityPermission } = await import(
  '@/services/permission-parity/parity-permissions.js'
);
// eslint-disable-next-line boundaries/dependencies -- test-only: the real dsh question entry point (ADR-226).
const { requestDshPermission } = await import('@/modules/providers/list/dsh/dsh-permissions.js');
const { controlCommandLru, ControlCommandLru } = await import('./control-command-lru.js');

type Frame = Record<string, any>;

/** Run frames of a recorded live Claude run, normalized by the real adapter. */
function recordedRunFrames(): Frame[] {
  const capture = JSON.parse(readFileSync(path.join(
    HERE, '../../providers/list/claude/__tests__/__fixtures__/claude-progress-sdk-stream.real.json',
  ), 'utf8')) as { events: Array<Record<string, unknown>> };
  const provider = new ClaudeSessionsProvider();
  return capture.events.flatMap((event) => provider.normalizeMessage(event, 'recorded')) as Frame[];
}
const RECORDED = recordedRunFrames();
assert.ok(RECORDED.some((frame) => frame.kind === 'text' && frame.role === 'assistant'));

// ---- fake provider launchers: refuse a busy session, block until aborted ----
const runs = new Map<string, { clientMsgId: string; stop(): void }>();
const bridgeCalls: Array<{ provider: string; sessionId: string; key?: string | null }> = [];

function launch(provider: string) {
  return (_command: string, options: Record<string, any>, runWriter: { send(frame: unknown): void }) => {
    const resumed = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : null;
    const sessionId = resumed ?? `${provider}-session-${options.clientMsgId}`;
    if (runs.has(sessionId)) {
      runWriter.send({ kind: 'error', code: 'session_busy', sessionId, provider, content: 'busy' });
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      runs.set(sessionId, { clientMsgId: options.clientMsgId, stop: () => { runs.delete(sessionId); resolve(); } });
      SESSIONS.set(sessionId, { session_id: sessionId, provider, project_path: PROJECT });
      if (!resumed) runWriter.send({ kind: 'session_created', sessionId, newSessionId: sessionId, provider });
      for (const frame of RECORDED) runWriter.send({ ...frame, sessionId, provider });
    });
  };
}

function stopRun(provider: string, sessionId: string, key?: string | null): boolean {
  bridgeCalls.push({ provider, sessionId, ...(key === undefined ? {} : { key }) });
  const run = runs.get(sessionId);
  if (!run) return false;
  run.stop();
  return true;
}

// The bridges main ships (kimi/deepseek/qwen were retired as bodies; dsh joined, ADR-224).
const SYNC_BRIDGES = ['cursor', 'codex', 'antigravity', 'opencode', 'glm', 'dsh'] as const;
const BRIDGE_DEPENDENCY: Record<(typeof SYNC_BRIDGES)[number], string> = {
  cursor: 'abortCursorSession', codex: 'abortCodexSession', antigravity: 'abortAntigravitySession',
  opencode: 'abortOpenCodeSession', glm: 'abortGlmSession', dsh: 'abortDshSession',
};

function dependencies(): Record<string, unknown> {
  const bridges = Object.fromEntries(SYNC_BRIDGES.map((provider) => [
    BRIDGE_DEPENDENCY[provider], (sessionId: string) => stopRun(provider, sessionId),
  ]));
  return {
    authorizeProviderExecution: authorizeTestProviderExecution,
    // Main's credential gate (fail closed when unwired): the starter's own account.
    admitCredentialTurn: (input: { actor: unknown }) => ({ principalId: input.actor, grantedBy: null }),
    queryClaudeSDK: launch('claude'),
    queryCodex: launch('codex'),
    spawnCursor: launch('cursor'), spawnAntigravity: launch('antigravity'),
    spawnGlm: launch('glm'), spawnOpenCode: launch('opencode'),
    getSessionProvider: (id: string) => SESSIONS.get(id)?.provider ?? null,
    getActiveClaudeSDKSessions: () => [],
    abortClaudeSDKSession: async (sessionId: string, _ws: unknown, key: string | null) => {
      const aborted = stopRun('claude', sessionId, key ?? null);
      return { aborted, reason: aborted ? 'interrupted' : 'no run', sessionId: aborted ? sessionId : null };
    },
    // Like claude-sdk: the first answer resolves the pending prompt, any later one finds none.
    resolveToolApproval: (requestId: string) => {
      if (requestId !== 'req-open' || approvals.has(requestId)) return { resolved: false, sessionId: null };
      approvals.add(requestId);
      return { resolved: true, sessionId: 'approval-session' };
    },
    // ADR-226: the real dsh/OpenCode question broker, as server/index.js wires it.
    resolveParityPermission,
    ...bridges,
  };
}
const approvals = new Set<string>();

function connect(userId: number, overrides: Record<string, unknown> = {}) {
  const frames: Frame[] = [];
  let onMessage: (raw: unknown) => Promise<void> = async () => {};
  const socket = {
    readyState: 1,
    send: (raw: string) => frames.push(JSON.parse(raw)),
    on: (event: string, callback: typeof onMessage) => { if (event === 'message') onMessage = callback; },
    close: () => undefined,
  };
  const principal = { id: userId, role: 'user', authenticationKind: 'session', authorizationGeneration: 1 };
  handleChatConnection(socket as never, { user: principal } as never, { ...dependencies(), ...overrides } as never);
  return {
    frames,
    /** Delivers one frame; a turn launch resolves only when that turn ends. */
    send: (message: Frame) => onMessage(JSON.stringify(message)),
    receipts: () => frames.filter((frame) => frame.type === 'control-command-receipt'),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function reset(): void {
  runs.clear();
  bridgeCalls.length = 0;
  SESSIONS.clear();
  approvals.clear();
  activeTurnRegistry.clear();
  controlCommandLru.clear();
}

/** Starts a turn through the socket and waits until its run frames arrived. */
async function startTurn(
  client: ReturnType<typeof connect>, provider: string, clientMsgId: string, sessionId?: string,
): Promise<{ sessionId: string; turnKey: string | undefined; done: Promise<void> }> {
  const type = provider === 'claude' ? 'claude-command' : `${provider}-command`;
  const done = client.send({
    type, command: 'go', options: { cwd: PROJECT, clientMsgId, ...(sessionId ? { sessionId } : {}) },
  });
  await settle();
  const runFrame = client.frames.findLast((frame) => frame.kind === 'text' && frame.role === 'assistant');
  assert.ok(runFrame, `the ${provider} turn streamed its recorded frames`);
  return { sessionId: runFrame.sessionId, turnKey: runFrame.turnKey, done };
}

test('baseline (old client): a stop without commandId keeps the exact legacy frames', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const turn = await startTurn(a, 'codex', 'turn-1');
  await a.send({ type: 'abort-session', sessionId: turn.sessionId, provider: 'codex' });
  await turn.done;
  const reply = a.frames.at(-1)!;
  assert.equal(reply.kind, 'complete');
  assert.equal(reply.aborted, true);
  assert.equal(reply.success, true);
  assert.equal(a.receipts().length, 0, 'an old client never receives the new frame');
});

test('every run frame carries the turnKey of the message that started the turn', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const turn = await startTurn(a, 'claude', 'turn-key-1');
  const runFrames = a.frames.filter((frame) => frame.sessionId === turn.sessionId && frame.kind !== 'complete');
  assert.ok(runFrames.length >= RECORDED.length);
  assert.ok(runFrames.every((frame) => frame.turnKey === 'turn-key-1'));
  await a.send({ type: 'abort-session', sessionId: turn.sessionId, provider: 'claude' });
  await turn.done;
});

test('double stop and resend after reconnect with one commandId: bridge once, then duplicate', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const turn = await startTurn(a, 'codex', 'turn-1');
  const stop = { type: 'abort-session', sessionId: turn.sessionId, provider: 'codex', commandId: 'stop-1', targetTurnKey: turn.turnKey };
  await a.send(stop);
  await a.send(stop);
  await turn.done;
  const reconnected = connect(MEMBER_A);
  await reconnected.send(stop);
  assert.equal(bridgeCalls.length, 1);
  assert.deepEqual(a.receipts().map((r) => [r.status, r.duplicate]), [['stopped', false], ['stopped', true]]);
  assert.deepEqual(reconnected.receipts().map((r) => [r.status, r.duplicate]), [['stopped', true]]);
  assert.equal(reconnected.receipts()[0].commandId, 'stop-1');
});

test('a late stop after a new turn began is stale_target and the new turn survives', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const first = await startTurn(a, 'codex', 'turn-1');
  await a.send({ type: 'abort-session', sessionId: first.sessionId, provider: 'codex' });
  await first.done;
  const second = await startTurn(a, 'codex', 'turn-2', first.sessionId);
  assert.equal(second.turnKey, 'turn-2');
  bridgeCalls.length = 0;
  await a.send({
    type: 'abort-session', sessionId: first.sessionId, provider: 'codex', commandId: 'late', targetTurnKey: 'turn-1',
  });
  assert.equal(bridgeCalls.length, 0, 'nothing was killed');
  assert.ok(runs.has(first.sessionId), 'the newer turn is still running');
  assert.equal(a.receipts().at(-1)?.status, 'stale_target');
  stopRun('codex', first.sessionId);
  await second.done;
});

test('member B stops member A\'s turn in a shared session with the key from the run frame', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const b = connect(MEMBER_B);
  for (const provider of ['claude', 'codex']) {
    const turn = await startTurn(a, provider, `a-${provider}`);
    await b.send({
      type: 'abort-session', sessionId: turn.sessionId, provider, commandId: `b-${provider}`, targetTurnKey: turn.turnKey,
    });
    await turn.done;
    assert.equal(b.receipts().at(-1)?.status, 'stopped');
  }
});

test('ADR-173 P5: a turn-scoped stop keeps the Claude stop right and its stoppedBy attribution', { timeout: 5000 }, async () => {
  reset();
  let allowed = false;
  const stopRight = {
    authorizeClaudeTurnStop: () => ({ allowed, role: allowed ? 'stuck' : null, stuck: allowed, starterUserId: MEMBER_A }),
  };
  const a = connect(MEMBER_A);
  const b = connect(MEMBER_B, stopRight);
  const turn = await startTurn(a, 'claude', 'a-turn');
  const stop = { type: 'abort-session', sessionId: turn.sessionId, provider: 'claude', commandId: 'b-stop', targetTurnKey: 'a-turn' };
  await b.send(stop);
  assert.equal(bridgeCalls.length, 0, 'a foreign stop of a running (not stuck) turn is refused');
  assert.equal(b.frames.find((frame) => frame.code === 'turn_stop_forbidden')?.kind, 'complete');
  assert.equal(b.receipts().at(-1)?.status, 'refused');
  allowed = true;
  await b.send(stop);
  await turn.done;
  assert.equal(b.receipts().at(-1)?.status, 'stopped', 'a refusal is never stored: the same id retries');
  assert.equal(b.frames.findLast((frame) => frame.kind === 'complete')?.stoppedBy?.userId, MEMBER_B);
});

test('an outsider stop is refused before the LRU and never reaches the bridge', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const outsider = connect(OUTSIDER);
  const turn = await startTurn(a, 'codex', 'turn-1');
  const stop = { type: 'abort-session', sessionId: turn.sessionId, provider: 'codex', commandId: 'x', targetTurnKey: turn.turnKey };
  await outsider.send(stop);
  assert.equal(bridgeCalls.length, 0);
  assert.equal(outsider.receipts()[0].status, 'refused');
  await a.send(stop);
  await turn.done;
  assert.equal(a.receipts()[0].status, 'stopped', 'the owner\'s same commandId is independent');
});

test('a steered turn keeps its turnKey: the starter\'s key still stops it', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const turn = await startTurn(a, 'claude', 'starter');
  // A steer never starts a turn: a session-steer is not a provider command.
  await a.send({ type: 'session-steer', sessionId: turn.sessionId, clientMsgId: 'steer-1', text: 'also do x' });
  assert.equal(activeTurnRegistry.get(turn.sessionId)?.turnKey, 'starter');
  await a.send({
    type: 'abort-session', sessionId: turn.sessionId, provider: 'claude', commandId: 'c', targetTurnKey: 'starter',
  });
  await turn.done;
  assert.equal(a.receipts().at(-1)?.status, 'stopped');
});

test('condition 1: a session_busy send does not overwrite or delete the running entry', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const b = connect(MEMBER_B);
  const turn = await startTurn(a, 'codex', 'running');
  await b.send({ type: 'codex-command', command: 'me too', options: { cwd: PROJECT, clientMsgId: 'busy', sessionId: turn.sessionId } });
  assert.ok(b.frames.some((frame) => frame.code === 'session_busy'));
  assert.equal(activeTurnRegistry.get(turn.sessionId)?.turnKey, 'running');
  await a.send({
    type: 'abort-session', sessionId: turn.sessionId, provider: 'codex', commandId: 'c', targetTurnKey: 'running',
  });
  await turn.done;
  assert.equal(a.receipts().at(-1)?.status, 'stopped');
});

test('condition 1: a resumed send registers only once the provider accepted it', { timeout: 5000 }, () => {
  const registry = new ActiveTurnRegistry();
  const sent: Frame[] = [];
  const connection = { send: (frame: Frame) => sent.push(frame) };
  const turn = withTurnKey(connection as never, {
    type: 'codex-command', command: 'x', options: { clientMsgId: 'k-busy', sessionId: 's-busy' },
  } as never, MEMBER_A, registry);
  assert.equal(registry.size(), 0, 'no entry before the provider answered');
  turn.writer.send({ kind: 'error', code: 'session_busy', sessionId: 's-busy' });
  assert.equal(registry.size(), 0, 'a refused send never holds an entry, not even briefly');
  assert.equal(sent[0].turnKey, 'k-busy', 'the refusal still carries its own turnKey');
  const accepted = withTurnKey(connection as never, {
    type: 'codex-command', command: 'x', options: { clientMsgId: 'k-run', sessionId: 's-busy' },
  } as never, MEMBER_A, registry);
  accepted.writer.send({ ...RECORDED[0], sessionId: 's-busy' });
  assert.equal(registry.get('s-busy')?.turnKey, 'k-run');
  accepted.writer.send({ kind: 'complete', sessionId: 's-busy', success: true });
  assert.equal(registry.size(), 0, 'the turn\'s own complete releases it');
  accepted.writer.send({ ...RECORDED[0], sessionId: 's-busy' });
  assert.equal(registry.size(), 0, 'a frame after the end never re-registers');
  turn.release();
  accepted.release();
});

test('condition 2: no registry entry runs the legacy stop; nothing running is a final reply', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const turn = await startTurn(a, 'codex', 'turn-1');
  activeTurnRegistry.clear(); // e.g. a run the registry never saw (/api/agent)
  await a.send({
    type: 'abort-session', sessionId: turn.sessionId, provider: 'codex', commandId: 'c1', targetTurnKey: 'turn-1',
  });
  await turn.done;
  assert.equal(a.receipts().at(-1)?.status, 'stopped', 'a needed stop is never refused');
  await a.send({
    type: 'abort-session', sessionId: turn.sessionId, provider: 'codex', commandId: 'c2', targetTurnKey: 'turn-1',
  });
  assert.equal(a.receipts().at(-1)?.status, 'not_running');
  assert.equal(a.frames.at(-2)?.kind, 'complete', 'the legacy complete clears every viewer\'s spinner');
});

test('restart then stop with an old key: nothing is killed and the spinner is cleared', { timeout: 5000 }, async () => {
  reset();
  SESSIONS.set('old-session', { session_id: 'old-session', provider: 'claude', project_path: PROJECT });
  const a = connect(MEMBER_A);
  await a.send({
    type: 'abort-session', sessionId: 'old-session', provider: 'claude', commandId: 'after-restart', targetTurnKey: 'gone',
  });
  assert.equal(runs.size, 0);
  assert.equal(a.receipts()[0].status, 'not_running');
  assert.equal(a.receipts()[0].duplicate, false);
});

test('a new turn registering between receive and abort (microtask race) is stale_target', { timeout: 5000 }, async () => {
  reset();
  // Production awaits the update-writer lease between receive and abort; this
  // cache yields once at the same point, so the stop is received (parsed and
  // write-checked) before the injected microtask and aborted after it.
  class YieldingLru extends ControlCommandLru<unknown> {
    override async run(...args: Parameters<ControlCommandLru<unknown>['run']>) {
      await Promise.resolve();
      return super.run(...args);
    }
  }
  const a = connect(MEMBER_A, { controlCommandLru: new YieldingLru() });
  const first = await startTurn(a, 'codex', 'turn-1');
  queueMicrotask(() => {
    activeTurnRegistry.release(first.sessionId, 'turn-1');
    activeTurnRegistry.register({ sessionId: first.sessionId, turnKey: 'turn-2', starterUserId: MEMBER_B, writer: null });
  });
  await a.send({
    type: 'abort-session', sessionId: first.sessionId, provider: 'codex', commandId: 'c', targetTurnKey: 'turn-1',
  });
  assert.equal(bridgeCalls.length, 0);
  assert.equal(a.receipts().at(-1)?.status, 'stale_target');
  stopRun('codex', first.sessionId);
  await first.done;
});

test('claude empty id with a pending send id targets that turn on this connection', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const turn = await startTurn(a, 'claude', 'pending-send');
  await a.send({ type: 'abort-session', sessionId: '', provider: 'claude', commandId: 'c', targetTurnKey: 'pending-send' });
  await turn.done;
  assert.deepEqual(bridgeCalls, [{ provider: 'claude', sessionId: turn.sessionId, key: 'pending-send' }]);
});

test('legacy client per bridge: all seven providers stop exactly as before, no receipt', { timeout: 5000 }, async () => {
  // glm chat launches are globally disabled (T-864) and the cursor/dsh launcher
  // contracts differ, so each run is seeded in the provider's own map
  // (like a run that predates this connection); the stop path is the real one.
  for (const provider of ['claude', ...SYNC_BRIDGES]) {
    reset();
    const sessionId = `${provider}-legacy`;
    SESSIONS.set(sessionId, { session_id: sessionId, provider, project_path: PROJECT });
    let stopped = false;
    runs.set(sessionId, { clientMsgId: 'seeded', stop: () => { stopped = true; runs.delete(sessionId); } });
    const a = connect(MEMBER_A);
    await a.send({ type: 'abort-session', sessionId, provider });
    assert.deepEqual(bridgeCalls.map((call) => call.provider), [provider]);
    assert.equal(stopped, true, provider);
    assert.equal(a.frames.at(-1)?.success, true, provider);
    assert.equal(a.frames.at(-1)?.provider, provider);
    assert.equal(a.receipts().length, 0, provider);
  }
});

test('new client per bridge: all seven providers stop through the bridge table with a receipt', { timeout: 5000 }, async () => {
  for (const provider of ['claude', ...SYNC_BRIDGES]) {
    reset();
    const sessionId = `${provider}-new-client`;
    SESSIONS.set(sessionId, { session_id: sessionId, provider, project_path: PROJECT });
    runs.set(sessionId, { clientMsgId: 'seeded', stop: () => { runs.delete(sessionId); } });
    const a = connect(MEMBER_A);
    await a.send({ type: 'abort-session', sessionId, provider, commandId: `c-${provider}`, targetTurnKey: 'seeded' });
    assert.deepEqual(bridgeCalls.map((call) => call.provider), [provider]);
    assert.deepEqual(a.receipts().map((r) => r.status), ['stopped'], provider);
  }
});

test('approval: duplicate press replays to the sender only; a second answer is already_resolved', { timeout: 5000 }, async () => {
  reset();
  const a = connect(MEMBER_A);
  const b = connect(MEMBER_B);
  const answer = { type: 'claude-permission-response', requestId: 'req-open', allow: true, commandId: 'ap-1' };
  await a.send(answer);
  await a.send(answer);
  await b.send({ ...answer, allow: false, commandId: 'ap-b' });
  await a.send({ ...answer, allow: false });
  assert.deepEqual(a.receipts().map((r) => [r.status, r.duplicate]),
    [['applied', false], ['applied', true], ['command_id_reused', false]]);
  assert.deepEqual(b.receipts().map((r) => r.status), ['already_resolved']);
  assert.deepEqual(b.receipts()[0].result, { requestId: 'req-open' });
  await a.send({ type: 'claude-permission-response', requestId: 'req-open', allow: true });
  assert.equal(a.receipts().length, 3, 'a legacy approval (no commandId) gets no receipt');
});

test('review item 2: an empty-id dsh stop passes its key and a stale verdict kills nothing', { timeout: 5000 },
  async () => {
    reset();
    const seen: unknown[] = [];
    const a = connect(MEMBER_A, {
      abortDshSession: (sessionId: string, _ws: unknown, key: unknown) => {
        seen.push([sessionId, key]);
        return { aborted: false, staleTarget: true };
      },
    });
    await a.send({ type: 'abort-session', sessionId: '', provider: 'dsh', commandId: 'd-1', targetTurnKey: 'turn-a' });
    assert.deepEqual(seen, [['', 'turn-a']]);
    assert.equal(a.receipts().at(-1)?.status, 'stale_target');
  });

/** Opens one real ADR-226 question and returns its requestId and settlement promise. */
function openParityQuestion(provider: 'dsh' | 'opencode', ownerUserId: number) {
  const cards: Frame[] = [];
  const questionWriter = { send: (frame: Frame) => cards.push(frame) };
  const ask = {
    runId: `run-${provider}`, ownerUserId, sessionId: `${provider}-s`, toolName: 'Bash', input: {},
    writer: questionWriter, timeoutMs: 4_000,
  };
  const settled: Promise<unknown> = provider === 'dsh'
    ? requestDshPermission(ask as never)
    : requestParityPermission({ ...ask, provider: 'opencode' } as never);
  return { requestId: cards[0].requestId as string, settled };
}

for (const provider of ['dsh', 'opencode'] as const) {
  test(`ADR-226: a ${provider} approval with commandId resolves once; a resend is duplicate`,
    { timeout: 5000 }, async () => {
      reset();
      const a = connect(MEMBER_A);
      const question = openParityQuestion(provider, MEMBER_A);
      const answer = { type: 'claude-permission-response', requestId: question.requestId, allow: true, commandId: 'p-1' };
      await a.send(answer);
      await a.send(answer);
      assert.notEqual(await question.settled, 'timeout', `the ${provider} question settled on the answer`);
      assert.deepEqual(a.receipts().map((r) => [r.status, r.duplicate]), [['applied', false], ['applied', true]]);
    });

  test(`ADR-226: a legacy ${provider} approval (no commandId) still resolves, no receipt`,
    { timeout: 5000 }, async () => {
      reset();
      const a = connect(MEMBER_A);
      const question = openParityQuestion(provider, MEMBER_A);
      await a.send({ type: 'claude-permission-response', requestId: question.requestId, allow: true });
      assert.notEqual(await question.settled, 'timeout');
      assert.equal(a.receipts().length, 0);
    });
}
