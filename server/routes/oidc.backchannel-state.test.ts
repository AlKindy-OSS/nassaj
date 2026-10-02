/**
 * ADR-194 D1 back-channel column (T-1962 S1/S3) with the REAL state model and
 * a real database: 501 only when the policy is not enforced; while enforced
 * the logout is verified with the row's issuer, client id and PINNED jwks_uri
 * (also for broken rows, never a fresh discovery), legacy env uses discovery
 * under the `public` policy, and anything unverifiable (unreadable state,
 * unparseable row or env) asks the IdP to retry (503 + Retry-After). Owner
 * subjects are never revoked. Only the verifier's network half and live-access
 * side effects are faked.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
const verifierUrl = url('../services/oidc-verifier.service.js');
const realVerifier = await import(verifierUrl);
let logoutSubject = 'sub-member';
let builtWith: Array<Record<string, unknown>> = [];

mock.module(verifierUrl, {
  namedExports: {
    ...realVerifier,
    createOidcVerifier: (options: Record<string, unknown>) => {
      builtWith.push(options);
      realVerifier.parseExactHttpsIssuer(options.issuer);
      if (options.endpoints && typeof (options.endpoints as { jwks_uri?: unknown }).jwks_uri !== 'string') {
        throw new Error('invalid_pinned_endpoints');
      }
      return { issuer: options.issuer, verifyLogoutToken: async () => ({ sub: logoutSubject }) };
    },
  },
});
mock.module(url('../middleware/rate-limit.js'), { namedExports: { createRateLimiter: () => passThrough } });
mock.module(url('../modules/account-wallet/user-identity-revocation.js'), {
  namedExports: { revokeUserIdentity: () => ({ abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 }) },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });

const ISSUER = 'https://idp.example';

const { initializeDatabase } = await import('../modules/database/init-db.js');
const { stopReconcileScheduler } = await import('../modules/database/project-reconcile.service.js');
const { getConnection } = await import('../modules/database/connection.js');
const { userDb, userIdentitiesDb } = await import('../modules/database/index.js');
const { writeDisabledRecordOn } = await import('../modules/database/repositories/sso-oidc-config.js');
const { migrateSsoOidcConfig } = await import('../modules/database/sso-oidc-config.migration.js');
const { clearSsoConfig, writeSsoRow } = await import('../services/__tests__/sso-config-fixture.js');
const { resetSsoConfigCacheForTests } = await import('../services/sso-config.service.js');
const { setSsoNetworkOverridesForTests } = await import('../services/sso-oidc-runtime.service.js');
await initializeDatabase();
stopReconcileScheduler();

const { default: oidcRouter } = await import('./oidc.js');
const app = express();
app.use(express.json());
app.use('/api/auth/oidc', oidcRouter);
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const member = userDb.createUser('bc_member', 'hash-member', 'user');
const owner = userDb.createUser('bc_owner', 'hash-owner', 'owner');
const ENV_KEYS = ['OIDC_ENABLED', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'NASSAJ_SSO_FORCE_OFF'] as const;

beforeEach(() => {
  const db = getConnection();
  migrateSsoOidcConfig(db);
  clearSsoConfig(db);
  db.exec('DELETE FROM user_identities');
  for (const key of ENV_KEYS) delete process.env[key];
  resetSsoConfigCacheForTests();
  setSsoNetworkOverridesForTests({});
  logoutSubject = 'sub-member';
  builtWith = [];
});

const linkMember = () => userIdentitiesDb.link(member.id, ISSUER, 'sub-member');
const envVerifier = () => Object.assign(process.env, { OIDC_ISSUER_URL: ISSUER, OIDC_CLIENT_ID: 'nassaj-client' });
const stamp = (userId = member.id) => (getConnection()
  .prepare('SELECT password_changed_at AS v FROM users WHERE id = ?').get(userId) as { v: number | null }).v;

async function logout() {
  return fetch(`${baseUrl}/api/auth/oidc/backchannel-logout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logout_token: 'logout-token-synthetic' }),
  });
}

const CASES: Array<{ label: string; setup: () => void; status: number; revokes?: boolean }> = [
  { label: 'fresh install', setup: () => { envVerifier(); }, status: 501 },
  { label: 'no row, no env, non-owner link', setup: () => { linkMember(); }, status: 503 },
  { label: 'active, valid, enabled', setup: () => { linkMember(); writeSsoRow(getConnection()); },
    status: 200, revokes: true },
  { label: 'broken row without a parseable verifier', setup: () => {
    linkMember(); writeSsoRow(getConnection(), { pinned_endpoints_json: null });
  }, status: 503 },
  { label: 'broken row (persisted runtime fault) verifies with the pinned jwks_uri', setup: () => {
    linkMember(); writeSsoRow(getConnection(), { runtime_fault: 'discovery_endpoint_changed' });
  }, status: 200, revokes: true },
  { label: 'broken row (undecryptable secret) verifies without the secret', setup: () => {
    linkMember(); writeSsoRow(getConnection(), { client_auth: 'client_secret_basic', client_secret_enc: 'ssooidc:v1:x' });
  }, status: 200, revokes: true },
  { label: 'broken row with an unparseable issuer', setup: () => {
    linkMember(); writeSsoRow(getConnection(), { issuer: 'http://idp.example' });
  }, status: 503 },
  { label: 'read throws, even with env that would parse', setup: () => {
    linkMember(); envVerifier(); getConnection().exec('DROP TABLE sso_oidc_config');
  }, status: 503 },
  { label: 'read throws, no verifier', setup: () => { linkMember(); getConnection().exec('DROP TABLE sso_oidc_config'); },
    status: 503 },
  { label: 'legacy env with issuer and client', setup: () => {
    linkMember(); envVerifier(); process.env.OIDC_ENABLED = 'true';
  }, status: 200, revokes: true },
  { label: 'legacy env with an unparseable issuer', setup: () => {
    linkMember(); envVerifier(); process.env.OIDC_ENABLED = 'true'; process.env.OIDC_ISSUER_URL = 'http://idp.example';
  }, status: 503 },
  { label: 'owner disabled', setup: () => {
    linkMember(); envVerifier(); writeDisabledRecordOn(getConnection(), 'owner', Date.now());
  }, status: 501 },
  { label: 'FORCE_OFF applied', setup: () => {
    linkMember(); envVerifier(); process.env.NASSAJ_SSO_FORCE_OFF = '1';
    writeDisabledRecordOn(getConnection(), 'force_off', Date.now());
  }, status: 501 },
];

for (const { label, setup, status, revokes = false } of CASES) {
  test(`back-channel matrix: ${label} → ${status}`, async (t) => {
    t.mock.method(process.stderr, 'write', () => true);
    setup();
    const before = stamp();
    const response = await logout();
    assert.equal(response.status, status);
    if (status === 503) assert.equal(response.headers.get('retry-after'), '300');
    assert.equal(stamp() !== before, revokes, revokes ? 'the member is revoked' : 'nothing is revoked');
  });
}

test('an unknown subject is a 200 no-op while enforced', async () => {
  linkMember();
  writeSsoRow(getConnection());
  logoutSubject = `unknown-${crypto.randomUUID()}`;
  const before = stamp();
  assert.equal((await logout()).status, 200);
  assert.equal(stamp(), before);
});

test('a broken row is verified with its pinned jwks_uri only, never by discovery', async () => {
  linkMember();
  writeSsoRow(getConnection(), { runtime_fault: 'discovery_endpoint_changed', allow_private_network: 1 });
  assert.equal((await logout()).status, 200);
  const options = builtWith.at(-1) as { endpoints: Record<string, string>; network: { addressPolicy: string } };
  assert.deepEqual(Object.keys(options.endpoints), ['jwks_uri']);
  assert.equal(options.endpoints.jwks_uri, 'https://idp.example/jwks');
  assert.equal(options.network.addressPolicy, 'private_allowed', 'the row policy applies');
});

test('legacy env verifies by discovery under the public policy', async () => {
  linkMember();
  envVerifier();
  process.env.OIDC_ENABLED = 'true';
  assert.equal((await logout()).status, 200);
  const options = builtWith.at(-1) as { endpoints?: unknown; network: { addressPolicy: string } };
  assert.equal(options.endpoints, undefined);
  assert.equal(options.network.addressPolicy, 'public');
});

test('ADR-194 D6: a subject linked to an owner is a 200 no-op', async () => {
  linkMember();
  userIdentitiesDb.link(owner.id, ISSUER, 'sub-owner');
  writeSsoRow(getConnection());
  logoutSubject = 'sub-owner';
  const before = stamp(owner.id);
  assert.equal((await logout()).status, 200);
  assert.equal(stamp(owner.id), before, 'owner sessions are never revoked by the IdP');
});
