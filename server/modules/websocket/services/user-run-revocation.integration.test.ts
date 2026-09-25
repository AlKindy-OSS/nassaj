/* eslint-disable boundaries/dependencies -- revocation is proven against the real router, DB, socket handler and monitor. */
/**
 * B-1327 — administrative revocation reaches live agent runs end to end.
 *
 * Real: auth router (PATCH role/status, DELETE user, device logout), SQLite,
 * AccountWalletService, the chat socket handler (handleChatConnection, its
 * message and close paths), WebSocketWriter plus every production writer
 * wrapper (coordination metadata, workspace bind, run fence), the session
 * process monitor and provider-run-presence. Only provider launchers and abort
 * bridges are spies: a launcher registers exactly like its production
 * counterpart (claude-sdk registers the writer it was handed; CLI providers go
 * through beginProviderRun) and then blocks until its abort bridge fires.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach, mock } from 'node:test';

import express from 'express';

import type { WebSocketWriter as WebSocketWriterType } from '@/modules/websocket/services/websocket-writer.service.js';

mock.module(new URL('../../../routes/webauthn.js', import.meta.url).href, { defaultExport: express.Router() });
mock.module(new URL('../../../routes/oidc.js', import.meta.url).href, { defaultExport: express.Router() });
const realWorkspaces = await import('@/modules/session-workspaces/index.js');
const resolveWorkspace = (input: { projectPath: string }) => ({
  cwd: input.projectPath,
  logicalProjectPath: input.projectPath,
  isolation: 'overlay' as const,
  generation: 'b1327-test',
});
mock.module('@/modules/session-workspaces/index.js', {
  namedExports: {
    ...realWorkspaces,
    resolveSessionWorkspaceForLaunch: resolveWorkspace,
    bindSessionWorkspace: resolveWorkspace,
  },
});

const {
  closeConnection, deviceAccountSessionsDb, initializeDatabase, projectMembersDb, projectsDb, userDb,
} = await import('@/modules/database/index.js');
const { __resetProjectFenceStateForTests } = await import('@/modules/database/repositories/project-access.js');
const { bindUserRealtimeRevocation, connectionRevocationRegistry } = await import('@/modules/account-wallet/index.js');
const { handleChatConnection } = await import('@/modules/websocket/services/chat-websocket.service.js');
const { closeWebSocketForIdentityRevocation } = await import('@/modules/websocket/services/websocket-server.service.js');
const { abortLateRevokedRun, revokeUserRunsAndSockets } =
  await import('@/modules/websocket/services/user-run-revocation.service.js');
const { __registerShellSessionForTests, terminateShellSessionsForUser } =
  await import('@/modules/websocket/services/shell-websocket.service.js');
const { addSessionMirror, removeSessionMirrorsForSocket } =
  await import('@/modules/websocket/services/websocket-writer.service.js');
const { trackUserSocket } = await import('@/modules/websocket/services/websocket-state.service.js');
const { bindLateRevokedRunHandler } = await import('@/shared/user-revocation-epoch.js');
// eslint-disable-next-line boundaries/no-unknown -- the real POST /api/agent non-streaming writer.
const { ResponseCollector } = await import('@/routes/agent-response-collector.js');
// eslint-disable-next-line boundaries/no-unknown -- production password seam.
const { hashPassword } = await import('@/services/password.service.js');
// eslint-disable-next-line boundaries/no-unknown -- the real process monitor is the ownership registry under test.
const monitor = await import('../../../services/session-process-monitor.js');
// eslint-disable-next-line boundaries/no-unknown -- production CLI registration path.
const { beginProviderRun } = await import('../../../services/provider-run-presence.js');

type User = { id: number; role: string };
type Frame = Record<string, unknown>;

const PASSWORD = 'correct horse battery staple';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** A `ws`-shaped socket: close() emits the same (code, Buffer) close event. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly frames: Frame[] = [];
  readonly closes: Array<[number, string]> = [];
  constructor(readonly userId: number) { super(); }
  send(serialized: string): void { this.frames.push(JSON.parse(serialized)); }
  ping(): void {}
  close(code = 1000, reason = ''): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closes.push([code, reason]);
    this.emit('close', code, Buffer.from(reason));
  }
}

// ---- provider spies: register like production, block until aborted ----------

const aborted: string[] = [];
const gates = new Map<string, () => void>();
const qwenSessions = new Set<string>();
const hostedSessions = new Set<string>();
let runSequence = 0;

function blockUntilAborted(sessionId: string): Promise<void> {
  return new Promise<void>((resolve) => { gates.set(sessionId, resolve); });
}

function abortBridge(sessionId: string): boolean {
  const release = gates.get(sessionId);
  if (!release) return false;
  gates.delete(sessionId);
  aborted.push(sessionId);
  release();
  return true;
}

type RunOptions = { testSessionId: string; holdRegistration?: boolean };

/**
 * qa M2: a launch that has started but not yet captured its session id. The
 * test releases it (after revoking) to model a late session_id.
 */
