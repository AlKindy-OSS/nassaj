/**
 * ADR-194 A1.5 / A2: the pure owner SSO sign-in rule — the factor rules, the
 * amr shape, the 30-day entry cap, the fresh-touch tier and the order of the
 * checks.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  amrSatisfiesRule,
  decideOwnerSignIn,
  normalizedAmr,
  OWNER_SSO_ENTRY_MAX_AUTH_AGE_MS,
  OWNER_SSO_FACTOR_RULE,
  ownerAuthTimeFailure,
  ownerLoginHint,
  ownerSignInIsFreshTouch,
  requireFreshOwnerTouch,
} from './oidc-owner-sign-in.js';
import * as ownerSignInModule from './oidc-owner-sign-in.js';

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = NOW_MS / 1000;
const ACCOUNT = Object.freeze({ must_change_password: 0 });
const PASSKEY = Object.freeze({ amr: ['user', 'mfa'], auth_time: NOW_SEC });

const DAY_SEC = 24 * 3600;

test('A2: the active factor rule is passkey_only (ADR-H20 D6)', () => {
  assert.equal(OWNER_SSO_FACTOR_RULE, 'passkey_only');
  assert.equal(amrSatisfiesRule(['user', 'mfa']), true);
  assert.equal(amrSatisfiesRule(['pwd', 'user', 'mfa']), false, 'a password beside the key is refused by default');
});

test('A2: the 30-day owner entry cap is a code constant, not a setting', () => {
  assert.equal(OWNER_SSO_ENTRY_MAX_AUTH_AGE_MS, 30 * DAY_SEC * 1000);
  assert.throws(() => {
    (ownerSignInModule as Record<string, unknown>).OWNER_SSO_ENTRY_MAX_AUTH_AGE_MS = 1;
  }, TypeError, 'an ES module binding cannot be reassigned');
  assert.equal(Object.keys(ownerSignInModule).some((name) => /setting|configure|set[A-Z]/.test(name)), false,
    'no setter or setting for the cap');
});

test('webauthn_key (alternative): user + mfa passes, with or without a password beside it', () => {
  for (const amr of [['user', 'mfa'], ['mfa', 'user'], ['pwd', 'user', 'mfa'], ['user', 'mfa', 'user']]) {
    assert.equal(amrSatisfiesRule(amr, 'webauthn_key'), true, JSON.stringify(amr));
  }
});

test('webauthn_key: no WebAuthn factor fails (password, OTP, partial)', () => {
  for (const amr of [['pwd'], ['pwd', 'otp', 'mfa'], ['user'], ['mfa'], ['hwk', 'mfa'], ['otp', 'mfa'], []]) {
    assert.equal(amrSatisfiesRule(amr, 'webauthn_key'), false, JSON.stringify(amr));
  }
});

test('passkey_only: exactly { user, mfa }; any pwd or otp fails', () => {
  assert.equal(amrSatisfiesRule(['mfa', 'user'], 'passkey_only'), true);
  for (const amr of [['pwd', 'user', 'mfa'], ['user', 'mfa', 'otp'], ['hwk', 'mfa'], ['pwd'], ['user'], []]) {
    assert.equal(amrSatisfiesRule(amr, 'passkey_only'), false, JSON.stringify(amr));
  }
});

test('an unknown rule name fails closed', () => {
  assert.equal(amrSatisfiesRule(['user', 'mfa'], 'anything'), false);
  assert.equal(amrSatisfiesRule(['user', 'mfa'], '__proto__'), false);
});

test('shape: missing, string, object, non-string item, >16 items or an item >32 chars fails under both rules', () => {
  const bad: unknown[] = [
    undefined, null, 'user mfa', { 0: 'user', 1: 'mfa' }, ['user', 'mfa', 7], ['user', 'mfa', null],
    [...Array.from({ length: 15 }, () => 'user'), 'mfa', 'user'], ['user', 'mfa', 'x'.repeat(33)], ['user', 'mfa', ''],
  ];
  for (const amr of bad) {
    assert.equal(normalizedAmr(amr), null, JSON.stringify(amr));
    assert.equal(amrSatisfiesRule(amr, 'passkey_only'), false);
    assert.equal(amrSatisfiesRule(amr, 'webauthn_key'), false);
  }
  assert.deepEqual(normalizedAmr([...Array.from({ length: 15 }, () => 'user'), 'mfa']), ['user', 'mfa'], '16 items pass');
  assert.equal(amrSatisfiesRule(['user', 'mfa', 'x'.repeat(32)], 'webauthn_key'), true, '32 chars is a valid shape');
  assert.notEqual(normalizedAmr(['user', 'mfa', 'x'.repeat(32)]), null);
});

test('auth_time: entry within 30 days (+60 s skew) passes; beyond, 61 s ahead, missing and non-integer fail', () => {
  assert.equal(ownerAuthTimeFailure(NOW_SEC, NOW_MS), null);
  assert.equal(ownerAuthTimeFailure(NOW_SEC - 84 * 60, NOW_MS), null, 'a reused IdP session (84 min) enters');
  assert.equal(ownerAuthTimeFailure(NOW_SEC - 30 * DAY_SEC - 60, NOW_MS), null, 'the window edge is inclusive');
  assert.equal(ownerAuthTimeFailure(NOW_SEC - 30 * DAY_SEC - 61, NOW_MS), 'auth_time_stale');
  assert.equal(ownerAuthTimeFailure(NOW_SEC + 60, NOW_MS), null, '60 s of skew ahead is tolerated');
  assert.equal(ownerAuthTimeFailure(NOW_SEC + 61, NOW_MS), 'auth_time_in_future');
  for (const value of [undefined, null, 0, -5, NOW_SEC + 0.5, String(NOW_SEC), Number.NaN]) {
    assert.equal(ownerAuthTimeFailure(value, NOW_MS), 'auth_time_missing', String(value));
  }
});

test('success returns the distinct amr, the auth age, and the fresh-touch tier', () => {
  const decision = decideOwnerSignIn({
    account: ACCOUNT, claims: { amr: ['mfa', 'user', 'mfa'], auth_time: NOW_SEC - 42 }, nowMs: NOW_MS,
  });
  assert.deepEqual(decision, { ok: true, amr: ['mfa', 'user'], authAgeSec: 42, authStale: false, privileged: true });
});

test('A2: an old auth_time enters without privilege and is flagged stale (audited silently)', () => {
  const decision = decideOwnerSignIn({ account: ACCOUNT, claims: { ...PASSKEY, auth_time: NOW_SEC - 3 * DAY_SEC }, nowMs: NOW_MS });
  assert.deepEqual(decision, { ok: true, amr: ['user', 'mfa'], authAgeSec: 3 * DAY_SEC, authStale: true, privileged: false });
});

test('D9-4: a fresh touch is at most 120 s old and not before the request started (minus 60 s skew)', () => {
  assert.equal(ownerSignInIsFreshTouch(NOW_MS - 120_000, NOW_MS, undefined), true);
  assert.equal(ownerSignInIsFreshTouch(NOW_MS - 120_001, NOW_MS, undefined), false);
  assert.equal(ownerSignInIsFreshTouch(NOW_MS - 31 * 60_000, NOW_MS, NOW_MS - 32 * 60_000), false, '31 min old');
  assert.equal(ownerSignInIsFreshTouch(NOW_MS - 90_000, NOW_MS, NOW_MS - 20_000), false, 'before the request');
  assert.equal(ownerSignInIsFreshTouch(NOW_MS - 70_000, NOW_MS, NOW_MS - 20_000), true, 'within the skew');
  const decision = decideOwnerSignIn({
    account: ACCOUNT, claims: { ...PASSKEY, auth_time: NOW_SEC - 90 }, nowMs: NOW_MS, requestedAtMs: NOW_MS - 10_000,
  });
  assert.equal(decision.ok && decision.privileged, false, 'an IdP session reused across the request is no touch');
});

test('each refusal carries its audited reason and return code', () => {
  const cases: Array<[Parameters<typeof decideOwnerSignIn>[0], string, string]> = [
    [{ account: { must_change_password: 1 }, claims: PASSKEY, nowMs: NOW_MS },
      'password_change_required', 'password_change_required'],
    [{ account: ACCOUNT, claims: { ...PASSKEY, amr: ['pwd', 'otp', 'mfa'] }, nowMs: NOW_MS },
      'amr_insufficient', 'owner_sso_key_required'],
    [{ account: ACCOUNT, claims: { amr: ['user', 'mfa'] }, nowMs: NOW_MS },
      'auth_time_missing', 'owner_sso_reauth_required'],
    [{ account: ACCOUNT, claims: { ...PASSKEY, auth_time: NOW_SEC - 31 * DAY_SEC }, nowMs: NOW_MS },
      'auth_time_stale', 'owner_sso_reauth_required'],
    [{ account: ACCOUNT, claims: { ...PASSKEY, auth_time: NOW_SEC + 120 }, nowMs: NOW_MS },
      'auth_time_in_future', 'owner_sso_reauth_required'],
  ];
  const stepUpReasons = new Set(['amr_insufficient', 'auth_time_missing', 'auth_time_stale', 'auth_time_in_future']);
  for (const [input, reason, code] of cases) {
    assert.deepEqual(decideOwnerSignIn(input), { ok: false, reason, code, stepUp: stepUpReasons.has(reason) }, reason);
  }
});

test('order: must_change_password, then amr, then auth_time — an earlier failure wins', () => {
  const allBad = { amr: ['pwd'], auth_time: NOW_SEC - 31 * DAY_SEC };
  const reasonOf = (input: Parameters<typeof decideOwnerSignIn>[0]) => {
    const decision = decideOwnerSignIn(input);
    return decision.ok ? 'ok' : decision.reason;
  };
  assert.equal(reasonOf({ account: { must_change_password: 1 }, claims: allBad, nowMs: NOW_MS }),
    'password_change_required');
  assert.equal(reasonOf({ account: ACCOUNT, claims: allBad, nowMs: NOW_MS }), 'amr_insufficient');
  assert.equal(reasonOf({ account: ACCOUNT, claims: { ...allBad, amr: ['user', 'mfa'] }, nowMs: NOW_MS }),
    'auth_time_stale');
  assert.equal(reasonOf({ account: ACCOUNT, claims: null, nowMs: NOW_MS }), 'amr_insufficient');
});

test('always on: no opt-in is needed, the passkey and freshness rules still apply', () => {
  assert.deepEqual(decideOwnerSignIn({ account: ACCOUNT, claims: PASSKEY, nowMs: NOW_MS }),
    { ok: true, amr: ['user', 'mfa'], authAgeSec: 0, authStale: false, privileged: true });
  const pwdOnly = decideOwnerSignIn({ account: ACCOUNT, claims: { ...PASSKEY, amr: ['pwd'] }, nowMs: NOW_MS });
  assert.deepEqual(pwdOnly, { ok: false, reason: 'amr_insufficient', code: 'owner_sso_key_required', stepUp: true });
  const stale = decideOwnerSignIn({ account: ACCOUNT, claims: { ...PASSKEY, auth_time: NOW_SEC - 31 * DAY_SEC }, nowMs: NOW_MS });
  assert.equal(stale.ok, false);
});

test('the rule parameter switches the factor check in one place', () => {
  const input = { account: ACCOUNT, claims: { amr: ['pwd', 'user', 'mfa'], auth_time: NOW_SEC }, nowMs: NOW_MS };
  assert.equal(decideOwnerSignIn(input).ok, false, 'passkey_only by default');
  assert.equal(decideOwnerSignIn({ ...input, rule: 'webauthn_key' }).ok, true);
});

test('ownerLoginHint takes a bounded preferred_username without spaces or control characters', () => {
  assert.equal(ownerLoginHint({ preferred_username: 'nawras@example.org' }), 'nawras@example.org');
  for (const value of [undefined, null, 7, '', 'a b', 'x\u0000y', 'x\ny', 'a'.repeat(256)]) {
    assert.equal(ownerLoginHint({ preferred_username: value }), null, JSON.stringify(value));
  }
  assert.equal(ownerLoginHint(null), null);
});

test('wallet mode: only a fresh passkey touch admits the owner; a reused session becomes a step-up refusal', () => {
  const fresh = decideOwnerSignIn({ account: ACCOUNT, claims: PASSKEY, nowMs: NOW_MS });
  assert.equal(requireFreshOwnerTouch(fresh), fresh);
  const reused = decideOwnerSignIn({ account: ACCOUNT, claims: { ...PASSKEY, auth_time: NOW_SEC - 3 * 86_400 }, nowMs: NOW_MS });
  assert.equal(reused.ok, true);
  assert.deepEqual(requireFreshOwnerTouch(reused), {
    ok: false, reason: 'fresh_touch_required', code: 'owner_sso_reauth_required', stepUp: true,
  });
  const refused = decideOwnerSignIn({ account: { must_change_password: 1 }, claims: PASSKEY, nowMs: NOW_MS });
  assert.equal(requireFreshOwnerTouch(refused), refused, 'a refusal passes through');
});
