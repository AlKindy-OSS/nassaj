/**
 * T-2035 (ADR-212): login throttle policy against an in-memory store and an
 * injected clock — lock threshold, progressive cap, decay, clear, and keys
 * that never carry the raw identifier.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryLoginThrottleStore } from './__tests__/login-throttle-memory-store.js';
import {
  createLoginThrottle,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_LOCK_MAX_MS,
  LOGIN_THROTTLE_DECAY_MS,
  lockDurationMs,
} from './login-throttle.service.js';

const SECRET = 'throttle-test-secret-0123456789abcdef';
const MINUTE = 60_000;

function harness() {
  const store = createMemoryLoginThrottleStore();
  let nowMs = 1_800_000_000_000;
  const throttle = createLoginThrottle({ secret: SECRET, store, now: () => nowMs });
  return { store, throttle, advance: (ms: number) => { nowMs += ms; } };
}

/** Charges `count` failed attempts and returns the admissions. */
function fail(throttle: ReturnType<typeof harness>['throttle'], key: string, count: number) {
  return Array.from({ length: count }, () => throttle.admit(key));
}

test('five attempts are admitted, the fifth starts a one-minute lock, the sixth is refused', () => {
  const { throttle } = harness();
  const key = throttle.keyForIdentifier('alice');
  const admissions = fail(throttle, key, 5);
  assert.ok(admissions.every((admission) => admission.allowed));
  assert.deepEqual(admissions.map((a) => a.allowed && a.lockedNow), [null, null, null, null,
    { lockSeconds: 60, lockCount: 1 }]);
  const sixth = throttle.admit(key);
  assert.deepEqual(sixth, { allowed: false, retryAfterSeconds: 60 });
});

test('a refused attempt is not charged and the lock ends on time', () => {
  const { throttle, store, advance } = harness();
  const key = throttle.keyForIdentifier('alice');
  fail(throttle, key, 5);
  advance(30_000);
  assert.deepEqual(throttle.admit(key), { allowed: false, retryAfterSeconds: 30 });
  assert.equal(store.rows.get(key)?.failures, 5, 'a locked attempt is never counted');
  advance(30_000);
  const after = throttle.admit(key);
  assert.equal(after.allowed, true, 'lock expired');
  assert.equal(store.rows.get(key)?.failures, 1, 'a new window starts after the lock');
});

test('failures older than the window do not accumulate', () => {
  const { throttle, store, advance } = harness();
  const key = throttle.keyForIdentifier('alice');
  fail(throttle, key, 4);
  advance(LOGIN_FAILURE_WINDOW_MS);
  fail(throttle, key, 4);
  assert.equal(store.rows.get(key)?.locked_until, null);
  assert.equal(store.rows.get(key)?.failures, 4);
});

test('locks grow 1, 2, 4, 8, 16 minutes and cap at 30 — never permanent', () => {
  const { throttle, advance } = harness();
  const key = throttle.keyForIdentifier('owner');
  const lengths: number[] = [];
  for (let round = 0; round < 8; round += 1) {
    const last = fail(throttle, key, 5).at(-1);
    assert.ok(last?.allowed && last.lockedNow);
    lengths.push(last.lockedNow.lockSeconds / 60);
    advance(last.lockedNow.lockSeconds * 1000);
  }
  assert.deepEqual(lengths, [1, 2, 4, 8, 16, 30, 30, 30]);
  assert.equal(lockDurationMs(1_000), LOGIN_LOCK_MAX_MS);
  // Even at the cap the owner can sign in once the current lock ends.
  assert.equal(throttle.admit(key).allowed, true);
});

test('lock_count decays after 24 hours without failures', () => {
  const { throttle, store, advance } = harness();
  const key = throttle.keyForIdentifier('alice');
  fail(throttle, key, 5);
  advance(MINUTE);
  fail(throttle, key, 5);
  assert.equal(store.rows.get(key)?.lock_count, 2);
  advance(LOGIN_THROTTLE_DECAY_MS + 1);
  const last = fail(throttle, key, 5).at(-1);
  assert.ok(last?.allowed);
  assert.deepEqual(last.lockedNow, { lockSeconds: 60, lockCount: 1 }, 'back to the first lock');
});

test('stale rows of other keys are pruned on write', () => {
  const { throttle, store, advance } = harness();
  throttle.admit(throttle.keyForIdentifier('old'));
  advance(LOGIN_THROTTLE_DECAY_MS + 1);
  throttle.admit(throttle.keyForIdentifier('new'));
  assert.equal(store.rows.size, 1);
});

test('clear removes the row', () => {
  const { throttle, store } = harness();
  const key = throttle.keyForIdentifier('alice');
  fail(throttle, key, 3);
  throttle.clear(key);
  assert.equal(store.rows.has(key), false);
});

test('keys are normalized HMACs that never contain the identifier', () => {
  const { throttle } = harness();
  const key = throttle.keyForIdentifier('  Alice@Example.TEST ');
  assert.equal(key, throttle.keyForIdentifier('alice@example.test'));
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key.includes('alice'), false);
  assert.notEqual(throttle.keyForUser(7), throttle.keyForIdentifier('7'));
  const other = createLoginThrottle({ secret: `${SECRET}-other`, store: createMemoryLoginThrottleStore() });
  assert.notEqual(other.keyForIdentifier('alice'), throttle.keyForIdentifier('alice'), 'keyed by the secret');
});

test('a missing secret fails closed at construction', () => {
  assert.throws(() => createLoginThrottle({ secret: '' }), /login_throttle_secret_missing/);
});