const heldLaunches = new Map<string, () => void>();
function holdUntilSessionId(options: RunOptions): Promise<void> {
  if (!options.holdRegistration) return Promise.resolve();
  return new Promise<void>((resolve) => { heldLaunches.set(options.testSessionId, resolve); });
}

/** claude-sdk.js: registerSessionProcess(sessionId, { writer }) with the writer it was handed. */
async function claudeLike(_command: string, options: RunOptions, writer: WebSocketWriterType): Promise<void> {
  const sessionId = options.testSessionId;
  await holdUntilSessionId(options);
  monitor.registerSessionProcess(sessionId, { provider: 'claude', writer, runTag: `tag-${sessionId}` });
  try { await blockUntilAborted(sessionId); } finally { monitor.unregisterSessionProcess(sessionId); }
}

/** Every CLI provider: beginProviderRun({ provider, writer }) from provider-run-presence. */
const cliLike = (provider: string) => async (
  _command: string, options: RunOptions, writer: WebSocketWriterType,
): Promise<void> => {
  const sessionId = options.testSessionId;
  if (provider === 'qwen') qwenSessions.add(sessionId);
  // Production pre-id path: begin without an id, rekey once it is captured.
  const presence = beginProviderRun({ provider, writer, sessionId: options.holdRegistration ? null : sessionId });
  await holdUntilSessionId(options);
  presence.rekey(sessionId);
  try { await blockUntilAborted(sessionId); } finally { presence.end(); }
};

const supervisorCancels: unknown[] = [];
/** Only launchHosted() routes a turn through the supervisor. */
let hostedLaunchPending = false;
const hostedTurnSupervisor = {
  enabled: (input: { provider: string }) => hostedLaunchPending && input.provider === 'kimi',
  supports: (input: { provider: string }) => hostedLaunchPending && input.provider === 'kimi',
  // Like the real supervisor: cancel answers only for turns it supervises.
  cancel: (input: { sessionId: string }) => {
    if (!hostedSessions.has(input.sessionId)) return false;
    supervisorCancels.push(input);
    return abortBridge(input.sessionId);
  },
  execute: async (input: { clientMsgId: string; onSession: (id: string, isNew: boolean) => void }) => {
    const sessionId = `hosted-${input.clientMsgId}`;
    hostedSessions.add(sessionId);
    if (input.clientMsgId.includes('-held-')) {
      await new Promise<void>((resolve) => { heldLaunches.set(sessionId, resolve); });
    }
    input.onSession(sessionId, true);
    await blockUntilAborted(sessionId);
    return null;
  },
};

const PROVIDER_COMMANDS: Record<string, string> = {
  claude: 'claude-command', codex: 'codex-command', cursor: 'cursor-command', antigravity: 'antigravity-command',
  hermes: 'hermes-command', opencode: 'opencode-command', kimi: 'kimi-command', qwen: 'qwen-command',
};

