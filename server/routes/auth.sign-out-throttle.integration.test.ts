/**
 * T-2035 (ADR-212): sign-out ends every JWT of the user, and password checks
 * are throttled per identifier. The real auth router, middleware and SQLite
 * run together; only the connector owner session and the OIDC router are
 * doubles, and the realtime layer is a recording binding.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';
import jwt from 'jsonwebtoken';

import {
  closeConnection, getConnection, initializeDatabase, revokedTokenSidsDb, userDb,
} from '../modules/database/index.js';
import { bindUserRealtimeRevocation } from '../modules/account-wallet/user-realtime-revocation.js';
import {
  isTokenSidRevoked,
  legacyTokenSid,
  registerTokenSessionSocket,
} from '../modules/account-wallet/token-session.js';
import { hashPassword } from '../services/password.service.js';
import { createLoginThrottle } from '../services/login-throttle.service.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const PASSWORD = 'correct horse battery staple';
const DAY_S = 24 * 60 * 60;

mock.module(url('../modules/connectors/connector-owner-auth-session.js'), {
  namedExports: {
    recordConnectorOwnerAuthentication: () => {},
    clearConnectorOwnerAuthentication: () => {},
  },
});
mock.module(url('./oidc.js'), { defaultExport: express.Router() });

type Revocation = { userId: number; revocation: unknown };
const realtimeRevocations: Revocation[] = [];
let server: Server;
let origin: string;
let passwordHash: string;
let sequence = 0;
let ipSequence = 0;
let secret: string;
let authenticateWebSocket: (token: string | null) => unknown;
let TOKEN_TTL_MS = 0;
let REFRESH_GRACE_MS = 0;
let unbindRealtime = () => {};
const previousFlag = process.env.MULTI_ACCOUNT_SWITCHING;

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  process.env.MULTI_ACCOUNT_SWITCHING = 'false';
  await initializeDatabase();
  passwordHash = await hashPassword(PASSWORD);
  const { default: router } = await import('./auth.js');
  const middleware = await import('../middleware/auth.js');
  secret = middleware.JWT_SECRET;
  authenticateWebSocket = middleware.authenticateWebSocket;
  TOKEN_TTL_MS = middleware.TOKEN_TTL_MS;
  REFRESH_GRACE_MS = middleware.REFRESH_GRACE_MS;
  unbindRealtime = bindUserRealtimeRevocation((userId, revocation) => {
    realtimeRevocations.push({ userId, revocation });
    return { abortedRuns: 0, closedSockets: 2, endedInteractiveSessions: 0 };
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  app.get('/api/probe', middleware.authenticateToken, (_req, res) => { res.json({ ok: true }); });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  unbindRealtime();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (previousFlag === undefined) delete process.env.MULTI_ACCOUNT_SWITCHING;
  else process.env.MULTI_ACCOUNT_SWITCHING = previousFlag;
});

/** A fresh client address per scenario, so the per-IP authLimiter never interferes. */
const freshIp = () => `198.51.100.${++ipSequence}`;

function account(role: 'user' | 'owner' = 'user') {
  return userDb.createUser(`t2035_user_${++sequence}`, passwordHash, role);
}

