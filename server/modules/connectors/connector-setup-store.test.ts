import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

/* eslint-disable boundaries/dependencies -- migration conformance exercises the canonical database owner. */
import {
  CONNECTOR_POLICY_V2_SUBSTRATE_TABLES,
  migrateConnectorPolicyV2Substrate,
} from '../database/connector-policy-v2.migration.js';
/* eslint-enable boundaries/dependencies */

import {
  ConnectorSetupStore,
  effectiveConnectorSetupReadiness,
  type ConnectorSetupPrerequisites,
} from './connector-setup-store.js';

const NOW = 1_787_776_000_000;
const DIGEST = 'a'.repeat(43);
const INSTALLATION = 'installation-1';
const ready: ConnectorSetupPrerequisites = {
  substrateReady: true, authorityRootReady: true, authorityAnchorReady: true, originReady: true,
  trustReady: true, providerPackReady: true, clockReady: true, digestsReady: true,
  profileReady: true, profileRequired: true, activationReady: true, eligibilityReady: true,
  tampered: false,
};

const createBaseInstallationTable = (database: Database.Database): void => {
  database.exec(`CREATE TABLE connector_installations (
    installation_id TEXT PRIMARY KEY,singleton INTEGER UNIQUE CHECK(singleton=1));`);
};

test('effective readiness covers R0-R4 and quarantines every integrity failure', () => {
  assert.equal(effectiveConnectorSetupReadiness({ ...ready, substrateReady: false }), 'none');
  assert.equal(effectiveConnectorSetupReadiness({ ...ready, originReady: false }), 'R0');
  assert.equal(effectiveConnectorSetupReadiness({ ...ready, providerPackReady: false }), 'R1');
  assert.equal(effectiveConnectorSetupReadiness({ ...ready, profileReady: false }), 'R2');
  assert.equal(effectiveConnectorSetupReadiness({ ...ready, activationReady: false }), 'R3');
  assert.equal(effectiveConnectorSetupReadiness(ready), 'R4');
  assert.equal(effectiveConnectorSetupReadiness({ ...ready, tampered: true }), 'quarantine');
  assert.equal(effectiveConnectorSetupReadiness({ ...ready, profileRequired: false, profileReady: false }), 'R4');
});

test('fresh and repeated migrations create the complete additive setup inventory', () => {
  const database = new Database(':memory:');
  try {
    createBaseInstallationTable(database);
    const first = migrateConnectorPolicyV2Substrate(database);
    const second = migrateConnectorPolicyV2Substrate(database);
    assert.equal(first, second);
    const expected = ['connector_setup_trust_bundle', 'connector_setup_certification_sequence',
      'connector_setup_local_activation', 'connector_setup_projection', 'connector_setup_event',
      'connector_setup_owner_wizard', 'connector_setup_owner_idempotency',
      'connector_setup_removal_intent', 'connector_setup_authority_intent',
      'connector_global_certification_packs'];
    for (const table of expected) assert.equal(CONNECTOR_POLICY_V2_SUBSTRATE_TABLES.includes(table), true, table);
    const tableRows = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const actual = new Set(tableRows.map(row => row.name));
    for (const table of expected) assert.equal(actual.has(table), true, table);
  } finally { database.close(); }
});

