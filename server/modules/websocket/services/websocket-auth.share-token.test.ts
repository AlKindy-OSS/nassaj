/* eslint-disable boundaries/no-unknown -- the real JWT authenticator and share capability are composed here as server/index.js does. */
/**
 * ADR-205 D1 point 3: a live read-link token is never a WebSocket credential.
 * verifyClient is unchanged; this pins that an upgrade carrying the share
 * token (header, query or Bearer) is refused on every socket path, through
 * the real JWT authenticator, while a real member JWT still connects.
 */
import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import jwt from 'jsonwebtoken';

import { initializeDatabase, userDb } from '@/modules/database/index.js';
import { clientIp } from '@/utils/client-ip.js';

import { createShareToken } from '../../../services/share-capability.js';

import { verifyWebSocketClient } from './websocket-auth.service.js';

const PATHS = ['/ws', '/shell', '/terminal', '/internal-session-chat'];
let auth: { authenticateWebSocket: (token: string | null) => unknown; JWT_SECRET: string };

before(async () => {
  await initializeDatabase();
  auth = await import('../../../middleware/auth.js') as never;
});

function dependencies(rejections: string[]) {
  return {
    isPlatform: false,
    canAcceptApplications: () => true,
    authenticateWebSocket: auth.authenticateWebSocket,
    deviceSessionsEnabled: () => false,
    jwtSecret: auth.JWT_SECRET,
    recordRejection: ({ reason }: { reason: string }) => { rejections.push(reason); },
    clientIp,
    isTrustedOrigin: () => false,
  };
}

const upgrade = (url: string, headers: Record<string, string> = {}) => ({
  req: { url, headers: { host: 'nassaj.example.test', ...headers }, socket: { remoteAddress: '203.0.113.5' } },
});

test('a share token in X-Share-Token, ?token= or a Bearer header is refused on every socket path', () => {
  const token = createShareToken();
  for (const path of PATHS) {
    for (const [label, info] of [
      ['header', upgrade(path, { 'x-share-token': token })],
      ['query', upgrade(`${path}?token=${token}`)],
      ['bearer', upgrade(path, { authorization: `Bearer ${token}` })],
      ['query plus header', upgrade(`${path}?token=${token}`, { 'x-share-token': token })],
    ] as const) {
      const rejections: string[] = [];
      assert.equal(verifyWebSocketClient(info as never, dependencies(rejections) as never), false, `${path} ${label}`);
      assert.equal((info.req as { user?: unknown }).user, undefined, `${path} ${label}: no principal attached`);
    }
  }
});

test('control: the same harness accepts a real member JWT, so the refusals above are about the credential', () => {
  const user = userDb.createUser(`ws-share-${process.pid}`, 'hash', 'user') as { id: number };
  const row = userDb.getUserById(user.id) as { password_changed_at: number; authorization_generation: number };
  const memberJwt = jwt.sign({ userId: user.id, pwd_iat: row.password_changed_at, auth_gen: row.authorization_generation },
    auth.JWT_SECRET, { expiresIn: '5m' });
  const info = upgrade(`/ws?token=${memberJwt}`, { 'x-share-token': createShareToken() });
  assert.equal(verifyWebSocketClient(info as never, dependencies([]) as never), true);
  assert.equal((info.req as { user?: { id?: number } }).user?.id, user.id);
});
