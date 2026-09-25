/* eslint-disable boundaries/dependencies -- dispatch is proven against the real registry, DB and monitor. */
/**
 * T-1854 / ADR-172 amendment — the run fence inside the REAL dispatch path.
 *
 * Real database, real fenced-run registry, real WebSocketWriter and the real
 * session-process monitor; only provider launchers and the workspace binder are
 * spies. Proves: every launch branch is armed (C2), revocation between
 * admission and hand-off never launches (I4), claude/codex are aborted once
 * their session id appears (test 14), the fence is the outermost wrapper
 * (test 17), deterministic release (qa M4), empty cwd never launches (M6),
 * flag-off parity (I6), /btw revocation (qa M7) and the POST /api/agent
 * secondary coverage through stopLaunchedTurns (qa H2).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, mock } from 'node:test';

import type { UniversalConversationShadowHook } from '@/modules/conversations/index.js';
import type { WebSocketWriter as WebSocketWriterType } from '@/modules/websocket/services/websocket-writer.service.js';

const binds: string[] = [];
const realWorkspaces = await import('@/modules/session-workspaces/index.js');
const resolveWorkspace = (input: { projectPath: string }) => ({
  cwd: input.projectPath,
  logicalProjectPath: input.projectPath,
  isolation: 'overlay' as const,
  generation: 'run-fence-test',
});
mock.module('@/modules/session-workspaces/index.js', {
  namedExports: {
    ...realWorkspaces,
    resolveSessionWorkspaceForLaunch: resolveWorkspace,
    bindSessionWorkspace: (input: { projectPath: string; sessionId: string }) => {
      binds.push(input.sessionId);
      return resolveWorkspace(input);
    },
  },
});

const {
  closeConnection,
  initializeDatabase,
  projectMembersDb,
  projectsDb,
  sessionsDb,
  userDb,
} = await import('@/modules/database/index.js');
const {
  __fencedRunCountForTests,
  __resetProjectFenceStateForTests,
} = await import('@/modules/database/repositories/project-access.js');
const { WebSocketWriter } = await import('@/modules/websocket/services/websocket-writer.service.js');
const { dispatchProviderCommand, handleChatConnection, abortSessionTurn, __resetBtwFloodStateForTests } =
  await import('@/modules/websocket/services/chat-websocket.service.js');
const { revokeProjectLiveAccess } = await import(
  '@/modules/websocket/services/project-membership-revocation.service.js'
);
// eslint-disable-next-line boundaries/no-unknown -- the real process monitor is the ownership registry under test.
const monitor = await import('../../../services/session-process-monitor.js');

type User = { id: number; role: string };
type Frame = Record<string, unknown>;

let creator: User;
let member: User;
let projectId = '';
let projectPath = '';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function socket(userId: number) {
  const received: Frame[] = [];
  return { readyState: 1, userId, received, send: (frame: string) => { received.push(JSON.parse(frame)); } };
}

const authorized = () => ({
  kind: 'authorized' as const,
  execution: {
    decisionId: 'rf-decision', leaseId: 'rf-lease', mode: 'legacy' as const,
    consume: () => ({}), markStarted: () => undefined, settle: () => undefined, notStarted: () => undefined,
  },
});

/** Removes the member at the exact admission point: right after arming, before hand-off. */
const revokingAuthorizer = () => {
  projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
  return authorized();
};

async function dispatch(
  messageType: string,
  options: Record<string, unknown>,
  dependencies: Record<string, unknown>,
  user: User = member,
) {
  const primary = socket(user.id);
  const writer = new WebSocketWriter(primary as never, user.id);
  await dispatchProviderCommand(
    messageType,
    { type: messageType, command: 'hello', options: { cwd: projectPath, ...options } } as never,
    writer,
    { getSessionProvider: () => null, authorizeProviderExecution: authorized, ...dependencies } as never,
    user.id,
    Object.freeze({ id: user.id, role: user.role, authenticationKind: 'session', authorizationGeneration: 1 }),
  );
  await tick();
  return primary;
}

