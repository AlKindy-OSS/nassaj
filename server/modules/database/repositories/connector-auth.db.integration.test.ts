import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateConnectorAuthSchema } from '../connector-auth.migration.js';

import { createConnectorAuthDb } from './connector-auth.db.js';

const openDatabase = (): Database.Database => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL
    );
    INSERT INTO users (id, username) VALUES (7, 'owner');
  `);
  migrateConnectorAuthSchema(database);
  return database;
};

const profileInput = (installationId: string) => ({
  profileId: randomUUID(),
  installationId,
  providerId: 'notion',
  canonicalOrigin: 'https://nassaj.example',
  status: 'pending' as const,
  catalogRevision: '2026-08-26.m1',
  secretRef: null,
  secretRevision: null,
});

const cipher = () => Buffer.from('encrypted-not-plaintext');

const installationSecretInput = (installationId: string) => ({
  secretRef: randomUUID(),
  installationId,
  providerId: 'notion',
  subjectType: 'installation' as const,
  subjectId: installationId,
  profileId: null,
  userId: null,
  fieldPurpose: 'oauth_client',
  secretKind: 'oauth_client',
  ciphertext: cipher(),
  nonce: Buffer.alloc(12, 1),
  authTag: Buffer.alloc(16, 2),
  wrappedDek: Buffer.alloc(32, 3),
  wrappedDekNonce: Buffer.alloc(12, 4),
  wrappedDekTag: Buffer.alloc(16, 5),
  kekVersion: 1,
  aadVersion: 1,
  secretRevision: 1,
});

test('migration is idempotent and creates the complete additive schema', () => {
  const database = openDatabase();
  try {
    assert.doesNotThrow(() => migrateConnectorAuthSchema(database));
    const tables = (database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'connector_%' ORDER BY name`,
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    assert.deepEqual(tables, [
      'connector_api_key_connector_bindings',
      'connector_auth_leases',
      'connector_auth_profile_secret_bindings',
      'connector_auth_profiles',
      'connector_credential_bundle_fields',
      'connector_credential_bundle_revisions',
      'connector_credential_operational_states',
      'connector_credential_verifications',
      'connector_installations',
      'connector_oauth_connector_bindings',
      'connector_oauth_grant_services',
      'connector_oauth_transactions',
      'connector_owner_auth_sessions',
      'connector_owner_operation_nonces',
      'connector_user_grants',
      'connector_vault_secrets',
    ]);
    const grantColumnRows = database.prepare('PRAGMA table_info(connector_user_grants)').all() as Array<{ name: string }>;
    const grantColumns = grantColumnRows.map(({ name }) => name);
    assert.equal(grantColumns.includes('provider_subject'), false);
    assert.ok(grantColumns.includes('provider_subject_hmac'));
    assert.ok(grantColumns.includes('provider_subject_ciphertext'));
    assert.ok(grantColumns.includes('account_label'));
    assert.ok(grantColumns.includes('hmac_key_version'));
  } finally {
    database.close();
  }
});

test('ADR-132 stores independent bundle, verification, and operational facts without PII bodies', () => {
  const database = openDatabase();
  try {
    assert.doesNotThrow(() => migrateConnectorAuthSchema(database));
    for (const table of [
      'connector_credential_bundle_revisions',
      'connector_credential_verifications',
      'connector_credential_operational_states',
    ]) {
      assert.ok(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table));
    }
    const verificationColumns = (database.prepare(
      'PRAGMA table_info(connector_credential_verifications)',
    ).all() as Array<{ name: string }>).map(column => column.name);
    for (const forbidden of [
      'raw_body', 'response_body', 'token', 'email', 'person_name', 'merchant_public_key',
    ]) assert.equal(verificationColumns.includes(forbidden), false, forbidden);
    assert.ok(verificationColumns.includes('evidence_hmac'));
    assert.ok(verificationColumns.includes('identity_hmac'));
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    database.close();
  }
});

