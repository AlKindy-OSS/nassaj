/**
 * T-1939 6B end to end: the PRODUCTION step-up wiring
 * (connector-owner-session.production.ts: real verifier, real StepUpError
 * narrowing, real per-user route limiter, real audit de-duplication) on a
 * real database whose connector substrate was composed by initializeDatabase
 * (real runtime fence, real session adapter, NASSAJ_PUBLIC_ORIGIN bootstrap
 * origin), into the real operation gates. Only authentication is replaced (a
 * header names the caller).
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express from 'express';

/* eslint-disable boundaries/dependencies -- integration test boots the real database and session store. */
import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
import { userDb } from '@/modules/database/repositories/users.js';

import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';
/* eslint-enable boundaries/dependencies */
// eslint-disable-next-line boundaries/no-unknown -- the grant store the OIDC callback fills.
import { oidcStepUpGrantStore } from '../../services/oidc-step-up-grant.store.js';
// eslint-disable-next-line boundaries/no-unknown
import { hashPassword } from '../../services/password.service.js';

import {
  configureConnectorOwnerAuthSessionProduction,
  connectorOwnerSessionAvailable,
  connectorOwnerSessionOrigin,
  createRecentAuthOriginSource,
} from './connector-owner-auth-session.js';
import { createConnectorOwnerOperationGate } from './connector-owner-operation-gate.js';
import connectorOwnerSessionRoutes from './connector-owner-session.production.js';
import { executeConnectorPolicyV2LifecycleWrite } from './connector-substrate-only.production.js';

const ORIGIN = 'https://nassaj.example';
const PASSWORD = 'correct horse battery';
const TXN = 'T'.repeat(43);
const RECENT_COOKIE = '__Host-nassaj_connector_recent_auth';
const CSRF_COOKIE = '__Secure-nassaj_connector_csrf';

let tempDirectory = '';
let previousDatabasePath: string | undefined;
let previousPublicOrigin: string | undefined;
let server: Server;
let baseUrl = '';
let passwordHash = '';
let userSeq = 0;
let configureOrigin: (resolveOrigin: () => string | null) => void = () => undefined;

before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  previousPublicOrigin = process.env.NASSAJ_PUBLIC_ORIGIN;
  process.env.NASSAJ_PUBLIC_ORIGIN = ORIGIN;
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'connector-step-up-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
  await initializeDatabase();
  passwordHash = await hashPassword(PASSWORD);
  assert.equal(connectorOwnerSessionAvailable(), true, 'the substrate composed the session adapter');
  assert.equal(connectorOwnerSessionOrigin(), ORIGIN, 'pre-origin bootstrap from NASSAJ_PUBLIC_ORIGIN');

  const database = getConnection();
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  configureOrigin = resolveOrigin => configureConnectorOwnerAuthSessionProduction({
    repository, installationId, resolveOrigin, executeWrite: executeConnectorPolicyV2LifecycleWrite,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = userDb.getUserById(Number(req.get('x-test-user')));
    if (user) (req as express.Request & { user: unknown }).user = { id: user.id, role: user.role };
    next();
  });
  app.use('/api/connectors/owner-session', connectorOwnerSessionRoutes);
  const gate = (operation: 'upsert_personal_api_key' | 'upsert_byo', ownerOnly: boolean) =>
    createConnectorOwnerOperationGate({ repository, installationId, canonicalOrigin: ORIGIN, operation, ownerOnly });
  const done: express.RequestHandler = (_req, res) => { res.status(204).end(); };
  app.post('/api/connectors/member-operation', gate('upsert_personal_api_key', false), done);
  app.post('/api/connectors/owner-operation', gate('upsert_byo', true), done);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousPublicOrigin === undefined) delete process.env.NASSAJ_PUBLIC_ORIGIN;
  else process.env.NASSAJ_PUBLIC_ORIGIN = previousPublicOrigin;
  await rm(tempDirectory, { recursive: true, force: true });
});

const newUser = (role: 'owner' | 'user' = 'user') => {
  userSeq += 1;
  return userDb.createUser(`connector_step_up_${userSeq}`, passwordHash, role);
};

const stepUp = (userId: number, stepUpEvidence: unknown, cookie?: string) => fetch(
  `${baseUrl}/api/connectors/owner-session/step-up`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', origin: ORIGIN, 'x-test-user': String(userId),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ stepUp: stepUpEvidence }),
  },
);

/** name → value of every Set-Cookie on the response (empty value = cleared). */
const setCookies = (response: Response): Map<string, string> => new Map(response.headers.getSetCookie()
  .map(line => line.split(';', 1)[0] ?? '')
  .map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)] as [string, string]));

const operate = (route: string, userId: number, cookies: Map<string, string>) => fetch(`${baseUrl}${route}`, {
  method: 'POST',
  headers: {
    origin: ORIGIN, 'x-test-user': String(userId),
    cookie: `${RECENT_COOKIE}=${cookies.get(RECENT_COOKIE)}`,
    'x-csrf-token': cookies.get(CSRF_COOKIE) ?? '',
  },
});

const sessionMethod = (userId: number): string | undefined => (getConnection().prepare(
  `SELECT auth_method FROM connector_owner_auth_sessions
   WHERE user_id = ? AND revoked_at_ms IS NULL ORDER BY auth_time_ms DESC LIMIT 1`,
).get(userId) as { auth_method: string } | undefined)?.auth_method;

