/**
 * trusted-origin — ADR-163 amendment 1 (D1/A1): one env-derived allowlist, a
 * fail-closed MULTI_ACCOUNT_SWITCHING predicate, and the forced password-change
 * cookie guard (C2) that works behind the tunnel with the flag off.
 * Covers T1, T1b, T2, T3, T4, T4b, T4c, T4d, T5 (guard parity), T5b, T5c, and
 * ADR-194 A3: on by default, `false` turns it off, SSO (any state but 'off')
 * turns it off per call.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createSsoConfigDouble } from '../services/__tests__/sso-config-double.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
// SSO off unless a test says otherwise; the real state model has its own tests.
const sso = createSsoConfigDouble({ enforced: false, loginAvailable: false });
mock.module(url('../services/sso-config.service.js'), { namedExports: sso.exports });

const { enforceCookieMutationGuard, mintMutationCsrfToken } = await import('../modules/account-wallet/request-csrf.js');
const {
  buildTrustedOriginPolicy, isTrustedOrigin, multiAccountSwitchingEnabled, walletOriginConfigured,
} = await import('./trusted-origin.js');

const PUBLIC = 'https://nassaj.example';
const KEYS = ['APP_ORIGINS', 'APP_ORIGIN', 'NASSAJ_PUBLIC_ORIGIN', 'SERVER_PORT', 'ALLOWED_ORIGINS',
  'MULTI_ACCOUNT_SWITCHING'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  sso.setActive(false);
  sso.state.legacy = false;
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** Replaces every policy variable with exactly `values`. */
function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

const codes = (env: Record<string, string>) =>
  buildTrustedOriginPolicy(env, false).warnings.map((warning) => warning.code);
const request = (headers: Record<string, string>) => ({ headers });

test('T1: flag on without any explicit origin keeps the wallet off and warns', () => {
  setEnv({ MULTI_ACCOUNT_SWITCHING: 'true' });
  assert.equal(multiAccountSwitchingEnabled(), false);
  assert.equal(walletOriginConfigured(), false);
  assert.deepEqual(codes({ MULTI_ACCOUNT_SWITCHING: 'true' }),
    ['trusted_origins_unconfigured', 'multi_account_switching_disabled']);
  assert.equal(isTrustedOrigin(request({ origin: 'http://localhost:3001' })), true);
});

test('T1b: NASSAJ_PUBLIC_ORIGIN alone, listed in CORS, enables the wallet behind a proxy', () => {
  setEnv({ MULTI_ACCOUNT_SWITCHING: 'true', NASSAJ_PUBLIC_ORIGIN: PUBLIC, ALLOWED_ORIGINS: PUBLIC });
  assert.equal(multiAccountSwitchingEnabled(), true);
  // The tunnel delivers plain http with a loopback Host; neither is consulted.
  assert.equal(isTrustedOrigin(request({ origin: PUBLIC, host: '127.0.0.1:3004' })), true);
});

test('T2: an explicit origin missing from ALLOWED_ORIGINS disables the wallet', () => {
  const env = { MULTI_ACCOUNT_SWITCHING: 'true', APP_ORIGINS: `${PUBLIC},https://tail.example`,
    ALLOWED_ORIGINS: PUBLIC };
  assert.ok(codes(env).includes('trusted_origin_not_in_cors'));
  assert.equal(buildTrustedOriginPolicy(env, false).multiAccountSwitching, false);
  setEnv(env);
  assert.equal(multiAccountSwitchingEnabled(), false);
  assert.equal(buildTrustedOriginPolicy({ ...env, ALLOWED_ORIGINS: `https://tail.example, ${PUBLIC}` }, false)
    .multiAccountSwitching, true);
});

test('platform mode never enables the wallet; only an explicit "false" turns the flag off', () => {
  const env = { MULTI_ACCOUNT_SWITCHING: 'true', NASSAJ_PUBLIC_ORIGIN: PUBLIC, ALLOWED_ORIGINS: PUBLIC };
  assert.equal(buildTrustedOriginPolicy(env, true).multiAccountSwitching, false);
  assert.equal(buildTrustedOriginPolicy(env, true).offReason, 'platform');
  assert.equal(buildTrustedOriginPolicy({ ...env, MULTI_ACCOUNT_SWITCHING: 'false' }, false).multiAccountSwitching,
    false);
  assert.equal(buildTrustedOriginPolicy({ ...env, MULTI_ACCOUNT_SWITCHING: 'false' }, false).offReason, 'flag');
  assert.equal(buildTrustedOriginPolicy({ ...env, MULTI_ACCOUNT_SWITCHING: '1' }, false).multiAccountSwitching, true);
});