before(async () => {
  closeConnection();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1854-dispatch-'));
  process.env.WORKSPACES_ROOT = root;
  await initializeDatabase();
  creator = userDb.createUser('rfd_creator', 'hash', 'user') as User;
  member = userDb.createUser('rfd_member', 'hash', 'user') as User;
  projectPath = fs.mkdtempSync(path.join(root, 'proj-'));
  projectId = projectsDb.createProjectPath(projectPath, 'RunFenceDispatch', creator.id).project?.project_id ?? '';
});

beforeEach(() => {
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  __resetProjectFenceStateForTests();
  __resetBtwFloodStateForTests();
  projectMembersDb.addAndRotateProjectAccess(projectId, member.id, 'member', creator.id);
  binds.length = 0;
});

after(() => {
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  delete process.env.NASSAJ_OPENCODE_CARRIER;
  delete process.env.WORKSPACES_ROOT;
  closeConnection();
});

type Branch = {
  name: string;
  messageType: string;
  options?: Record<string, unknown>;
  env?: Record<string, string>;
  launcher: (launches: string[]) => Record<string, unknown>;
};

const launcher = (key: string) => (launches: string[]) => ({
  [key]: async () => { launches.push(key); },
});

const BRANCHES: Branch[] = [
  { name: 'claude', messageType: 'claude-command', launcher: launcher('queryClaudeSDK') },
  { name: 'codex', messageType: 'codex-command', launcher: launcher('queryCodex') },
  { name: 'cursor', messageType: 'cursor-command', launcher: launcher('spawnCursor') },
  { name: 'antigravity', messageType: 'antigravity-command', launcher: launcher('spawnAntigravity') },
  { name: 'hermes', messageType: 'hermes-command', launcher: launcher('spawnHermes') },
  { name: 'opencode', messageType: 'opencode-command', launcher: launcher('spawnOpenCode') },
  { name: 'kimi', messageType: 'kimi-command', launcher: launcher('spawnKimi') },
  {
    name: 'kimi-agent', messageType: 'kimi-command', options: { mode: 'agent' },
    launcher: launcher('spawnKimiAgent'),
  },
  {
    name: 'glm-carrier', messageType: 'glm-command', options: { mode: 'agent' },
    env: { NASSAJ_OPENCODE_CARRIER: '1' }, launcher: launcher('spawnOpenCode'),
  },
  { name: 'qwen', messageType: 'qwen-command', launcher: launcher('spawnQwen') },
  {
    name: 'hosted', messageType: 'kimi-command', options: { clientMsgId: 'rf-hosted-1' },
    launcher: (launches) => ({
      hostedTurnSupervisor: {
        enabled: () => true, supports: () => true, cancel: () => true,
        execute: async () => { launches.push('hosted'); return null; },
      },
    }),
  },
  {
    name: 'cli', messageType: 'qwen-command', options: { clientMsgId: 'rf-cli-1' },
    launcher: (launches) => ({
      cliTurnSupervisor: {
        enabledCell: () => true, supports: () => true, cancel: () => true,
        execute: async () => { launches.push('cli'); return null; },
      },
    }),
  },
];

for (const branch of BRANCHES) {
  test(`test 5 / I4 [${branch.name}]: revoked after admission, before hand-off — never launched`, async () => {
    Object.assign(process.env, branch.env ?? {});
    try {
      const launches: string[] = [];
      const primary = await dispatch(branch.messageType, branch.options ?? {}, {
        ...branch.launcher(launches),
        authorizeProviderExecution: revokingAuthorizer,
      });
      assert.deepEqual(launches, [], 'the adapter is never called');
      const terminals = primary.received.filter((frame) => frame.kind === 'complete');
      assert.equal(terminals.length, 1, 'exactly one terminal frame');
      assert.equal(terminals[0].code, 'project_access_changed');
      assert.equal(terminals[0].notStarted, true);
      assert.equal(__fencedRunCountForTests(), 0, 'qa M4: released on the revoked exit');
    } finally {
      for (const key of Object.keys(branch.env ?? {})) delete process.env[key];
    }
  });
}

