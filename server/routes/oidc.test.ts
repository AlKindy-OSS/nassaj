import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createSsoConfigDouble, doubleMapping } from '../services/__tests__/sso-config-double.js';
import { createSsoRuntimeDouble } from '../services/__tests__/sso-runtime-double.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
// Project-scoped roles claim in the nested-grant shape (fixture data, neutral name).
const ROLES_CLAIM = 'urn:example:iam:org:project:proj-synth:roles';
const GENERIC_ROLES_CLAIM = 'urn:example:iam:org:project:roles';
const sso = createSsoConfigDouble({ mapping: doubleMapping({ role_claim_path: `["${ROLES_CLAIM}"]` }) });
let currentTransaction: string | null = null;
const audits: Array<Record<string, unknown>> = [];
const revocations: number[] = [];
const refreshInvalidations: number[] = [];
let unlinkedUserId: number | null = null;
let storedCode: Record<string, unknown> | null = null;
const mintedRoles: string[] = [];
// Default attestation carries a recognized role on the configured project (T-1939).
let verifiedClaims: Record<string, unknown> = {
  sub: 'subject-synthetic',
  [ROLES_CLAIM]: { member: { '1': 'org.example' } },
};
const attestations: Array<{ identityId: number; userId: number; at: number }> = [];
let attestationFailure: 'throw' | 'no_row' | null = null;
let verifyFailure: Error | null = null;
const storedUser = { id: 12, username: 'linked', role: 'user', password_changed_at: 1 };
const identityRevocations: Array<{ userId: number; revocation: unknown }> = [];
// B-1410: per-id rows behind getRawById, and failure/limit switches.
const rawUsers = new Map<number, { id: number; role: string; password_hash?: string }>([
  [1, { id: 1, role: 'owner', password_hash: 'hash-owner' }],
  [2, { id: 2, role: 'owner', password_hash: 'hash-owner-2' }],
  [3, { id: 3, role: 'admin', password_hash: 'hash-admin' }],
  [12, { id: 12, role: 'user', password_hash: 'hash-user' }],
]);
let unlinkFailure: Error | null = null;
let selfUnlinkLimitExhausted = false;
let selfUnlinkLimiterOptions: { key?: (req: unknown) => string; max?: number } | null = null;
let ownerLinkCount = 0;
let liveRevocationFailure: Error | null = null;
// T-1939 slice 3: API-key revocation on grant withdrawal / back-channel logout.
const apiKeyRevocations: number[] = [];
let apiKeyCount = 2;
let apiKeyFailure: Error | null = null;
let identityUserId = 12;
// T-1939 slice 5: legacy duplicate (user, issuer) links.
let userIssuerLinkCount = 1;
let duplicateUsersCount = 0;

let storedConfigVersion: unknown = null;
const pkceStore = {
  store: (_state: string, value: Record<string, unknown>) => {
    currentTransaction = typeof value.browserTransaction === 'string' ? value.browserTransaction : null;
    storedConfigVersion = value.configVersion;
    return currentTransaction !== null;
  },
  consume: (state: string, browserTransaction: string | null) => (
    state === 'state-synthetic' && browserTransaction === currentTransaction
      ? { nonce: 'nonce-synthetic', codeVerifier: 'verifier-synthetic', purpose: 'login', configVersion: storedConfigVersion }
      : null
  ),
  consumeWithOutcome: (state: string, browserTransaction: string | null) => ({
    entry: pkceStore.consume(state, browserTransaction), stalePurpose: null,
  }),
};
const codeStore = {
  store: (code: string, value: Record<string, unknown>) => {
    storedCode = { code, ...value };
    return true;
  },
  consume: (code: string, browserTransaction: string | null) => (
    code === storedCode?.code && browserTransaction === currentTransaction
      ? { token: storedCode.token, userId: storedCode.userId }
      : null
  ),
  discard: (code: string) => {
    if (code !== storedCode?.code) return false;
    storedCode = null;
    return true;
  },
};

