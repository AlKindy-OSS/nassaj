import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _resetHarnessLeases,
  acquireHarnessLease,
  activeHarnessJobId,
  isHarnessLeased,
  releaseHarnessLease,
} from './lease.js';

test('single-flight: a second acquire for the same harness conflicts', () => {
  _resetHarnessLeases();
  const first = acquireHarnessLease('kimi', 'job-1');
  assert.ok('lease' in first);
  assert.equal(isHarnessLeased('kimi'), true);
  assert.equal(activeHarnessJobId('kimi'), 'job-1');

  const second = acquireHarnessLease('kimi', 'job-2');
  assert.deepEqual(second, { conflict: 'job-1' });
});

test('different harnesses hold independent leases', () => {
  _resetHarnessLeases();
  assert.ok('lease' in acquireHarnessLease('kimi', 'a'));
  assert.ok('lease' in acquireHarnessLease('qwen', 'b'));
  assert.equal(isHarnessLeased('kimi'), true);
  assert.equal(isHarnessLeased('qwen'), true);
});

test('release only frees when the holder matches (idempotent)', () => {
  _resetHarnessLeases();
  acquireHarnessLease('cursor', 'owner');
  releaseHarnessLease('cursor', 'someone-else');
  assert.equal(isHarnessLeased('cursor'), true); // not released by a non-owner
  releaseHarnessLease('cursor', 'owner');
  assert.equal(isHarnessLeased('cursor'), false);
  releaseHarnessLease('cursor', 'owner'); // no-op, no throw
  assert.equal(activeHarnessJobId('cursor'), null);
});
