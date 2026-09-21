import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

// eslint-disable-next-line boundaries/dependencies -- integration test exercises the additive grant schema.
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- integration test exercises real grant CAS persistence.
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';
// eslint-disable-next-line boundaries/dependencies -- placement truth is part of the grant list contract.
import { CONNECTORS_TABLE_SCHEMA_SQL, CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL } from '../database/schema.js';
import { providerAuthSpecFor } from '../../../shared/connector-auth-registry.js';

import {
  createConnectorGrantDualReader,
  createConnectorUserGrantService,
} from './connector-user-grant.service.js';
import { connectorCredentialContractFor } from './connector-credential-contracts.js';

const keyring = {
  activeKekVersion: () => 1,
  readKek: () => Buffer.alloc(32, 7),
  activeHmacKeyVersion: () => 1,
  readHmacKey: () => Buffer.alloc(32, 8),
};

const env = {
  NASSAJ_CONNECTOR_GRANTS_V2: '1',
  NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
  NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '1',
  NASSAJ_CONNECTOR_GRANT_CERT_GITHUB: '1',
  NASSAJ_CONNECTOR_CREDENTIAL_RUNTIME_V2: '1',
  NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_GITHUB: '1',
};

const setup = (probe: (apiKey: string) => Promise<string | void> = async () => undefined) => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    INSERT INTO users VALUES (7, 'first'), (8, 'second');
  `);
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  const service = createConnectorUserGrantService({
    installationId, repository, keyring, env,
    testApiKeyCandidate: async ({ apiKey }) => {
      const providerSubject = await probe(apiKey);
      return { providerSubject: providerSubject ?? `provider:${apiKey}`, identityKind: 'user' };
    },
  });
  return { database, repository, installationId, service };
};

test('personal grants are user-isolated and support multiple labels with one default', async () => {
  const { database, repository, installationId, service } = setup();
  try {
    const work = await service.putPersonalApiKey(7, {
      serviceId: 'github', apiKey: 'github-key-work', accountLabel: 'Work',
    });
    const personal = await service.putPersonalApiKey(7, {
      serviceId: 'github', apiKey: 'github-key-personal', accountLabel: 'Personal', isDefault: true,
    });
    assert.equal(repository.bindApiKeyConnectorGrant({
      connectorId: 'github-work-u7', installationId, userId: 7,
      serviceId: 'github', grantId: work.grantId,
    }), true);
    assert.equal(repository.bindApiKeyConnectorGrant({
      connectorId: 'github-personal-u7', installationId, userId: 7,
      serviceId: 'github', grantId: personal.grantId,
    }), true);
    assert.deepEqual(repository.readApiKeyConnectorGrantBinding(
      'github-work-u7', installationId, 7, 'github',
    ), { grantId: work.grantId });
    assert.deepEqual(repository.readApiKeyConnectorGrantBinding(
      'github-personal-u7', installationId, 7, 'github',
    ), { grantId: personal.grantId });
    database.exec(CONNECTORS_TABLE_SCHEMA_SQL);
    database.exec(CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL);
    const insertConnector = database.prepare(
      `INSERT INTO connectors (
         id, service, display_name, account_label, credential_mode,
         owner_user_id, enabled, auth_mode, source_revision
       ) VALUES (?, 'github', 'GitHub', ?, 'per_member', 7, 1, 'key', ?)`,
    );
    insertConnector.run('github-work-u7', 'Work', 2);
    insertConnector.run('github-personal-u7', 'Personal', 2);
    const fingerprint = 'a'.repeat(64);
    database.prepare(
      `INSERT INTO connector_placements (
         connector_id, member_user_id, body_provider, contract_version,
         desired_generation, applied_generation, state,
         desired_fingerprint_version, desired_fingerprint, desired_source_revision,
         desired_present, applied_fingerprint_version, applied_fingerprint
       ) VALUES (?, 7, ?, 'mcp-user-v1', 1, ?, ?, 1, ?, ?, 1, ?, ?)`,
    ).run('github-work-u7', 'claude', 1, 'healthy', fingerprint, 2, 1, fingerprint);
    database.prepare(
      `INSERT INTO connector_placements (
         connector_id, member_user_id, body_provider, contract_version,
         desired_generation, applied_generation, state,
         desired_fingerprint_version, desired_fingerprint, desired_source_revision,
         desired_present
       ) VALUES (?, 7, 'codex', 'mcp-user-v1', 1, 0, 'pending', 1, ?, 4, 1)`,
    ).run('github-work-u7', fingerprint);
    assert.equal(work.isDefault, true);
    assert.equal(personal.isDefault, true);
    const firstUser = service.list(7, 'github');
    assert.equal(firstUser.length, 2);
    assert.deepEqual(firstUser.filter(grant => grant.isDefault).map(grant => grant.accountLabel), ['Personal']);
    assert.deepEqual(service.list(8, 'github'), []);
    const placed = firstUser.find(grant => grant.grantId === work.grantId)!;
    assert.deepEqual(placed.availableBodies, ['claude']);
    assert.deepEqual(placed.pendingBodies, ['codex']);
    assert.equal(placed.availabilityState, 'needs_reconciliation');
    assert.equal(placed.canRetryVerification, false);
    assert.equal(placed.canReconnect, true);
    assert.equal(placed.canRemove, true);
    database.prepare(
      "DELETE FROM connector_placements WHERE connector_id = ? AND body_provider = 'codex'",
    ).run('github-work-u7');
    const singleEligibleBody = service.list(7, 'github')
      .find(grant => grant.grantId === work.grantId)!;
    assert.deepEqual(singleEligibleBody.availableBodies, ['claude']);
    assert.deepEqual(singleEligibleBody.pendingBodies, []);
    assert.equal(singleEligibleBody.availabilityState, 'needs_reconciliation',
      'a missing placement row cannot silently remove a body required by policy');
    database.prepare(
      `INSERT INTO connector_placements (
         connector_id, member_user_id, body_provider, contract_version,
         desired_generation, applied_generation, state,
         desired_fingerprint_version, desired_fingerprint, desired_source_revision,
         desired_present, applied_fingerprint_version, applied_fingerprint
       ) VALUES (?, 7, 'codex', 'mcp-user-v1', 1, 1, 'healthy', 1, ?, 2, 1, 1, ?)`,
    ).run('github-work-u7', fingerprint, fingerprint);
    const allPolicyBodies = service.list(7, 'github')
      .find(grant => grant.grantId === work.grantId)!;
    assert.deepEqual(allPolicyBodies.availableBodies, ['claude', 'codex']);
    assert.equal(allPolicyBodies.availabilityState, 'available_next_session');

    const verifiedBundle = database.prepare(
      `SELECT bundle_id, bundle_revision FROM connector_credential_bundle_revisions
       WHERE grant_id = ? AND bundle_state = 'stored'`,
    ).get(work.grantId) as { bundle_id: string; bundle_revision: number };
    database.prepare(
      `UPDATE connector_credential_verifications SET expires_at = datetime('now', '-1 second')
       WHERE bundle_id = ? AND bundle_revision = ?`,
    ).run(verifiedBundle.bundle_id, verifiedBundle.bundle_revision);
    const expired = service.list(7, 'github').find(grant => grant.grantId === work.grantId)!;
    assert.equal(expired.eligible, false);
    assert.equal(expired.availabilityState, 'verification_expired');
    assert.equal(expired.reasonCode, 'verification_expired');

    const flagsOff = createConnectorUserGrantService({
      installationId, repository, keyring, env: {},
      testApiKeyCandidate: async () => ({ providerSubject: 'unused', identityKind: 'user' }),
    }).list(7, 'github').find(grant => grant.grantId === work.grantId)!;
    assert.equal(flagsOff.eligible, false);
    assert.equal(flagsOff.canReconnect, false);
    assert.equal(flagsOff.canRemove, true, 'removal is independent of creation/runtime flags');
    assert.equal(JSON.stringify(firstUser).includes('github-key'), false);

    const subjectRows = database.prepare(
      `SELECT provider_subject_ciphertext, provider_subject_hmac,
              provider_subject_kek_version, hmac_key_version
       FROM connector_user_grants WHERE user_id = 7`,
    ).all() as Array<{
      provider_subject_ciphertext: Buffer; provider_subject_hmac: string;
      provider_subject_kek_version: number; hmac_key_version: number;
    }>;
    assert.equal(subjectRows.length, 2);
    assert.equal(subjectRows.every(row => row.provider_subject_hmac.length === 64), true);
    assert.equal(subjectRows.every(row => row.provider_subject_kek_version === 1 && row.hmac_key_version === 1), true);
    assert.equal(subjectRows.some(row => row.provider_subject_ciphertext.includes(Buffer.from('github:work'))), false);
    const m2 = database.prepare(
      `SELECT count(*) AS count,
              min(v.verification_state = 'verified') AS all_verified,
              min(o.operational_state = 'eligible') AS all_eligible
       FROM connector_credential_bundle_revisions b
       JOIN connector_credential_verifications v USING (bundle_id, bundle_revision)
       JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
       WHERE b.bundle_state = 'stored'`,
    ).get() as { count: number; all_verified: number; all_eligible: number };
    assert.deepEqual(m2, { count: 2, all_verified: 1, all_eligible: 1 });
  } finally {
    database.close();
  }
});

test('candidate rejection preserves the old active secret and releases the retry lease', async () => {
  let reject = false;
  const { database, service } = setup(async () => {
    if (reject) throw new Error('provider rejected');
    return 'provider:stable-account';
  });
  try {
    await service.putPersonalApiKey(7, {
      serviceId: 'github', apiKey: 'old-key', accountLabel: 'Work',
    });
    const before = database.prepare(
      "SELECT secret_ref, version FROM connector_user_grants WHERE user_id = 7 AND account_label_key = 'work'",
    ).get();
    reject = true;
    await assert.rejects(() => service.putPersonalApiKey(7, {
      serviceId: 'github', apiKey: 'rejected-key', accountLabel: 'work',
    }), /candidate_rejected/);
    const after = database.prepare(
      "SELECT secret_ref, version FROM connector_user_grants WHERE user_id = 7 AND account_label_key = 'work'",
    ).get();
    assert.deepEqual(after, before);
    reject = false;
    await service.putPersonalApiKey(7, {
      serviceId: 'github', apiKey: 'retry-key', accountLabel: 'WORK',
    });
    assert.equal(service.list(7, 'github').length, 1, 'normalized label rotates rather than duplicates');
  } finally {
    database.close();
  }
});

test('all grant writers are off by default and create no profile, grant, or vault row', async () => {
  const { database, repository, installationId } = setup();
  try {
    const disabled = createConnectorUserGrantService({
      installationId, repository, keyring, env: {}, testApiKeyCandidate: async () => ({
        providerSubject: 'provider-user-7', identityKind: 'user',
      }),
    });
    await assert.rejects(() => disabled.putPersonalApiKey(7, {
      serviceId: 'github', apiKey: 'never-written',
    }), /writer_disabled/);
    const pendingProviderOff = createConnectorUserGrantService({
      installationId, repository, keyring,
      env: {
        NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
        NASSAJ_CONNECTOR_GRANT_CERT_SALLA: '1',
      },
      testApiKeyCandidate: async () => ({ providerSubject: 'unused', identityKind: 'user' }),
    });
    await assert.rejects(() => pendingProviderOff.putPersonalApiKey(7, {
      serviceId: 'salla', apiKey: 'never-stored',
    }), /writer_disabled/);
    const counts = database.prepare(
      `SELECT (SELECT count(*) FROM connector_user_grants) AS grants,
              (SELECT count(*) FROM connector_vault_secrets) AS secrets,
              (SELECT count(*) FROM connector_auth_profiles) AS profiles`,
    ).get();
    assert.deepEqual(counts, { grants: 0, secrets: 0, profiles: 0 });
  } finally {
    database.close();
  }
});

test('a first invalid key is probed before creating any profile, grant, lease, or vault secret', async () => {
  const { database, service } = setup(async () => { throw new Error('provider rejected'); });
  try {
    await assert.rejects(() => service.putPersonalApiKey(7, {
      serviceId: 'github', apiKey: 'invalid-first-key', accountLabel: 'First',
    }), /candidate_rejected/u);
    const counts = database.prepare(
      `SELECT (SELECT count(*) FROM connector_user_grants) AS grants,
              (SELECT count(*) FROM connector_vault_secrets) AS secrets,
              (SELECT count(*) FROM connector_auth_profiles) AS profiles,
              (SELECT count(*) FROM connector_auth_leases) AS leases`,
    ).get();
    assert.deepEqual(counts, { grants: 0, secrets: 0, profiles: 0, leases: 0 });
  } finally {
    database.close();
  }
});

test('a pending probe stores an encrypted inert candidate isolated by installation, user, service, and account', async () => {
  const { database, repository, installationId } = setup();
  let probeCalls = 0;
  try {
    const service = createConnectorUserGrantService({
      installationId,
      repository,
      keyring,
      env: {
        NASSAJ_CONNECTOR_GRANTS_V2: '1',
        NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
        NASSAJ_CONNECTOR_AUTH_CERT_SALLA: '1',
        NASSAJ_CONNECTOR_GRANT_CERT_SALLA: '1',
      },
      testApiKeyCandidate: async () => {
        probeCalls += 1;
        return { providerSubject: 'provider-user-7', identityKind: 'user' };
      },
    });
    await assert.rejects(() => service.putPersonalApiKey(7, {
      serviceId: 'salla', apiKey: 'must-not-be-stored', accountLabel: 'Work',
    }), /unverified_opt_in_required/u);
    assert.equal(service.list(7, 'salla').length, 0);
    const stored = await service.putPersonalApiKey(7, {
      serviceId: 'salla', apiKey: 'must-not-leave-process', accountLabel: 'Work',
      acceptStoredUnverified: true,
    });
    assert.equal(stored.status, 'pending');
    assert.equal(stored.credentialStatus, 'stored_unverified');
    assert.ok(stored.credentialExpiresAt);
    assert.equal(probeCalls, 0);
    assert.deepEqual(service.list(8, 'salla'), []);
    assert.deepEqual(service.list(7, 'github'), []);
    assert.equal(service.list(7, 'salla')[0]?.accountLabel, 'Work');
    const rows = database.prepare(
      `SELECT b.bundle_state, v.verification_state, o.operational_state,
              s.ciphertext, s.secret_ref
       FROM connector_credential_bundle_revisions b
       JOIN connector_credential_verifications v USING (bundle_id, bundle_revision)
       JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
       JOIN connector_credential_bundle_fields f USING (bundle_id, bundle_revision)
       JOIN connector_vault_secrets s ON s.secret_ref = f.secret_ref`,
    ).all() as Array<{
      bundle_state: string; verification_state: string; operational_state: string;
      ciphertext: Buffer; secret_ref: string;
    }>;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows.map(({ bundle_state, verification_state, operational_state }) => ({
      bundle_state, verification_state, operational_state,
    })), [{ bundle_state: 'stored', verification_state: 'stored_unverified', operational_state: 'ineligible' }]);
    assert.equal(rows[0]!.ciphertext.includes(Buffer.from('must-not-leave-process')), false);
    for (const [state, availability] of [
      ['rejected', 'credential_rejected'],
      ['unavailable', 'temporarily_unavailable'],
      ['corrupt', 'credential_corrupt'],
    ] as const) {
      database.prepare(
        `UPDATE connector_credential_verifications
         SET verification_state = ?, reason_code = ?
         WHERE bundle_id = (SELECT bundle_id FROM connector_credential_bundle_revisions
           WHERE grant_id = ? AND bundle_state = 'stored')`,
      ).run(state, `test_${state}`, stored.grantId);
      const visible = service.list(7, 'salla').find(grant => grant.grantId === stored.grantId)!;
      assert.equal(visible.verificationState, state);
      assert.equal(visible.availabilityState, availability);
      assert.equal(repository.readActiveGrantMaterial(
        installationId, 7, 'salla', stored.grantId, {
          registryEnabled: true, grantsEnabled: true, runtimeEnabled: true,
          providerCertified: false, providerEnabled: true, serviceEnabled: true,
          expectedCatalogRevision: '2026-08-26.m1',
          expectedShapeRevision: 1, expectedContractRevision: 1,
        },
      ).state, 'ineligible', 'pending material remains current rather than becoming generic corrupt');
    }
    database.prepare(
      `UPDATE connector_credential_verifications
       SET verification_state = 'stored_unverified', reason_code = 'stored_without_provider_probe'
       WHERE bundle_id = (SELECT bundle_id FROM connector_credential_bundle_revisions
         WHERE grant_id = ? AND bundle_state = 'stored')`,
    ).run(stored.grantId);
    const source = repository.readStoredUnverifiedApiKey(installationId, 7, stored.grantId);
    assert.ok(source);
    await service.putPersonalApiKey(7, {
      serviceId: 'salla', apiKey: 'rotated-during-probe', accountLabel: 'Work',
      acceptStoredUnverified: true,
    });
    const staleFence = repository.acquireLease(`grant:${stored.grantId}`, randomUUID(), 60);
    assert.ok(staleFence);
    assert.equal(repository.storedUnverifiedBundleIsCurrent({
      bundleId: source.bundleId, bundleRevision: source.bundleRevision,
      bundleVersion: source.bundleVersion, grantId: stored.grantId, userId: 7,
      fence: staleFence,
    }), false, 'a late probe result cannot promote a rotated source bundle');
    repository.releaseLease(staleFence);
    assert.deepEqual(repository.readActiveGrantMaterial(
      randomUUID(), 7, 'salla', stored.grantId, {
        registryEnabled: true, grantsEnabled: true, runtimeEnabled: true,
        providerCertified: false, providerEnabled: true, serviceEnabled: true,
        expectedCatalogRevision: '2026-08-26.m1',
        expectedShapeRevision: 1, expectedContractRevision: 1,
      },
    ), { state: 'absent' });

    const expiring = await service.putPersonalApiKey(7, {
      serviceId: 'salla', apiKey: 'expires-without-use', accountLabel: 'Personal',
      acceptStoredUnverified: true,
    });
    database.prepare(
      `UPDATE connector_credential_bundle_revisions
       SET expires_at = datetime('now', '-1 second') WHERE grant_id = ?`,
    ).run(expiring.grantId);
    assert.equal(repository.purgeExpiredCredentialCandidates(25), 1);
    assert.equal(service.list(7, 'salla').find(grant => grant.grantId === expiring.grantId)
      ?.credentialStatus, null);

    let legacyReads = 0;
    const reader = createConnectorGrantDualReader({
      installationId, repository, keyring,
      env: {
        NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
        NASSAJ_CONNECTOR_AUTH_CERT_SALLA: '1', NASSAJ_CONNECTOR_GRANT_CERT_SALLA: '1',
        NASSAJ_CONNECTOR_CREDENTIAL_RUNTIME_V2: '1',
        NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_SALLA: '1',
      },
      legacy: { readCopy: () => { legacyReads += 1; return { secret: Buffer.from('legacy'), provenance: 'file' }; } },
    });
    await assert.rejects(() => reader.resolve(7, 'salla', stored.grantId), /v2_ineligible/u);
    assert.equal(legacyReads, 0);

    service.revoke(7, stored.grantId);
    assert.equal((database.prepare('SELECT count(*) AS count FROM connector_credential_bundle_revisions')
      .get() as { count: number }).count, 0);
    assert.equal((database.prepare('SELECT count(*) AS count FROM connector_vault_secrets')
      .get() as { count: number }).count, 0);
  } finally {
    database.close();
  }
});

test('provider certification off blocks migration before callback or any grant write', async () => {
  const { database, repository, installationId } = setup();
  let migrationCalls = 0;
  try {
    const reader = createConnectorGrantDualReader({
      installationId, repository, keyring,
      env: { ...env, NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '0' },
      legacy: { readCopy: () => ({ secret: Buffer.from('legacy'), provenance: 'legacy:v1' }) },
      migrateLegacy: async () => { migrationCalls += 1; },
    });
    await assert.rejects(() => reader.resolve(7, 'github'), /runtime_disabled/);
    assert.equal(migrationCalls, 0);
    assert.equal((database.prepare('SELECT count(*) AS count FROM connector_user_grants').get() as { count: number }).count, 0);
  } finally {
    database.close();
  }
});

test('stored candidate reverifies without re-entry and rejects a late probe after rotation', async () => {
  const { database, repository, installationId } = setup();
  const pendingEnv = {
    NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
    NASSAJ_CONNECTOR_AUTH_CERT_SALLA: '1', NASSAJ_CONNECTOR_GRANT_CERT_SALLA: '1',
  };
  const pending = createConnectorUserGrantService({
    installationId, repository, keyring, env: pendingEnv,
    testApiKeyCandidate: async () => { throw new Error('pending probe'); },
  });
  const spec = providerAuthSpecFor('salla')!;
  const contract = connectorCredentialContractFor('salla')!;
  const certifiedSpec = {
    ...spec,
    serviceProbe: {
      status: 'certified' as const, endpoint: 'https://api.salla.dev/admin/v2/oauth2/user/info',
      method: 'GET' as const, credentialHeader: 'authorization' as const,
      credentialPrefix: 'Bearer ' as const,
    },
  };
  const certifiedContract = {
    ...contract, verification: { ...contract.verification, status: 'certified' as const },
  };
  const makeCertified = (probe: (key: string) => Promise<string>) => createConnectorUserGrantService({
    installationId, repository, keyring, env: pendingEnv,
    providerAuthSpecFor: service => service === 'salla' ? certifiedSpec : providerAuthSpecFor(service),
    credentialContractFor: service => service === 'salla' ? certifiedContract : connectorCredentialContractFor(service),
    testApiKeyCandidate: async ({ apiKey }) => ({
      providerSubject: await probe(apiKey), identityKind: 'user' as const,
    }),
  });
  try {
    const first = await pending.putPersonalApiKey(7, {
      serviceId: 'salla', apiKey: 'stored-first', accountLabel: 'Work', acceptStoredUnverified: true,
    });
    const verified = await makeCertified(async key => {
      assert.equal(key, 'stored-first');
      return 'salla-user-7';
    }).reverifyStoredApiKey(7, first.grantId);
    assert.equal(verified.status, 'active');
    assert.equal(verified.credentialStatus, 'verified');

    const second = await pending.putPersonalApiKey(7, {
      serviceId: 'salla', apiKey: 'stored-second', accountLabel: 'Personal', acceptStoredUnverified: true,
    });
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const late = makeCertified(async () => { await wait; return 'late-user'; })
      .reverifyStoredApiKey(7, second.grantId);
    await Promise.resolve();
    await pending.putPersonalApiKey(7, {
      serviceId: 'salla', apiKey: 'rotated-current', accountLabel: 'Personal', acceptStoredUnverified: true,
    });
    release();
    await assert.rejects(() => late, /unverified_source_stale/u);
    assert.equal(pending.list(7, 'salla').find(item => item.grantId === second.grantId)
      ?.credentialStatus, 'stored_unverified');
    const rejected = await pending.putPersonalApiKey(7, {
      serviceId: 'salla', apiKey: 'provider-rejects', accountLabel: 'Rejected',
      acceptStoredUnverified: true,
    });
    await assert.rejects(() => makeCertified(async () => { throw new Error('rejected'); })
      .reverifyStoredApiKey(7, rejected.grantId), /candidate_rejected/u);
    assert.equal(pending.list(7, 'salla').find(item => item.grantId === rejected.grantId)
      ?.credentialStatus, 'stored_unverified');
  } finally { database.close(); }
});

test('a compound Geidea candidate is stored atomically as two encrypted inert fields', async () => {
  const { database, repository, installationId } = setup();
  try {
    const service = createConnectorUserGrantService({
      installationId, repository, keyring,
      env: {
        NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
        NASSAJ_CONNECTOR_AUTH_CERT_GEIDEA: '1', NASSAJ_CONNECTOR_GRANT_CERT_GEIDEA: '1',
      },
      testApiKeyCandidate: async () => { throw new Error('probe must remain inert'); },
    });
    const stored = await service.putPersonalApiKey(7, {
      serviceId: 'geidea', accountLabel: 'Merchant',
      acceptStoredUnverified: true,
      credentialFields: { merchant_public_key: 'merchant-public', api_password: 'private-password' },
    });
    assert.equal(stored.credentialStatus, 'stored_unverified');
    const facts = database.prepare(
      `SELECT b.credential_shape, v.verification_state, o.operational_state,
              count(f.field_id) AS fields
       FROM connector_credential_bundle_revisions b
       JOIN connector_credential_verifications v USING (bundle_id, bundle_revision)
       JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
       JOIN connector_credential_bundle_fields f USING (bundle_id, bundle_revision)
       WHERE b.grant_id = ? GROUP BY b.bundle_id, b.bundle_revision`,
    ).get(stored.grantId);
    assert.deepEqual(facts, {
      credential_shape: 'geidea_basic', verification_state: 'stored_unverified',
      operational_state: 'ineligible', fields: 2,
    });
    const before = database.prepare(
      `SELECT (SELECT count(*) FROM connector_user_grants) AS grants,
              (SELECT count(*) FROM connector_vault_secrets) AS secrets,
              (SELECT count(*) FROM connector_credential_bundle_revisions) AS bundles`,
    ).get();
    const failingRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === 'createCredentialBundleRevision') {
          return () => { throw new Error('injected bundle failure'); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
      },
    });
    const failing = createConnectorUserGrantService({
      installationId, repository: failingRepository, keyring,
      env: {
        NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
        NASSAJ_CONNECTOR_AUTH_CERT_GEIDEA: '1', NASSAJ_CONNECTOR_GRANT_CERT_GEIDEA: '1',
      },
      testApiKeyCandidate: async () => { throw new Error('probe must remain inert'); },
    });
    await assert.rejects(() => failing.putPersonalApiKey(7, {
      serviceId: 'geidea', accountLabel: 'Second merchant',
      acceptStoredUnverified: true,
      credentialFields: { merchant_public_key: 'second-public', api_password: 'second-password' },
    }), /candidate_rejected/u);
    assert.deepEqual(database.prepare(
      `SELECT (SELECT count(*) FROM connector_user_grants) AS grants,
              (SELECT count(*) FROM connector_vault_secrets) AS secrets,
              (SELECT count(*) FROM connector_credential_bundle_revisions) AS bundles`,
    ).get(), before, 'partial compound failure leaves no grant, envelope, or bundle');
  } finally { database.close(); }
});

test('real legacy migration is verified, CAS-idempotent, and leaves legacy storage untouched', async () => {
  const { database, repository, installationId, service } = setup();
  const legacyStorage = Buffer.from('legacy-secret');
  let legacyReads = 0;
  let migrations = 0;
  try {
    const reader = createConnectorGrantDualReader({
      installationId, repository, keyring, env,
      legacy: { readCopy: () => {
        legacyReads += 1;
        return { secret: Buffer.from(legacyStorage), provenance: 'connector:legacy:revision:2' };
      } },
      migrateLegacy: async input => {
        migrations += 1;
        await service.putPersonalApiKey(input.userId, {
          serviceId: input.serviceId, apiKey: input.secret.toString('utf8'),
          providerSubject: `legacy:${input.fingerprint}`,
          legacyProvenance: input.provenance,
        });
      },
    });
    const first = await reader.resolve(7, 'github');
    const second = await reader.resolve(7, 'github');
    assert.equal(first?.secretRef, second?.secretRef);
    assert.equal(migrations, 1);
    assert.equal(legacyReads, 1);
    assert.equal(legacyStorage.toString('utf8'), 'legacy-secret');
    assert.equal((database.prepare('SELECT count(*) AS count FROM connector_user_grants').get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});

test('M2 subject read keeps the verified old HMAC generation usable until replacement reverify', async () => {
  let activeVersion = 1;
  const rotatingKeyring = {
    activeKekVersion: () => 1,
    readKek: () => Buffer.alloc(32, 7),
    activeHmacKeyVersion: () => activeVersion,
    readHmacKey: (version: number) => Buffer.alloc(32, version === 1 ? 8 : 9),
  };
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users VALUES (7, 'owner')");
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  const service = createConnectorUserGrantService({
    installationId, repository, keyring: rotatingKeyring, env,
    testApiKeyCandidate: async () => ({ providerSubject: 'provider-user-7', identityKind: 'user' }),
  });
  try {
    await service.putPersonalApiKey(7, {
      serviceId: 'github', apiKey: 'secret', providerSubject: 'github-subject',
    });
    activeVersion = 2;
    const reader = createConnectorGrantDualReader({
      installationId, repository, keyring: rotatingKeyring, env,
      legacy: { readCopy: () => null },
    });
    assert.equal((await reader.resolve(7, 'github'))?.kind, 'v2');
    const rotated = database.prepare(
      'SELECT hmac_key_version, version, provider_subject_hmac FROM connector_user_grants',
    ).get() as { hmac_key_version: number; version: number; provider_subject_hmac: string };
    assert.equal(rotated.hmac_key_version, 1);
    assert.equal(rotated.version, 2);
    const hmac = rotated.provider_subject_hmac;
    assert.equal((await reader.resolve(7, 'github'))?.kind, 'v2');
    const repeated = database.prepare(
      'SELECT hmac_key_version, version, provider_subject_hmac FROM connector_user_grants',
    ).get() as typeof rotated;
    assert.deepEqual(repeated, { hmac_key_version: 1, version: 2, provider_subject_hmac: hmac });
  } finally {
    database.close();
  }
});
