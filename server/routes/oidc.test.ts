import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
let currentTransaction: string | null = null;
const audits: Array<Record<string, unknown>> = [];
const revocations: number[] = [];
const refreshInvalidations: number[] = [];
let unlinkedUserId: number | null = null;
let storedCode: Record<string, unknown> | null = null;
const mintedRoles: string[] = [];
let verifiedClaims: Record<string, unknown> = { sub: 'subject-synthetic' };
let verifyFailure: Error | null = null;
const storedUser = { id: 12, username: 'linked', role: 'user', password_changed_at: 1 };
const identityRevocations: Array<{ userId: number; revocation: unknown }> = [];

const pkceStore = {
  store: (_state: string, value: Record<string, unknown>) => {
    currentTransaction = typeof value.browserTransaction === 'string' ? value.browserTransaction : null;
    return currentTransaction !== null;
  },
  consume: (state: string, browserTransaction: string | null) => (
    state === 'state-synthetic' && browserTransaction === currentTransaction
      ? { nonce: 'nonce-synthetic', codeVerifier: 'verifier-synthetic' }
      : null
  ),
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
};

mock.module(url('../middleware/auth.js'), {
  namedExports: {
    authenticateToken: passThrough,
    generateToken: (user: { role: string }) => {
      mintedRoles.push(user.role);
      return 'jwt-synthetic';
    },
    invalidateRefreshCache: (userId: number) => refreshInvalidations.push(userId),
    requireRole: () => passThrough,
  },
});
mock.module(url('../modules/account-wallet/user-identity-revocation.js'), {
  namedExports: {
    revokeUserIdentity: (userId: number, revocation: unknown) => {
      identityRevocations.push({ userId, revocation });
      return { abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 };
    },
  },
});
mock.module(url('../middleware/rate-limit.js'), { namedExports: { createRateLimiter: () => passThrough } });
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    auditLogDb: { record: (event: string, data: Record<string, unknown>) => audits.push({ event, ...data }) },
    getConnection: () => ({ prepare: () => ({ run: (_stamp: number, userId: number) => revocations.push(userId) }) }),
    userDb: {
      getUserById: () => ({ ...storedUser }),
      setRoleIfUnchanged: (_id: number, from: string, to: string) => {
        if (storedUser.role !== from || from === 'owner' || to === 'owner') return false;
        storedUser.role = to;
        return true;
      },
      getRawById: () => ({ id: 12 }),
      updateLastLogin: () => {},
    },
    userIdentitiesDb: {
      findByIssuerAndSubject: () => ({ user_id: 12 }),
      link: () => {},
      unlinkAll: (userId: number) => { unlinkedUserId = userId; },
    },
  },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });
mock.module(url('../services/oidc-pkce.store.js'), { namedExports: { oidcPkceStore: pkceStore } });
mock.module(url('../services/oidc-code.store.js'), { namedExports: { oidcCodeStore: codeStore } });
mock.module(url('../services/oidc-verifier.service.js'), {
  namedExports: {
    parseExactHttpsIssuer: (issuer: string) => issuer,
    createOidcVerifier: () => ({
      getDiscovery: async () => ({ authorization_endpoint: 'https://issuer.example/authorize' }),
      exchangeAuthorizationCode: async () => ({ id_token: 'id-token-synthetic' }),
      verifyIdToken: async () => {
        if (verifyFailure) throw verifyFailure;
        return verifiedClaims;
      },
      verifyLogoutToken: async () => ({ sub: 'subject-synthetic' }),
    }),
  },
});

process.env.OIDC_ENABLED = 'true';
process.env.OIDC_ISSUER_URL = 'https://issuer.example';
process.env.OIDC_CLIENT_ID = 'client-synthetic';
process.env.OIDC_REDIRECT_URI = 'https://app.example/api/auth/oidc/callback';
// Required for OIDC to be live (fail-closed): role mapping must be project-scoped.
process.env.OIDC_ROLE_PROJECT_ID = 'proj-synth';

const { default: oidcRouter } = await import('./oidc.js');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as { user?: unknown }).user = { id: 1, role: 'owner' }; next(); });
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

