/**
 * ADR-194 A1 withdrawn (A2.5, owner decision 2026-10-18): the pure owner SSO
 * sign-in rule admits a linked owner whatever the `amr` and `auth_time`; only
 * a pending forced password change refuses. `amr` and the sign-in age are
 * kept for the audit only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { authAgeSeconds, decideOwnerSignIn, normalizedAmr } from './oidc-owner-sign-in.js';
import * as ownerSignInModule from './oidc-owner-sign-in.js';

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = NOW_MS / 1000;
const ACCOUNT = Object.freeze({ must_change_password: 0 });
const DAY_SEC = 24 * 3600;

test('any amr is admitted: password only, OTP, password + key, passkey, missing', () => {
  for (const amr of [['pwd'], ['pwd', 'otp', 'mfa'], ['pwd', 'user', 'mfa'], ['user', 'mfa'], [], undefined]) {
    const decision = decideOwnerSignIn({ account: ACCOUNT, claims: { amr, auth_time: NOW_SEC }, nowMs: NOW_MS });
    assert.equal(decision.ok, true, JSON.stringify(amr));
  }
});

test('any auth_time is admitted: years old, missing, malformed or in the future', () => {
  for (const authTime of [NOW_SEC - 400 * DAY_SEC, undefined, 'x', -1, NOW_SEC + DAY_SEC]) {
    const decision = decideOwnerSignIn({ account: ACCOUNT, claims: { amr: ['pwd'], auth_time: authTime }, nowMs: NOW_MS });
    assert.equal(decision.ok, true, String(authTime));
  }
});

test('a pending forced password change is the one refusal, and no step-up is offered', () => {
  const decision = decideOwnerSignIn({
    account: { must_change_password: 1 }, claims: { amr: ['user', 'mfa'], auth_time: NOW_SEC }, nowMs: NOW_MS,
  });
  assert.deepEqual(decision, { ok: false, reason: 'password_change_required', code: 'password_change_required' });
});

test('the admitted decision carries the audit fields only', () => {
  const decision = decideOwnerSignIn({
    account: ACCOUNT, claims: { amr: ['pwd', 'pwd'], auth_time: NOW_SEC - 90 }, nowMs: NOW_MS,
  });
  assert.deepEqual(decision, { ok: true, amr: ['pwd'], authAgeSec: 90 });
});

test('normalizedAmr keeps a valid shape only; authAgeSeconds never throws', () => {
  assert.deepEqual(normalizedAmr(['user', 'mfa', 'user']), ['user', 'mfa']);
  assert.equal(normalizedAmr('pwd'), null);
  assert.equal(normalizedAmr(Array.from({ length: 17 }, () => 'x')), null);
  assert.equal(normalizedAmr(['x'.repeat(33)]), null);
  assert.equal(authAgeSeconds(NOW_SEC - 5, NOW_MS), 5);
  assert.equal(authAgeSeconds(NOW_SEC + 5, NOW_MS), 0);
  assert.equal(authAgeSeconds(undefined, NOW_MS), null);
});

test('the withdrawn A1 surface is gone (no factor rule, cap, fresh touch or wallet step-up)', () => {
  for (const name of [
    'OWNER_SSO_FACTOR_RULE', 'OWNER_SSO_FACTOR_RULES', 'OWNER_SSO_ENTRY_MAX_AUTH_AGE_MS', 'amrSatisfiesRule',
    'ownerAuthTimeFailure', 'ownerSignInIsFreshTouch', 'requireFreshOwnerTouch', 'ownerLoginHint',
  ]) {
    assert.equal(name in ownerSignInModule, false, name);
  }
});