mock.module(url('../middleware/auth.js'), {
  namedExports: {
    authenticateToken: passThrough,
    generateToken: (user: { role: string }) => {
      mintedRoles.push(user.role);
      return 'jwt-synthetic';
    },
    invalidateRefreshCache: (userId: number) => refreshInvalidations.push(userId),
    requireRole: (...roles: string[]) => (
      req: { user?: { role?: string } },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void,
    ) => (roles.includes(req.user?.role ?? '') ? next() : res.status(403).json({ error: 'Insufficient permissions' })),
  },
});
mock.module(url('../modules/account-wallet/user-identity-revocation.js'), {
  namedExports: {
    revokeUserIdentity: (userId: number, revocation: unknown) => {
      if (liveRevocationFailure) throw liveRevocationFailure;
      identityRevocations.push({ userId, revocation });
      return { abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 };
    },
  },
});
mock.module(url('../middleware/rate-limit.js'), {
  namedExports: {
    createRateLimiter: (options: { code?: string; key?: (req: unknown) => string; max?: number }) => {
      if (options?.code !== 'oidc_self_unlink_rate_limited') return passThrough;
      selfUnlinkLimiterOptions = options;
      return (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }, next: () => void) => (
        selfUnlinkLimitExhausted ? res.status(429).json({ code: options.code }) : next()
      );
    },
  },
});
mock.module(url('../services/password.service.js'), {
  namedExports: {
    verifyPassword: async (hash: string, password: string) => hash === 'hash-owner' && password === 'correct-pw',
  },
});
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    apiKeysDb: {
      revokeAllForUser: (userId: number) => {
        if (apiKeyFailure) throw apiKeyFailure;
        apiKeyRevocations.push(userId);
        return apiKeyCount;
      },
    },
    auditLogDb: { record: (event: string, data: Record<string, unknown>) => audits.push({ event, ...data }) },
    getConnection: () => ({
      prepare: () => ({ run: (_stamp: number, userId: number) => revocations.push(userId) }),
      // Mirrors better-sqlite3: a throw inside rolls back the stamps it wrote.
      transaction: (fn: () => void) => () => {
        const mark = revocations.length;
        try {
          fn();
        } catch (error) {
          revocations.length = mark;
          throw error;
        }
      },
    }),
    userDb: {
      getUserById: () => ({ ...storedUser }),
      setRoleIfUnchanged: (_id: number, from: string, to: string) => {
        if (storedUser.role !== from || from === 'owner' || to === 'owner') return false;
        storedUser.role = to;
        return true;
      },
      getRawById: (id: number) => rawUsers.get(id),
      updateLastLogin: () => {},
    },
    userIdentitiesDb: {
      findByIssuerAndSubject: () => ({ id: 40, user_id: identityUserId }),
      markAttested: (identityId: number, userId: number, at: number) => {
        if (attestationFailure === 'throw') throw new Error('database is locked');
        if (attestationFailure === 'no_row') return false;
        attestations.push({ identityId, userId, at });
        return true;
      },
      unlinkAll: (userId: number) => {
        if (unlinkFailure) throw unlinkFailure;
        unlinkedUserId = userId;
      },
      countLinkedUsersWithRole: (role: string) => (role === 'owner' ? ownerLinkCount : 0),
      countForUserAndIssuer: () => userIssuerLinkCount,
      countUsersWithDuplicateIssuerLinks: () => duplicateUsersCount,
    },
  },
});
mock.module(url('../services/notification-orchestrator.js'), {
  namedExports: { createNotificationEvent: (event: unknown) => event, notifyUserIfEnabled: () => {} },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });
mock.module(url('../services/oidc-pkce.store.js'), { namedExports: { oidcPkceStore: pkceStore } });
mock.module(url('../services/oidc-code.store.js'), { namedExports: { oidcCodeStore: codeStore } });
mock.module(url('../services/oidc-verifier.service.js'), {
  namedExports: {
    parseExactHttpsIssuer: (issuer: string) => issuer,
    idTokenAuthTimeMs: (claims: { auth_time?: number }) => (
      typeof claims?.auth_time === 'number' ? claims.auth_time * 1000 : null
    ),
  },
});
// ADR-194: the routes read the SSO configuration rows, never OIDC_* env.
const ssoRuntime = createSsoRuntimeDouble(sso, {
  exchangeAuthorizationCode: async () => ({ id_token: 'id-token-synthetic' }),
  verifyIdToken: async () => {
    if (verifyFailure) throw verifyFailure;
    return verifiedClaims;
  },
  verifyLogoutToken: async () => ({ sub: 'subject-synthetic' }),
});

