/**
 * B-142 — constant-time login. The unknown-user branch of POST /login must run a
 * real password verification against a fixed decoy hash so it costs the same as
 * the bad-password branch and cannot be used to enumerate usernames by response
 * timing.
 *
 * Wall-clock timing is not reliably assertable in a unit test, so we prove the
 * STRUCTURAL property that guarantees it: verifyPassword is invoked on BOTH the
 * unknown-user branch (against DECOY_PASSWORD_HASH) and the bad-password branch
 * (against the user's own hash), and both return the identical generic 401.
 *
 * Framework: node:test module mocking (--experimental-test-module-mocks),
 * as used elsewhere in the server suite — here via the current `options.exports`
 * form (`namedExports`/`defaultExport` are deprecated on Node 24 and warn).
 * The real auth router is mounted on a
 * throwaway express app; every side-effecting dependency (DB, auth middleware,
 * rate limiter, password service, invite service, sub-routers) is mocked so
 * importing the router never opens the real SQLite store.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

// --- controllable test state -------------------------------------------------

// verifyPassword spy: records (hash, password) per call, returns `verifyResult`.
const verifyCalls: Array<{ hash: unknown; password: unknown }> = [];
let verifyResult = false;

// The row getUserByUsername returns for the current test (null → unknown user).
let userRow: Record<string, unknown> | null = null;

const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();

const url = (spec: string) =>
  pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

class MockInviteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Register mocks BEFORE importing the router (node:test mocks are not hoisted).
mock.module(url('../modules/database/index.js'), {
  exports: {
    userDb: { getUserByUsername: () => userRow, updateLastLogin: () => {} },
    auditLogDb: { record: () => {} },
    invitesDb: {},
  },
});
// The mock must cover the WHOLE import surface routes/auth.js pulls from this
// module (auth.js:10-17). A mocked module that omits even one name makes the
// import itself a SyntaxError, so this list is kept in step with that import.
// None of these three touch the /login path (graceRefresh is mounted on
// /refresh only, auth.js:286), so they are inert with respect to the timing
// assertions below; they exist so the router can be imported at all.
mock.module(url('../middleware/auth.js'), {
  exports: {
    generateToken: () => 'test-jwt',
    authenticateToken: passThrough,
    requireRole: () => passThrough,
    invalidateRefreshCache: () => {},
    // Fail-closed stub: `ok:false` makes graceRefresh hand the request straight
    // to the normal path (auth.js:254), i.e. it never short-circuits anything.
    verifyTokenAllowingRecentExpiry: () => ({ ok: false, reason: 'invalid' }),
    // The production default (AUTH_REFRESH_GRACE_HOURS unset → 24h,
    // middleware/auth.js:228,240-242), so the grace branch is "on" as in prod.
    REFRESH_GRACE_MS: 24 * 60 * 60 * 1000,
  },
});
mock.module(url('../middleware/rate-limit.js'), {
  exports: { createRateLimiter: () => passThrough },
});
mock.module(url('../services/password.service.js'), {
  exports: {
    verifyPassword: async (hash: unknown, password: unknown) => {
      verifyCalls.push({ hash, password });
      return verifyResult;
    },
    needsRehash: () => false,
    hashPassword: async () => '$argon2id$stub',
  },
});
mock.module(url('../services/invite.service.js'), {
  exports: {
    createInvite: async () => ({}),
    acceptInvite: async () => ({}),
    InviteError: MockInviteError,
  },
});
mock.module(url('../utils/client-ip.js'), {
  exports: { clientIp: () => '127.0.0.1' },
});
mock.module(url('./webauthn.js'), { exports: { default: express.Router() } });
mock.module(url('./oidc.js'), { exports: { default: express.Router() } });

// Import the router + the decoy constant AFTER the mocks are registered.
const { default: authRouter, DECOY_PASSWORD_HASH } = await import('./auth.js');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function login(username: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

test('B-142 attack: unknown user still runs verifyPassword against the decoy hash', async () => {
  verifyCalls.length = 0;
  userRow = null; // getUserByUsername → null → unknown-user branch
  verifyResult = false;

  const res = await login('ghost-user', 'attempted-password');

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'Invalid username or password' });
  // Decisive: the no-user branch performed a real verification...
  assert.equal(verifyCalls.length, 1);
  // ...against the fixed decoy hash, with the submitted password.
  assert.equal(verifyCalls[0].hash, DECOY_PASSWORD_HASH);
  assert.equal(verifyCalls[0].password, 'attempted-password');
  assert.ok(String(DECOY_PASSWORD_HASH).startsWith('$argon2id$'));
});

test('B-142 parity: bad password returns the identical 401 and also runs verify', async () => {
  verifyCalls.length = 0;
  userRow = { id: 7, username: 'real', role: 'user', password_hash: '$argon2id$real' };
  verifyResult = false; // wrong password

  const res = await login('real', 'wrong-password');

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'Invalid username or password' });
  assert.equal(verifyCalls.length, 1);
  assert.equal(verifyCalls[0].hash, '$argon2id$real'); // verified the real user's hash
});

test('B-142 happy path preserved: valid credentials return a token (200)', async () => {
  verifyCalls.length = 0;
  userRow = { id: 7, username: 'real', role: 'user', password_hash: '$argon2id$real' };
  verifyResult = true;

  const res = await login('real', 'correct-password');

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    success?: boolean;
    token?: string;
    user?: { username?: string };
  };
  assert.equal(body.success, true);
  assert.equal(body.token, 'test-jwt');
  assert.equal(body.user?.username, 'real');
});
