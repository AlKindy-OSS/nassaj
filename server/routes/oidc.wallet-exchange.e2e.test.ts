/**
 * ADR-163 amendment 1, A-1 (T9a, T9b for SSO, flag-off): on an SSO-active node
 * with MULTI_ACCOUNT_SWITCHING on, a linked member who signs in at the IdP is
 * handed a NEW device session by POST /oidc/exchange, never a JWT, so later
 * requests cannot collide into 400 ambiguous_authentication. The real OIDC
 * router, runtime, verifier, auth middleware and database run against the
 * in-process mock OpenID Provider.
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
const { deviceAccountSessionsDb, userDb, userIdentitiesDb, WalletConflictError } =
  await import('../modules/database/index.js');
const { clearSsoConfig, writeSsoRow, FIXTURE_ISSUER } = await import('../services/__tests__/sso-config-fixture.js');
const { resetSsoConfigCacheForTests } = await import('../services/sso-config.service.js');
const { setSsoNetworkOverridesForTests } = await import('../services/sso-oidc-runtime.service.js');
const { BROWSER_TRANSACTION_COOKIE } = await import('../services/oidc-browser-transaction.js');
await initializeDatabase();
stopReconcileScheduler();

const { default: oidcRouter } = await import('./oidc.js');
const { authenticateToken } = await import('../middleware/auth.js');
const app = express();
app.use(express.json());
app.use('/api/auth/oidc', oidcRouter);
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
let op = createMockOpenIdProvider();

beforeEach(() => {
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
const secretOf = (cookie: string | undefined) => decodeURIComponent(cookie?.split(';', 1)[0]?.split('=')[1] ?? '');

/** GET /oidc/login (optionally carrying a device cookie), IdP sign-in, callback → one-time code. */
async function signInAtIdp(extraCookie = '') {
  const login = await fetch(`${baseUrl}/api/auth/oidc/login`, {
    redirect: 'manual', headers: extraCookie ? { cookie: extraCookie } : {},
  });
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

test('T9a: a linked member signing in through SSO gets a device cookie, no JWT, and later 200s', async () => {
  const { oneTimeCode, transactionCookie } = await signInAtIdp();
  const response = await exchange(oneTimeCode, [transactionCookie]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.token, undefined, 'no JWT in wallet mode');
  assert.equal(body.wallet.accounts.length, 1);
  assert.match(body.csrfToken, /^\d+\.[A-Za-z0-9_-]+$/u);
  const cookie = deviceCookieOf(response);
  assert.match(cookie ?? '', /Max-Age=\d+/u);
  const probe = await fetch(`${baseUrl}/api/probe`, { headers: { cookie: deviceCookie(secretOf(cookie)) } });
  assert.equal(probe.status, 200, 'not 400 ambiguous_authentication');
  assert.equal((await probe.json()).userId, member.id);
});

test('T9a: the exchange needs the trusted Origin and stays single-use', async () => {
  const { oneTimeCode, transactionCookie } = await signInAtIdp();
  const foreign = await exchange(oneTimeCode, [transactionCookie], 'https://attacker.example');
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).code, 'origin_rejected');
  assert.equal(deviceCookieOf(foreign), undefined);
  assert.equal((await exchange(oneTimeCode, [transactionCookie])).status, 200, 'the refusal did not burn the code');
  assert.equal((await exchange(oneTimeCode, [transactionCookie])).status, 401, 'single use');
});

test('T9a: a stale attestation at redemption refuses the code', async () => {
  const { oneTimeCode, transactionCookie } = await signInAtIdp();
  db.prepare('UPDATE user_identities SET last_attested_at = 1 WHERE user_id = ?').run(member.id);
  const response = await exchange(oneTimeCode, [transactionCookie]);
  assert.equal(response.status, 401);
  assert.equal(deviceCookieOf(response), undefined);
});

test('T9a: a config apply between callback and exchange refuses with oidc_config_changed', async () => {
  const { oneTimeCode, transactionCookie } = await signInAtIdp();
  db.prepare("UPDATE sso_oidc_config SET version = version + 1 WHERE slot = 'active'").run();
  resetSsoConfigCacheForTests();
  const response = await exchange(oneTimeCode, [transactionCookie]);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'oidc_config_changed');
  assert.equal(deviceCookieOf(response), undefined);
});

