/**
 * T-1939 slice 6B: OIDC step-up of an SSO-linked member (POST /step-up/start
 * + the 'step_up' branch of /callback). The PKCE store, the browser
 * transaction cookie, the step-up quota and the one-time grant store are the
 * REAL ones; the IdP verifier and the database are in-memory fakes (same
 * harness as oidc.self-link.test.ts).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createSsoRuntimeDouble } from '../services/__tests__/sso-runtime-double.js';
import { createSsoConfigDouble, doubleMapping } from '../services/__tests__/sso-config-double.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const sso = createSsoConfigDouble();
mock.module(url('../services/sso-config.service.js'), { namedExports: sso.exports });
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
const ISSUER = 'https://issuer.example';
// Project-scoped roles claim in the nested-grant shape (fixture data, neutral name).
const ROLES_CLAIM = 'urn:example:iam:org:project:proj-synth:roles';
const ROLE_MAPPING = doubleMapping({ role_claim_path: `["${ROLES_CLAIM}"]` });
/** `role_grant_scope` over ROLES_CLAIM allowing only the given scopes (D5). */
const scopedMapping = (scopes: string[]) => doubleMapping({
  role_claim_path: `["${ROLES_CLAIM}"]`, tenant_mode: 'role_grant_scope', tenant_values_json: JSON.stringify(scopes),
});
const MEMBER_ROLE = { member: { '1': 'org.example' } };

type FakeUser = { id: number; username: string; role: string; password_hash: string;
  must_change_password: number; active: boolean };
type FakeIdentity = { id: number; user_id: number; issuer: string; subject: string; last_attested_at: number | null };

const users = new Map<number, FakeUser>();
let identities: FakeIdentity[] = [];
let nextIdentityId = 100;
const audits: Array<{ event: string; userId?: unknown; metadata?: unknown }> = [];
const minted: number[] = [];
let stampFailure = false;
let exchangeFailure = false;
let userLookupFailure = false;
let claims: Record<string, unknown> = {};

function resetState() {
  users.clear();
  const add = (id: number, role: string, extra: Partial<FakeUser> = {}) => users.set(id, {
    id, username: `user-${id}`, role, password_hash: `hash-${id}`, must_change_password: 0, active: true, ...extra,
  });
  add(1, 'owner');
  for (let id = 12; id <= 30; id += 1) add(id, 'user');
  identities = [];
  audits.length = 0;
  minted.length = 0;
  stampFailure = false;
  exchangeFailure = false;
  userLookupFailure = false;
  claims = { sub: 'subject-new', [ROLES_CLAIM]: MEMBER_ROLE, auth_time: Math.floor(Date.now() / 1000) };
  sso.setActive(true);
  sso.state.mapping = ROLE_MAPPING;
}

const publicUser = (user: FakeUser | undefined) => (user && user.active
  ? { id: user.id, username: user.username, role: user.role, must_change_password: user.must_change_password }
  : undefined);