test('OIDC unlink revokes active sessions and subject input is bounded', async () => {
  revocations.length = 0;
  refreshInvalidations.length = 0;
  unlinkedUserId = null;
  const unlink = await fetch(`${baseUrl}/api/auth/oidc/link/12`, { method: 'DELETE' });
  assert.equal(unlink.status, 200);
  assert.deepEqual(revocations, [12]);
  assert.deepEqual(refreshInvalidations, [12]);
  assert.equal(unlinkedUserId, 12);

  const oversizedSubject = 's'.repeat(256);
  const link = await fetch(`${baseUrl}/api/auth/oidc/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetUserId: 12, subject: oversizedSubject }),
  });
  assert.equal(link.status, 400);
});

// Roles are read ONLY from the project-scoped claim (fail-closed).
const ROLES_CLAIM = `urn:zitadel:iam:org:project:${process.env.OIDC_ROLE_PROJECT_ID}:roles`;
const GENERIC_ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles';

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

test('T-958: an owner is never demoted and an absent claim lowers an admin to user', async () => {
  resetLoginState('owner', { [ROLES_CLAIM]: ['viewer'] });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(mintedRoles, ['owner']);
  assert.equal(storedUser.role, 'owner');
  assert.ok(!audits.some((record) => record.event === 'external_role_synced'));

  resetLoginState('admin', {});
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(mintedRoles, ['user']);
  // Finding 3: an absent roles claim is audited with a distinct, diagnosable reason.
  const absentSync = audits.find((record) => record.event === 'external_role_synced');
  assert.deepEqual(absentSync?.metadata, {
    provider: 'oidc', from: 'admin', to: 'user', reason: 'roles_claim_absent',
  });

  resetLoginState('user', { [ROLES_CLAIM]: ['owner'] });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(mintedRoles, ['user'], 'an attested owner is ignored');
});

test('cross-project leak: a present-but-unrecognized scoped claim demotes WITHOUT the absent reason', async () => {
  resetLoginState('admin', { [ROLES_CLAIM]: { superuser: {} } });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(mintedRoles, ['user']);
  const sync = audits.find((record) => record.event === 'external_role_synced');
  assert.deepEqual(sync?.metadata, { provider: 'oidc', from: 'admin', to: 'user' },
    'present-but-unrecognized is distinct from claim-absent');
});

test('cross-project leak: the generic roles claim alone never grants a role', async () => {
  // A user who is admin on ANOTHER project (generic claim) but has no grant on
  // the configured project must be demoted, not elevated.
  resetLoginState('admin', { [GENERIC_ROLES_CLAIM]: { admin: { '1': 'org.example' } } });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(mintedRoles, ['user'], 'generic cross-project admin is ignored');
  const sync = audits.find((record) => record.event === 'external_role_synced');
  assert.deepEqual(sync?.metadata, {
    provider: 'oidc', from: 'admin', to: 'user', reason: 'roles_claim_absent',
  }, 'the scoped claim is absent, so the distinct reason is recorded');
});

test('fail-closed: a missing/invalid OIDC_ROLE_PROJECT_ID disables OIDC (routes 501)', async () => {
  const saved = process.env.OIDC_ROLE_PROJECT_ID;
  try {
    delete process.env.OIDC_ROLE_PROJECT_ID;
    const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
    assert.equal(login.status, 501, 'missing project id disables OIDC');

    process.env.OIDC_ROLE_PROJECT_ID = 'bad id with spaces';
    const exchange = await fetch(`${baseUrl}/api/auth/oidc/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x' }),
    });
    assert.equal(exchange.status, 501, 'invalid project id disables OIDC');
  } finally {
    process.env.OIDC_ROLE_PROJECT_ID = saved;
  }
});

test('B-1327 (qa M1): an SSO downgrade revokes live work; a promotion does not', async () => {
  identityRevocations.length = 0;
  resetLoginState('user', { [ROLES_CLAIM]: { admin: { '1': 'org.example' } } });
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(identityRevocations, [], 'promotion user -> admin changes nothing live');

  resetLoginState('admin', {});
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(identityRevocations, [{
    userId: 12,
    revocation: { abortReason: 'role_changed', endInteractiveSessions: true },
  }]);

  identityRevocations.length = 0;
  resetLoginState('owner', {});
  assert.equal((await runCallback()).status, 302);
  assert.deepEqual(identityRevocations, [], 'an owner is never demoted, so nothing is revoked');
});
