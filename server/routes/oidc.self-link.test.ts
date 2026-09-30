/**
 * T-1939 slice 5: member self-link (POST /link/self/start + the 'link' branch
 * of /callback). The PKCE and one-time-code stores are the REAL ones, so the
 * purpose binding and the browser-transaction cookie are exercised end to
 * end; the IdP verifier and the database are in-memory fakes.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
const ISSUER = 'https://issuer.example';
const ROLES_CLAIM = 'urn:zitadel:iam:org:project:proj-synth:roles';
const MEMBER_ROLE = { member: { '1': 'org.example' } };

type FakeUser = { id: number; username: string; role: string; password_hash: string;
  must_change_password: number; active: boolean };
type FakeIdentity = { id: number; user_id: number; issuer: string; subject: string; last_attested_at: number | null };

const users = new Map<number, FakeUser>();
let identities: FakeIdentity[] = [];
let nextIdentityId = 100;
const audits: Array<{ event: string; userId?: unknown; metadata?: unknown }> = [];
const passwordChecks: string[] = [];
const notifications: number[] = [];
const minted: number[] = [];
let stampFailure = false;
let linkConflict = false;
let rateLimitExhausted = false;
let selfLinkLimiterOptions: { key?: (req: unknown) => string; max?: number; windowMs?: number } | null = null;
let claims: Record<string, unknown> = {};

function resetState() {
  users.clear();
  const add = (id: number, role: string, extra: Partial<FakeUser> = {}) => users.set(id, {
    id, username: `user-${id}`, role, password_hash: `hash-${id}`, must_change_password: 0, active: true, ...extra,
  });
  add(1, 'owner');
  add(12, 'user');
  add(30, 'user');
  identities = [];
  audits.length = 0;
  passwordChecks.length = 0;
  notifications.length = 0;
  minted.length = 0;
  stampFailure = false;
  linkConflict = false;
  rateLimitExhausted = false;
  claims = { sub: 'subject-new', [ROLES_CLAIM]: MEMBER_ROLE, auth_time: Math.floor(Date.now() / 1000) };
  process.env.OIDC_ENABLED = 'true';
  delete process.env.OIDC_ALLOWED_ORG_IDS;
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
    createRateLimiter: (options: { code?: string; key?: (req: unknown) => string; max?: number }) => {
      if (options?.code !== 'oidc_self_link_rate_limited') return passThrough;
      selfLinkLimiterOptions = options;
      return (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }, next: () => void) => (
        rateLimitExhausted ? res.status(429).json({ code: options.code }) : next()
      );
    },
  },
});
mock.module(url('../services/password.service.js'), {
  namedExports: {
    verifyPassword: async (hash: string, password: string) => {
      passwordChecks.push(hash);
      return password === 'correct-pw' && [...users.values()].some((user) => user.password_hash === hash);
    },
  },
});
mock.module(url('../services/notification-orchestrator.js'), {
  namedExports: {
    createNotificationEvent: (event: unknown) => event,
    notifyUserIfEnabled: ({ userId }: { userId: number }) => notifications.push(userId),
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
      getUserById: (id: number) => publicUser(users.get(id)),
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
        if (duplicate || linkConflict) {
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
    createOidcVerifier: () => ({
      getDiscovery: async () => ({ authorization_endpoint: 'https://issuer.example/authorize' }),
      exchangeAuthorizationCode: async () => ({ id_token: 'id-token-synthetic' }),
      verifyIdToken: async () => claims,
      verifyLogoutToken: async () => ({ sub: 'unused' }),
    }),
  },
});

process.env.OIDC_ISSUER_URL = ISSUER;
process.env.OIDC_CLIENT_ID = 'client-synthetic';
process.env.OIDC_REDIRECT_URI = 'https://app.example/api/auth/oidc/callback';
process.env.OIDC_ROLE_PROJECT_ID = 'proj-synth';
resetState();

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
beforeEach(resetState);

function startLink(userId: number | null, body: unknown = { currentPassword: 'correct-pw' }) {
  return fetch(`${baseUrl}/api/auth/oidc/link/self/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(userId === null ? {} : { 'x-test-user-id': String(userId) }),
    },
    body: JSON.stringify(body),
  });
}

type Transaction = { state: string; cookie: string };

async function startedLink(userId = 12): Promise<Transaction> {
  const res = await startLink(userId);
  assert.equal(res.status, 200);
  const { authorizationUrl } = await res.json() as { authorizationUrl: string };
  return {
    state: new URL(authorizationUrl).searchParams.get('state') ?? '',
    cookie: (res.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
  };
}

async function startedLogin(): Promise<Transaction> {
  const res = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return {
    state: new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? '',
    cookie: (res.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
  };
}

function callback({ state, cookie }: Transaction) {
  return fetch(`${baseUrl}/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=provider-code`, {
    headers: { cookie },
    redirect: 'manual',
  });
}

async function exchange(res: Response, cookie: string) {
  const code = new URL(res.headers.get('location') ?? '', 'https://app.example').searchParams.get('oidc_code');
  const redeemed = await fetch(`${baseUrl}/api/auth/oidc/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ code }),
  });
  return { status: redeemed.status, body: await redeemed.json() };
}

const auditEvents = () => audits.map((record) => record.event);
const failureReasons = () => audits
  .filter((record) => record.event === 'oidc_identity_self_link_failed')
  .map((record) => (record.metadata as { reason: string }).reason);

// ---------------------------------------------------------------------------
// POST /link/self/start
// ---------------------------------------------------------------------------

test('start: OIDC off answers 501 before authentication, like every OIDC route', async () => {
  process.env.OIDC_ENABLED = 'false';
  const res = await startLink(null);
  assert.equal(res.status, 501);
  const status = await fetch(`${baseUrl}/api/auth/oidc/link/self`, { headers: { 'x-test-user-id': '12' } });
  assert.equal(status.status, 501);
  assert.deepEqual(passwordChecks, []);
});

test('start: requires an authenticated caller and a password', async () => {
  assert.equal((await startLink(null)).status, 401);
  const missing = await startLink(12, {});
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'current_password_required');
  assert.deepEqual(passwordChecks, []);
});

test('start: a wrong password is 401 with a NON-session code and starts nothing', async () => {
  const res = await startLink(12, { currentPassword: 'wrong' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.code, 'current_password_incorrect', 'a code-less 401 would sign the member out');
  assert.equal(res.headers.get('set-cookie'), null, 'no transaction cookie');
  assert.deepEqual(passwordChecks, ['hash-12']);
  assert.deepEqual(failureReasons(), ['bad_current_password']);
  assert.ok(!JSON.stringify(audits).includes('wrong'));
});

test('start: the per-account limiter answers 429 BEFORE any argon2 verification', async () => {
  assert.equal(selfLinkLimiterOptions?.max, 5);
  assert.equal(selfLinkLimiterOptions?.windowMs, 15 * 60_000);
  assert.equal(selfLinkLimiterOptions?.key?.({ user: { id: 12 } }), 'oidc-self-link:12');
  rateLimitExhausted = true;
  const res = await startLink(12);
  assert.equal(res.status, 429);
  assert.deepEqual(passwordChecks, [], 'argon2 never ran');
});

test('start: an account that must change its password is refused without a password check', async () => {
  users.get(12)!.must_change_password = 1;
  const res = await startLink(12);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'password_change_required');
  assert.deepEqual(passwordChecks, []);
});

test('start: an account already linked for this issuer gets 409 already_linked', async () => {
  identities.push({ id: 1, user_id: 12, issuer: ISSUER, subject: 'subject-old', last_attested_at: 1 });
  const res = await startLink(12);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'already_linked');
  assert.equal(res.headers.get('set-cookie'), null);
});

test('start: success returns a forced-reauth authorization URL and the transaction cookie', async () => {
  const res = await startLink(12);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { authorizationUrl } = await res.json();
  const params = new URL(authorizationUrl).searchParams;
  assert.equal(params.get('prompt'), 'login');
  assert.equal(params.get('max_age'), '0');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.ok(params.get('state') && params.get('nonce') && params.get('code_challenge'));
  const cookie = res.headers.get('set-cookie') ?? '';
  assert.match(cookie, /__Host-oidc-txn=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
});

test('GET /link/self reports only the caller\'s own link state', async () => {
  const status = () => fetch(`${baseUrl}/api/auth/oidc/link/self`, { headers: { 'x-test-user-id': '12' } })
    .then((res) => res.json());
  assert.deepEqual(await status(), { linked: false, ssoStepUp: false });
  identities.push({ id: 1, user_id: 30, issuer: ISSUER, subject: 'other', last_attested_at: 1 });
  assert.deepEqual(await status(), { linked: false, ssoStepUp: false });
  identities.push({ id: 2, user_id: 12, issuer: ISSUER, subject: 'mine', last_attested_at: 1 });
  assert.deepEqual(await status(), { linked: true, ssoStepUp: true });
});

// ---------------------------------------------------------------------------
// /callback — 'link' branch
// ---------------------------------------------------------------------------

test('link: success links the starter, stamps the attestation, audits ids only, and signs them in', async () => {
  const txn = await startedLink(12);
  const before = Date.now();
  const res = await callback(txn);
  assert.equal(res.status, 302);
  assert.equal(identities.length, 1);
  const [link] = identities;
  assert.equal(link.user_id, 12);
  assert.equal(link.subject, 'subject-new');
  assert.ok(link.last_attested_at !== null && link.last_attested_at >= before, 'stamped in the same write');
  const audit = audits.find((record) => record.event === 'oidc_identity_self_linked');
  assert.deepEqual(audit?.metadata, { provider: 'oidc', identityId: link.id });
  assert.equal(audit?.userId, 12);
  assert.ok(!JSON.stringify(audits).includes('subject-new'), 'the subject is never audited');
  assert.deepEqual(await exchange(res, txn.cookie), { status: 200, body: { token: 'jwt-for-12', userId: 12 } });
  assert.deepEqual(minted, [12]);
  // qa slice-5 finding 3: every member self-link alerts the owner(s).
  assert.deepEqual(notifications, [1], 'the owner is alerted about a member link');
  const alert = audits.find((record) => record.event === 'oidc_owner_alerted');
  assert.deepEqual(alert?.metadata, { provider: 'oidc', kind: 'member_linked', ownerCount: 1 });
  assert.equal(alert?.userId, 12);
});

test('link: the state is single-use', async () => {
  const txn = await startedLink(12);
  assert.equal((await callback(txn)).status, 302);
  const replay = await callback(txn);
  assert.equal(replay.status, 302, 'an unknown state returns to the SPA, never raw JSON');
  assert.equal(new URL(replay.headers.get('location') ?? '', 'https://app.example').search, '?error=invalid_state');
  assert.equal(identities.length, 1);
});

test('link: the callback must come from the browser that started it', async () => {
  const txn = await startedLink(12);
  const res = await callback({ state: txn.state, cookie: '' });
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location') ?? '', 'https://app.example').search,
    '?error=transaction_expired', 'a known link state from another browser is never completed');
  assert.equal(identities.length, 0);
  assert.deepEqual(minted, []);
});

test('link: a missing, stale, or pre-request auth_time is refused and nothing is written', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cases: Array<[unknown, string]> = [
    [undefined, 'auth_time_missing'],
    [nowSeconds - 7 * 60, 'auth_time_before_request'],
    [nowSeconds - 90, 'auth_time_before_request'],
  ];
  for (const [authTime, reason] of cases) {
    audits.length = 0;
    const txn = await startedLink(12);
    claims = { ...claims, auth_time: authTime };
    const res = await callback(txn);
    assert.equal(res.status, 401, reason);
    assert.equal((await res.json()).error, 'oidc_reauth_required');
    assert.deepEqual(failureReasons(), [reason]);
  }
  assert.equal(identities.length, 0);
  assert.deepEqual(minted, []);
});

test('link: an auth_time older than 5 minutes (+60s skew) is stale even if the request was older', async () => {
  const realNow = Date.now;
  const txn = await startedLink(12);
  const signedInAt = Math.floor(realNow() / 1000);
  claims = { ...claims, auth_time: signedInAt };
  // The browser lingered at the IdP: the callback arrives 6m30s after sign-in.
  Date.now = () => realNow() + 6.5 * 60_000;
  let res: Response;
  try {
    res = await callback(txn);
  } finally {
    Date.now = realNow;
  }
  assert.equal(res.status, 401);
  assert.deepEqual(failureReasons(), ['auth_time_stale']);
  assert.equal(identities.length, 0);
});

test('link: an identity without a recognized project role is refused, not downgraded', async () => {
  for (const roleClaims of [{}, { [ROLES_CLAIM]: { 'not-a-role': {} } }]) {
    audits.length = 0;
    const txn = await startedLink(12);
    claims = { sub: 'subject-new', auth_time: Math.floor(Date.now() / 1000), ...roleClaims };
    const res = await callback(txn);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'oidc_not_authorized');
    assert.equal(failureReasons().length, 1);
  }
  assert.equal(identities.length, 0);
  assert.equal(users.get(12)?.role, 'user');
});

test('link: a subject already linked to another account is 409 and never logs that account in', async () => {
  identities.push({ id: 1, user_id: 30, issuer: ISSUER, subject: 'subject-new', last_attested_at: 1 });
  const txn = await startedLink(12);
  const res = await callback(txn);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'oidc_subject_taken');
  assert.deepEqual(minted, [], 'no session for user 30 (or anyone)');
  assert.equal(identities.length, 1);
  assert.deepEqual(failureReasons(), ['subject_taken']);
});

test('link: a starter disabled or deleted before the callback is refused', async () => {
  for (const change of ['disable', 'delete'] as const) {
    resetState();
    const txn = await startedLink(12);
    if (change === 'disable') users.get(12)!.active = false;
    else users.delete(12);
    const res = await callback(txn);
    assert.equal(res.status, 401, change);
    assert.deepEqual(failureReasons(), ['account_unavailable']);
    assert.equal(identities.length, 0);
    assert.deepEqual(minted, []);
  }
});

test('link: a link made meanwhile for this issuer (race) is 409 already_linked', async () => {
  const txn = await startedLink(12);
  identities.push({ id: 1, user_id: 12, issuer: ISSUER, subject: 'subject-other', last_attested_at: 1 });
  const res = await callback(txn);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'already_linked');
});

test('link: a unique conflict at write time is 409; a failed stamp rolls the link back', async () => {
  let txn = await startedLink(12);
  linkConflict = true;
  let res = await callback(txn);
  assert.equal(res.status, 409);
  assert.deepEqual(failureReasons(), ['link_conflict']);

  resetState();
  txn = await startedLink(12);
  stampFailure = true;
  res = await callback(txn);
  assert.equal(res.status, 500);
  assert.equal(identities.length, 0, 'no link without its attestation');
  assert.deepEqual(failureReasons(), ['link_failed']);
  assert.deepEqual(minted, []);
});

test('link: the owner linking their own account raises the owner alert, WARN and audit', async () => {
  const writes: string[] = [];
  const write = mock.method(process.stderr, 'write', (chunk: string) => { writes.push(String(chunk)); return true; });
  let res: Response;
  try {
    const txn = await startedLink(1);
    res = await callback(txn);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    write.mock.restore();
  }
  assert.equal(res.status, 302);
  assert.equal(identities[0]?.user_id, 1);
  assert.equal(users.get(1)?.role, 'owner', 'the IdP role never replaces owner');
  assert.ok(auditEvents().includes('oidc_owner_account_linked'));
  assert.deepEqual(notifications, [1]);
  assert.ok(writes.some((line) => JSON.parse(line).code === 'owner_account_self_linked'));
  assert.ok(!writes.join('').includes('subject-new'));
});

test('link: the attested role is applied through the shared mapper', async () => {
  const txn = await startedLink(12);
  claims = { ...claims, [ROLES_CLAIM]: { admin: { '1': 'org.example' } } };
  const res = await callback(txn);
  assert.equal(res.status, 302);
  assert.equal(users.get(12)?.role, 'admin');
  assert.ok(auditEvents().includes('external_role_synced'));
});

test('link: with an org allowlist, a role granted only by a foreign org is refused', async () => {
  process.env.OIDC_ALLOWED_ORG_IDS = '1';
  const txn = await startedLink(12);
  claims = { ...claims, [ROLES_CLAIM]: { admin: { '999': 'foreign.example' } } };
  const res = await callback(txn);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'oidc_not_authorized');
  assert.deepEqual(failureReasons(), ['org_not_allowed']);
  assert.equal(identities.length, 0);
  assert.equal(users.get(12)?.role, 'user');
});

test('link: with an org allowlist, a foreign admin grant never raises the role', async () => {
  process.env.OIDC_ALLOWED_ORG_IDS = '1';
  const txn = await startedLink(12);
  claims = { ...claims, [ROLES_CLAIM]: { ...MEMBER_ROLE, admin: { '999': 'foreign.example' } } };
  const res = await callback(txn);
  assert.equal(res.status, 302);
  assert.equal(identities.length, 1);
  assert.equal(users.get(12)?.role, 'user');
});

test('link: without an org allowlist a grant of any org still counts (unchanged)', async () => {
  const txn = await startedLink(12);
  claims = { ...claims, [ROLES_CLAIM]: { admin: { '999': 'foreign.example' } } };
  assert.equal((await callback(txn)).status, 302);
  assert.equal(users.get(12)?.role, 'admin');
});

// ---------------------------------------------------------------------------
// Purpose separation
// ---------------------------------------------------------------------------

test('a login transaction never links: an unknown subject stays unlinked', async () => {
  const txn = await startedLogin();
  const res = await callback(txn);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/oidc/return?error=oidc_not_linked');
  assert.equal(identities.length, 0);
  assert.ok(!auditEvents().includes('oidc_identity_self_linked'));
});

test('a link transaction never logs in by subject: it cannot reach the subject\'s account', async () => {
  // The IdP subject belongs to user 30; user 12 starts a link and returns with it.
  identities.push({ id: 1, user_id: 30, issuer: ISSUER, subject: 'subject-new', last_attested_at: 1 });
  const linkTxn = await startedLink(12);
  const linkRes = await callback(linkTxn);
  assert.equal(linkRes.status, 409);
  assert.deepEqual(minted, []);

  // The same subject through an ordinary login does sign user 30 in — the
  // branch, not the subject, decides what a transaction may do.
  const loginTxn = await startedLogin();
  const loginRes = await callback(loginTxn);
  assert.equal(loginRes.status, 302);
  assert.deepEqual(minted, [30]);
  assert.equal(identities.length, 1, 'login never adds a link');
});

test('a link transaction signs in only the account that started it', async () => {
  const txn = await startedLink(12);
  const res = await callback(txn);
  assert.equal(res.status, 302);
  const redeemed = await exchange(res, txn.cookie);
  assert.equal(redeemed.body.userId, 12);
  assert.deepEqual(minted, [12]);
});