test('ADR-194 A3: unset flag enables the wallet when the origin preconditions hold', () => {
  setEnv({ NASSAJ_PUBLIC_ORIGIN: PUBLIC, ALLOWED_ORIGINS: PUBLIC });
  assert.equal(multiAccountSwitchingEnabled(), true);
  assert.equal(buildTrustedOriginPolicy({ NASSAJ_PUBLIC_ORIGIN: PUBLIC, ALLOWED_ORIGINS: PUBLIC }, false).offReason,
    null);
  setEnv({ NASSAJ_PUBLIC_ORIGIN: PUBLIC, ALLOWED_ORIGINS: PUBLIC, MULTI_ACCOUNT_SWITCHING: 'false' });
  assert.equal(multiAccountSwitchingEnabled(), false);
});

test('ADR-194 A3: unset flag stays off without origin, with a CORS gap, and in platform mode — no warning', () => {
  const noOrigin = buildTrustedOriginPolicy({}, false);
  assert.equal(noOrigin.multiAccountSwitching, false);
  assert.equal(noOrigin.offReason, 'origin');
  assert.ok(!noOrigin.warnings.some((warning) => warning.code === 'multi_account_switching_disabled'));
  const corsGap = buildTrustedOriginPolicy({ NASSAJ_PUBLIC_ORIGIN: PUBLIC }, false);
  assert.equal(corsGap.offReason, 'cors');
  assert.ok(!corsGap.warnings.some((warning) => warning.code === 'multi_account_switching_disabled'));
  const platform = buildTrustedOriginPolicy({ NASSAJ_PUBLIC_ORIGIN: PUBLIC, ALLOWED_ORIGINS: PUBLIC }, true);
  assert.equal(platform.offReason, 'platform');
  assert.equal(platform.multiAccountSwitching, false);
});

test('ADR-194 A3: any SSO state except off disables the wallet per call, without touching the env cache', () => {
  setEnv({ NASSAJ_PUBLIC_ORIGIN: PUBLIC, ALLOWED_ORIGINS: PUBLIC });
  assert.equal(multiAccountSwitchingEnabled(), true);
  sso.setActive(true); // 'active'
  assert.equal(multiAccountSwitchingEnabled(), false);
  sso.state.loginAvailable = false; // 'unavailable' (IdP outage): still off, no mode flip
  assert.equal(multiAccountSwitchingEnabled(), false);
  sso.state.legacy = true; // 'paused'
  assert.equal(multiAccountSwitchingEnabled(), false);
  sso.setActive(false);
  sso.state.legacy = false; // 'off'
  assert.equal(multiAccountSwitchingEnabled(), true);
});

test('T3: a trailing slash or host case in Origin is normalized; http for the public host is not', () => {
  setEnv({ NASSAJ_PUBLIC_ORIGIN: PUBLIC });
  assert.equal(isTrustedOrigin(request({ origin: `${PUBLIC}/` })), true);
  assert.equal(isTrustedOrigin(request({ origin: 'https://NASSAJ.example' })), true);
  assert.equal(isTrustedOrigin(request({ origin: 'http://nassaj.example' })), false);
});

test('T4/T4b: forwarded headers and Host never make a foreign Origin trusted', () => {
  setEnv({ NASSAJ_PUBLIC_ORIGIN: PUBLIC, SERVER_PORT: '3004' });
  assert.equal(isTrustedOrigin(request({ origin: 'https://evil.example', host: 'evil.example',
    'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' })), false);
  assert.equal(isTrustedOrigin(request({ origin: 'http://nassaj.example', 'x-forwarded-proto': 'https' })), false);
  assert.equal(isTrustedOrigin(request({ origin: 'http://evil:3004', host: '127.0.0.1:3004' })), false);
  for (const origin of ['', 'null', 'not a url', 'https://user:pw@nassaj.example']) {
    assert.equal(isTrustedOrigin(request({ origin })), false, origin);
  }
  assert.equal(isTrustedOrigin(request({})), false);
});