test('ADR-132 repository read uses the central gate and rejects unverified material before bytes', () => {
  const database = openDatabase();
  try {
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    const profile = repository.ensureApiKeyGrantProfile({
      profileId: randomUUID(), installationId, providerId: 'github',
      canonicalOrigin: 'https://nassaj.example', catalogRevision: '2026-08-26.m1',
    });
    const grantId = repository.createGrant({
      grantId: randomUUID(), profileId: profile.profileId, userId: 7, serviceId: 'github',
      providerSubjectHmac: 'a'.repeat(64), providerSubjectCiphertext: cipher(),
      providerSubjectNonce: Buffer.alloc(12, 1), providerSubjectTag: Buffer.alloc(16, 2),
      hmacKeyVersion: 1, accountLabel: 'Personal', accountLabelKey: 'personal',
      secretRef: null, secretRevision: null, status: 'pending',
    });
    const secretRef = repository.createVaultSecret({
      ...installationSecretInput(installationId), secretRef: randomUUID(), providerId: 'github',
      subjectType: 'grant', subjectId: grantId, profileId: profile.profileId, userId: 7,
      fieldPurpose: 'api_key', secretKind: 'api_key',
    });
    const bundleId = randomUUID();
    const credentialFence = repository.acquireLease(`credential:${bundleId}:1`, randomUUID(), 60);
    assert.ok(credentialFence);
    assert.equal(repository.createCredentialBundleRevision({
      bundleId, bundleRevision: 1, installationId, userId: 7, providerId: 'github',
      serviceId: 'github', grantId, profileId: profile.profileId,
      credentialShape: 'single_api_key', shapeRevision: 1, secretRevision: 1,
      expiresAt: '2030-01-01 00:00:00',
      fields: [{ fieldId: 'api_key', sensitivity: 'secret', secretRef }],
      evidenceHmac: 'b'.repeat(64), evidenceExpiresAt: '2030-01-01 00:00:00',
      fence: credentialFence,
    }), true);
    assert.equal(repository.storeCredentialBundleRevision({
      bundleId, bundleRevision: 1, expectedVersion: 1, fence: credentialFence,
    }), true);
    const policy = {
      registryEnabled: true, grantsEnabled: true, runtimeEnabled: true,
      providerCertified: true, providerEnabled: true, serviceEnabled: true,
      expectedCatalogRevision: '2026-08-26.m1',
      expectedShapeRevision: 1, expectedContractRevision: 1,
    };
    assert.deepEqual(
      repository.readActiveGrantMaterial(installationId, 7, 'github', undefined, policy),
      { state: 'ineligible', reason: 'grant_inactive' },
    );
    assert.equal(repository.recordCredentialVerification({
      bundleId, bundleRevision: 1, expectedBundleVersion: 3, expectedVerificationVersion: 1,
      installationId, userId: 7,
      providerId: 'github', serviceId: 'github', grantId, secretRevision: 1,
      shapeRevision: 1, contractRevision: 1, state: 'verified', reasonCode: 'identity_match',
      identityKind: 'user', identityHmac: 'c'.repeat(64), evidenceHmac: 'd'.repeat(64),
      expiresAt: '2030-01-01 00:00:00', fence: credentialFence,
    }), false, 'a mismatched provider identity cannot verify');
    assert.equal(repository.recordCredentialVerification({
      bundleId, bundleRevision: 1, expectedBundleVersion: 2, expectedVerificationVersion: 1,
      installationId, userId: 7,
      providerId: 'github', serviceId: 'github', grantId, secretRevision: 1,
      shapeRevision: 1, contractRevision: 1, state: 'verified', reasonCode: 'identity_match',
      identityKind: 'user', identityHmac: 'a'.repeat(64), evidenceHmac: 'd'.repeat(64),
      expiresAt: '2030-01-01 00:00:00', fence: credentialFence,
    }), true);
    assert.equal(repository.recordCredentialVerification({
      bundleId, bundleRevision: 1, expectedBundleVersion: 2, expectedVerificationVersion: 1,
      installationId, userId: 7, providerId: 'github', serviceId: 'github', grantId,
      secretRevision: 1, shapeRevision: 1, contractRevision: 1, state: 'verified',
      reasonCode: 'identity_match', identityKind: 'user', identityHmac: 'a'.repeat(64),
      evidenceHmac: 'd'.repeat(64), expiresAt: '2030-01-01 00:00:00', fence: credentialFence,
    }), true, 'an exact retry is idempotent even with its original verification version');
    assert.equal(repository.recordCredentialVerification({
      bundleId, bundleRevision: 1, expectedBundleVersion: 2, expectedVerificationVersion: 2,
      installationId, userId: 7, providerId: 'github', serviceId: 'github', grantId,
      secretRevision: 1, shapeRevision: 1, contractRevision: 1, state: 'rejected',
      reasonCode: 'late_failure', identityKind: null, identityHmac: null,
      evidenceHmac: 'e'.repeat(64), expiresAt: '2030-01-01 00:00:00', fence: credentialFence,
    }), false, 'a later failure cannot automatically downgrade verified evidence');
    assert.equal(repository.promoteCredentialBundle({
      bundleId, bundleRevision: 1, expectedOperationalVersion: 1,
      grantId, secretRevision: 1, fence: credentialFence,
    }), true);
    assert.equal(
      repository.readActiveGrantMaterial(installationId, 7, 'github', undefined, policy).state,
      'ready',
    );
    const otherGrantId = repository.createGrant({
      grantId: randomUUID(), profileId: profile.profileId, userId: 7, serviceId: 'github',
      providerSubjectHmac: '9'.repeat(64), providerSubjectCiphertext: cipher(),
      providerSubjectNonce: Buffer.alloc(12, 3), providerSubjectTag: Buffer.alloc(16, 4),
      hmacKeyVersion: 1, accountLabel: 'Work', accountLabelKey: 'work',
      secretRef: null, secretRevision: null, status: 'pending',
    });
    const otherSecretRef = repository.createVaultSecret({
      ...installationSecretInput(installationId), secretRef: randomUUID(), providerId: 'github',
      subjectType: 'grant', subjectId: otherGrantId, profileId: profile.profileId, userId: 7,
      fieldPurpose: 'api_key', secretKind: 'api_key',
    });
    const otherFence = repository.acquireLease(`grant:${otherGrantId}`, randomUUID(), 60);
    assert.ok(otherFence);
    assert.equal(repository.activateUserGrant({
      grantId: otherGrantId, expectedVersion: 1, accountLabel: 'Work', accountLabelKey: 'work',
      secretRef: otherSecretRef, secretRevision: 1, isDefault: false, fence: otherFence,
    }), true);
    repository.releaseLease(otherFence);

    const replacementSecretRef = repository.createVaultSecret({
      ...installationSecretInput(installationId), secretRef: randomUUID(), providerId: 'github',
      subjectType: 'grant', subjectId: grantId, profileId: profile.profileId, userId: 7,
      fieldPurpose: 'api_key', secretKind: 'api_key', secretRevision: 2,
    });
    const replacementBundleId = randomUUID();
    const replacementFence = repository.acquireLease(
      `credential:${replacementBundleId}:1`, randomUUID(), 60,
    );
    assert.ok(replacementFence);
    assert.equal(repository.createCredentialBundleRevision({
      bundleId: replacementBundleId, bundleRevision: 1, installationId, userId: 7,
      providerId: 'github', serviceId: 'github', grantId, profileId: profile.profileId,
      credentialShape: 'single_api_key', shapeRevision: 1, secretRevision: 2,
      expiresAt: '2030-01-01 00:00:00',
      fields: [{ fieldId: 'api_key', sensitivity: 'secret', secretRef: replacementSecretRef }],
      evidenceHmac: '6'.repeat(64), evidenceExpiresAt: '2030-01-01 00:00:00',
      fence: replacementFence,
    }), true);
    assert.equal(repository.storeCredentialBundleRevision({
      bundleId: replacementBundleId, bundleRevision: 1, expectedVersion: 1,
      fence: replacementFence,
    }), true);
    assert.equal(repository.recordCredentialVerification({
      bundleId: replacementBundleId, bundleRevision: 1, expectedBundleVersion: 2,
      expectedVerificationVersion: 1, installationId, userId: 7, providerId: 'github',
      serviceId: 'github', grantId, secretRevision: 2, shapeRevision: 1,
      contractRevision: 1, state: 'verified', reasonCode: 'identity_match',
      identityKind: 'user', identityHmac: 'a'.repeat(64), evidenceHmac: '7'.repeat(64),
      expiresAt: '2030-01-01 00:00:00', fence: replacementFence,
    }), true);
    assert.throws(() => repository.promoteCredentialBundle({
      bundleId: replacementBundleId, bundleRevision: 1, expectedOperationalVersion: 1,
      grantId, secretRevision: 2, fence: replacementFence,
      activation: { accountLabel: 'Work', accountLabelKey: 'work', isDefault: false },
    }), /UNIQUE constraint failed/u);
    assert.equal((database.prepare(
      `SELECT operational_state FROM connector_credential_operational_states
       WHERE bundle_id = ? AND bundle_revision = 1`,
    ).get(bundleId) as { operational_state: string }).operational_state, 'eligible');
    assert.equal((database.prepare(
      `SELECT operational_state FROM connector_credential_operational_states
       WHERE bundle_id = ? AND bundle_revision = 1`,
    ).get(replacementBundleId) as { operational_state: string }).operational_state, 'ineligible');
    assert.equal((database.prepare(
      'SELECT secret_ref FROM connector_user_grants WHERE grant_id = ?',
    ).get(grantId) as { secret_ref: string }).secret_ref, secretRef);
    repository.releaseLease(replacementFence);
    const reindexFence = repository.acquireLease(`grant:${grantId}`, randomUUID(), 60);
    assert.ok(reindexFence);
    assert.equal(repository.rotateGrantSubjectIndex({
      grantId, userId: 7, expectedVersion: 2, expectedHmacKeyVersion: 1,
      providerSubjectHmac: 'f'.repeat(64), hmacKeyVersion: 2, fence: reindexFence,
    }), false, 'M2 identity rotation defers until a replacement bundle can be verified');
    repository.releaseLease(reindexFence);
    assert.equal(
      repository.readActiveGrantMaterial(installationId, 7, 'github', undefined, policy).state,
      'ready',
      'safe deferral does not strand a verified M2 bundle in unrecoverable stale state',
    );
    const swappedRef = repository.createVaultSecret({
      ...installationSecretInput(installationId), secretRef: randomUUID(), providerId: 'github',
      subjectType: 'grant', subjectId: grantId, profileId: profile.profileId, userId: 7,
      fieldPurpose: 'api_key', secretKind: 'api_key',
    });
    database.prepare(
      'UPDATE connector_user_grants SET secret_ref = ? WHERE grant_id = ?',
    ).run(swappedRef, grantId);
    assert.deepEqual(
      repository.readActiveGrantMaterial(installationId, 7, 'github', undefined, policy),
      { state: 'corrupt' },
      'post-promotion reads bind to the bundle field and reject a swapped grant pointer',
    );
    database.prepare(
      'UPDATE connector_user_grants SET secret_ref = ? WHERE grant_id = ?',
    ).run(secretRef, grantId);
    const reusedBundle = randomUUID();
    const reusedFence = repository.acquireLease(`credential:${reusedBundle}:1`, randomUUID(), 60);
    assert.ok(reusedFence);
    assert.throws(() => repository.createCredentialBundleRevision({
      bundleId: reusedBundle, bundleRevision: 1, installationId, userId: 7,
      providerId: 'github', serviceId: 'github', grantId, profileId: profile.profileId,
      credentialShape: 'single_api_key', shapeRevision: 1, secretRevision: 1,
      expiresAt: '2030-01-01 00:00:00',
      fields: [{ fieldId: 'api_key', sensitivity: 'secret', secretRef }],
      evidenceHmac: 'b'.repeat(64), evidenceExpiresAt: '2030-01-01 00:00:00',
      fence: reusedFence,
    }), /connector_credential_candidate_reuses_active_secret/u);
    repository.releaseLease(reusedFence);
    assert.deepEqual(
      repository.readActiveGrantMaterial(installationId, 7, 'github', undefined, {
        ...policy, runtimeEnabled: false,
      }),
      { state: 'ineligible', reason: 'policy_disabled' },
    );
    assert.equal(repository.deleteCredentialBundleAndEnvelopeReferences({
      bundleId, bundleRevision: 1, userId: 7, fence: credentialFence,
    }), true, 'envelope-reference deletion remains available without feature flags');
    assert.equal(database.prepare(
      'SELECT 1 FROM connector_vault_secrets WHERE secret_ref = ?',
    ).get(secretRef), undefined, 'live envelope row is deleted; backup retention is separate');
    const expiredBundle = randomUUID();
    const grantIdentity = database.prepare(
      `SELECT g.provider_subject_hmac, p.version AS profile_version, p.catalog_revision
       FROM connector_user_grants g JOIN connector_auth_profiles p ON p.profile_id = g.profile_id
       WHERE g.grant_id = ?`,
    ).get(grantId) as {
      provider_subject_hmac: string; profile_version: number; catalog_revision: string;
    };
    database.prepare(`INSERT INTO connector_credential_bundle_revisions (
      bundle_id, bundle_revision, installation_id, user_id, provider_id, service_id,
      grant_id, profile_id, profile_version, catalog_revision, provider_subject_hmac,
      credential_shape, shape_revision, secret_revision, bundle_state,
      expected_field_count, expires_at
    ) VALUES (?, 1, ?, 7, 'github', 'github', ?, ?, ?, ?, ?,
              'single_api_key', 1, 2, 'candidate', 1, datetime('now', '-1 second'))`).run(
      expiredBundle, installationId, grantId, profile.profileId, grantIdentity.profile_version,
      grantIdentity.catalog_revision, grantIdentity.provider_subject_hmac,
    );
    assert.equal(repository.purgeExpiredCredentialCandidates(25), 1);
    assert.equal(database.prepare(
      'SELECT 1 FROM connector_credential_bundle_revisions WHERE bundle_id = ?',
    ).get(expiredBundle), undefined);
  } finally {
    database.close();
  }
});