const chatDependencies = {
  getSessionProvider: () => null,
  getActiveClaudeSDKSessions: () => [],
  authorizeProviderExecution: () => ({
    kind: 'authorized' as const,
    execution: {
      decisionId: 'b1327', leaseId: 'b1327', mode: 'legacy' as const,
      consume: () => ({}), markStarted: () => undefined, settle: () => undefined, notStarted: () => undefined,
    },
  }),
  queryClaudeSDK: claudeLike,
  queryCodex: cliLike('codex'),
  spawnCursor: cliLike('cursor'),
  spawnAntigravity: cliLike('antigravity'),
  spawnHermes: cliLike('hermes'),
  spawnOpenCode: cliLike('opencode'),
  spawnKimi: cliLike('kimi'),
  spawnQwen: cliLike('qwen'),
  hostedTurnSupervisor,
  abortClaudeSDKSession: async (id: string) => ({ aborted: abortBridge(id), reason: 'test', sessionId: id }),
  abortCodexSession: abortBridge,
  abortCursorSession: abortBridge,
  abortAntigravitySession: abortBridge,
  abortHermesSession: abortBridge,
  abortOpenCodeSession: abortBridge,
  abortKimiSession: abortBridge,
  abortQwenSession: abortBridge,
  // Qwen keeps its pre-existing foreground-only policy (any transport loss ends it).
  isQwenSessionActive: (id: string) => qwenSessions.has(id) && gates.has(id),
  getProviderRunsOwnedByWriter: monitor.getProviderRunsOwnedByWriter,
  getProviderRunWriter: monitor.getProviderRunWriter,
  isProviderRunOwnershipCurrent: monitor.isProviderRunOwnershipCurrent,
  getProviderRunsOwnedByUser: monitor.getProviderRunsOwnedByUser,
  isProviderRunRegistrationCurrent: monitor.isProviderRunRegistrationCurrent,
};

// ---- fixture ------------------------------------------------------------------

let server: Server;
let origin = '';
let projectPath = '';
let projectId = '';
let owner: User;
let passwordHash = '';
let generateToken: (user: unknown) => string;
let unbindRevocation: () => void = () => undefined;
const previousEnv = {
  flag: process.env.MULTI_ACCOUNT_SWITCHING, origin: process.env.APP_ORIGIN, root: process.env.WORKSPACES_ROOT,
};

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b1327-'));
  process.env.WORKSPACES_ROOT = root;
  await initializeDatabase();
  passwordHash = await hashPassword(PASSWORD);
  owner = userDb.createUser('b1327_owner', passwordHash, 'owner') as User;
  projectPath = fs.mkdtempSync(path.join(root, 'proj-'));
  projectId = projectsDb.createProjectPath(projectPath, 'B1327', owner.id).project?.project_id ?? '';
  // eslint-disable-next-line boundaries/no-unknown -- the real auth router is under test.
  const { default: router } = await import('@/routes/auth.js');
  // eslint-disable-next-line boundaries/no-unknown -- production JWT issuer.
  ({ generateToken } = await import('@/middleware/auth.js'));
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.APP_ORIGIN = origin;
  // Same bindings createWebSocketServer installs in production.
  const unbindUser = bindUserRealtimeRevocation(
    (userId, revocation) => revokeUserRunsAndSockets(userId, revocation, chatDependencies as never, {
      terminateShells: terminateShellSessionsForUser,
      terminateTerminals: (userId) => { terminalTerminations.push(userId); return 0; },
    }),
  );
  const unbindLate = bindLateRevokedRunHandler((run) => abortLateRevokedRun(run as never, chatDependencies as never));
  unbindRevocation = () => { unbindUser(); unbindLate(); };
});

