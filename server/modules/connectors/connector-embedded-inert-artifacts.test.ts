import assert from 'node:assert/strict';
import test from 'node:test';

import { CONNECTOR_EMBEDDED_INERT_PACK, CONNECTOR_EMBEDDED_TRUST_BUNDLE } from './connector-embedded-inert-artifacts.js';
import { verifyConnectorGlobalCertificationPack } from './connector-global-certification-pack.js';
import { CONNECTOR_RUNTIME_PACK_EXPECTATIONS } from './connector-runtime-manifest.js';

test('embedded distribution fixture verifies reproducibly and certifies no operation', () => {
  const result = verifyConnectorGlobalCertificationPack(CONNECTOR_EMBEDDED_INERT_PACK, {
    now: new Date('2026-08-28T00:00:00.000Z'), wallClockHighWaterMs: 0, priorSequence: 0,
    minimumTrustBundleRevision: 1, runtimeFloor: 1, policySchemaVersion: 2,
    trustBundle: CONNECTOR_EMBEDDED_TRUST_BUNDLE, ...CONNECTOR_RUNTIME_PACK_EXPECTATIONS,
  });
  assert.equal(result.verified, true);
  assert.deepEqual(CONNECTOR_EMBEDDED_INERT_PACK.pack.certifications, []);
});