test('migration rebuilds the M1.3 owner-operation CHECK without losing rows or foreign keys', () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  const installationId = randomUUID();
  const sessionId = randomUUID();
  const requestId = randomUUID();
  try {
    database.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
      INSERT INTO users (id, username) VALUES (7, 'owner');
      CREATE TABLE connector_installations (
        installation_id TEXT PRIMARY KEY,
        singleton INTEGER NOT NULL DEFAULT 1 UNIQUE
      );
      CREATE TABLE connector_owner_auth_sessions (
        session_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        session_token_hash TEXT NOT NULL UNIQUE,
        csrf_token_hash TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        auth_method TEXT NOT NULL,
        auth_time_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE connector_owner_operation_nonces (
        nonce_hash TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN (
          'upsert_byo', 'register_dcr', 'upsert_shared_api_key', 'disable'
        )),
        expires_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES connector_owner_auth_sessions(session_id),
        FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
    database.prepare(
      'INSERT INTO connector_installations (installation_id, singleton) VALUES (?, 1)',
    ).run(installationId);
    database.prepare(`INSERT INTO connector_owner_auth_sessions (
      session_id, installation_id, session_token_hash, csrf_token_hash, user_id,
      auth_method, auth_time_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, 7, 'password', 1, 10000)`).run(
      sessionId, installationId, 'a'.repeat(64), 'b'.repeat(64),
    );
    database.prepare(`INSERT INTO connector_owner_operation_nonces (
      nonce_hash, request_id, session_id, installation_id, user_id, operation, expires_at_ms
    ) VALUES (?, ?, ?, ?, 7, 'disable', 9000)`).run(
      'c'.repeat(64), requestId, sessionId, installationId,
    );

    migrateConnectorAuthSchema(database);
    const repository = createConnectorAuthDb(database);
    assert.equal((database.prepare(
      'SELECT operation FROM connector_owner_operation_nonces WHERE nonce_hash = ?',
    ).get('c'.repeat(64)) as { operation: string }).operation, 'disable');
    assert.ok(repository.issueOwnerOperation({
      sessionId, requestId: randomUUID(), nonceHash: 'd'.repeat(64), installationId,
      userId: 7, operation: 'upsert_personal_api_key', nowMs: 2, ttlMs: 100,
    }));
    assert.ok(repository.issueOwnerOperation({
      sessionId, requestId: randomUUID(), nonceHash: 'e'.repeat(64), installationId,
      userId: 7, operation: 'oauth_start', nowMs: 2, ttlMs: 100,
    }));
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
    const index = database.prepare(
      "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_connector_owner_operation_expiry'",
    ).get() as { tbl_name: string };
    assert.equal(index.tbl_name, 'connector_owner_operation_nonces');
  } finally {
    database.close();
  }
});

