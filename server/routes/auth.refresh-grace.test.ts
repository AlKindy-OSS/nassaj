/**
 * Route-level coverage for two auth fixes in server/routes/auth.js, exercised
 * against the REAL middleware (server/middleware/auth.js is NOT mocked here, so
 * the production JWT verification, pwd_iat gate, auto-refresh header and
 * refresh-coalescing cache all run):
 *
 *  - B-165: PATCH /me/password must not answer with an `X-Refreshed-Token`.
 *    authenticateToken attaches that header whenever the request token is past
 *    half-life, and it is minted with the OLD pwd_iat — dead the instant this
 *    handler advances password_changed_at. The client adopts refresh headers
 *    unconditionally, so shipping it makes the browser throw away the working
 *    token it just received in the body and bounce (401 + WebSocket redial).
 *
 *  - B-154: POST /refresh accepts a token that expired RECENTLY (strict window,
 *    default 24h) so a user who was offline longer than the 7-day TTL is not
 *    force-logged-out — while every other gate still applies (unknown/inactive
 *    account, stale pwd_iat, forced rotation), the window is hard-capped, and
 *    the path is separately rate-limited.
 *
 * Framework: node:test module mocking (--experimental-test-module-mocks), same
 * shape as auth.login-timing.test.ts: the real router on a throwaway express
 * app with the database, password service, invite service and the two
 * sub-routers mocked, so no SQLite store, argon2 work or WebAuthn/OIDC stack is
 * touched.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import jwt from 'jsonwebtoken';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

const FIXED_SECRET = 'refresh-grace-test-secret-0123456789ab';

delete process.env.JWT_SECRET;
delete process.env.AUTH_REFRESH_GRACE_HOURS;

const DAY_S = 24 * 60 * 60;

// --- mutable test state ------------------------------------------------------

type Row = {
  id: number;
  username: string;
  role: string;
  status: string;
  avatar_url: string | null;
  password_hash: string;
  password_changed_at: number | null;
  must_change_password: number;
};

const T0 = Date.now() - 10 * DAY_S * 1000;

let row: Row = {
  id: 7,
  username: 'grace',
  role: 'user',
  status: 'active',
  avatar_url: null,
  password_hash: '$argon2id$stub',
  password_changed_at: T0,
  must_change_password: 0,
};

// null → getUserById resolves nothing (deleted / disabled account).
let userResolvable = true;

const auditCalls: Array<{ event: string; payload: Record<string, unknown> }> = [];

class MockInviteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: {
      getUserById: () => (userResolvable ? row : undefined),
      getRawById: () => row,
      getUserByUsername: () => undefined,
      updateLastLogin: () => {},
      changePassword: (_id: number, hash: string, changedAt: number) => {
        row = {
          ...row,
          password_hash: hash,
          password_changed_at: changedAt,
          must_change_password: 0,
        };
      },
    },
    appConfigDb: { getOrCreateJwtSecret: () => FIXED_SECRET },
    auditLogDb: {
      record: (event: string, payload: Record<string, unknown>) => {
        auditCalls.push({ event, payload });
      },
    },
    invitesDb: {},
  },
});
mock.module(url('../services/password.service.js'), {
  namedExports: {
    verifyPassword: async () => true,
    needsRehash: () => false,
    hashPassword: async () => '$argon2id$rotated',
  },
});
mock.module(url('../services/invite.service.js'), {
  namedExports: {
    createInvite: async () => ({}),
    acceptInvite: async () => ({}),
    InviteError: MockInviteError,
  },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '203.0.113.7' } });
mock.module(url('./webauthn.js'), { defaultExport: express.Router() });
mock.module(url('./oidc.js'), { defaultExport: express.Router() });

const { default: authRouter } = await import('./auth.js');
const { JWT_SECRET } = await import('../middleware/auth.js');

assert.equal(JWT_SECRET, FIXED_SECRET);

// --- harness -----------------------------------------------------------------

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const { port } = server.address() as AddressInfo;

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, urlPath: string, token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    refreshHeader: res.headers.get('x-refreshed-token'),
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/** Token signed `issuedAgoSeconds` in the past with the production 7d TTL. */
function tokenIssuedAgo(issuedAgoSeconds: number, pwdIat = row.password_changed_at ?? 0) {
  const iat = Math.floor(Date.now() / 1000) - issuedAgoSeconds;
  return jwt.sign(
    { userId: row.id, username: row.username, role: row.role, pwd_iat: pwdIat, iat },
    JWT_SECRET,
    { expiresIn: 7 * DAY_S }
  );
}

const decode = (token: string) =>
  jwt.verify(token, JWT_SECRET) as { pwd_iat: number; exp: number };

// ---------------------------------------------------------------------------
// B-165
// ---------------------------------------------------------------------------

