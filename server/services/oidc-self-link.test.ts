import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isUniqueConflict,
  oidcAlertDedupeKey,
  SELF_LINK_CLOCK_SKEW_MS,
  SELF_LINK_MAX_AUTH_AGE_MS,
  selfLinkAuthTimeFailure,
} from './oidc-self-link.js';

const requestedAtMs = 1_800_000_000_000;

test('T-1939 slice 5: auth_time must follow the link request and be at most 5 min (+skew) old', () => {
  const check = (authTimeMs: number | null, nowMs: number) => selfLinkAuthTimeFailure({ authTimeMs, requestedAtMs, nowMs });
  assert.equal(check(null, requestedAtMs), 'auth_time_missing');
  assert.equal(check(Number.NaN, requestedAtMs), 'auth_time_missing');
  assert.equal(check(requestedAtMs - SELF_LINK_CLOCK_SKEW_MS, requestedAtMs), null, 'skew edge accepted');
  assert.equal(check(requestedAtMs - SELF_LINK_CLOCK_SKEW_MS - 1, requestedAtMs), 'auth_time_before_request');
  const limit = SELF_LINK_MAX_AUTH_AGE_MS + SELF_LINK_CLOCK_SKEW_MS;
  assert.equal(check(requestedAtMs, requestedAtMs + limit), null, 'age edge accepted');
  assert.equal(check(requestedAtMs, requestedAtMs + limit + 1), 'auth_time_stale');
  assert.equal(SELF_LINK_MAX_AUTH_AGE_MS, 5 * 60_000);
  assert.equal(SELF_LINK_CLOCK_SKEW_MS, 60_000);
});

test('T-1939 slice 5: only SQLite constraint errors count as link conflicts', () => {
  assert.equal(isUniqueConflict({ code: 'SQLITE_CONSTRAINT_UNIQUE' }), true);
  assert.equal(isUniqueConflict({ code: 'SQLITE_BUSY' }), false);
  assert.equal(isUniqueConflict(new Error('x')), false);
  assert.equal(isUniqueConflict(null), false);
});

test('ADR-194 A1: a dedupe suffix makes each owner SSO alert its own; none keeps the merged key', () => {
  assert.equal(oidcAlertDedupeKey('member_linked', 12), 'oidc:member_linked:12');
  assert.equal(oidcAlertDedupeKey('owner_sso_sign_in', 1, 'abc'), 'oidc:owner_sso_sign_in:1:abc');
  assert.equal(oidcAlertDedupeKey('owner_sso_sign_in', 1, ''), 'oidc:owner_sso_sign_in:1');
  assert.notEqual(oidcAlertDedupeKey('owner_sso_sign_in', 1, 'a'), oidcAlertDedupeKey('owner_sso_sign_in', 1, 'b'));
});
