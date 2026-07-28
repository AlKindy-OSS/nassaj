/**
 * Unit coverage for three auth-token lifecycle fixes that live in
 * server/middleware/auth.js:
 *
 *  - B-164: generateToken's missing-stamp fallback. It used to be
 *    `user.password_changed_at || Date.now()`, a MILLISECOND clock read, so two
 *    mints of the same identity in the same second produced different tokens
 *    (the amplifier behind the B-163 refresh storm) AND the token looked
 *    "current" regardless of the row's real password history. It is now a
 *    deterministic 0.
 *  - B-165: invalidateRefreshCache drops the coalesced token so a password
 *    change cannot hand the client back a token minted with the old pwd_iat.
 *  - B-154: verifyTokenAllowingRecentExpiry + the grace-window resolver
 *    (default, invalid input, and the hard cap).
 *
 * Framework: node:test module mocking (--experimental-test-module-mocks); the
 * database module is mocked so importing auth.js opens no SQLite store.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import jwt from 'jsonwebtoken';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

const FIXED_SECRET = 'lifecycle-test-secret-0123456789abcdef';

delete process.env.JWT_SECRET;
delete process.env.AUTH_REFRESH_GRACE_HOURS;

const auditCalls: Array<{ event: string; payload: Record<string, unknown> }> = [];

// The user authenticateToken resolves; password_changed_at is mutable per test.
const user = {
  id: 42,
  username: 'lifecycle',
  role: 'user',
  password_changed_at: null as number | null,
};

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: { getUserById: () => user },
    appConfigDb: { getOrCreateJwtSecret: () => FIXED_SECRET },
    auditLogDb: {
      record: (event: string, payload: Record<string, unknown>) => {
        auditCalls.push({ event, payload });
      },
    },
  },
});

const {
  generateToken,
  invalidateRefreshCache,
  verifyTokenAllowingRecentExpiry,
  resolveRefreshGraceMs,
  authenticateToken,
  REFRESH_GRACE_MAX_HOURS,
  JWT_SECRET,
} = await import('./auth.js');

const decode = (token: string) => jwt.verify(token, JWT_SECRET) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// B-164 — deterministic pwd_iat
// ---------------------------------------------------------------------------

test('B-164: a user object without password_changed_at mints pwd_iat=0, not a ms clock read', () => {
  const token = generateToken({ id: 1, username: 'a', role: 'user' });
  assert.equal(decode(token).pwd_iat, 0);
});

test('B-164: two mints of the same stamp-less identity are byte-identical (storm amplifier gone)', async () => {
  const first = generateToken({ id: 1, username: 'a', role: 'user' });
  // Cross a millisecond boundary: the old `|| Date.now()` fallback made these
  // differ every time, so every parallel refresh produced a distinct token.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = generateToken({ id: 1, username: 'a', role: 'user' });
  assert.equal(first, second);
});

test('B-164: an explicit password_changed_at is carried through unchanged', () => {
  const token = generateToken({ id: 1, username: 'a', role: 'user', password_changed_at: 1234 });
  assert.equal(decode(token).pwd_iat, 1234);
});

test('B-164: a 0-stamped token is invalidated once the row gains a stamp', () => {
  const token = generateToken({ id: 42, username: 'lifecycle', role: 'user' });
  const decoded = decode(token) as { pwd_iat: number };
  // This is the check authenticateToken performs (auth.js).
  const rowStamp = Date.now();
  assert.equal(decoded.pwd_iat < rowStamp, true);
});

// ---------------------------------------------------------------------------
// B-165 — refresh-cache invalidation
// ---------------------------------------------------------------------------

/** Signs a token issued 4 days ago with the real 7d TTL → past half-life. */
function pastHalfLifeToken(userId: number, pwdIat = 0): string {
  const iat = Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60;
  return jwt.sign(
    { userId, username: 'lifecycle', role: 'user', pwd_iat: pwdIat, iat },
    JWT_SECRET,
    { expiresIn: 7 * 24 * 60 * 60 }
  );
}

/** Runs authenticateToken over a stub req/res and returns the refresh header. */
async function refreshHeaderFor(token: string): Promise<string | undefined> {
  const headers: Record<string, string> = {};
  const req = { headers: { authorization: `Bearer ${token}` }, query: {}, socket: {} };
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status: () => ({ json: () => {} }),
  };
  await authenticateToken(req as never, res as never, () => {});
  return headers['X-Refreshed-Token'];
}

