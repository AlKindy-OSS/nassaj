/**
 * ADR-163 amendment 1, slice A stage A3 (T9, T9b, T17, M8, flag-off): primary
 * password and passkey logins issue a NEW device session through
 * issueDeviceSession, revoke the device the browser presented, keep each
 * method's surrounding steps, and renew by sliding window. The real auth and
 * passkey routers, middleware and SQLite run together; only the WebAuthn
 * assertion verifier and the connector owner session are doubles.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

import {
  closeConnection, DEVICE_IDLE_TTL_MS, deviceAccountSessionsDb, getConnection, initializeDatabase, userDb,
  WalletConflictError,
} from '../modules/database/index.js';
import { connectionRevocationRegistry } from '../modules/account-wallet/index.js';
import { hashPassword } from '../services/password.service.js';
import { useWalletOriginEnv } from '../utils/__tests__/wallet-origin-env.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const PASSWORD = 'correct horse battery staple';
const DAY = 24 * 60 * 60 * 1000;

let passkeyUser: { id: number; username: string; role: string; must_change_password: number } | null = null;
const ownerSessions: Array<{ userId: number; method: string }> = [];
const realWebAuthn = await import(url('../services/webauthn.service.js'));
mock.module(url('../services/webauthn.service.js'), {
  namedExports: {
    ...realWebAuthn,
    verifyAuthentication: async () => ({
      user: passkeyUser, credentialId: 'credential-a3', userVerified: true, stepUpEligible: true,
    }),
  },
});
mock.module(url('../modules/connectors/connector-owner-auth-session.js'), {
  namedExports: {
    recordConnectorOwnerAuthentication: (_res: unknown, userId: number, method: string) => {
      ownerSessions.push({ userId, method });
    },
    clearConnectorOwnerAuthentication: () => {},
  },
});
mock.module(url('./oidc.js'), { defaultExport: express.Router() });

let server: Server;
let origin: string;
let passwordHash: string;
let sequence = 0;
let authenticateDeviceWebSocket: (secret: string) => unknown;
const previousFlag = process.env.MULTI_ACCOUNT_SWITCHING;
let restoreOriginEnv = () => {};

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  await initializeDatabase();
  passwordHash = await hashPassword(PASSWORD);
  const { default: router } = await import('./auth.js');
  const middleware = await import('../middleware/auth.js');
  authenticateDeviceWebSocket = middleware.authenticateDeviceWebSocket;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  app.get('/api/probe', middleware.authenticateToken, (req, res) => {
    res.json({ userId: (req as unknown as { user: { id: number } }).user.id });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  ({ origin, restore: restoreOriginEnv } = useWalletOriginEnv((server.address() as AddressInfo).port));
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (previousFlag === undefined) delete process.env.MULTI_ACCOUNT_SWITCHING;
  else process.env.MULTI_ACCOUNT_SWITCHING = previousFlag;
  restoreOriginEnv();
});

function account(role = 'user') {
  const created = userDb.createUser(`a3_user_${++sequence}`, passwordHash, role as 'user');
  return { ...created, must_change_password: 0 };
}

function withFlagOff<T>(run: () => Promise<T>): Promise<T> {
  process.env.MULTI_ACCOUNT_SWITCHING = 'false';
  return run().finally(() => { process.env.MULTI_ACCOUNT_SWITCHING = 'true'; });
}

const deviceCookieOf = (response: Response) => response.headers.getSetCookie()
  .find((cookie) => cookie.startsWith('__Host-nassaj_device='));
const secretOf = (cookie: string | undefined) => decodeURIComponent(cookie?.split(';', 1)[0]?.split('=')[1] ?? '');
const maxAgeOf = (cookie: string | undefined) => Number(/Max-Age=(\d+)/u.exec(cookie ?? '')?.[1]);

// A distinct client address per request keeps the per-IP login limiter out of the way.
let clientAddress = 0;
const freshIp = () => ({ 'CF-Connecting-IP': `198.51.${Math.floor(++clientAddress / 250)}.${clientAddress % 250}` });

function post(route: string, body: object, headers: Record<string, string> = {}) {
  return fetch(`${origin}/api/auth${route}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...freshIp(), ...headers },
  });
}
const passwordLogin = (username: string, headers?: Record<string, string>) =>
  post('/login', { username, password: PASSWORD }, headers);
const passkeyLogin = (headers?: Record<string, string>) =>
  post('/webauthn/login/verify', { response: { id: 'assertion' } }, headers);
const probe = (secret: string) => fetch(`${origin}/api/probe`, {
  headers: { Cookie: `__Host-nassaj_device=${encodeURIComponent(secret)}` },
});
const audits = (userId: number, action: string) => getConnection()
  .prepare('SELECT metadata FROM audit_log WHERE user_id = ? AND action = ?').all(userId, action) as Array<{ metadata: string }>;

async function assertDeviceLogin(response: Response, userId: number) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.token, undefined, 'no JWT in wallet mode');
  assert.equal(body.success, true);
  assert.equal(body.user.id, userId);
  assert.match(body.csrfToken, /^\d+\.[A-Za-z0-9_-]+$/u);
  assert.equal(body.wallet.accounts.length, 1);
  const cookie = deviceCookieOf(response);
  assert.ok(cookie, 'a device cookie is set');
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.ok(Math.abs(maxAgeOf(cookie) - DEVICE_IDLE_TTL_MS / 1000) <= 2, 'M6: Max-Age is the idle window');
  assert.equal((await probe(secretOf(cookie))).status, 200, 'the cookie authenticates REST');
  return secretOf(cookie);
}

test('T9: password login issues a device session and keeps B-1407, audit and last-login', async () => {
  const user = account();
  ownerSessions.length = 0;
  await assertDeviceLogin(await passwordLogin(user.username), user.id);
  assert.deepEqual(ownerSessions, [{ userId: user.id, method: 'password' }]);
  assert.equal(audits(user.id, 'login_success').length, 1);
  assert.ok(userDb.getUserById(user.id)?.last_login, 'last login updated');
});

test('T9: a legacy bcrypt hash is still upgraded on a wallet-mode login', async () => {
  const user = account();
  const { default: bcrypt } = await import('bcrypt');
  userDb.setPasswordHash(user.id, await bcrypt.hash(PASSWORD, 4));
  await assertDeviceLogin(await passwordLogin(user.username), user.id);
  const row = getConnection().prepare('SELECT password_hash AS hash FROM users WHERE id = ?').get(user.id) as { hash: string };
  assert.match(row.hash, /^\$argon2id\$/u);
});

test('T9: passkey login issues a device session and keeps B-1407 and audit', async () => {
  const user = account();
  passkeyUser = user;
  ownerSessions.length = 0;
  await assertDeviceLogin(await passkeyLogin(), user.id);
  assert.deepEqual(ownerSessions, [{ userId: user.id, method: 'webauthn' }]);
  const [audit] = audits(user.id, 'login_success');
  assert.equal(JSON.parse(audit?.metadata ?? '{}').method, 'passkey');
});

test('wallet mode: passkey login needs the trusted Origin before verifying anything', async () => {
  passkeyUser = account();
  const foreign = await passkeyLogin({ Origin: 'https://attacker.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).code, 'origin_rejected');
  assert.equal(deviceCookieOf(foreign), undefined);
});

test('T9b: a primary login replaces the presented device; the old secret dies on REST and WS', async () => {
  const first = account();
  const second = account();
  const oldSecret = await assertDeviceLogin(await passwordLogin(first.username), first.id);
  const old = deviceAccountSessionsDb.resolve(oldSecret)!;
  deviceAccountSessionsDb.add(old.principal, second.id, second.password_changed_at, old.wallet.generation);
  const closed: Array<number | undefined> = [];
  connectionRevocationRegistry.register({ close: (code) => closed.push(code) }, old.principal);

  const response = await passwordLogin(second.username, { Cookie: `__Host-nassaj_device=${encodeURIComponent(oldSecret)}` });
  const newSecret = await assertDeviceLogin(response, second.id);
  assert.notEqual(newSecret, oldSecret, 'a fresh secret');
  assert.deepEqual(closed, [4401], 'live connections of the old device are closed');
  const stale = await probe(oldSecret);
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).code, 'device_session_invalid');
  const accounts = await fetch(`${origin}/api/auth/accounts`, { headers: { Cookie: `__Host-nassaj_device=${oldSecret}` } });
  assert.equal(accounts.status, 401);
  assert.equal(authenticateDeviceWebSocket(oldSecret), null, 'WS upgrade refused for the old secret');
  assert.ok(authenticateDeviceWebSocket(newSecret));
});

test('T9b: a passkey login also rotates the presented device', async () => {
  const first = account();
  const oldSecret = await assertDeviceLogin(await passwordLogin(first.username), first.id);
  passkeyUser = first;
  const newSecret = await assertDeviceLogin(
    await passkeyLogin({ Cookie: `__Host-nassaj_device=${encodeURIComponent(oldSecret)}` }), first.id,
  );
  assert.notEqual(newSecret, oldSecret);
  assert.equal(deviceAccountSessionsDb.resolve(oldSecret), null);
});

test('M8: must_change_password keeps its limited branch and completes into a device session', async () => {
  const user = account();
  getConnection().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(user.id);
  const login = await passwordLogin(user.username);
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.equal(body.passwordChangeRequired, true);
  assert.equal(deviceCookieOf(login), undefined, 'no device session before rotation');
  const limited = login.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-nassaj_password_change='));
  assert.ok(limited);
  const csrf = await fetch(`${origin}/api/auth/mutation-csrf?method=PATCH&path=/api/auth/me/password`, {
    headers: { Cookie: limited.split(';', 1)[0]!, Origin: origin },
  });
  const change = await fetch(`${origin}/api/auth/me/password`, {
    method: 'PATCH',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'another long passphrase' }),
    headers: {
      Cookie: limited.split(';', 1)[0]!, Origin: origin, 'Content-Type': 'application/json',
      'X-CSRF-Token': (await csrf.json()).csrfToken,
    },
  });
  assert.equal(change.status, 200);
  assert.ok((await change.json()).wallet, 'rotation establishes the wallet');
  assert.equal((await probe(secretOf(deviceCookieOf(change)))).status, 200);
});

test('wallet mode: a passkey login for a forced rotation is refused, not issued', async () => {
  const user = account();
  getConnection().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(user.id);
  passkeyUser = { ...user, must_change_password: 1 };
  const response = await passkeyLogin();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'password_change_required');
  assert.equal(deviceCookieOf(response), undefined);
  assert.equal(audits(user.id, 'login_success').length, 0);
});

test('flag off: password and passkey logins answer the legacy JWT and touch no device', async () => {
  const user = account();
  const existing = deviceAccountSessionsDb.create(user.id, DEVICE_IDLE_TTL_MS);
  const cookie = { Cookie: `__Host-nassaj_device=${encodeURIComponent(existing.secret)}` };
  passkeyUser = user;
  await withFlagOff(async () => {
    for (const response of [await passwordLogin(user.username, cookie), await passkeyLogin(cookie)]) {
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(typeof body.token, 'string');
      assert.equal(body.wallet, undefined);
      assert.equal(deviceCookieOf(response), undefined);
    }
    const noOrigin = await fetch(`${origin}/api/auth/webauthn/login/verify`, {
      method: 'POST', body: JSON.stringify({ response: {} }), headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(noOrigin.status, 200, 'legacy passkey login needs no Origin');
  });
  assert.ok(deviceAccountSessionsDb.resolve(existing.secret), 'the presented device is untouched');
});

test('T17: a REST request past half-life renews the cookie with a new Max-Age', async () => {
  const user = account();
  const secret = await assertDeviceLogin(await passwordLogin(user.username), user.id);
  const { deviceSessionId } = deviceAccountSessionsDb.resolve(secret)!.principal;
  const now = Date.now();
  getConnection().prepare('UPDATE device_sessions SET expires_at = ?, created_at = ? WHERE id = ?')
    .run(now + DAY, now - 6 * DAY, deviceSessionId);
  const renewed = await probe(secret);
  assert.equal(renewed.status, 200);
  const cookie = deviceCookieOf(renewed);
  assert.equal(secretOf(cookie), secret, 'same secret, re-issued');
  assert.ok(Math.abs(maxAgeOf(cookie) - DEVICE_IDLE_TTL_MS / 1000) <= 2);
  const wallet = await fetch(`${origin}/api/auth/accounts`, { headers: { Cookie: `__Host-nassaj_device=${secret}` } });
  assert.equal(wallet.status, 200);
  assert.equal(deviceCookieOf(wallet), undefined, 'nothing to renew right after a renewal');
});

test('T17: a failing renewal never fails the request', async (t) => {
  const user = account();
  const secret = await assertDeviceLogin(await passwordLogin(user.username), user.id);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(deviceAccountSessionsDb, 'slideExpiry', () => { throw new Error('database is locked'); });
  const response = await probe(secret);
  assert.equal(response.status, 200);
  assert.equal(deviceCookieOf(response), undefined);
});

/** Signs in with the forced-change password and completes the rotation, carrying `extraCookie`. */
async function completeForcedRotation(username: string, extraCookie: string) {
  const login = await passwordLogin(username, { Cookie: extraCookie });
  const limited = login.headers.getSetCookie()
    .find((cookie) => cookie.startsWith('__Host-nassaj_password_change='))!.split(';', 1)[0]!;
  const cookie = `${limited}; ${extraCookie}`;
  const csrf = await fetch(`${origin}/api/auth/mutation-csrf?method=PATCH&path=/api/auth/me/password`, {
    headers: { Cookie: limited, Origin: origin },
  });
  return fetch(`${origin}/api/auth/me/password`, {
    method: 'PATCH',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'another long passphrase' }),
    headers: {
      Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...freshIp(),
      'X-CSRF-Token': (await csrf.json()).csrfToken,
    },
  });
}

