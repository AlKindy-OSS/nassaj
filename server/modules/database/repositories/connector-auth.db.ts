import { randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
/* eslint-disable boundaries/dependencies -- ADR-132's single gate and closed vocabulary are persistence invariants. */
import {
  evaluateConnectorCredentialEligibility,
  evaluateConnectorRuntimePolicy,
  type ConnectorCredentialRuntimePolicy,
} from '@/modules/connectors/connector-credential-eligibility.js';
import { connectorCredentialContractFor } from '@/modules/connectors/connector-credential-contracts.js';
/* eslint-enable boundaries/dependencies */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;

export type ConnectorAuthLease = Readonly<{
  leaseKey: string;
  ownerToken: string;
  fencingToken: number;
  expiresAt: string;
}>;

export type ConnectorOwnerOperation = 'upsert_byo' | 'register_dcr' | 'upsert_shared_api_key'
  | 'disable' | 'upsert_personal_api_key' | 'revoke_personal_grant'
  | 'oauth_start' | 'oauth_refresh' | 'oauth_revoke';

export type ConnectorAuthProfile = Readonly<{
  profileId: string;
  installationId: string;
  providerId: string;
  canonicalOrigin: string;
  status: 'pending' | 'ready' | 'disabled' | 'error';
  catalogRevision: string;
  secretRef: string | null;
  secretRevision: number | null;
  secretRefs: Readonly<Record<string, string>>;
  version: number;
}>;

type ProfileRow = {
  profile_id: string;
  installation_id: string;
  provider_id: string;
  canonical_origin: string;
  status: ConnectorAuthProfile['status'];
  catalog_revision: string;
  secret_ref: string | null;
  secret_revision: number | null;
  version: number;
};

const profileFromRow = (row: ProfileRow, secretRefs: Readonly<Record<string, string>> = {}): ConnectorAuthProfile => ({
  profileId: row.profile_id,
  installationId: row.installation_id,
  providerId: row.provider_id,
  canonicalOrigin: row.canonical_origin,
  status: row.status,
  catalogRevision: row.catalog_revision,
  secretRef: row.secret_ref,
  secretRevision: row.secret_revision,
  secretRefs,
  version: row.version,
});

const assertUuid = (value: string): void => {
  if (!UUID_PATTERN.test(value)) throw new Error('connector_auth_uuid_invalid');
};

const assertId = (value: string): void => {
  if (!ID_PATTERN.test(value)) throw new Error('connector_auth_id_invalid');
};

const assertHash = (value: string): void => {
  if (!HEX_64_PATTERN.test(value)) throw new Error('connector_auth_hash_invalid');
};

const assertBlob = (value: Buffer): void => {
  if (!Buffer.isBuffer(value) || value.length === 0) throw new Error('connector_auth_cipher_material_invalid');
};

const assertOrigin = (value: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('connector_auth_origin_invalid');
  }
  if (parsed.origin !== value || parsed.protocol !== 'https:' || parsed.pathname !== '/') {
    throw new Error('connector_auth_origin_invalid');
  }
};

const assertVersion = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('connector_auth_version_invalid');
};

const assertFence = (fence: ConnectorAuthLease, expectedKey: string): void => {
  if (fence.leaseKey !== expectedKey || !UUID_PATTERN.test(fence.ownerToken)) {
    throw new Error('connector_auth_fence_invalid');
  }
  assertVersion(fence.fencingToken);
};

