/**
 * ADR-163 amendment 1, slice A stage A4 (inventory M4): the share routes that
 * verify Bearer themselves accept the wallet device cookie through
 * authenticateDeviceCookieIfPresent, which delegates to the single
 * authenticateToken. The real middleware, share routers, mounts, device
 * repository and SQLite run together; only the session-share policy and the
 * snapshot builder are stubs, because these cases stop before any snapshot.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after, before } from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';
import jwt from 'jsonwebtoken';

import { mintMutationCsrfToken } from '../modules/account-wallet/request-csrf.js';
import { createDocumentSharesStore, migrateDocumentShares } from '../modules/database/document-shares.js';
import {
  closeConnection, DEVICE_COOKIE, deviceAccountSessionsDb, initializeDatabase, userDb,
} from '../modules/database/index.js';
import { createDocumentShareVerifier } from '../services/document-share-auth.js';
import { multiAccountSwitchingEnabled } from '../utils/trusted-origin.js';
import { useWalletOriginEnv } from '../utils/__tests__/wallet-origin-env.js';

import { createDocumentSharesMount, createDocumentSharesRouter } from './document-shares.js';
import { createSessionShareManagementMount, createSessionShareManagementRouter } from './session-shares.js';

const previousFlag = process.env.MULTI_ACCOUNT_SWITCHING;
let server: Server;
let origin = '';
let restoreOriginEnv = () => {};
let base = '';
let shareDb: Database.Database;
let jwtSecret = '';
let sequence = 0;
const listedFor: number[] = [];
const members = new Set<number>();

type Device = { secret: string; deviceSessionId: string; slotId: string; generation: number; userId: number };

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  await initializeDatabase();
  const middleware = await import('../middleware/auth.js');
  jwtSecret = middleware.JWT_SECRET;
  base = await fs.mkdtemp(path.join('/var/tmp', 'a4-share-device-'));
  const root = path.join(base, 'project');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'plan.txt'), 'wallet member read');
  shareDb = new Database(':memory:');
  shareDb.exec('CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT, isArchived INTEGER)');
  shareDb.prepare('INSERT INTO projects VALUES (?,?,0)').run('p1', root);
  migrateDocumentShares(shareDb);
  const store = createDocumentSharesStore(shareDb);
  const verifyUser = createDocumentShareVerifier(userDb, jwtSecret);
  const documentRouter = createDocumentSharesRouter({
    getStore: () => store, verifyUser, isMember: (_root: string, id: number) => members.has(id),
    publicOrigin: 'https://nassaj.test',
  });
  const sessionRouter = createSessionShareManagementRouter({
    getStore: () => ({ listForUser: (id: number) => { listedFor.push(id); return []; }, get: () => null }),
    policy: { getSession: () => null, resolveOwner: () => null, getUserName: () => null },
    verifyUser, buildSnapshot: async () => { throw new Error('not reached'); },
    publicOrigin: 'https://nassaj.test', deviceCookieName: DEVICE_COOKIE,
    deviceCookiesEnabled: multiAccountSwitchingEnabled,
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createDocumentSharesMount(documentRouter, {
    authenticateToken: middleware.authenticateToken,
    deviceIdentity: middleware.authenticateDeviceCookieIfPresent,
  }));
  app.use('/api', createSessionShareManagementMount(sessionRouter, middleware.authenticateDeviceCookieIfPresent));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  ({ origin, restore: restoreOriginEnv } = useWalletOriginEnv((server.address() as AddressInfo).port));
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  shareDb?.close();
  closeConnection();
  if (base) await fs.rm(base, { recursive: true, force: true });
  if (previousFlag === undefined) delete process.env.MULTI_ACCOUNT_SWITCHING;
  else process.env.MULTI_ACCOUNT_SWITCHING = previousFlag;
  restoreOriginEnv();
});

function device(role: 'owner' | 'admin' | 'user' = 'user'): Device {
  const user = userDb.createUser(`a4_share_${++sequence}`, 'unused-hash', role);
  const issued = deviceAccountSessionsDb.create(user.id, 60 * 60_000);
  const { deviceSessionId, slotId, generation } = issued.principal;
  return { secret: issued.secret, deviceSessionId, slotId, generation, userId: user.id };
}

const cookie = (d: Device) => ({ Cookie: `${DEVICE_COOKIE}=${encodeURIComponent(d.secret)}` });
const bearer = (userId: number) => ({
  Authorization: `Bearer ${jwt.sign({ userId, pwd_iat: Date.now(), auth_gen: 0 }, jwtSecret, { expiresIn: '1h' })}`,
});

/** Origin plus the generation-bound mutation token the client fetches from /api/auth/mutation-csrf. */
function csrf(d: Device, method: string, route: string) {
  const binding = `device:${d.deviceSessionId}:${d.slotId}:${d.generation}`;
  const minted = mintMutationCsrfToken(jwtSecret, binding, method, route);
  assert.ok(minted);
  return { Origin: origin, 'X-CSRF-Token': minted.csrfToken };
}

