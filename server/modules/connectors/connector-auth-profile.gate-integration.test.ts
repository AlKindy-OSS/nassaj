import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

/* eslint-disable boundaries/dependencies -- integration test drives the real migration and persistence owners. */
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
import { migrateConnectorPolicyV2Substrate } from '../database/connector-policy-v2.migration.js';
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';
/* eslint-enable boundaries/dependencies */

// eslint-disable-next-line boundaries/no-unknown -- test derives the certified api_key spec.
import { providerAuthSpecFor } from '../../../shared/connector-auth-registry.js';
import { createConnectorProfileManagementService } from './connector-auth-profile-management.js';
import { CONNECTOR_GLOBAL_PACK_DOMAIN, connectorGlobalPackDigest,
  connectorGlobalPackSignedBytes } from './connector-global-certification-pack.js';
import { connectorJcs } from './connector-jcs.js';
import { CONNECTOR_LOCAL_ACTIVATION_DOMAIN, connectorLocalActivationDigest,
  parseConnectorLocalActivationRecord } from './connector-local-activation.js';
import { openOrCreateConnectorRuntimeAuthorityRoot } from './connector-runtime-authority-root.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';
import { CONNECTOR_RUNTIME_MANIFEST } from './connector-runtime-manifest.js';
import { ConnectorSetupStore } from './connector-setup-store.js';
import {
  assertConnectorProviderEffectEnabled,
  executeConnectorPolicyV2LifecycleWrite,
  initializeConnectorPolicyV2SubstrateOnly,
} from './connector-substrate-only.production.js';
import { connectorRuntimeActivationMac } from './connector-runtime-fence.js';
import { connectorTrustBundleDigest, type ConnectorTrustBundle } from './connector-trust-bundle.js';

// B-848 / ADR-138 §ج: the installation-shared api-key route (auth-profile) asserts
// the read-only CredentialVerify gate before any profile row exists, exactly the
// B-845 boot cycle. This test wires the REAL `assertConnectorProviderEffectEnabled`
// (with its real signed pack, trust bundle and local activation) on a clean
// database so the defect — and its ProfileConfigure-parity fix — is proven against
// the exact production gate, not a re-statement of its rule.

const ORIGIN = 'https://nassaj.example';
const keyring = {
  activeKekVersion: () => 1,
  readKek: () => Buffer.alloc(32, 6),
  activeHmacKeyVersion: () => 1,
  readHmacKey: () => Buffer.alloc(32, 7),
};

// Installs a signed pack + trust bundle + local activation that certify and
// enable BOTH operations the shared api-key route asserts (ProfileConfigure,
// then CredentialVerify) for github/github, so only profile readiness gates it.
const installSubstrate = (database: Database.Database, installationId: string,
  authorityPath: string, providerId: string, serviceId: string): void => {
  const nowMs = Date.now();
  const authority = openOrCreateConnectorRuntimeAuthorityRoot(authorityPath).authority;
  const setup = new ConnectorSetupStore(database, false);
  const keys = generateKeyPairSync('ed25519');
  const trust: ConnectorTrustBundle = { schemaVersion: 1, revision: 1, distributionIssuerId: 'test-issuer',
    revokedKeyIds: [], roots: [{ issuerId: 'test-issuer', keyId: 'root-1', algorithm: 'Ed25519',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: new Date(nowMs - 60_000).toISOString(), validUntil: new Date(nowMs + 86_400_000).toISOString(),
      source: 'distribution' }] };
  const certification = (operation: ConnectorPolicyOperation) => ({ providerId, serviceId, operation,
    authMethod: 'api_key' as const, shapeRevision: 1, shapeDigest: 's'.repeat(43), contractRevision: 1,
    contractDigest: 'd'.repeat(43), status: 'certified' as const });
  const pack = { schemaVersion: 1 as const, domain: CONNECTOR_GLOBAL_PACK_DOMAIN,
    issuerId: 'test-issuer', channel: 'stable' as const, sequence: 1,
    issuedAt: new Date(nowMs - 1_000).toISOString(), expiresAt: new Date(nowMs + 86_400_000).toISOString(),
    minimumRuntimeFloor: 1, maximumPolicySchemaVersion: 2, ...CONNECTOR_RUNTIME_MANIFEST,
    certifications: [certification(ConnectorPolicyOperation.ProfileConfigure),
      certification(ConnectorPolicyOperation.CredentialVerify)], signingKeyId: 'root-1' };
  const envelope = { pack, signature: sign(null, connectorGlobalPackSignedBytes(pack),
    keys.privateKey).toString('base64url') };
  const digest = connectorGlobalPackDigest(pack).toString('base64url');
  const state = JSON.parse((database.prepare('SELECT state_json AS json FROM connector_policy_v2_state')
    .get() as { json: string }).json) as { policyEpoch: number; writerEpoch: number; originRevision: number };
  const record = parseConnectorLocalActivationRecord({ schemaVersion: 1,
    domain: CONNECTOR_LOCAL_ACTIVATION_DOMAIN, installationId, recordRevision: 1,
    policyEpoch: state.policyEpoch, writerEpoch: state.writerEpoch, originRevision: state.originRevision,
    globalPackIssuerId: pack.issuerId, globalPackChannel: pack.channel, globalPackSequence: pack.sequence,
    globalPackDigest: digest, trustBundleRevision: 1, issuedAt: new Date(nowMs).toISOString(),
    issuedByUserId: 7, activations: [
      { providerId, serviceId, operation: ConnectorPolicyOperation.ProfileConfigure,
        enabled: true, profileRevision: null },
      { providerId, serviceId, operation: ConnectorPolicyOperation.CredentialVerify,
        enabled: true, profileRevision: null }] });
  assert.ok(record);
  assert.equal(executeConnectorPolicyV2LifecycleWrite(() => {
    setup.saveTrustBundle({ installationId, expectedRevision: 0,
      bundleJson: connectorJcs(trust), digest: connectorTrustBundleDigest(trust).toString('base64url'), nowMs });
    setup.saveVerifiedPack({ installationId, issuer: pack.issuerId, channel: pack.channel,
      sequence: pack.sequence, envelopeJson: connectorJcs(envelope), digest, trustBundleRevision: 1,
      acceptedWallMs: nowMs, clockHighWaterMs: nowMs });
    setup.saveLocalActivation({ installationId, expectedRevision: 0,
      envelopeJson: connectorJcs({ record, mac: connectorRuntimeActivationMac(authority,
        Buffer.from(connectorJcs(record), 'utf8')) }),
      digest: connectorLocalActivationDigest(record).toString('base64url'), policyEpoch: state.policyEpoch,
      writerEpoch: state.writerEpoch, originRevision: state.originRevision });
  }), true);
};

