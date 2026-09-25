import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { WebSocket } from 'ws';

import {
  AccountWalletService,
  connectionRevocationRegistry,
} from '@/modules/account-wallet/index.js';
import {
  closeConnection,
  deviceAccountSessionsDb,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';

// eslint-disable-next-line boundaries/no-unknown -- integration test uses the production password seam.
import { hashPassword, verifyPassword } from '../../../services/password.service.js';

import { handleChatConnection } from './chat-websocket.service.js';
import { handleShellConnection } from './shell-websocket.service.js';
import { handleTerminalConnection } from './terminal-websocket.service.js';
import { createWebSocketServer } from './websocket-server.service.js';

const DECOY = '$argon2id$v=19$m=19456,t=2,p=1$EDCm/UT8BUkf/841sKsVBA$ovQxBwQSaiVR9mJzTVt6kcaWVmZzT1PslPE4FjMPxRk';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closes.push([code, reason]); }
}

test('stale device generation closes chat, shell and terminal before frame effects', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'wallet-realtime-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    const hash = await hashPassword('correct horse battery staple');
    const user = userDb.createUser('realtime_owner', hash, 'owner');
    const device = deviceAccountSessionsDb.create(user.id, 60_000);
    const request = {
      user: {
        id: user.id,
        userId: user.id,
        username: user.username,
        role: 'owner',
        authenticationKind: 'device_session',
        authorizationGeneration: 1,
        deviceSessionId: device.principal.deviceSessionId,
        slotId: device.principal.slotId,
        deviceGeneration: device.principal.generation,
      },
    };
    const chat = new FakeSocket();
    const shell = new FakeSocket();
    const terminal = new FakeSocket();
    handleChatConnection(chat as never, request as never, {
      getActiveClaudeSDKSessions: () => [],
    } as never);
    handleShellConnection(shell as never, request as never, {} as never);
    handleTerminalConnection(terminal as never, request as never, {} as never);

    const service = new AccountWalletService({
      findLocalCredential: () => null,
      verifyPassword,
      decoyPasswordHash: DECOY,
    });
    service.rotatePassword(
      user.id,
      await hashPassword('new correct horse battery staple'),
      Date.now() + 1000,
      device.principal.slotId,
    );
    chat.emit('message', JSON.stringify({ type: 'get-projects' }));
    shell.emit('message', JSON.stringify({ type: 'input', data: 'forbidden' }));
    terminal.emit('message', JSON.stringify({ type: 'input', data: 'forbidden' }));
    await new Promise((resolve) => setImmediate(resolve));

    for (const socket of [chat, shell, terminal]) {
      assert.deepEqual(socket.closes, [[4401, 'identity_revoked']]);
    }
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('real chat, shell and terminal upgrades close immediately after device logout', { timeout: 5000 }, async () => {
  assert.ok(process.env.DATABASE_PATH, 'Run with the isolated node test runner');
  await initializeDatabase();
  const user = userDb.createUser('real_socket_owner', await hashPassword('correct horse battery staple'), 'owner');
  const device = deviceAccountSessionsDb.create(user.id, 60_000);
  const server = createServer();
  let revokedWriterAborts = 0;
  const ownedRun = { sessionId: 'wallet-live-claude', provider: 'claude', token: {} };
  const gateway = createWebSocketServer(server, {
    verifyClient: {
      isPlatform: false, canAcceptApplications: () => true,
      authenticateWebSocket: () => null,
      authenticateDeviceWebSocket: (secret) => {
        const resolved = deviceAccountSessionsDb.resolve(secret);
        if (!resolved) return null;
        return { ...user, userId: user.id, authenticationKind: 'device_session',
          authorizationGeneration: resolved.principal.authorizationGeneration,
          deviceSessionId: resolved.principal.deviceSessionId,
          slotId: resolved.principal.slotId, deviceGeneration: resolved.principal.generation };
      },
      jwtSecret: 'unused-cookie-authentication-secret',
      recordRejection: () => {}, clientIp: () => '127.0.0.1',
      isTrustedOrigin: (request) => request.headers.origin === 'https://wallet.example.test',
    },
    chat: {
      getActiveClaudeSDKSessions: () => [],
      getProviderRunsOwnedByWriter: () => [ownedRun],
      isProviderRunOwnershipCurrent: (candidate: unknown) => candidate === ownedRun,
      abortClaudeSDKSession: async () => { revokedWriterAborts += 1; return true; },
    } as never,
    shell: {} as never, terminal: {} as never,
  });
  const sockets: WebSocket[] = [];
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    for (const route of ['/ws', '/shell', '/terminal']) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${route}`, {
        headers: { Cookie: `__Host-nassaj_device=${device.secret}`, Origin: 'https://wallet.example.test' },
      });
      sockets.push(socket);
      await once(socket, 'open');
    }
    const closed = sockets.map((socket) => once(socket, 'close'));
    const service = new AccountWalletService({ findLocalCredential: () => null, verifyPassword, decoyPasswordHash: DECOY });
    service.logoutAll(device.principal, 1);
    for (const [code, reason] of await Promise.all(closed)) {
      assert.equal(code, 4401);
      assert.equal(reason.toString(), 'identity_revoked');
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(revokedWriterAborts, 1, 'wallet revocation aborts the chat writer run once');
    assert.equal(deviceAccountSessionsDb.resolve(device.secret), null);
  } finally {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
  }
});

test('switch between websocket verification and registration cannot leave a stale socket', { timeout: 5000 }, async () => {
  assert.ok(process.env.DATABASE_PATH, 'Run with the isolated node test runner');
  await initializeDatabase();
  const user = userDb.createUser(
    'registration_race_owner',
    await hashPassword('correct horse battery staple'),
    'owner',
  );
  const device = deviceAccountSessionsDb.create(user.id, 60_000);
  const service = new AccountWalletService({
    findLocalCredential: () => null, verifyPassword, decoyPasswordHash: DECOY,
  });
  const nextHash = await hashPassword('new correct horse battery staple');
  const originalRegister = connectionRevocationRegistry.register.bind(connectionRevocationRegistry);
  const registration = mock.method(
    connectionRevocationRegistry,
    'register',
    (connection, principal) => {
      service.rotatePassword(user.id, nextHash, Date.now() + 1000, device.principal.slotId);
      return originalRegister(connection, principal);
    },
  );
  const server = createServer();
  const gateway = createWebSocketServer(server, {
    verifyClient: {
      isPlatform: false, canAcceptApplications: () => true,
      authenticateWebSocket: () => null,
      authenticateDeviceWebSocket: (secret) => {
        const resolved = deviceAccountSessionsDb.resolve(secret);
        if (!resolved) return null;
        return { ...user, userId: user.id, authenticationKind: 'device_session',
          authorizationGeneration: resolved.principal.authorizationGeneration,
          deviceSessionId: resolved.principal.deviceSessionId,
          slotId: resolved.principal.slotId, deviceGeneration: resolved.principal.generation };
      },
      jwtSecret: 'unused-cookie-authentication-secret',
      recordRejection: () => {}, clientIp: () => '127.0.0.1',
      isTrustedOrigin: (request) => request.headers.origin === 'https://wallet.example.test',
    },
    chat: { getActiveClaudeSDKSessions: () => [] } as never,
    shell: {} as never, terminal: {} as never,
  });
  let raced: WebSocket | null = null;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    raced = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: `__Host-nassaj_device=${device.secret}`, Origin: 'https://wallet.example.test' },
    });
    const [code, reason] = await once(raced, 'close');
    assert.equal(code, 4401);
    assert.equal(reason.toString(), 'identity_revoked');
    assert.equal(registration.mock.callCount(), 1);
    assert.equal(connectionRevocationRegistry.sizeForTests(), 0);
  } finally {
    registration.mock.restore();
    raced?.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
  }
});
