/**
 * sessionProcessStateStore.presence.test.ts (B-269)
 *
 * The store has TWO feeds that must compose, not overwrite each other:
 *
 *  1. the `process_state` mirror stream (setSessionProcessState) — reaches only
 *     sessions this client has opened, but covers runs presence cannot see
 *     (a run whose writer carries no authenticated userId is never registered
 *     in presence at all, yet still broadcasts through its mirrors);
 *  2. the presence snapshot's `runningSessions` list
 *     (reconcilePresenceProcessStates) — reaches every client for every run it
 *     is permitted to see, opened or not.
 *
 * Reconciliation is authoritative for what presence OWNS and inert elsewhere;
 * this pins that boundary, since getting it wrong either resurrects finished
 * sessions or silently wipes the badge of a live one.
 */

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  getSessionProcessState,
  reconcilePresenceProcessStates,
  setSessionProcessState,
  subscribeSessionProcessState,
} from './sessionProcessStateStore';

/** Clears every entry either feed could have left behind. */
function resetStore(): void {
  for (const id of ['a', 'b', 'c', 'mirror-only']) {
    setSessionProcessState(id, 'idle');
  }
  reconcilePresenceProcessStates([]);
}

beforeEach(resetStore);

test('presence lights up sessions this client never opened', () => {
  reconcilePresenceProcessStates([
    { sessionId: 'a', state: 'running' },
    { sessionId: 'b', state: 'frozen' },
  ]);

  assert.equal(getSessionProcessState('a'), 'running');
  assert.equal(getSessionProcessState('b'), 'frozen');
});

test('a run dropped from the snapshot clears — that is the live update', () => {
  reconcilePresenceProcessStates([
    { sessionId: 'a', state: 'running' },
    { sessionId: 'b', state: 'running' },
  ]);
  reconcilePresenceProcessStates([{ sessionId: 'a', state: 'running' }]);

  assert.equal(getSessionProcessState('a'), 'running');
  assert.equal(getSessionProcessState('b'), null, 'b ended, so its badge clears');
});

test('reconciliation never prunes an entry the mirror stream owns', () => {
  // A run presence does not know about (unauthenticated writer) arrives only
  // through the mirror stream. Snapshots that omit it must leave it alone.
  setSessionProcessState('mirror-only', 'running');
  reconcilePresenceProcessStates([{ sessionId: 'a', state: 'running' }]);

  assert.equal(
    getSessionProcessState('mirror-only'),
    'running',
    'a mirror-owned entry survives a snapshot that omits it',
  );

  reconcilePresenceProcessStates([]);
  assert.equal(getSessionProcessState('mirror-only'), 'running');
  assert.equal(getSessionProcessState('a'), null, 'the presence-owned entry did clear');
});

test('a local idle from the mirror stream is not resurrected by a stale snapshot', () => {
  reconcilePresenceProcessStates([{ sessionId: 'a', state: 'running' }]);
  // The turn completes: AppContent maps complete/error to 'idle'.
  setSessionProcessState('a', 'idle');
  assert.equal(getSessionProcessState('a'), null);

  // The very next snapshot no longer lists it; the entry must stay cleared and
  // presence must have released ownership (no stale prune bookkeeping).
  reconcilePresenceProcessStates([]);
  assert.equal(getSessionProcessState('a'), null);
});

test('presence transitions running ⇄ frozen in place', () => {
  reconcilePresenceProcessStates([{ sessionId: 'a', state: 'running' }]);
  reconcilePresenceProcessStates([{ sessionId: 'a', state: 'frozen' }]);
  assert.equal(getSessionProcessState('a'), 'frozen');

  reconcilePresenceProcessStates([{ sessionId: 'a', state: 'running' }]);
  assert.equal(getSessionProcessState('a'), 'running');
});

test('subscribers are notified exactly when the snapshot changes something', () => {
  // useSyncExternalStore re-reads on every emit; an emit per snapshot (the
  // server re-broadcasts on any presence change) would re-render the sidebar
  // for nothing.
  let emits = 0;
  const unsubscribe = subscribeSessionProcessState(() => {
    emits += 1;
  });
  try {
    reconcilePresenceProcessStates([{ sessionId: 'a', state: 'running' }]);
    assert.equal(emits, 1, 'first appearance emits');

    reconcilePresenceProcessStates([{ sessionId: 'a', state: 'running' }]);
    assert.equal(emits, 1, 'an identical snapshot is silent');

    reconcilePresenceProcessStates([]);
    assert.equal(emits, 2, 'removal emits');
  } finally {
    unsubscribe();
  }
});