test('test 5 [deepseek]: a disabled provider is refused before admission — no arm, no launch', async () => {
  const launches: string[] = [];
  const primary = await dispatch('deepseek-command', {}, launcher('spawnDeepSeek')(launches));
  assert.deepEqual(launches, []);
  assert.equal(primary.received.at(-1)?.notStarted, true);
  assert.equal(__fencedRunCountForTests(), 0);
});

test('C2: a stranger is refused at arming with project_access_changed', async () => {
  const stranger = userDb.createUser('rfd_stranger', 'hash', 'user') as User;
  const launches: string[] = [];
  const primary = await dispatch('claude-command', {}, launcher('queryClaudeSDK')(launches), stranger);
  assert.deepEqual(launches, []);
  assert.equal(primary.received.at(-1)?.code, 'project_access_changed');
  assert.equal(primary.received.at(-1)?.notStarted, true);
});

test('M6: an empty cwd under enforcement never launches (permission_launch_context_invalid)', async () => {
  const launches: string[] = [];
  const primary = await dispatch('claude-command', { cwd: '' }, launcher('queryClaudeSDK')(launches));
  assert.deepEqual(launches, []);
  assert.equal(primary.received.at(-1)?.code, 'permission_launch_context_invalid');
  assert.equal(__fencedRunCountForTests(), 0);
});

for (const provider of ['claude', 'codex'] as const) {
  test(`test 14 [${provider}]: removed before session_created — aborted by id, zero content frames`, async () => {
    const aborted: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sessionId = `rf-${provider}-late-session`;
    const run = async (_command: string, _options: unknown, ws: WebSocketWriterType) => {
      await gate;
      ws.send({ kind: 'session_created', sessionId, newSessionId: sessionId, provider });
      monitor.registerSessionProcess(sessionId, { provider, writer: ws, projectPath });
      ws.send({ kind: 'text', role: 'assistant', sessionId, provider, content: 'late secret' });
      monitor.unregisterSessionProcess(sessionId);
    };
    const pending = dispatch(`${provider}-command`, {}, {
      queryClaudeSDK: run,
      queryCodex: run,
      getProviderRunsOwnedByWriter: monitor.getProviderRunsOwnedByWriter,
      getProviderRunWriter: monitor.getProviderRunWriter,
      isProviderRunOwnershipCurrent: monitor.isProviderRunOwnershipCurrent,
      abortClaudeSDKSession: async (id: string) => { aborted.push(id); return { aborted: true, reason: 'ok', sessionId: id }; },
      abortCodexSession: (id: string) => { aborted.push(id); return true; },
    });
    await tick();
    projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
    release();
    const primary = await pending;
    await tick();
    assert.deepEqual(aborted, [sessionId], 'abort requested once, for the right session');
    assert.equal(JSON.stringify(primary.received).includes('late secret'), false);
    const terminals = primary.received.filter((frame) => frame.kind === 'complete');
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].sessionId, sessionId);
    const states = primary.received.filter((frame) => frame.text === 'process_state');
    assert.equal(states.at(-1)?.processState, 'idle', 'the badge settles for every viewer');
    // The fence emits exactly the M2 fields (run-fence.test.ts); the inner
    // coordination layer then adds its routing envelope, as for every frame.
    for (const frame of states) {
      assert.deepEqual(Object.keys(frame).sort(), [
        'coordinationLevel', 'id', 'kind', 'processState', 'provider', 'sessionId', 'text', 'timestamp',
      ], 'sanitized (qa M2)');
    }
    assert.equal(__fencedRunCountForTests(), 0);
  });
}