test('B-1529 T9b: completing a forced rotation rotates the presented device; nothing merges', async () => {
  const first = account();
  const second = account();
  const forced = account();
  const oldSecret = await assertDeviceLogin(await passwordLogin(first.username), first.id);
  const old = deviceAccountSessionsDb.resolve(oldSecret)!;
  deviceAccountSessionsDb.add(old.principal, second.id, second.password_changed_at, old.wallet.generation);
  const closed: Array<number | undefined> = [];
  connectionRevocationRegistry.register({ close: (code) => closed.push(code) }, old.principal);
  getConnection().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(forced.id);

  const change = await completeForcedRotation(forced.username, `__Host-nassaj_device=${encodeURIComponent(oldSecret)}`);
  assert.equal(change.status, 200);
  const body = await change.json();
  assert.deepEqual(body.wallet.accounts.map((slot: { displayName: string }) => slot.displayName), [forced.username],
    'no slots carried over');
  const cookie = deviceCookieOf(change);
  assert.ok(Math.abs(maxAgeOf(cookie) - DEVICE_IDLE_TTL_MS / 1000) <= 2, 'Max-Age is set');
  const fresh = secretOf(cookie);
  assert.notEqual(fresh, oldSecret);
  assert.equal((await probe(fresh)).status, 200);
  const stale = await probe(oldSecret);
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).code, 'device_session_invalid');
  assert.deepEqual(closed, [4401], 'the prior device connections are closed');
});

