/**
 * ADR-H20 S6 end to end (ADR-194 amendment A2): the REAL router, verifier,
 * pinned fetch, stores and database against the in-process mock OpenID
 * Provider. Covers the owner tier (N2's passkey step-up withdrawn 2026-10-18), N3 (login_hint), N5
 * (sid binding and the D6 matrix, kill switch), N7 (the D5 back-channel
 * standard) and N8 (silent re-check semantics). Only authentication of the
 * caller (headers stand in for a verified bearer) and rate limits are faked.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createMockOpenIdProvider } from '../services/__tests__/mock-openid-provider.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
for (const key of ['OIDC_ENABLED', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI']) delete process.env[key];

let backchannelLimiterOptions: Record<string, unknown> | null = null;
const realRateLimit = await import(url('../middleware/rate-limit.js'));
mock.module(url('../middleware/rate-limit.js'), {
  namedExports: {
    createRateLimiter: (options: Record<string, unknown>) => {
      if (String(options?.message ?? '').includes('logout notifications')) backchannelLimiterOptions = options;
      return passThrough;
    },
  },
});
const mintedSids: string[] = [];
mock.module(url('../middleware/auth.js'), {
  namedExports: {
    authenticateToken: (req: {
      headers: Record<string, string | undefined>; user?: unknown; tokenSession?: unknown;
    }, _r: unknown, next: () => void) => {
      req.user = { id: Number(req.headers['x-test-user-id']), role: String(req.headers['x-test-role'] ?? 'user') };
      const refreshSid = req.headers['x-test-refresh-sid'];
      req.tokenSession = refreshSid ? { sid: refreshSid, refreshSid, expiresAtMs: Date.now() + 60_000 } : undefined;
      next();
    },
    generateToken: (user: { id: number }, options: { sid?: string } = {}) => {
      if (options.sid) mintedSids.push(options.sid);
      return `jwt-for-${user.id}`;
    },
    invalidateRefreshCache: () => {},
    requireRole: () => passThrough,
  },
});
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
const {
  apiKeysDb, revokedTokenSidsDb, ssoDeviceSessionsDb, userDb, userIdentitiesDb,
} = await import('../modules/database/index.js');
const { clearSsoConfig, writeSsoRow, FIXTURE_ISSUER } = await import('../services/__tests__/sso-config-fixture.js');
const { resetSsoConfigCacheForTests } = await import('../services/sso-config.service.js');
const { setSsoNetworkOverridesForTests } = await import('../services/sso-oidc-runtime.service.js');
const { registerTokenSessionSocket } = await import('../modules/account-wallet/token-session.js');
const { LOGOUT_JTI_MAX_ENTRIES } = await import('../services/oidc-backchannel-logout.service.js');
const { updateSsoLinkedSettings } = await import('../services/sso-linked-settings.service.js');
const { forgetSsoDeviceSession } = await import('../services/sso-device-session.service.js');
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

const db = getConnection();
const owner = userDb.createUser('ls_owner', 'hash-owner', 'owner');
const member = userDb.createUser('ls_member', 'hash-member', 'user');
const otherMember = userDb.createUser('ls_member_two', 'hash-member', 'user');
let op = createMockOpenIdProvider();
const MEMBER = Object.freeze({ sub: 'sub-member', roles: ['member'], org: 'org-1' });
const OWNER = Object.freeze({ sub: 'sub-owner', roles: ['member'], org: 'org-1', amr: ['user', 'mfa'] });
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  clearSsoConfig(db);
  db.exec(`DELETE FROM user_identities; DELETE FROM sso_device_sessions; DELETE FROM sso_device_session_idp_sids;
    DELETE FROM oidc_logout_jtis; DELETE FROM revoked_token_sids; DELETE FROM api_keys;
    DELETE FROM app_config WHERE key LIKE 'sso.linked.%';`);
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(owner.id);
  userIdentitiesDb.link(member.id, FIXTURE_ISSUER, 'sub-member');
  userIdentitiesDb.link(otherMember.id, FIXTURE_ISSUER, 'sub-member-two');
  userIdentitiesDb.link(owner.id, FIXTURE_ISSUER, 'sub-owner');
  resetSsoConfigCacheForTests();
  op = createMockOpenIdProvider();
  setSsoNetworkOverridesForTests(op.network);
  writeSsoRow(db);
  mintedSids.length = 0;
});

type Started = { authorizationUrl: string; cookie: string };

function cookieOf(res: Response) {
  return (res.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
}

async function startLogin(query = ''): Promise<Started> {
  const res = await fetch(`${baseUrl}/api/auth/oidc/login${query}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return { authorizationUrl: res.headers.get('location') ?? '', cookie: cookieOf(res) };
}

function callback(query: Record<string, string>, cookie: string) {
  return fetch(`${baseUrl}/api/auth/oidc/callback?${new URLSearchParams(query)}`, { headers: { cookie }, redirect: 'manual' });
}

async function complete(started: Started, claims: Record<string, unknown>) {
  const { code, state } = op.authorize(started.authorizationUrl, claims);
  return callback({ state, code }, started.cookie);
}

/** Signs in through SSO and returns the bound device session id. */
async function signIn(claims: Record<string, unknown>): Promise<string> {
  const res = await complete(await startLogin(), claims);
  assert.match(res.headers.get('location') ?? '', /oidc_code=/, `signed in: ${res.headers.get('location')}`);
  const sid = mintedSids.at(-1);
  assert.ok(sid, 'a device session id was minted');
  return sid;
}