const auditReasons = (userId: number): string[] => (getConnection().prepare(
  "SELECT metadata FROM audit_log WHERE action = 'connector_step_up_failure' AND user_id = ? ORDER BY id",
).all(userId) as Array<{ metadata: string }>).map(row => (JSON.parse(row.metadata) as { reason: string }).reason);

const withOidc = async (run: () => Promise<void>) => {
  const saved = process.env.OIDC_ENABLED;
  process.env.OIDC_ENABLED = 'true';
  try { await run(); } finally {
    if (saved === undefined) delete process.env.OIDC_ENABLED;
    else process.env.OIDC_ENABLED = saved;
  }
};

test('a member password step-up opens member gates and is refused at owner gates', async () => {
  const member = newUser('user');
  const response = await stepUp(member.id, { method: 'password', password: PASSWORD });
  assert.equal(response.status, 204);
  const cookies = setCookies(response);
  assert.match(cookies.get(RECENT_COOKIE) ?? '', /^[a-f0-9]{64}$/u);
  assert.match(cookies.get(CSRF_COOKIE) ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(sessionMethod(member.id), 'password');

  assert.equal((await operate('/api/connectors/member-operation', member.id, cookies)).status, 204);
  const owner = await operate('/api/connectors/owner-operation', member.id, cookies);
  assert.equal(owner.status, 403);
  assert.equal(((await owner.json()) as { code: string }).code, 'CONNECTOR_OWNER_REQUIRED');

  const ownerUser = newUser('owner');
  const ownerCookies = setCookies(await stepUp(ownerUser.id, { method: 'password', password: PASSWORD }));
  assert.equal((await operate('/api/connectors/owner-operation', ownerUser.id, ownerCookies)).status, 204);
  assert.equal((await operate('/api/connectors/owner-operation', ownerUser.id, cookies)).status, 403,
    'a session belongs to its own user only');
});

test('the real verifier quota answers 429 with Retry-After and is audited once per window', async () => {
  const member = newUser('user');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const refused = await stepUp(member.id, { method: 'password', password: `wrong-${attempt}` });
    assert.equal(refused.status, 401);
    assert.equal(((await refused.json()) as { code: string }).code, 'step_up_failed');
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const limited = await stepUp(member.id, { method: 'password', password: PASSWORD });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      error: 'Too many verification attempts, please try again later', code: 'step_up_rate_limited',
    });
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(limited.headers.getSetCookie().length, 0);
  }
  assert.deepEqual(auditReasons(member.id), [
    'bad_password', 'bad_password', 'bad_password', 'bad_password', 'bad_password', 'step_up_rate_limited',
  ]);
});

test('the production route limiter is keyed per user (20 per minute)', async () => {
  const noisy = newUser('user');
  const quiet = newUser('user');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // Missing evidence is refused before the verifier quota, so only the route limiter counts it.
    assert.equal((await stepUp(noisy.id, undefined)).status, 403);
  }
  const limited = await stepUp(noisy.id, undefined);
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { code: string }).code, 'step_up_rate_limited');
  assert.equal((await stepUp(quiet.id, undefined)).status, 403, 'another user has its own bucket');
});

test('an SSO-linked member steps up with a real OIDC grant and the transaction cookie', async () => {
  const member = newUser('user');
  userIdentitiesDb.link(member.id, 'https://idp.example', `sub-${member.id}`);
  await withOidc(async () => {
    const password = await stepUp(member.id, { method: 'password', password: PASSWORD });
    assert.equal(password.status, 403);
    assert.equal(((await password.json()) as { code: string }).code, 'sso_step_up_required');

    const grant = oidcStepUpGrantStore.issue({
      userId: member.id, audience: 'connector_owner', browserTransaction: TXN,
    }) as string;
    const response = await stepUp(member.id, { method: 'oidc_grant', grant }, `__Host-oidc-txn=${TXN}`);
    assert.equal(response.status, 204);
    const cookies = setCookies(response);
    assert.equal(cookies.get('__Host-oidc-txn'), '', 'the browser transaction is cleared');
    assert.equal(sessionMethod(member.id), 'oidc');
    assert.equal((await operate('/api/connectors/member-operation', member.id, cookies)).status, 204);

    const replay = await stepUp(member.id, { method: 'oidc_grant', grant }, `__Host-oidc-txn=${TXN}`);
    assert.equal(replay.status, 401, 'the grant is single use');
  });
});

test('a tampered persisted origin fails closed: 503 and no cookie, never the environment origin', async () => {
  const member = newUser('user');
  configureOrigin(createRecentAuthOriginSource({
    readPersisted: () => { throw new Error('connector_origin_database_tampered'); },
    readProposal: () => ORIGIN,
  }));
  try {
    const response = await stepUp(member.id, { method: 'password', password: PASSWORD });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { code: string }).code, 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED');
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(sessionMethod(member.id), undefined);
  } finally {
    configureOrigin(() => ORIGIN);
  }
});

test('the step-up router is mounted under /api/connectors behind authenticateToken', async () => {
  const serverRoot = path.resolve(import.meta.dirname, '../..');
  const index = await readFile(path.join(serverRoot, 'index.js'), 'utf8');
  const connectors = await readFile(path.join(import.meta.dirname, 'connectors.routes.ts'), 'utf8');
  assert.match(index, /app\.use\('\/api\/connectors', authenticateToken, connectorsRoutes\)/u);
  assert.match(connectors,
    /import connectorOwnerSessionRoutes from '\.\/connector-owner-session\.production\.js';/u);
  assert.match(connectors, /router\.use\('\/owner-session', connectorOwnerSessionRoutes\)/u);
});
