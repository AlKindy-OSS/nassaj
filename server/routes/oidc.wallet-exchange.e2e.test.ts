/**
 * ADR-194 A3 (owner decision 2026-10-18): multi-account switching is excluded
 * by SSO. On an SSO node the wallet is off even with MULTI_ACCOUNT_SWITCHING
 * set to "true": a linked member who signs in at the IdP gets a bearer JWT
 * from POST /oidc/exchange, never a device cookie; a wallet cookie minted
 * while SSO was off is dead once SSO is enabled (and stays dead if SSO is
 * turned off again); /accounts answers 404; a bearer survives the upgrade; and
 * a mode change between login start and redemption fails safely. The real
 * auth and OIDC routers, runtime, verifier, auth middleware and database run
 * against the in-process mock OpenID Provider.
 *
 * (Formerly the ADR-163 amendment 1 A-1 wallet-exchange test: the SSO wallet
 * hand-off it covered is unreachable since A3.)
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test, { after, before, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createMockOpenIdProvider } from '../services/__tests__/mock-openid-provider.js';
import { useWalletOriginEnv } from '../utils/__tests__/wallet-origin-env.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
for (const key of ['OIDC_ENABLED', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI']) delete process.env[key];

mock.module(url('../middleware/rate-limit.js'), { namedExports: { createRateLimiter: () => passThrough } });
mock.module(url('../modules/account-wallet/user-identity-revocation.js'), {
  namedExports: { revokeUserIdentity: () => ({ abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 }) },
});
mock.module(url('../services/notification-orchestrator.js'), {
  namedExports: { createNotificationEvent: (event: unknown) => event, notifyUserIfEnabled: () => {} },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });

const { initializeDatabase } = await import('../modules/database/init-db.js');
const { stopReconcileScheduler } = await import('../modules/database/project-reconcile.service.js');
const { getConnection } = await import('../modules/database/connection.js');
const { deviceAccountSessionsDb, userDb, userIdentitiesDb } = await import('../modules/database/index.js');
const { clearSsoConfig, writeSsoRow, FIXTURE_ISSUER } = await import('../services/__tests__/sso-config-fixture.js');
const { resetSsoConfigCacheForTests } = await import('../services/sso-config.service.js');
const { enableSso } = await import('../services/sso-apply.service.js');
const { applySsoBootPolicy, disableSso } = await import('../services/sso-lifecycle.service.js');
const { setSsoNetworkOverridesForTests } = await import('../services/sso-oidc-runtime.service.js');
const { BROWSER_TRANSACTION_COOKIE } = await import('../services/oidc-browser-transaction.js');
await initializeDatabase();
stopReconcileScheduler();

const { default: authRouter } = await import('./auth.js');
const { authenticateToken, generateToken } = await import('../middleware/auth.js');
const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.get('/api/probe', authenticateToken, (req, res) => {
  res.json({ userId: (req as unknown as { user: { id: number } }).user.id });
});
const server: Server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as AddressInfo).port;
const baseUrl = `http://127.0.0.1:${port}`;
const previousFlag = process.env.MULTI_ACCOUNT_SWITCHING;
let restoreOriginEnv = () => {};

before(() => {
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  ({ restore: restoreOriginEnv } = useWalletOriginEnv(port));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousFlag === undefined) delete process.env.MULTI_ACCOUNT_SWITCHING;
  else process.env.MULTI_ACCOUNT_SWITCHING = previousFlag;
  restoreOriginEnv();
});

const db = getConnection();
const owner = userDb.createUser('wallet_sso_owner', 'hash-owner', 'owner');
const member = userDb.createUser('wallet_sso_member', 'hash-member', 'user');
const MEMBER_CLAIMS = { sub: 'sub-wallet-member', roles: ['member'], org: 'org-1' };
const DAY_MS = 24 * 60 * 60 * 1000;
let op = createMockOpenIdProvider();

beforeEach(() => {
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  clearSsoConfig(db);
  db.exec('DELETE FROM user_identities;');
  userIdentitiesDb.link(member.id, FIXTURE_ISSUER, MEMBER_CLAIMS.sub);
  resetSsoConfigCacheForTests();
  op = createMockOpenIdProvider();
  setSsoNetworkOverridesForTests(op.network);
  writeSsoRow(db);
});

const deviceCookie = (secret: string) => `__Host-nassaj_device=${encodeURIComponent(secret)}`;
const deviceCookieOf = (response: Response) => response.headers.getSetCookie()
  .find((cookie) => cookie.startsWith('__Host-nassaj_device='));
const probe = (headers: Record<string, string>) => fetch(`${baseUrl}/api/probe`, { headers });
const statusBody = async () => (await fetch(`${baseUrl}/api/auth/status`)).json();

/** GET /oidc/login, IdP sign-in, callback → one-time code. */
async function signInAtIdp() {
  const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const transactionCookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  assert.ok(transactionCookie.startsWith(`${BROWSER_TRANSACTION_COOKIE}=`));
  const { code, state } = op.authorize(login.headers.get('location') ?? '', MEMBER_CLAIMS);
  const callback = await fetch(`${baseUrl}/api/auth/oidc/callback?${new URLSearchParams({ state, code })}`, {
    headers: { cookie: transactionCookie }, redirect: 'manual',
  });
  const location = new URL(callback.headers.get('location') ?? '', 'https://app.example');
  const oneTimeCode = location.searchParams.get('oidc_code');
  assert.ok(oneTimeCode, `callback handed off a code (${location.search})`);
  return { oneTimeCode, transactionCookie };
}