function asUser(userId: number, role: string, refreshSid?: string) {
  return {
    'content-type': 'application/json', 'x-test-user-id': String(userId), 'x-test-role': role,
    ...(refreshSid ? { 'x-test-refresh-sid': refreshSid } : {}),
  };
}

async function postJson(pathname: string, headers: Record<string, string>) {
  const res = await fetch(`${baseUrl}/api/auth/oidc${pathname}`, { method: 'POST', headers, body: '{}' });
  return { res, body: await res.json() as Record<string, unknown> };
}

/** Starts a device-session purpose (the re-check) and returns its IdP URL + cookie. */
async function startBound(pathname: string, headers: Record<string, string>): Promise<Started> {
  const res = await fetch(`${baseUrl}/api/auth/oidc${pathname}`, { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 200, pathname);
  const { authorizationUrl } = await res.json() as { authorizationUrl: string };
  return { authorizationUrl, cookie: cookieOf(res) };
}

function backchannel(token: string, contentType = 'application/x-www-form-urlencoded') {
  const body = contentType.includes('json') ? JSON.stringify({ logout_token: token })
    : new URLSearchParams({ logout_token: token }).toString();
  return fetch(`${baseUrl}/api/auth/oidc/backchannel-logout`, { method: 'POST', headers: { 'content-type': contentType }, body });
}

const revoked = (refreshSid: string) => revokedTokenSidsDb.isRevoked(refreshSid, Date.now());
const row = (refreshSid: string) => ssoDeviceSessionsDb.get(refreshSid);
const auditActions = (action: string) => (db.prepare('SELECT metadata FROM audit_log WHERE action = ? ORDER BY id')
  .all(action) as Array<{ metadata: string }>).map((entry) => JSON.parse(entry.metadata));

// ---------------------------------------------------------------------------
// N5: the IdP sid is bound at sign-in
// ---------------------------------------------------------------------------

test('N5: a member SSO sign-in binds the device session to the IdP sid, login hint and clocks', async () => {
  const refreshSid = await signIn({ ...MEMBER, sid: 'V1_member-browser', preferred_username: 'member@idp' });
  const bound = row(refreshSid);
  assert.equal(bound?.user_id, member.id);
  assert.equal(bound?.owner_tier, 0);
  assert.equal(bound?.login_hint, 'member@idp');
  assert.equal(bound?.privileged_until, null);
  assert.deepEqual(ssoDeviceSessionsDb.findByIdpSid(FIXTURE_ISSUER, 'V1_member-browser').map((r) => r.refresh_sid), [refreshSid]);
});

test('N3: an owner node login_hint rides on /login; none when unset (no last-user cookie)', async () => {
  const plain = new URL((await startLogin()).authorizationUrl);
  assert.equal(plain.searchParams.get('login_hint'), null);
  updateSsoLinkedSettings({ ownerLoginHint: 'ibrahim@example.org' }, { userId: owner.id });
  const hinted = new URL((await startLogin()).authorizationUrl);
  assert.equal(hinted.searchParams.get('login_hint'), 'ibrahim@example.org');
  assert.equal(hinted.searchParams.get('prompt'), null, 'auto sign-in is a plain authorize: no click');
});

// ---------------------------------------------------------------------------
// Owner tier (N2 step-up withdrawn 2026-10-18: no grant is ever written)
// ---------------------------------------------------------------------------

test('owner entry from a reused IdP session (3 days) is direct and audited with its age; no grant', async () => {
  const refreshSid = await signIn({ ...OWNER, sid: 'V1_owner-a', auth_time: nowSec() - 3 * 86_400 });
  assert.equal(row(refreshSid)?.owner_tier, 1);
  assert.equal(row(refreshSid)?.privileged_until, null);
  const [signInAudit] = auditActions('oidc_owner_sign_in').slice(-1);
  assert.ok(Number(signInAudit.authAgeSec) >= 3 * 86_400 - 5);
  assert.equal('authStale' in signInAudit || 'privileged' in signInAudit, false, 'no tier fields');
});

test('a fresh-touch owner sign-in binds the owner tier and no grant (nothing left to grant)', async () => {
  const refreshSid = await signIn({ ...OWNER, sid: 'V1_owner-fresh' });
  assert.equal(row(refreshSid)?.owner_tier, 1);
  assert.equal(row(refreshSid)?.privileged_until, null);
});

/** Turns wallet mode (MULTI_ACCOUNT_SWITCHING) on for one test. */
function walletMode(t: { after: (fn: () => void) => void }) {
  const keys = ['MULTI_ACCOUNT_SWITCHING', 'APP_ORIGIN', 'ALLOWED_ORIGINS'] as const;
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, {
    MULTI_ACCOUNT_SWITCHING: 'true', APP_ORIGIN: 'https://nassaj.example', ALLOWED_ORIGINS: 'https://nassaj.example',
  });
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
}