test('migration upgrades the OAuth service mapping to its composite grant identity FK', () => {
  const database = openDatabase();
  try {
    database.exec(`
      DROP TABLE connector_oauth_grant_services;
      CREATE TABLE connector_oauth_grant_services (
        grant_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        service_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (grant_id, service_id),
        UNIQUE (installation_id, user_id, service_id),
        FOREIGN KEY (grant_id) REFERENCES connector_user_grants(grant_id) ON DELETE CASCADE,
        FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    migrateConnectorAuthSchema(database);
    const row = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_oauth_grant_services'",
    ).get() as { sql: string };
    assert.match(row.sql, /FOREIGN KEY\s*\(grant_id,\s*installation_id,\s*user_id\)/u);
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { database.close(); }
});

const issueOwnerNonce = (
  repository: ReturnType<typeof createConnectorAuthDb>,
  installationId: string,
  sessionId: string,
) => {
  const requestId = randomUUID();
  const nonceHash = 'b'.repeat(64);
  const issued = repository.issueOwnerOperation({
    sessionId, requestId, nonceHash, installationId, userId: 7,
    operation: 'disable', nowMs: 1_000_001, ttlMs: 30_000,
  });
  assert.ok(issued);
  return { requestId, nonceHash };
};

const recordOwnerSession = (
  repository: ReturnType<typeof createConnectorAuthDb>,
  installationId: string,
  sessionTokenHash: string,
) => {
  const sessionId = randomUUID();
  repository.recordOwnerAuthSession({
    sessionId, installationId, sessionTokenHash, csrfTokenHash: 'c'.repeat(64),
    userId: 7, authMethod: 'password', authTimeMs: 1_000_000, expiresAtMs: 1_300_000,
  });
  return sessionId;
};

const consumeOwnerNonce = (
  repository: ReturnType<typeof createConnectorAuthDb>,
  installationId: string,
  sessionId: string,
  issued: Readonly<{ requestId: string; nonceHash: string }>,
) => repository.consumeOwnerOperation({
  ...issued, sessionId, installationId, userId: 7, operation: 'disable', nowMs: 1_000_002,
});

test('logout revocation invalidates an already-issued operation nonce', () => {
  const database = openDatabase();
  try {
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    const tokenHash = 'd'.repeat(64);
    const sessionId = recordOwnerSession(repository, installationId, tokenHash);
    const nonce = issueOwnerNonce(repository, installationId, sessionId);
    assert.equal(repository.revokeOwnerAuthSession({
      sessionTokenHash: tokenHash, installationId, userId: 7, nowMs: 1_000_002,
    }), true);
    assert.equal(consumeOwnerNonce(repository, installationId, sessionId, nonce), false);
  } finally {
    database.close();
  }
});

test('login rotation invalidates previously issued nonces from the old session', () => {
  const database = openDatabase();
  try {
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    const sessionId = recordOwnerSession(repository, installationId, 'e'.repeat(64));
    const nonce = issueOwnerNonce(repository, installationId, sessionId);
    assert.equal(repository.revokeOwnerAuthSessions({
      installationId, userId: 7, nowMs: 1_000_002,
    }), 1);
    recordOwnerSession(repository, installationId, 'f'.repeat(64));
    assert.equal(consumeOwnerNonce(repository, installationId, sessionId, nonce), false);
  } finally {
    database.close();
  }
});

test('an active session nonce remains exactly one-shot', () => {
  const database = openDatabase();
  try {
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    const sessionId = recordOwnerSession(repository, installationId, '1'.repeat(64));
    const nonce = issueOwnerNonce(repository, installationId, sessionId);
    assert.equal(consumeOwnerNonce(repository, installationId, sessionId, nonce), true);
    assert.equal(consumeOwnerNonce(repository, installationId, sessionId, nonce), false);
  } finally {
    database.close();
  }
});

test('installation identity is a stable local UUID and profile/grant identities are unique', () => {
  const database = openDatabase();
  try {
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    assert.match(installationId, /^[0-9a-f-]{36}$/u);
    assert.equal(repository.getOrCreateInstallation(), installationId);

    const profile = repository.createProfile(profileInput(installationId));
    assert.equal(profile.version, 1);
    assert.throws(() => repository.createProfile(profileInput(installationId)), /UNIQUE/);
    assert.throws(() => repository.createProfile({
      ...profileInput(installationId), providerId: 'linear', status: 'ready',
    }), /must_start_pending/);

    const grant = {
      grantId: randomUUID(),
      profileId: profile.profileId,
      userId: 7,
      providerSubjectHmac: 'a'.repeat(64),
      providerSubjectCiphertext: cipher(),
      providerSubjectNonce: Buffer.alloc(12, 1),
      providerSubjectTag: Buffer.alloc(16, 2),
      hmacKeyVersion: 1,
      accountLabel: 'Work',
      secretRef: null,
      secretRevision: null,
      status: 'pending' as const,
    };
    assert.equal(repository.createGrant(grant), grant.grantId);
    assert.deepEqual(database.prepare(
      'SELECT grant_id, secret_subject_id FROM connector_user_grants WHERE grant_id = ?',
    ).get(grant.grantId), { grant_id: grant.grantId, secret_subject_id: grant.grantId });
    assert.throws(() => repository.createGrant(grant), /UNIQUE/);
    assert.throws(() => repository.createGrant({
      ...grant, providerSubjectHmac: 'e'.repeat(64), status: 'active',
    }), /must_start_pending/);
  } finally {
    database.close();
  }
});

test('OAuth state is hashed, expires on DB time, and can be consumed exactly once', () => {
  const database = openDatabase();
  try {
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    const profile = repository.createProfile(profileInput(installationId));
    const stateHash = 'b'.repeat(64);
    const transactionId = repository.createOAuthTransaction({
      profileId: profile.profileId,
      userId: 7,
      stateHash,
      secretRef: null,
      secretRevision: null,
      ttlSeconds: 60,
    });
    const transactionFence = repository.acquireLease(`oauth:${transactionId}`, randomUUID(), 60);
    assert.ok(transactionFence);
    const transactionSecretRef = repository.createVaultSecret({
      ...installationSecretInput(installationId),
      subjectType: 'oauth_transaction',
      subjectId: transactionId,
      profileId: profile.profileId,
      userId: 7,
      fieldPurpose: 'pkce_verifier',
      secretKind: 'oauth_transaction',
    });
    assert.equal(repository.finalizeOAuthTransactionSecret({
      transactionId,
      expectedVersion: 1,
      secretRef: transactionSecretRef,
      secretRevision: 1,
      fence: transactionFence,
    }), true);
    assert.equal(repository.consumeOAuthTransaction(stateHash, {
      ...transactionFence,
      ownerToken: randomUUID(),
    }), null, 'a mismatched lease owner cannot perform the final consume write');
    const consumed = repository.consumeOAuthTransaction(stateHash, transactionFence);
    assert.equal(consumed?.transaction_id, transactionId);
    assert.equal(consumed?.secret_ref, transactionSecretRef);
    assert.equal(consumed?.secret_revision, 1);
    assert.equal(repository.consumeOAuthTransaction(stateHash, transactionFence), null);

    const expiredHash = 'c'.repeat(64);
    const expiredId = repository.createOAuthTransaction({
      profileId: profile.profileId,
      userId: 7,
      stateHash: expiredHash,
      secretRef: null,
      secretRevision: null,
      ttlSeconds: 60,
    });
    const expiredFence = repository.acquireLease(`oauth:${expiredId}`, randomUUID(), 60);
    assert.ok(expiredFence);
    database.prepare(
      "UPDATE connector_oauth_transactions SET expires_at = datetime('now', '-1 second') WHERE state_hash = ?",
    ).run(expiredHash);
    assert.equal(repository.consumeOAuthTransaction(expiredHash, expiredFence), null);
  } finally {
    database.close();
  }
});

test('DB-time lease takeover advances fencing and rejects stale or stale-version final writes', () => {
  const database = openDatabase();
  try {
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    const profile = repository.createProfile(profileInput(installationId));
    const leaseKey = `profile:${profile.profileId}`;
    const first = repository.acquireLease(leaseKey, randomUUID(), 60);
    assert.ok(first);
    const dbClockProof = database.prepare(
      'SELECT expires_at > CURRENT_TIMESTAMP AS live FROM connector_auth_leases WHERE lease_key = ?',
    ).get(leaseKey) as { live: number };
    assert.equal(dbClockProof.live, 1);
    assert.equal(repository.acquireLease(leaseKey, randomUUID(), 60), null);

    database.prepare(
      "UPDATE connector_auth_leases SET expires_at = datetime('now', '-1 second') WHERE lease_key = ?",
    ).run(leaseKey);
    const second = repository.acquireLease(leaseKey, randomUUID(), 60);
    assert.ok(second);
    assert.ok(second.fencingToken > first.fencingToken);

    assert.equal(repository.finalizeProfile({
      profileId: profile.profileId,
      expectedVersion: 1,
      status: 'ready',
      catalogRevision: '2026-08-26.m2',
      secretRef: null,
      secretRevision: null,
      fence: first,
    }), null, 'stale fencing token cannot finalize');
    const finalized = repository.finalizeProfile({
      profileId: profile.profileId,
      expectedVersion: 1,
      status: 'ready',
      catalogRevision: '2026-08-26.m2',
      secretRef: null,
      secretRevision: null,
      fence: second,
    });
    assert.equal(finalized?.version, 2);
    assert.equal(repository.finalizeProfile({
      profileId: profile.profileId,
      expectedVersion: 1,
      status: 'disabled',
      catalogRevision: '2026-08-26.m2',
      secretRef: null,
      secretRevision: null,
      fence: second,
    }), null, 'stale row version cannot finalize');
  } finally {
    database.close();
  }
});

test('vault and grant final writes require their exact live fence and CAS version', () => {
  const database = openDatabase();
  try {
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    const allocatedSecretRef = randomUUID();
    const secretRef = repository.createVaultSecret({
      installationId,
      secretRef: allocatedSecretRef,
      providerId: 'notion',
      subjectType: 'installation',
      subjectId: installationId,
      profileId: null,
      userId: null,
      fieldPurpose: 'oauth_client',
      secretKind: 'oauth_client',
      ciphertext: cipher(),
      nonce: Buffer.alloc(12, 1),
      authTag: Buffer.alloc(16, 2),
      wrappedDek: Buffer.alloc(32, 3),
      wrappedDekNonce: Buffer.alloc(12, 4),
      wrappedDekTag: Buffer.alloc(16, 5),
      kekVersion: 1,
      aadVersion: 1,
      secretRevision: 1,
    });
    assert.equal(secretRef, allocatedSecretRef);
    assert.equal((database.prepare(
      'SELECT secret_ref FROM connector_vault_secrets WHERE secret_ref = ?',
    ).get(allocatedSecretRef) as { secret_ref: string }).secret_ref, allocatedSecretRef);
    const vaultFence = repository.acquireLease(`vault:${secretRef}`, randomUUID(), 60);
    assert.ok(vaultFence);
    assert.equal(repository.finalizeVaultSecret({
      secretRef,
      expectedVersion: 1,
      expectedSecretRevision: 1,
      targetSecretRevision: 2,
      ciphertext: Buffer.from('rotated-ciphertext'),
      nonce: Buffer.alloc(12, 6),
      authTag: Buffer.alloc(16, 7),
      wrappedDek: Buffer.alloc(32, 8),
      wrappedDekNonce: Buffer.alloc(12, 9),
      wrappedDekTag: Buffer.alloc(16, 10),
      kekVersion: 2,
      aadVersion: 1,
      fence: vaultFence,
    }), true);

    const profile = repository.createProfile(profileInput(installationId));
    const allocatedGrantId = randomUUID();
    const grantId = repository.createGrant({
      grantId: allocatedGrantId,
      profileId: profile.profileId,
      userId: 7,
      providerSubjectHmac: 'd'.repeat(64),
      providerSubjectCiphertext: cipher(),
      providerSubjectNonce: Buffer.alloc(12, 1),
      providerSubjectTag: Buffer.alloc(16, 2),
      hmacKeyVersion: 1,
      accountLabel: 'Personal',
      secretRef: null,
      secretRevision: null,
      status: 'pending',
    });
    assert.equal(grantId, allocatedGrantId);
    const grantSecretRef = repository.createVaultSecret({
      secretRef: randomUUID(),
      installationId,
      providerId: 'notion',
      subjectType: 'grant',
      subjectId: grantId,
      profileId: profile.profileId,
      userId: 7,
      fieldPurpose: 'access_token',
      secretKind: 'oauth_token',
      ciphertext: cipher(),
      nonce: Buffer.alloc(12, 1),
      authTag: Buffer.alloc(16, 2),
      wrappedDek: Buffer.alloc(32, 3),
      wrappedDekNonce: Buffer.alloc(12, 4),
      wrappedDekTag: Buffer.alloc(16, 5),
      kekVersion: 1,
      aadVersion: 1,
      secretRevision: 1,
    });
    const grantFence = repository.acquireLease(`grant:${grantId}`, randomUUID(), 60);
    assert.ok(grantFence);
    assert.equal(repository.finalizeGrant({
      grantId,
      expectedVersion: 1,
      status: 'active',
      accountLabel: 'Personal',
      secretRef: grantSecretRef,
      secretRevision: 1,
      fence: grantFence,
    }), true);
    assert.equal(repository.finalizeGrant({
      grantId,
      expectedVersion: 1,
      status: 'revoked',
      accountLabel: 'Personal',
      secretRef: grantSecretRef,
      secretRevision: 1,
      fence: grantFence,
    }), false);
  } finally {
    database.close();
  }
});

test('database constraints reject malformed UUIDs, origins, hashes, labels, and AES-GCM material', () => {
  const database = openDatabase();
  try {
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    const profile = repository.createProfile(profileInput(installationId));
    const grantId = repository.createGrant({
      grantId: randomUUID(),
      profileId: profile.profileId,
      userId: 7,
      providerSubjectHmac: '1'.repeat(64),
      providerSubjectCiphertext: cipher(),
      providerSubjectNonce: Buffer.alloc(12),
      providerSubjectTag: Buffer.alloc(16),
      hmacKeyVersion: 1,
      accountLabel: 'Valid',
      secretRef: null,
      secretRevision: null,
      status: 'pending',
    });

    assert.throws(() => database.prepare(
      'INSERT INTO connector_installations (installation_id, singleton) VALUES (?, 1)',
    ).run('not-a-uuid'), /CHECK/);
    assert.throws(() => database.prepare(
      'UPDATE connector_auth_profiles SET canonical_origin = ? WHERE profile_id = ?',
    ).run('https://Example.com/path', profile.profileId), /CHECK/);
    assert.throws(() => database.prepare(
      'UPDATE connector_user_grants SET provider_subject_hmac = ? WHERE grant_id = ?',
    ).run('A'.repeat(64), grantId), /CHECK/);
    assert.throws(() => database.prepare(
      'UPDATE connector_user_grants SET provider_subject_nonce = ? WHERE grant_id = ?',
    ).run(Buffer.alloc(11), grantId), /CHECK/);
    assert.throws(() => database.prepare(
      'UPDATE connector_user_grants SET provider_subject_tag = ? WHERE grant_id = ?',
    ).run(Buffer.alloc(15), grantId), /CHECK/);
    assert.throws(() => database.prepare(
      'UPDATE connector_user_grants SET account_label = ? WHERE grant_id = ?',
    ).run('x'.repeat(129), grantId), /CHECK/);
    assert.throws(() => repository.createVaultSecret({
      ...installationSecretInput(installationId),
      nonce: Buffer.alloc(11),
    }), /CHECK/);
    assert.throws(() => repository.createVaultSecret({
      ...installationSecretInput(installationId),
      wrappedDek: Buffer.alloc(31),
    }), /CHECK/);
  } finally {
    database.close();
  }
});

test('OAuth service mappings cannot cross a grant user identity', () => {
  const database = openDatabase();
  try {
    database.prepare("INSERT INTO users (id, username) VALUES (8, 'other')").run();
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    const profile = repository.createProfile(profileInput(installationId));
    const grantId = repository.createGrant({
      grantId: randomUUID(), profileId: profile.profileId, userId: 7,
      providerSubjectHmac: '9'.repeat(64), providerSubjectCiphertext: cipher(),
      providerSubjectNonce: Buffer.alloc(12), providerSubjectTag: Buffer.alloc(16),
      hmacKeyVersion: 1, accountLabel: 'Bound', secretRef: null, secretRevision: null,
      status: 'pending',
    });
    assert.throws(() => database.prepare(`INSERT INTO connector_oauth_grant_services (
      grant_id, installation_id, user_id, service_id, scopes_json
    ) VALUES (?, ?, 8, 'notion', '["openid"]')`).run(grantId, installationId), /FOREIGN KEY/u);
  } finally { database.close(); }
});

test('AAD-bound composite foreign keys reject cross-subject swaps and revision mismatches', () => {
  const database = openDatabase();
  try {
    const repository = createConnectorAuthDb(database);
    const installationId = repository.getOrCreateInstallation();
    const profile = repository.createProfile(profileInput(installationId));
    const secondProfile = repository.createProfile({
      ...profileInput(installationId),
      providerId: 'linear',
      canonicalOrigin: 'https://second.example',
    });
    const grantInput = (hash: string) => ({
      grantId: randomUUID(),
      profileId: profile.profileId,
      userId: 7,
      providerSubjectHmac: hash,
      providerSubjectCiphertext: cipher(),
      providerSubjectNonce: Buffer.alloc(12),
      providerSubjectTag: Buffer.alloc(16),
      hmacKeyVersion: 1,
      accountLabel: 'Bound account',
      secretRef: null,
      secretRevision: null,
      status: 'pending' as const,
    });
    const firstGrantId = repository.createGrant(grantInput('2'.repeat(64)));
    const secondGrantId = repository.createGrant(grantInput('3'.repeat(64)));
    assert.throws(() => database.prepare(
      'UPDATE connector_user_grants SET grant_id = ? WHERE grant_id = ?',
    ).run(randomUUID(), firstGrantId), /grant_aad_identity_immutable/,
    'grant AAD identity is immutable before any vault secret is attached');
    const allocatedSecretRef = randomUUID();
    const secretRef = repository.createVaultSecret({
      ...installationSecretInput(installationId),
      secretRef: allocatedSecretRef,
      subjectType: 'grant',
      subjectId: firstGrantId,
      profileId: profile.profileId,
      userId: 7,
      fieldPurpose: 'access_token',
      secretKind: 'oauth_token',
    });
    assert.equal(secretRef, allocatedSecretRef);
    assert.deepEqual(database.prepare(
      'SELECT secret_ref, subject_id FROM connector_vault_secrets WHERE secret_ref = ?',
    ).get(secretRef), { secret_ref: allocatedSecretRef, subject_id: firstGrantId });
    assert.throws(() => repository.createVaultSecret({
      ...installationSecretInput(installationId),
      subjectType: 'grant',
      subjectId: randomUUID(),
      profileId: profile.profileId,
      userId: 7,
    }), /vault_subject_mismatch/);
    assert.throws(() => database.prepare(
      'UPDATE connector_vault_secrets SET subject_id = ? WHERE secret_ref = ?',
    ).run(secondGrantId, secretRef), /aad_identity_immutable/);
    const profileSecretRef = repository.createVaultSecret({
      ...installationSecretInput(installationId),
      subjectType: 'profile',
      subjectId: profile.profileId,
      profileId: profile.profileId,
      fieldPurpose: 'client_secret',
    });

    assert.throws(() => database.prepare(
      `UPDATE connector_auth_profiles
       SET secret_ref = ?, secret_revision = 1 WHERE profile_id = ?`,
    ).run(profileSecretRef, secondProfile.profileId), /FOREIGN KEY/);
    assert.throws(() => database.prepare(
      `UPDATE connector_user_grants
       SET secret_ref = ?, secret_revision = 1 WHERE grant_id = ?`,
    ).run(secretRef, secondGrantId), /FOREIGN KEY/);
    assert.throws(() => database.prepare(
      `UPDATE connector_user_grants
       SET secret_ref = ?, secret_revision = 2 WHERE grant_id = ?`,
    ).run(secretRef, firstGrantId), /FOREIGN KEY/);

    const fence = repository.acquireLease(`vault:${secretRef}`, randomUUID(), 60);
    assert.ok(fence);
    assert.throws(() => repository.finalizeVaultSecret({
      secretRef,
      expectedVersion: 1,
      expectedSecretRevision: 1,
      targetSecretRevision: 3,
      ciphertext: cipher(),
      nonce: Buffer.alloc(12),
      authTag: Buffer.alloc(16),
      wrappedDek: Buffer.alloc(32),
      wrappedDekNonce: Buffer.alloc(12),
      wrappedDekTag: Buffer.alloc(16),
      kekVersion: 1,
      aadVersion: 1,
      fence,
    }), /revision_target_invalid/);
  } finally {
    database.close();
  }
});