mock.module(url('../services/sso-config.service.js'), { namedExports: sso.exports });
mock.module(url('../services/sso-oidc-runtime.service.js'), { namedExports: ssoRuntime.exports });
for (const key of ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI']) delete process.env[key];

const { default: oidcRouter } = await import('./oidc.js');
const { warnOnOwnerOidcLinks } = await import('../services/oidc-owner-link-check.js');
const app = express();
app.use(express.json());
// Caller identity is driven per request by test headers (default: owner id 1).
app.use((req, _res, next) => {
  const id = Number(req.headers['x-test-user-id'] ?? 1);
  const role = String(req.headers['x-test-role'] ?? 'owner');
  (req as { user?: unknown }).user = { id, role };
  next();
});
app.use('/api/auth/oidc', oidcRouter);
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('OIDC browser transaction cookie binds callback and POST exchange, with no-store', async () => {
  const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie') ?? '';
  assert.match(cookie, /__Host-oidc-txn=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  const cookiePair = cookie.split(';', 1)[0];
  assert.ok(cookiePair);

  const callback = await fetch(`${baseUrl}/api/auth/oidc/callback?state=state-synthetic&code=provider-code`, {
    headers: { cookie: cookiePair },
    redirect: 'manual',
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  const oneTimeCode = new URL(callback.headers.get('location') ?? '', 'https://app.example').searchParams.get('oidc_code');
  assert.ok(oneTimeCode);

  const getExchange = await fetch(`${baseUrl}/api/auth/oidc/exchange?code=${oneTimeCode}`);
  assert.equal(getExchange.status, 404, 'query-string exchange is not exposed');

  const stolenExchange = await fetch(`${baseUrl}/api/auth/oidc/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: oneTimeCode }),
  });
  assert.equal(stolenExchange.status, 401);

  const exchange = await fetch(`${baseUrl}/api/auth/oidc/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookiePair },
    body: JSON.stringify({ code: oneTimeCode }),
  });
  assert.equal(exchange.status, 200);
  assert.equal(exchange.headers.get('cache-control'), 'no-store');
  assert.match(exchange.headers.get('set-cookie') ?? '', /__Host-oidc-txn=;/);
  assert.deepEqual(await exchange.json(), { token: 'jwt-synthetic', userId: 12 });
  assert.equal(storedCode?.browserTransaction, currentTransaction);
  assert.ok(audits.every((record) => !JSON.stringify(record).includes('subject-synthetic')));
});

function resetUnlinkState() {
  revocations.length = 0;
  refreshInvalidations.length = 0;
  identityRevocations.length = 0;
  audits.length = 0;
  unlinkedUserId = null;
  unlinkFailure = null;
  selfUnlinkLimitExhausted = false;
  liveRevocationFailure = null;
  apiKeyRevocations.length = 0;
  apiKeyCount = 2;
}

const IDENTITY_UNLINK_REVOCATION = { abortReason: null, endInteractiveSessions: true };

function unlinkUser(userId: number | string, caller: { id: number; role: string } = { id: 1, role: 'owner' }) {
  return fetch(`${baseUrl}/api/auth/oidc/link/${userId}`, {
    method: 'DELETE',
    headers: { 'x-test-user-id': String(caller.id), 'x-test-role': caller.role },
  });
}

function unlinkSelf(body: unknown, caller: { id: number; role: string } = { id: 1, role: 'owner' }) {
  return fetch(`${baseUrl}/api/auth/oidc/link/self`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      'x-test-user-id': String(caller.id),
      'x-test-role': caller.role,
    },
    body: JSON.stringify(body),
  });
}

