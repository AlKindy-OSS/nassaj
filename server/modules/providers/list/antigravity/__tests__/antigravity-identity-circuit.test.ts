/**
 * B-1284 — the Antigravity catalog breakers are per identity: one member's
 * failures never open another member's circuit, and a success deletes the
 * entry (bounded map, B-342 shape). Runner: node:test + node:assert/strict.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createIdentityCircuit } from '@/modules/providers/list/antigravity/antigravity-identity-circuit.js';

test('B-1284: identity A reaching the threshold opens A only', () => {
  const circuit = createIdentityCircuit(3, 1_000);
  for (let index = 0; index < 3; index += 1) circuit.recordFailure(1, 100);
  assert.equal(circuit.isOpen(1, 101), true, 'A is open');
  assert.equal(circuit.isOpen(2, 101), false, 'B is untouched by A');
  assert.equal(circuit.isOpen(null, 101), false, 'the operator is untouched by A');
});

test('B-1284: another identity\'s success never resets A\'s counter', () => {
  const circuit = createIdentityCircuit(3, 1_000);
  circuit.recordFailure(1, 100);
  circuit.recordFailure(1, 100);
  circuit.recordSuccess(2);
  circuit.recordFailure(1, 100);
  assert.equal(circuit.isOpen(1, 101), true, 'A still opens on its third failure');
});

test('B-1284: success deletes the entry; cooldown expiry half-opens', () => {
  const circuit = createIdentityCircuit(1, 1_000);
  circuit.recordFailure('7', 100);
  assert.equal(circuit.size(), 1);
  assert.equal(circuit.isOpen('7', 1_099), true);
  assert.equal(circuit.isOpen('7', 1_100), false, 'cooldown elapsed: one probe is allowed');
  circuit.recordSuccess('7');
  assert.equal(circuit.size(), 0, 'success deletes, so the map is bounded by failing identities');
});

test('B-1284: numeric and string ids of one member share one entry; null is the operator', () => {
  const circuit = createIdentityCircuit(2, 1_000);
  circuit.recordFailure(5, 0);
  circuit.recordFailure('5', 0);
  assert.equal(circuit.isOpen(5, 1), true);
  assert.equal(circuit.isOpen(null, 1), false);
});