mock.module(url('../middleware/auth.js'), {
  namedExports: {
    authenticateToken: (req: { headers: Record<string, string | undefined>; user?: unknown },
      res: { status: (c: number) => { json: (b: unknown) => void } }, next: () => void) => {
      const id = Number(req.headers['x-test-user-id']);
      const user = users.get(id);
      if (!user) return res.status(401).json({ error: 'Invalid token' });
      req.user = { id, role: user.role };
      return next();
    },
    generateToken: (user: { id: number }) => {
      minted.push(user.id);
      return `jwt-for-${user.id}`;
    },
    invalidateRefreshCache: () => {},
    requireRole: () => passThrough,
  },
});
mock.module(url('../modules/account-wallet/user-identity-revocation.js'), {
  namedExports: { revokeUserIdentity: () => ({ abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 }) },
});
mock.module(url('../middleware/rate-limit.js'), {
  namedExports: {
    createRateLimiter: () => passThrough,
  },
});
mock.module(url('../services/password.service.js'), {
  namedExports: { verifyPassword: async () => assert.fail('an IdP step-up never checks a password') },
});
mock.module(url('../services/notification-orchestrator.js'), {
  namedExports: {
    createNotificationEvent: (event: unknown) => event,
    notifyUserIfEnabled: () => {},
  },
});
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    apiKeysDb: { revokeAllForUser: () => 0 },
    auditLogDb: {
      record: (event: string, data: { userId?: unknown; metadata?: unknown }) => audits.push({ event, ...data }),
    },
    getConnection: () => ({
      prepare: () => ({ run: () => ({ changes: 1 }) }),
      // Mirrors better-sqlite3: a throw inside rolls back every identity write.
      transaction: (fn: () => unknown) => () => {
        const snapshot = identities.map((row) => ({ ...row }));
        try {
          return fn();
        } catch (error) {
          identities = snapshot;
          throw error;
        }
      },
    }),
    userDb: {
      getUserById: (id: number) => {
        if (userLookupFailure) throw new Error('SQLITE_BUSY: database is locked');
        return publicUser(users.get(id));
      },
      getRawById: (id: number) => users.get(id),
      listActiveOwnerIds: () => [...users.values()]
        .filter((user) => user.role === 'owner' && user.active).map((user) => user.id),
      setRoleIfUnchanged: (id: number, from: string, to: string) => {
        const user = users.get(id);
        if (!user || user.role !== from || from === 'owner' || to === 'owner') return false;
        user.role = to;
        return true;
      },
      updateLastLogin: () => {},
    },
    userIdentitiesDb: {
      hasAnyLink: (userId: number) => identities.some((row) => row.user_id === userId),
      findByIssuerAndSubject: (issuer: string, subject: string) => identities
        .find((row) => row.issuer === issuer && row.subject === subject),
      countForUserAndIssuer: (userId: number, issuer: string) => identities
        .filter((row) => row.user_id === userId && row.issuer === issuer).length,
      link: (userId: number, issuer: string, subject: string) => {
        const duplicate = identities.some((row) => (row.issuer === issuer && row.subject === subject)
          || (row.user_id === userId && row.issuer === issuer));
        if (duplicate) {
          throw Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
        }
        const id = nextIdentityId++;
        identities.push({ id, user_id: userId, issuer, subject, last_attested_at: null });
        return id;
      },
      markAttested: (identityId: number, userId: number, at: number) => {
        if (stampFailure) return false;
        const row = identities.find((entry) => entry.id === identityId && entry.user_id === userId);
        if (!row) return false;
        row.last_attested_at = at;
        return true;
      },
    },
  },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });
mock.module(url('../services/oidc-verifier.service.js'), {
  namedExports: {
    parseExactHttpsIssuer: (issuer: string) => issuer,
    idTokenAuthTimeMs: (verified: { auth_time?: unknown }) => (
      Number.isInteger(verified?.auth_time) && (verified.auth_time as number) > 0
        ? (verified.auth_time as number) * 1000
        : null
    ),
  },
});
// ADR-194: the routes read the SSO configuration rows, never OIDC_* env.
const ssoRuntime = createSsoRuntimeDouble(sso, {
  exchangeAuthorizationCode: async () => {
    if (exchangeFailure) throw new Error('token endpoint 500');
    return { id_token: 'id-token-synthetic' };
  },
  verifyIdToken: async () => claims,
  verifyLogoutToken: async () => ({ sub: 'unused' }),
});
mock.module(url('../services/sso-oidc-runtime.service.js'), { namedExports: ssoRuntime.exports });