test('B-1410: the admin POST /link route no longer exists', async () => {
  resetUnlinkState();
  const link = await fetch(`${baseUrl}/api/auth/oidc/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetUserId: 1, subject: 'attacker-subject' }),
  });
  assert.equal(link.status, 404);
  assert.equal(audits.length, 0);
});

test('B-1410: owner unlinks a lower-ranked member in one transaction, then cuts live access', async () => {
  resetUnlinkState();
  const res = await unlinkUser(3);
  assert.equal(res.status, 200);
  assert.equal(unlinkedUserId, 3);
  assert.deepEqual(revocations, [3], 'password_changed_at bumped');
  assert.deepEqual(refreshInvalidations, [3]);
  assert.deepEqual(identityRevocations, [{ userId: 3, revocation: IDENTITY_UNLINK_REVOCATION }]);
  const audit = audits.find((record) => record.event === 'oidc_identity_unlinked');
  assert.deepEqual(audit?.metadata, { targetUserId: 3 });
  assert.equal(audit?.userId, 1);
});

test('T-1946: unlinking a member deletes their API keys in the unlink transaction', async () => {
  resetUnlinkState();
  const res = await unlinkUser(3);
  assert.equal(res.status, 200);
  assert.deepEqual(apiKeyRevocations, [3]);
  const audit = audits.find((record) => record.event === 'api_keys_revoked_sso');
  assert.deepEqual(audit?.metadata, { trigger: 'identity_unlinked', count: 2 });
  assert.equal(audit?.userId, 3);

  resetUnlinkState();
  apiKeyCount = 0;
  assert.equal((await unlinkUser(3)).status, 200);
  assert.ok(!audits.some((record) => record.event === 'api_keys_revoked_sso'), 'no keys → no audit');

  resetUnlinkState();
  unlinkFailure = new Error('disk full');
  assert.equal((await unlinkUser(3)).status, 500);
  assert.deepEqual(apiKeyRevocations, [], 'a failed unlink deletes no key');
});

test('B-1410: a live-revocation failure never blocks the audit or the response', async () => {
  resetUnlinkState();
  liveRevocationFailure = new Error('ws layer down');
  const res = await unlinkUser(12);
  assert.equal(res.status, 200);
  assert.deepEqual(revocations, [12], 'the committed stamp stands');
  assert.ok(audits.some((record) => record.event === 'oidc_identity_unlinked'));
});

test('B-1410: an admin may not unlink anyone', async () => {
  resetUnlinkState();
  const res = await unlinkUser(12, { id: 3, role: 'admin' });
  assert.equal(res.status, 403);
  assert.equal(unlinkedUserId, null);
  assert.deepEqual(revocations, []);
});

test('B-1410: owner→owner and owner→self are refused and audited', async () => {
  for (const target of [2, 1]) {
    resetUnlinkState();
    const res = await unlinkUser(target);
    assert.equal(res.status, 403, `target ${target}`);
    assert.equal(unlinkedUserId, null);
    assert.deepEqual(revocations, []);
    assert.deepEqual(identityRevocations, []);
    const denial = audits.find((record) => record.event === 'insufficient_role');
    assert.deepEqual(denial?.metadata, {
      required: 'strictly_higher_than_target',
      actual: 'owner',
      targetUserId: target,
      targetRole: 'owner',
      context: 'oidc_unlink',
    });
  }
});

test('B-1410: an unknown user is 404 before any rank decision; a bad id is 400', async () => {
  resetUnlinkState();
  assert.equal((await unlinkUser(999)).status, 404);
  assert.equal((await unlinkUser('abc')).status, 400);
  assert.equal(audits.length, 0);
});

test('B-1410: a failed unlink never bumps the session stamp or cuts live access', async () => {
  resetUnlinkState();
  unlinkFailure = new Error('disk full');
  const res = await unlinkUser(12);
  assert.equal(res.status, 500);
  assert.deepEqual(revocations, []);
  assert.deepEqual(refreshInvalidations, []);
  assert.deepEqual(identityRevocations, []);
  assert.ok(!audits.some((record) => record.event === 'oidc_identity_unlinked'));
});

test('B-1410 C1: owner self-unlink with the right password', async () => {
  resetUnlinkState();
  const res = await unlinkSelf({ currentPassword: 'correct-pw' });
  assert.equal(res.status, 200);
  assert.equal(unlinkedUserId, 1);
  assert.deepEqual(revocations, [1]);
  assert.deepEqual(identityRevocations, [{ userId: 1, revocation: IDENTITY_UNLINK_REVOCATION }]);
  const audit = audits.find((record) => record.event === 'oidc_identity_self_unlinked');
  assert.equal(audit?.userId, 1);
  assert.ok(audits.every((record) => !JSON.stringify(record).includes('correct-pw')));
  assert.deepEqual(apiKeyRevocations, [], 'the owner keeps its API keys');
});

test('B-1410 C1: a wrong password is 401, audited without the password, and unlinks nothing', async () => {
  resetUnlinkState();
  const res = await unlinkSelf({ currentPassword: 'wrong-pw' });
  assert.equal(res.status, 401);
  // B-1405 fix: a `code` is required on this 401, or isSessionRejection()
  // (src/utils/api.js) treats it as a rejected session and signs the owner
  // out on a mere password typo.
  assert.equal((await res.clone().json()).code, 'current_password_incorrect');
  assert.equal(unlinkedUserId, null);
  assert.deepEqual(revocations, []);
  const failure = audits.find((record) => record.event === 'oidc_identity_self_unlink_failed');
  assert.deepEqual(failure?.metadata, { reason: 'bad_current_password' });
  assert.ok(audits.every((record) => !JSON.stringify(record).includes('wrong-pw')));

  assert.equal((await unlinkSelf({})).status, 400, 'a missing password is a 400');
});

test('B-1410 C1: an owner with no password_hash gets the same coded 401', async () => {
  resetUnlinkState();
  rawUsers.set(2, { id: 2, role: 'owner', password_hash: undefined });
  try {
    const res = await unlinkSelf({ currentPassword: 'anything' }, { id: 2, role: 'owner' });
    assert.equal(res.status, 401);
    assert.equal((await res.clone().json()).code, 'current_password_incorrect');
    assert.equal(unlinkedUserId, null);
  } finally {
    rawUsers.set(2, { id: 2, role: 'owner', password_hash: 'hash-owner-2' });
  }
});

test('B-1410 C1: unlinkAll failure is a 500, audited, and never bumps the password stamp', async () => {
  resetUnlinkState();
  unlinkFailure = new Error('db_unavailable');
  const res = await unlinkSelf({ currentPassword: 'correct-pw' });
  assert.equal(res.status, 500);
  assert.equal(unlinkedUserId, null);
  assert.deepEqual(revocations, [], 'the failed transaction rolls back the stamp bump');
  const failure = audits.find((record) => record.event === 'oidc_identity_self_unlink_failed');
  assert.deepEqual(failure?.metadata, { reason: 'unlink_failed' });
});

test('B-1410 C1: self-unlink is owner only', async () => {
  resetUnlinkState();
  const res = await unlinkSelf({ currentPassword: 'correct-pw' }, { id: 3, role: 'admin' });
  assert.equal(res.status, 403);
  assert.equal(unlinkedUserId, null);
});

test('B-1410 C1: self-unlink is rate limited per account', async () => {
  resetUnlinkState();
  assert.equal(selfUnlinkLimiterOptions?.max, 5);
  assert.equal(selfUnlinkLimiterOptions?.key?.({ user: { id: 1 } }), 'oidc-self-unlink:1');
  selfUnlinkLimitExhausted = true;
  const res = await unlinkSelf({ currentPassword: 'correct-pw' });
  assert.equal(res.status, 429);
  assert.equal(unlinkedUserId, null);
});

test('B-1410: boot warns once, with a count only, when an owner holds an SSO link', () => {
  const writes: string[] = [];
  const write = mock.method(process.stderr, 'write', (chunk: string) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    ownerLinkCount = 0;
    warnOnOwnerOidcLinks();
    assert.deepEqual(writes, []);
    ownerLinkCount = 1;
    warnOnOwnerOidcLinks();
  } finally {
    write.mock.restore();
    ownerLinkCount = 0;
  }
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0] ?? '{}'), {
    level: 'warn', scope: 'oidc', code: 'owner_account_has_sso_link', ownerCount: 1,
  });
});

// Roles are read ONLY from the project-scoped claim (fail-closed).

async function runCallback() {
  const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  const cookiePair = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  return fetch(`${baseUrl}/api/auth/oidc/callback?state=state-synthetic&code=provider-code`, {
    headers: { cookie: cookiePair },
    redirect: 'manual',
  });
}

function resetLoginState(role: string, claims: Record<string, unknown>) {
  storedUser.role = role;
  verifiedClaims = { sub: 'subject-synthetic', ...claims };
  verifyFailure = null;
  storedCode = null;
  mintedRoles.length = 0;
  audits.length = 0;
  attestations.length = 0;
  attestationFailure = null;
  revocations.length = 0;
  refreshInvalidations.length = 0;
  identityRevocations.length = 0;
  apiKeyRevocations.length = 0;
  identityUserId = 12;
}

test('T-961: a rejected id_token never reaches session creation', async () => {
  resetLoginState('user', {});
  verifyFailure = new Error('signature_or_registered_claim_invalid');
  const callback = await runCallback();
  assert.equal(callback.status, 502);
  assert.equal(storedCode, null, 'no one-time code is issued');
  assert.deepEqual(mintedRoles, [], 'generateToken is never called');
  assert.ok(!audits.some((record) => record.event === 'oidc_login'));
});

test('T-958: the verified roles claim sets the minted role and is audited without PII', async () => {
  resetLoginState('user', { [ROLES_CLAIM]: { admin: { '1': 'org.example' } } });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(mintedRoles, ['admin']);
  const synced = audits.find((record) => record.event === 'external_role_synced');
  assert.deepEqual(synced?.metadata, { provider: 'oidc', from: 'user', to: 'admin' });
  assert.ok(audits.every((record) => !JSON.stringify(record).includes('subject-synthetic')));
});

test('ADR-194 I6: an owner identity is refused with owner_must_sign_in_locally and writes nothing', async () => {
  resetLoginState('owner', { [ROLES_CLAIM]: ['viewer'] });
  const callback = await runCallback();
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/auth/oidc/return?error=owner_must_sign_in_locally');
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(mintedRoles, [], 'no token is minted');
  assert.equal(storedCode, null);
  assert.deepEqual(attestations, [], 'no attestation stamp');
  assert.deepEqual(revocations, []);
  assert.equal(storedUser.role, 'owner');
  assert.deepEqual(audits.map((record) => record.event), ['oidc_owner_sign_in_refused']);
  assert.deepEqual(audits[0]?.metadata, { provider: 'oidc', purpose: 'login' });
});

test('T-958: an attested owner value is ignored', async () => {
  resetLoginState('user', { [ROLES_CLAIM]: ['owner', 'member'] });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(mintedRoles, ['user'], 'an attested owner is ignored');
});

async function assertDeniedWithoutRole(role: string, claims: Record<string, unknown>, reason: string) {
  resetLoginState(role, claims);
  const callback = await runCallback();
  assert.equal(callback.status, 302, role);
  assert.equal(callback.headers.get('location'), '/auth/oidc/return?error=oidc_not_authorized');
  assert.equal(storedCode, null, 'no one-time code is issued');
  assert.deepEqual(mintedRoles, [], 'generateToken is never called');
  assert.equal(storedUser.role, role, 'no downgrade: the stored role is untouched');
  assert.deepEqual(attestations, [], 'a refused login is never attested');
  assert.ok(!audits.some((record) => ['oidc_login', 'external_role_synced'].includes(String(record.event))));
  const denial = audits.find((record) => record.event === 'oidc_access_denied_no_role');
  assert.deepEqual(denial?.metadata, { provider: 'oidc', reason });
  assert.equal(denial?.userId, 12);
  assert.ok(audits.every((record) => !JSON.stringify(record).includes('subject-synthetic')));
}

test('T-1939: an absent roles claim is refused, revoked and audited — never downgraded', async () => {
  await assertDeniedWithoutRole('admin', {}, 'roles_claim_absent');
  assert.deepEqual(revocations, [12], 'existing tokens are stamped stale');
  assert.deepEqual(refreshInvalidations, [12]);
  assert.deepEqual(identityRevocations, [{
    userId: 12, revocation: { abortReason: 'role_changed', endInteractiveSessions: true },
  }]);
});

test('T-1939: a present claim with only unknown roles is refused with its own reason', async () => {
  await assertDeniedWithoutRole('user', { [ROLES_CLAIM]: { superuser: {} } }, 'no_recognized_role');
  assert.deepEqual(identityRevocations.map((entry) => entry.userId), [12]);
});

test('cross-project leak: the generic roles claim alone is refused, not elevated', async () => {
  await assertDeniedWithoutRole('admin', {
    [GENERIC_ROLES_CLAIM]: { admin: { '1': 'org.example' } },
  }, 'roles_claim_absent');
});

test('ADR-194 D5: the claim tenant mode refuses an unlisted tenant with tenant_not_allowed', async () => {
  const saved = sso.state.mapping;
  sso.state.mapping = doubleMapping({
    role_claim_path: 'groups', tenant_mode: 'claim', tenant_claim_path: 'tid', tenant_values_json: '["t-1"]',
  });
  try {
    await assertDeniedWithoutRole('user', { groups: ['member'], tid: 't-2' }, 'tenant_not_allowed');
    resetLoginState('user', { groups: ['admin'], tid: 't-1' });
    assert.equal((await runCallback()).status, 302);
    assert.deepEqual(mintedRoles, ['admin']);
  } finally {
    sso.state.mapping = saved;
  }
});

test('ADR-194: a mapping that vanished mid-flight refuses without treating it as a withdrawal', async () => {
  const saved = sso.state.mapping;
  sso.state.mapping = null;
  try {
    resetLoginState('admin', { [ROLES_CLAIM]: ['admin'] });
    const callback = await runCallback();
    assert.equal(callback.headers.get('location'), '/auth/oidc/return?error=temporarily_unavailable');
    assert.equal(storedCode, null);
    assert.deepEqual(revocations, [], 'no session revocation');
    assert.deepEqual(apiKeyRevocations, [], 'no API key revocation');
    assert.ok(!audits.some((record) => record.event === 'oidc_access_denied_no_role'));
  } finally {
    sso.state.mapping = saved;
  }
});

test('ADR-194 I6: an owner without a role is refused as an owner, before any mapping', async () => {
  resetLoginState('owner', {});
  const callback = await runCallback();
  assert.equal(callback.headers.get('location'), '/auth/oidc/return?error=owner_must_sign_in_locally');
  assert.deepEqual(revocations, []);
  assert.deepEqual(identityRevocations, []);
  assert.deepEqual(apiKeyRevocations, [], 'owner keys are untouched');
  assert.ok(!audits.some((record) => record.event === 'oidc_access_denied_no_role'));
});

test('ADR-194 D9: an apply between start and callback refuses with oidc_config_changed', async () => {
  resetLoginState('user', { [ROLES_CLAIM]: ['member'] });
  const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  const cookiePair = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  ssoRuntime.runtime.version = 8;
  try {
    const callback = await fetch(`${baseUrl}/api/auth/oidc/callback?state=state-synthetic&code=provider-code`, {
      headers: { cookie: cookiePair }, redirect: 'manual',
    });
    assert.equal(callback.headers.get('location'), '/auth/oidc/return?error=oidc_config_changed');
    assert.equal(storedCode, null);
    assert.deepEqual(mintedRoles, []);
    assert.deepEqual(attestations, []);
  } finally {
    ssoRuntime.runtime.version = 7;
  }
});

test('ADR-194 D9: the fence refuses the writes when an apply lands before them', async () => {
  resetLoginState('admin', {});
  ssoRuntime.runtime.fenceVersion = 8;
  try {
    const callback = await runCallback();
    assert.equal(callback.headers.get('location'), '/auth/oidc/return?error=oidc_config_changed');
    assert.deepEqual(revocations, [], 'denyLoginWithoutRole writes nothing on mismatch');
    assert.deepEqual(apiKeyRevocations, []);
    assert.ok(!audits.some((record) => record.event === 'oidc_access_denied_no_role'));
  } finally {
    ssoRuntime.runtime.fenceVersion = null;
  }
});

test('ADR-194 D9: an apply after the JWT is minted drops the one-time code', async () => {
  resetLoginState('user', { [ROLES_CLAIM]: ['member'] });
  ssoRuntime.runtime.postMintVersion = 8;
  try {
    const callback = await runCallback();
    assert.equal(callback.headers.get('location'), '/auth/oidc/return?error=oidc_config_changed');
    assert.equal(storedCode, null, 'the code is deleted');
    assert.ok(!audits.some((record) => record.event === 'oidc_login'));
  } finally {
    ssoRuntime.runtime.postMintVersion = null;
  }
});

test('ADR-194 D2: RFC 9207 iss is checked against the selected config', async () => {
  ssoRuntime.runtime.discoveryFlags = { authorization_response_iss_parameter_supported: true };
  try {
    for (const [query, expected] of [
      ['', 'iss_mismatch'], ['&iss=https%3A%2F%2Fother.example', 'iss_mismatch'],
    ] as const) {
      resetLoginState('user', { [ROLES_CLAIM]: ['member'] });
      const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
      const cookiePair = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
      const callback = await fetch(`${baseUrl}/api/auth/oidc/callback?state=state-synthetic&code=c${query}`, {
        headers: { cookie: cookiePair }, redirect: 'manual',
      });
      assert.equal(callback.headers.get('location'), `/auth/oidc/return?error=${expected}`, query);
      assert.deepEqual(mintedRoles, []);
    }
    resetLoginState('user', { [ROLES_CLAIM]: ['member'] });
    const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
    const cookiePair = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
    const ok = await fetch(`${baseUrl}/api/auth/oidc/callback?state=state-synthetic&code=c&iss=${
      encodeURIComponent('https://issuer.example')}`, { headers: { cookie: cookiePair }, redirect: 'manual' });
    assert.match(ok.headers.get('location') ?? '', /oidc_code=/);
  } finally {
    ssoRuntime.runtime.discoveryFlags = {};
  }
});

test('T-1939: a live-revocation failure still refuses the login', async () => {
  liveRevocationFailure = new Error('ws layer down');
  try {
    await assertDeniedWithoutRole('user', {}, 'roles_claim_absent');
  } finally {
    liveRevocationFailure = null;
  }
});

test('T-1939: a successful login stamps last_attested_at on the matched link', async () => {
  resetLoginState('user', { [ROLES_CLAIM]: ['member'] });
  const before = Date.now();
  assert.equal((await runCallback()).status, 302);
  assert.equal(attestations.length, 1);
  assert.equal(attestations[0]?.identityId, 40);
  assert.equal(attestations[0]?.userId, 12);
  assert.ok((attestations[0]?.at ?? 0) >= before);
});

test('T-1939: the link is stamped before a token exists; a failed stamp issues nothing', async () => {
  for (const failure of ['throw', 'no_row'] as const) {
    resetLoginState('user', { [ROLES_CLAIM]: ['member'] });
    attestationFailure = failure;
    const response = await runCallback();
    assert.equal(response.status, 500, failure);
    assert.equal(storedCode, null, `${failure}: no one-time code`);
    assert.deepEqual(mintedRoles, [], `${failure}: no token minted`);
    assert.ok(!(response.headers.get('location') ?? '').includes('oidc_code'), failure);
  }
  attestationFailure = null;
});

test('fail-closed: browser routes answer 501 while SSO login is unavailable (ADR-194 D1)', async () => {
  sso.state.loginAvailable = false;
  try {
    const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
    assert.equal(login.status, 501, 'login');
    const exchange = await fetch(`${baseUrl}/api/auth/oidc/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x' }),
    });
    assert.equal(exchange.status, 501, 'exchange');
  } finally {
    sso.state.loginAvailable = true;
  }
  // D2: the callback consumes the entry first, then refuses a non-test purpose.
  resetLoginState('user', { [ROLES_CLAIM]: ['member'] });
  const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  const cookiePair = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  sso.state.loginAvailable = false;
  try {
    const callback = await fetch(`${baseUrl}/api/auth/oidc/callback?state=state-synthetic&code=c`, {
      headers: { cookie: cookiePair }, redirect: 'manual',
    });
    assert.equal(callback.headers.get('location'), '/auth/oidc/return?error=sso_unavailable', 'callback');
    assert.deepEqual(mintedRoles, []);
  } finally {
    sso.state.loginAvailable = true;
  }
});