function exchange(oneTimeCode: string, cookies: string[], origin: string | null = baseUrl) {
  return fetch(`${baseUrl}/api/auth/oidc/exchange`, {
    method: 'POST',
    body: JSON.stringify({ code: oneTimeCode }),
    headers: {
      'Content-Type': 'application/json', cookie: cookies.filter(Boolean).join('; '),
      ...(origin ? { Origin: origin } : {}),
    },
  });
}

test('A3: with the flag "true" and SSO active, an SSO sign-in answers a bearer JWT, never a device cookie', async () => {
  for (const flag of ['true', undefined]) {
    if (flag === undefined) delete process.env.MULTI_ACCOUNT_SWITCHING;
    else process.env.MULTI_ACCOUNT_SWITCHING = flag;
    assert.equal((await statusBody()).deviceAccountSessionsEnabled, false, `flag ${flag}: wallet off`);
    const { oneTimeCode, transactionCookie } = await signInAtIdp();
    const response = await exchange(oneTimeCode, [transactionCookie]);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.token, 'string', 'a bearer JWT');
    assert.equal(body.wallet, undefined);
    assert.match(deviceCookieOf(response) ?? '__Host-nassaj_device=;', /^__Host-nassaj_device=;/u,
      'no device secret is set (at most a clearing cookie)');
    const bearer = await probe({ authorization: `Bearer ${body.token}` });
    assert.equal(bearer.status, 200);
    assert.equal((await bearer.json()).userId, member.id);
  }
});