test('B-848: real provider-effect gate denies shared api-key CredentialVerify before'
  + ' materialisation and opens after ProfileConfigure parity on a clean install', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1', NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '1',
    NASSAJ_CONNECTOR_GRANT_CERT_GITHUB: '1',
  });
  const directory = mkdtempSync(join(process.cwd(), '.artifacts', 'nassaj-auth-profile-gate-integration-'));
  const database = new Database(':memory:');
  database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, status TEXT, is_active INTEGER);"
    + " INSERT INTO users VALUES (7,'owner','active',1)");
  migrateConnectorAuthSchema(database);
  const installationId = migrateConnectorPolicyV2Substrate(database);
  const authorityPath = join(directory, 'authority.json');
  try {
    // The substrate runtime the real gate reads must be THIS database.
    assert.equal(initializeConnectorPolicyV2SubstrateOnly(database, authorityPath).ready, true);
    const spec = providerAuthSpecFor('github')!;
    installSubstrate(database, installationId, authorityPath, spec.profileId, 'github');

    const repository = createConnectorAuthDb(database);
    assert.equal(repository.getOrCreateInstallation(), installationId,
      'profile repository and substrate must share the singleton installation');
    const service = createConnectorProfileManagementService({
      installation: { installationId, canonicalOrigin: ORIGIN, callbackUrl: `${ORIGIN}/connectors/oauth/callback` },
      repository, keyring, env: process.env,
      testByoCandidate: async () => undefined, testApiKeyCandidate: async () => undefined,
    });

    // (1) The route USED to assert CredentialVerify first. On a clean install the
    // REAL gate denies it with profile_unready — this is the B-845-style boot
    // cycle the bug alleges, proven against the exact production code.
    assert.equal((database.prepare('SELECT count(*) AS c FROM connector_auth_profiles')
      .get() as { c: number }).c, 0, 'clean install starts with zero profile rows');
    assert.throws(() => assertConnectorProviderEffectEnabled({
      operation: ConnectorPolicyOperation.CredentialVerify,
      providerId: spec.profileId, serviceId: 'github', userId: 7,
    }), /profile_unready/u, 'the real gate denies CredentialVerify before the profile is materialised');

    // (2) The fix runs ProfileConfigure parity first; the real gate must allow it
    // on the same clean install, since it short-circuits profile readiness.
    assert.doesNotThrow(() => assertConnectorProviderEffectEnabled({
      operation: ConnectorPolicyOperation.ProfileConfigure,
      providerId: spec.profileId, serviceId: 'github', userId: 7,
    }));

    // (3) The new materialiser writes the ready row under the installed runtime
    // fence (proving it is correctly wrapped in the synchronous write seam).
    service.ensureApiKeyProfile(spec.profileId);
    const profile = database.prepare(
      'SELECT status, secret_ref FROM connector_auth_profiles WHERE provider_id = ?',
    ).get(spec.profileId) as { status: string; secret_ref: string | null } | undefined;
    assert.equal(profile?.status, 'ready', 'ProfileConfigure parity materialised the ready row');
    assert.equal(profile?.secret_ref, null, 'the materialised row carries no shared secret yet');

    // (4) With a ready row present, the real CredentialVerify gate now opens, so
    // the reordered route reaches the writer instead of 500ing.
    assert.doesNotThrow(() => assertConnectorProviderEffectEnabled({
      operation: ConnectorPolicyOperation.CredentialVerify,
      providerId: spec.profileId, serviceId: 'github', userId: 7,
    }), 'CredentialVerify is eligible once the profile row is ready');

    // (5) Idempotence: a concurrent-style second materialisation converges on the
    // same single row rather than raising or duplicating.
    service.ensureApiKeyProfile(spec.profileId);
    assert.equal((database.prepare('SELECT count(*) AS c FROM connector_auth_profiles')
      .get() as { c: number }).c, 1, 'ensureApiKeyProfile stays idempotent on repeat');
  } finally {
    initializeConnectorPolicyV2SubstrateOnly(database, '/proc/nassaj-connector-runtime-authority.json');
    database.close();
    rmSync(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
