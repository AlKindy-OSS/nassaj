import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { ChallengeStoreFullError, createChallengeStore } from './webauthn-challenge.store.js';

/**
 * The two expiry tests below used to advance real time with `setTimeout(20)`
 * against a `ttlMs: 5` store. That raced: the store reads `Date.now()` directly
 * , so under full-suite load more than 5 ms
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

const REG = { purpose: 'registration' as const };
const LOGIN = { purpose: 'login' as const, userId: null };

test('challenge store: consume returns the binding once, then null (single use)', () => {
  const store = createChallengeStore();
  store.store('chal-1', { ...REG, userId: 42 });

  assert.deepEqual(store.consume('chal-1', { ...REG, userId: 42 }),
    { userId: 42, purpose: 'registration', audience: null });
  assert.equal(store.consume('chal-1', { ...REG, userId: 42 }), null, 'second consume (replay) rejected');
});

test('challenge store: anonymous login challenges carry userId null', () => {
  const store = createChallengeStore();
  store.store('anon-1', LOGIN);

  assert.deepEqual(store.consume('anon-1', LOGIN), { userId: null, purpose: 'login', audience: null });
});

test('challenge store: unknown or invalid challenge returns null', () => {
  const store = createChallengeStore();
  assert.equal(store.consume('never-stored', LOGIN), null);
  assert.equal(store.consume('', LOGIN), null);
  // @ts-expect-error deliberately wrong type
  assert.equal(store.consume(undefined, LOGIN), null);
});

test('challenge store: any purpose/user/audience mismatch returns null AND burns the entry', () => {
  const store = createChallengeStore();
  const cases: Array<[Parameters<typeof store.store>[1], Parameters<typeof store.consume>[1]]> = [
    [LOGIN, { ...REG, userId: 1 }],
    [{ ...REG, userId: 1 }, LOGIN],
    [{ ...REG, userId: 1 }, { purpose: 'step_up', userId: 1, audience: 'passkey_registration' }],
    [{ purpose: 'step_up', userId: 1, audience: 'passkey_registration' }, { ...REG, userId: 1 }],
    [{ purpose: 'step_up', userId: 1, audience: 'passkey_registration' }, LOGIN],
    [LOGIN, { purpose: 'step_up', userId: 1, audience: 'passkey_registration' }],
    [{ ...REG, userId: 1 }, { ...REG, userId: 2 }],
    [{ purpose: 'step_up', userId: 1, audience: 'connector_owner' },
      { purpose: 'step_up', userId: 1, audience: 'passkey_registration' }],
  ];
  cases.forEach(([binding, expected], index) => {
    store.store(`c-${index}`, binding);
    assert.equal(store.consume(`c-${index}`, expected), null, `case ${index} mismatch rejected`);
    assert.equal(store.consume(`c-${index}`, binding), null, `case ${index} entry burned`);
  });
  assert.equal(store.size, 0);
});

test('challenge store: malformed bindings are programmer errors', () => {
  const store = createChallengeStore();
  // @ts-expect-error missing purpose
  assert.throws(() => store.store('x', { userId: 1 }), /purpose_invalid/);
  assert.throws(() => store.store('x', { purpose: 'login', userId: 1 }), /user_invalid/);
  assert.throws(() => store.store('x', { purpose: 'registration', userId: null }), /user_invalid/);
  assert.throws(() => store.store('x', { purpose: 'step_up', userId: 1 }), /audience_invalid/);
  assert.throws(() => store.store('x', { purpose: 'registration', userId: 1, audience: 'a' }), /audience_invalid/);
});

test('challenge store: one pending step_up per user — the new challenge replaces the old', () => {
  const store = createChallengeStore();
  const binding = { purpose: 'step_up' as const, userId: 5, audience: 'passkey_registration' };
  store.store('old', binding);
  store.store('other-user', { ...binding, userId: 6 });
  store.store('new', { ...binding, audience: 'connector_owner' });
  assert.equal(store.consume('old', binding), null, 'replaced challenge is gone');
  assert.deepEqual(store.consume('new', { ...binding, audience: 'connector_owner' }),
    { userId: 5, purpose: 'step_up', audience: 'connector_owner' });
  assert.ok(store.consume('other-user', { ...binding, userId: 6 }), 'other users keep theirs');
});

test('challenge store: per-purpose caps throw ChallengeStoreFullError without starving other purposes', () => {
  const store = createChallengeStore({ caps: { login: 2, registration: 1 } });
  store.store('l1', LOGIN);
  store.store('l2', LOGIN);
  assert.throws(() => store.store('l3', LOGIN), (error: unknown) =>
    error instanceof ChallengeStoreFullError && error.purpose === 'login');
  store.store('r1', { ...REG, userId: 1 });
  assert.throws(() => store.store('r2', { ...REG, userId: 2 }), ChallengeStoreFullError);
  store.consume('l1', LOGIN);
  store.store('l3', LOGIN);
  assert.equal(store.size, 3);
});

test('challenge store: expired challenge is rejected and removed', () => {
  withMockedClock((advance) => {
    const store = createChallengeStore({ ttlMs: 5 });
    store.store('soon-stale', { ...REG, userId: 7 });

    advance(20); // exactly 20 ms past store(), well beyond the 5 ms TTL

    assert.equal(store.consume('soon-stale', { ...REG, userId: 7 }), null, 'expired challenge rejected');
    assert.equal(store.size, 0, 'expired entry removed on consume');
  });
});

// The TTL boundary itself: the store compares with `>`, so a challenge is
// still valid AT its expiry instant and dead one millisecond later.
test('challenge store: a challenge is valid up to its TTL and dead one ms after', () => {
  withMockedClock((advance) => {
    const atBoundary = createChallengeStore({ ttlMs: 5 });
    atBoundary.store('edge', { ...REG, userId: 3 });
    advance(5); // now === expiresAt
    assert.ok(atBoundary.consume('edge', { ...REG, userId: 3 }), 'valid at the TTL instant');

    const pastBoundary = createChallengeStore({ ttlMs: 5 });
    pastBoundary.store('edge', { ...REG, userId: 3 });
    advance(6); // now === expiresAt + 1
    assert.equal(pastBoundary.consume('edge', { ...REG, userId: 3 }), null, 'dead one ms past the TTL');
  });
});

test('challenge store: every store() sweeps expired entries, so a full cap frees itself', () => {
  withMockedClock((advance) => {
    const store = createChallengeStore({ ttlMs: 5, caps: { login: 3 } });
    for (let i = 0; i < 3; i += 1) {
      store.store(`stale-${i}`, LOGIN);
    }
    store.store('reg', { ...REG, userId: 1 });
    advance(20);

    store.store('fresh', LOGIN);

    assert.equal(store.size, 1, 'only the fresh challenge survives the sweep');
    assert.ok(store.consume('fresh', LOGIN));
  });
});