test('B-1327 (qa M1): an SSO downgrade revokes live work; a promotion does not', async () => {
  resetLoginState('user', { [ROLES_CLAIM]: { admin: { '1': 'org.example' } } });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(identityRevocations, [], 'promotion user -> admin changes nothing live');

  resetLoginState('admin', { [ROLES_CLAIM]: ['member'] });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(mintedRoles, ['user']);
  assert.deepEqual(identityRevocations, [{
    userId: 12,
    revocation: { abortReason: 'role_changed', endInteractiveSessions: true },
  }]);

  resetLoginState('owner', { [ROLES_CLAIM]: ['member'] });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(identityRevocations, [], 'an owner identity is refused, so nothing is revoked');
});

// ---------------------------------------------------------------------------
// T-1939 slice 3 — API keys are revoked when the IdP withdraws the grant
// ---------------------------------------------------------------------------

const keyAudits = () => audits.filter((record) => record.event === 'api_keys_revoked_sso');

async function backchannelLogout() {
  return fetch(`${baseUrl}/api/auth/oidc/backchannel-logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logout_token: 'logout-token-synthetic' }),
  });
}

test('T-1939 slice 3: oidc_not_authorized deletes the member\'s API keys, audited by count', async () => {
  await assertDeniedWithoutRole('user', {}, 'roles_claim_absent');
  assert.deepEqual(apiKeyRevocations, [12]);
  assert.deepEqual(keyAudits().map((record) => [record.userId, record.metadata]), [
    [12, { trigger: 'oidc_not_authorized', count: 2 }],
  ]);
});

test('T-1939 slice 3: an owner identity keeps its API keys', async () => {
  resetLoginState('owner', {});
  await runCallback();
  assert.deepEqual(apiKeyRevocations, []);
  assert.deepEqual(keyAudits(), []);
});

test('T-1939 slice 3: no keys to delete → no audit row; a successful login deletes nothing', async () => {
  apiKeyCount = 0;
  try {
    await assertDeniedWithoutRole('user', {}, 'roles_claim_absent');
  } finally {
    apiKeyCount = 2;
  }
  assert.deepEqual(apiKeyRevocations, [12]);
  assert.deepEqual(keyAudits(), []);

  resetLoginState('user', { [ROLES_CLAIM]: ['member'] });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(apiKeyRevocations, []);
});

test('T-1939 slice 3: back-channel logout deletes a member\'s API keys, never the owner\'s', async () => {
  resetLoginState('user', {});
  const response = await backchannelLogout();
  assert.equal(response.status, 200);
  assert.deepEqual(apiKeyRevocations, [12]);
  assert.deepEqual(keyAudits().map((record) => record.metadata), [{ trigger: 'backchannel_logout', count: 2 }]);

  resetLoginState('user', {});
  identityUserId = 1;
  assert.equal((await backchannelLogout()).status, 200);
  assert.deepEqual(apiKeyRevocations, [], 'owner keys are untouched');
  assert.deepEqual(revocations, [], 'owner sessions are untouched (ADR-194 D6)');
});

test('ADR-194 D1: back-channel answers 501 only when the policy is not enforced', async () => {
  sso.setActive(false);
  try {
    assert.equal((await backchannelLogout()).status, 501);
  } finally {
    sso.setActive(true);
  }
});

test('ADR-194 D1: enforced but unverifiable back-channel asks the IdP to retry (503 + Retry-After)', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  sso.state.loginAvailable = false;
  ssoRuntime.runtime.backchannelAvailable = false;
  try {
    resetLoginState('user', {});
    const response = await backchannelLogout();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '300');
    assert.deepEqual(apiKeyRevocations, [], 'nothing is revoked without a verified token');
  } finally {
    ssoRuntime.runtime.backchannelAvailable = true;
    sso.state.loginAvailable = true;
  }
});

test('ADR-194 D1: enforced with login unavailable still verifies and revokes when the verifier parses', async () => {
  sso.state.loginAvailable = false;
  try {
    resetLoginState('user', {});
    assert.equal((await backchannelLogout()).status, 200);
    assert.deepEqual(apiKeyRevocations, [12]);
  } finally {
    sso.state.loginAvailable = true;
  }
});

test('T-1939 slice 3: an API-key revocation failure never changes the response', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  apiKeyFailure = new Error('db locked');
  try {
    assert.equal((await backchannelLogout()).status, 200);
    await assertDeniedWithoutRole('user', {}, 'roles_claim_absent');
    assert.deepEqual(keyAudits(), []);
  } finally {
    apiKeyFailure = null;
  }
});

test('T-1939 slice 5: a login for an account with duplicate links for this issuer is refused', async () => {
  audits.length = 0;
  mintedRoles.length = 0;
  userIssuerLinkCount = 2;
  try {
    const res = await runCallback();
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'oidc_duplicate_links');
    assert.deepEqual(mintedRoles, [], 'no session is minted');
    const audit = audits.find((record) => record.event === 'oidc_login_blocked_duplicate_links');
    assert.equal(audit?.userId, 12);
    assert.ok(!JSON.stringify(audits).includes('subject-synthetic'));
  } finally {
    userIssuerLinkCount = 1;
  }
});

test('T-1939 slice 5: the boot check audits and warns the duplicate-link count only', () => {
  audits.length = 0;
  const writes: string[] = [];
  const write = mock.method(process.stderr, 'write', (chunk: string) => { writes.push(String(chunk)); return true; });
  try {
    duplicateUsersCount = 0;
    warnOnOwnerOidcLinks();
    assert.deepEqual(writes, []);
    assert.equal(audits.length, 0);
    duplicateUsersCount = 3;
    warnOnOwnerOidcLinks();
  } finally {
    write.mock.restore();
    duplicateUsersCount = 0;
  }
  assert.deepEqual(writes.map((line) => JSON.parse(line)), [
    { level: 'warn', scope: 'oidc', code: 'users_with_duplicate_sso_links', duplicateUsers: 3 },
  ]);
  assert.deepEqual(audits, [
    { event: 'oidc_duplicate_links_detected', userId: null, metadata: { duplicateUsers: 3 } },
  ]);
});
