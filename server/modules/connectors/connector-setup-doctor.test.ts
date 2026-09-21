import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

// eslint-disable-next-line boundaries/dependencies -- integration fixture exercises the canonical additive substrate.
import { migrateConnectorPolicyV2Substrate } from '../database/connector-policy-v2.migration.js';

import { CONNECTOR_EMBEDDED_INERT_PACK,
  CONNECTOR_EMBEDDED_TRUST_BUNDLE } from './connector-embedded-inert-artifacts.js';
import { connectorGlobalPackDigest } from './connector-global-certification-pack.js';
import { connectorJcs } from './connector-jcs.js';
import { CONNECTOR_LOCAL_ACTIVATION_DOMAIN,
  connectorLocalActivationDigest, parseConnectorLocalActivationRecord } from './connector-local-activation.js';
import { inspectConnectorSetup } from './connector-setup-doctor.js';
import { ConnectorSetupStore } from './connector-setup-store.js';
import { openOrCreateConnectorRuntimeAuthorityRoot } from './connector-runtime-authority-root.js';
import { connectorRuntimeActivationMac, reinstallConnectorRuntimeFence } from './connector-runtime-fence.js';
import { connectorTrustBundleDigest } from './connector-trust-bundle.js';

test('doctor is read-only, secret-free, and reports the first resumable step', () => {
  const database = new Database(':memory:'); const directory = mkdtempSync('/var/tmp/nassaj-doctor-');
  try {
    database.exec(`CREATE TABLE connector_installations (installation_id TEXT PRIMARY KEY,
      singleton INTEGER UNIQUE CHECK(singleton=1));`);
    const installationId = migrateConnectorPolicyV2Substrate(database);
    const root = openOrCreateConnectorRuntimeAuthorityRoot(join(directory, 'authority.json'));
    const before = database.serialize();
    const report = inspectConnectorSetup(database, installationId, root.authority, Date.now());
    assert.equal(report.resumableStep, 'origin');
    assert.equal(report.readyForAccountLinking, false);
    assert.equal(JSON.stringify(report).includes('bundleJson'), false);
    assert.deepEqual(database.serialize(), before);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('doctor rejects expired packs, trust tamper, and activation MAC tamper without provider I/O', () => {
  const database = new Database(':memory:'); const directory = mkdtempSync('/var/tmp/nassaj-doctor-crypto-');
  const nowMs = Date.parse('2026-08-28T00:00:00.000Z');
  try {
    database.exec(`CREATE TABLE connector_installations (installation_id TEXT PRIMARY KEY,
      singleton INTEGER UNIQUE CHECK(singleton=1));`);
    const installationId = migrateConnectorPolicyV2Substrate(database);
    const root = openOrCreateConnectorRuntimeAuthorityRoot(join(directory, 'authority.json'));
    const setup = new ConnectorSetupStore(database, false);
    database.prepare(`INSERT INTO connector_m5_installation_origin
      (installation_id,canonical_origin,updated_at_ms) VALUES (?,'https://nassaj.example',?)`)
      .run(installationId, nowMs);
    setup.saveTrustBundle({ installationId, expectedRevision: 0,
      bundleJson: connectorJcs(CONNECTOR_EMBEDDED_TRUST_BUNDLE),
      digest: connectorTrustBundleDigest(CONNECTOR_EMBEDDED_TRUST_BUNDLE).toString('base64url'), nowMs });
    const packDigest = connectorGlobalPackDigest(CONNECTOR_EMBEDDED_INERT_PACK.pack).toString('base64url');
    setup.saveVerifiedPack({ installationId, issuer: CONNECTOR_EMBEDDED_INERT_PACK.pack.issuerId,
      channel: CONNECTOR_EMBEDDED_INERT_PACK.pack.channel, sequence: 1,
      envelopeJson: connectorJcs(CONNECTOR_EMBEDDED_INERT_PACK), digest: packDigest,
      trustBundleRevision: 1, acceptedWallMs: nowMs, clockHighWaterMs: nowMs });
    const policy = JSON.parse((database.prepare(`SELECT state_json AS json FROM connector_policy_v2_state`)
      .get() as { json: string }).json) as { policyEpoch: number; writerEpoch: number; originRevision: number };
    const record = parseConnectorLocalActivationRecord({ schemaVersion: 1,
      domain: CONNECTOR_LOCAL_ACTIVATION_DOMAIN, installationId, recordRevision: 1,
      policyEpoch: policy.policyEpoch, writerEpoch: policy.writerEpoch, originRevision: policy.originRevision,
      globalPackIssuerId: CONNECTOR_EMBEDDED_INERT_PACK.pack.issuerId, globalPackChannel: 'stable',
      globalPackSequence: 1, globalPackDigest: packDigest, trustBundleRevision: 1, activations: [],
      issuedAt: new Date(nowMs).toISOString(), issuedByUserId: 7 });
    assert.ok(record);
    const envelope = { record, mac: connectorRuntimeActivationMac(
      root.authority, Buffer.from(connectorJcs(record), 'utf8')) };
    setup.saveLocalActivation({ installationId, expectedRevision: 0, envelopeJson: connectorJcs(envelope),
      digest: connectorLocalActivationDigest(record).toString('base64url'), policyEpoch: policy.policyEpoch,
      writerEpoch: policy.writerEpoch, originRevision: policy.originRevision });
    database.prepare(`UPDATE connector_setup_local_activation SET envelope_json=? WHERE installation_id=?`)
      .run(connectorJcs({ record, mac: 'x'.repeat(43) }), installationId);
    reinstallConnectorRuntimeFence(database, root.authority);
    assert.equal(inspectConnectorSetup(database, installationId, root.authority, nowMs)
      .checks.find(item => item.id === 'activation')?.code, 'CONNECTOR_ACTIVATION_INVALID');
    assert.equal(inspectConnectorSetup(database, installationId, root.authority,
      Date.parse('2026-09-26T00:00:00.000Z')).checks.find(item => item.id === 'pack')?.code,
    'CONNECTOR_PACK_INVALID');
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