test('test 17: the fence is outermost — a revoked session_created binds nothing; shadow still starts', async () => {
  const counts = { dispatch: 0 };
  const shadow: UniversalConversationShadowHook = {
    isEnabled: () => true,
    beginLegacyTurn: () => ({
      conversationId: 'rf-conv', runId: 'rf-run', reused: false,
      observeLegacyPayload: () => undefined,
      markLegacyDispatchStarted: () => { counts.dispatch += 1; },
      finishLegacyDispatch: () => undefined,
      recordLegacyFailure: () => undefined,
    }),
    recordHookFailure: () => undefined,
  } as never;
  const { issueTrustedShadowAuthorization } = await import('@/modules/conversations/index.js');
  const primary = await dispatch('codex-command', { clientMsgId: 'rf-shadow-1' }, {
    universalConversationShadow: shadow,
    authorizeUniversalConversationShadow: (input: { principalId: number; clientMsgId: string }) =>
      issueTrustedShadowAuthorization({
        kind: 'fresh', projectId, principalId: input.principalId, clientMsgId: input.clientMsgId,
        canSubmit: true, authorizationProvenance: 'run-fence-test',
      }),
    attestUniversalConversationLegacySession: () => null,
    queryCodex: async (_command: string, _options: unknown, ws: WebSocketWriterType) => {
      projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
      ws.send({ kind: 'session_created', sessionId: 'rf-outer', newSessionId: 'rf-outer', provider: 'codex' });
    },
  });
  assert.equal(counts.dispatch, 1, 'the shadow entry moved to the fenced writer (markLegacyDispatchStarted)');
  assert.deepEqual(binds, [], 'no workspace bind for a dropped session_created');
  assert.equal(primary.received.some((frame) => frame.kind === 'session_created'), false);
  assert.equal(sessionsDb.getSessionById('rf-outer'), null);
});

test('qa M4: a provider throw or a falsy result still releases the run', async () => {
  await assert.rejects(dispatch('claude-command', {}, {
    queryClaudeSDK: async () => { throw new Error('provider exploded'); },
  }));
  assert.equal(__fencedRunCountForTests(), 0, 'throw');
  await dispatch('claude-command', {}, { queryClaudeSDK: async () => undefined });
  assert.equal(__fencedRunCountForTests(), 0, 'falsy value');
  await dispatch('antigravity-command', {}, { spawnAntigravity: async () => null });
  assert.equal(__fencedRunCountForTests(), 0, 'null value');
});

test('test 6 / I6: flag off — no fence, no registry, removal does not touch the stream', async () => {
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '0';
  let sawFence: unknown = 'unset';
  const primary = await dispatch('claude-command', {}, {
    queryClaudeSDK: async (_command: string, _options: unknown, ws: WebSocketWriterType) => {
      sawFence = (ws as { runFenceRevoked?: boolean }).runFenceRevoked;
      assert.equal(__fencedRunCountForTests(), 0);
      projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
      ws.send({ kind: 'text', role: 'assistant', sessionId: 'rf-off', content: 'still streamed' });
    },
  });
  assert.equal(sawFence, undefined, 'the provider sees the pre-T-1854 writer chain');
  assert.equal(primary.received.some((frame) => frame.content === 'still streamed'), true);
});

test('qa H2: a member removed during a streaming POST /api/agent run gets the process aborted', async () => {
  const sessionId = 'rf-agent-sse-session';
  sessionsDb.createSession(sessionId, 'opencode', projectPath, 'agent run');
  const aborted: string[] = [];
  // An SSE writer as routes/agent.js builds it: no socket, JWT userId only.
  const sseWriter = { userId: member.id, send: () => undefined };
  monitor.registerSessionProcess(sessionId, { provider: 'opencode', writer: sseWriter, projectPath });
  try {
    const outcome = revokeProjectLiveAccess(
      { projectId, projectPath, userId: member.id, stillHasAccess: false },
      {
        clients: [], refreshPresence: () => undefined, terminateShells: () => 0,
        abortTurn: (id: string, userId: number) => abortSessionTurn({
          getSessionProvider: () => 'opencode',
          abortOpenCodeSession: (target: string) => { aborted.push(target); return true; },
        } as never, id, null, userId),
      },
    );
    await tick();
    assert.equal(outcome.turnsStopped, 1);
    assert.deepEqual(aborted, [sessionId]);
  } finally {
    monitor.unregisterSessionProcess(sessionId);
  }
});

