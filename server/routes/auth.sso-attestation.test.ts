/**
 * T-1939 slice 3 — SSO attestation window, exercised against the REAL auth
 * middleware and router (same harness shape as auth.refresh-grace.test.ts):
 * bearer REST, auto-renew header, POST /refresh, the grace refresh, the
 * device-session cookie and both WebSocket verifiers. The database module is
 * mocked; `attestedAgoMs` drives user_identities.last_attested_at.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import jwt from 'jsonwebtoken';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

const FIXED_SECRET = 'sso-attestation-test-secret-0123456789';
const DAY_S = 24 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const FRESH_EDGE = 12 * HOUR_MS - MINUTE_MS; // 11:59h
const STALE_EDGE = 12 * HOUR_MS + MINUTE_MS; // 12:01h

delete process.env.JWT_SECRET;
delete process.env.AUTH_REFRESH_GRACE_HOURS;
delete process.env.OIDC_ATTESTATION_MAX_AGE_HOURS;

const row = {
  id: 7,
  username: 'member',
  role: 'user',
  status: 'active',
  avatar_url: null,
  password_hash: '$argon2id$stub',
  password_changed_at: Date.now() - 30 * DAY_S * 1000,
  must_change_password: 0,
  authorization_generation: 1,
};
let linkCount = 1;
let attestedAgoMs: number | null = FRESH_EDGE;
let summaryReads = 0;
const auditCalls: Array<{ event: string; payload: Record<string, unknown> }> = [];

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: {
      getUserById: () => ({ ...row }),
      getRawById: () => ({ ...row }),
      getUserByUsername: () => undefined,
      isAuthorizationPrincipalCurrent: () => true,
      updateLastLogin: () => {},
    },
    userIdentitiesDb: {
      attestationSummary: () => {
        summaryReads += 1;
        return {
          linkCount,
          latestAttestedAt: attestedAgoMs === null ? null : Date.now() - attestedAgoMs,
        };
      },
      hasAnyLink: () => linkCount > 0,
    },
    deviceAccountSessionsDb: {
      resolve: (secret: string) => (secret === 'device-secret'
        ? {
          wallet: { activeSlotId: 'slot-1' },
          principal: {
            deviceSessionId: 'dev-1', slotId: 'slot-1', generation: 1, userId: row.id,
            authorizationGeneration: 1,
          },
        }
        : null),
      isPrincipalCurrent: () => true,
    },
    appConfigDb: { getOrCreateJwtSecret: () => FIXED_SECRET },
    localModelServersDb: {},
    auditLogDb: {
      record: (event: string, payload: Record<string, unknown>) => auditCalls.push({ event, payload }),
    },
    invitesDb: {},
  },
});
mock.module(url('../modules/account-wallet/index.js'), {
  namedExports: { AccountWalletService: class {} },
});
mock.module(url('../services/password.service.js'), {
  namedExports: {
    verifyPassword: async () => true,
    needsRehash: () => false,
    hashPassword: async () => '$argon2id$stub',
  },
});
mock.module(url('../services/invite.service.js'), {
  namedExports: { createInvite: async () => ({}), acceptInvite: async () => ({}), InviteError: Error },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '203.0.113.9' } });
mock.module(url('./webauthn.js'), { defaultExport: express.Router() });
mock.module(url('./oidc.js'), { defaultExport: express.Router() });

const { default: authRouter } = await import('./auth.js');
const {
  JWT_SECRET, authenticateWebSocket, authenticateDeviceWebSocket,
} = await import('../middleware/auth.js');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const { port } = server.address() as AddressInfo;
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const OIDC_KEYS = ['OIDC_ENABLED', 'OIDC_ROLE_PROJECT_ID', 'MULTI_ACCOUNT_SWITCHING'] as const;
const savedEnv = Object.fromEntries(OIDC_KEYS.map((key) => [key, process.env[key]]));
after(() => {
  for (const key of OIDC_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ROLE_PROJECT_ID = 'proj-synth';
  delete process.env.MULTI_ACCOUNT_SWITCHING;
  row.role = 'user';
  linkCount = 1;
  attestedAgoMs = FRESH_EDGE;
  summaryReads = 0;
  auditCalls.length = 0;
});

function tokenIssuedAgo(issuedAgoSeconds: number) {
  const iat = Math.floor(Date.now() / 1000) - issuedAgoSeconds;
  return jwt.sign(
    {
      userId: row.id, username: row.username, role: row.role,
      pwd_iat: row.password_changed_at, auth_gen: row.authorization_generation, iat,
    },
    JWT_SECRET,
    { expiresIn: 7 * DAY_S },
  );
}

async function call(method: string, urlPath: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method, headers });
  const text = await res.text();
  return {
    status: res.status,
    refreshHeader: res.headers.get('x-refreshed-token'),
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('REST: 11:59h since attestation passes, 12:01h is refused with sso_reauth_required', async () => {
  const token = tokenIssuedAgo(60);
  attestedAgoMs = FRESH_EDGE;
  assert.equal((await call('GET', '/api/auth/me', bearer(token))).status, 200);

  attestedAgoMs = STALE_EDGE;
  const stale = await call('GET', '/api/auth/me', bearer(token));
  assert.equal(stale.status, 401);
  assert.equal(stale.body.code, 'sso_reauth_required');
});

test('REST: a linked member with no attestation stamp at all is stale', async () => {
  attestedAgoMs = null;
  const res = await call('GET', '/api/auth/me', bearer(tokenIssuedAgo(60)));
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'sso_reauth_required');
});

test('auto-renew: past half-life a fresh member gets a header, a stale one gets nothing', async () => {
  const token = tokenIssuedAgo(4 * DAY_S);
  const fresh = await call('GET', '/api/auth/me', bearer(token));
  assert.equal(fresh.status, 200);
  assert.ok(fresh.refreshHeader, 'fresh member is auto-renewed');

  attestedAgoMs = STALE_EDGE;
  const stale = await call('GET', '/api/auth/me', bearer(tokenIssuedAgo(4 * DAY_S + 5)));
  assert.equal(stale.status, 401);
  assert.equal(stale.refreshHeader, null, 'stale member is never re-issued a token');
  assert.equal(stale.body.code, 'sso_reauth_required');
});

test('POST /refresh: fresh re-issues, stale is refused without a token', async () => {
  const fresh = await call('POST', '/api/auth/refresh', bearer(tokenIssuedAgo(60)));
  assert.equal(fresh.status, 200);
  assert.equal(typeof fresh.body.token, 'string');

  attestedAgoMs = STALE_EDGE;
  const stale = await call('POST', '/api/auth/refresh', bearer(tokenIssuedAgo(60)));
  assert.equal(stale.status, 401);
  assert.equal(stale.body.code, 'sso_reauth_required');
  assert.equal(stale.body.token, undefined);
});

test('grace refresh: a recently expired token renews only while the attestation is fresh', async () => {
  const expired = tokenIssuedAgo(7 * DAY_S + 3600);
  const fresh = await call('POST', '/api/auth/refresh', bearer(expired));
  assert.equal(fresh.status, 200);
  assert.equal(typeof fresh.body.token, 'string');

  attestedAgoMs = STALE_EDGE;
  const stale = await call('POST', '/api/auth/refresh', bearer(tokenIssuedAgo(7 * DAY_S + 3600)));
  assert.equal(stale.status, 401);
  assert.equal(stale.body.code, 'sso_reauth_required');
  assert.equal(stale.body.token, undefined);
});

test('device session: the active slot is refused once its attestation is stale', async () => {
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  const cookie = { cookie: '__Host-nassaj_device=device-secret' };
  assert.equal((await call('GET', '/api/auth/me', cookie)).status, 200);

  attestedAgoMs = STALE_EDGE;
  const stale = await call('GET', '/api/auth/me', cookie);
  assert.equal(stale.status, 401);
  assert.equal(stale.body.code, 'sso_reauth_required');
});

test('WebSocket: bearer and device verifiers refuse a stale member and admit a fresh one', () => {
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  const token = tokenIssuedAgo(60);
  assert.equal(authenticateWebSocket(token)?.id, row.id);
  assert.equal(authenticateDeviceWebSocket('device-secret')?.id, row.id);

  attestedAgoMs = STALE_EDGE;
  assert.equal(authenticateWebSocket(token), null);
  assert.equal(authenticateDeviceWebSocket('device-secret'), null);
});

test('forced password change: the rotation cookie is refused once the attestation is stale', async () => {
  const cookieToken = jwt.sign(
    { userId: row.id, purpose: 'password_change', pwd_iat: row.password_changed_at },
    JWT_SECRET,
    { expiresIn: 600 },
  );
  const headers = {
    cookie: `__Host-nassaj_password_change=${encodeURIComponent(cookieToken)}`,
    'content-type': 'application/json',
  };
  row.must_change_password = 1;
  try {
    attestedAgoMs = STALE_EDGE;
    const stale = await call('PATCH', '/api/auth/me/password', headers);
    assert.equal(stale.status, 401);
    assert.equal(stale.body.code, 'sso_reauth_required');

    attestedAgoMs = FRESH_EDGE;
    const fresh = await call('PATCH', '/api/auth/me/password', headers);
    assert.notEqual(fresh.body.code, 'sso_reauth_required', 'a fresh member passes authentication');
    assert.notEqual(fresh.status, 401);
  } finally {
    row.must_change_password = 0;
  }
});

test('owner is exempt: a stale or missing stamp never refuses the owner', async () => {
  row.role = 'owner';
  attestedAgoMs = null;
  const token = tokenIssuedAgo(4 * DAY_S);
  const res = await call('GET', '/api/auth/me', bearer(token));
  assert.equal(res.status, 200);
  assert.ok(res.refreshHeader);
  assert.ok(authenticateWebSocket(token));
  assert.equal(summaryReads, 0, 'owner never reads the attestation');
});

test('non-linked accounts are exempt', async () => {
  linkCount = 0;
  attestedAgoMs = null;
  assert.equal((await call('GET', '/api/auth/me', bearer(tokenIssuedAgo(60)))).status, 200);
});

test('OIDC disabled: behaviour is unchanged and the attestation is never read', async () => {
  process.env.OIDC_ENABLED = 'false';
  attestedAgoMs = null;
  const token = tokenIssuedAgo(4 * DAY_S);
  const res = await call('GET', '/api/auth/me', bearer(token));
  assert.equal(res.status, 200);
  assert.ok(res.refreshHeader);
  assert.equal((await call('POST', '/api/auth/refresh', bearer(tokenIssuedAgo(60)))).status, 200);
  assert.ok(authenticateWebSocket(token));
  assert.equal(summaryReads, 0);
});
