/**
 * B-1728: the relay delivers only on CLI versions whose S1 P0 facts were measured
 * (refuse precedence, native wrapper dropped under refuse, isSynthetic delivery,
 * proof-line shape). An explicit set, never a range: any unlisted version fails closed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPeerRunState, isUnverifiedCli, isVerifiedRelayCliVersion, VERIFIED_RELAY_CLI_VERSIONS } from '../peer-run.js';

test('the verified set is exactly the measured versions', () => {
  assert.deepEqual([...VERIFIED_RELAY_CLI_VERSIONS].sort(), ['2.1.306', '2.1.312']);
});

test('2.1.306 and 2.1.312 are verified', () => {
  assert.equal(isVerifiedRelayCliVersion('2.1.306'), true);
  assert.equal(isVerifiedRelayCliVersion('2.1.312'), true);
});

test('any unlisted version fails closed (no range, no prefix, no padding)', () => {
  for (const version of ['2.1.304', '2.1.307', '2.1.311', '2.1.313', '2.2.0', '2.1.312 ', ' 2.1.312', '2.1.3120',
    'v2.1.312', '2.1.312-beta', '', null, undefined, 2.1]) {
    assert.equal(isVerifiedRelayCliVersion(version), false, String(version));
  }
});

test('a run on an unlisted CLI is unverified; on 2.1.312 it is not', () => {
  const run = createPeerRunState({ activeMemberCount: 2, userId: 1, sessionId: 's', permissionMode: 'default' });
  run.cliVersion = '2.1.313';
  assert.equal(isUnverifiedCli(run), true);
  run.cliVersion = '2.1.312';
  assert.equal(isUnverifiedCli(run), false);
});