test('H1 + A3: with the wallet flag on, an SSO owner sign-in is still a bound bearer session', async (t) => {
  walletMode(t);
  for (const claims of [
    { ...OWNER, sid: 'V1_wallet-fresh' },
    { ...OWNER, sid: 'V1_wallet-stale', auth_time: nowSec() - 3 * 86_400, amr: ['pwd'] },
  ]) {
    const res = await complete(await startLogin(), claims);
    assert.equal(res.status, 302, claims.sid);
    assert.match(res.headers.get('location') ?? '', /oidc_code=/, claims.sid);
  }
  // ADR-194 A3: SSO excludes wallet mode, so every SSO sign-in is a bearer JWT bound to its IdP sid.
  assert.equal(mintedSids.length, 2, 'a bearer JWT per sign-in');
  for (const sid of mintedSids) assert.equal(row(sid)?.owner_tier, 1, 'bound to the IdP session');
  assert.ok(!auditActions('oidc_owner_sign_in_refused').some((entry) => entry.reason === 'fresh_touch_required'));
});

test('N2 withdrawn: POST /owner-step-up/start no longer exists', async () => {
  const refreshSid = await signIn({ ...OWNER, sid: 'V1_owner-gone', auth_time: nowSec() - 86_400 });
  const res = await fetch(`${baseUrl}/api/auth/oidc/owner-step-up/start`, {
    method: 'POST', headers: asUser(owner.id, 'owner', refreshSid), body: '{}',
  });
  assert.equal(res.status, 404);
});