function post(route: string, body: unknown, { token, ip }: { token?: string; ip: string }) {
  return fetch(`${origin}/api/auth${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function probe(token: string) {
  return fetch(`${origin}/api/probe`, { headers: { authorization: `Bearer ${token}` } });
}

async function login(username: string, password: string, ip: string) {
  return post('/login', { username, password }, { ip });
}

/** Signs a session token the way generateToken does, with explicit timing/epoch. */
function signSession(
  user: { id: number; username: string },
  { iatOffsetS = 0, ttlS = 7 * DAY_S, tokEp, sid }: {
    iatOffsetS?: number; ttlS?: number; tokEp?: number; sid?: string;
  } = {},
) {
  const row = userDb.getRawById(user.id)!;
  const iat = Math.floor(Date.now() / 1000) + iatOffsetS;
  return jwt.sign({
    userId: user.id, username: user.username, role: row.role,
    pwd_iat: row.password_changed_at ?? 0, auth_gen: row.authorization_generation,
    ...(tokEp === undefined ? {} : { tok_ep: tokEp }), ...(sid === undefined ? {} : { sid }),
    iat, exp: iat + ttlS,
  }, secret);
}

const generationOf = (id: number) => userDb.getRawById(id)!.authorization_generation;
const auditRows = (action: string) => getConnection()
  .prepare('SELECT user_id AS userId, metadata FROM audit_log WHERE action = ? ORDER BY id')
  .all(action) as Array<{ userId: number | null; metadata: string | null }>;

test('logout ends only this device: REST, WS, refresh and grace refresh refuse A; B stays signed in', async () => {
  const user = account();
  const ip = freshIp();
  const deviceA = (await (await login(user.username, PASSWORD, ip)).json()).token as string;
  const deviceB = (await (await login(user.username, PASSWORD, freshIp())).json()).token as string;
  const sidA = (jwt.decode(deviceA) as { sid: string }).sid;
  const sidB = (jwt.decode(deviceB) as { sid: string }).sid;
  assert.match(sidA, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(sidA, sidB, 'each sign-in mints its own device session');
  const expiredA = signSession(user, { iatOffsetS: -7 * DAY_S - 3600, tokEp: 0, sid: sidA });
  assert.equal((await post('/refresh', {}, { token: expiredA, ip })).status, 200, 'grace control');
  const closed: string[] = [];
  const untagA = registerTokenSessionSocket(sidA, () => closed.push('A'));
  const untagB = registerTokenSessionSocket(sidB, () => closed.push('B'));
  const generation = generationOf(user.id);
  realtimeRevocations.length = 0;

  try {
    const logout = await post('/logout', {}, { token: deviceA, ip });
    assert.equal(logout.status, 200);
    assert.equal((await logout.json()).scope, 'device');

    assert.equal((await probe(deviceA)).status, 401);
    assert.equal(authenticateWebSocket(deviceA), null);
    assert.equal((await post('/refresh', {}, { token: deviceA, ip })).status, 401);
    const grace = await post('/refresh', {}, { token: expiredA, ip });
    assert.equal(grace.status, 401);
    assert.deepEqual(await grace.json(), { error: 'Token invalidated' });

    assert.equal((await probe(deviceB)).status, 200, 'the other device is untouched');
    assert.ok(authenticateWebSocket(deviceB));
    assert.deepEqual(closed, ['A'], "only device A's sockets close (4401)");
    assert.deepEqual(realtimeRevocations, [], 'no user-wide socket revocation');
    assert.equal(userDb.getTokenEpoch(user.id), 0, 'a device sign-out never bumps the epoch');
    assert.equal(generationOf(user.id), generation);
    const audit = auditRows('logout').filter((row) => row.userId === user.id);
    assert.deepEqual(audit.map((row) => JSON.parse(row.metadata ?? '{}')), [{ scope: 'device' }]);
  } finally {
    untagA();
    untagB();
  }
});

test('a refreshed token keeps its sid and dies with its device sign-out', async () => {
  const user = account();
  const ip = freshIp();
  const original = (await (await login(user.username, PASSWORD, ip)).json()).token as string;
  const sid = (jwt.decode(original) as { sid: string }).sid;
  const refreshed = (await (await post('/refresh', {}, { token: original, ip })).json()).token as string;
  assert.equal((jwt.decode(refreshed) as { sid: string }).sid, sid, 'POST /refresh keeps the sid');
  const pastHalfLife = signSession(user, { iatOffsetS: -4 * DAY_S, tokEp: 0, sid });
  const coalesced = (await probe(pastHalfLife)).headers.get('x-refreshed-token');
  assert.ok(coalesced);
  assert.equal((jwt.decode(coalesced) as { sid: string }).sid, sid, 'auto-refresh keeps the sid');
  const expired = signSession(user, { iatOffsetS: -7 * DAY_S - 3600, tokEp: 0, sid });
  const graced = (await (await post('/refresh', {}, { token: expired, ip })).json()).token as string;
  assert.equal((jwt.decode(graced) as { sid: string }).sid, sid, 'grace refresh keeps the sid');

  assert.equal((await post('/logout', {}, { token: refreshed, ip })).status, 200);
  for (const token of [original, refreshed, coalesced, graced]) assert.equal((await probe(token)).status, 401);
});

test('a pre-release token without sid is a device session of its own (derived sid)', async () => {
  const user = account();
  const ip = freshIp();
  const legacy = signSession(user, { tokEp: 0 });
  const legacyOther = signSession(user, { tokEp: 0, iatOffsetS: -30 });
  assert.equal(Object.hasOwn(jwt.decode(legacy) as object, 'sid'), false);
  const other = (await (await login(user.username, PASSWORD, ip)).json()).token as string;
  assert.equal((await post('/logout', {}, { token: other, ip })).status, 200);
  assert.equal((await probe(legacy)).status, 200, "another device's sign-out does not reach it");
  assert.equal((authenticateWebSocket(legacy) as { tokenSid: string }).tokenSid, legacyTokenSid(legacy),
    'its sockets are tagged with the derived sid');

  const closed: string[] = [];
  const untag = registerTokenSessionSocket(legacyTokenSid(legacy), () => closed.push('legacy'));
  try {
    const logout = await post('/logout', {}, { token: legacy, ip });
    assert.equal(logout.status, 200);
    assert.equal((await logout.json()).scope, 'device');
  } finally {
    untag();
  }
  assert.deepEqual(closed, ['legacy'], 'its socket closes (4401)');
  assert.equal((await probe(legacy)).status, 401, 'the token itself is signed out (H1)');
  assert.equal(authenticateWebSocket(legacy), null);
  assert.equal((await post('/refresh', {}, { token: legacy, ip })).status, 401);
  assert.equal((await probe(legacyOther)).status, 200, 'a different pre-release token is another device');
  userDb.bumpTokenEpoch(user.id);
  assert.equal((await probe(legacyOther)).status, 401, 'the epoch still ends every token');
});

test('C1: a later token of a signed-out session stays revoked past the presented exp + grace', async () => {
  const user = account();
  const ip = freshIp();
  const sid = 'stolenSessionSid000000';
  // The presented token expires in an hour; a stolen copy refreshed earlier
  // would carry the same sid with an expiry up to a full TTL away.
  const presented = signSession(user, { tokEp: 0, sid, iatOffsetS: -7 * DAY_S + 3600 });
  const later = signSession(user, { tokEp: 0, sid });
  assert.equal((await post('/logout', {}, { token: presented, ip })).status, 200);
  assert.equal((await probe(later)).status, 401);
  const presentedExpMs = (jwt.decode(presented) as { exp: number }).exp * 1000;
  const laterExpMs = (jwt.decode(later) as { exp: number }).exp * 1000;
  assert.equal(isTokenSidRevoked(sid, presentedExpMs + REFRESH_GRACE_MS + 60_000), true,
    'still revoked after the presented token and its grace window are long gone');
  assert.equal(isTokenSidRevoked(sid, laterExpMs + REFRESH_GRACE_MS - 1), true,
    'revoked until every token of the session is past its grace window');
  const row = getConnection().prepare('SELECT expires_at FROM revoked_token_sids WHERE sid = ?').get(sid) as {
    expires_at: number;
  };
  assert.ok(row.expires_at >= Date.now() + TOKEN_TTL_MS, 'the row outlives any token minted before the sign-out');
});

test('H2: a recently expired bearer can still sign its device out, and is then not renewable', async () => {
  const user = account();
  const ip = freshIp();
  const sid = 'expiredDeviceSid000000';
  const expired = signSession(user, { tokEp: 0, sid, iatOffsetS: -7 * DAY_S - 3600 });
  const sibling = signSession(user, { tokEp: 0, sid, iatOffsetS: -60 });
  const logout = await post('/logout', {}, { token: expired, ip });
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).scope, 'device');
  assert.equal((await post('/refresh', {}, { token: expired, ip })).status, 401, 'no grace renewal');
  assert.equal((await probe(sibling)).status, 401, 'the whole device session is ended');
  assert.equal((await post('/logout', {}, { token: expired, ip })).status, 401,
    'an ended session cannot sign out again');
  const forged = jwt.sign({ userId: user.id, pwd_iat: 0, auth_gen: 1, iat: 1, exp: 2 }, 'not-the-secret');
  assert.equal((await post('/logout', {}, { token: forged, ip })).status, 401, 'never for a forged token');
});

test('revoked sids are pruned once their tokens can no longer be used', async () => {
  const user = account();
  const now = Date.now();
  revokedTokenSidsDb.revoke({ sid: 'expiredsid000000000000', userId: user.id, revokedAt: now - 10, expiresAt: now - 1 });
  revokedTokenSidsDb.revoke({ sid: 'livesid000000000000000', userId: user.id, revokedAt: now, expiresAt: now + 60_000 });
  const rows = getConnection().prepare('SELECT sid FROM revoked_token_sids WHERE sid IN (?, ?)')
    .all('expiredsid000000000000', 'livesid000000000000000') as Array<{ sid: string }>;
  assert.deepEqual(rows.map((row) => row.sid), ['livesid000000000000000']);
  const expiredToken = signSession(user, { tokEp: 0, sid: 'expiredsid000000000000' });
  const liveToken = signSession(user, { tokEp: 0, sid: 'livesid000000000000000' });
  assert.equal((await probe(expiredToken)).status, 200, 'an expired revocation no longer applies');
  assert.equal((await probe(liveToken)).status, 401, 'a revocation written outside this process applies at once');
});

test('a token without tok_ep is valid at epoch 0 and dies with the first sign-out', async () => {
  const user = account();
  const legacy = signSession(user);
  assert.equal(Object.hasOwn(jwt.decode(legacy) as object, 'tok_ep'), false);
  assert.equal((await probe(legacy)).status, 200, 'the deploy signs nobody out');
  assert.ok(authenticateWebSocket(legacy));
  userDb.bumpTokenEpoch(user.id);
  assert.equal((await probe(legacy)).status, 401);
  assert.equal(authenticateWebSocket(legacy), null);
});

test('the coalesced refresh token cannot outlive a sign-out', async () => {
  const user = account();
  const ip = freshIp();
  const pastHalfLife = signSession(user, { iatOffsetS: -4 * DAY_S, tokEp: 0 });
  const first = await probe(pastHalfLife);
  const cached = first.headers.get('x-refreshed-token');
  assert.ok(cached, 'auto-refresh issued a coalesced token');
  assert.equal((await probe(pastHalfLife)).headers.get('x-refreshed-token'), cached, 'coalesced');

  const logout = await post('/logout', {}, { token: pastHalfLife, ip });
  assert.equal(logout.status, 200);
  assert.equal(logout.headers.get('x-refreshed-token'), null, 'no ended-session token on the logout answer');
  assert.equal((await probe(cached)).status, 401, 'the coalesced token carried the ended sid');

  // An epoch bump (sign-out everywhere) also defeats the coalescing cache.
  // A different pre-release token (another device): the signed-out one is now
  // refused under its derived sid (H1).
  const other = signSession(user, { iatOffsetS: -4 * DAY_S - 1, tokEp: 0 });
  const beforeBump = (await probe(other)).headers.get('x-refreshed-token');
  assert.ok(beforeBump);
  userDb.bumpTokenEpoch(user.id);
  assert.equal((await probe(beforeBump)).status, 401);
  const nextEpoch = signSession(user, { iatOffsetS: -4 * DAY_S, tokEp: 1 });
  const renewed = (await probe(nextEpoch)).headers.get('x-refreshed-token');
  assert.ok(renewed);
  assert.notEqual(renewed, beforeBump);
  assert.equal((jwt.decode(renewed) as { tok_ep: number }).tok_ep, 1);
  assert.equal((await probe(renewed)).status, 200);
});

test('the sixth wrong attempt is 429 with Retry-After, identical for known and unknown identifiers', async () => {
  const user = account();
  const unknown = `nobody_${sequence}@example.test`;
  const answers: Array<{ status: number; retryAfter: string | null; body: Record<string, unknown> }> = [];
  for (const identifier of [user.username, unknown]) {
    const ip = freshIp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(identifier, 'wrong password', ip);
      assert.equal(response.status, 401);
    }
    const sixth = await login(identifier, 'wrong password', ip);
    answers.push({ status: sixth.status, retryAfter: sixth.headers.get('retry-after'), body: await sixth.json() });
  }
  for (const answer of answers) {
    assert.equal(answer.status, 429);
    const seconds = Number(answer.retryAfter);
    assert.ok(seconds >= 1 && seconds <= 60, `Retry-After ${answer.retryAfter}`);
    assert.equal(answer.body.code, 'login_temporarily_locked');
    assert.equal(answer.body.retryAfterSeconds, seconds);
  }
  const strip = ({ retryAfterSeconds: _ignored, ...rest }: Record<string, unknown>) => rest;
  assert.deepEqual(strip(answers[0].body), strip(answers[1].body));
  assert.deepEqual(Object.keys(answers[0].body).sort(), Object.keys(answers[1].body).sort());

  const lockouts = auditRows('login_lockout').slice(-2);
  assert.equal(lockouts[0].userId, user.id, 'a known account is named');
  assert.equal(lockouts[1].userId, null, 'an unknown identifier is not');
  assert.equal(lockouts.some((row) => (row.metadata ?? '').includes(unknown)), false);
});

test('a correct password during the lock is refused; a success after expiry clears the row', async () => {
  const user = account();
  const ip = freshIp();
  for (let attempt = 0; attempt < 5; attempt += 1) await login(user.username, 'wrong password', ip);
  const locked = await login(user.username, PASSWORD, ip);
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).code, 'login_temporarily_locked');

  const key = createLoginThrottle({ secret }).keyForIdentifier(user.username);
  getConnection().prepare('UPDATE login_throttle SET locked_until = ? WHERE key_hash = ?').run(Date.now() - 1, key);
  const success = await login(user.username, PASSWORD, ip);
  assert.equal(success.status, 200);
  assert.equal(getConnection().prepare('SELECT 1 FROM login_throttle WHERE key_hash = ?').get(key), undefined);
});

test('the throttle table never stores a plaintext identifier', async () => {
  const user = account();
  const unknown = `plain_${sequence}@example.test`;
  const ip = freshIp();
  await login(user.username, 'wrong password', ip);
  await login(unknown, 'wrong password', ip);
  const dump = JSON.stringify(getConnection().prepare('SELECT * FROM login_throttle').all());
  assert.ok(dump.length > 2);
  assert.equal(dump.includes(user.username), false);
  assert.equal(dump.includes(unknown), false);
  assert.equal(dump.includes('plain_'), false);
});

test('PATCH /me/password is throttled per account', async () => {
  const user = account();
  const ip = freshIp();
  const token = (await (await login(user.username, PASSWORD, ip)).json()).token as string;
  const change = (currentPassword: string) => fetch(`${origin}/api/auth/me/password`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword, newPassword: 'another long password' }),
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await change('wrong password');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'current_password_incorrect');
  }
  const locked = await change(PASSWORD);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await locked.json()).code, 'login_temporarily_locked');
  const key = createLoginThrottle({ secret }).keyForUser(user.id);
  assert.ok(getConnection().prepare('SELECT 1 FROM login_throttle WHERE key_hash = ?').get(key));
});

async function lockOut(username: string) {
  const ip = freshIp();
  for (let attempt = 0; attempt < 5; attempt += 1) await login(username, 'wrong password', ip);
  assert.equal((await login(username, PASSWORD, ip)).status, 429, 'locked');
}

test('owner break-glass: POST /users/:id/login-unlock clears the lock, owner-only and audited', async () => {
  const owner = account('owner');
  const member = account();
  const bystander = account();
  await lockOut(member.username);
  const ownerToken = (await (await login(owner.username, PASSWORD, freshIp())).json()).token as string;
  const bystanderToken = (await (await login(bystander.username, PASSWORD, freshIp())).json()).token as string;

  const refused = await post(`/users/${member.id}/login-unlock`, {}, { token: bystanderToken, ip: freshIp() });
  assert.equal(refused.status, 403);
  assert.equal((await login(member.username, PASSWORD, freshIp())).status, 429, 'still locked');

  const unlocked = await post(`/users/${member.id}/login-unlock`, {}, { token: ownerToken, ip: freshIp() });
  assert.equal(unlocked.status, 200);
  assert.ok((await unlocked.json()).cleared >= 1);
  assert.equal((await login(member.username, PASSWORD, freshIp())).status, 200);
  const audit = auditRows('login_unlocked').at(-1)!;
  assert.equal(audit.userId, owner.id);
  assert.deepEqual(JSON.parse(audit.metadata ?? '{}'), { targetUserId: member.id, cleared: 1, via: 'api' });

  assert.equal((await post('/users/999999/login-unlock', {}, { token: ownerToken, ip: freshIp() })).status, 404);
});

test('owner break-glass CLI: unlockLogin clears every throttle row of the account and audits', async () => {
  const { unlockLogin, UnlockLoginError } = await import('../scripts/unlock-login.js');
  const owner = account('owner');
  await lockOut(owner.username);
  const result = await unlockLogin(owner.username);
  assert.deepEqual(result, { userId: owner.id, cleared: 1 });
  assert.equal((await login(owner.username, PASSWORD, freshIp())).status, 200);
  assert.deepEqual(JSON.parse(auditRows('login_unlocked').at(-1)!.metadata ?? '{}'),
    { targetUserId: owner.id, cleared: 1, via: 'cli' });
  assert.deepEqual(await unlockLogin(String(owner.id)), { userId: owner.id, cleared: 0 }, 'by id, idempotent');
  await assert.rejects(unlockLogin('nobody_at_all'), (error: unknown) =>
    error instanceof UnlockLoginError && error.exitCode === 3);
});
