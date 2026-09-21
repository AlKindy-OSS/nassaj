import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { createChallengeStore } from './webauthn-challenge.store.js';

/**
 * The two expiry tests below used to advance real time with `setTimeout(20)`
 * against a `ttlMs: 5` store. That raced: the store reads `Date.now()` directly
 * (webauthn-challenge.store.js:45,66), so under full-suite load more than 5 ms
 * could elapse between storing the FRESH entry and consuming it — the fresh
 * entry then expired too and `consume` returned null (observed once in six
 * full-suite runs).
 *
 * The clock is now injected from OUTSIDE the production module via node:test's
 * `mock.timers` with the `Date` API: the store's own `Date.now()` calls resolve
 * to a clock this test advances by an exact number of milliseconds. No sleeping,
 * no wall-clock dependency, and no change to the production store — expiry is
 * still exercised for real, just at a time we choose rather than one we hope for.
 *
 * `withMockedClock` guarantees `reset()` even if an assertion throws, so a
 * failure here can never leak a frozen global Date into another test.
 */
function withMockedClock(run: (advance: (ms: number) => void) => void): void {
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  try {
    run((ms) => mock.timers.tick(ms));
  } finally {
    mock.timers.reset();
  }
}

test('challenge store: consume returns the stored userId once, then null (single use)', () => {
  const store = createChallengeStore();
  store.store('chal-1', 42);

  assert.deepEqual(store.consume('chal-1'), { userId: 42 });
  assert.equal(store.consume('chal-1'), null, 'second consume (replay) rejected');
});

test('challenge store: anonymous challenges carry userId null', () => {
  const store = createChallengeStore();
  store.store('anon-1');

  assert.deepEqual(store.consume('anon-1'), { userId: null });
});

test('challenge store: unknown or invalid challenge returns null', () => {
  const store = createChallengeStore();
  assert.equal(store.consume('never-stored'), null);
  assert.equal(store.consume(''), null);
  // @ts-expect-error deliberately wrong type
  assert.equal(store.consume(undefined), null);
});

test('challenge store: expired challenge is rejected and removed', () => {
  withMockedClock((advance) => {
    const store = createChallengeStore({ ttlMs: 5 });
    store.store('soon-stale', 7);

    advance(20); // exactly 20 ms past store(), well beyond the 5 ms TTL

    assert.equal(store.consume('soon-stale'), null, 'expired challenge rejected');
    assert.equal(store.size, 0, 'expired entry removed on consume');
  });
});

// The TTL boundary itself, which a wall-clock test could never pin down: the
// store compares with `>` (webauthn-challenge.store.js:66), so a challenge is
// still valid AT its expiry instant and dead one millisecond later.
test('challenge store: a challenge is valid up to its TTL and dead one ms after', () => {
  withMockedClock((advance) => {
    const atBoundary = createChallengeStore({ ttlMs: 5 });
    atBoundary.store('edge', 3);
    advance(5); // now === expiresAt
    assert.deepEqual(atBoundary.consume('edge'), { userId: 3 }, 'valid at the TTL instant');

    const pastBoundary = createChallengeStore({ ttlMs: 5 });
    pastBoundary.store('edge', 3);
    advance(6); // now === expiresAt + 1
    assert.equal(pastBoundary.consume('edge'), null, 'dead one ms past the TTL');
  });
});

test('challenge store: lazy prune evicts expired entries once the map is large', () => {
  withMockedClock((advance) => {
    const store = createChallengeStore({ ttlMs: 5 });
    for (let i = 0; i < 1000; i += 1) {
      store.store(`stale-${i}`, i);
    }
    advance(20);

    // This store() crosses the prune threshold and sweeps the expired entries.
    store.store('fresh', 1);

    assert.equal(store.size, 1, 'only the fresh challenge survives the sweep');
    // The fresh entry cannot expire mid-test any more: the clock only moves
    // when this test moves it, so this is the assertion that used to flake.
    assert.deepEqual(store.consume('fresh'), { userId: 1 });
  });
});