test('an owner session ends on sign-out and on back-channel logout; a kill-switch change is audited plainly', async () => {
  const signedOut = await signIn({ ...OWNER, sid: 'V1_owner-1' });
  forgetSsoDeviceSession(signedOut);
  assert.equal(row(signedOut), undefined, 'sign-out forgets the binding');

  const backchanneled = await signIn({ ...OWNER, sid: 'V1_owner-2' });
  assert.equal((await backchannel(op.logoutToken('sub-owner', { sid: 'V1_owner-2' }))).status, 200);
  assert.equal(row(backchanneled), undefined);
  assert.equal(revoked(backchanneled), true);

  const result = updateSsoLinkedSettings({ idpSignOutAffectsOwner: false }, { userId: owner.id });
  assert.equal(result.ok, true);
  const [audit] = auditActions('sso_linked_settings_changed').slice(-1);
  assert.deepEqual(audit, { changed: ['idpSignOutAffectsOwner'], idpSignOutAffectsOwner: false });
});

// ---------------------------------------------------------------------------
// N5: the D6 back-channel matrix
// ---------------------------------------------------------------------------

test('D6 member, sid matched: only that browser ends; sockets close; other browser, API keys and epoch stay', async () => {
  const browserA = await signIn({ ...MEMBER, sid: 'V1_m-a' });
  const browserB = await signIn({ ...MEMBER, sid: 'V1_m-b' });
  apiKeysDb.createApiKey(member.id, 'automation');
  let closed = 0;
  registerTokenSessionSocket(browserA, () => { closed += 1; });
  const epochBefore = userDb.getTokenEpoch(member.id);
  assert.equal((await backchannel(op.logoutToken('sub-member', { sid: 'V1_m-a' }))).status, 200);
  assert.equal(revoked(browserA), true);
  assert.equal(revoked(browserB), false, 'another browser stays signed in');
  assert.equal(closed, 1, 'the socket of that browser closes (4401 by its registrant)');
  assert.equal(apiKeysDb.getApiKeys(member.id).length, 1, 'API keys untouched');
  assert.equal(userDb.getTokenEpoch(member.id), epochBefore, 'never a sign-out everywhere');
});

test('D6 owner, sid matched: ends that browser while the kill switch is on; no effect (audited) when off', async () => {
  const on = await signIn({ ...OWNER, sid: 'V1_o-on' });
  assert.equal((await backchannel(op.logoutToken('sub-owner', { sid: 'V1_o-on' }))).status, 200);
  assert.equal(revoked(on), true);

  updateSsoLinkedSettings({ idpSignOutAffectsOwner: false }, { userId: owner.id });
  const off = await signIn({ ...OWNER, sid: 'V1_o-off' });
  assert.equal((await backchannel(op.logoutToken('sub-owner', { sid: 'V1_o-off' }))).status, 200);
  assert.equal(revoked(off), false);
  const [audit] = auditActions('oidc_backchannel_logout').slice(-1);
  assert.equal(audit.outcome, 'no_effect');
  assert.deepEqual(audit.skipped, ['owner_kill_switch_off']);
});

test('D6: sid unmatched is a 200 no-op, audited, and never falls back to sub (owner or member)', async () => {
  const ownerSession = await signIn({ ...OWNER, sid: 'V1_o-real' });
  const memberSession = await signIn({ ...MEMBER, sid: 'V1_m-real' });
  for (const sub of ['sub-owner', 'sub-member']) {
    assert.equal((await backchannel(op.logoutToken(sub, { sid: 'V1_other-browser' }))).status, 200);
  }
  assert.equal(revoked(ownerSession), false);
  assert.equal(revoked(memberSession), false);
  assert.deepEqual(auditActions('oidc_backchannel_logout').slice(-2).map((a) => a.outcome), ['sid_unmatched', 'sid_unmatched']);
});