/** Repository factory for ADR-132 persistence contracts; it performs no provider or crypto I/O. */
export function createConnectorAuthDb(database: Database = getConnection()) {
  const getOrCreateInstallationTransaction = database.transaction((): string => {
    const existing = database.prepare(
      'SELECT installation_id FROM connector_installations WHERE singleton = 1',
    ).get() as { installation_id: string } | undefined;
    if (existing) return existing.installation_id;
    const installationId = randomUUID();
    database.prepare(
      'INSERT INTO connector_installations (installation_id, singleton) VALUES (?, 1)',
    ).run(installationId);
    return installationId;
  });

  const acquireLeaseTransaction = database.transaction((
    leaseKey: string,
    ownerToken: string,
    ttlSeconds: number,
  ): ConnectorAuthLease | null => {
    const changed = database.prepare(
      `INSERT INTO connector_auth_leases (
         lease_key, owner_token, fencing_token, expires_at, version
       ) VALUES (?, ?, 1, datetime('now', '+' || ? || ' seconds'), 1)
       ON CONFLICT(lease_key) DO UPDATE SET
         owner_token = excluded.owner_token,
         fencing_token = connector_auth_leases.fencing_token + 1,
         expires_at = excluded.expires_at,
         version = connector_auth_leases.version + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE connector_auth_leases.expires_at <= CURRENT_TIMESTAMP
          OR connector_auth_leases.owner_token = excluded.owner_token`,
    ).run(leaseKey, ownerToken, ttlSeconds);
    if (changed.changes !== 1) return null;
    const row = database.prepare(
      `SELECT lease_key, owner_token, fencing_token, expires_at
       FROM connector_auth_leases WHERE lease_key = ? AND owner_token = ?`,
    ).get(leaseKey, ownerToken) as {
      lease_key: string;
      owner_token: string;
      fencing_token: number;
      expires_at: string;
    } | undefined;
    return row ? {
      leaseKey: row.lease_key,
      ownerToken: row.owner_token,
      fencingToken: row.fencing_token,
      expiresAt: row.expires_at,
    } : null;
  });

  const readProfile = (profileId: string): ConnectorAuthProfile | null => {
    const row = database.prepare(
      `SELECT profile_id, installation_id, provider_id, canonical_origin,
              status, catalog_revision, secret_ref, secret_revision, version
       FROM connector_auth_profiles WHERE profile_id = ?`,
    ).get(profileId) as ProfileRow | undefined;
    if (!row) return null;
    const bindings = database.prepare(
      `SELECT field_purpose, secret_ref FROM connector_auth_profile_secret_bindings
       WHERE profile_id = ? AND status = 'active' ORDER BY field_purpose`,
    ).all(profileId) as Array<{ field_purpose: string; secret_ref: string }>;
    return profileFromRow(row, Object.fromEntries(
      bindings.map(binding => [binding.field_purpose, binding.secret_ref]),
    ));
  };

  const listProfiles = (installationId: string): ConnectorAuthProfile[] => {
    assertUuid(installationId);
    const rows = database.prepare(
      `SELECT profile_id, installation_id, provider_id, canonical_origin,
              status, catalog_revision, secret_ref, secret_revision, version
       FROM connector_auth_profiles WHERE installation_id = ? ORDER BY provider_id`,
    ).all(installationId) as ProfileRow[];
    return rows.map(row => readProfile(row.profile_id)!);
  };

  const assertVaultSubject = (input: Readonly<{
    installationId: string;
    providerId: string;
    subjectType: 'installation' | 'profile' | 'grant' | 'oauth_transaction';
    subjectId: string;
    profileId: string | null;
    userId: number | null;
  }>): void => {
    if (input.subjectType === 'installation') {
      if (input.subjectId !== input.installationId || input.profileId !== null || input.userId !== null) {
        throw new Error('connector_auth_vault_subject_mismatch');
      }
      return;
    }
    const table = input.subjectType === 'grant'
      ? 'connector_user_grants'
      : input.subjectType === 'oauth_transaction'
        ? 'connector_oauth_transactions'
        : 'connector_auth_profiles';
    const idColumn = input.subjectType === 'grant'
      ? 'grant_id'
      : input.subjectType === 'oauth_transaction'
        ? 'transaction_id'
        : 'profile_id';
    const userClause = input.subjectType === 'profile' ? 'AND ? IS NULL' : 'AND user_id = ?';
    const found = database.prepare(
      `SELECT 1 FROM ${table}
       WHERE ${idColumn} = ? AND installation_id = ? AND provider_id = ?
         AND profile_id = ? ${userClause}`,
    ).get(
      input.subjectId, input.installationId, input.providerId, input.profileId, input.userId,
    );
    if (!found) throw new Error('connector_auth_vault_subject_mismatch');
  };

  const leaseIsCurrent = (fence: ConnectorAuthLease): boolean => Boolean(database.prepare(
    `SELECT 1 FROM connector_auth_leases
     WHERE lease_key = ? AND owner_token = ? AND fencing_token = ?
       AND expires_at > CURRENT_TIMESTAMP`,
  ).get(fence.leaseKey, fence.ownerToken, fence.fencingToken));

  const findProfile = (installationId: string, providerId: string): ConnectorAuthProfile | null => {
    assertUuid(installationId);
    assertId(providerId);
    const found = database.prepare(
      `SELECT profile_id FROM connector_auth_profiles
       WHERE installation_id = ? AND provider_id = ?`,
    ).get(installationId, providerId) as { profile_id: string } | undefined;
    return found ? readProfile(found.profile_id) : null;
  };

  const stageProfileSecretTransaction = database.transaction((input: Readonly<{
    secretRef: string;
    installationId: string;
    providerId: string;
    profileId: string;
    fieldPurpose: string;
    secretKind: string;
    envelope: Readonly<{
      ciphertext: Buffer; nonce: Buffer; authTag: Buffer; wrappedDek: Buffer;
      wrappedDekNonce: Buffer; wrappedDekTag: Buffer; kekVersion: number;
      aadVersion: number; secretRevision: number;
    }>;
    fence: ConnectorAuthLease;
  }>): boolean => {
    if (!leaseIsCurrent(input.fence)) return false;
    const profile = readProfile(input.profileId);
    if (!profile || profile.installationId !== input.installationId || profile.providerId !== input.providerId) {
      throw new Error('connector_auth_vault_subject_mismatch');
    }
    const envelope = input.envelope;
    database.prepare(
      `INSERT INTO connector_vault_secrets (
         secret_ref, installation_id, provider_id, subject_type, subject_id,
         profile_id, user_id, field_purpose, secret_kind, ciphertext, nonce, auth_tag,
         wrapped_dek, wrapped_dek_nonce, wrapped_dek_tag, kek_version, aad_version,
         secret_revision
       ) VALUES (?, ?, ?, 'profile', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.secretRef, input.installationId, input.providerId, input.profileId,
      input.profileId, input.fieldPurpose, input.secretKind, envelope.ciphertext,
      envelope.nonce, envelope.authTag, envelope.wrappedDek, envelope.wrappedDekNonce,
      envelope.wrappedDekTag, envelope.kekVersion, envelope.aadVersion,
      envelope.secretRevision,
    );
    database.prepare(
      `INSERT INTO connector_auth_profile_secret_bindings (
         profile_id, installation_id, provider_id, field_purpose, secret_ref,
         secret_revision, status, secret_subject_type, secret_subject_id
       ) VALUES (?, ?, ?, ?, ?, ?, 'candidate', 'profile', ?)`,
    ).run(
      input.profileId, input.installationId, input.providerId, input.fieldPurpose,
      input.secretRef, envelope.secretRevision, input.profileId,
    );
    return true;
  });

  const activateProfileTransaction = database.transaction((input: Readonly<{
    profileId: string;
    expectedVersion: number;
    catalogRevision: string;
    secretRefs: Readonly<Record<string, string>>;
    fence: ConnectorAuthLease;
  }>): boolean => {
    if (!leaseIsCurrent(input.fence)) return false;
    const entries = Object.entries(input.secretRefs);
    if (entries.length === 0) throw new Error('connector_auth_binding_set_empty');
    const profile = readProfile(input.profileId);
    if (!profile || profile.version !== input.expectedVersion) return false;
    for (const [purpose, secretRef] of entries) {
      assertId(purpose);
      assertUuid(secretRef);
      const candidate = database.prepare(
        `SELECT 1 FROM connector_auth_profile_secret_bindings
         WHERE profile_id = ? AND field_purpose = ? AND secret_ref = ? AND status = 'candidate'`,
      ).get(input.profileId, purpose, secretRef);
      if (!candidate) throw new Error('connector_auth_binding_candidate_invalid');
    }
    database.prepare(
      `UPDATE connector_auth_profile_secret_bindings SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
       WHERE profile_id = ? AND status = 'active'`,
    ).run(input.profileId);
    for (const [purpose, secretRef] of entries) {
      const changed = database.prepare(
        `UPDATE connector_auth_profile_secret_bindings SET status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE profile_id = ? AND field_purpose = ? AND secret_ref = ? AND status = 'candidate'`,
      ).run(input.profileId, purpose, secretRef);
      if (changed.changes !== 1) throw new Error('connector_auth_binding_candidate_invalid');
    }
    const changed = database.prepare(
      `UPDATE connector_auth_profiles
       SET status = 'ready', catalog_revision = ?, version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE profile_id = ? AND version = ?`,
    ).run(input.catalogRevision, input.profileId, input.expectedVersion);
    if (changed.changes !== 1) throw new Error('connector_auth_profile_cas_stale');
    return true;
  });

  const issueOwnerOperationTransaction = database.transaction((input: Readonly<{
    sessionId: string;
    requestId: string;
    nonceHash: string;
    installationId: string;
    userId: number;
    operation: ConnectorOwnerOperation;
    nowMs: number;
    ttlMs: number;
  }>) => {
    const session = database.prepare(
      `SELECT session_id, auth_time_ms, expires_at_ms FROM connector_owner_auth_sessions
       WHERE session_id = ? AND installation_id = ? AND user_id = ?
         AND revoked_at_ms IS NULL AND expires_at_ms > ?`,
    ).get(input.sessionId, input.installationId, input.userId, input.nowMs) as {
      session_id: string; auth_time_ms: number; expires_at_ms: number;
    } | undefined;
    if (!session) return null;
    const expiresAt = Math.min(session.expires_at_ms, input.nowMs + input.ttlMs);
    database.prepare(
      `INSERT INTO connector_owner_operation_nonces (
         nonce_hash, request_id, session_id, installation_id, user_id, operation, expires_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.nonceHash, input.requestId, session.session_id, input.installationId,
      input.userId, input.operation, expiresAt,
    );
    return {
      sessionId: session.session_id,
      authTime: session.auth_time_ms,
      expiresAt,
    };
  });

  const activateUserGrantTransaction = database.transaction((input: Readonly<{
    grantId: string; expectedVersion: number; accountLabel: string; accountLabelKey: string;
    secretRef: string; secretRevision: number; isDefault: boolean; fence: ConnectorAuthLease;
  }>): boolean => {
    if (!leaseIsCurrent(input.fence)) return false;
    const grant = database.prepare(
      `SELECT installation_id, user_id, service_id, version FROM connector_user_grants
       WHERE grant_id = ?`,
    ).get(input.grantId) as {
      installation_id: string; user_id: number; service_id: string; version: number;
    } | undefined;
    if (!grant || grant.version !== input.expectedVersion) return false;
    const secret = database.prepare(
      `SELECT 1 FROM connector_vault_secrets WHERE secret_ref = ? AND subject_type = 'grant'
       AND subject_id = ? AND installation_id = ? AND user_id = ?
       AND secret_revision = ?`,
    ).get(
      input.secretRef, input.grantId, grant.installation_id, grant.user_id, input.secretRevision,
    );
    if (!secret) throw new Error('connector_auth_grant_secret_invalid');
    if (input.isDefault) {
      database.prepare(
        `UPDATE connector_user_grants SET is_default = 0, updated_at = CURRENT_TIMESTAMP
         WHERE installation_id = ? AND user_id = ? AND service_id = ?
           AND grant_id != ? AND status = 'active' AND is_default = 1`,
      ).run(grant.installation_id, grant.user_id, grant.service_id, input.grantId);
    }
    return database.prepare(
      `UPDATE connector_user_grants
       SET status = 'active', account_label = ?, account_label_key = ?,
           secret_ref = ?, secret_revision = ?, is_default = ?,
           version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE grant_id = ? AND version = ?`,
    ).run(
      input.accountLabel, input.accountLabelKey, input.secretRef, input.secretRevision,
      input.isDefault ? 1 : 0, input.grantId, input.expectedVersion,
    ).changes === 1;
  });

  const promoteOAuthGrantTransaction = database.transaction((input: Readonly<{
    grantId: string; expectedVersion: number; serviceId: string; scopes: readonly string[];
    secretRef: string; secretRevision: number; profileVersion: number; fence: ConnectorAuthLease;
  }>): boolean => {
    if (!leaseIsCurrent(input.fence)) return false;
    const grant = database.prepare(
      `SELECT g.installation_id, g.user_id, g.provider_id, g.profile_id,
              g.secret_ref, g.version, p.status AS profile_status, p.version AS profile_version
       FROM connector_user_grants g
       JOIN connector_auth_profiles p ON p.profile_id = g.profile_id
       WHERE g.grant_id = ? AND g.status != 'revoked'`,
    ).get(input.grantId) as Readonly<{
      installation_id: string; user_id: number; provider_id: string; profile_id: string;
      secret_ref: string | null; version: number; profile_status: string; profile_version: number;
    }> | undefined;
    if (!grant || grant.version !== input.expectedVersion || grant.profile_status !== 'ready'
      || grant.profile_version !== input.profileVersion) return false;
    const secret = database.prepare(
      `SELECT 1 FROM connector_vault_secrets
       WHERE secret_ref = ? AND installation_id = ? AND provider_id = ?
         AND subject_type = 'grant' AND subject_id = ? AND profile_id = ? AND user_id = ?
         AND field_purpose = 'oauth_token_bundle' AND secret_revision = ?`,
    ).get(
      input.secretRef, grant.installation_id, grant.provider_id, input.grantId,
      grant.profile_id, grant.user_id, input.secretRevision,
    );
    if (!secret) throw new Error('connector_oauth_grant_secret_invalid');
    const changed = database.prepare(
      `UPDATE connector_user_grants
       SET status = 'active', secret_ref = ?, secret_revision = ?, is_default = 0,
           version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE grant_id = ? AND version = ?`,
    ).run(input.secretRef, input.secretRevision, input.grantId, input.expectedVersion);
    if (changed.changes !== 1) return false;
    database.prepare(
      `INSERT INTO connector_oauth_grant_services (
         grant_id, installation_id, user_id, service_id, scopes_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(grant_id, service_id) DO UPDATE SET
         scopes_json = excluded.scopes_json,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      input.grantId, grant.installation_id, grant.user_id, input.serviceId,
      JSON.stringify([...new Set(input.scopes)].sort()),
    );
    if (grant.secret_ref && grant.secret_ref !== input.secretRef) {
      database.prepare('DELETE FROM connector_vault_secrets WHERE secret_ref = ?').run(grant.secret_ref);
    }
    return true;
  });

  const revokeOAuthGrantTransaction = database.transaction((input: Readonly<{
    grantId: string; userId: number; expectedVersion: number; fence: ConnectorAuthLease;
  }>): boolean => {
    if (!leaseIsCurrent(input.fence)) return false;
    const grant = database.prepare(
      `SELECT secret_ref FROM connector_user_grants
       WHERE grant_id = ? AND user_id = ? AND version = ? AND status = 'active'`,
    ).get(input.grantId, input.userId, input.expectedVersion) as { secret_ref: string | null } | undefined;
    if (!grant) return false;
    database.prepare('DELETE FROM connector_oauth_grant_services WHERE grant_id = ?').run(input.grantId);
    const changed = database.prepare(
      `UPDATE connector_user_grants SET status = 'revoked', secret_ref = NULL,
         secret_revision = NULL, is_default = 0, version = version + 1,
         updated_at = CURRENT_TIMESTAMP WHERE grant_id = ? AND version = ?`,
    ).run(input.grantId, input.expectedVersion);
    if (changed.changes !== 1) return false;
    if (grant.secret_ref) {
      database.prepare('DELETE FROM connector_vault_secrets WHERE secret_ref = ?').run(grant.secret_ref);
    }
    return true;
  });

  const deleteOAuthTransactionSecret = database.transaction((
    transactionId: string,
    secretRef: string,
    fence: ConnectorAuthLease,
  ): boolean => {
    if (!leaseIsCurrent(fence)) return false;
    const deleted = database.prepare(
      `DELETE FROM connector_oauth_transactions
       WHERE transaction_id = ? AND secret_ref = ? AND consumed_at IS NOT NULL`,
    ).run(transactionId, secretRef);
    if (deleted.changes !== 1) return false;
    database.prepare('DELETE FROM connector_vault_secrets WHERE secret_ref = ?').run(secretRef);
    return true;
  });

  const discardOAuthGrantCandidateTransaction = database.transaction((input: Readonly<{
    grantId: string; secretRef: string; createdGrant: boolean;
  }>): boolean => {
    const grant = database.prepare(
      'SELECT status, secret_ref FROM connector_user_grants WHERE grant_id = ?',
    ).get(input.grantId) as { status: string; secret_ref: string | null } | undefined;
    if (grant?.secret_ref === input.secretRef) return false;
    if (input.createdGrant && grant) {
      if (grant.status !== 'pending' || grant.secret_ref !== null) return false;
      database.prepare('DELETE FROM connector_user_grants WHERE grant_id = ?').run(input.grantId);
    }
    database.prepare(
      `DELETE FROM connector_vault_secrets
       WHERE secret_ref = ? AND subject_type = 'grant' AND subject_id = ?`,
    ).run(input.secretRef, input.grantId);
    return true;
  });

  return {
    runCredentialWrite<T>(operation: () => T): T {
      return database.transaction(operation).immediate();
    },

    getOrCreateInstallation(): string {
      return getOrCreateInstallationTransaction.immediate();
    },

    acquireLease(leaseKey: string, ownerToken: string, ttlSeconds: number): ConnectorAuthLease | null {
      assertId(leaseKey);
      assertUuid(ownerToken);
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3_600) {
        throw new Error('connector_auth_lease_ttl_invalid');
      }
      return acquireLeaseTransaction.immediate(leaseKey, ownerToken, ttlSeconds);
    },

    releaseLease(fence: ConnectorAuthLease): boolean {
      assertFence(fence, fence.leaseKey);
      return database.prepare(
        `DELETE FROM connector_auth_leases
         WHERE lease_key = ? AND owner_token = ? AND fencing_token = ?`,
      ).run(fence.leaseKey, fence.ownerToken, fence.fencingToken).changes === 1;
    },

    recordOwnerAuthSession(input: Readonly<{
      sessionId: string;
      installationId: string;
      sessionTokenHash: string;
      csrfTokenHash: string;
      userId: number;
      authMethod: 'password' | 'webauthn';
      authTimeMs: number;
      expiresAtMs: number;
    }>): void {
      assertUuid(input.sessionId);
      assertUuid(input.installationId);
      assertHash(input.sessionTokenHash);
      assertHash(input.csrfTokenHash);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0
        || !Number.isSafeInteger(input.authTimeMs) || input.authTimeMs <= 0
        || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= input.authTimeMs
        || !['password', 'webauthn'].includes(input.authMethod)) {
        throw new Error('connector_owner_session_invalid');
      }
      database.prepare(
        `INSERT INTO connector_owner_auth_sessions (
           session_id, installation_id, session_token_hash, csrf_token_hash,
           user_id, auth_method, auth_time_ms, expires_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_token_hash) DO UPDATE SET
           installation_id = excluded.installation_id, csrf_token_hash = excluded.csrf_token_hash,
           user_id = excluded.user_id, auth_method = excluded.auth_method,
           auth_time_ms = excluded.auth_time_ms, expires_at_ms = excluded.expires_at_ms,
           revoked_at_ms = NULL`,
      ).run(
        input.sessionId, input.installationId, input.sessionTokenHash, input.csrfTokenHash,
        input.userId, input.authMethod, input.authTimeMs, input.expiresAtMs,
      );
    },

    readOwnerAuthSession(input: Readonly<{
      sessionTokenHash: string; installationId: string; userId: number; nowMs: number;
    }>): Readonly<{ sessionId: string; csrfTokenHash: string; authTime: number; expiresAt: number }> | null {
      assertHash(input.sessionTokenHash);
      assertUuid(input.installationId);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0
        || !Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) return null;
      const row = database.prepare(
        `SELECT session_id, csrf_token_hash, auth_time_ms, expires_at_ms
         FROM connector_owner_auth_sessions
         WHERE session_token_hash = ? AND installation_id = ? AND user_id = ?
           AND revoked_at_ms IS NULL AND expires_at_ms > ?`,
      ).get(input.sessionTokenHash, input.installationId, input.userId, input.nowMs) as {
        session_id: string; csrf_token_hash: string; auth_time_ms: number; expires_at_ms: number;
      } | undefined;
      return row ? {
        sessionId: row.session_id,
        csrfTokenHash: row.csrf_token_hash,
        authTime: row.auth_time_ms,
        expiresAt: row.expires_at_ms,
      } : null;
    },

    revokeOwnerAuthSession(input: Readonly<{
      sessionTokenHash: string; installationId: string; userId: number; nowMs: number;
    }>): boolean {
      assertHash(input.sessionTokenHash);
      assertUuid(input.installationId);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0
        || !Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) return false;
      return database.prepare(
        `UPDATE connector_owner_auth_sessions SET revoked_at_ms = ?
         WHERE session_token_hash = ? AND installation_id = ? AND user_id = ?
           AND revoked_at_ms IS NULL`,
      ).run(input.nowMs, input.sessionTokenHash, input.installationId, input.userId).changes === 1;
    },

    revokeOwnerAuthSessions(input: Readonly<{
      installationId: string; userId: number; nowMs: number;
    }>): number {
      assertUuid(input.installationId);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0
        || !Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) return 0;
      return database.prepare(
        `UPDATE connector_owner_auth_sessions SET revoked_at_ms = ?
         WHERE installation_id = ? AND user_id = ? AND revoked_at_ms IS NULL`,
      ).run(input.nowMs, input.installationId, input.userId).changes;
    },

    issueOwnerOperation(input: Parameters<typeof issueOwnerOperationTransaction>[0]) {
      assertUuid(input.sessionId);
      assertUuid(input.requestId);
      assertHash(input.nonceHash);
      assertUuid(input.installationId);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0
        || !Number.isSafeInteger(input.nowMs) || input.nowMs <= 0
        || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 60_000
        || ![
          'upsert_byo', 'register_dcr', 'upsert_shared_api_key', 'disable',
          'upsert_personal_api_key', 'revoke_personal_grant',
          'oauth_start', 'oauth_refresh', 'oauth_revoke',
        ].includes(input.operation)) {
        throw new Error('connector_owner_operation_invalid');
      }
      return issueOwnerOperationTransaction.immediate(input);
    },

    consumeOwnerOperation(input: Readonly<{
      nonceHash: string;
      requestId: string;
      sessionId: string;
      installationId: string;
      userId: number;
      operation: ConnectorOwnerOperation;
      nowMs: number;
    }>): boolean {
      assertHash(input.nonceHash);
      assertUuid(input.requestId);
      assertUuid(input.sessionId);
      assertUuid(input.installationId);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0
        || !Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) return false;
      return database.prepare(
        `UPDATE connector_owner_operation_nonces SET consumed_at_ms = ?
         WHERE nonce_hash = ? AND request_id = ? AND session_id = ?
           AND installation_id = ? AND user_id = ? AND operation = ?
           AND consumed_at_ms IS NULL AND expires_at_ms > ?
           AND EXISTS (
             SELECT 1 FROM connector_owner_auth_sessions s
             WHERE s.session_id = connector_owner_operation_nonces.session_id
               AND s.installation_id = connector_owner_operation_nonces.installation_id
               AND s.user_id = ? AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ?
           )`,
      ).run(
        input.nowMs, input.nonceHash, input.requestId, input.sessionId,
        input.installationId, input.userId, input.operation, input.nowMs,
        input.userId, input.nowMs,
      ).changes === 1;
    },

    createProfile(input: Omit<ConnectorAuthProfile, 'version' | 'secretRefs'>): ConnectorAuthProfile {
      assertUuid(input.profileId);
      assertUuid(input.installationId);
      assertId(input.providerId);
      assertOrigin(input.canonicalOrigin);
      assertId(input.catalogRevision);
      if (input.status !== 'pending' || input.secretRef !== null || input.secretRevision !== null) {
        throw new Error('connector_auth_profile_must_start_pending');
      }
      database.prepare(
        `INSERT INTO connector_auth_profiles (
           profile_id, installation_id, provider_id, canonical_origin,
           status, catalog_revision, secret_ref, secret_revision,
           secret_subject_type, secret_subject_id, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'profile', ?, 1)`,
      ).run(
        input.profileId, input.installationId, input.providerId, input.canonicalOrigin,
        input.status, input.catalogRevision, input.secretRef, input.secretRevision, input.profileId,
      );
      return readProfile(input.profileId)!;
    },

    listProfiles,

    findProfile,

    ensureApiKeyGrantProfile(input: Readonly<{
      profileId: string; installationId: string; providerId: string;
      canonicalOrigin: string; catalogRevision: string;
    }>): ConnectorAuthProfile {
      assertUuid(input.profileId);
      assertUuid(input.installationId);
      assertId(input.providerId);
      assertOrigin(input.canonicalOrigin);
      assertId(input.catalogRevision);
      database.prepare(
        `INSERT INTO connector_auth_profiles (
           profile_id, installation_id, provider_id, canonical_origin,
           status, catalog_revision, secret_ref, secret_revision,
           secret_subject_type, secret_subject_id, version
         ) VALUES (?, ?, ?, ?, 'ready', ?, NULL, NULL, 'profile', ?, 1)
         ON CONFLICT(installation_id, provider_id, canonical_origin) DO NOTHING`,
      ).run(
        input.profileId, input.installationId, input.providerId,
        input.canonicalOrigin, input.catalogRevision, input.profileId,
      );
      const profile = findProfile(input.installationId, input.providerId);
      if (!profile) throw new Error('connector_auth_profile_create_failed');
      return profile;
    },

    createPendingProfile(input: Readonly<{
      profileId: string;
      installationId: string;
      providerId: string;
      canonicalOrigin: string;
      catalogRevision: string;
      fence: ConnectorAuthLease;
    }>): ConnectorAuthProfile | null {
      assertFence(input.fence, `profile-provider:${input.installationId}:${input.providerId}`);
      if (!leaseIsCurrent(input.fence)) return null;
      return this.createProfile({
        ...input,
        status: 'pending',
        secretRef: null,
        secretRevision: null,
      });
    },

    stageVaultSecret(input: Parameters<typeof stageProfileSecretTransaction>[0]): boolean {
      assertUuid(input.secretRef);
      assertUuid(input.installationId);
      assertUuid(input.profileId);
      assertId(input.providerId);
      assertId(input.fieldPurpose);
      assertId(input.secretKind);
      assertFence(input.fence, `profile-provider:${input.installationId}:${input.providerId}`);
      for (const value of [
        input.envelope.ciphertext, input.envelope.nonce, input.envelope.authTag,
        input.envelope.wrappedDek, input.envelope.wrappedDekNonce, input.envelope.wrappedDekTag,
      ]) assertBlob(value);
      assertVersion(input.envelope.kekVersion);
      assertVersion(input.envelope.aadVersion);
      assertVersion(input.envelope.secretRevision);
      return stageProfileSecretTransaction.immediate(input);
    },

    activateProfile(input: Parameters<typeof activateProfileTransaction>[0]): ConnectorAuthProfile | null {
      assertUuid(input.profileId);
      assertVersion(input.expectedVersion);
      assertId(input.catalogRevision);
      const profile = readProfile(input.profileId);
      if (!profile) return null;
      assertFence(input.fence, `profile-provider:${profile.installationId}:${profile.providerId}`);
      try {
        return activateProfileTransaction.immediate(input) ? readProfile(input.profileId) : null;
      } catch (error) {
        if (error instanceof Error && error.message === 'connector_auth_profile_cas_stale') return null;
        throw error;
      }
    },

    disableProfile(input: Readonly<{
      profileId: string;
      expectedVersion: number;
      fence: ConnectorAuthLease;
    }>): ConnectorAuthProfile | null {
      assertUuid(input.profileId);
      assertVersion(input.expectedVersion);
      const profile = readProfile(input.profileId);
      if (!profile) return null;
      assertFence(input.fence, `profile-provider:${profile.installationId}:${profile.providerId}`);
      const changed = database.prepare(
        `UPDATE connector_auth_profiles SET status = 'disabled', version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE profile_id = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM connector_auth_leases l
             WHERE l.lease_key = ? AND l.owner_token = ? AND l.fencing_token = ?
               AND l.expires_at > CURRENT_TIMESTAMP
           )`,
      ).run(
        input.profileId, input.expectedVersion, input.fence.leaseKey,
        input.fence.ownerToken, input.fence.fencingToken,
      );
      return changed.changes === 1 ? readProfile(input.profileId) : null;
    },

    getProfile(profileId: string): ConnectorAuthProfile | null {
      assertUuid(profileId);
      return readProfile(profileId);
    },

    readActiveProfileSecret(profileId: string, fieldPurpose: string) {
      assertUuid(profileId);
      assertId(fieldPurpose);
      const profile = readProfile(profileId);
      if (!profile || profile.status !== 'ready') return { state: 'absent' as const };
      const row = database.prepare(
        `SELECT v.secret_ref, v.ciphertext, v.nonce, v.auth_tag, v.wrapped_dek,
                v.wrapped_dek_nonce, v.wrapped_dek_tag, v.kek_version,
                v.aad_version, v.secret_revision
         FROM connector_auth_profile_secret_bindings b
         JOIN connector_vault_secrets v ON v.secret_ref = b.secret_ref
         WHERE b.profile_id = ? AND b.field_purpose = ? AND b.status = 'active'
           AND v.subject_type = 'profile' AND v.subject_id = ? AND v.user_id IS NULL`,
      ).get(profileId, fieldPurpose, profileId) as Readonly<{
        secret_ref: string; ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer;
        wrapped_dek: Buffer; wrapped_dek_nonce: Buffer; wrapped_dek_tag: Buffer;
        kek_version: number; aad_version: number; secret_revision: number;
      }> | undefined;
      if (!row) return { state: 'corrupt' as const };
      return {
        state: 'ready' as const, secretRef: row.secret_ref, profile,
        envelope: {
          ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag,
          wrappedDek: row.wrapped_dek, wrappedDekNonce: row.wrapped_dek_nonce,
          wrappedDekTag: row.wrapped_dek_tag, kekVersion: row.kek_version,
          aadVersion: row.aad_version, secretRevision: row.secret_revision,
        },
      };
    },

    finalizeProfile(input: Readonly<{
      profileId: string;
      expectedVersion: number;
      status: ConnectorAuthProfile['status'];
      catalogRevision: string;
      secretRef: string | null;
      secretRevision: number | null;
      fence: ConnectorAuthLease;
    }>): ConnectorAuthProfile | null {
      assertUuid(input.profileId);
      assertVersion(input.expectedVersion);
      assertId(input.catalogRevision);
      if ((input.secretRef === null) !== (input.secretRevision === null)) {
        throw new Error('connector_auth_secret_binding_invalid');
      }
      if (input.secretRef !== null) {
        assertUuid(input.secretRef);
        assertVersion(input.secretRevision!);
      }
      assertFence(input.fence, `profile:${input.profileId}`);
      const row = database.prepare(
        `UPDATE connector_auth_profiles
         SET status = ?, catalog_revision = ?, secret_ref = ?, secret_revision = ?,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE profile_id = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM connector_auth_leases l
             WHERE l.lease_key = ? AND l.owner_token = ? AND l.fencing_token = ?
               AND l.expires_at > CURRENT_TIMESTAMP
           )
         RETURNING profile_id, installation_id, provider_id, canonical_origin,
                   status, catalog_revision, secret_ref, secret_revision, version`,
      ).get(
        input.status, input.catalogRevision, input.secretRef, input.secretRevision,
        input.profileId, input.expectedVersion, input.fence.leaseKey,
        input.fence.ownerToken, input.fence.fencingToken,
      ) as ProfileRow | undefined;
      return row ? profileFromRow(row) : null;
    },

    /** Stages inert encrypted bytes; only a fenced profile/grant finalize can activate the reference. */
    createVaultSecret(input: Readonly<{
      secretRef: string;
      installationId: string;
      providerId: string;
      subjectType: 'installation' | 'profile' | 'grant' | 'oauth_transaction';
      subjectId: string;
      profileId: string | null;
      userId: number | null;
      fieldPurpose: string;
      secretKind: string;
      ciphertext: Buffer;
      nonce: Buffer;
      authTag: Buffer;
      wrappedDek: Buffer;
      wrappedDekNonce: Buffer;
      wrappedDekTag: Buffer;
      kekVersion: number;
      aadVersion: number;
      secretRevision: number;
    }>): string {
      assertUuid(input.secretRef);
      assertUuid(input.installationId);
      assertId(input.providerId);
      assertId(input.subjectId);
      if (input.profileId !== null) assertUuid(input.profileId);
      if (input.userId !== null && (!Number.isSafeInteger(input.userId) || input.userId <= 0)) {
        throw new Error('connector_auth_subject_invalid');
      }
      assertId(input.fieldPurpose);
      assertId(input.secretKind);
      for (const value of [
        input.ciphertext, input.nonce, input.authTag, input.wrappedDek,
        input.wrappedDekNonce, input.wrappedDekTag,
      ]) assertBlob(value);
      assertVersion(input.kekVersion);
      assertVersion(input.aadVersion);
      assertVersion(input.secretRevision);
      assertVaultSubject(input);
      database.prepare(
        `INSERT INTO connector_vault_secrets (
           secret_ref, installation_id, provider_id, subject_type, subject_id,
           profile_id, user_id, field_purpose, secret_kind, ciphertext, nonce, auth_tag,
           wrapped_dek, wrapped_dek_nonce, wrapped_dek_tag, kek_version, aad_version,
           secret_revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.secretRef, input.installationId, input.providerId, input.subjectType,
        input.subjectId, input.profileId, input.userId, input.fieldPurpose,
        input.secretKind, input.ciphertext,
        input.nonce, input.authTag, input.wrappedDek, input.wrappedDekNonce,
        input.wrappedDekTag, input.kekVersion, input.aadVersion, input.secretRevision,
      );
      return input.secretRef;
    },

    finalizeVaultSecret(input: Readonly<{
      secretRef: string;
      expectedVersion: number;
      expectedSecretRevision: number;
      targetSecretRevision: number;
      ciphertext: Buffer;
      nonce: Buffer;
      authTag: Buffer;
      wrappedDek: Buffer;
      wrappedDekNonce: Buffer;
      wrappedDekTag: Buffer;
      kekVersion: number;
      aadVersion: number;
      fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.secretRef);
      assertVersion(input.expectedVersion);
      assertVersion(input.expectedSecretRevision);
      assertVersion(input.targetSecretRevision);
      if (input.targetSecretRevision !== input.expectedSecretRevision + 1) {
        throw new Error('connector_auth_secret_revision_target_invalid');
      }
      assertVersion(input.kekVersion);
      assertVersion(input.aadVersion);
      assertFence(input.fence, `vault:${input.secretRef}`);
      for (const value of [
        input.ciphertext, input.nonce, input.authTag, input.wrappedDek,
        input.wrappedDekNonce, input.wrappedDekTag,
      ]) assertBlob(value);
      return database.prepare(
        `UPDATE connector_vault_secrets
         SET ciphertext = ?, nonce = ?, auth_tag = ?, wrapped_dek = ?,
             wrapped_dek_nonce = ?, wrapped_dek_tag = ?, kek_version = ?, aad_version = ?,
             secret_revision = ?, version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE secret_ref = ? AND version = ? AND secret_revision = ?
           AND EXISTS (
             SELECT 1 FROM connector_auth_leases l
             WHERE l.lease_key = ? AND l.owner_token = ? AND l.fencing_token = ?
               AND l.expires_at > CURRENT_TIMESTAMP
           )`,
      ).run(
        input.ciphertext, input.nonce, input.authTag, input.wrappedDek,
        input.wrappedDekNonce, input.wrappedDekTag, input.kekVersion, input.aadVersion,
        input.targetSecretRevision,
        input.secretRef, input.expectedVersion, input.expectedSecretRevision,
        input.fence.leaseKey, input.fence.ownerToken, input.fence.fencingToken,
      ).changes === 1;
    },

    createGrant(input: Readonly<{
      grantId: string;
      profileId: string;
      userId: number;
      providerSubjectHmac: string;
      providerSubjectCiphertext: Buffer;
      providerSubjectNonce: Buffer;
      providerSubjectTag: Buffer;
      hmacKeyVersion: number;
      providerSubjectKekVersion?: number;
      serviceId?: string;
      accountLabel: string;
      accountLabelKey?: string;
      isDefault?: boolean;
      legacyProvenance?: string | null;
      secretRef: string | null;
      secretRevision: number | null;
      status: 'pending' | 'active' | 'revoked' | 'error';
    }>): string {
      assertUuid(input.grantId);
      assertUuid(input.profileId);
      assertHash(input.providerSubjectHmac);
      assertBlob(input.providerSubjectCiphertext);
      assertBlob(input.providerSubjectNonce);
      assertBlob(input.providerSubjectTag);
      assertVersion(input.hmacKeyVersion);
      assertVersion(input.providerSubjectKekVersion ?? input.hmacKeyVersion);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || input.accountLabel.length > 128) {
        throw new Error('connector_auth_grant_invalid');
      }
      if (input.status !== 'pending' || input.secretRef !== null || input.secretRevision !== null) {
        throw new Error('connector_auth_grant_must_start_pending');
      }
      const profile = readProfile(input.profileId);
      if (!profile) throw new Error('connector_auth_profile_not_found');
      const serviceId = input.serviceId ?? '';
      const accountLabelKey = input.accountLabelKey ?? '';
      if (serviceId) assertId(serviceId);
      if (accountLabelKey.length > 128 || input.legacyProvenance && input.legacyProvenance.length > 256) {
        throw new Error('connector_auth_grant_invalid');
      }
      database.prepare(
        `INSERT INTO connector_user_grants (
           grant_id, profile_id, installation_id, provider_id, service_id, user_id, provider_subject_hmac,
           provider_subject_ciphertext, provider_subject_nonce, provider_subject_tag,
           provider_subject_kek_version, hmac_key_version, account_label, account_label_key,
           is_default, legacy_provenance, secret_ref, secret_revision,
           secret_subject_type, secret_subject_id, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'grant', ?, ?)`,
      ).run(
        input.grantId, input.profileId, profile.installationId, profile.providerId,
        serviceId, input.userId, input.providerSubjectHmac,
        input.providerSubjectCiphertext, input.providerSubjectNonce, input.providerSubjectTag,
        input.providerSubjectKekVersion ?? input.hmacKeyVersion, input.hmacKeyVersion,
        input.accountLabel, accountLabelKey, input.isDefault ? 1 : 0,
        input.legacyProvenance ?? null, input.secretRef, input.secretRevision,
        input.grantId, input.status,
      );
      return input.grantId;
    },

    finalizeGrant(input: Readonly<{
      grantId: string;
      expectedVersion: number;
      status: 'pending' | 'active' | 'revoked' | 'error';
      accountLabel: string;
      secretRef: string | null;
      secretRevision: number | null;
      fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.grantId);
      assertVersion(input.expectedVersion);
      if (input.accountLabel.length > 128) throw new Error('connector_auth_grant_invalid');
      if ((input.secretRef === null) !== (input.secretRevision === null)) {
        throw new Error('connector_auth_secret_binding_invalid');
      }
      if (input.secretRef !== null) {
        assertUuid(input.secretRef);
        assertVersion(input.secretRevision!);
      }
      assertFence(input.fence, `grant:${input.grantId}`);
      return database.prepare(
        `UPDATE connector_user_grants
         SET status = ?, account_label = ?, secret_ref = ?, secret_revision = ?,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE grant_id = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM connector_auth_leases l
             WHERE l.lease_key = ? AND l.owner_token = ? AND l.fencing_token = ?
               AND l.expires_at > CURRENT_TIMESTAMP
           )`,
      ).run(
        input.status, input.accountLabel, input.secretRef, input.secretRevision, input.grantId,
        input.expectedVersion, input.fence.leaseKey, input.fence.ownerToken,
        input.fence.fencingToken,
      ).changes === 1;
    },

    listUserGrants(installationId: string, userId: number, serviceId?: string) {
      assertUuid(installationId);
      if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('connector_auth_grant_invalid');
      if (serviceId !== undefined) assertId(serviceId);
      const hasPlacementTruth = (database.prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('connectors', 'connector_placements')",
      ).get() as { count: number }).count === 2;
      const boundConnector = `(EXISTS (
        SELECT 1 FROM connector_api_key_connector_bindings api_binding
        WHERE api_binding.connector_id = p.connector_id AND api_binding.grant_id = g.grant_id
          AND api_binding.installation_id = g.installation_id AND api_binding.user_id = g.user_id
          AND api_binding.service_id = c.service
      ) OR EXISTS (
        SELECT 1 FROM connector_oauth_connector_bindings oauth_binding
        WHERE oauth_binding.connector_id = p.connector_id AND oauth_binding.grant_id = g.grant_id
          AND oauth_binding.installation_id = g.installation_id AND oauth_binding.user_id = g.user_id
          AND oauth_binding.service_id = c.service
          AND EXISTS (SELECT 1 FROM connector_oauth_grant_services mapped_service
            WHERE mapped_service.grant_id = g.grant_id
              AND mapped_service.service_id = oauth_binding.service_id)
      ))`;
      const healthyPlacement = `c.enabled = 1 AND c.owner_user_id = g.user_id
        AND c.credential_mode = 'per_member' AND c.source_revision >= 0
        AND c.source_revision % 2 = 0 AND c.source_revision = p.desired_source_revision
        AND p.contract_version = 'mcp-user-v1' AND p.desired_present = 1
        AND p.desired_generation > 0 AND p.applied_generation = p.desired_generation
        AND p.state = 'healthy'
        AND p.desired_fingerprint_version IN (1, 2)
        AND p.applied_fingerprint_version = p.desired_fingerprint_version
        AND p.applied_fingerprint = p.desired_fingerprint`;
      const placementColumns = hasPlacementTruth ? `,
        (SELECT group_concat(DISTINCT p.body_provider) FROM connector_placements p
          JOIN connectors c ON c.id = p.connector_id
          WHERE p.member_user_id = g.user_id AND ${boundConnector}
            AND ${healthyPlacement}) AS available_bodies,
        (SELECT group_concat(DISTINCT p.body_provider) FROM connector_placements p
          JOIN connectors c ON c.id = p.connector_id
          WHERE p.member_user_id = g.user_id AND ${boundConnector}
            AND NOT (${healthyPlacement})) AS pending_bodies`
        : ', NULL AS available_bodies, NULL AS pending_bodies';
      return database.prepare(
        `WITH ranked AS (
           SELECT b.grant_id, b.bundle_state, b.credential_shape, b.expires_at,
                  v.verification_state, v.reason_code, o.operational_state,
                  row_number() OVER (PARTITION BY b.grant_id
                    ORDER BY b.created_at DESC, b.bundle_revision DESC, b.bundle_id DESC) AS position
           FROM connector_credential_bundle_revisions b
           JOIN connector_user_grants current_grant ON current_grant.grant_id = b.grant_id
           JOIN connector_credential_verifications v USING (bundle_id, bundle_revision)
           JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
           WHERE b.bundle_state = 'stored'
             AND ((current_grant.status = 'active'
               AND b.secret_revision = current_grant.secret_revision
               AND EXISTS (SELECT 1 FROM connector_credential_bundle_fields current_field
                 WHERE current_field.bundle_id = b.bundle_id
                   AND current_field.bundle_revision = b.bundle_revision
                   AND current_field.secret_ref = current_grant.secret_ref))
               OR current_grant.status != 'active')
         )
         SELECT g.grant_id, g.profile_id, g.provider_id, g.service_id, g.user_id, g.account_label,
                g.is_default, g.status, g.version, g.secret_ref, g.secret_revision, g.legacy_provenance,
                r.verification_state AS credential_state, r.expires_at AS credential_expires_at,
                r.bundle_state, r.credential_shape, r.operational_state,
                r.reason_code AS verification_reason,
                COALESCE((SELECT group_concat(service_id) FROM connector_oauth_grant_services
                  WHERE grant_id = g.grant_id), g.service_id) AS granted_services
                ${placementColumns}
         FROM connector_user_grants g
         LEFT JOIN ranked r ON r.grant_id = g.grant_id AND r.position = 1
         WHERE g.installation_id = ? AND g.user_id = ?
           AND (? IS NULL OR g.service_id = ? OR EXISTS (
             SELECT 1 FROM connector_oauth_grant_services requested_service
             WHERE requested_service.grant_id = g.grant_id
               AND requested_service.service_id = ?))
         ORDER BY g.service_id, g.is_default DESC, g.account_label_key, g.grant_id`,
      ).all(
        installationId, userId, serviceId ?? null, serviceId ?? null, serviceId ?? null,
      ) as Array<Readonly<{
        grant_id: string; profile_id: string; provider_id: string; service_id: string;
        user_id: number; account_label: string; is_default: 0 | 1;
        status: 'pending' | 'active' | 'revoked' | 'error'; version: number;
        secret_ref: string | null; secret_revision: number | null; legacy_provenance: string | null;
        credential_state: 'stored_unverified' | 'verified' | 'stale' | 'rejected' | 'unavailable' | 'corrupt' | null;
        credential_expires_at: string | null;
        bundle_state: 'candidate' | 'stored' | 'superseded' | 'deleted' | null;
        credential_shape: 'single_api_key' | 'geidea_basic' | null;
        operational_state: 'ineligible' | 'eligible' | 'disabled' | 'revoking' | 'deleted' | null;
        verification_reason: string | null; granted_services: string | null;
        available_bodies: string | null; pending_bodies: string | null;
      }>>;
    },

    findUserGrant(installationId: string, userId: number, serviceId: string, accountLabelKey: string) {
      assertUuid(installationId);
      assertId(serviceId);
      if (!Number.isSafeInteger(userId) || userId <= 0 || accountLabelKey.length > 128) {
        throw new Error('connector_auth_grant_invalid');
      }
      return database.prepare(
        `SELECT grant_id, profile_id, provider_id, service_id, user_id, account_label,
                account_label_key, is_default, status, version, secret_ref, secret_revision
         FROM connector_user_grants
         WHERE installation_id = ? AND user_id = ? AND service_id = ?
           AND account_label_key = ? AND status != 'revoked'`,
      ).get(installationId, userId, serviceId, accountLabelKey) as Readonly<{
        grant_id: string; profile_id: string; provider_id: string; service_id: string;
        user_id: number; account_label: string; account_label_key: string; is_default: 0 | 1;
        status: 'pending' | 'active' | 'error'; version: number;
        secret_ref: string | null; secret_revision: number | null;
      }> | undefined ?? null;
    },

    readStoredUnverifiedApiKey(installationId: string, userId: number, grantId: string) {
      assertUuid(installationId);
      assertUuid(grantId);
      if (!Number.isSafeInteger(userId) || userId <= 0) return null;
      const row = database.prepare(
        `SELECT g.service_id, g.account_label, g.provider_id, g.profile_id,
                b.bundle_id, b.bundle_revision, b.version AS bundle_version,
                s.secret_ref, s.ciphertext, s.nonce, s.auth_tag,
                s.wrapped_dek, s.wrapped_dek_nonce, s.wrapped_dek_tag,
                s.kek_version, s.aad_version, s.secret_revision
         FROM connector_user_grants g
         JOIN connector_credential_bundle_revisions b ON b.grant_id = g.grant_id
         JOIN connector_credential_verifications v USING (bundle_id, bundle_revision)
         JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
         JOIN connector_credential_bundle_fields f USING (bundle_id, bundle_revision)
         JOIN connector_vault_secrets s ON s.secret_ref = f.secret_ref
         WHERE g.grant_id = ? AND g.installation_id = ? AND g.user_id = ?
           AND g.status = 'pending' AND b.bundle_state = 'stored'
           AND b.credential_shape = 'single_api_key' AND f.field_id = 'api_key'
           AND v.verification_state = 'stored_unverified'
           AND o.operational_state = 'ineligible' AND b.expires_at > CURRENT_TIMESTAMP
         ORDER BY b.created_at DESC, b.bundle_id DESC LIMIT 1`,
      ).get(grantId, installationId, userId) as Readonly<{
        service_id: string; account_label: string; provider_id: string; profile_id: string;
        bundle_id: string; bundle_revision: number; bundle_version: number;
        secret_ref: string; ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer;
        wrapped_dek: Buffer; wrapped_dek_nonce: Buffer; wrapped_dek_tag: Buffer;
        kek_version: number; aad_version: number; secret_revision: number;
      }> | undefined;
      return row ? {
        serviceId: row.service_id, accountLabel: row.account_label,
        providerId: row.provider_id, profileId: row.profile_id, secretRef: row.secret_ref,
        bundleId: row.bundle_id, bundleRevision: row.bundle_revision, bundleVersion: row.bundle_version,
        envelope: {
          ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag,
          wrappedDek: row.wrapped_dek, wrappedDekNonce: row.wrapped_dek_nonce,
          wrappedDekTag: row.wrapped_dek_tag, kekVersion: row.kek_version,
          aadVersion: row.aad_version, secretRevision: row.secret_revision,
        },
      } : null;
    },

    storedUnverifiedBundleIsCurrent(input: Readonly<{
      bundleId: string; bundleRevision: number; bundleVersion: number;
      grantId: string; userId: number; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.bundleId);
      assertUuid(input.grantId);
      assertVersion(input.bundleRevision);
      assertVersion(input.bundleVersion);
      assertFence(input.fence, `grant:${input.grantId}`);
      return Boolean(database.prepare(
        `SELECT 1 FROM connector_credential_bundle_revisions b
         JOIN connector_credential_verifications v USING (bundle_id, bundle_revision)
         JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
         WHERE b.bundle_id = ? AND b.bundle_revision = ? AND b.version = ?
           AND b.grant_id = ? AND b.user_id = ? AND b.bundle_state = 'stored'
           AND v.verification_state = 'stored_unverified'
           AND o.operational_state = 'ineligible' AND b.expires_at > CURRENT_TIMESTAMP
           AND EXISTS (SELECT 1 FROM connector_auth_leases l
             WHERE l.lease_key = ? AND l.owner_token = ? AND l.fencing_token = ?
               AND l.expires_at > CURRENT_TIMESTAMP)`,
      ).get(
        input.bundleId, input.bundleRevision, input.bundleVersion,
        input.grantId, input.userId,
        input.fence.leaseKey, input.fence.ownerToken, input.fence.fencingToken,
      ));
    },

    readActiveGrantMaterial(
      installationId: string,
      userId: number,
      serviceId: string,
      grantId: string | undefined,
      policy: ConnectorCredentialRuntimePolicy,
    ) {
      assertUuid(installationId);
      assertId(serviceId);
      if (grantId !== undefined) assertUuid(grantId);
      if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('connector_auth_grant_invalid');
      const grant = database.prepare(
        `SELECT g.grant_id, g.profile_id, g.provider_id, g.service_id, g.user_id,
                g.status, g.version, p.status AS profile_status,
                p.version AS profile_version, p.catalog_revision,
                g.provider_subject_hmac, g.provider_subject_ciphertext, g.provider_subject_nonce,
                provider_subject_tag, provider_subject_kek_version, hmac_key_version,
                g.secret_ref, g.secret_revision
         FROM connector_user_grants g
         JOIN connector_auth_profiles p ON p.profile_id = g.profile_id
         WHERE g.installation_id = ? AND g.user_id = ? AND g.status != 'revoked'
           AND (service_id = ? OR EXISTS (
             SELECT 1 FROM connector_oauth_grant_services s
             WHERE s.grant_id = g.grant_id AND s.service_id = ?
           ))
           AND (? IS NULL OR g.grant_id = ?)
         ORDER BY (g.status = 'active') DESC, g.is_default DESC,
                  g.account_label_key, g.grant_id LIMIT 1`,
      ).get(
        installationId, userId, serviceId, serviceId, grantId ?? null, grantId ?? null,
      ) as Readonly<{
        grant_id: string; profile_id: string; provider_id: string; service_id: string;
        user_id: number; version: number; status: 'pending' | 'active' | 'error';
        profile_status: 'pending' | 'ready' | 'disabled' | 'error';
        profile_version: number; catalog_revision: string;
        provider_subject_hmac: string;
        provider_subject_ciphertext: Buffer; provider_subject_nonce: Buffer;
        provider_subject_tag: Buffer; provider_subject_kek_version: number; hmac_key_version: number;
        secret_ref: string | null; secret_revision: number | null;
      }> | undefined;
      if (!grant) return { state: 'absent' as const };

      const bundle = database.prepare(
        `SELECT b.bundle_id, b.bundle_revision, b.secret_revision, b.shape_revision,
                b.profile_version, b.catalog_revision, b.provider_subject_hmac,
                b.bundle_state, b.expires_at AS credential_expires_at,
                b.expected_field_count, v.contract_revision, v.verification_state,
                v.identity_hmac AS verification_identity_hmac,
                v.expires_at AS verification_expires_at, o.operational_state,
                (SELECT count(*) FROM connector_credential_bundle_fields f
                 WHERE f.bundle_id = b.bundle_id AND f.bundle_revision = b.bundle_revision
                   AND f.installation_id = b.installation_id AND f.user_id = b.user_id
                   AND f.provider_id = b.provider_id AND f.service_id = b.service_id
                   AND f.grant_id = b.grant_id AND f.secret_revision = b.secret_revision) AS field_count,
                (b.installation_id = ? AND b.user_id = ? AND b.provider_id = ?
                 AND b.service_id = ? AND b.grant_id = ?) AS identity_bound
         FROM connector_credential_bundle_revisions b
         LEFT JOIN connector_credential_verifications v
           ON v.bundle_id = b.bundle_id AND v.bundle_revision = b.bundle_revision
         LEFT JOIN connector_credential_operational_states o
           ON o.bundle_id = b.bundle_id AND o.bundle_revision = b.bundle_revision
         WHERE b.grant_id = ? AND b.bundle_state = 'stored'
           AND ((? = 'active' AND b.secret_revision = ?
             AND EXISTS (SELECT 1 FROM connector_credential_bundle_fields current_field
               WHERE current_field.bundle_id = b.bundle_id
                 AND current_field.bundle_revision = b.bundle_revision
                 AND current_field.secret_ref = ?))
             OR ? != 'active')
         ORDER BY b.created_at DESC, b.bundle_revision DESC, b.bundle_id DESC LIMIT 1`,
      ).get(
        installationId, userId, grant.provider_id, serviceId, grant.grant_id, grant.grant_id,
        grant.status, grant.secret_revision, grant.secret_ref, grant.status,
      ) as Readonly<{
        bundle_id: string; bundle_revision: number; secret_revision: number;
        profile_version: number; catalog_revision: string; provider_subject_hmac: string;
        shape_revision: number; bundle_state: 'candidate' | 'stored' | 'superseded';
        credential_expires_at: string | null; expected_field_count: number;
        contract_revision: number | null; verification_state:
          | 'stored_unverified' | 'verified' | 'stale' | 'rejected' | 'unavailable' | 'corrupt' | null;
        verification_identity_hmac: string | null;
        verification_expires_at: string | null;
        operational_state: 'ineligible' | 'eligible' | 'disabled' | 'revoking' | 'deleted' | null;
        field_count: number; identity_bound: 0 | 1;
      }> | undefined;
      if (!bundle) {
        const hasM2Material = Boolean(database.prepare(
          `SELECT 1 FROM connector_credential_bundle_revisions
           WHERE grant_id = ? AND bundle_state != 'deleted' LIMIT 1`,
        ).get(grant.grant_id));
        if (hasM2Material) return { state: 'corrupt' as const };
        const decision = evaluateConnectorCredentialEligibility({
          materialGeneration: 'm1', installationId, userId, providerId: grant.provider_id,
          serviceId, grantId: grant.grant_id, grantStatus: grant.status,
          bundleId: null, bundleRevision: null, secretRevision: grant.secret_revision,
          shapeRevision: null, contractRevision: null,
          expectedShapeRevision: policy.expectedShapeRevision,
          expectedContractRevision: policy.expectedContractRevision,
          catalogRevision: grant.catalog_revision,
          expectedCatalogRevision: policy.expectedCatalogRevision,
          profileStatus: grant.profile_status, profileVersion: grant.profile_version,
          boundProfileVersion: grant.profile_version, providerSubjectHmacMatches: true,
          revoked: false, verificationState: null,
          operationalState: null, verificationExpiresAt: null, credentialExpiresAt: null,
          now: '', identityBound: true, bundleComplete: true, ownership: 'personal',
          registryEnabled: policy.registryEnabled, grantsEnabled: policy.grantsEnabled,
          runtimeEnabled: policy.runtimeEnabled, providerCertified: policy.providerCertified,
          providerEnabled: policy.providerEnabled, serviceEnabled: policy.serviceEnabled,
        });
        if (!decision.eligible) return { state: 'ineligible' as const, reason: decision.reason };
      }
      if (bundle) {
        const decision = evaluateConnectorCredentialEligibility({
          materialGeneration: 'm2', installationId, userId, providerId: grant.provider_id, serviceId,
          grantId: grant.grant_id, grantStatus: grant.status,
          bundleId: bundle.bundle_id, bundleRevision: bundle.bundle_revision,
          secretRevision: bundle.secret_revision, shapeRevision: bundle.shape_revision,
          contractRevision: bundle.contract_revision,
          expectedShapeRevision: policy.expectedShapeRevision,
          expectedContractRevision: policy.expectedContractRevision,
          catalogRevision: bundle.catalog_revision,
          expectedCatalogRevision: policy.expectedCatalogRevision,
          profileStatus: grant.profile_status,
          profileVersion: grant.profile_version,
          boundProfileVersion: bundle.profile_version,
          providerSubjectHmacMatches:
            bundle.provider_subject_hmac === grant.provider_subject_hmac
            && bundle.provider_subject_hmac === bundle.verification_identity_hmac,
          revoked: false,
          verificationState: bundle.verification_state === 'unavailable'
            ? 'stored_unverified' : bundle.verification_state,
          operationalState: bundle.operational_state,
          verificationExpiresAt: bundle.verification_expires_at,
          credentialExpiresAt: bundle.credential_expires_at,
          now: (database.prepare("SELECT CURRENT_TIMESTAMP AS now").get() as { now: string }).now,
          identityBound: bundle.identity_bound === 1,
          bundleComplete: bundle.bundle_state === 'stored'
            && bundle.field_count === bundle.expected_field_count,
          ownership: 'personal',
          registryEnabled: policy.registryEnabled,
          grantsEnabled: policy.grantsEnabled,
          runtimeEnabled: policy.runtimeEnabled,
          providerCertified: policy.providerCertified,
          providerEnabled: policy.providerEnabled,
          serviceEnabled: policy.serviceEnabled,
        });
        if (!decision.eligible) return { state: 'ineligible' as const, reason: decision.reason };
      }
      const boundSecret = bundle ? database.prepare(
        `SELECT secret_ref FROM connector_credential_bundle_fields
         WHERE bundle_id = ? AND bundle_revision = ? AND field_id = 'api_key'
           AND secret_revision = ?`,
      ).get(bundle.bundle_id, bundle.bundle_revision, bundle.secret_revision) as {
        secret_ref: string;
      } | undefined : undefined;
      const effectiveSecretRef = boundSecret?.secret_ref ?? grant.secret_ref;
      if (!effectiveSecretRef || !grant.secret_revision
        || bundle && grant.secret_ref !== effectiveSecretRef) return { state: 'corrupt' as const };
      const secret = database.prepare(
        `SELECT ciphertext, nonce, auth_tag, wrapped_dek, wrapped_dek_nonce, wrapped_dek_tag,
                kek_version, aad_version, secret_revision
         FROM connector_vault_secrets
         WHERE secret_ref = ? AND installation_id = ? AND provider_id = ?
           AND subject_type = 'grant' AND subject_id = ? AND profile_id = ? AND user_id = ?
           AND secret_revision = ?`,
      ).get(
        effectiveSecretRef, installationId, grant.provider_id, grant.grant_id,
        grant.profile_id, userId, grant.secret_revision,
      ) as Readonly<{
        ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; wrapped_dek: Buffer;
        wrapped_dek_nonce: Buffer; wrapped_dek_tag: Buffer; kek_version: number;
        aad_version: number; secret_revision: number;
      }> | undefined;
      if (!secret) return { state: 'corrupt' as const };
      return {
        state: 'ready' as const,
        materialGeneration: bundle ? 'm2' as const : 'm1' as const,
        grantId: grant.grant_id,
        profileId: grant.profile_id,
        providerId: grant.provider_id,
        serviceId: grant.service_id,
        userId: grant.user_id,
        ownership: 'personal' as const,
        version: grant.version,
        providerSubjectHmac: grant.provider_subject_hmac,
        providerSubjectCiphertext: grant.provider_subject_ciphertext,
        providerSubjectNonce: grant.provider_subject_nonce,
        providerSubjectTag: grant.provider_subject_tag,
        providerSubjectKekVersion: grant.provider_subject_kek_version,
        hmacKeyVersion: grant.hmac_key_version,
        secretRef: effectiveSecretRef,
        envelope: {
          ciphertext: secret.ciphertext, nonce: secret.nonce, authTag: secret.auth_tag,
          wrappedDek: secret.wrapped_dek, wrappedDekNonce: secret.wrapped_dek_nonce,
          wrappedDekTag: secret.wrapped_dek_tag, kekVersion: secret.kek_version,
          aadVersion: secret.aad_version, secretRevision: secret.secret_revision,
        },
      };
    },

    rotateGrantSubjectIndex(input: Readonly<{
      grantId: string; userId: number; expectedVersion: number; expectedHmacKeyVersion: number;
      providerSubjectHmac: string; hmacKeyVersion: number; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.grantId);
      assertVersion(input.expectedVersion);
      assertVersion(input.expectedHmacKeyVersion);
      assertVersion(input.hmacKeyVersion);
      assertHash(input.providerSubjectHmac);
      assertFence(input.fence, `grant:${input.grantId}`);
      return database.transaction(() => {
        if (!leaseIsCurrent(input.fence)) return false;
        const hasBundles = database.prepare(
          `SELECT 1 FROM connector_credential_bundle_revisions
           WHERE grant_id = ? AND bundle_state != 'deleted' LIMIT 1`,
        ).get(input.grantId);
        if (hasBundles) {
          // A bundle/evidence identity is immutable. Defer index rotation until
          // a replacement bundle is verified instead of creating a stale state
          // that no production workflow can recover from.
          return false;
        }
        return database.prepare(
          `UPDATE connector_user_grants
           SET provider_subject_hmac = ?, hmac_key_version = ?, version = version + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE grant_id = ? AND user_id = ? AND version = ? AND hmac_key_version = ?
             AND status = 'active'`,
        ).run(
          input.providerSubjectHmac, input.hmacKeyVersion, input.grantId, input.userId,
          input.expectedVersion, input.expectedHmacKeyVersion,
        ).changes === 1;
      }).immediate();
    },

    adoptPendingGrantIdentity(input: Readonly<{
      grantId: string; userId: number; expectedVersion: number;
      providerSubjectHmac: string; providerSubjectCiphertext: Buffer;
      providerSubjectNonce: Buffer; providerSubjectTag: Buffer;
      providerSubjectKekVersion: number; hmacKeyVersion: number; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.grantId);
      assertVersion(input.expectedVersion);
      assertHash(input.providerSubjectHmac);
      assertBlob(input.providerSubjectCiphertext);
      assertBlob(input.providerSubjectNonce);
      assertBlob(input.providerSubjectTag);
      assertVersion(input.providerSubjectKekVersion);
      assertVersion(input.hmacKeyVersion);
      assertFence(input.fence, `grant:${input.grantId}`);
      return database.prepare(
        `UPDATE connector_user_grants SET
           provider_subject_hmac = ?, provider_subject_ciphertext = ?,
           provider_subject_nonce = ?, provider_subject_tag = ?,
           provider_subject_kek_version = ?, hmac_key_version = ?,
           version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE grant_id = ? AND user_id = ? AND version = ?
           AND status = 'pending' AND secret_ref IS NULL
           AND EXISTS (SELECT 1 FROM connector_auth_leases l
             WHERE l.lease_key = ? AND l.owner_token = ? AND l.fencing_token = ?
               AND l.expires_at > CURRENT_TIMESTAMP)`,
      ).run(
        input.providerSubjectHmac, input.providerSubjectCiphertext,
        input.providerSubjectNonce, input.providerSubjectTag,
        input.providerSubjectKekVersion, input.hmacKeyVersion,
        input.grantId, input.userId, input.expectedVersion,
        input.fence.leaseKey, input.fence.ownerToken, input.fence.fencingToken,
      ).changes === 1;
    },

    activateUserGrant(input: Parameters<typeof activateUserGrantTransaction>[0]): boolean {
      assertUuid(input.grantId);
      assertVersion(input.expectedVersion);
      assertUuid(input.secretRef);
      assertVersion(input.secretRevision);
      assertFence(input.fence, `grant:${input.grantId}`);
      if (!input.accountLabel || input.accountLabel.length > 128
        || !input.accountLabelKey || input.accountLabelKey.length > 128) {
        throw new Error('connector_auth_grant_invalid');
      }
      return activateUserGrantTransaction.immediate(input);
    },

    revokeUserGrant(input: Readonly<{
      grantId: string; expectedVersion: number; userId: number; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.grantId);
      assertVersion(input.expectedVersion);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0) return false;
      assertFence(input.fence, `grant:${input.grantId}`);
      return database.transaction(() => {
        if (!leaseIsCurrent(input.fence)) return false;
        const refs = database.prepare(
          `SELECT f.secret_ref FROM connector_credential_bundle_fields f
           JOIN connector_credential_bundle_revisions b USING (bundle_id, bundle_revision)
           WHERE b.grant_id = ?
           UNION
           SELECT g.secret_ref FROM connector_user_grants g
           WHERE g.grant_id = ? AND g.user_id = ? AND g.secret_ref IS NOT NULL`,
        ).all(input.grantId, input.grantId, input.userId) as Array<{ secret_ref: string }>;
        const changed = database.prepare(
          `UPDATE connector_user_grants SET status = 'revoked', is_default = 0,
               secret_ref = NULL, secret_revision = NULL,
               version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE grant_id = ? AND user_id = ? AND version = ?`,
        ).run(input.grantId, input.userId, input.expectedVersion);
        if (changed.changes !== 1) return false;
        database.prepare('DELETE FROM connector_credential_bundle_revisions WHERE grant_id = ?')
          .run(input.grantId);
        database.prepare('DELETE FROM connector_api_key_connector_bindings WHERE grant_id = ?')
          .run(input.grantId);
        database.prepare('DELETE FROM connector_oauth_connector_bindings WHERE grant_id = ?')
          .run(input.grantId);
        const erase = database.prepare('DELETE FROM connector_vault_secrets WHERE secret_ref = ?');
        for (const ref of refs) erase.run(ref.secret_ref);
        return true;
      }).immediate();
    },

    deleteCandidateVaultSecrets(input: Readonly<{
      grantId: string; userId: number; secretRefs: readonly string[]; fence: ConnectorAuthLease;
    }>): number {
      assertUuid(input.grantId);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0) return 0;
      assertFence(input.fence, `grant:${input.grantId}`);
      return database.transaction(() => {
        if (!leaseIsCurrent(input.fence)) return 0;
        const erase = database.prepare(
          `DELETE FROM connector_vault_secrets
           WHERE secret_ref = ? AND subject_type = 'grant' AND subject_id = ? AND user_id = ?
             AND NOT EXISTS (SELECT 1 FROM connector_credential_bundle_fields f
               WHERE f.secret_ref = connector_vault_secrets.secret_ref)`,
        );
        let removed = 0;
        for (const ref of input.secretRefs) {
          assertUuid(ref);
          removed += erase.run(ref, input.grantId, input.userId).changes;
        }
        return removed;
      }).immediate();
    },

    /** Atomically binds every field of one immutable credential revision. */
    createCredentialBundleRevision(input: Readonly<{
      bundleId: string; bundleRevision: number; installationId: string; userId: number;
      providerId: string; serviceId: string; grantId: string; profileId: string;
      credentialShape: 'single_api_key' | 'geidea_basic'; shapeRevision: number;
      secretRevision: number; expiresAt: string;
      fields: readonly Readonly<{
        fieldId: 'api_key' | 'merchant_public_key' | 'api_password';
        sensitivity: 'secret' | 'confidential_identifier'; secretRef: string;
      }>[];
      evidenceHmac: string; evidenceExpiresAt: string; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.bundleId);
      assertUuid(input.installationId);
      assertUuid(input.grantId);
      assertUuid(input.profileId);
      assertVersion(input.bundleRevision);
      assertVersion(input.shapeRevision);
      assertVersion(input.secretRevision);
      assertId(input.providerId);
      assertId(input.serviceId);
      assertHash(input.evidenceHmac);
      assertFence(input.fence, `credential:${input.bundleId}:${input.bundleRevision}`);
      const contract = connectorCredentialContractFor(input.serviceId);
      if (!contract || contract.providerId !== input.providerId
        || contract.shape.id !== input.credentialShape
        || contract.shape.revision !== input.shapeRevision) {
        throw new Error('connector_credential_contract_mismatch');
      }
      const expectedFields = contract.shape.fields.map(field => field.id).sort();
      const actualFields = input.fields.map(field => field.fieldId).sort();
      if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields)
        || new Set(input.fields.map(field => field.secretRef)).size !== input.fields.length) {
        throw new Error('connector_credential_bundle_incomplete');
      }
      for (const field of input.fields) {
        assertUuid(field.secretRef);
        const fieldContract = contract.shape.fields.find(candidate => candidate.id === field.fieldId);
        if (!fieldContract || fieldContract.sensitivity !== field.sensitivity) {
          throw new Error('connector_credential_field_contract_mismatch');
        }
      }
      return database.transaction(() => {
        if (!leaseIsCurrent(input.fence)) return false;
        const grant = database.prepare(
          `SELECT g.provider_subject_hmac, g.secret_ref AS active_secret_ref,
                  p.version AS profile_version,
                  p.catalog_revision, p.status AS profile_status
           FROM connector_user_grants g
           JOIN connector_auth_profiles p ON p.profile_id = g.profile_id
           WHERE g.grant_id = ? AND g.installation_id = ? AND g.user_id = ?
             AND g.provider_id = ? AND g.service_id = ? AND g.profile_id = ?
             AND g.status != 'revoked'`,
        ).get(
          input.grantId, input.installationId, input.userId, input.providerId,
          input.serviceId, input.profileId,
        ) as Readonly<{
          provider_subject_hmac: string; profile_version: number;
          catalog_revision: string; profile_status: string; active_secret_ref: string | null;
        }> | undefined;
        if (!grant) throw new Error('connector_credential_identity_mismatch');
        if (grant.active_secret_ref
          && input.fields.some(field => field.secretRef === grant.active_secret_ref)) {
          throw new Error('connector_credential_candidate_reuses_active_secret');
        }
        for (const field of input.fields) {
          const secret = database.prepare(
            `SELECT 1 FROM connector_vault_secrets
             WHERE secret_ref = ? AND installation_id = ? AND user_id = ?
               AND provider_id = ? AND subject_type = 'grant' AND subject_id = ?
               AND profile_id = ? AND secret_revision = ? AND field_purpose = ?`,
          ).get(
            field.secretRef, input.installationId, input.userId, input.providerId,
            input.grantId, input.profileId, input.secretRevision, field.fieldId,
          );
          if (!secret) throw new Error('connector_credential_secret_revision_mismatch');
        }
        database.prepare(`INSERT INTO connector_credential_bundle_revisions (
          bundle_id, bundle_revision, installation_id, user_id, provider_id, service_id,
          grant_id, profile_id, profile_version, catalog_revision, provider_subject_hmac,
          credential_shape, shape_revision, secret_revision,
          bundle_state, expected_field_count, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`)
          .run(
            input.bundleId, input.bundleRevision, input.installationId, input.userId,
            input.providerId, input.serviceId, input.grantId, input.profileId,
            grant.profile_version, grant.catalog_revision, grant.provider_subject_hmac,
            input.credentialShape, input.shapeRevision, input.secretRevision,
            input.fields.length, input.expiresAt,
          );
        const insertField = database.prepare(`INSERT INTO connector_credential_bundle_fields (
          bundle_id, bundle_revision, installation_id, user_id, provider_id, service_id,
          grant_id, profile_id, profile_version, catalog_revision, provider_subject_hmac,
          secret_revision, field_id, sensitivity, secret_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const field of input.fields) insertField.run(
          input.bundleId, input.bundleRevision, input.installationId, input.userId,
          input.providerId, input.serviceId, input.grantId, input.profileId,
          grant.profile_version, grant.catalog_revision, grant.provider_subject_hmac,
          input.secretRevision, field.fieldId, field.sensitivity, field.secretRef,
        );
        database.prepare(`INSERT INTO connector_credential_verifications (
          bundle_id, bundle_revision, installation_id, user_id, provider_id, service_id,
          grant_id, profile_id, profile_version, catalog_revision, provider_subject_hmac,
          secret_revision, shape_revision, contract_revision, verification_state,
          reason_code, evidence_hmac, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'stored_unverified',
                  'owner_opt_in', ?, ?)`)
          .run(
            input.bundleId, input.bundleRevision, input.installationId, input.userId,
            input.providerId, input.serviceId, input.grantId, input.profileId,
            grant.profile_version, grant.catalog_revision, grant.provider_subject_hmac,
            input.secretRevision,
            input.shapeRevision, input.evidenceHmac, input.evidenceExpiresAt,
          );
        database.prepare(`INSERT INTO connector_credential_operational_states (
          bundle_id, bundle_revision, installation_id, user_id, provider_id, service_id,
          grant_id, profile_id, profile_version, catalog_revision, provider_subject_hmac,
          secret_revision, operational_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ineligible')`).run(
          input.bundleId, input.bundleRevision, input.installationId, input.userId,
          input.providerId, input.serviceId, input.grantId, input.profileId,
          grant.profile_version, grant.catalog_revision, grant.provider_subject_hmac,
          input.secretRevision,
        );
        return true;
      }).immediate();
    },

    /** Candidate-to-stored transition after its complete field transaction is durable. */
    storeCredentialBundleRevision(input: Readonly<{
      bundleId: string; bundleRevision: number; expectedVersion: number; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.bundleId);
      assertVersion(input.bundleRevision);
      assertVersion(input.expectedVersion);
      assertFence(input.fence, `credential:${input.bundleId}:${input.bundleRevision}`);
      return database.prepare(
        `UPDATE connector_credential_bundle_revisions
         SET bundle_state = 'stored', version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE bundle_id = ? AND bundle_revision = ? AND version = ?
           AND bundle_state = 'candidate' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
           AND EXISTS (SELECT 1 FROM connector_auth_leases l
             WHERE l.lease_key = ? AND l.owner_token = ? AND l.fencing_token = ?
               AND l.expires_at > CURRENT_TIMESTAMP)
           AND (SELECT count(*) FROM connector_credential_bundle_fields f
             WHERE f.bundle_id = connector_credential_bundle_revisions.bundle_id
               AND f.bundle_revision = connector_credential_bundle_revisions.bundle_revision)
             = expected_field_count`,
      ).run(
        input.bundleId, input.bundleRevision, input.expectedVersion,
        input.fence.leaseKey, input.fence.ownerToken, input.fence.fencingToken,
      ).changes === 1;
    },

    retireOtherUnverifiedCredentialBundles(input: Readonly<{
      grantId: string; keepBundleId: string; keepBundleRevision: number;
      userId: number; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.grantId);
      assertUuid(input.keepBundleId);
      assertVersion(input.keepBundleRevision);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0) return false;
      assertFence(input.fence, `credential:${input.keepBundleId}:${input.keepBundleRevision}`);
      return database.transaction(() => {
        if (!leaseIsCurrent(input.fence)) return false;
        const keep = database.prepare(
          `SELECT 1 FROM connector_credential_bundle_revisions b
           JOIN connector_credential_verifications v USING (bundle_id, bundle_revision)
           JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
           WHERE b.bundle_id = ? AND b.bundle_revision = ? AND b.grant_id = ?
             AND b.user_id = ? AND b.bundle_state = 'stored'
             AND v.verification_state = 'stored_unverified'
             AND o.operational_state = 'ineligible'`,
        ).get(input.keepBundleId, input.keepBundleRevision, input.grantId, input.userId);
        if (!keep) return false;
        const refs = database.prepare(
          `SELECT f.secret_ref FROM connector_credential_bundle_fields f
           JOIN connector_credential_bundle_revisions b USING (bundle_id, bundle_revision)
           JOIN connector_credential_verifications v USING (bundle_id, bundle_revision)
           JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
           WHERE b.grant_id = ? AND b.user_id = ?
             AND NOT (b.bundle_id = ? AND b.bundle_revision = ?)
             AND b.bundle_state = 'stored' AND v.verification_state = 'stored_unverified'
             AND o.operational_state = 'ineligible'`,
        ).all(
          input.grantId, input.userId, input.keepBundleId, input.keepBundleRevision,
        ) as Array<{ secret_ref: string }>;
        database.prepare(
          `DELETE FROM connector_credential_bundle_revisions
           WHERE grant_id = ? AND user_id = ?
             AND NOT (bundle_id = ? AND bundle_revision = ?)
             AND bundle_state = 'stored'
             AND EXISTS (SELECT 1 FROM connector_credential_verifications v
               JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
               WHERE v.bundle_id = connector_credential_bundle_revisions.bundle_id
                 AND v.bundle_revision = connector_credential_bundle_revisions.bundle_revision
                 AND v.verification_state = 'stored_unverified'
                 AND o.operational_state = 'ineligible')`,
        ).run(input.grantId, input.userId, input.keepBundleId, input.keepBundleRevision);
        const erase = database.prepare('DELETE FROM connector_vault_secrets WHERE secret_ref = ?');
        for (const ref of refs) erase.run(ref.secret_ref);
        return true;
      }).immediate();
    },

    /** Revision-bound verification CAS; raw provider responses have no input slot. */
    recordCredentialVerification(input: Readonly<{
      bundleId: string; bundleRevision: number; expectedBundleVersion: number;
      expectedVerificationVersion: number;
      installationId: string; userId: number; providerId: string; serviceId: string;
      grantId: string; secretRevision: number; shapeRevision: number; contractRevision: number;
      state: 'verified' | 'stale' | 'rejected' | 'unavailable' | 'corrupt';
      reasonCode: string; identityKind: 'user' | 'store' | 'merchant' | 'account' | null;
      identityHmac: string | null; evidenceHmac: string; expiresAt: string;
      fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.bundleId);
      assertUuid(input.installationId);
      assertUuid(input.grantId);
      assertVersion(input.bundleRevision);
      assertVersion(input.expectedBundleVersion);
      assertVersion(input.expectedVerificationVersion);
      assertVersion(input.secretRevision);
      assertVersion(input.shapeRevision);
      assertVersion(input.contractRevision);
      assertHash(input.evidenceHmac);
      if (input.identityHmac !== null) assertHash(input.identityHmac);
      assertId(input.reasonCode);
      assertFence(input.fence, `credential:${input.bundleId}:${input.bundleRevision}`);
      if (input.state === 'verified' && (!input.identityKind || !input.identityHmac)) {
        throw new Error('connector_credential_verified_identity_required');
      }
      if (input.state === 'verified') {
        const binding = database.prepare(
          `SELECT 1 FROM connector_credential_bundle_revisions b
           JOIN connector_user_grants g ON g.grant_id = b.grant_id
           WHERE b.bundle_id = ? AND b.bundle_revision = ?
             AND b.provider_subject_hmac = ? AND g.provider_subject_hmac = ?`,
        ).get(
          input.bundleId, input.bundleRevision, input.identityHmac, input.identityHmac,
        );
        if (!binding) return false;
      }
      return database.transaction(() => {
        if (!leaseIsCurrent(input.fence)) return false;
        const existing = database.prepare(
          `SELECT verification_state, reason_code, identity_kind, identity_hmac,
                  evidence_hmac, expires_at
           FROM connector_credential_verifications
           WHERE bundle_id = ? AND bundle_revision = ? AND installation_id = ?
             AND user_id = ? AND provider_id = ? AND service_id = ? AND grant_id = ?
             AND secret_revision = ? AND shape_revision = ?`,
        ).get(
          input.bundleId, input.bundleRevision, input.installationId, input.userId,
          input.providerId, input.serviceId, input.grantId, input.secretRevision,
          input.shapeRevision,
        ) as Readonly<{
          verification_state: string; reason_code: string; identity_kind: string | null;
          identity_hmac: string | null; evidence_hmac: string; expires_at: string;
        }> | undefined;
        if (existing && existing.verification_state === input.state
          && existing.reason_code === input.reasonCode
          && existing.identity_kind === input.identityKind
          && existing.identity_hmac === input.identityHmac
          && existing.evidence_hmac === input.evidenceHmac
          && existing.expires_at === input.expiresAt) return true;
        const changed = database.prepare(
          `UPDATE connector_credential_verifications SET
             contract_revision = ?, verification_state = ?, reason_code = ?,
             identity_kind = ?, identity_hmac = ?, evidence_hmac = ?,
             verified_at = CASE WHEN ? = 'verified' THEN CURRENT_TIMESTAMP ELSE verified_at END,
             expires_at = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE bundle_id = ? AND bundle_revision = ? AND installation_id = ?
             AND user_id = ? AND provider_id = ? AND service_id = ? AND grant_id = ?
             AND secret_revision = ? AND shape_revision = ?
             AND version = ?
             AND ((verification_state = 'stored_unverified'
                    AND ? IN ('verified', 'rejected', 'unavailable', 'corrupt'))
               OR (verification_state = 'verified' AND ? IN ('verified', 'stale'))
               OR (verification_state = ?))
             AND EXISTS (SELECT 1 FROM connector_credential_bundle_revisions b
               WHERE b.bundle_id = ? AND b.bundle_revision = ? AND b.version = ?
                 AND b.bundle_state = 'stored' AND b.secret_revision = ?
                 AND b.shape_revision = ?)`,
        ).run(
          input.contractRevision, input.state, input.reasonCode, input.identityKind,
          input.identityHmac, input.evidenceHmac, input.state, input.expiresAt,
          input.bundleId, input.bundleRevision, input.installationId, input.userId,
          input.providerId, input.serviceId, input.grantId, input.secretRevision,
          input.shapeRevision, input.expectedVerificationVersion,
          input.state, input.state, input.state,
          input.bundleId, input.bundleRevision,
          input.expectedBundleVersion, input.secretRevision, input.shapeRevision,
        );
        return changed.changes === 1;
      }).immediate();
    },

    /** Promote only a verified current revision; failed candidates never touch the prior active row. */
    promoteCredentialBundle(input: Readonly<{
      bundleId: string; bundleRevision: number; expectedOperationalVersion: number;
      grantId: string; secretRevision: number; fence: ConnectorAuthLease;
      activation?: Readonly<{
        accountLabel: string; accountLabelKey: string; isDefault: boolean;
      }>;
    }>): boolean {
      assertUuid(input.bundleId);
      assertUuid(input.grantId);
      assertVersion(input.bundleRevision);
      assertVersion(input.expectedOperationalVersion);
      assertVersion(input.secretRevision);
      assertFence(input.fence, `credential:${input.bundleId}:${input.bundleRevision}`);
      if (input.activation && (!input.activation.accountLabel
        || input.activation.accountLabel.length > 128
        || !input.activation.accountLabelKey
        || input.activation.accountLabelKey.length > 128)) {
        throw new Error('connector_auth_grant_invalid');
      }
      return database.transaction(() => {
        if (!leaseIsCurrent(input.fence)) return false;
        const current = database.prepare(
          `SELECT b.installation_id, b.user_id, b.provider_id, b.service_id,
                  b.credential_shape, b.shape_revision, b.expires_at,
                  v.contract_revision
           FROM connector_credential_bundle_revisions b
           JOIN connector_credential_verifications v
             ON v.bundle_id = b.bundle_id AND v.bundle_revision = b.bundle_revision
           JOIN connector_credential_operational_states o
             ON o.bundle_id = b.bundle_id AND o.bundle_revision = b.bundle_revision
           JOIN connector_user_grants g ON g.grant_id = b.grant_id
           JOIN connector_auth_profiles p ON p.profile_id = b.profile_id
           WHERE b.bundle_id = ? AND b.bundle_revision = ? AND b.grant_id = ?
             AND b.secret_revision = ? AND b.bundle_state = 'stored'
             AND b.expires_at > CURRENT_TIMESTAMP
             AND v.verification_state = 'verified' AND v.expires_at > CURRENT_TIMESTAMP
             AND v.identity_hmac = b.provider_subject_hmac
             AND o.operational_state = 'ineligible' AND o.version = ?
             AND g.status != 'revoked' AND g.installation_id = b.installation_id
             AND g.user_id = b.user_id AND g.provider_id = b.provider_id
             AND g.service_id = b.service_id
             AND g.provider_subject_hmac = b.provider_subject_hmac
             AND p.status = 'ready' AND p.version = b.profile_version
             AND p.catalog_revision = b.catalog_revision`,
        ).get(
          input.bundleId, input.bundleRevision, input.grantId, input.secretRevision,
          input.expectedOperationalVersion,
        ) as {
          installation_id: string; user_id: number; provider_id: string; service_id: string;
          credential_shape: 'single_api_key' | 'geidea_basic'; shape_revision: number;
          contract_revision: number; expires_at: string;
        } | undefined;
        if (!current) return false;
        const contract = connectorCredentialContractFor(current.service_id);
        if (!contract || contract.providerId !== current.provider_id
          || contract.shape.id !== current.credential_shape
          || contract.shape.revision !== current.shape_revision
          || contract.verification.revision !== current.contract_revision) return false;
        if (current.credential_shape !== 'single_api_key') {
          throw new Error('connector_credential_atomic_reader_required');
        }
        const promotedField = database.prepare(
          `SELECT secret_ref FROM connector_credential_bundle_fields
           WHERE bundle_id = ? AND bundle_revision = ? AND field_id = 'api_key'
             AND secret_revision = ?`,
        ).get(input.bundleId, input.bundleRevision, input.secretRevision) as {
          secret_ref: string;
        } | undefined;
        if (!promotedField) throw new Error('connector_credential_bundle_incomplete');
        database.prepare(
          `UPDATE connector_credential_operational_states
           SET operational_state = 'disabled', version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE installation_id = ? AND user_id = ? AND service_id = ? AND grant_id = ?
             AND operational_state = 'eligible' AND NOT (bundle_id = ? AND bundle_revision = ?)`,
        ).run(
          current.installation_id, current.user_id, current.service_id, input.grantId,
          input.bundleId, input.bundleRevision,
        );
        const promoted = database.prepare(
          `UPDATE connector_credential_operational_states
           SET operational_state = 'eligible', version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE bundle_id = ? AND bundle_revision = ? AND grant_id = ? AND version = ?
             AND operational_state = 'ineligible'`,
        ).run(
          input.bundleId, input.bundleRevision, input.grantId, input.expectedOperationalVersion,
        );
        if (promoted.changes !== 1) throw new Error('connector_credential_promotion_stale');
        if (input.activation?.isDefault) {
          database.prepare(
            `UPDATE connector_user_grants SET is_default = 0, updated_at = CURRENT_TIMESTAMP
             WHERE installation_id = ? AND user_id = ? AND service_id = ?
               AND grant_id != ? AND status = 'active' AND is_default = 1`,
          ).run(
            current.installation_id, current.user_id, current.service_id, input.grantId,
          );
        }
        const grant = database.prepare(
          `UPDATE connector_user_grants SET secret_ref = ?, secret_revision = ?,
             status = 'active',
             account_label = CASE WHEN ? IS NULL THEN account_label ELSE ? END,
             account_label_key = CASE WHEN ? IS NULL THEN account_label_key ELSE ? END,
             is_default = CASE WHEN ? IS NULL THEN is_default ELSE ? END,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE grant_id = ? AND installation_id = ? AND user_id = ? AND provider_id = ?
             AND service_id = ? AND status != 'revoked'`,
        ).run(
          promotedField.secret_ref, input.secretRevision,
          input.activation?.accountLabel ?? null, input.activation?.accountLabel ?? null,
          input.activation?.accountLabelKey ?? null, input.activation?.accountLabelKey ?? null,
          input.activation ? 1 : null, input.activation?.isDefault ? 1 : 0,
          input.grantId, current.installation_id,
          current.user_id, current.provider_id, current.service_id,
        );
        if (grant.changes !== 1) throw new Error('connector_credential_grant_promotion_stale');
        return true;
      }).immediate();
    },

    /** Immediate disable is independent of replacement and never downgrades verification evidence. */
    disableCredentialBundle(input: Readonly<{
      bundleId: string; bundleRevision: number; expectedVersion: number; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.bundleId);
      assertVersion(input.bundleRevision);
      assertVersion(input.expectedVersion);
      assertFence(input.fence, `credential:${input.bundleId}:${input.bundleRevision}`);
      return database.prepare(
        `UPDATE connector_credential_operational_states
         SET operational_state = 'disabled', version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE bundle_id = ? AND bundle_revision = ? AND version = ?
           AND operational_state IN ('eligible', 'ineligible')
           AND EXISTS (SELECT 1 FROM connector_auth_leases l
             WHERE l.lease_key = ? AND l.owner_token = ? AND l.fencing_token = ?
               AND l.expires_at > CURRENT_TIMESTAMP)`,
      ).run(
        input.bundleId, input.bundleRevision, input.expectedVersion,
        input.fence.leaseKey, input.fence.ownerToken, input.fence.fencingToken,
      ).changes === 1;
    },

    /**
     * Deletes live envelope rows/references even with flags OFF. SQLite backups may
     * retain old encrypted pages until their independent retention expires.
     */
    deleteCredentialBundleAndEnvelopeReferences(input: Readonly<{
      bundleId: string; bundleRevision: number; userId: number; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.bundleId);
      assertVersion(input.bundleRevision);
      assertFence(input.fence, `credential:${input.bundleId}:${input.bundleRevision}`);
      return database.transaction(() => {
        if (!leaseIsCurrent(input.fence)) return false;
        const row = database.prepare(
          `SELECT 1 FROM connector_credential_bundle_revisions
           WHERE bundle_id = ? AND bundle_revision = ? AND user_id = ?`,
        ).get(input.bundleId, input.bundleRevision, input.userId);
        if (!row) return false;
        const refs = database.prepare(
          `SELECT secret_ref FROM connector_credential_bundle_fields
           WHERE bundle_id = ? AND bundle_revision = ?`,
        ).all(input.bundleId, input.bundleRevision) as Array<{ secret_ref: string }>;
        database.prepare(
          `UPDATE connector_user_grants SET status = 'revoked', is_default = 0,
             secret_ref = NULL, secret_revision = NULL, version = version + 1,
             updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ? AND secret_ref IN (
             SELECT secret_ref FROM connector_credential_bundle_fields
             WHERE bundle_id = ? AND bundle_revision = ?
           )`,
        ).run(input.userId, input.bundleId, input.bundleRevision);
        database.prepare(
          'DELETE FROM connector_credential_bundle_revisions WHERE bundle_id = ? AND bundle_revision = ?',
        ).run(input.bundleId, input.bundleRevision);
        const erase = database.prepare('DELETE FROM connector_vault_secrets WHERE secret_ref = ?');
        for (const ref of refs) erase.run(ref.secret_ref);
        return true;
      }).immediate();
    },

    /** Bounded DB-time cleanup for expired, never-promoted candidates. */
    purgeExpiredCredentialCandidates(limit: number): number {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('connector_credential_cleanup_limit_invalid');
      }
      return database.transaction(() => {
        const expired = database.prepare(
          `SELECT b.bundle_id, b.bundle_revision
           FROM connector_credential_bundle_revisions b
           LEFT JOIN connector_credential_verifications v USING (bundle_id, bundle_revision)
           LEFT JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
           WHERE b.expires_at <= CURRENT_TIMESTAMP AND (
             b.bundle_state = 'candidate'
             OR (b.bundle_state = 'stored' AND v.verification_state = 'stored_unverified'
                 AND o.operational_state = 'ineligible')
           )
           ORDER BY b.expires_at, b.bundle_id, b.bundle_revision LIMIT ?`,
        ).all(limit) as Array<{ bundle_id: string; bundle_revision: number }>;
        const refsFor = database.prepare(
          `SELECT secret_ref FROM connector_credential_bundle_fields
           WHERE bundle_id = ? AND bundle_revision = ?`,
        );
        const deleteBundle = database.prepare(
          `DELETE FROM connector_credential_bundle_revisions
           WHERE bundle_id = ? AND bundle_revision = ? AND expires_at <= CURRENT_TIMESTAMP
             AND (bundle_state = 'candidate' OR EXISTS (
               SELECT 1 FROM connector_credential_verifications v
               JOIN connector_credential_operational_states o USING (bundle_id, bundle_revision)
               WHERE v.bundle_id = connector_credential_bundle_revisions.bundle_id
                 AND v.bundle_revision = connector_credential_bundle_revisions.bundle_revision
                 AND v.verification_state = 'stored_unverified'
                 AND o.operational_state = 'ineligible'))`,
        );
        const eraseEnvelope = database.prepare(
          'DELETE FROM connector_vault_secrets WHERE secret_ref = ?',
        );
        let removed = 0;
        for (const row of expired) {
          const refs = refsFor.all(row.bundle_id, row.bundle_revision) as Array<{ secret_ref: string }>;
          if (deleteBundle.run(row.bundle_id, row.bundle_revision).changes !== 1) continue;
          for (const ref of refs) eraseEnvelope.run(ref.secret_ref);
          removed += 1;
        }
        const remaining = limit - removed;
        if (remaining > 0) {
          const orphaned = database.prepare(
            `SELECT s.secret_ref FROM connector_vault_secrets s
             JOIN connector_user_grants g
               ON g.grant_id = s.subject_id AND g.user_id = s.user_id
             WHERE s.subject_type = 'grant' AND g.status = 'pending'
               AND s.created_at <= datetime('now', '-1 day')
               AND NOT EXISTS (SELECT 1 FROM connector_credential_bundle_fields f
                 WHERE f.secret_ref = s.secret_ref)
             ORDER BY s.created_at, s.secret_ref LIMIT ?`,
          ).all(remaining) as Array<{ secret_ref: string }>;
          for (const row of orphaned) removed += eraseEnvelope.run(row.secret_ref).changes;
        }
        return removed;
      }).immediate();
    },

    createOAuthTransaction(input: Readonly<{
      profileId: string;
      userId: number;
      stateHash: string;
      secretRef: string | null;
      secretRevision: number | null;
      ttlSeconds: number;
    }>): string {
      assertUuid(input.profileId);
      assertHash(input.stateHash);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0
        || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 900) {
        throw new Error('connector_auth_transaction_invalid');
      }
      if (input.secretRef !== null || input.secretRevision !== null) {
        throw new Error('connector_auth_transaction_must_start_pending');
      }
      const profile = readProfile(input.profileId);
      if (!profile) throw new Error('connector_auth_profile_not_found');
      const transactionId = randomUUID();
      database.prepare(
        `INSERT INTO connector_oauth_transactions (
           transaction_id, profile_id, installation_id, provider_id, user_id, state_hash,
           secret_ref, secret_revision, secret_subject_type, secret_subject_id, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'oauth_transaction', ?,
                   datetime('now', '+' || ? || ' seconds'))`,
      ).run(
        transactionId, input.profileId, profile.installationId, profile.providerId,
        input.userId, input.stateHash, input.secretRef, input.secretRevision,
        transactionId, input.ttlSeconds,
      );
      return transactionId;
    },

    readOAuthTransactionMaterial(stateHash: string) {
      assertHash(stateHash);
      const row = database.prepare(
        `SELECT t.transaction_id, t.profile_id, t.installation_id, t.provider_id,
                t.user_id, t.version, t.secret_ref, t.secret_revision,
                v.ciphertext, v.nonce, v.auth_tag, v.wrapped_dek,
                v.wrapped_dek_nonce, v.wrapped_dek_tag, v.kek_version, v.aad_version
         FROM connector_oauth_transactions t
         LEFT JOIN connector_vault_secrets v ON v.secret_ref = t.secret_ref
         WHERE t.state_hash = ? AND t.consumed_at IS NULL AND t.expires_at > CURRENT_TIMESTAMP`,
      ).get(stateHash) as Readonly<{
        transaction_id: string; profile_id: string; installation_id: string; provider_id: string;
        user_id: number; version: number; secret_ref: string | null; secret_revision: number | null;
        ciphertext: Buffer | null; nonce: Buffer | null; auth_tag: Buffer | null;
        wrapped_dek: Buffer | null; wrapped_dek_nonce: Buffer | null; wrapped_dek_tag: Buffer | null;
        kek_version: number | null; aad_version: number | null;
      }> | undefined;
      if (!row) return { state: 'absent' as const };
      if (!row.secret_ref || !row.secret_revision || !row.ciphertext || !row.nonce || !row.auth_tag
        || !row.wrapped_dek || !row.wrapped_dek_nonce || !row.wrapped_dek_tag
        || !row.kek_version || !row.aad_version) return { state: 'corrupt' as const };
      return {
        state: 'ready' as const, transactionId: row.transaction_id, profileId: row.profile_id,
        installationId: row.installation_id, providerId: row.provider_id, userId: row.user_id,
        version: row.version, secretRef: row.secret_ref,
        envelope: {
          ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag,
          wrappedDek: row.wrapped_dek, wrappedDekNonce: row.wrapped_dek_nonce,
          wrappedDekTag: row.wrapped_dek_tag, kekVersion: row.kek_version,
          aadVersion: row.aad_version, secretRevision: row.secret_revision,
        },
      };
    },

    finalizeOAuthTransactionSecret(input: Readonly<{
      transactionId: string;
      expectedVersion: number;
      secretRef: string;
      secretRevision: number;
      fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.transactionId);
      assertVersion(input.expectedVersion);
      assertUuid(input.secretRef);
      assertVersion(input.secretRevision);
      assertFence(input.fence, `oauth:${input.transactionId}`);
      return database.prepare(
        `UPDATE connector_oauth_transactions
         SET secret_ref = ?, secret_revision = ?, version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE transaction_id = ? AND version = ? AND consumed_at IS NULL
           AND expires_at > CURRENT_TIMESTAMP
           AND EXISTS (
             SELECT 1 FROM connector_auth_leases l
             WHERE l.lease_key = ? AND l.owner_token = ? AND l.fencing_token = ?
               AND l.expires_at > CURRENT_TIMESTAMP
           )`,
      ).run(
        input.secretRef, input.secretRevision, input.transactionId, input.expectedVersion,
        input.fence.leaseKey, input.fence.ownerToken, input.fence.fencingToken,
      ).changes === 1;
    },

    consumeOAuthTransaction(stateHash: string, fence: ConnectorAuthLease) {
      assertHash(stateHash);
      const found = database.prepare(
        'SELECT transaction_id FROM connector_oauth_transactions WHERE state_hash = ?',
      ).get(stateHash) as { transaction_id: string } | undefined;
      if (!found) return null;
      assertFence(fence, `oauth:${found.transaction_id}`);
      return database.prepare(
        `UPDATE connector_oauth_transactions
         SET consumed_at = CURRENT_TIMESTAMP, version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE transaction_id = ? AND state_hash = ? AND consumed_at IS NULL
           AND expires_at > CURRENT_TIMESTAMP
           AND EXISTS (
             SELECT 1 FROM connector_auth_leases l
             WHERE l.lease_key = ? AND l.owner_token = ? AND l.fencing_token = ?
               AND l.expires_at > CURRENT_TIMESTAMP
           )
         RETURNING transaction_id, profile_id, user_id, secret_ref, secret_revision, version`,
      ).get(
        found.transaction_id, stateHash, fence.leaseKey, fence.ownerToken, fence.fencingToken,
      ) as Readonly<{
        transaction_id: string;
        profile_id: string;
        user_id: number;
        secret_ref: string | null;
        secret_revision: number | null;
        version: number;
      }> | undefined ?? null;
    },

    deleteOAuthTransaction(transactionId: string, secretRef: string, fence: ConnectorAuthLease): boolean {
      assertUuid(transactionId);
      assertUuid(secretRef);
      assertFence(fence, `oauth:${transactionId}`);
      return deleteOAuthTransactionSecret.immediate(transactionId, secretRef, fence);
    },

    readActiveOAuthGrantMaterial(
      installationId: string,
      userId: number,
      profileId: string,
      serviceId: string,
      policy: ConnectorCredentialRuntimePolicy,
      grantId?: string,
    ) {
      assertUuid(installationId);
      assertUuid(profileId);
      assertId(serviceId);
      if (grantId !== undefined) assertUuid(grantId);
      if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('connector_oauth_grant_invalid');
      const grant = database.prepare(
        `SELECT g.grant_id FROM connector_user_grants g
         WHERE g.installation_id = ? AND g.user_id = ? AND g.profile_id = ?
           AND g.status = 'active'
           AND (? IS NULL OR g.grant_id = ?)
           AND EXISTS (
             SELECT 1 FROM connector_oauth_grant_services s
             WHERE s.grant_id = g.grant_id AND s.service_id = ?
           )
         ORDER BY g.updated_at DESC LIMIT 1`,
      ).get(
        installationId, userId, profileId, grantId ?? null, grantId ?? null, serviceId,
      ) as { grant_id: string } | undefined;
      if (!grant) {
        const decision = evaluateConnectorRuntimePolicy(policy);
        return decision.eligible
          ? { state: 'absent' as const }
          : { state: 'ineligible' as const, reason: decision.reason };
      }
      const material = this.readActiveGrantMaterial(
        installationId, userId, serviceId,
        grant.grant_id,
        policy,
      );
      if (material.state !== 'ready') return material;
      const services = database.prepare(
        'SELECT service_id, scopes_json FROM connector_oauth_grant_services WHERE grant_id = ? ORDER BY service_id',
      ).all(grant.grant_id) as Array<{ service_id: string; scopes_json: string }>;
      return {
        ...material,
        services: services.map(service => ({
          serviceId: service.service_id,
          scopes: JSON.parse(service.scopes_json) as string[],
        })),
      };
    },

    /** Incremental consent only: reads an existing provider grant before the requested service is mapped. */
    readOAuthGrantForProfileExtension(
      installationId: string,
      userId: number,
      profileId: string,
      requestedServiceId: string,
      policy: ConnectorCredentialRuntimePolicy,
      grantId: string,
    ) {
      assertUuid(installationId);
      assertUuid(profileId);
      assertId(requestedServiceId);
      assertUuid(grantId);
      if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('connector_oauth_grant_invalid');
      const grant = database.prepare(
        `SELECT g.grant_id,
                (SELECT s.service_id FROM connector_oauth_grant_services s
                 WHERE s.grant_id = g.grant_id ORDER BY s.service_id LIMIT 1) AS mapped_service_id
         FROM connector_user_grants g
         WHERE g.installation_id = ? AND g.user_id = ? AND g.profile_id = ?
           AND g.grant_id = ?
           AND g.status = 'active'
           AND EXISTS (SELECT 1 FROM connector_oauth_grant_services s WHERE s.grant_id = g.grant_id)
         LIMIT 1`,
      ).get(installationId, userId, profileId, grantId) as {
        grant_id: string; mapped_service_id: string;
      } | undefined;
      if (!grant) {
        const decision = evaluateConnectorRuntimePolicy(policy);
        return decision.eligible
          ? { state: 'absent' as const }
          : { state: 'ineligible' as const, reason: decision.reason };
      }
      const material = this.readActiveGrantMaterial(
        installationId, userId, grant.mapped_service_id, grant.grant_id, policy,
      );
      if (material.state !== 'ready') return material;
      const services = database.prepare(
        'SELECT service_id, scopes_json FROM connector_oauth_grant_services WHERE grant_id = ? ORDER BY service_id',
      ).all(grant.grant_id) as Array<{ service_id: string; scopes_json: string }>;
      return {
        ...material,
        services: services.map(service => ({
          serviceId: service.service_id,
          scopes: JSON.parse(service.scopes_json) as string[],
        })),
      };
    },

    bindOAuthConnectorGrant(input: Readonly<{
      connectorId: string; installationId: string; userId: number; serviceId: string; grantId: string;
    }>): boolean {
      assertId(input.connectorId);
      assertUuid(input.installationId);
      assertId(input.serviceId);
      assertUuid(input.grantId);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0) return false;
      return database.prepare(
        `INSERT INTO connector_oauth_connector_bindings (
           connector_id, installation_id, user_id, service_id, grant_id
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(connector_id) DO UPDATE SET
           installation_id = excluded.installation_id, user_id = excluded.user_id,
           service_id = excluded.service_id, grant_id = excluded.grant_id,
           updated_at = CURRENT_TIMESTAMP`,
      ).run(
        input.connectorId, input.installationId, input.userId, input.serviceId, input.grantId,
      ).changes === 1;
    },

    readOAuthConnectorGrantBinding(
      connectorId: string, installationId: string, userId: number, serviceId: string,
    ): Readonly<{ grantId: string }> | null {
      assertId(connectorId);
      assertUuid(installationId);
      assertId(serviceId);
      if (!Number.isSafeInteger(userId) || userId <= 0) return null;
      return database.prepare(
        `SELECT grant_id AS grantId FROM connector_oauth_connector_bindings
         WHERE connector_id = ? AND installation_id = ? AND user_id = ? AND service_id = ?`,
      ).get(connectorId, installationId, userId, serviceId) as { grantId: string } | undefined ?? null;
    },

    bindApiKeyConnectorGrant(input: Readonly<{
      connectorId: string; installationId: string; userId: number; serviceId: string; grantId: string;
    }>): boolean {
      assertId(input.connectorId);
      assertUuid(input.installationId);
      assertId(input.serviceId);
      assertUuid(input.grantId);
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0) return false;
      return database.prepare(
        `INSERT INTO connector_api_key_connector_bindings (
           connector_id, installation_id, user_id, service_id, grant_id
         )
         SELECT ?, ?, ?, ?, g.grant_id FROM connector_user_grants g
         WHERE g.grant_id = ? AND g.installation_id = ? AND g.user_id = ?
           AND g.service_id = ? AND g.status IN ('pending', 'active')
         ON CONFLICT(connector_id) DO UPDATE SET
           installation_id = excluded.installation_id, user_id = excluded.user_id,
           service_id = excluded.service_id, grant_id = excluded.grant_id,
           updated_at = CURRENT_TIMESTAMP`,
      ).run(
        input.connectorId, input.installationId, input.userId, input.serviceId,
        input.grantId, input.installationId, input.userId, input.serviceId,
      ).changes === 1;
    },

    readApiKeyConnectorGrantBinding(
      connectorId: string, installationId: string, userId: number, serviceId: string,
    ): Readonly<{ grantId: string }> | null {
      assertId(connectorId);
      assertUuid(installationId);
      assertId(serviceId);
      if (!Number.isSafeInteger(userId) || userId <= 0) return null;
      return database.prepare(
        `SELECT b.grant_id AS grantId FROM connector_api_key_connector_bindings b
         JOIN connector_user_grants g ON g.grant_id = b.grant_id
         WHERE b.connector_id = ? AND b.installation_id = ? AND b.user_id = ?
           AND b.service_id = ? AND g.status = 'active' AND g.service_id = b.service_id`,
      ).get(connectorId, installationId, userId, serviceId) as { grantId: string } | undefined ?? null;
    },

    promoteOAuthGrant(input: Readonly<{
      grantId: string; expectedVersion: number; serviceId: string; scopes: readonly string[];
      secretRef: string; secretRevision: number; profileVersion: number; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.grantId);
      assertVersion(input.expectedVersion);
      assertId(input.serviceId);
      assertUuid(input.secretRef);
      assertVersion(input.secretRevision);
      assertVersion(input.profileVersion);
      assertFence(input.fence, `grant:${input.grantId}`);
      if (input.scopes.length === 0 || input.scopes.some(scope => typeof scope !== 'string' || scope.length > 512)) {
        throw new Error('connector_oauth_scopes_invalid');
      }
      return promoteOAuthGrantTransaction.immediate(input);
    },

    revokeOAuthGrantAndDeleteSecrets(input: Readonly<{
      grantId: string; userId: number; expectedVersion: number; fence: ConnectorAuthLease;
    }>): boolean {
      assertUuid(input.grantId);
      assertVersion(input.expectedVersion);
      assertFence(input.fence, `grant:${input.grantId}`);
      return revokeOAuthGrantTransaction.immediate(input);
    },

    discardOAuthGrantCandidate(input: Readonly<{
      grantId: string; secretRef: string; createdGrant: boolean;
    }>): boolean {
      assertUuid(input.grantId);
      assertUuid(input.secretRef);
      return discardOAuthGrantCandidateTransaction.immediate(input);
    },
  };
}