test('A3: a wallet cookie from before SSO is 401 after enable, /accounts is 404, and it never revives', async () => {
  writeSsoRow(db, { enabled: 0 });
  resetSsoConfigCacheForTests();
  db.exec('DELETE FROM user_identities;'); // SSO off: no member link enforces it
  assert.equal((await statusBody()).deviceAccountSessionsEnabled, true, 'SSO off: wallet on');
  const device = deviceAccountSessionsDb.create(owner.id, DAY_MS);
  const cookie = { cookie: deviceCookie(device.secret), origin: baseUrl };
  assert.equal((await probe(cookie)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/accounts`, { headers: cookie })).status, 200);

  enableSso({ actorUserId: owner.id });
  const after = await probe(cookie);
  assert.equal(after.status, 401, 'the cookie is not an identity any more');
  const accounts = await fetch(`${baseUrl}/api/auth/accounts`, { headers: cookie });
  assert.equal(accounts.status, 404, 'the wallet routes are gone, so the SPA takes the bearer path (no loop)');
  assert.equal((await statusBody()).deviceAccountSessionsEnabled, false);
  assert.equal(deviceAccountSessionsDb.resolve(device.secret), null, 'revoked in the enable transaction');

  disableSso({ actorUserId: owner.id, afterCommit: () => {} });
  assert.equal((await statusBody()).deviceAccountSessionsEnabled, true, 'SSO off again: wallet on');
  assert.equal((await probe(cookie)).status, 401, 'the old device session stays revoked');
});

test('A3: a bearer survives the upgrade boot that revokes the wallet', async () => {
  writeSsoRow(db, { enabled: 0 });
  db.exec('DELETE FROM user_identities;');
  resetSsoConfigCacheForTests();
  const device = deviceAccountSessionsDb.create(owner.id, DAY_MS);
  const token = generateToken(owner);
  writeSsoRow(db); // the upgraded node already has SSO enabled
  applySsoBootPolicy({ afterCommit: () => {} });
  assert.equal(deviceAccountSessionsDb.resolve(device.secret), null, 'boot revoked the wallet');
  const bearer = await probe({ authorization: `Bearer ${token}` });
  assert.equal(bearer.status, 200);
  assert.equal((await bearer.json()).userId, owner.id);
});

test('A3: SSO sign-in clears a stale device cookie; after SSO is disabled the bearer still works', async () => {
  writeSsoRow(db, { enabled: 0 });
  db.exec('DELETE FROM user_identities;');
  resetSsoConfigCacheForTests();
  const device = deviceAccountSessionsDb.create(owner.id, DAY_MS);
  enableSso({ actorUserId: owner.id }); // revokes the session; the browser keeps the cookie
  userIdentitiesDb.link(member.id, FIXTURE_ISSUER, MEMBER_CLAIMS.sub);
  const { oneTimeCode, transactionCookie } = await signInAtIdp();
  const response = await exchange(oneTimeCode, [transactionCookie, deviceCookie(device.secret)]);
  assert.equal(response.status, 200);
  assert.match(deviceCookieOf(response) ?? '', /^__Host-nassaj_device=;/u, 'the exchange clears the cookie');
  const { token } = await response.json();

  // Owner keeps linked sessions (from active), so the member's bearer stays valid.
  disableSso({ actorUserId: owner.id, keepLinkedSessions: true, afterCommit: () => {} });
  assert.equal((await statusBody()).deviceAccountSessionsEnabled, true, 'the wallet is back');
  // A browser that missed the clearing still sends the revoked cookie beside its bearer.
  const both = await probe({ authorization: `Bearer ${token}`, cookie: deviceCookie(device.secret) });
  assert.equal(both.status, 200, 'not 400 ambiguous_authentication');
  assert.equal((await both.json()).userId, member.id);
  assert.match(deviceCookieOf(both) ?? '', /^__Host-nassaj_device=;/u, 'the stale cookie is cleared');
});

test('A3: a LIVE device session beside a bearer stays ambiguous (400)', async () => {
  disableSso({ actorUserId: owner.id, afterCommit: () => {} });
  const device = deviceAccountSessionsDb.create(owner.id, DAY_MS);
  const res = await probe({ authorization: `Bearer ${generateToken(owner)}`, cookie: deviceCookie(device.secret) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'ambiguous_authentication');
});

test('A3: SSO turned off between login start and redemption refuses the code safely', async () => {
  const { oneTimeCode, transactionCookie } = await signInAtIdp();
  disableSso({ actorUserId: owner.id, afterCommit: () => {} });
  assert.equal((await statusBody()).deviceAccountSessionsEnabled, true, 'the node is now in wallet mode');
  const response = await exchange(oneTimeCode, [transactionCookie]);
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.token, undefined);
  assert.equal(body.wallet, undefined);
  assert.equal(deviceCookieOf(response), undefined, 'no device session from an SSO code');
});

test('A3: a cross-site login start is not refused while the wallet is off (gate L2 is wallet-only)', async () => {
  const response = await fetch(`${baseUrl}/api/auth/oidc/login`, {
    redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') ?? '', /^https:\/\/idp\.example\/authorize\?/u);
});