test('T9b: GET /oidc/login neither binds nor merges the presented device; the exchange rotates it', async () => {
  const prior = deviceAccountSessionsDb.create(owner.id, 60_000);
  const { oneTimeCode, transactionCookie } = await signInAtIdp(deviceCookie(prior.secret));
  assert.ok(deviceAccountSessionsDb.resolve(prior.secret), 'login and callback leave the device alone');
  assert.deepEqual(deviceAccountSessionsDb.snapshot(prior.principal.deviceSessionId), prior.wallet);

  const response = await exchange(oneTimeCode, [transactionCookie, deviceCookie(prior.secret)]);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.wallet.accounts.map((slot: { displayName: string }) => slot.displayName), [member.username],
    'no slot carried over from the prior wallet');
  const fresh = secretOf(deviceCookieOf(response));
  assert.notEqual(fresh, prior.secret);
  assert.equal(deviceAccountSessionsDb.resolve(prior.secret), null, 'the presented device is revoked');
  const stale = await fetch(`${baseUrl}/api/probe`, { headers: { cookie: deviceCookie(prior.secret) } });
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).code, 'device_session_invalid');
});

test('flag off: the exchange answers the legacy JWT and touches no device', async () => {
  const prior = deviceAccountSessionsDb.create(owner.id, 60_000);
  process.env.MULTI_ACCOUNT_SWITCHING = 'false';
  try {
    const { oneTimeCode, transactionCookie } = await signInAtIdp();
    const response = await exchange(oneTimeCode, [transactionCookie, deviceCookie(prior.secret)], null);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.token, 'string');
    assert.equal(body.userId, member.id);
    assert.equal(body.wallet, undefined);
    assert.equal(deviceCookieOf(response), undefined);
  } finally {
    process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  }
  assert.ok(deviceAccountSessionsDb.resolve(prior.secret));
});

const startLogin = (secFetchSite?: string) => fetch(`${baseUrl}/api/auth/oidc/login`, {
  redirect: 'manual', headers: secFetchSite ? { 'Sec-Fetch-Site': secFetchSite } : {},
});

test('T9c (gate L2): a cross-site or same-site login start is refused with no transaction state', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const response = await startLogin(site);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/auth/oidc/return?error=oidc_login_not_initiated');
    assert.equal(response.headers.get('set-cookie'), null, `${site}: no transaction cookie`);
  }
  assert.equal(op.requests.length, 0, 'the IdP is never contacted');
});

test('T9c (gate L2): same-origin, none, or no Sec-Fetch-Site proceeds to the IdP', async () => {
  for (const site of ['same-origin', 'none', undefined]) {
    const response = await startLogin(site);
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') ?? '', /^https:\/\/idp\.example\/authorize\?/u);
    assert.match(response.headers.get('set-cookie') ?? '', new RegExp(`^${BROWSER_TRANSACTION_COOKIE}=`, 'u'));
  }
});

test('T9c (gate L2): flag off leaves a cross-site login start unchanged', async () => {
  process.env.MULTI_ACCOUNT_SWITCHING = 'false';
  try {
    const response = await startLogin('cross-site');
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') ?? '', /^https:\/\/idp\.example\/authorize\?/u);
  } finally {
    process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  }
});

const oidcAudits = (action: string) => db.prepare('SELECT metadata FROM audit_log WHERE user_id = ? AND action = ?')
  .all(member.id, action) as Array<{ metadata: string }>;

test('L3: wallet mode records the SSO login at the exchange, after issuance only', async (t) => {
  db.prepare('DELETE FROM audit_log WHERE user_id = ?').run(member.id);
  const first = await signInAtIdp();
  assert.equal(oidcAudits('oidc_login').length, 0, 'the callback records nothing in wallet mode');
  t.mock.method(deviceAccountSessionsDb, 'rotateDevice', () => {
    throw new WalletConflictError('account_ineligible');
  });
  const failed = await exchange(first.oneTimeCode, [first.transactionCookie]);
  assert.equal(failed.status, 401);
  assert.equal(oidcAudits('oidc_login').length, 0);
  assert.equal(JSON.parse(oidcAudits('login_failure')[0]?.metadata ?? '{}').reason, 'account_ineligible');
  t.mock.restoreAll();

  const second = await signInAtIdp();
  assert.equal((await exchange(second.oneTimeCode, [second.transactionCookie])).status, 200);
  assert.equal(oidcAudits('oidc_login').length, 1);
});
