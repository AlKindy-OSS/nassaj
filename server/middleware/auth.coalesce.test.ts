/**
 * B-163 — refresh-token coalescing in authenticateToken.
 *
 * authenticateToken auto-refreshes any token past half-life by minting a fresh
 * JWT into the `X-Refreshed-Token` response header. A boot burst of ~16 parallel
 * requests would otherwise mint 16 DISTINCT tokens; the client adopts a
 * last-wins one and redials the WebSocket per token — a reconnect storm. The
 * in-process coalescing Map collapses a burst within REFRESH_COALESCE_WINDOW_MS
 * to ONE minted token (and ONE audit row), while a request past the window mints
 * afresh.
 *
 * Framework: node:test module mocking (--experimental-test-module-mocks),
 * mirroring auth.login-timing.test.ts. The database module is mocked so importing
 * auth.js never opens the real SQLite store; JWT_SECRET is resolved from the
 * mocked getOrCreateJwtSecret and re-used to sign the test tokens.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import jwt from 'jsonwebtoken';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

// Every auditLogDb.record(event, payload) call lands here (reset per test).
const auditCalls: Array<{ event: string; payload: unknown }> = [];

// Fixed ≥32-char secret returned by the mocked getOrCreateJwtSecret.
const FIXED_SECRET = 'coalesce-test-secret-0123456789abcdef';

// Force resolveJwtSecret down the app_config path so the mock's secret is used
// and the module never depends on an ambient JWT_SECRET.
delete process.env.JWT_SECRET;

// Register mocks BEFORE importing auth.js (node:test mocks are not hoisted).
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    // Active user for whatever id the token claims; password_changed_at null so
    // the pwd_iat staleness gate is skipped.
    userDb: {
      getUserById: (id: number) => ({
        id,
        username: 'coalesce-user',
        role: 'user',
        password_changed_at: null,
      }),
    },
    appConfigDb: { getOrCreateJwtSecret: () => FIXED_SECRET },
    auditLogDb: {
      record: (event: string, payload: unknown) => {
        auditCalls.push({ event, payload });
      },
    },
  },
});

// Import AFTER the mocks are registered.
const { authenticateToken, JWT_SECRET } = await import('./auth.js');

// Sanity: the middleware resolved the mocked secret (not an ambient one).
assert.equal(JWT_SECRET, FIXED_SECRET);

const SEVEN_DAYS = 7 * 24 * 60 * 60;
const FOUR_DAYS = 4 * 24 * 60 * 60;

/** Token whose iat is 4 days ago and exp is iat + 7 days → safely past half-life. */
function pastHalfLifeToken(userId: number): { token: string; exp: number } {
  const iat = Math.floor(Date.now() / 1000) - FOUR_DAYS;
  const exp = iat + SEVEN_DAYS;
  // Explicit iat/exp (no expiresIn option, which would conflict with exp).
  const token = jwt.sign(
    { userId, username: 'coalesce-user', role: 'user', pwd_iat: 0, iat, exp },
    JWT_SECRET
  );
  return { token, exp };
}

/**
 * Runs authenticateToken against a minimal req/res for `token`, returning the
 * value handed to res.setHeader('X-Refreshed-Token', …) (or undefined). Asserts
 * the request reached next() — i.e. it took the authenticated happy path.
 */
async function invoke(token: string): Promise<string | undefined> {
  const req = {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'coalesce-test' },
    query: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  let refreshed: string | undefined;
  const res = {
    setHeader: (name: string, value: string) => {
      if (name === 'X-Refreshed-Token') refreshed = value;
    },
    // Chainable no-ops; only hit on a rejection path, which would (correctly)
    // leave nextCalled false and fail the assertion below.
    status: () => res,
    json: () => res,
  };
  let nextCalled = false;
  await authenticateToken(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, 'authenticateToken should reach next() on the happy path');
  return refreshed;
}

test('B-163: a burst of 16 past-half-life requests coalesces to ONE minted token and ONE audit row', async () => {
  auditCalls.length = 0;
  const userId = 501;
  const { token, exp: oldExp } = pastHalfLifeToken(userId);

  const captured: Array<string | undefined> = [];
  for (let i = 0; i < 16; i++) {
    captured.push(await invoke(token));
  }

  // Every request past half-life received a refreshed token…
  assert.ok(
    captured.every((v) => typeof v === 'string'),
    'all 16 requests set X-Refreshed-Token'
  );
  // …but all 16 are the SAME token (coalesced within the window).
  const distinct = new Set(captured);
  assert.equal(distinct.size, 1, 'the 16 requests collapse to a single minted token');

  // Exactly one implicit-refresh audit row — only the minting request logs.
  const refreshRows = auditCalls.filter((c) => c.event === 'token_refresh');
  assert.equal(refreshRows.length, 1, 'only the minting request logs token_refresh');

  // The coalesced token verifies against the same secret and expires later than
  // the old one (a genuine, fresh 7-day token).
  const refreshedToken = [...distinct][0] as string;
  const decoded = jwt.verify(refreshedToken, JWT_SECRET) as Record<string, number>;
  assert.ok(decoded.exp > oldExp, 'refreshed token expires later than the old token');
});

test('B-163: a request past the coalesce window mints a second, distinct token and logs again', async (t) => {
  auditCalls.length = 0;
  // Distinct user id → its own cache key, isolated from the previous test.
  const userId = 777;
  const { token } = pastHalfLifeToken(userId);

  // Pin Date.now at the real current time, then advance it manually. Anchoring at
  // "now" keeps the half-life math (iat 4 days ago) triggering a refresh and
  // keeps jwt.verify seeing a live token; jwt.sign inside generateToken also
  // reads this mocked clock, so the two mints differ by their iat/pwd_iat.
  let fakeNow = Date.now();
  t.mock.method(Date, 'now', () => fakeNow);

  const first = await invoke(token);
  assert.equal(typeof first, 'string');

  // Jump comfortably past the coalesce window (currently 10s) → next request mints.
  fakeNow += 60_000;

  const second = await invoke(token);
  assert.equal(typeof second, 'string');

  assert.notEqual(first, second, 'a post-window request mints a distinct token');
  const refreshRows = auditCalls.filter((c) => c.event === 'token_refresh');
  assert.equal(refreshRows.length, 2, 'each mint logs exactly one token_refresh row');
});