function btwHarness(user: User, overrides: Record<string, unknown> = {}) {
  const sent: Frame[] = [];
  const listeners: Record<string, Array<(arg: unknown) => unknown>> = {};
  const ws = {
    readyState: 1, sent,
    send: (data: string) => { sent.push(JSON.parse(data)); },
    on: (event: string, callback: (arg: unknown) => unknown) => { (listeners[event] ||= []).push(callback); },
    emit: (event: string, arg: unknown) => Promise.all((listeners[event] || []).map((cb) => cb(arg))),
  };
  const calls: Array<{ callbacks: Record<string, (...args: never[]) => void> }> = [];
  handleChatConnection(ws as never, {
    user: { id: user.id, role: user.role, authenticationKind: 'session', authorizationGeneration: 1 },
  } as never, {
    getSessionProvider: () => 'claude',
    getActiveClaudeSDKSessions: () => [],
    authorizeProviderExecution: authorized,
    spawnClaudeSideQuery: (_params: unknown, callbacks: Record<string, (...args: never[]) => void>) => {
      calls.push({ callbacks });
      return new Promise<void>(() => undefined);
    },
    ...overrides,
  } as never);
  return { ws, sent, calls };
}

test('qa M7: revoked during the writer-lease await — refused before btw-accepted', async () => {
  const sessionId = 'rf-btw-lease';
  sessionsDb.createSession(sessionId, 'claude', projectPath, 'btw');
  let releases = 0;
  const { ws, sent, calls } = btwHarness(member, {
    acquireWriterLease: async () => {
      projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
      await tick();
      return { release: () => { releases += 1; } };
    },
  });
  await ws.emit('message', JSON.stringify({ type: 'btw-query', btwId: 'b1', sessionId, question: 'q' }));
  await tick();
  assert.equal(sent.some((frame) => frame.type === 'btw-accepted'), false);
  assert.equal(sent.find((frame) => frame.type === 'btw-error')?.code, 'project_access_changed');
  assert.equal(calls.length, 0, 'no fork');
  assert.equal(releases, 1, 'the lease is released');
  assert.equal(__fencedRunCountForTests(), 0);
});

test('test 19: an in-flight /btw of a removed member is interrupted, its slots freed, no content after', async () => {
  const sessionId = 'rf-btw-live';
  sessionsDb.createSession(sessionId, 'claude', projectPath, 'btw');
  const { ws, sent, calls } = btwHarness(member, { acquireWriterLease: async () => ({ release: () => undefined }) });
  await ws.emit('message', JSON.stringify({ type: 'btw-query', btwId: 'b2', sessionId, question: 'q' }));
  await tick();
  assert.equal(sent.some((frame) => frame.type === 'btw-accepted'), true);
  assert.equal(__fencedRunCountForTests(), 1, '/btw is registered');
  let interrupted = 0;
  calls[0].callbacks.onStarted({ interrupt: () => { interrupted += 1; } } as never);
  projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
  await tick();
  assert.equal(interrupted, 1);
  assert.equal(sent.find((frame) => frame.type === 'btw-error')?.code, 'project_access_changed');
  calls[0].callbacks.onChunk('late chunk' as never);
  calls[0].callbacks.onComplete('late answer' as never);
  assert.equal(JSON.stringify(sent).includes('late'), false);
  assert.equal(__fencedRunCountForTests(), 0);

  projectMembersDb.addAndRotateProjectAccess(projectId, member.id, 'member', creator.id);
  await ws.emit('message', JSON.stringify({ type: 'btw-query', btwId: 'b3', sessionId, question: 'q' }));
  await tick();
  assert.equal(sent.filter((frame) => frame.type === 'btw-accepted').length, 2, 'the slots were freed');
});

test('qa M3 race: a /btw fork that starts after the revocation is interrupted at once', async () => {
  const sessionId = 'rf-btw-race';
  sessionsDb.createSession(sessionId, 'claude', projectPath, 'btw');
  const { ws, calls } = btwHarness(member, { acquireWriterLease: async () => ({ release: () => undefined }) });
  await ws.emit('message', JSON.stringify({ type: 'btw-query', btwId: 'b4', sessionId, question: 'q' }));
  await tick();
  projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
  await tick();
  let interrupted = 0;
  calls[0].callbacks.onStarted({ interrupt: () => { interrupted += 1; } } as never);
  assert.equal(interrupted, 1);
});
