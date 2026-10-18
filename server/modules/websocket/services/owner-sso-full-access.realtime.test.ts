/**
 * ADR-H20 S6 on the realtime side, with the real database.
 *
 * N2 withdrawn (owner decision 2026-10-18): an owner's no-click SSO session
 * with NO step-up grant starts an agent turn and opens the shell and terminal
 * sockets like any other owner session; nothing asks for a passkey.
 *
 * Also: a forced sign-out of a browser (back channel / re-check) closes its
 * sockets with 4401 while running turns keep going (B-1327).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, mock } from 'node:test';

const resolveWorkspace = (input: { projectPath: string }) => ({
  cwd: input.projectPath,
  logicalProjectPath: input.projectPath,
  isolation: 'overlay' as const,
  generation: 'owner-sso-full-access',
});
const realWorkspaces = await import('@/modules/session-workspaces/index.js');
mock.module('@/modules/session-workspaces/index.js', {
  namedExports: {
    ...realWorkspaces,
    resolveSessionWorkspaceForLaunch: resolveWorkspace,
    bindSessionWorkspace: resolveWorkspace,
  },
});

const { initializeDatabase, projectsDb, ssoDeviceSessionsDb, userDb } = await import('@/modules/database/index.js');
const { registerTokenSessionSocket } = await import('@/modules/account-wallet/index.js');
// eslint-disable-next-line boundaries/no-unknown -- the test drives the shared ADR-H20 services directly.
const { endSsoDeviceSession } = await import('../../../services/sso-device-session.service.js');
const { WebSocketWriter } = await import('./websocket-writer.service.js');
const { handleChatConnection } = await import('./chat-websocket.service.js');
const { closeWebSocketForIdentityRevocation, createWebSocketServer } = await import('./websocket-server.service.js');
const { listUserOwnedRuns } = await import('./user-run-revocation.service.js');

const HOUR_MS = 60 * 60_000;
type Frame = Record<string, unknown>;

/** A `ws`-shaped socket: records frames and closes. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly frames: Frame[] = [];
  readonly closes: Array<[number, string]> = [];
  send(serialized: string): void { this.frames.push(JSON.parse(serialized)); }
  ping(): void {}
  terminate(): void {}
  close(code = 1000, reason = ''): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closes.push([code, reason]);
    this.emit('close', code, Buffer.from(reason));
  }
}

let owner: { id: number; username: string; role: string };
let projectPath = '';
const previousRoot = process.env.WORKSPACES_ROOT;

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-sso-full-'));
  process.env.WORKSPACES_ROOT = root;
  await initializeDatabase();
  owner = userDb.createUser(`owner_sso_full_${crypto.randomUUID().slice(0, 8)}`, 'x', 'owner') as typeof owner;
  projectPath = fs.mkdtempSync(path.join(root, 'proj-'));
  projectsDb.createProjectPath(projectPath, 'OwnerSsoFull', owner.id);
});

after(() => {
  if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;
  else process.env.WORKSPACES_ROOT = previousRoot;
});

/** An owner-tier SSO device session with no step-up grant (the column stays NULL). */
function bindOwnerSso(userId: number): string {
  const refreshSid = crypto.randomBytes(16).toString('base64url');
  ssoDeviceSessionsDb.bind({
    refreshSid, userId, issuer: 'https://idp.example', idpSid: `V1_${refreshSid}`, loginHint: null,
    ownerTier: true, nowMs: Date.now(), pruneAfter: Date.now() + 30 * 24 * HOUR_MS,
  });
  assert.equal(ssoDeviceSessionsDb.get(refreshSid)?.privileged_until, null);
  return refreshSid;
}

function ownerPrincipal(tokenSid: string) {
  const raw = userDb.getRawById(owner.id) as { authorization_generation: number };
  return {
    id: owner.id, userId: owner.id, username: owner.username, role: 'owner', tokenSid,
    authenticationKind: 'session', authorizationGeneration: raw.authorization_generation,
  };
}

test('N2 withdrawn: an owner SSO session with no grant starts a claude turn; no passkey refusal', async () => {
  const tokenSid = bindOwnerSso(owner.id);
  const launched: string[] = [];
  const socket = new FakeSocket();
  handleChatConnection(socket as never, { user: ownerPrincipal(tokenSid) } as never, {
    getSessionProvider: () => null,
    getActiveClaudeSDKSessions: () => [],
    authorizeProviderExecution: () => ({
      kind: 'authorized' as const,
      execution: {
        decisionId: 'n2', leaseId: 'n2', mode: 'legacy' as const,
        consume: () => ({}), markStarted: () => undefined, settle: () => undefined, notStarted: () => undefined,
      },
    }),
    queryClaudeSDK: async (command: string) => { launched.push(command); },
  } as never);

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'claude-command', command: 'hello owner', options: { cwd: projectPath },
  })));
  for (let attempt = 0; attempt < 200 && launched.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(launched, ['hello owner'], 'the provider was reached');
  assert.equal(socket.frames.some((frame) => frame.code === 'owner_step_up_required'), false);
  assert.deepEqual(socket.closes, []);
});

test('N2 withdrawn: /shell and /terminal open for an owner SSO session with no grant', () => {
  const tokenSid = bindOwnerSso(owner.id);
  const server = createServer();
  const gateway = createWebSocketServer(server, {
    verifyClient: {} as never, chat: {} as never, shell: {} as never, terminal: {} as never,
  });
  try {
    for (const route of ['/shell', '/terminal']) {
      const socket = new FakeSocket();
      gateway.emit('connection', socket, { url: route, headers: {}, user: ownerPrincipal(tokenSid) });
      assert.deepEqual(socket.closes, [], `${route} is not refused`);
      socket.close();
    }
  } finally {
    gateway.close();
  }
});

test('a forced sign-out (back channel / re-check) closes that browser\'s sockets with 4401; running turns survive', () => {
  const refreshSid = crypto.randomBytes(16).toString('base64url');
  ssoDeviceSessionsDb.bind({
    refreshSid, userId: 41, issuer: 'https://idp.example', idpSid: `V1_${refreshSid}`, loginHint: null,
    ownerTier: false, nowMs: Date.now(), pruneAfter: Date.now() + 30 * 24 * HOUR_MS,
  });
  const closes: Array<[number, string]> = [];
  const socket = { close: (code: number, reason: string) => closes.push([code, reason]) };
  registerTokenSessionSocket(refreshSid, () => closeWebSocketForIdentityRevocation(socket as never));
  const writer = new WebSocketWriter({ readyState: 1, send: () => undefined } as never, 41);
  writer.bindRevocableRun('turn-41', 'claude');

  const closed = endSsoDeviceSession({ userId: 41, refreshSid });

  assert.equal(closed, 1);
  assert.deepEqual(closes, [[4401, 'identity_revoked']]);
  const runs = listUserOwnedRuns(41, {} as never);
  assert.deepEqual(runs.map((run) => run.sessionId), ['turn-41'], 'the running turn is still registered');
  assert.equal(runs[0].isCurrent(), true, 'and still current: nothing aborted it');
  assert.equal(writer.isRunOutputRevoked(), false, 'its output is not fenced');
});
