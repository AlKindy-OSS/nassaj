/** T-2044 S1: constant-time API key comparison. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { secretsEqual } from './secret-compare.js';

test('secretsEqual: equal strings match', () => {
  assert.equal(secretsEqual('k3y-value', 'k3y-value'), true);
});

test('secretsEqual: different value or length does not match', () => {
  assert.equal(secretsEqual('k3y-valuf', 'k3y-value'), false);
  assert.equal(secretsEqual('k3y', 'k3y-value'), false);
  assert.equal(secretsEqual('k3y-value-longer', 'k3y-value'), false);
  assert.equal(secretsEqual('', 'k3y-value'), false);
});

test('secretsEqual: non-string inputs never match and never throw', () => {
  for (const provided of [undefined, null, 42, ['k3y-value'], { k: 1 }]) {
    assert.equal(secretsEqual(provided, 'k3y-value'), false);
  }
  assert.equal(secretsEqual('x', undefined), false);
  assert.equal(secretsEqual('', ''), false, 'an empty expected secret matches nothing');
});
