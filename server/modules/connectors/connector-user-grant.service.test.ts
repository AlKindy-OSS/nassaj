import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import test from 'node:test';

import {
  assertConnectorGrantSubjectIdentity,
  createConnectorGrantDualReader,
  createAuthorizedOAuthGrantMaterialReference,
  consumeAuthorizedConnectorGrantMaterial,
  isAuthorizedConnectorGrantMaterialReference,
  readConnectorGrantMaterialBundle,
  readConnectorGrantMaterialSecret,
  revokeAuthorizedConnectorGrantMaterialReference,
  resolveConnectorGrantFanout,
  connectorGrantDto,
} from './connector-user-grant.service.js';
import { encryptConnectorVaultSecret, indexProviderSubject } from './connector-auth-vault.crypto.js';
import {
  isM2PlacementMaterialReference,
  productionOAuthBundleNeedsRefresh,
  connectorGrantBindingMatches,
  refreshThenRevalidateConnectorGrantBinding,
} from './connector-user-grant.production.js';

const INSTALLATION_ID = '10000000-0000-4000-8000-000000000001';
const PROFILE_ID = '20000000-0000-4000-8000-000000000001';
const GRANT_ID = '30000000-0000-4000-8000-000000000001';
const SECRET_REF = '40000000-0000-4000-8000-000000000001';
const keyring = {
  activeKekVersion: () => 1,
  readKek: () => Buffer.alloc(32, 4),
  activeHmacKeyVersion: () => 1,
  readHmacKey: () => Buffer.alloc(32, 5),
};

test('temporal capability awaits consumption, zeroizes bytes, and rejects replay', async () => {
  const source = Buffer.from('oauth-bundle');
  const reference = createAuthorizedOAuthGrantMaterialReference({
    userId: 7, serviceId: 'google-drive', grantId: GRANT_ID, secretRef: SECRET_REF,
    readBundle: () => Buffer.from(source),
  });
  let observed: Buffer | null = null;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const consuming = consumeAuthorizedConnectorGrantMaterial(reference, async bundle => {
    observed = bundle.fields.get('oauth_token_bundle')!;
    await wait;
    assert.equal(observed.toString(), 'oauth-bundle');
    return 'done';
  });
  await Promise.resolve();
  assert.equal(isAuthorizedConnectorGrantMaterialReference(reference, 7, 'google-drive'), true);
  assert.equal(observed?.toString(), 'oauth-bundle');
  release();
  assert.equal(await consuming, 'done');
  assert.deepEqual(observed, Buffer.alloc('oauth-bundle'.length));
  assert.equal(isAuthorizedConnectorGrantMaterialReference(reference, 7, 'google-drive'), false);
  assert.equal(readConnectorGrantMaterialBundle(reference), null, 'direct reader is gated after consume');
  assert.equal(readConnectorGrantMaterialSecret(reference), null, 'secret reader cannot replay');
  await assert.rejects(
    () => consumeAuthorizedConnectorGrantMaterial(reference, async () => undefined),
    /connector_grant_capability_expired/u,
  );
});

test('explicit capability revocation deletes its reader and blocks direct consumption', () => {
  const reference = createAuthorizedOAuthGrantMaterialReference({
    userId: 7, serviceId: 'google-drive', grantId: GRANT_ID, secretRef: SECRET_REF,
    readBundle: () => Buffer.from('never-readable-after-revoke'),
  });
  revokeAuthorizedConnectorGrantMaterialReference(reference);
  assert.equal(readConnectorGrantMaterialBundle(reference), null);
  assert.equal(isAuthorizedConnectorGrantMaterialReference(reference, 7, 'google-drive'), false);
});

test('new placement rejects legacy and M1 references while accepting exact M2 provenance', () => {
  const base = {
    kind: 'v2' as const, credentialShape: 'single_api_key' as const,
    ownership: 'personal' as const, serviceId: 'github', userId: 7,
    grantId: GRANT_ID, secretRef: SECRET_REF,
  };
  assert.equal(isM2PlacementMaterialReference({ ...base, provenance: 'm1' }), false);
  assert.equal(isM2PlacementMaterialReference({ ...base, provenance: 'm2' }), true);
  assert.equal(isM2PlacementMaterialReference({
    ...base, kind: 'legacy', grantId: null, provenance: 'legacy',
  }), false);
});