test('failed migration rolls additive DDL and installation seed back atomically', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`CREATE TABLE connector_installations (
      installation_id TEXT PRIMARY KEY,singleton INTEGER UNIQUE CHECK(singleton=1));
      CREATE TABLE connector_policy_v2_state (
        installation_id TEXT PRIMARY KEY,state_json TEXT NOT NULL,kill_revision INTEGER NOT NULL);
      CREATE TRIGGER reject_setup_seed BEFORE INSERT ON connector_policy_v2_state
      BEGIN SELECT RAISE(ABORT,'reject setup seed'); END;`);
    assert.throws(() => migrateConnectorPolicyV2Substrate(database), /reject setup seed/u);
    assert.deepEqual(database.prepare(`SELECT count(*) AS count FROM connector_installations`).get(), { count: 0 });
    assert.equal(database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table'
      AND name='connector_setup_projection'`).get(), undefined);
  } finally { database.close(); }
});

test('projection CAS is idempotent, concurrent stale writers lose, and events are append-only', () => {
  const database = new Database(':memory:');
  try {
    const store = new ConnectorSetupStore(database);
    const first = store.recomputeProjection({ installationId: INSTALLATION, scopeKey: 'google:gmail',
      prerequisites: ready, expectedProjectionRevision: 0, evidenceDigest: DIGEST,
      invalidReason: null, policyEpoch: 1, writerEpoch: 1, nowMs: NOW });
    assert.equal(first.readiness, 'R4'); assert.equal(first.projectionRevision, 1);
    const replay = store.recomputeProjection({ installationId: INSTALLATION, scopeKey: 'google:gmail',
      prerequisites: ready, expectedProjectionRevision: 1, evidenceDigest: DIGEST,
      invalidReason: null, policyEpoch: 1, writerEpoch: 1, nowMs: NOW + 1 });
    assert.equal(replay.projectionRevision, 1);
    assert.throws(() => store.recomputeProjection({ installationId: INSTALLATION, scopeKey: 'google:gmail',
      prerequisites: { ...ready, profileReady: false }, expectedProjectionRevision: 0,
      evidenceDigest: null, invalidReason: 'profile_lost', policyEpoch: 2, writerEpoch: 2,
      nowMs: NOW + 2 }), /cas_conflict/u);
    const downgraded = store.downgradeForOriginRotation(INSTALLATION, 2, 2, NOW + 3);
    assert.equal(downgraded, 1);
    assert.equal(store.readProjection(INSTALLATION, 'google:gmail')?.readiness, 'R0');
    const events = database.prepare(`SELECT from_readiness AS before,to_readiness AS after
      FROM connector_setup_event ORDER BY created_at_ms`).all();
    assert.deepEqual(events, [{ before: 'none', after: 'R4' }, { before: 'R4', after: 'R0' }]);
    assert.throws(() => database.prepare(`UPDATE connector_setup_event SET to_readiness='R4'`).run(),
      /connector_setup_event_append_only/u);
  } finally { database.close(); }
});

test('trust sequence rejects rollback and wizard/idempotency use exact CAS bindings', () => {
  const database = new Database(':memory:');
  try {
    const store = new ConnectorSetupStore(database);
    assert.equal(store.saveTrustBundle({ installationId: INSTALLATION, expectedRevision: 0,
      bundleJson: '{}', digest: DIGEST, nowMs: NOW }), 1);
    assert.throws(() => store.saveTrustBundle({ installationId: INSTALLATION, expectedRevision: 0,
      bundleJson: '{}', digest: DIGEST, nowMs: NOW }), /cas_conflict/u);
    store.acceptCertificationSequence({ installationId: INSTALLATION, issuer: 'nassaj', channel: 'stable',
      sequence: 4, digest: DIGEST, acceptedWallMs: NOW, clockHighWaterMs: NOW });
    assert.throws(() => store.acceptCertificationSequence({ installationId: INSTALLATION,
      issuer: 'nassaj', channel: 'stable', sequence: 3, digest: DIGEST,
      acceptedWallMs: NOW + 1, clockHighWaterMs: NOW }), /sequence_rollback/u);
    assert.equal(store.saveWizard({ installationId: INSTALLATION, expectedRevision: 0,
      currentStep: 'origin', completedSteps: [], boundOriginRevision: 0, boundTrustRevision: 1,
      boundPackDigest: null, boundProfileRevisions: {}, lastIdempotencyKey: null, nowMs: NOW }), 1);
    assert.throws(() => store.saveWizard({ installationId: INSTALLATION, expectedRevision: 0,
      currentStep: 'trust', completedSteps: ['origin'], boundOriginRevision: 1, boundTrustRevision: 1,
      boundPackDigest: DIGEST, boundProfileRevisions: {}, lastIdempotencyKey: 'request-1', nowMs: NOW + 1 }),
    /wizard_cas_conflict/u);
    const request = { installationId: INSTALLATION, ownerUserId: 7, route: 'setup-origin', key: 'request-1',
      bodySha256: DIGEST, writerEpoch: 1, phase: 'origin', nowMs: NOW, expiresAtMs: NOW + 60_000 };
    assert.equal(store.beginIdempotent(request), 'started');
    assert.equal(store.beginIdempotent(request), 'pending');
    assert.throws(() => store.beginIdempotent({ ...request, bodySha256: 'b'.repeat(43) }), /body_conflict/u);
    store.finishIdempotent({ installationId: INSTALLATION, ownerUserId: 7, route: 'setup-origin',
      key: 'request-1', bodySha256: DIGEST, state: 'committed', responseStatus: 200,
      responseJson: '{"ok":true}' });
    assert.equal(store.beginIdempotent(request), 'committed');
    assert.equal(store.saveLocalActivation({ installationId: INSTALLATION, expectedRevision: 0,
      envelopeJson: '{}', digest: DIGEST, policyEpoch: 1, writerEpoch: 1, originRevision: 1 }), 1);
    assert.throws(() => store.saveLocalActivation({ installationId: INSTALLATION, expectedRevision: 0,
      envelopeJson: '{}', digest: DIGEST, policyEpoch: 1, writerEpoch: 1, originRevision: 1 }),
    /activation_cas_conflict/u);
    const removal = store.createRemovalIntent({ installationId: INSTALLATION, userId: 7,
      ownership: 'personal', providerId: 'google', serviceId: 'gmail', accountId: 'account-1',
      grantId: 'grant-1', consumerBody: 'claude', operation: 'placement.remove', nowMs: NOW });
    store.proveRemoval(removal, '{"removed":true}', NOW + 1);
    assert.deepEqual(database.prepare(`SELECT state,proof_json AS proof FROM connector_setup_removal_intent
      WHERE intent_id=?`).get(removal), { state: 'proved', proof: '{"removed":true}' });
  } finally { database.close(); }
});

test('quarantine is sticky and wizard resume recomputes prerequisite bindings', () => {
  const database = new Database(':memory:');
  try {
    const store = new ConnectorSetupStore(database);
    const quarantined = store.recomputeProjection({ installationId: INSTALLATION, scopeKey: 'global',
      prerequisites: { ...ready, tampered: true }, expectedProjectionRevision: 0,
      evidenceDigest: null, invalidReason: 'root_tampered', policyEpoch: 1, writerEpoch: 1, nowMs: NOW });
    assert.equal(quarantined.readiness, 'quarantine');
    assert.equal(store.recomputeProjection({ installationId: INSTALLATION, scopeKey: 'global',
      prerequisites: ready, expectedProjectionRevision: 1, evidenceDigest: DIGEST,
      invalidReason: null, policyEpoch: 2, writerEpoch: 2, nowMs: NOW + 1 }).readiness, 'quarantine');
    assert.equal(store.recomputeProjection({ installationId: INSTALLATION, scopeKey: 'global',
      prerequisites: ready, expectedProjectionRevision: 2, evidenceDigest: DIGEST,
      invalidReason: null, policyEpoch: 3, writerEpoch: 3, nowMs: NOW + 2,
      allowQuarantineRecovery: true }).readiness, 'R4');
    store.saveWizard({ installationId: INSTALLATION, expectedRevision: 0, currentStep: 'complete',
      completedSteps: ['origin', 'trust', 'provider_pack', 'profiles', 'activation'],
      boundOriginRevision: 1, boundTrustRevision: 1, boundPackDigest: DIGEST,
      boundProfileRevisions: { google: 1 }, lastIdempotencyKey: null, nowMs: NOW });
    const resumed = store.resumeWizard({ installationId: INSTALLATION, expectedRevision: 1,
      originRevision: 2, trustRevision: 1, packDigest: DIGEST,
      profileRevisions: { google: 1 }, nowMs: NOW + 1 });
    assert.deepEqual([resumed?.wizardRevision, resumed?.currentStep, resumed?.completedSteps],
      [2, 'origin', []]);
  } finally { database.close(); }
});