test('D6: a sub-only token (owner) is refused 400 with no effect; a sid of another subject ends nothing', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const ownerSession = await signIn({ ...OWNER, sid: 'V1_o-x' });
  assert.equal((await backchannel(op.logoutToken('sub-owner', { sid: undefined }))).status, 400);
  assert.equal(revoked(ownerSession), false);
  assert.equal((await backchannel(op.logoutToken('sub-member-two', { sid: 'V1_o-x' }))).status, 200);
  assert.equal(revoked(ownerSession), false, 'the sid belongs to another subject');
});

// ---------------------------------------------------------------------------
// N7: the D5 standard
// ---------------------------------------------------------------------------

test('D5 negatives: wrong iss/aud, alg none/HS256, events missing, nonce, sid missing, iat window → 400, no effect', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const session = await signIn({ ...MEMBER, sid: 'V1_mock-sid' });
  const now = nowSec();
  const base = {
    iss: FIXTURE_ISSUER, aud: 'nassaj-client', sub: 'sub-member', sid: 'V1_mock-sid', iat: now, exp: now + 900,
    jti: 'j', events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
  };
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const tokens: Array<[string, string]> = [
    ['wrong iss', op.signRaw({ ...base, iss: 'https://evil.example', jti: crypto.randomUUID() })],
    ['wrong aud', op.signRaw({ ...base, aud: 'other-client', jti: crypto.randomUUID() })],
    ['alg none', `${part({ alg: 'none', kid: 'mock-key-1' })}.${part(base)}.`],
    ['HS256', `${part({ alg: 'HS256', kid: 'mock-key-1' })}.${part(base)}.c2ln`],
    ['events missing', op.logoutToken('sub-member', { events: undefined })],
    ['nonce present', op.logoutToken('sub-member', { nonce: 'n' })],
    ['sid missing', op.logoutToken('sub-member', { sid: undefined })],
    ['iat too old', op.logoutToken('sub-member', { iat: now - 181 })],
    ['iat in the future', op.logoutToken('sub-member', { iat: now + 120 })],
    ['garbage', 'not-a-jwt'],
  ];
  for (const [label, token] of tokens) {
    assert.equal((await backchannel(token)).status, 400, label);
  }
  assert.equal(revoked(session), false, 'nothing ended');
  assert.equal(db.prepare('SELECT count(*) AS n FROM oidc_logout_jtis').get().n, 0, 'no jti recorded for a refusal');
});

test('D5 V4: a jti replay after a 200 is a 200 no-op; a retry after our 503 (same jti, fresh iat) is processed', async () => {
  const first = await signIn({ ...MEMBER, sid: 'V1_replay' });
  const jti = crypto.randomUUID();
  assert.equal((await backchannel(op.logoutToken('sub-member', { sid: 'V1_replay', jti }))).status, 200);
  assert.equal(revoked(first), true);
  const second = await signIn({ ...MEMBER, sid: 'V1_replay' });
  assert.equal((await backchannel(op.logoutToken('sub-member', { sid: 'V1_replay', jti }))).status, 200);
  assert.equal(revoked(second), false, 'an already-processed jti has no effect');

  const retried = await signIn({ ...MEMBER, sid: 'V1_retry' });
  const retryJti = crypto.randomUUID();
  db.exec('ALTER TABLE oidc_logout_jtis RENAME TO oidc_logout_jtis_away');
  try {
    const failed = await backchannel(op.logoutToken('sub-member', { sid: 'V1_retry', jti: retryJti }));
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('retry-after'), '300');
    assert.equal(revoked(retried), false, 'nothing applied while the store is unreadable');
  } finally {
    db.exec('ALTER TABLE oidc_logout_jtis_away RENAME TO oidc_logout_jtis');
  }
  const retry = await backchannel(op.logoutToken('sub-member', { sid: 'V1_retry', jti: retryJti, iat: nowSec() }));
  assert.equal(retry.status, 200);
  assert.equal(revoked(retried), true, 'the retry is processed');
});