test('B-165: the coalescing cache repeats one token until it is invalidated', async () => {
  user.password_changed_at = null;
  const first = await refreshHeaderFor(pastHalfLifeToken(42));
  const second = await refreshHeaderFor(pastHalfLifeToken(42));
  assert.ok(first);
  assert.equal(second, first, 'within the window the cached token is reused (B-163)');

  invalidateRefreshCache(42);

  // After a password change the cached token would be dead; invalidation must
  // force a fresh mint against the new stamp.
  user.password_changed_at = Date.now() + 60_000;
  const third = await refreshHeaderFor(pastHalfLifeToken(42, user.password_changed_at));
  assert.ok(third);
  assert.notEqual(third, first, 'invalidateRefreshCache must force a fresh mint');
  assert.equal((decode(third) as { pwd_iat: number }).pwd_iat, user.password_changed_at);
  user.password_changed_at = null;
});

// ---------------------------------------------------------------------------
// B-154 — grace window
// ---------------------------------------------------------------------------

test('B-154: grace window defaults to 24h and honours a valid override', () => {
  assert.equal(resolveRefreshGraceMs(undefined), 24 * 60 * 60 * 1000);
  assert.equal(resolveRefreshGraceMs(''), 24 * 60 * 60 * 1000);
  assert.equal(resolveRefreshGraceMs('6'), 6 * 60 * 60 * 1000);
  assert.equal(resolveRefreshGraceMs('0'), 0, '0 disables the grace path entirely');
});

test('B-154: an oversized window is CLAMPED to the hard cap, never honoured', () => {
  assert.equal(resolveRefreshGraceMs('720'), REFRESH_GRACE_MAX_HOURS * 60 * 60 * 1000);
  assert.equal(resolveRefreshGraceMs('99999'), REFRESH_GRACE_MAX_HOURS * 60 * 60 * 1000);
});

test('B-154: an invalid or negative window falls back to the default', () => {
  assert.equal(resolveRefreshGraceMs('abc'), 24 * 60 * 60 * 1000);
  assert.equal(resolveRefreshGraceMs('-5'), 24 * 60 * 60 * 1000);
});

test('B-154: a still-valid token is reported as not expired', () => {
  const token = jwt.sign({ userId: 42 }, JWT_SECRET, { expiresIn: '1h' });
  const result = verifyTokenAllowingRecentExpiry(token);
  assert.equal(result.ok, true);
  assert.equal(result.expired, false);
});

test('B-154: a token expired INSIDE the window is renewable', () => {
  const token = jwt.sign({ userId: 42 }, JWT_SECRET, { expiresIn: -3600 });
  const result = verifyTokenAllowingRecentExpiry(token);
  assert.equal(result.ok, true);
  assert.equal(result.expired, true);
  assert.ok(result.expiredForMs >= 3_600_000 - 5_000);
});

test('B-154: a token expired BEYOND the window is refused', () => {
  const token = jwt.sign({ userId: 42 }, JWT_SECRET, { expiresIn: -(48 * 3600) });
  const result = verifyTokenAllowingRecentExpiry(token, { graceMs: 24 * 60 * 60 * 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired_beyond_grace');
});

test('B-154: signature/algorithm are still enforced on the grace path', () => {
  const forged = jwt.sign({ userId: 42 }, 'attacker-secret-0123456789abcdef', {
    expiresIn: -60,
  });
  assert.equal(verifyTokenAllowingRecentExpiry(forged).ok, false);

  const alg = jwt.sign({ userId: 42 }, '', { algorithm: 'none', noTimestamp: true } as never);
  assert.equal(verifyTokenAllowingRecentExpiry(alg).ok, false);
});

test('B-154: a token with no exp is refused (fail-closed, never renewable)', () => {
  const token = jwt.sign({ userId: 42 }, JWT_SECRET, { noTimestamp: true });
  const result = verifyTokenAllowingRecentExpiry(token);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_exp');
});

test('B-154: a zero window makes even a one-second-old expiry unrenewable', () => {
  const token = jwt.sign({ userId: 42 }, JWT_SECRET, { expiresIn: -1 });
  const result = verifyTokenAllowingRecentExpiry(token, { graceMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired_beyond_grace');
});
