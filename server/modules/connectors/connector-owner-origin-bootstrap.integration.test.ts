/**
 * Pre-origin owner wizard end to end, on its own database: production step-up,
 * production readiness (CSRF from the step-up session store), and the first
 * origin bind through the production owner-setup routes. The bind persists an
 * origin, so this file owns its database and leaves no state behind.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express from 'express';

/* eslint-disable boundaries/dependencies -- integration test boots the real database. */
import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';

/* eslint-enable boundaries/dependencies */
// eslint-disable-next-line boundaries/no-unknown
import { hashPassword } from '../../services/password.service.js';
// eslint-disable-next-line boundaries/no-unknown
import { configureLoginThrottle } from '../../services/login-throttle.service.js';

import { connectorAuthProfileRuntimeForOwnerSetup } from './connector-auth-profile.routes.js';
import connectorAuthReadinessRoutes from './connector-auth-readiness.routes.js';
import connectorOwnerSessionRoutes from './connector-owner-session.production.js';
import { connectorPolicyV2OwnerSetupRoutes } from './connector-substrate-only.production.js';

const ORIGIN = 'https://nassaj.example';
const PASSWORD = 'correct horse battery';
const RECENT_COOKIE = '__Host-nassaj_connector_recent_auth';
const CSRF_COOKIE = '__Secure-nassaj_connector_csrf';
const REGISTRY_FLAG = 'NASSAJ_CONNECTOR_AUTH_REGISTRY_V1';
const SAVED_ENV = ['DATABASE_PATH', 'NASSAJ_PUBLIC_ORIGIN', REGISTRY_FLAG] as const;

let tempDirectory = '';
const savedEnv = new Map<string, string | undefined>();
let server: Server;
let baseUrl = '';
let passwordHash = '';

before(async () => {
  for (const key of SAVED_ENV) savedEnv.set(key, process.env[key]);
  process.env.NASSAJ_PUBLIC_ORIGIN = ORIGIN;
  delete process.env[REGISTRY_FLAG];
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'connector-origin-bootstrap-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
  await initializeDatabase();
  passwordHash = await hashPassword(PASSWORD);
  // The auth middleware configures the step-up password throttle at load (ADR-212);
  // authentication is replaced here, so configure it as that module does, on this database.
  configureLoginThrottle('connector-step-up-test-secret-0123456789abcdef');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = userDb.getUserById(Number(req.get('x-test-user')));
    if (user) (req as express.Request & { user: unknown }).user = { id: user.id, role: user.role };
    next();
  });
  app.use('/api/connectors/owner-session', connectorOwnerSessionRoutes);
  app.use('/api/connectors/auth-readiness', connectorAuthReadinessRoutes);
  app.use('/api/connectors/v2/owner/setup', connectorPolicyV2OwnerSetupRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeConnection();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tempDirectory, { recursive: true, force: true });
});

const setCookies = (response: Response): Map<string, string> => new Map(response.headers.getSetCookie()
  .map(line => line.split(';', 1)[0] ?? '')
  .map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)] as [string, string]));

const ownerSetup = async (userId: number) => (await fetch(`${baseUrl}/api/connectors/v2/owner/setup`, {
  headers: { 'x-test-user': String(userId) },
})).json() as Promise<{
  origin: { canonicalOrigin: string } | null; originProposal: { canonicalOrigin: string | null };
}>;

const readiness = async (userId: number, cookie: string) => {
  const response = await fetch(`${baseUrl}/api/connectors/auth-readiness`, {
    headers: { 'x-test-user': String(userId), cookie },
  });
  return { status: response.status, body: await response.json() as { csrfToken: string | null } };
};

test('pre-origin owner wizard: step-up, readiness CSRF, first origin bind, CSRF kept after', async () => {
  const owner = userDb.createUser('origin_bootstrap_owner', passwordHash, 'owner');
  const member = userDb.createUser('origin_bootstrap_member', passwordHash, 'user');
  const before = await ownerSetup(owner.id);
  assert.equal(before.origin, null);
  assert.equal(before.originProposal.canonicalOrigin, ORIGIN);

  const stepUp = await fetch(`${baseUrl}/api/connectors/owner-session/step-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-test-user': String(owner.id) },
    body: JSON.stringify({ stepUp: { method: 'password', password: PASSWORD } }),
  });
  assert.equal(stepUp.status, 204);
  const cookies = setCookies(stepUp);
  const cookie = `${RECENT_COOKIE}=${cookies.get(RECENT_COOKIE)}; ${CSRF_COOKIE}=${cookies.get(CSRF_COOKIE)}`;
  const pre = await readiness(owner.id, cookie);
  assert.equal(pre.status, 200);
  assert.equal(pre.body.csrfToken, cookies.get(CSRF_COOKIE));
  const csrf = pre.body.csrfToken!;

  const bind = (userId: number, token: string) => fetch(`${baseUrl}/api/connectors/v2/owner/setup/origin`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json', origin: ORIGIN, 'x-test-user': String(userId), cookie,
      'x-csrf-token': token, 'if-match': '"0"', 'idempotency-key': `origin-bind-${userId}-${token.slice(0, 8)}`,
    },
    body: JSON.stringify({ canonicalOrigin: ORIGIN, expectedOriginRevision: 0 }),
  });
  assert.equal((await bind(owner.id, 'f'.repeat(64))).status, 403, 'a wrong CSRF token is still refused');
  assert.equal((await bind(member.id, csrf)).status, 404, 'members never reach the origin bind');
  const bound = await bind(owner.id, csrf);
  assert.equal(bound.status, 200, await bound.clone().text());
  assert.equal((await ownerSetup(owner.id)).origin?.canonicalOrigin, ORIGIN);

  // Post-save: the persisted origin now names the cookies; the same session keeps its token.
  const post = await readiness(owner.id, cookie);
  assert.equal(post.status, 200);
  assert.equal(post.body.csrfToken, csrf);

  // Registry flag on: the profile runtime can now be composed (origin persisted) and
  // readiness lists profiles while still returning the step-up CSRF token.
  connectorAuthProfileRuntimeForOwnerSetup();
  process.env[REGISTRY_FLAG] = '1';
  const flagged = await readiness(owner.id, cookie);
  assert.equal(flagged.status, 200);
  assert.equal(flagged.body.csrfToken, csrf);
  assert.equal((await readiness(member.id, cookie)).body.csrfToken, null,
    'a session belongs to its own user only');
});