after(async () => {
  unbindRevocation();
  for (const release of gates.values()) release();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  for (const [key, value] of [
    ['MULTI_ACCOUNT_SWITCHING', previousEnv.flag], ['APP_ORIGIN', previousEnv.origin],
    ['WORKSPACES_ROOT', previousEnv.root],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
});

const terminalTerminations: number[] = [];

beforeEach(() => {
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  __resetProjectFenceStateForTests();
  aborted.length = 0;
  supervisorCancels.length = 0;
  terminalTerminations.length = 0;
});

let userSequence = 0;
function createUser(role: 'admin' | 'user'): User {
  userSequence += 1;
  const user = userDb.createUser(`b1327_${role}_${userSequence}`, passwordHash, role) as User;
  projectMembersDb.addAndRotateProjectAccess(projectId, user.id, 'member', owner.id);
  return user;
}

/** Opens a chat socket through the real handler, stamped like a JWT upgrade. */
function connect(user: User): FakeSocket {
  const socket = new FakeSocket(user.id);
  const raw = userDb.getRawById(user.id) as { authorization_generation: number };
  handleChatConnection(socket as never, {
    user: {
      id: user.id, userId: user.id, role: user.role,
      authenticationKind: 'session', authorizationGeneration: raw.authorization_generation,
    },
  } as never, chatDependencies as never);
  return socket;
}

/** Starts one turn over the socket and waits until the provider has registered. */
async function launch(socket: FakeSocket, provider: string): Promise<string> {
  runSequence += 1;
  const sessionId = `b1327-${provider}-${runSequence}`;
  socket.emit('message', Buffer.from(JSON.stringify({
    type: PROVIDER_COMMANDS[provider],
    command: 'hello',
    options: { cwd: projectPath, testSessionId: sessionId },
  })));
  await waitFor(() => gates.has(sessionId), `${provider} run ${sessionId}`);
  return sessionId;
}

/** qa M2: starts a turn that has not captured its session id yet. */
async function launchHeld(socket: FakeSocket, provider: string): Promise<string> {
  runSequence += 1;
  const sessionId = `b1327-held-${provider}-${runSequence}`;
  socket.emit('message', Buffer.from(JSON.stringify({
    type: PROVIDER_COMMANDS[provider],
    command: 'hello',
    options: { cwd: projectPath, testSessionId: sessionId, holdRegistration: true },
  })));
  await waitFor(() => heldLaunches.has(sessionId), `held ${provider} launch ${sessionId}`);
  return sessionId;
}

function releaseHeld(sessionId: string): void {
  const release = heldLaunches.get(sessionId);
  heldLaunches.delete(sessionId);
  release?.();
}

async function launchHosted(socket: FakeSocket, held = false): Promise<string> {
  runSequence += 1;
  const clientMsgId = `b1327-hosted-${held ? 'held-' : ''}${runSequence}`;
  hostedLaunchPending = true;
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'kimi-command', command: 'hello', options: { cwd: projectPath, clientMsgId },
  })));
  const sessionId = `hosted-${clientMsgId}`;
  try {
    await waitFor(() => (held ? heldLaunches : gates).has(sessionId), `hosted run ${sessionId}`);
  } finally {
    hostedLaunchPending = false;
  }
  return sessionId;
}