async function errorCode(response: Response): Promise<unknown> {
  const body = await response.json() as { code?: unknown; error?: { code?: unknown } };
  return body.error?.code ?? body.code;
}

test('session-share management reads accept the device cookie', async () => {
  const owner = device();
  listedFor.length = 0;
  const response = await fetch(`${origin}/api/session-shares/mine`, { headers: cookie(owner) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { shares: [] });
  assert.deepEqual(listedFor, [owner.userId], 'the handler saw the device user');
});

test('session-share mutations by cookie need the trusted origin and the CSRF token', async () => {
  const owner = device();
  const route = '/api/session-shares/missing-share/revoke';
  const post = (headers: Record<string, string>) => fetch(`${origin}${route}`, {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', ...cookie(owner), ...headers },
  });
  const bare = await post({});
  assert.equal(bare.status, 403);
  assert.equal(await errorCode(bare), 'csrf_or_origin_rejected');
  const foreign = await post({ ...csrf(owner, 'POST', route), Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403, 'a foreign Origin is refused even with a valid token');
  const accepted = await post(csrf(owner, 'POST', route));
  assert.equal(accepted.status, 404, 'authenticated; the share simply does not exist');
  assert.equal(await errorCode(accepted), 'SHARE_UNAVAILABLE');
});

test('session shares: cookie beside Bearer stays ambiguous; a revoked device or flag off is refused', async () => {
  const owner = device();
  const both = await fetch(`${origin}/api/session-shares/mine`, { headers: { ...cookie(owner), ...bearer(owner.userId) } });
  assert.equal(both.status, 400);
  assert.equal(await errorCode(both), 'AMBIGUOUS_AUTHENTICATION');

  const resolved = deviceAccountSessionsDb.resolve(owner.secret);
  assert.ok(resolved);
  deviceAccountSessionsDb.logout(resolved.principal, resolved.principal.generation, true);
  const revoked = await fetch(`${origin}/api/session-shares/mine`, { headers: cookie(owner) });
  assert.equal(revoked.status, 401);
  assert.equal(await errorCode(revoked), 'device_session_invalid');

  const other = device();
  process.env.MULTI_ACCOUNT_SWITCHING = 'false';
  try {
    const flagOff = await fetch(`${origin}/api/session-shares/mine`, { headers: cookie(other) });
    assert.equal(flagOff.status, 401, 'flag off: the cookie is ignored and no Bearer is present');
    assert.equal(await errorCode(flagOff), 'AUTH_REQUIRED');
  } finally {
    process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  }
});

test('document shares: cookie management and members-audience reads; token reads ignore cookies', async () => {
  const owner = device('owner');
  const member = device();
  const outsider = device();
  members.add(member.userId);
  const createRoute = '/api/projects/p1/document-shares';
  const create = (audience: string) => fetch(`${origin}${createRoute}`, {
    method: 'POST', body: JSON.stringify({ relativePath: 'docs/plan.txt', audience }),
    headers: { 'Content-Type': 'application/json', ...cookie(owner), ...csrf(owner, 'POST', createRoute) },
  });
  const membersShare = await create('members');
  assert.equal(membersShare.status, 201);
  const { share } = await membersShare.json() as { share: { id: string } };

  const read = await fetch(`${origin}/api/document-shares/${share.id}`, { headers: cookie(member) });
  assert.equal(read.status, 200, 'a wallet member reads a members-audience share');
  const body = await read.json() as { document: { name: string } };
  assert.equal(body.document.name, 'plan.txt');
  const content = await fetch(`${origin}/api/document-shares/${share.id}/content`, { headers: cookie(member) });
  assert.equal(content.status, 200);
  assert.equal(await content.text(), 'wallet member read');

  const denied = await fetch(`${origin}/api/document-shares/${share.id}`, { headers: cookie(outsider) });
  assert.equal(denied.status, 403, 'membership is still enforced for the cookie identity');
  const anonymous = await fetch(`${origin}/api/document-shares/${share.id}`);
  assert.equal(anonymous.status, 401);

  const clientShare = await create('client');
  assert.equal(clientShare.status, 201);
  const { share: client, shareUrl } = await clientShare.json() as { share: { id: string }; shareUrl: string };
  const token = new URL(shareUrl).hash.replace('#token=', '');
  const tokenRead = await fetch(`${origin}/api/document-shares/${client.id}`, {
    headers: { 'X-Share-Token': token, Cookie: `${DEVICE_COOKIE}=not-a-live-secret` },
  });
  assert.equal(tokenRead.status, 200, 'a share-token read never consults the device cookie');
});