function failIssuance(t: { mock: { method: typeof mock.method } }) {
  t.mock.method(deviceAccountSessionsDb, 'rotateDevice', () => {
    throw new WalletConflictError('account_ineligible');
  });
}

test('L3: a failed password-login issuance records no success, no last login, no owner session', async (t) => {
  const user = account();
  ownerSessions.length = 0;
  failIssuance(t);
  const response = await passwordLogin(user.username);
  assert.equal(response.status, 401);
  assert.equal(deviceCookieOf(response), undefined);
  assert.deepEqual(ownerSessions, []);
  assert.equal(audits(user.id, 'login_success').length, 0);
  assert.equal(JSON.parse(audits(user.id, 'login_failure')[0]?.metadata ?? '{}').reason, 'account_ineligible');
  assert.equal(userDb.getUserById(user.id)?.last_login, null);
});

test('L3: a failed passkey-login issuance records no success, no last login, no owner session', async (t) => {
  const user = account();
  passkeyUser = user;
  ownerSessions.length = 0;
  failIssuance(t);
  const response = await passkeyLogin();
  assert.equal(response.status, 401);
  assert.equal(deviceCookieOf(response), undefined);
  assert.deepEqual(ownerSessions, []);
  assert.equal(audits(user.id, 'login_success').length, 0);
  assert.equal(audits(user.id, 'login_failure').length, 1);
  assert.equal(userDb.getUserById(user.id)?.last_login, null);
});