async function admin(method: string, route: string, body?: object): Promise<Response> {
  const response = await fetch(`${origin}/api/auth${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${generateToken(userDb.getRawById(owner.id))}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  await tick();
  return response;
}

const revocationFrames = (socket: FakeSocket, code: string) =>
  socket.frames.filter((frame) => frame.kind === 'complete' && frame.aborted === true && frame.code === code);

// ---- 1. disable / delete ------------------------------------------------------

test('disable: every provider run of the user is aborted, frames typed, sockets closed', async () => {
  const bob = createUser('user');
  const carol = createUser('user');
  const bobSocket = connect(bob);
  const carolSocket = connect(carol);
  const bobRuns = [];
  for (const provider of Object.keys(PROVIDER_COMMANDS)) bobRuns.push(await launch(bobSocket, provider));
  const carolRun = await launch(carolSocket, 'codex');

  const response = await admin('PATCH', `/users/${bob.id}/status`, { status: 'disabled' });
  assert.equal(response.status, 200);
  await waitFor(() => aborted.length === bobRuns.length, 'all bob aborts');

  assert.deepEqual([...aborted].sort(), [...bobRuns].sort(), 'claude-like and every cli-like provider aborted');
  assert.equal(revocationFrames(bobSocket, 'account_disabled').length, bobRuns.length);
  assert.deepEqual(bobSocket.closes, [[4401, 'identity_revoked']]);
  assert.equal(gates.has(carolRun), true, "another user's run is untouched");
  assert.deepEqual(carolSocket.closes, []);
  assert.equal(monitor.getProviderRunsOwnedByUser(bob.id).length, 0, 'registrations released');
  abortBridge(carolRun);
});

test('disable reaches detached and supervised runs after a normal socket close', async () => {
  const bob = createUser('user');
  const socket = connect(bob);
  const detached = await launch(socket, 'claude');
  const supervised = await launchHosted(socket);
  socket.close(1006, '');
  await tick();
  assert.deepEqual(aborted, [], 'a network drop aborts nothing');

  await admin('PATCH', `/users/${bob.id}/status`, { status: 'disabled' });
  await waitFor(() => aborted.length === 2, 'detached aborts');
  assert.deepEqual([...aborted].sort(), [detached, supervised].sort());
  assert.deepEqual(supervisorCancels, [{ provider: 'kimi', sessionId: supervised, userId: bob.id }]);
});

test('delete: running turns of the deleted user are aborted', async () => {
  const bob = createUser('user');
  const socket = connect(bob);
  const runs = [await launch(socket, 'claude'), await launch(socket, 'opencode')];
  const response = await admin('DELETE', `/users/${bob.id}`);
  assert.equal(response.status, 200);
  await waitFor(() => aborted.length === 2, 'delete aborts');
  assert.deepEqual([...aborted].sort(), [...runs].sort());
  assert.equal(revocationFrames(socket, 'account_deleted').length, 2);
  assert.deepEqual(socket.closes, [[4401, 'identity_revoked']]);
});

test('re-enabling a disabled account stops nothing', async () => {
  const bob = createUser('user');
  userDb.setStatus(bob.id, 'disabled');
  const response = await admin('PATCH', `/users/${bob.id}/status`, { status: 'active' });
  assert.equal(response.status, 200);
  assert.deepEqual(aborted, []);
});

// ---- 2. role change -----------------------------------------------------------

test('downgrade admin -> user: runs aborted with role_changed; session stays resumable', async () => {
  const alice = createUser('admin');
  const socket = connect(alice);
  const runs = [await launch(socket, 'claude'), await launch(socket, 'cursor')];
  const response = await admin('PATCH', `/users/${alice.id}/role`, { role: 'user' });
  assert.equal(response.status, 200);
  await waitFor(() => aborted.length === 2, 'downgrade aborts');
  assert.deepEqual([...aborted].sort(), [...runs].sort());
  const frames = revocationFrames(socket, 'role_changed');
  assert.equal(frames.length, 2);
  assert.match(String(frames[0].error), /role changed/);
  assert.deepEqual(socket.closes, [[4401, 'identity_revoked']], 'client reconnects under the new role');
  assert.equal(userDb.getRawById(alice.id)?.role, 'user');
});

test('promotion user -> admin (and owner) never aborts running turns', async () => {
  const bob = createUser('user');
  const socket = connect(bob);
  const run = await launch(socket, 'codex');
  assert.equal((await admin('PATCH', `/users/${bob.id}/role`, { role: 'admin' })).status, 200);
  const next = connect(bob);
  const second = await launch(next, 'claude');
  assert.equal((await admin('PATCH', `/users/${bob.id}/role`, { role: 'owner' })).status, 200);
  await tick();
  assert.deepEqual(aborted, []);
  assert.equal(gates.has(run) && gates.has(second), true);
  assert.equal(revocationFrames(socket, 'role_changed').length, 0);
  abortBridge(run);
  abortBridge(second);
});

// ---- 3. transport events never abort -------------------------------------------

test('tab close, network loss and a 4401 identity close (logout/expiry) abort nothing', async () => {
  const bob = createUser('user');
  const closes: Array<[number, string]> = [[1001, ''], [1006, ''], [1000, 'normal'], [4401, 'identity_revoked']];
  const runs: string[] = [];
  for (const [code, reason] of closes) {
    const socket = connect(bob);
    runs.push(await launch(socket, 'codex'));
    socket.close(code, reason);
  }
  await tick();
  assert.deepEqual(aborted, []);
  for (const run of runs) assert.equal(gates.has(run), true, `${run} keeps running`);
  for (const run of runs) abortBridge(run);
});

test('device logout closes the socket through the registry without aborting runs', async () => {
  const bob = createUser('user');
  const device = deviceAccountSessionsDb.create(bob.id, 60_000);
  const principal = deviceAccountSessionsDb.resolve(device.secret)!.principal;
  const socket = connect(bob);
  const unregister = connectionRevocationRegistry.register({
    close: () => closeWebSocketForIdentityRevocation(socket as never),
  }, principal);
  const run = await launch(socket, 'claude');
  try {
    const cookie = `__Host-nassaj_device=${device.secret}`;
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
    const csrf = await fetch(`${origin}/api/auth/accounts/csrf?action=logout`, { headers });
    assert.equal(csrf.status, 200);
    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { ...headers, 'X-CSRF-Token': (await csrf.json()).csrfToken },
      body: JSON.stringify({ expectedGeneration: 1 }),
    });
    assert.equal(logout.status, 200);
    await tick();
    assert.deepEqual(socket.closes, [[4401, 'identity_revoked']]);
    assert.deepEqual(aborted, [], 'logout never stops agents');
    assert.equal(gates.has(run), true);
  } finally {
    unregister();
    abortBridge(run);
  }
});

// ---- run-fence wrappers --------------------------------------------------------

test('PROJECT_MEMBERSHIP_ENFORCE on: runs registered through the run fence are found and aborted', async () => {
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  const bob = createUser('user');
  const socket = connect(bob);
  const runs = [await launch(socket, 'claude'), await launch(socket, 'hermes')];
  const fenced = monitor.getProviderRunWriter(runs[0]) as { runFenceRevoked?: boolean } | null;
  assert.equal(typeof fenced?.runFenceRevoked, 'boolean', 'registered writer is the run-fence proxy');
  await admin('PATCH', `/users/${bob.id}/status`, { status: 'disabled' });
  await waitFor(() => aborted.length === 2, 'fenced aborts');
  assert.deepEqual([...aborted].sort(), [...runs].sort());
});

// ---- qa M2: launched before the revocation, registered after it --------------

test('disable during launch: runs that register after the revocation are aborted', async () => {
  const bob = createUser('user');
  const socket = connect(bob);
  const held = [await launchHeld(socket, 'claude'), await launchHeld(socket, 'codex')];
  const hosted = await launchHosted(socket, true);
  assert.equal((await admin('PATCH', `/users/${bob.id}/status`, { status: 'disabled' })).status, 200);
  assert.deepEqual(aborted, [], 'nothing was registered yet');

  for (const sessionId of [...held, hosted]) releaseHeld(sessionId);
  await waitFor(() => aborted.length === 3, 'late registrations aborted');
  assert.deepEqual([...aborted].sort(), [...held, hosted].sort());

  // A writer created after re-enabling is newer than the revocation: untouched.
  assert.equal((await admin('PATCH', `/users/${bob.id}/status`, { status: 'active' })).status, 200);
  const fresh = await launch(connect(bob), 'codex');
  await tick();
  await tick();
  assert.equal(gates.has(fresh), true, 'a post-revocation writer is not revoked');
  abortBridge(fresh);
});

// ---- T2: mirrors never learn the account reason ------------------------------

test('mirrors of other members get a neutral terminal frame; only the user sees the reason', async () => {
  const bob = createUser('user');
  const carol = createUser('user');
  const bobSocket = connect(bob);
  const carolSocket = new FakeSocket(carol.id);
  const run = await launch(bobSocket, 'claude');
  addSessionMirror(run, carolSocket as never);
  try {
    await admin('PATCH', `/users/${bob.id}/status`, { status: 'disabled' });
    await waitFor(() => aborted.includes(run), 'mirrored run aborted');
    const carolTerminal = carolSocket.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(carolTerminal.length, 1);
    assert.equal(carolTerminal[0].code, 'turn_stopped');
    assert.equal(JSON.stringify(carolSocket.frames).includes('disabled'), false, 'no account detail leaks');
    const bobTerminal = bobSocket.frames.filter((frame) => frame.kind === 'complete');
    assert.deepEqual(bobTerminal.map((frame) => frame.code), ['account_disabled']);
  } finally {
    removeSessionMirrorsForSocket(carolSocket as never);
  }
});

// ---- qa M3: shells and terminals ----------------------------------------------

function fakePty(userId: number, label: string) {
  const state = { killed: false, released: false };
  const ws = new FakeSocket(userId);
  __registerShellSessionForTests(`${userId}_/tmp/${label}_x`, {
    pty: { kill: () => { state.killed = true; } },
    ws, buffer: [], timeoutId: null, projectPath: `/tmp/${label}`, sessionId: null,
    writerLease: { release: () => { state.released = true; } },
  } as never);
  return { state, ws };
}

test('disable ends shells and terminals of the user and closes an idle JWT /shell socket', async () => {
  const bob = createUser('user');
  const carol = createUser('user');
  const bobPty = fakePty(bob.id, 'bob');
  const carolPty = fakePty(carol.id, 'carol');
  const idleShell = new FakeSocket(bob.id);
  const untrack = trackUserSocket(bob.id, idleShell as never);
  try {
    await admin('PATCH', `/users/${bob.id}/status`, { status: 'disabled' });
    assert.deepEqual(bobPty.state, { killed: true, released: true });
    assert.deepEqual(bobPty.ws.closes, [[4401, 'identity_revoked']]);
    assert.deepEqual(idleShell.closes, [[4401, 'identity_revoked']], 'a shell socket with no PTY is closed too');
    assert.deepEqual(terminalTerminations, [bob.id]);
    assert.deepEqual(carolPty.state, { killed: false, released: false }, 'another user keeps their shell');
  } finally {
    untrack();
    terminateShellSessionsForUser(carol.id);
  }
});

test('shells end on admin -> user, but not on owner -> admin or on promotion', async () => {
  const alice = createUser('admin');
  const pty = fakePty(alice.id, 'alice');
  await admin('PATCH', `/users/${alice.id}/role`, { role: 'owner' });
  assert.equal(pty.state.killed, false, 'promotion keeps the shell');
  await admin('PATCH', `/users/${alice.id}/role`, { role: 'admin' });
  assert.equal(pty.state.killed, false, 'owner -> admin keeps shell rights');
  assert.deepEqual(terminalTerminations, []);
  await admin('PATCH', `/users/${alice.id}/role`, { role: 'user' });
  assert.equal(pty.state.killed, true, 'user role may not hold a free shell or terminal');
  assert.deepEqual(terminalTerminations, [alice.id]);
});

test('POST /api/agent (stream=false): a collector run registered after disable is aborted', async () => {
  const bob = createUser('user');
  // The route creates the collector before the provider captures a session id.
  const claudeCollector = new ResponseCollector(bob.id);
  const cliCollector = new ResponseCollector(bob.id);
  const cliPresence = beginProviderRun({ provider: 'codex', writer: cliCollector, sessionId: null });
  assert.equal((await admin('PATCH', `/users/${bob.id}/status`, { status: 'disabled' })).status, 200);
  assert.deepEqual(aborted, []);

  // claude-sdk addSession path, then the CLI rekey path, both after the revocation.
  const claudeRun = 'b1327-agent-claude';
  const cliRun = 'b1327-agent-codex';
  const claudeDone = blockUntilAborted(claudeRun);
  monitor.registerSessionProcess(claudeRun, { provider: 'claude', writer: claudeCollector, runTag: 'tag-agent' });
  const cliDone = blockUntilAborted(cliRun);
  cliPresence.rekey(cliRun);
  try {
    await waitFor(() => aborted.length === 2, 'late /api/agent registrations aborted');
    assert.deepEqual([...aborted].sort(), [claudeRun, cliRun].sort());
    await Promise.all([claudeDone, cliDone]);
    const terminal = claudeCollector.getMessages().find((frame: Frame) => frame.kind === 'complete');
    assert.equal(terminal?.aborted, true, 'the collector reply records the stop');
  } finally {
    monitor.unregisterSessionProcess(claudeRun);
    cliPresence.end();
  }
});