for (const key of ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI']) delete process.env[key];
resetState();

const { default: oidcRouter } = await import('./oidc.js');
const { oidcStepUpGrantStore } = await import('../services/oidc-step-up-grant.store.js');
const app = express();
app.use(express.json());
app.use('/api/auth/oidc', oidcRouter);
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(resetState);

const RETURN_PATH = '/auth/oidc/return';
const linkMember = (userId: number, subject = `subject-${userId}`) => {
  identities.push({ id: nextIdentityId++, user_id: userId, issuer: ISSUER, subject, last_attested_at: null });
  claims = { ...claims, sub: subject };
};

function startStepUp(userId: number | null) {
  return fetch(`${baseUrl}/api/auth/oidc/step-up/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(userId === null ? {} : { 'x-test-user-id': String(userId) }),
    },
    body: '{}',
  });
}

type Transaction = { state: string; cookie: string; txn: string };

async function startedStepUp(userId: number): Promise<Transaction> {
  const res = await startStepUp(userId);
  assert.equal(res.status, 200);
  const { authorizationUrl } = await res.json() as { authorizationUrl: string };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  return {
    state: new URL(authorizationUrl).searchParams.get('state') ?? '',
    cookie,
    txn: cookie.slice(cookie.indexOf('=') + 1),
  };
}

function callback({ state, cookie }: { state: string; cookie: string }) {
  return fetch(`${baseUrl}/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=provider-code`, {
    headers: { cookie },
    redirect: 'manual',
  });
}

const returned = (res: Response) => new URL(res.headers.get('location') ?? '', 'https://app.example');
const failureReasons = () => audits
  .filter((record) => record.event === 'oidc_step_up_failed')
  .map((record) => (record.metadata as { reason: string }).reason);
const redeem = (grant: string | null, userId: number, txn: string) => oidcStepUpGrantStore.consume(grant ?? '', {
  userId, audience: 'connector_owner', browserTransaction: txn,
});

test('start: 501 when SSO login is unavailable, 401 without a session', async () => {
  sso.state.loginAvailable = false;
  assert.equal((await startStepUp(12)).status, 501);
  sso.state.loginAvailable = true;
  assert.equal((await startStepUp(null)).status, 401);
});

test('start: only an SSO-linked member may start; owners and unlinked members use local evidence', async () => {
  const unlinked = await startStepUp(13);
  assert.equal(unlinked.status, 409);
  assert.equal((await unlinked.json()).code, 'sso_step_up_not_applicable');
  identities.push({ id: nextIdentityId++, user_id: 1, issuer: ISSUER, subject: 'owner-sub', last_attested_at: 1 });
  const owner = await startStepUp(1);
  assert.equal(owner.status, 409, 'the owner is local (break-glass) and steps up locally');
  assert.equal(owner.headers.get('set-cookie'), null);
  assert.deepEqual(failureReasons(), ['sso_step_up_not_applicable', 'sso_step_up_not_applicable']);
});

test('start: a member holding duplicate links is refused', async () => {
  linkMember(14, 'dup-a');
  linkMember(14, 'dup-b');
  const res = await startStepUp(14);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'oidc_duplicate_links');
});

test('start: success is a forced re-authentication (prompt=login, max_age=0) with a transaction cookie', async () => {
  linkMember(12);
  const res = await startStepUp(12);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const params = new URL((await res.json()).authorizationUrl).searchParams;
  assert.equal(params.get('prompt'), 'login');
  assert.equal(params.get('max_age'), '0');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.match(res.headers.get('set-cookie') ?? '', /__Host-oidc-txn=[A-Za-z0-9_-]{43};.*HttpOnly/u);
  assert.deepEqual(audits.map((record) => record.event), ['oidc_step_up_started']);
  assert.deepEqual(audits[0].metadata, { provider: 'oidc', audience: 'connector_owner' });
});

test('start: counted on the shared per-user step-up quota (5 per 15 minutes) with Retry-After', async () => {
  linkMember(15);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await startStepUp(15)).status, 200, `attempt ${attempt + 1}`);
  }
  const limited = await startStepUp(15);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'step_up_rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(failureReasons().at(-1), 'rate_limited');
  linkMember(16);
  assert.equal((await startStepUp(16)).status, 200, 'another member has its own bucket');
});

test('callback: a fresh sign-in by the same member yields a one-time grant and never a login', async () => {
  linkMember(12);
  const transaction = await startedStepUp(12);
  const res = await callback(transaction);
  assert.equal(res.status, 302);
  const location = returned(res);
  assert.equal(location.pathname, RETURN_PATH);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', 'the grant URL never leaks as a Referer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(location.searchParams.get('oidc_code'), null, 'no session hand-off');
  const grant = location.searchParams.get('oidc_step_up');
  assert.match(grant ?? '', /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(minted, [], 'no JWT minted');
  assert.ok(identities.find((row) => row.user_id === 12)?.last_attested_at, 'attestation stamped');
  assert.ok(audits.some((record) => record.event === 'oidc_step_up_verified'));
  assert.ok(!JSON.stringify(audits).includes('subject-12'), 'the subject is never audited');

  assert.equal(redeem(grant, 30, transaction.txn), false, 'another user cannot redeem it (and burns it)');
  assert.equal(redeem(grant, 12, transaction.txn), false, 'burned');

  const second = await startedStepUp(12);
  const again = returned(await callback(second)).searchParams.get('oidc_step_up');
  assert.equal(redeem(again, 12, 'Z'.repeat(43)), false, 'another browser cannot redeem it');
  const third = await startedStepUp(12);
  const good = returned(await callback(third)).searchParams.get('oidc_step_up');
  assert.equal(redeem(good, 12, third.txn), true);
  assert.equal(redeem(good, 12, third.txn), false, 'single use');
});

test('callback: the state is single use and bound to the browser that started it', async () => {
  linkMember(17);
  const transaction = await startedStepUp(17);
  const foreign = await callback({ state: transaction.state, cookie: `__Host-oidc-txn=${'Q'.repeat(43)}` });
  assert.equal(foreign.status, 302, 'a known step-up state returns to the dialog, never raw JSON');
  assert.equal(returned(foreign).pathname, RETURN_PATH);
  assert.equal(returned(foreign).searchParams.get('oidc_step_up_error'), 'oidc_reauth_required');
  assert.equal(returned(foreign).searchParams.get('oidc_step_up'), null, 'no grant');
  const replay = await callback(transaction);
  assert.equal(replay.status, 302, 'consumed by the foreign attempt');
  assert.equal(returned(replay).searchParams.get('error'), 'invalid_state');
  assert.equal(minted.length, 0);
});

test('callback: an unknown state (expired, or lost on restart) returns to the SPA, not raw JSON', async () => {
  for (const suffix of ['&code=provider-code', '&error=access_denied']) {
    const res = await fetch(`${baseUrl}/api/auth/oidc/callback?state=${'U'.repeat(43)}${suffix}`, {
      headers: { cookie: `__Host-oidc-txn=${'Q'.repeat(43)}` }, redirect: 'manual',
    });
    assert.equal(res.status, 302, suffix);
    assert.equal(returned(res).pathname, RETURN_PATH);
    assert.deepEqual([...returned(res).searchParams.keys()], ['error'], 'only a fixed code travels');
    assert.equal(returned(res).searchParams.get('error'), 'invalid_state');
    assert.match(res.headers.get('cache-control') ?? '', /no-store/u);
  }
});

test('link/self: ssoStepUp is the exact start-admission predicate', async () => {
  const status = async (userId: number) => (await fetch(`${baseUrl}/api/auth/oidc/link/self`, {
    headers: { 'x-test-user-id': String(userId) },
  })).json() as Promise<{ linked: boolean; ssoStepUp: boolean }>;
  assert.deepEqual(await status(13), { linked: false, ssoStepUp: false });
  linkMember(13);
  assert.deepEqual(await status(13), { linked: true, ssoStepUp: true });
  identities.push({ id: nextIdentityId++, user_id: 1, issuer: ISSUER, subject: 'owner-sub', last_attested_at: 1 });
  assert.deepEqual(await status(1), { linked: true, ssoStepUp: false }, 'the owner steps up locally');
  identities.push({ id: nextIdentityId++, user_id: 15, issuer: 'https://old-issuer.example', subject: 's',
    last_attested_at: 1 });
  assert.deepEqual(await status(15), { linked: false, ssoStepUp: true },
    'SSO-only through a previous issuer: the client still offers SSO');
});

test('start: an SSO-only member linked only under a previous issuer gets oidc_issuer_changed', async () => {
  identities.push({ id: nextIdentityId++, user_id: 16, issuer: 'https://old-issuer.example', subject: 's',
    last_attested_at: 1 });
  const res = await startStepUp(16);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'oidc_issuer_changed');
  assert.equal(res.headers.get('set-cookie'), null, 'no IdP round trip is opened');
  assert.deepEqual(failureReasons(), ['oidc_issuer_changed']);
});

test('callback: a subject linked to someone else is refused with a fixed code', async () => {
  linkMember(23);
  identities.push({ id: nextIdentityId++, user_id: 30, issuer: ISSUER, subject: 'subject-30', last_attested_at: 1 });
  const transaction = await startedStepUp(23);
  claims = { ...claims, sub: 'subject-30' };
  const res = await callback(transaction);
  assert.equal(returned(res).searchParams.get('oidc_step_up_error'), 'oidc_step_up_identity_mismatch');
  assert.equal(returned(res).searchParams.get('oidc_step_up'), null);
  assert.deepEqual(failureReasons(), ['identity_mismatch']);
});

test('callback: an IdP session older than the request cannot satisfy the step-up', async () => {
  linkMember(18);
  const transaction = await startedStepUp(18);
  claims = { ...claims, auth_time: Math.floor((Date.now() - 10 * 60_000) / 1000) };
  const res = await callback(transaction);
  assert.equal(returned(res).searchParams.get('oidc_step_up_error'), 'oidc_reauth_required');
  assert.deepEqual(failureReasons(), ['auth_time_before_request']);
  linkMember(19);
  const missing = await startedStepUp(19);
  claims = { ...claims, sub: 'subject-19', auth_time: undefined };
  assert.equal(returned(await callback(missing)).searchParams.get('oidc_step_up_error'), 'oidc_reauth_required');
});

test('callback: a withdrawn role refuses the step-up exactly as it would refuse a login', async () => {
  linkMember(20);
  const transaction = await startedStepUp(20);
  claims = { ...claims, [ROLES_CLAIM]: {} };
  const res = await callback(transaction);
  assert.equal(returned(res).searchParams.get('oidc_step_up_error'), 'oidc_not_authorized');
  assert.ok(audits.some((record) => record.event === 'oidc_access_denied_no_role'));
  assert.equal(returned(res).searchParams.get('oidc_step_up'), null);
});

test('callback: a mapping that vanished mid-flight refuses without a withdrawal', async () => {
  linkMember(22);
  const transaction = await startedStepUp(22);
  sso.state.mapping = null;
  const res = await callback(transaction);
  assert.equal(returned(res).searchParams.get('oidc_step_up_error'), 'temporarily_unavailable');
  assert.deepEqual(failureReasons(), ['mapping_unavailable']);
  assert.ok(!audits.some((record) => record.event === 'oidc_access_denied_no_role'));
});

test('callback: a failed attestation stamp yields no grant', async () => {
  linkMember(21);
  const transaction = await startedStepUp(21);
  stampFailure = true;
  const res = await callback(transaction);
  assert.equal(returned(res).searchParams.get('oidc_step_up_error'), 'temporarily_unavailable');
  assert.deepEqual(failureReasons(), ['attestation_failed']);
});

test('callback: a login transaction never yields a step-up grant', async () => {
  linkMember(22);
  const res = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  const login = {
    state: new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? '',
    cookie: (res.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
  };
  const done = await callback(login);
  assert.equal(returned(done).searchParams.get('oidc_step_up'), null);
  assert.ok(returned(done).searchParams.get('oidc_code'), 'an ordinary login hand-off');
});

test('callback: a member who cancels at the IdP returns to the SPA with provider_denied', async () => {
  linkMember(24);
  const transaction = await startedStepUp(24);
  const res = await fetch(`${baseUrl}/api/auth/oidc/callback?state=${encodeURIComponent(transaction.state)}`
    + '&error=access_denied&error_description=User%20cancelled', { headers: { cookie: transaction.cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(returned(res).pathname, RETURN_PATH);
  assert.equal(returned(res).searchParams.get('oidc_step_up_error'), 'provider_denied');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(failureReasons(), ['provider_denied']);
  assert.ok(!JSON.stringify(audits).includes('User cancelled'), 'the IdP text is never audited');
  const replay = await callback(transaction);
  assert.equal(replay.status, 302, 'the abandoned transaction is consumed');
  assert.equal(returned(replay).searchParams.get('error'), 'invalid_state');
});

test('callback: a code-less reply to a login transaction keeps the JSON 400', async () => {
  const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const res = await fetch(`${baseUrl}/api/auth/oidc/callback?state=${encodeURIComponent(state)}&error=access_denied`, {
    headers: { cookie: (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '' }, redirect: 'manual',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Missing authorization code' });
});

test('callback: a failed code exchange returns to the SPA with temporarily_unavailable', async () => {
  linkMember(25);
  const transaction = await startedStepUp(25);
  exchangeFailure = true;
  const res = await callback(transaction);
  assert.equal(res.status, 302);
  assert.equal(returned(res).searchParams.get('oidc_step_up_error'), 'temporarily_unavailable');
  assert.equal(returned(res).searchParams.get('oidc_step_up'), null);
  assert.deepEqual(failureReasons(), ['provider_exchange_failed']);
});

test('callback: an id_token without a subject returns to the SPA instead of raw JSON', async () => {
  linkMember(26);
  const transaction = await startedStepUp(26);
  claims = { ...claims, sub: undefined };
  const res = await callback(transaction);
  assert.equal(returned(res).searchParams.get('oidc_step_up_error'), 'temporarily_unavailable');
  assert.deepEqual(failureReasons(), ['subject_missing']);
});

test('start: a database failure answers 503 temporarily_unavailable instead of hanging', async () => {
  linkMember(27);
  userLookupFailure = true;
  const res = await startStepUp(27);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: 'Verification temporarily unavailable', code: 'temporarily_unavailable',
  });
  assert.equal(res.headers.get('set-cookie'), null, 'no transaction is opened');
});

test('ADR-194 D9: an apply before the step-up writes refuses, withdrawing nothing', async () => {
  linkMember(23);
  const transaction = await startedStepUp(23);
  claims = { ...claims, [ROLES_CLAIM]: {} };
  ssoRuntime.runtime.fenceVersion = 8;
  try {
    const res = await callback(transaction);
    assert.equal(returned(res).searchParams.get('oidc_step_up_error'), 'oidc_config_changed');
    assert.ok(!audits.some((record) => record.event === 'oidc_access_denied_no_role'),
      'no denial revocation on a version mismatch');
  } finally {
    ssoRuntime.runtime.fenceVersion = null;
  }
});

test('ADR-194 D9: an apply after the grant is issued revokes the grant', async () => {
  linkMember(24);
  const transaction = await startedStepUp(24);
  ssoRuntime.runtime.postMintVersion = 8;
  const issue = mock.method(oidcStepUpGrantStore, 'issue');
  try {
    const res = await callback(transaction);
    assert.equal(returned(res).searchParams.get('oidc_step_up_error'), 'oidc_config_changed');
    const grant = issue.mock.calls[0]?.result as string;
    assert.match(grant, /^[A-Za-z0-9_-]{43}$/u, 'a grant was issued inside the fence');
    assert.equal(redeem(grant, 24, transaction.txn), false, 'and revoked on mismatch');
  } finally {
    issue.mock.restore();
    ssoRuntime.runtime.postMintVersion = null;
  }
});