test('D5: the jti store survives a restart (fresh verifier and caches)', async () => {
  const session = await signIn({ ...MEMBER, sid: 'V1_restart' });
  const jti = crypto.randomUUID();
  assert.equal((await backchannel(op.logoutToken('sub-member', { sid: 'V1_restart', jti }))).status, 200);
  resetSsoConfigCacheForTests();
  setSsoNetworkOverridesForTests(op.network);
  const again = await signIn({ ...MEMBER, sid: 'V1_restart' });
  assert.equal((await backchannel(op.logoutToken('sub-member', { sid: 'V1_restart', jti }))).status, 200);
  assert.equal(revoked(session), true);
  assert.equal(revoked(again), false, 'the remembered jti is still a no-op');
});

test('D5: a store full of unexpired jtis answers 503 and evicts none', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const session = await signIn({ ...MEMBER, sid: 'V1_full' });
  const insert = db.prepare('INSERT INTO oidc_logout_jtis (issuer, jti, expires_at) VALUES (?, ?, ?)');
  const future = Date.now() + 3_600_000;
  db.transaction(() => {
    for (let i = 0; i < LOGOUT_JTI_MAX_ENTRIES; i += 1) insert.run(FIXTURE_ISSUER, `full-${i}`, future);
  })();
  const res = await backchannel(op.logoutToken('sub-member', { sid: 'V1_full' }));
  assert.equal(res.status, 503);
  assert.ok(res.headers.get('retry-after'));
  assert.equal(revoked(session), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM oidc_logout_jtis WHERE expires_at > ?').get(Date.now()).n,
    LOGOUT_JTI_MAX_ENTRIES, 'no unexpired entry evicted');
});

test('D5: an unknown kid gets one refetch; still unknown → 503 + Retry-After; once published → 200', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const session = await signIn({ ...MEMBER, sid: 'V1_rotate' });
  op.rotateKey('rotated-kid');
  const before = op.jwksFetches();
  const unknown = await backchannel(op.rotatedLogoutToken('sub-member', { sid: 'V1_rotate' }));
  assert.equal(unknown.status, 503);
  assert.equal(unknown.headers.get('retry-after'), '300');
  assert.equal(op.jwksFetches() - before, 1, 'one refetch for the unseen kid');
  const throttled = await backchannel(op.rotatedLogoutToken('sub-member', { sid: 'V1_rotate' }));
  assert.equal(throttled.status, 503, 'the refetch is throttled to once a minute');
  assert.equal(op.jwksFetches() - before, 1);
  op.setPublishRotated(true);
  resetSsoConfigCacheForTests();
  setSsoNetworkOverridesForTests(op.network);
  assert.equal((await backchannel(op.rotatedLogoutToken('sub-member', { sid: 'V1_rotate' }))).status, 200);
  assert.equal(revoked(session), true);
});

test('D5 request limits: JSON is 415, a body over 8 KB is 413; the route carries a 30/min limiter', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  assert.equal((await backchannel(op.logoutToken('sub-member'), 'application/json')).status, 415);
  assert.equal((await backchannel(`${op.logoutToken('sub-member')}${'a'.repeat(9 * 1024)}`)).status, 413);
  assert.equal(backchannelLimiterOptions?.max, 30);
  assert.equal(backchannelLimiterOptions?.windowMs, 60_000);
  const limiter = realRateLimit.createRateLimiter(backchannelLimiterOptions);
  let limited = 0;
  const res = { setHeader: () => {}, status: () => ({ json: () => { limited += 1; } }) };
  for (let i = 0; i < 31; i += 1) limiter({ headers: {}, socket: { remoteAddress: '203.0.113.9' } }, res, () => {});
  assert.equal(limited, 1, 'the 31st notice in a minute is refused');
});

// ---------------------------------------------------------------------------
// N8 / D9-1: the silent re-check
// ---------------------------------------------------------------------------