async function limitedSession(user: { username: string }) {
  const login = await passwordLogin(user.username);
  assert.equal(login.status, 200);
  const limited = login.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-nassaj_password_change='));
  assert.ok(limited);
  return limited.split(';', 1)[0]!;
}

test('B-1533: the forced-rotation cookie answers /user flagged, and a wrong temporary password is coded', async () => {
  const user = account();
  getConnection().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(user.id);
  const cookie = await limitedSession(user);
  const identity = await fetch(`${origin}/api/auth/user`, { headers: { Cookie: cookie, Origin: origin } });
  assert.equal(identity.status, 200);
  const body = await identity.json();
  assert.equal(body.user.id, user.id);
  assert.equal(body.user.mustChangePassword, true);
  assert.equal(body.passwordChangeSession, true);
  assert.equal((await fetch(`${origin}/api/probe`, { headers: { Cookie: cookie } })).status, 401,
    'the limited cookie still opens nothing else');

  const csrf = await fetch(`${origin}/api/auth/mutation-csrf?method=PATCH&path=/api/auth/me/password`, {
    headers: { Cookie: cookie, Origin: origin },
  });
  const wrong = await fetch(`${origin}/api/auth/me/password`, {
    method: 'PATCH',
    body: JSON.stringify({ currentPassword: 'not the temporary one', newPassword: 'another long passphrase' }),
    headers: {
      Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...freshIp(),
      'X-CSRF-Token': (await csrf.json()).csrfToken,
    },
  });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).code, 'current_password_incorrect');
  const after = await fetch(`${origin}/api/auth/user`, { headers: { Cookie: cookie, Origin: origin } });
  assert.equal(after.status, 200, 'a wrong attempt keeps the limited session');
});

