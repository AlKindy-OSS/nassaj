import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

import { CONNECTOR_GLOBAL_PACK_DOMAIN, connectorGlobalPackSignedBytes } from './connector-global-certification-pack.js';
import { ConnectorOwnerSetupService } from './connector-owner-setup.service.js';
import { ConnectorRuntimeAuthority } from './connector-runtime-fence.js';
import { CONNECTOR_RUNTIME_MANIFEST } from './connector-runtime-manifest.js';
import { ConnectorSetupStore } from './connector-setup-store.js';
import { connectorJcs } from './connector-jcs.js';
import { connectorTrustBundleDigest, type ConnectorTrustBundle } from './connector-trust-bundle.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

test('signed pack import is local, idempotent, anti-rollback, and stores the exact envelope', () => {
  const database = new Database(':memory:'); const setup = new ConnectorSetupStore(database);
  try {
    database.exec(`CREATE TABLE connector_runtime_control (singleton INTEGER PRIMARY KEY,writer_epoch INTEGER);
      INSERT INTO connector_runtime_control VALUES(1,1);
      CREATE TABLE connector_policy_v2_state (installation_id TEXT PRIMARY KEY,state_json TEXT,kill_revision INTEGER);
      INSERT INTO connector_policy_v2_state VALUES('install-1','{"policyEpoch":1,"writerEpoch":1}',0);`);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const trust: ConnectorTrustBundle = { schemaVersion: 1, revision: 1, distributionIssuerId: 'nassaj-oss',
      roots: [{ issuerId: 'nassaj-oss', keyId: 'root-1', algorithm: 'Ed25519',
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        validFrom: new Date(NOW - 60_000).toISOString(), validUntil: new Date(NOW + 86_400_000).toISOString(),
        source: 'distribution' }], revokedKeyIds: [] };
    setup.saveTrustBundle({ installationId: 'install-1', expectedRevision: 0,
      bundleJson: connectorJcs(trust), digest: connectorTrustBundleDigest(trust).toString('base64url'), nowMs: NOW });
    const pack = { schemaVersion: 1 as const, domain: CONNECTOR_GLOBAL_PACK_DOMAIN,
      issuerId: 'nassaj-oss', channel: 'stable' as const, sequence: 1,
      issuedAt: new Date(NOW - 1_000).toISOString(), expiresAt: new Date(NOW + 86_400_000).toISOString(),
      minimumRuntimeFloor: 1, maximumPolicySchemaVersion: 2, ...CONNECTOR_RUNTIME_MANIFEST,
      certifications: [{ providerId: 'github', serviceId: 'github',
        operation: ConnectorPolicyOperation.CredentialUse, authMethod: 'api_key' as const,
        shapeRevision: 1, shapeDigest: 's'.repeat(43), contractRevision: 1,
        contractDigest: 'd'.repeat(43), status: 'certified' as const }], signingKeyId: 'root-1' };
    const envelope = { pack, signature: sign(null, connectorGlobalPackSignedBytes(pack), privateKey).toString('base64url') };
    const service = new ConnectorOwnerSetupService(database, 'install-1',
      ConnectorRuntimeAuthority.create(Buffer.alloc(32, 3)), setup, {} as never,
      (_advance, effect) => { effect(); return true; }, () => NOW);
    const context = { ownerUserId: 7, idempotencyKey: 'pack-request-1', expectedRevision: 0,
      requestOrigin: 'https://nassaj.example', authTimeMs: NOW - 1, expiresAtMs: NOW + 1_000, nowMs: NOW };
    const first = service.importPack({ envelope }, context);
    assert.deepEqual(service.importPack({ envelope }, context), first);
    assert.equal(setup.readActivePack('install-1')?.envelopeJson, connectorJcs(envelope));
    assert.throws(() => service.importPack({ envelope }, { ...context, idempotencyKey: 'pack-request-2' }),
      /CONNECTOR_SETUP_REVISION_MISMATCH/u);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM connector_global_certification_packs')
      .get().count, 1);
  } finally { database.close(); }
});

test('status surfaces packExpiresAt and warns pack_expiring_soon within 7 days of expiry (T-1527)', () => {
  const build = (expiresAtMs: number): { warnings: readonly string[]; packExpiresAt: string | null } => {
    const database = new Database(':memory:'); const setup = new ConnectorSetupStore(database);
    try {
      database.exec(`CREATE TABLE connector_runtime_control (singleton INTEGER PRIMARY KEY,writer_epoch INTEGER);
        INSERT INTO connector_runtime_control VALUES(1,1);
        CREATE TABLE connector_policy_v2_state (installation_id TEXT PRIMARY KEY,state_json TEXT,kill_revision INTEGER);
        INSERT INTO connector_policy_v2_state VALUES('install-1','{"policyEpoch":1,"writerEpoch":1}',0);`);
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const trust: ConnectorTrustBundle = { schemaVersion: 1, revision: 1, distributionIssuerId: 'nassaj-oss',
        roots: [{ issuerId: 'nassaj-oss', keyId: 'root-1', algorithm: 'Ed25519',
          publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          validFrom: new Date(NOW - 60_000).toISOString(), validUntil: new Date(NOW + 40 * 86_400_000).toISOString(),
          source: 'distribution' }], revokedKeyIds: [] };
      setup.saveTrustBundle({ installationId: 'install-1', expectedRevision: 0, bundleJson: connectorJcs(trust),
        digest: connectorTrustBundleDigest(trust).toString('base64url'), nowMs: NOW });
      const pack = { schemaVersion: 1 as const, domain: CONNECTOR_GLOBAL_PACK_DOMAIN, issuerId: 'nassaj-oss',
        channel: 'stable' as const, sequence: 1, issuedAt: new Date(NOW - 1_000).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(), minimumRuntimeFloor: 1, maximumPolicySchemaVersion: 2,
        ...CONNECTOR_RUNTIME_MANIFEST, certifications: [{ providerId: 'github', serviceId: 'github',
          operation: ConnectorPolicyOperation.CredentialUse, authMethod: 'api_key' as const, shapeRevision: 1,
          shapeDigest: 's'.repeat(43), contractRevision: 1, contractDigest: 'd'.repeat(43),
          status: 'certified' as const }], signingKeyId: 'root-1' };
      const envelope = { pack,
        signature: sign(null, connectorGlobalPackSignedBytes(pack), privateKey).toString('base64url') };
      const service = new ConnectorOwnerSetupService(database, 'install-1',
        ConnectorRuntimeAuthority.create(Buffer.alloc(32, 3)), setup, { read: () => null } as never,
        (_advance, effect) => { effect(); return true; }, () => NOW);
      service.importPack({ envelope }, { ownerUserId: 7, idempotencyKey: 'pack-expiry-1', expectedRevision: 0,
        requestOrigin: 'https://nassaj.example', authTimeMs: NOW - 1, expiresAtMs: NOW + 1_000, nowMs: NOW });
      const status = service.status();
      return { warnings: status.warnings, packExpiresAt: status.packExpiresAt };
    } finally { database.close(); }
  };
  const soon = build(NOW + 3 * 86_400_000);
  assert.deepEqual(soon.warnings, ['pack_expiring_soon']);
  assert.equal(soon.packExpiresAt, new Date(NOW + 3 * 86_400_000).toISOString());
  assert.deepEqual(build(NOW + 20 * 86_400_000).warnings, []);
});
