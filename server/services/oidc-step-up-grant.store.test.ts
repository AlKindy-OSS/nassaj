/**
 * T-1939 6B: the one-time OIDC step-up grant store, the auth_time freshness
 * rule and the browser-transaction cookie reader.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { readBrowserTransaction } from './oidc-browser-transaction.js';
import { createOidcStepUpGrantStore } from './oidc-step-up-grant.store.js';
import {
  STEP_UP_CLOCK_SKEW_MS,
  STEP_UP_MAX_AUTH_AGE_MS,
  stepUpAuthTimeFailure,
} from './oidc-step-up.js';

const TXN = 'A'.repeat(43);
const OTHER_TXN = 'B'.repeat(43);
const binding = { userId: 7, audience: 'connector_owner', browserTransaction: TXN };

test('a grant is single use and bound to user, audience and browser transaction', () => {
  const store = createOidcStepUpGrantStore();
  const grant = store.issue(binding);
  assert.match(grant ?? '', /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(store.consume(grant!, binding), true);
  assert.equal(store.consume(grant!, binding), false, 'replay');

  for (const mismatch of [
    { ...binding, userId: 8 },
    { ...binding, audience: 'passkey_registration' },
    { ...binding, browserTransaction: OTHER_TXN },
    { ...binding, browserTransaction: null },
  ]) {
    const burned = store.issue(binding)!;
    assert.equal(store.consume(burned, mismatch), false);
    assert.equal(store.consume(burned, binding), false, 'a mismatched attempt burns the grant');
  }
  assert.equal(store.size, 0);
});

test('a grant expires after its 60 s TTL and expired grants are purged', () => {
  let now = 1_000;
  const store = createOidcStepUpGrantStore({ now: () => now });
  const early = store.issue(binding)!;
  now += 59_999;
  assert.equal(store.consume(early, binding), true, 'still valid just before 60 s');
  const late = store.issue(binding)!;
  now += 60_000;
  assert.equal(store.consume(late, binding), false, 'expired at exactly 60 s');

  store.issue(binding);
  store.issue(binding);
  assert.equal(store.size, 2);
  now += 60_000;
  assert.equal(store.consume('unknown-grant', binding), false);
  assert.equal(store.size, 0, 'every lookup prunes expired grants; no separate purge is needed');
});

test('issue refuses malformed bindings and a full store; consume refuses malformed grants', () => {
  let now = 0;
  const store = createOidcStepUpGrantStore({ maxEntries: 2, now: () => now });
  assert.equal(store.issue({ ...binding, userId: 0 }), null);
  assert.equal(store.issue({ ...binding, userId: 1.5 }), null);
  assert.equal(store.issue({ ...binding, browserTransaction: 'short' }), null);
  assert.equal(store.issue({ ...binding, audience: undefined as unknown as string }), null);
  assert.ok(store.issue(binding));
  assert.ok(store.issue(binding));
  assert.equal(store.issue(binding), null, 'bounded');
  now += 60_000;
  assert.ok(store.issue(binding), 'expired entries are pruned before the cap applies');
  for (const grant of ['', 'x'.repeat(129), 42 as unknown as string]) {
    assert.equal(store.consume(grant, binding), false);
  }
});

test('auth_time must prove a fresh IdP sign-in for this step-up', () => {
  const requestedAtMs = 10_000_000;
  const nowMs = requestedAtMs + 30_000;
  const check = (authTimeMs: number | null) => stepUpAuthTimeFailure({ authTimeMs, requestedAtMs, nowMs });
  assert.equal(check(null), 'auth_time_missing');
  assert.equal(check(Number.NaN), 'auth_time_missing');
  assert.equal(check(requestedAtMs + 1_000), null);
  assert.equal(check(requestedAtMs - STEP_UP_CLOCK_SKEW_MS), null, 'skew tolerated');
  assert.equal(check(requestedAtMs - STEP_UP_CLOCK_SKEW_MS - 1), 'auth_time_before_request',
    'an older IdP session cannot satisfy prompt=login');
  assert.equal(check(nowMs + STEP_UP_CLOCK_SKEW_MS + 1), 'auth_time_in_future');
  assert.equal(stepUpAuthTimeFailure({
    authTimeMs: requestedAtMs, requestedAtMs, nowMs: requestedAtMs + STEP_UP_MAX_AUTH_AGE_MS + 1,
  }), 'auth_time_stale');
});

test('the browser transaction cookie resolves only when present exactly once and well formed', () => {
  const read = (cookie: unknown) => readBrowserTransaction({ headers: { cookie } });
  assert.equal(read(`__Host-oidc-txn=${TXN}`), TXN);
  assert.equal(read(`other=1; __Host-oidc-txn=${TXN}; x=y`), TXN);
  assert.equal(read(`__Host-oidc-txn=${TXN}; __Host-oidc-txn=${OTHER_TXN}`), null, 'duplicate');
  assert.equal(read(`__Host-oidc-txn=${TXN}; __Host-oidc-txn=${TXN}`), null, 'duplicate, same value');
  assert.equal(read('__Host-oidc-txn=short'), null);
  assert.equal(read(undefined), null);
  assert.equal(read(`x=${'y'.repeat(4096)}; __Host-oidc-txn=${TXN}`), null, 'oversized header');
});