test('B-1533: an ordinary /user answer is not flagged as a password-change session', async () => {
  const user = account();
  const secret = await assertDeviceLogin(await passwordLogin(user.username), user.id);
  const identity = await fetch(`${origin}/api/auth/user`, {
    headers: { Cookie: `__Host-nassaj_device=${encodeURIComponent(secret)}` },
  });
  assert.equal(identity.status, 200);
  assert.equal((await identity.json()).passwordChangeSession, undefined);
});

async function newInvite() {
  const { createInvite } = await import('../services/invite.service.js');
  const owner = account('owner');
  return (await createInvite({ id: owner.id, role: 'owner' }, { role: 'user' })).token as string;
}

test('B-1534: wallet mode: an invite join answers a device session, not a JWT', async () => {
  const token = await newInvite();
  const response = await post('/invite/accept', { token, username: `joiner_${++sequence}`, password: PASSWORD });
  const body = await response.clone().json();
  await assertDeviceLogin(response, body.user.id);
});

test('B-1534: wallet mode: an untrusted origin is refused before the invite is consumed', async () => {
  const token = await newInvite();
  const username = `joiner_${++sequence}`;
  const refused = await post('/invite/accept', { token, username, password: PASSWORD },
    { Origin: 'https://evil.example' });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'origin_rejected');
  assert.equal(deviceCookieOf(refused), undefined);
  const accepted = await post('/invite/accept', { token, username, password: PASSWORD });
  assert.equal(accepted.status, 200, 'the invite is still usable from the trusted origin');
});

test('B-1534: flag off: an invite join keeps answering the legacy JWT', async () => {
  const token = await newInvite();
  await withFlagOff(async () => {
    const response = await post('/invite/accept', { token, username: `joiner_${++sequence}`, password: PASSWORD });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.token, 'string');
    assert.equal(body.wallet, undefined);
    assert.equal(deviceCookieOf(response), undefined);
  });
});