test('V2 OAuth consumer refreshes an expiring bundle only when a refresh token exists', () => {
  const now = 1_700_000_000_000;
  assert.equal(productionOAuthBundleNeedsRefresh(Buffer.from(JSON.stringify({
    expiresAt: now + 30_000, refreshToken: 'rotate-once',
  })), now), true);
  assert.equal(productionOAuthBundleNeedsRefresh(Buffer.from(JSON.stringify({
    expiresAt: now + 120_000, refreshToken: 'rotate-later',
  })), now), false);
  assert.equal(productionOAuthBundleNeedsRefresh(Buffer.from(JSON.stringify({
    expiresAt: now - 1, refreshToken: null,
  })), now), false);
});

test('tampered or stale MCP OAuth coordinates fail the exact connector binding gate', () => {
  assert.equal(connectorGrantBindingMatches({ grantId: GRANT_ID }, GRANT_ID), true);
  assert.equal(connectorGrantBindingMatches({
    grantId: '50000000-0000-4000-8000-000000000001',
  }, GRANT_ID), false);
  assert.equal(connectorGrantBindingMatches(null, GRANT_ID), false);
});

test('an OAuth binding switched during refresh fails closed before refreshed material is consumed', async () => {
  let binding: { grantId: string } | null = { grantId: GRANT_ID };
  await assert.rejects(() => refreshThenRevalidateConnectorGrantBinding({
    grantId: GRANT_ID,
    refresh: async () => { binding = { grantId: '50000000-0000-4000-8000-000000000001' }; },
    readBinding: () => binding,
  }), /connector_oauth_binding_mismatch/);
});

const ready = (secret: string) => {
  const subject = Buffer.from('github:default');
  const nonce = Buffer.alloc(12, 9);
  const key = keyring.readKek(1);
  const aad = Buffer.from(
    `nassaj:grant-subject:v1\0${INSTALLATION_ID}\0github\0${PROFILE_ID}\0${GRANT_ID}\0${1}`,
  );
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const providerSubjectCiphertext = Buffer.concat([cipher.update(subject), cipher.final()]);
  const indexed = indexProviderSubject(subject, {
    installationId: INSTALLATION_ID, providerId: 'github', profileId: PROFILE_ID,
  }, keyring);
  return {
    state: 'ready' as const, grantId: GRANT_ID, profileId: PROFILE_ID, providerId: 'github',
    serviceId: 'github', userId: 7, ownership: 'personal' as const, version: 2,
    providerSubjectHmac: indexed.providerSubjectHmac,
    providerSubjectCiphertext, providerSubjectNonce: nonce, providerSubjectTag: cipher.getAuthTag(),
    providerSubjectKekVersion: 1, hmacKeyVersion: 1, secretRef: SECRET_REF,
    envelope: encryptConnectorVaultSecret(Buffer.from(secret), {
    vaultSecretId: SECRET_REF,
    installationId: INSTALLATION_ID,
    providerId: 'github',
    subjectType: 'grant',
    subjectId: GRANT_ID,
    profileId: PROFILE_ID,
    userId: 7,
    fieldPurpose: 'api_key',
    secretRevision: 1,
    }, keyring),
  };
};

test('the real subject verifier accepts bound ciphertext and rejects HMAC or installation tampering', () => {
  const material = ready('synthetic-key');
  assert.doesNotThrow(() => assertConnectorGrantSubjectIdentity(material, INSTALLATION_ID, keyring));
  assert.throws(() => assertConnectorGrantSubjectIdentity({
    ...material, providerSubjectHmac: '00'.repeat(32),
  }, INSTALLATION_ID, keyring), /connector_grant_subject_corrupt/);
  assert.throws(() => assertConnectorGrantSubjectIdentity(material, 'another-installation', keyring));
});

const repositoryMethods = {
  runCredentialWrite: <T>(operation: () => T) => operation(),
  acquireLease: () => null,
  releaseLease: () => false,
  rotateGrantSubjectIndex: () => false,
};

