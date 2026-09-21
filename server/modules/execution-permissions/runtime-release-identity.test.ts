import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRuntimePermissionIdentity } from './runtime-release-identity.js';

test('all-absent environment is explicit unsealed development, never sealed fallback', () => {
  const identity = resolveRuntimePermissionIdentity({});
  assert.equal(identity.authority.source, 'development_unsealed');
  assert.equal(identity.releaseBuild, 'development-unsealed');
  assert.equal(identity.manifestSha256, null);
});

test('complete launcher attestation resolves and partial/tampered input rejects', () => {
  const environment = {
    NASSAJ_PERMISSION_PROFILE: 'full_delegation',
    NASSAJ_PERMISSION_CONTRACT_VERSION: 'permission-parity/v1',
    NASSAJ_PERMISSION_PROFILE_DIGEST: `sha256:${'a'.repeat(64)}`,
    NASSAJ_PERMISSION_CAPABILITY_DIGEST: `sha256:${'b'.repeat(64)}`,
    NASSAJ_PERMISSION_PROTOCOL_GENERATION: '1',
    NASSAJ_PERMISSION_MINIMUM_BUILD: 'c'.repeat(64),
    NASSAJ_PERMISSION_MANIFEST_SHA256: 'd'.repeat(64),
  };
  assert.equal(resolveRuntimePermissionIdentity(environment).authority.source,
    'sealed_release_manifest');
  assert.throws(
    () => resolveRuntimePermissionIdentity({ ...environment, NASSAJ_PERMISSION_PROFILE_DIGEST: undefined }),
    /PERMISSION_RELEASE_IDENTITY_PARTIAL/,
  );
  assert.throws(
    () => resolveRuntimePermissionIdentity({ ...environment, NASSAJ_PERMISSION_PROFILE: 'legacy' }),
    /PERMISSION_RELEASE_IDENTITY_INVALID/,
  );
});