/** Starts (and abandons) another account's forced password change; returns its limited cookie. */
async function abandonedForcedChange() {
  const other = account();
  getConnection().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(other.id);
  const login = await passwordLogin(other.username);
  return login.headers.getSetCookie()
    .find((cookie) => cookie.startsWith('__Host-nassaj_password_change='))!.split(';', 1)[0]!;
}

/** Applies a response's Set-Cookie headers to a simple name → value jar, honoring clears. */
function applyCookies(jar: Map<string, string>, response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';', 1);
    const [name, value = ''] = pair!.split('=');
    if (value === '' || /Expires=Thu, 01 Jan 1970/u.test(header)) jar.delete(name!);
    else jar.set(name!, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function assertDeviceIdentityAfter(response: Response, limited: string, userId: number) {
  assert.equal(response.status, 200);
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-nassaj_password_change=;')),
    'the abandoned password-change cookie is cleared');
  const [name, value] = limited.split('=');
  const cookies = applyCookies(new Map([[name!, value!]]), response);
  assert.doesNotMatch(cookies, /__Host-nassaj_password_change/u);
  const current = await fetch(`${origin}/api/auth/user`, { headers: { Cookie: cookies, Origin: origin } });
  assert.equal(current.status, 200);
  const body = await current.json();
  assert.equal(body.user.id, userId, 'GET /user answers the device identity');
  assert.equal(body.passwordChangeSession, undefined);
}

test('P1: a passkey sign-in clears another account\'s abandoned password-change cookie', async () => {
  const limited = await abandonedForcedChange();
  const user = account();
  passkeyUser = user;
  await assertDeviceIdentityAfter(await passkeyLogin({ Cookie: limited }), limited, user.id);
});

test('P1: an invite acceptance clears another account\'s abandoned password-change cookie', async () => {
  const limited = await abandonedForcedChange();
  const inviter = account('owner');
  const { createInvite } = await import('../services/invite.service.js');
  const { token } = await createInvite({ id: inviter.id, role: 'owner' }, { role: 'user' });
  const username = `a3_invitee_${++sequence}`;
  const response = await post('/invite/accept', { token, username, password: PASSWORD }, { Cookie: limited });
  await assertDeviceIdentityAfter(response, limited, userDb.getUserByUsername(username)!.id);
});

// W1: /user goes through authenticatePasswordChange, so a leftover forced-change cookie
// (browser-session lifetime, inner JWT ten minutes) must not lock a signed-in user out.
const W1_COOKIE = '__Host-nassaj_password_change';
const clearsLimitedCookie = (response: Response) => response.headers.getSetCookie()
  .some((cookie) => cookie.startsWith(`${W1_COOKIE}=;`));

/** A forced-change cookie for a user under rotation whose inner JWT already expired. */
async function expiredLimitedCookie() {
  const { default: jwt } = await import('jsonwebtoken');
  const { JWT_SECRET } = await import('../middleware/auth.js');
  const other = account();
  getConnection().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(other.id);
  const row = userDb.getUserById(other.id) as { password_changed_at: number | null };
  const token = jwt.sign({
    userId: other.id, pwd_iat: row.password_changed_at ?? 0, purpose: 'password_change',
    exp: Math.floor(Date.now() / 1000) - 60,
  }, JWT_SECRET, { algorithm: 'HS256' });
  return `${W1_COOKIE}=${encodeURIComponent(token)}`;
}

/** Flag off: a legacy password login, answering its Bearer header. */
async function legacyBearer(user: { username: string }) {
  const response = await passwordLogin(user.username);
  assert.equal(response.status, 200);
  return `Bearer ${(await response.json()).token as string}`;
}

const getUser = (headers: Record<string, string>) =>
  fetch(`${origin}/api/auth/user`, { headers: { Origin: origin, ...headers } });