test('T4c: only the listening port is an implicit loopback origin', () => {
  setEnv({});
  assert.equal(isTrustedOrigin(request({ origin: 'http://localhost:3001' })), true);
  assert.equal(isTrustedOrigin(request({ origin: 'http://127.0.0.1:3001' })), true);
  assert.equal(isTrustedOrigin(request({ origin: 'http://localhost:3004' })), false);
  assert.equal(isTrustedOrigin(request({ origin: 'http://localhost:5173' })), false);
  setEnv({ SERVER_PORT: '3004' });
  assert.equal(isTrustedOrigin(request({ origin: 'http://localhost:3004' })), true);
  assert.equal(isTrustedOrigin(request({ origin: 'http://localhost:3001' })), false);
});

test('T4d: an invalid explicit origin is dropped with a warning and nothing is derived', () => {
  for (const raw of ['http://nassaj.example', 'https://nassaj.example/app', 'https://nassaj.example/',
    'https://NASSAJ.example', ' https://nassaj.example', 'nassaj.example']) {
    const env = { MULTI_ACCOUNT_SWITCHING: 'true', NASSAJ_PUBLIC_ORIGIN: raw, ALLOWED_ORIGINS: raw };
    const policy = buildTrustedOriginPolicy(env, false);
    assert.deepEqual(policy.warnings[0], { code: 'trusted_origin_invalid', source: 'NASSAJ_PUBLIC_ORIGIN' }, raw);
    assert.equal(policy.multiAccountSwitching, false, raw);
    assert.equal(policy.walletOriginConfigured, false, raw);
    assert.equal(policy.origins.has(PUBLIC), false, raw);
  }
  const mixed = buildTrustedOriginPolicy({ APP_ORIGINS: `bogus, ${PUBLIC}`, ALLOWED_ORIGINS: PUBLIC,
    MULTI_ACCOUNT_SWITCHING: 'true' }, false);
  assert.deepEqual(mixed.warnings, [{ code: 'trusted_origin_invalid', source: 'APP_ORIGINS' }]);
  assert.equal(mixed.multiAccountSwitching, true);
});

const SECRET = 'x'.repeat(48);
const PATH = '/api/auth/me/password';

/** A forced password-change request as authenticatePasswordChange leaves it. */
function passwordChangeRequest(origin: string) {
  const user = { id: 7, password_changed_at: 1_700_000_000_000 };
  const binding = `password-change:${user.id}:${user.password_changed_at}`;
  const token = mintMutationCsrfToken(SECRET, binding, 'POST', PATH)!.csrfToken;
  const headers: Record<string, string> = { origin, host: '127.0.0.1:3004', 'x-csrf-token': token };
  return { method: 'POST', originalUrl: PATH, protocol: 'http', headers, user, passwordChangeSession: true,
    get: (name: string) => headers[name.toLowerCase()] };
}

/** Runs the cookie guard and returns the response status (200 when it passes). */
function guardStatus(origin: string): number {
  let status = 200;
  const res = { status(code: number) { status = code; return res; }, json() { return res; } };
  enforceCookieMutationGuard(passwordChangeRequest(origin), res, SECRET);
  return status;
}

test('T5b: forced password change works behind the tunnel with the flag off', () => {
  setEnv({ NASSAJ_PUBLIC_ORIGIN: PUBLIC, SERVER_PORT: '3004' });
  assert.equal(multiAccountSwitchingEnabled(), false);
  assert.equal(guardStatus(PUBLIC), 200);
  assert.equal(guardStatus('https://evil.example'), 403);
});

test('T5c: without an explicit origin only the local listening port passes the guard', () => {
  setEnv({ SERVER_PORT: '3004' });
  assert.equal(guardStatus(PUBLIC), 403);
  assert.equal(guardStatus('http://localhost:3004'), 200);
  assert.equal(guardStatus('http://localhost:3001'), 403);
});

test('T5: the cookie guard and the shared predicate agree on every origin', () => {
  setEnv({ NASSAJ_PUBLIC_ORIGIN: PUBLIC, SERVER_PORT: '3004' });
  for (const origin of [PUBLIC, `${PUBLIC}/`, 'http://nassaj.example', 'http://localhost:3004',
    'http://localhost:3001', 'https://evil.example', 'null', '']) {
    assert.equal(guardStatus(origin) === 200, isTrustedOrigin(request({ origin })), origin);
  }
});
