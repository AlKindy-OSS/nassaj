/**
 * computeHarnessCompatibility (T-1871 / ADR-159 Addendum 4, qa M-4).
 * Fixtures are the values measured on-host 2026-09-27
 * (docs/ops/t1871-measurements.md): opencode 1.18.32 vs pin 1.17.18,
 * kimi 2.1.1 vs pin 0.28.1, cursor baseline 2026.09.18-9a7762b.
 */
// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { PINNED_VENDOR_DIGESTS } from '@/services/isolation/vendor-binary-integrity.js';

import { computeHarnessCompatibility, type CompatibilityInput } from './compatibility.js';
import { HARNESS_UPDATE_DESCRIPTORS } from './descriptors.js';

const opencode = HARNESS_UPDATE_DESCRIPTORS.opencode;
const kimi = HARNESS_UPDATE_DESCRIPTORS.kimi;
const cursor = HARNESS_UPDATE_DESCRIPTORS.cursor;

const input = (over: Partial<CompatibilityInput>): CompatibilityInput => ({
  version: null,
  descriptor: cursor,
  pins: PINNED_VENDOR_DIGESTS,
  pinArmed: false,
  carrierAlwaysEnforced: false,
  ...over,
});

test('fixtures match the real pin table', () => {
  assert.equal(PINNED_VENDOR_DIGESTS.opencode.version, '1.17.18');
  assert.equal(PINNED_VENDOR_DIGESTS.kimi.version, '0.28.1');
  assert.equal(opencode.compat?.alwaysEnforcedMode, 'glm-carrier');
});

test('opencode 1.18.32, pin off, GLM carrier always enforces → incompatible in that mode', () => {
  const v = computeHarnessCompatibility(input({
    version: '1.18.32', descriptor: opencode, carrierAlwaysEnforced: true,
  }));
  assert.equal(v.state, 'incompatible');
  assert.equal(v.reason, 'glm-carrier-blocked');
  assert.deepEqual(v.blockedModes, ['glm-carrier']);
  assert.equal(v.referenceVersion, '1.17.18');
});

test('pin armed + mismatch → incompatible everywhere, takes precedence over the carrier', () => {
  const v = computeHarnessCompatibility(input({
    version: '1.18.32', descriptor: opencode, pinArmed: true, carrierAlwaysEnforced: true,
  }));
  assert.equal(v.state, 'incompatible');
  assert.equal(v.reason, 'pin-armed-blocked');
  assert.deepEqual(v.blockedModes, ['all']);
});

test('kimi 2.1.1, pin 0.28.1 not enforced → untested pin-mismatch-unreviewed (baseline does not mask it)', () => {
  assert.equal(kimi.compat?.baseline?.version, '2.1.1');
  const v = computeHarnessCompatibility(input({ version: '2.1.1', descriptor: kimi }));
  assert.equal(v.state, 'untested');
  assert.equal(v.reason, 'pin-mismatch-unreviewed');
  assert.equal(v.referenceVersion, '0.28.1');
  assert.deepEqual(v.blockedModes, []);
});

test('kimi 2.1.1 with the pin armed → incompatible', () => {
  const v = computeHarnessCompatibility(input({ version: '2.1.1', descriptor: kimi, pinArmed: true }));
  assert.equal(v.state, 'incompatible');
  assert.equal(v.reason, 'pin-armed-blocked');
});

test('version equal to the reviewed pin → compatible, even with the pin armed', () => {
  for (const pinArmed of [false, true]) {
    const v = computeHarnessCompatibility(input({
      version: '1.17.18', descriptor: opencode, pinArmed, carrierAlwaysEnforced: true,
    }));
    assert.equal(v.state, 'compatible');
    assert.equal(v.reason, 'pin-match');
  }
});

test('unpinned harness at its baseline → baseline with the as-of date, never "tested"', () => {
  const v = computeHarnessCompatibility(input({ version: '2026.09.18-9a7762b' }));
  assert.equal(v.state, 'baseline');
  assert.equal(v.reason, 'baseline-match');
  assert.equal(v.asOf, '2026-09-27');
  assert.equal(v.referenceVersion, '2026.09.18-9a7762b');
});

test('pin posture is irrelevant to an unpinned harness', () => {
  const v = computeHarnessCompatibility(input({
    version: '2026.09.18-9a7762b', pinArmed: true, carrierAlwaysEnforced: true,
  }));
  assert.equal(v.state, 'baseline');
});

test('unpinned harness past its baseline → untested not-baselined', () => {
  const v = computeHarnessCompatibility(input({ version: '2026.10.01-aaaaaaa' }));
  assert.equal(v.state, 'untested');
  assert.equal(v.reason, 'not-baselined');
  assert.equal(v.asOf, '2026-09-27');
});

test('no compat data at all → untested no-compat-data', () => {
  const v = computeHarnessCompatibility(input({
    version: '1.0.0', descriptor: { pinKey: null },
  }));
  assert.equal(v.state, 'untested');
  assert.equal(v.reason, 'no-compat-data');
  assert.equal(v.referenceVersion, null);
});

test('unreadable version → untested version-unknown', () => {
  for (const version of [null, '', '  ']) {
    const v = computeHarnessCompatibility(input({ version, descriptor: opencode, pinArmed: true }));
    assert.equal(v.state, 'untested');
    assert.equal(v.reason, 'version-unknown');
  }
});

test('a pin key missing from the table falls back to baseline logic', () => {
  const v = computeHarnessCompatibility(input({
    version: '2.1.1', descriptor: kimi, pins: {}, pinArmed: true,
  }));
  assert.equal(v.state, 'baseline');
});

test('a carrier mode without a named mode still reports a blocked reason', () => {
  const v = computeHarnessCompatibility(input({
    version: '9.9.9', descriptor: { pinKey: 'opencode' }, carrierAlwaysEnforced: true,
  }));
  assert.equal(v.reason, 'carrier-blocked');
  assert.deepEqual(v.blockedModes, ['carrier']);
});