test('W1: an expired forced-change cookie beside a valid Bearer answers the Bearer and is cleared', async () => {
  const limited = await expiredLimitedCookie();
  const user = account();
  await withFlagOff(async () => {
    const response = await getUser({ Cookie: limited, Authorization: await legacyBearer(user) });
    assert.equal(response.status, 200);
    assert.ok(clearsLimitedCookie(response), 'the stale cookie is cleared');
    const body = await response.json();
    assert.equal(body.user.id, user.id);
    assert.equal(body.passwordChangeSession, undefined);
  });
});

test('W1: an expired forced-change cookie alone falls back to normal auth and is cleared', async () => {
  const limited = await expiredLimitedCookie();
  await withFlagOff(async () => {
    const response = await getUser({ Cookie: limited });
    assert.equal(response.status, 401, 'no other credential: normal auth refuses');
    assert.ok(clearsLimitedCookie(response));
  });
  // Wallet mode: the device session the browser also holds answers instead.
  const user = account();
  const secret = await assertDeviceLogin(await passwordLogin(user.username), user.id);
  const response = await getUser({ Cookie: `${limited}; __Host-nassaj_device=${encodeURIComponent(secret)}` });
  assert.equal(response.status, 200);
  assert.ok(clearsLimitedCookie(response));
  assert.equal((await response.json()).user.id, user.id);
});

test('W1: a superseded forced-change cookie (rotation already done) is cleared, not honored', async () => {
  const limited = await abandonedForcedChange();
  const id = Number(JSON.parse(Buffer.from(decodeURIComponent(limited.split('=')[1]!).split('.')[1]!,
    'base64url').toString()).userId);
  getConnection().prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
  const user = account();
  await withFlagOff(async () => {
    const response = await getUser({ Cookie: limited, Authorization: await legacyBearer(user) });
    assert.equal(response.status, 200);
    assert.ok(clearsLimitedCookie(response));
    assert.equal((await response.json()).user.id, user.id);
  });
});

test('W1: a live forced-change cookie beside a current Bearer yields to the Bearer', async () => {
  const limited = await abandonedForcedChange();
  const user = account();
  await withFlagOff(async () => {
    const response = await getUser({ Cookie: limited, Authorization: await legacyBearer(user) });
    assert.equal(response.status, 200);
    assert.ok(clearsLimitedCookie(response));
    const body = await response.json();
    assert.equal(body.user.id, user.id);
    assert.equal(body.passwordChangeSession, undefined);
  });
});

test('W1: a live forced-change cookie beside a non-current Bearer stays ambiguous', async () => {
  const limited = await abandonedForcedChange();
  await withFlagOff(async () => {
    for (const authorization of ['Bearer not-a-jwt', 'Basic abc']) {
      const response = await getUser({ Cookie: limited, Authorization: authorization });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'ambiguous_authentication');
      assert.equal(clearsLimitedCookie(response), false, 'the live limited session is kept');
    }
  });
});

test('W1: flag off: passkey and invite sign-ins clear an abandoned forced-change cookie', async () => {
  const user = account();
  passkeyUser = user;
  const token = await newInvite();
  await withFlagOff(async () => {
    const passkey = await passkeyLogin({ Cookie: await abandonedForcedChange() });
    assert.equal(passkey.status, 200);
    assert.equal(typeof (await passkey.json()).token, 'string');
    assert.ok(clearsLimitedCookie(passkey), 'passkey');
    const invite = await post('/invite/accept', { token, username: `joiner_${++sequence}`, password: PASSWORD },
      { Cookie: await abandonedForcedChange() });
    assert.equal(invite.status, 200);
    assert.equal(typeof (await invite.json()).token, 'string');
    assert.ok(clearsLimitedCookie(invite), 'invite');
  });
});

test('W1: Bearer-wins never bypasses a forced change: same user, live cookie and Bearer → 403', async () => {
  const user = account();
  await withFlagOff(async () => {
    // A current Bearer minted before the rotation was demanded, then the live limited cookie.
    const authorization = await legacyBearer(user);
    getConnection().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(user.id);
    const limited = await limitedSession(user);
    const response = await getUser({ Cookie: limited, Authorization: authorization });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'password_change_required');
    assert.ok(clearsLimitedCookie(response), 'the limited cookie is cleared');
  });
});
