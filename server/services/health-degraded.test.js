/** Unit tests for the /health `degraded` derivation (ADR-156 WI-6, T-1718). */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEGRADED_REASONS, resolveDegraded } from './health-degraded.js';

test('an OPEN gate is not degraded', () => {
  assert.deepEqual(
    resolveDegraded(() => ({ state: 'OPEN', phase: null, gateClosed: false })),
    { degraded: false, degradedReason: null, degradedPhase: null },
  );
});

test('MANUAL outranks the generic maintenance reason', () => {
  assert.deepEqual(
    resolveDegraded(() => ({ state: 'MANUAL', phase: 'ROLLED_BACK', gateClosed: true })),
    { degraded: true, degradedReason: DEGRADED_REASONS.MANUAL, degradedPhase: 'ROLLED_BACK' },
  );
});

test('a closed gate mid-update is degraded as maintenance', () => {
  for (const state of ['DRAINING', 'UPDATING', 'RECOVERING']) {
    assert.deepEqual(
      resolveDegraded(() => ({ state, phase: 'PREPARED', gateClosed: true })),
      { degraded: true, degradedReason: DEGRADED_REASONS.MAINTENANCE, degradedPhase: 'PREPARED' },
    );
  }
});

test('MANUAL is degraded even if the journal claims the gate is open', () => {
  const resolved = resolveDegraded(() => ({ state: 'MANUAL', phase: null, gateClosed: false }));
  assert.equal(resolved.degraded, true);
  assert.equal(resolved.degradedReason, DEGRADED_REASONS.MANUAL);
});

test('an unreadable or nonsensical journal fails CLOSED, never healthy', () => {
  for (const reader of [
    () => { throw new Error('journal missing'); },
    () => null,
    () => 'OPEN',
    undefined,
  ]) {
    assert.deepEqual(
      resolveDegraded(reader),
      { degraded: true, degradedReason: DEGRADED_REASONS.UNAVAILABLE, degradedPhase: null },
    );
  }
});

test('the status projection is read at most once per probe', () => {
  let calls = 0;
  resolveDegraded(() => { calls += 1; return { state: 'OPEN', gateClosed: false }; });
  assert.equal(calls, 1);
});

test('a gate reopened on the previous generation is degraded with its exit path (ب.5)', () => {
  const resolved = resolveDegraded(() => ({
    state: 'OPEN', phase: null, gateClosed: false,
    degraded: 'source_tree_at_target', exitPath: 'complete_source_rollback_or_pin_release_ref',
  }));
  assert.equal(resolved.degraded, true);
  assert.equal(resolved.degradedReason, DEGRADED_REASONS.SOURCE_STATE);
  assert.equal(resolved.degradedDetail, 'source_tree_at_target');
  assert.equal(resolved.exitPath, 'complete_source_rollback_or_pin_release_ref');
});