test('grant DTO exposes sanitized three-axis truth without client placement inference', () => {
  const enabledEnv = {
    NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
    NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '1', NASSAJ_CONNECTOR_GRANT_CERT_GITHUB: '1',
    NASSAJ_CONNECTOR_CREDENTIAL_RUNTIME_V2: '1',
    NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_GITHUB: '1',
  };
  const base = {
    grant_id: GRANT_ID, profile_id: PROFILE_ID, provider_id: 'github', service_id: 'github',
    user_id: 7, account_label: 'Work', is_default: 1 as const, status: 'active' as const,
    version: 1, secret_ref: SECRET_REF, secret_revision: 1, bundle_state: 'stored' as const,
    credential_expires_at: '2030-01-01 00:00:00', granted_services: 'github',
    available_bodies: 'claude,codex', pending_bodies: null,
  };
  const cases = [
    ['stored_unverified', 'ineligible', 'stored_only', 'not_verified', false, 'not_verified'],
    ['verified', 'eligible', 'available_next_session', null, true, null],
    ['verified', 'ineligible', 'needs_reconciliation', 'operational_ineligible', false, 'operationally_inactive'],
    ['stale', 'ineligible', 'verification_expired', 'verification_expired', false, 'verification_expired'],
    ['rejected', 'ineligible', 'credential_rejected', 'credential_rejected', false, 'not_verified'],
    ['corrupt', 'ineligible', 'credential_corrupt', 'credential_corrupt', false, 'identity_mismatch'],
  ] as const;
  for (const [verification, operational, availability, reason, eligible, ineligibleReason] of cases) {
    const dto = connectorGrantDto({
      ...base, credential_state: verification, operational_state: operational,
      credential_shape: 'single_api_key',
    }, enabledEnv, ineligibleReason === null
      ? { state: 'ready' }
      : { state: 'ineligible', reason: ineligibleReason });
    assert.equal(dto.availabilityState, availability, verification);
    assert.equal(dto.reasonCode, reason, verification);
    assert.equal(dto.eligible, eligible, verification);
    assert.deepEqual(dto.availableBodies, ['claude', 'codex']);
    assert.equal(dto.canRetryVerification, verification === 'stored_unverified');
    assert.equal(dto.canReconnect, true);
    assert.equal(dto.canRemove, true);
    assert.equal(JSON.stringify(dto).includes('secret_ref'), false);
  }
  const flagsOff = connectorGrantDto({
    ...base, credential_state: 'verified', operational_state: 'eligible',
    credential_shape: 'single_api_key',
  }, {}, { state: 'ineligible', reason: 'policy_disabled' });
  assert.equal(flagsOff.eligible, false);
  assert.equal(flagsOff.availabilityState, 'not_available');
  assert.equal(flagsOff.reasonCode, 'policy_disabled');
  assert.equal(flagsOff.canReconnect, false);
  assert.equal(flagsOff.canRemove, true);
  const grantCertOff = connectorGrantDto({
    ...base, credential_state: 'verified', operational_state: 'eligible',
    credential_shape: 'single_api_key',
  }, { ...enabledEnv, NASSAJ_CONNECTOR_GRANT_CERT_GITHUB: '0' }, { state: 'ready' });
  assert.equal(grantCertOff.canReconnect, false);
});

test('present but corrupt v2 fails closed and never consults legacy', async () => {
  let legacyReads = 0;
  const reader = createConnectorGrantDualReader({
    installationId: INSTALLATION_ID,
    repository: { readActiveGrantMaterial: () => ({ state: 'corrupt' }), ...repositoryMethods },
    keyring,
    legacy: { readCopy: () => { legacyReads += 1; return { secret: Buffer.from('legacy'), provenance: 'file' }; } },
  });
  await assert.rejects(() => reader.resolve(7, 'github'), /v2_corrupt/);
  assert.equal(legacyReads, 0);
});

test('API-key reader passes the connector-bound grantId to the central material gate', async () => {
  let selectedGrant: string | undefined;
  const reader = createConnectorGrantDualReader({
    installationId: INSTALLATION_ID,
    repository: {
      readActiveGrantMaterial: (_installation, _user, _service, grantId) => {
        selectedGrant = grantId;
        return { state: 'absent' };
      },
      ...repositoryMethods,
    },
    keyring,
    env: {
      NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
      NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '1', NASSAJ_CONNECTOR_GRANT_CERT_GITHUB: '1',
      NASSAJ_CONNECTOR_CREDENTIAL_RUNTIME_V2: '1',
      NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_GITHUB: '1',
    },
    legacy: { readCopy: () => null },
  });
  await reader.resolve(7, 'github', GRANT_ID);
  assert.equal(selectedGrant, GRANT_ID);
});