test('B-165: PATCH /me/password answers WITHOUT a stale X-Refreshed-Token', async () => {
  // Past half-life → authenticateToken attaches the auto-refresh header, minted
  // with the pre-change pwd_iat.
  const token = tokenIssuedAgo(4 * DAY_S);

  const res = await call('PATCH', '/api/auth/me/password', token, {
    currentPassword: 'old-password',
    newPassword: 'brand-new-password',
  });

  assert.equal(res.status, 200);
  assert.equal(
    res.refreshHeader,
    null,
    'the refresh header carries the OLD pwd_iat and is dead on arrival — it must be stripped'
  );

  // The body token is the live one and carries the NEW stamp.
  const issued = res.body.token as string;
  assert.ok(issued);
  assert.equal(decode(issued).pwd_iat, row.password_changed_at);
});

test('B-165: a later refresh mints against the NEW stamp (coalescing cache purged)', async () => {
  // Same user, still inside the 10s coalescing window: without the purge the
  // cache would hand back the pre-change token minted in the test above.
  const token = tokenIssuedAgo(4 * DAY_S, row.password_changed_at ?? 0);
  const res = await call('GET', '/api/auth/me', token);
  assert.equal(res.status, 200);
  if (res.refreshHeader) {
    assert.equal(decode(res.refreshHeader).pwd_iat, row.password_changed_at);
  }
});

// ---------------------------------------------------------------------------
// B-154
// ---------------------------------------------------------------------------

test('B-154: a token expired 1h ago is renewed by POST /refresh', async () => {
  const expired = tokenIssuedAgo(7 * DAY_S + 3600);
  const res = await call('POST', '/api/auth/refresh', expired);

  assert.equal(res.status, 200, 'a just-expired token must be renewable, not a forced logout');
  const renewed = res.body.token as string;
  assert.ok(renewed);
  // The renewed token is genuinely valid (verify enforces exp).
  assert.ok(decode(renewed).exp * 1000 > Date.now());
  assert.ok(
    auditCalls.some((c) => c.event === 'token_refresh' && (c.payload.metadata as { via?: string })?.via === 'grace'),
    'the grace renewal must be audited distinctly'
  );
});

test('B-154: a token expired beyond the window is refused (401)', async () => {
  const longDead = tokenIssuedAgo(7 * DAY_S + 48 * 3600);
  const res = await call('POST', '/api/auth/refresh', longDead);
  assert.equal(res.status, 401);
  assert.equal(res.body.token, undefined);
});

test('B-154: the grace path still honours the pwd_iat gate', async () => {
  // Token minted before the last password change → must never be renewable.
  const stale = tokenIssuedAgo(7 * DAY_S + 3600, (row.password_changed_at ?? 0) - 60_000);
  const res = await call('POST', '/api/auth/refresh', stale);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Token invalidated');
});

test('B-154: the grace path still honours forced password rotation (403)', async () => {
  row = { ...row, must_change_password: 1 };
  try {
    const expired = tokenIssuedAgo(7 * DAY_S + 3600);
    const res = await call('POST', '/api/auth/refresh', expired);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'password_change_required');
  } finally {
    row = { ...row, must_change_password: 0 };
  }
});

test('B-154: the grace path refuses a deleted/disabled account', async () => {
  userResolvable = false;
  try {
    const expired = tokenIssuedAgo(7 * DAY_S + 3600);
    const res = await call('POST', '/api/auth/refresh', expired);
    assert.equal(res.status, 401);
  } finally {
    userResolvable = true;
  }
});

test('B-154: a forged expired token is refused (signature still enforced)', async () => {
  const iat = Math.floor(Date.now() / 1000) - (7 * DAY_S + 3600);
  const forged = jwt.sign(
    { userId: row.id, username: row.username, role: 'owner', pwd_iat: 0, iat },
    'attacker-secret-0123456789abcdefgh',
    { expiresIn: 7 * DAY_S }
  );
  const res = await call('POST', '/api/auth/refresh', forged);
  assert.equal(res.status, 401);
});

test('B-154: a still-valid token keeps using the normal refresh path', async () => {
  const fresh = tokenIssuedAgo(60);
  const res = await call('POST', '/api/auth/refresh', fresh);
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.ok(
    auditCalls.some(
      (c) => c.event === 'token_refresh' && (c.payload.metadata as { via?: string })?.via === 'endpoint'
    )
  );
});

// Runs LAST: the per-IP bucket is shared across this file, so exhausting it
// earlier would poison the tests above.
test('B-154: the grace path is rate-limited (429 once the quota is spent)', async () => {
  let saw429 = false;
  for (let attempt = 0; attempt < 12 && !saw429; attempt += 1) {
    const expired = tokenIssuedAgo(7 * DAY_S + 3600);
    const res = await call('POST', '/api/auth/refresh', expired);
    saw429 = res.status === 429;
  }
  assert.equal(saw429, true, 'repeated grace renewals from one IP must be throttled');
});