test('D9-1: the re-check sends prompt=none with the session user as login_hint', async () => {
  const refreshSid = await signIn({ ...MEMBER, sid: 'V1_re', preferred_username: 'member@idp' });
  const started = await startBound('/recheck/start', asUser(member.id, 'user', refreshSid));
  const idp = new URL(started.authorizationUrl);
  assert.equal(idp.searchParams.get('prompt'), 'none');
  assert.equal(idp.searchParams.get('login_hint'), 'member@idp');
  const refused = await postJson('/recheck/start', asUser(member.id, 'user', 'N'.repeat(22)));
  assert.equal(refused.res.status, 409, 'a password session has nothing to re-check');
});

test('V10a: interaction_required keeps the session (stamped); login_required ends it', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const refreshSid = await signIn({ ...MEMBER, sid: 'V1_keep' });
  db.prepare('UPDATE sso_device_sessions SET last_recheck_at = 0 WHERE refresh_sid = ?').run(refreshSid);
  for (const error of ['interaction_required', 'account_selection_required', 'consent_required']) {
    const started = await startBound('/recheck/start', asUser(member.id, 'user', refreshSid));
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
    const res = await callback({ state, error }, started.cookie);
    assert.equal(res.headers.get('location'), '/auth/oidc/return?oidc_recheck=kept', error);
    assert.equal(revoked(refreshSid), false, `${error} is not a sign-out`);
  }
  assert.ok(Number(row(refreshSid)?.last_recheck_at) > 0, 'the interval restarts');
  const started = await startBound('/recheck/start', asUser(member.id, 'user', refreshSid));
  const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
  const res = await callback({ state, error: 'login_required' }, started.cookie);
  assert.equal(res.headers.get('location'), '/auth/oidc/return?oidc_recheck=signed_out');
  assert.equal(revoked(refreshSid), true, 'login_required signs this browser out');
});

test('D9-1: a successful re-check renews the clock and binds the sid; another subject ends the session', async () => {
  const refreshSid = await signIn({ ...MEMBER, sid: 'V1_ok' });
  db.prepare('UPDATE sso_device_sessions SET last_recheck_at = 0 WHERE refresh_sid = ?').run(refreshSid);
  const ok = await complete(await startBound('/recheck/start', asUser(member.id, 'user', refreshSid)), { ...MEMBER, sid: 'V1_ok2' });
  assert.equal(ok.headers.get('location'), '/auth/oidc/return?oidc_recheck=ok');
  assert.ok(Number(row(refreshSid)?.last_recheck_at) > Date.now() - 5_000);
  assert.equal(ssoDeviceSessionsDb.findByIdpSid(FIXTURE_ISSUER, 'V1_ok2')[0]?.refresh_sid, refreshSid);
  const changed = await complete(await startBound('/recheck/start', asUser(member.id, 'user', refreshSid)), {
    ...MEMBER, sub: 'sub-member-two',
  });
  assert.equal(changed.headers.get('location'), '/auth/oidc/return?oidc_recheck=signed_out');
  assert.equal(revoked(refreshSid), true);
});

test('GET /session reports the tier and recheckDue after the interval', async () => {
  const refreshSid = await signIn({ ...OWNER, sid: 'V1_status', auth_time: nowSec() - 86_400 });
  const read = async () => (await fetch(`${baseUrl}/api/auth/oidc/session`, { headers: asUser(owner.id, 'owner', refreshSid) })).json();
  assert.deepEqual(await read(), { sso: true, recheckDue: false, ownerTier: true });
  db.prepare('UPDATE sso_device_sessions SET last_recheck_at = ? WHERE refresh_sid = ?').run(Date.now() - 13 * 3_600_000, refreshSid);
  assert.equal((await read()).recheckDue, true, 'default 12 h interval');
  updateSsoLinkedSettings({ recheckIntervalHours: 24 }, { userId: owner.id });
  assert.equal((await read()).recheckDue, false, 'configurable up to 24 h');
  const none = await fetch(`${baseUrl}/api/auth/oidc/session`, { headers: asUser(owner.id, 'owner', 'Q'.repeat(22)) });
  assert.deepEqual(await none.json(), { sso: false });
});