test('present unverified, stale, rejected, or policy-disabled v2 never falls back to legacy', async () => {
  for (const reason of ['not_verified', 'verification_expired', 'policy_disabled']) {
    let legacyReads = 0;
    const reader = createConnectorGrantDualReader({
      installationId: INSTALLATION_ID,
      repository: {
        readActiveGrantMaterial: () => ({ state: 'ineligible' as const, reason }),
        ...repositoryMethods,
      },
      keyring,
      legacy: {
        readCopy: () => {
          legacyReads += 1;
          return { secret: Buffer.from('legacy'), provenance: 'file' };
        },
      },
    });
    await assert.rejects(() => reader.resolve(7, 'github'), /v2_ineligible/);
    assert.equal(legacyReads, 0, reason);
  }
});

test('legacy migration verifies encrypted v2, remains idempotent, and never deletes legacy', async () => {
  let material: ReturnType<typeof ready> | { state: 'absent' } = { state: 'absent' };
  let legacyReads = 0;
  let migrations = 0;
  const reader = createConnectorGrantDualReader({
    installationId: INSTALLATION_ID,
    repository: { readActiveGrantMaterial: () => material, ...repositoryMethods },
    keyring,
    env: {
      NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
      NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '1', NASSAJ_CONNECTOR_GRANT_CERT_GITHUB: '1',
      NASSAJ_CONNECTOR_CREDENTIAL_RUNTIME_V2: '1',
      NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_GITHUB: '1',
    },
    legacy: {
      readCopy: () => {
        legacyReads += 1;
        return { secret: Buffer.from('legacy-secret'), provenance: 'legacy-credential-store:v1' };
      },
    },
    migrateLegacy: async input => {
      migrations += 1;
      assert.equal(input.provenance, 'legacy-credential-store:v1');
      assert.equal(input.fingerprint.length, 64);
      assert.equal(input.secret.toString(), 'legacy-secret');
      material = ready('legacy-secret');
    },
  });

  const first = await reader.resolve(7, 'github');
  const second = await reader.resolve(7, 'github');
  assert.equal(first?.kind, 'v2');
  assert.equal(second?.kind, 'v2');
  assert.equal(migrations, 1);
  assert.equal(legacyReads, 1, 'v2-first makes the second read independent of untouched legacy');
});

test('fan-out reuses one reference for eligible Claude and Codex bodies only', async () => {
  const material = Object.freeze({
    kind: 'v2' as const,
    ownership: 'personal' as const,
    serviceId: 'github',
    userId: 7,
    grantId: GRANT_ID,
    secretRef: SECRET_REF,
    provenance: 'v2',
  });
  const placements = await resolveConnectorGrantFanout({
    userId: 7,
    serviceId: 'github',
    resolve: async () => material,
    bodies: [
      { bodyId: 'claude-1', engine: 'claude', userId: 7, serviceIds: ['github'] },
      { bodyId: 'codex-1', engine: 'codex', userId: 7, serviceIds: ['github'] },
      { bodyId: 'wrong-user', engine: 'claude', userId: 8, serviceIds: ['github'] },
      { bodyId: 'unsupported', engine: 'codex', userId: 7, serviceIds: ['slack'] },
      { bodyId: 'team', engine: 'claude', userId: 7, serviceIds: ['github'], teamShared: true },
    ],
  });
  assert.deepEqual(placements.map(item => item.bodyId), ['claude-1', 'codex-1']);
  assert.equal(placements[0].material, material);
  assert.equal(placements[1].material, material);
  assert.equal(placements.every(item => item.appliesTo === 'next_session'), true);

  await assert.rejects(() => resolveConnectorGrantFanout({
    userId: 7, serviceId: 'github', bodies: [],
    resolve: async () => ({ ...material, userId: 8 }),
  }), /identity_mismatch/);
});
