import type { Database } from 'better-sqlite3';

import type { ConnectorPlacementFingerprint } from '@/modules/connectors/index.js';
import { getConnection } from '@/modules/database/connection.js';

export type ConnectorPlacementKey = {
  connectorId: string;
  memberUserId: number;
  bodyProvider: 'claude' | 'codex';
  contractVersion: 'mcp-user-v1';
};

export type ConnectorPlacementLease = ConnectorPlacementKey & {
  ownerId: string;
  fencingToken: number;
  desiredGeneration: number;
  sourceRevision: number;
  expiresAtMs: number;
};

export type ConnectorPlacementStatus = ConnectorPlacementKey & {
  desiredGeneration: number;
  appliedGeneration: number;
  state: 'pending' | 'applying' | 'healthy' | 'degraded' | 'removing' | 'blocked';
  attemptCount: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
};

export type ConnectorPlacementPublicTargetStatus = ConnectorPlacementStatus & {
  desiredAppliedMatch: boolean;
};

type PlacementRow = {
  connector_id: string;
  member_user_id: number;
  body_provider: 'claude' | 'codex';
  contract_version: 'mcp-user-v1';
  desired_generation: number;
  applied_generation: number;
  state: ConnectorPlacementStatus['state'];
  attempt_count: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  desired_fingerprint_version: number;
  applied_fingerprint_version: number | null;
  desired_source_revision: number;
  desired_present: number;
  source_is_current: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/i;
const MAX_DATE_MS = 8_640_000_000_000_000;

function assertKey(key: ConnectorPlacementKey): void {
  if (
    !key.connectorId
    || !Number.isSafeInteger(key.memberUserId)
    || key.memberUserId <= 0
    || (key.bodyProvider !== 'claude' && key.bodyProvider !== 'codex')
    || key.contractVersion !== 'mcp-user-v1'
  ) throw new Error('connector_placement_key_invalid');
}

function keyParameters(key: ConnectorPlacementKey): [string, number, string, string] {
  assertKey(key);
  return [key.connectorId, key.memberUserId, key.bodyProvider, key.contractVersion];
}

function assertProof(proof: ConnectorPlacementFingerprint): void {
  if ((proof.version !== 1 && proof.version !== 2) || !FINGERPRINT_PATTERN.test(proof.fingerprint)) {
    throw new Error('connector_placement_fingerprint_invalid');
  }
}

function checkedDeadline(nowMs: number, durationMs: number): number {
  if (
    !Number.isSafeInteger(nowMs)
    || nowMs < 0
    || !Number.isSafeInteger(durationMs)
    || durationMs < 0
    || durationMs > Number.MAX_SAFE_INTEGER - nowMs
  ) throw new Error('connector_placement_deadline_invalid');
  const deadline = nowMs + durationMs;
  if (deadline > MAX_DATE_MS) throw new Error('connector_placement_deadline_invalid');
  return deadline;
}

function toStatus(row: PlacementRow): ConnectorPlacementStatus {
  const hasVerifiedHealthyState = row.desired_generation > 0
    && row.applied_generation === row.desired_generation
    && row.desired_source_revision >= 0
    && row.source_is_current === 1
    && (row.desired_fingerprint_version === 1 || row.desired_fingerprint_version === 2)
    && (row.applied_fingerprint_version === 1 || row.applied_fingerprint_version === 2);
  return {
    connectorId: row.connector_id,
    memberUserId: row.member_user_id,
    bodyProvider: row.body_provider,
    contractVersion: row.contract_version,
    desiredGeneration: row.desired_generation,
    appliedGeneration: row.applied_generation,
    state: row.desired_source_revision < 0 || row.source_is_current !== 1
      ? 'pending'
      : row.state === 'healthy' && !hasVerifiedHealthyState
        ? 'pending'
        : row.state,
    attemptCount: row.attempt_count,
    nextRetryAt: row.next_retry_at,
    lastErrorCode: row.last_error_code,
  };
}

/** Factory accepts an explicit connection so competing-connection behavior is testable. */
export function createConnectorPlacementsDb(database: Database = getConnection()) {
  const upsertDesiredTransaction = database.transaction(
    (
      key: ConnectorPlacementKey,
      proof: ConnectorPlacementFingerprint,
      sourceRevision = -1,
      desiredPresent = true,
    ): ConnectorPlacementStatus => {
      const params = keyParameters(key);
      database.prepare(
        `INSERT INTO connector_placements (
           connector_id, member_user_id, body_provider, contract_version,
           desired_generation, state, desired_fingerprint_version, desired_fingerprint,
           desired_source_revision, desired_present
         ) VALUES (?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?)
         ON CONFLICT(connector_id, member_user_id, body_provider) DO UPDATE SET
           desired_generation = desired_generation +
             CASE WHEN desired_fingerprint_version = excluded.desired_fingerprint_version
                    AND desired_fingerprint = excluded.desired_fingerprint
                    AND desired_source_revision = excluded.desired_source_revision
                    AND desired_present = excluded.desired_present THEN 0 ELSE 1 END,
           desired_fingerprint_version = excluded.desired_fingerprint_version,
           desired_fingerprint = excluded.desired_fingerprint,
           desired_source_revision = excluded.desired_source_revision,
           desired_present = excluded.desired_present,
           state = CASE
             WHEN desired_fingerprint_version = excluded.desired_fingerprint_version
               AND desired_fingerprint = excluded.desired_fingerprint
               AND desired_source_revision = excluded.desired_source_revision
               AND desired_present = excluded.desired_present THEN state ELSE 'pending' END,
           attempt_count = CASE
             WHEN desired_fingerprint_version = excluded.desired_fingerprint_version
               AND desired_fingerprint = excluded.desired_fingerprint
               AND desired_source_revision = excluded.desired_source_revision
               AND desired_present = excluded.desired_present THEN attempt_count ELSE 0 END,
           next_retry_at = CASE
             WHEN desired_fingerprint_version = excluded.desired_fingerprint_version
               AND desired_fingerprint = excluded.desired_fingerprint
               AND desired_source_revision = excluded.desired_source_revision
               AND desired_present = excluded.desired_present THEN next_retry_at ELSE NULL END,
           last_error_code = CASE
             WHEN desired_fingerprint_version = excluded.desired_fingerprint_version
               AND desired_fingerprint = excluded.desired_fingerprint
               AND desired_source_revision = excluded.desired_source_revision
               AND desired_present = excluded.desired_present THEN last_error_code ELSE NULL END,
           lease_owner = CASE
             WHEN desired_fingerprint_version = excluded.desired_fingerprint_version
               AND desired_fingerprint = excluded.desired_fingerprint
               AND desired_source_revision = excluded.desired_source_revision
               AND desired_present = excluded.desired_present THEN lease_owner ELSE '' END,
           lease_expires_at_ms = CASE
             WHEN desired_fingerprint_version = excluded.desired_fingerprint_version
               AND desired_fingerprint = excluded.desired_fingerprint
               AND desired_source_revision = excluded.desired_source_revision
               AND desired_present = excluded.desired_present THEN lease_expires_at_ms ELSE 0 END,
           updated_at = CURRENT_TIMESTAMP
         WHERE connector_placements.contract_version = excluded.contract_version`,
      ).run(...params, proof.version, proof.fingerprint, sourceRevision, desiredPresent ? 1 : 0);
      return toStatus(database.prepare(
        `SELECT p.connector_id, p.member_user_id, p.body_provider, p.contract_version,
                p.desired_generation, p.applied_generation, p.state, p.attempt_count,
                p.next_retry_at, p.last_error_code, p.desired_fingerprint_version,
                p.applied_fingerprint_version, p.desired_source_revision, p.desired_present,
                CASE WHEN c.source_revision = p.desired_source_revision
                       AND c.source_revision % 2 = 0
                       AND c.credential_mode = 'per_member'
                       AND c.owner_user_id = p.member_user_id
                       AND c.enabled = p.desired_present
                     THEN 1 ELSE 0 END AS source_is_current
         FROM connector_placements p JOIN connectors c ON c.id = p.connector_id
         WHERE p.connector_id = ? AND p.member_user_id = ?
           AND p.body_provider = ? AND p.contract_version = ?`,
      ).get(...params) as PlacementRow);
    },
  );

  const acquireLeaseTransaction = database.transaction((
    key: ConnectorPlacementKey,
    ownerId: string,
    nowMs: number,
    leaseMs: number,
  ): ConnectorPlacementLease | null => {
    const params = keyParameters(key);
    const expiresAtMs = nowMs + leaseMs;
    const result = database.prepare(
      `UPDATE connector_placements
       SET state = 'applying', lease_owner = ?, lease_expires_at_ms = ?,
           fencing_token = fencing_token + 1, updated_at = CURRENT_TIMESTAMP
       WHERE connector_id = ? AND member_user_id = ? AND body_provider = ? AND contract_version = ?
         AND desired_generation > 0
         AND desired_source_revision >= 0
         AND desired_fingerprint_version IN (1, 2)
         AND length(desired_fingerprint) = 64
         AND desired_fingerprint NOT GLOB '*[^0-9a-f]*'
         AND state != 'blocked'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
         AND (lease_owner = '' OR lease_expires_at_ms <= ?)
         AND EXISTS (
           SELECT 1 FROM connectors c
           WHERE c.id = connector_placements.connector_id
             AND c.owner_user_id = connector_placements.member_user_id
             AND c.credential_mode = 'per_member'
             AND c.source_revision = connector_placements.desired_source_revision
             AND c.source_revision % 2 = 0
             AND c.enabled = connector_placements.desired_present
         )`,
    ).run(ownerId, expiresAtMs, ...params, new Date(nowMs).toISOString(), nowMs);
    if (result.changes !== 1) return null;
    const row = database.prepare(
      `SELECT desired_generation, desired_source_revision, fencing_token, lease_expires_at_ms
       FROM connector_placements
       WHERE connector_id = ? AND member_user_id = ? AND body_provider = ? AND contract_version = ?
         AND lease_owner = ?`,
    ).get(...params, ownerId) as {
      desired_generation: number;
      desired_source_revision: number;
      fencing_token: number;
      lease_expires_at_ms: number;
    } | undefined;
    if (!row) return null;
    return {
      ...key,
      ownerId,
      fencingToken: row.fencing_token,
      desiredGeneration: row.desired_generation,
      sourceRevision: row.desired_source_revision,
      expiresAtMs: row.lease_expires_at_ms,
    };
  });

  const stageDesiredTransaction = database.transaction((
    key: ConnectorPlacementKey,
    expectedSourceRevision: number,
    proof: ConnectorPlacementFingerprint,
    desiredPresent: boolean,
  ): boolean => {
    const source = database.prepare(
      `SELECT 1 FROM connectors
       WHERE id = ? AND source_revision = ? AND source_revision % 2 = 0
         AND credential_mode = 'per_member' AND owner_user_id = ?
         AND enabled = ?`,
    ).get(key.connectorId, expectedSourceRevision, key.memberUserId, desiredPresent ? 1 : 0);
    if (!source) return false;
    upsertDesiredTransaction(key, proof, expectedSourceRevision, desiredPresent);
    return true;
  });

  return {
    upsertDesired(key: ConnectorPlacementKey, proof: ConnectorPlacementFingerprint): ConnectorPlacementStatus {
      assertProof(proof);
      return upsertDesiredTransaction.immediate(key, proof);
    },

    stageDesiredIfConnectorCurrent(
      key: ConnectorPlacementKey,
      expectedSourceRevision: number,
      proof: ConnectorPlacementFingerprint,
      desiredPresent: boolean,
    ): boolean {
      assertProof(proof);
      if (!Number.isSafeInteger(expectedSourceRevision) || expectedSourceRevision < 0
        || expectedSourceRevision % 2 !== 0) {
        throw new Error('connector_placement_source_revision_invalid');
      }
      return stageDesiredTransaction.immediate(key, expectedSourceRevision, proof, desiredPresent);
    },

    acquireLease(
      key: ConnectorPlacementKey,
      input: { ownerId: string; nowMs: number; leaseMs: number },
    ): ConnectorPlacementLease | null {
      if (
        !UUID_PATTERN.test(input.ownerId)
        || input.leaseMs <= 0
      ) throw new Error('connector_placement_lease_invalid');
      checkedDeadline(input.nowMs, input.leaseMs);
      return acquireLeaseTransaction.immediate(key, input.ownerId, input.nowMs, input.leaseMs);
    },

    /**
     * Exact internal fence for a future writer to call while holding its config lock.
     * It performs no provider I/O and never enters a public DTO or route.
     */
    getConfigWriteProof(
      lease: ConnectorPlacementLease,
      nowMs: number,
    ): {
      desiredProof: ConnectorPlacementFingerprint;
      priorAppliedProof: ConnectorPlacementFingerprint | null;
    } | null {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('connector_placement_time_invalid');
      const readFence = database.transaction(() => database.prepare(
        `SELECT desired_fingerprint_version, desired_fingerprint,
                applied_fingerprint_version, applied_fingerprint
         FROM connector_placements
         WHERE connector_id = ? AND member_user_id = ? AND body_provider = ? AND contract_version = ?
           AND desired_generation = ? AND lease_owner = ? AND fencing_token = ?
           AND desired_source_revision = ? AND lease_expires_at_ms > ?
           AND EXISTS (
             SELECT 1 FROM connectors c
             WHERE c.id = connector_placements.connector_id
               AND c.owner_user_id = connector_placements.member_user_id
               AND c.credential_mode = 'per_member'
               AND c.source_revision = connector_placements.desired_source_revision
               AND c.source_revision % 2 = 0
               AND c.enabled = connector_placements.desired_present
           )`,
      ).get(
        ...keyParameters(lease), lease.desiredGeneration, lease.ownerId,
        lease.fencingToken, lease.sourceRevision, nowMs,
      ) as {
        desired_fingerprint_version: 1 | 2;
        desired_fingerprint: string;
        applied_fingerprint_version: 1 | 2 | null;
        applied_fingerprint: string | null;
      } | undefined);
      const row = readFence.immediate();
      if (!row) return null;
      if (
        (row.desired_fingerprint_version !== 1 && row.desired_fingerprint_version !== 2)
        || (row.applied_fingerprint_version !== null
          && row.applied_fingerprint_version !== 1
          && row.applied_fingerprint_version !== 2)
      ) throw new Error('connector_placement_fingerprint_version_unsupported');
      const desiredProof: ConnectorPlacementFingerprint = {
        version: row.desired_fingerprint_version,
        fingerprint: row.desired_fingerprint,
      };
      assertProof(desiredProof);
      let priorAppliedProof: ConnectorPlacementFingerprint | null = null;
      if (row.applied_fingerprint_version !== null) {
        if (row.applied_fingerprint === null) throw new Error('connector_placement_fingerprint_invalid');
        priorAppliedProof = {
          version: row.applied_fingerprint_version,
          fingerprint: row.applied_fingerprint,
        };
        assertProof(priorAppliedProof);
      }
      return {
        desiredProof,
        priorAppliedProof,
      };
    },

    markHealthy(
      lease: ConnectorPlacementLease,
      proof: ConnectorPlacementFingerprint,
      nowMs: number,
    ): boolean {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('connector_placement_time_invalid');
      assertProof(proof);
      const result = database.prepare(
        `UPDATE connector_placements
         SET applied_generation = desired_generation,
             applied_fingerprint_version = desired_fingerprint_version,
             applied_fingerprint = desired_fingerprint,
             state = 'healthy', attempt_count = 0, next_retry_at = NULL,
             last_error_code = NULL, lease_owner = '', lease_expires_at_ms = 0,
             updated_at = CURRENT_TIMESTAMP
         WHERE connector_id = ? AND member_user_id = ? AND body_provider = ? AND contract_version = ?
           AND lease_owner = ? AND fencing_token = ? AND desired_generation = ?
           AND desired_source_revision = ?
           AND desired_fingerprint_version = ? AND desired_fingerprint = ?
           AND lease_expires_at_ms > ?
           AND EXISTS (
             SELECT 1 FROM connectors c
             WHERE c.id = connector_placements.connector_id
               AND c.owner_user_id = connector_placements.member_user_id
               AND c.credential_mode = 'per_member'
               AND c.source_revision = connector_placements.desired_source_revision
               AND c.source_revision % 2 = 0
               AND c.enabled = connector_placements.desired_present
           )`,
      ).run(
        ...keyParameters(lease), lease.ownerId, lease.fencingToken,
        lease.desiredGeneration, lease.sourceRevision, proof.version, proof.fingerprint, nowMs,
      );
      return result.changes === 1;
    },

    markFailure(
      lease: ConnectorPlacementLease,
      input: { nowMs: number; retryAfterMs: number; errorCode: string; blocked?: boolean },
    ): boolean {
      if (
        !Number.isSafeInteger(input.nowMs)
        || input.nowMs < 0
        || !ERROR_CODE_PATTERN.test(input.errorCode)
      ) throw new Error('connector_placement_failure_invalid');
      const retryDeadline = checkedDeadline(input.nowMs, input.retryAfterMs);
      const nextRetryAt = input.blocked ? null : new Date(retryDeadline).toISOString();
      const result = database.prepare(
        `UPDATE connector_placements
         SET state = ?, attempt_count = attempt_count + 1, next_retry_at = ?,
             last_error_code = ?, lease_owner = '', lease_expires_at_ms = 0,
             updated_at = CURRENT_TIMESTAMP
         WHERE connector_id = ? AND member_user_id = ? AND body_provider = ? AND contract_version = ?
           AND lease_owner = ? AND fencing_token = ? AND desired_generation = ?
           AND desired_source_revision = ? AND lease_expires_at_ms > ?
           AND EXISTS (
             SELECT 1 FROM connectors c
             WHERE c.id = connector_placements.connector_id
               AND c.owner_user_id = connector_placements.member_user_id
               AND c.credential_mode = 'per_member'
               AND c.source_revision = connector_placements.desired_source_revision
               AND c.source_revision % 2 = 0
               AND c.enabled = connector_placements.desired_present
           )`,
      ).run(
        input.blocked ? 'blocked' : 'degraded', nextRetryAt, input.errorCode,
        ...keyParameters(lease), lease.ownerId, lease.fencingToken,
        lease.desiredGeneration, lease.sourceRevision, input.nowMs,
      );
      return result.changes === 1;
    },

    getStatus(key: ConnectorPlacementKey): ConnectorPlacementStatus | null {
      const row = database.prepare(
        `SELECT p.connector_id, p.member_user_id, p.body_provider, p.contract_version,
                p.desired_generation, p.applied_generation, p.state, p.attempt_count,
                p.next_retry_at, p.last_error_code, p.desired_fingerprint_version,
                p.applied_fingerprint_version, p.desired_source_revision, p.desired_present,
                CASE WHEN c.source_revision = p.desired_source_revision
                       AND c.source_revision % 2 = 0
                       AND c.credential_mode = 'per_member'
                       AND c.owner_user_id = p.member_user_id
                       AND c.enabled = p.desired_present
                     THEN 1 ELSE 0 END AS source_is_current
         FROM connector_placements p JOIN connectors c ON c.id = p.connector_id
         WHERE p.connector_id = ? AND p.member_user_id = ?
           AND p.body_provider = ? AND p.contract_version = ?`,
      ).get(...keyParameters(key)) as PlacementRow | undefined;
      return row ? toStatus(row) : null;
    },

    listPublicStatuses(
      connectorIds: string[],
      memberUserId: number,
    ): ConnectorPlacementPublicTargetStatus[] {
      if (!Number.isSafeInteger(memberUserId) || memberUserId <= 0 || connectorIds.length === 0) return [];
      const uniqueIds = [...new Set(connectorIds)].filter((id) => typeof id === 'string' && id.length > 0);
      if (uniqueIds.length === 0) return [];
      const placeholders = uniqueIds.map(() => '?').join(', ');
      const rows = database.prepare(
        `SELECT p.connector_id, p.member_user_id, p.body_provider, p.contract_version,
                p.desired_generation, p.applied_generation, p.state, p.attempt_count,
                p.next_retry_at, p.last_error_code, p.desired_fingerprint_version,
                p.applied_fingerprint_version, p.desired_source_revision, p.desired_present,
                CASE WHEN c.source_revision = p.desired_source_revision
                       AND c.source_revision % 2 = 0
                       AND c.credential_mode = 'per_member'
                       AND c.owner_user_id = p.member_user_id
                       AND c.enabled = p.desired_present
                     THEN 1 ELSE 0 END AS source_is_current,
                CASE WHEN p.desired_generation > 0
                       AND p.applied_generation = p.desired_generation
                       AND p.desired_fingerprint_version IN (1, 2)
                       AND p.applied_fingerprint_version = p.desired_fingerprint_version
                       AND p.applied_fingerprint = p.desired_fingerprint
                       AND c.source_revision = p.desired_source_revision
                       AND c.source_revision % 2 = 0
                       AND c.credential_mode = 'per_member'
                       AND c.owner_user_id = p.member_user_id
                       AND c.enabled = p.desired_present
                     THEN 1 ELSE 0 END AS desired_applied_match
         FROM connector_placements p
         JOIN connectors c ON c.id = p.connector_id
         WHERE p.member_user_id = ? AND p.connector_id IN (${placeholders})`,
      ).all(memberUserId, ...uniqueIds) as Array<PlacementRow & { desired_applied_match: number }>;
      return rows.map((row) => ({ ...toStatus(row), desiredAppliedMatch: row.desired_applied_match === 1 }));
    },
  };
}

/** Lazy facade avoids opening SQLite before startup migrations complete. */
export const connectorPlacementsDb = {
  upsertDesired: (key: ConnectorPlacementKey, proof: ConnectorPlacementFingerprint) =>
    createConnectorPlacementsDb().upsertDesired(key, proof),
  stageDesiredIfConnectorCurrent: (
    key: ConnectorPlacementKey,
    expectedSourceRevision: number,
    proof: ConnectorPlacementFingerprint,
    desiredPresent: boolean,
  ) => createConnectorPlacementsDb().stageDesiredIfConnectorCurrent(
    key, expectedSourceRevision, proof, desiredPresent,
  ),
  acquireLease: (
    key: ConnectorPlacementKey,
    input: { ownerId: string; nowMs: number; leaseMs: number },
  ) => createConnectorPlacementsDb().acquireLease(key, input),
  getConfigWriteProof: (lease: ConnectorPlacementLease, nowMs: number) =>
    createConnectorPlacementsDb().getConfigWriteProof(lease, nowMs),
  markHealthy: (
    lease: ConnectorPlacementLease,
    proof: ConnectorPlacementFingerprint,
    nowMs: number,
  ) => createConnectorPlacementsDb().markHealthy(lease, proof, nowMs),
  markFailure: (
    lease: ConnectorPlacementLease,
    input: { nowMs: number; retryAfterMs: number; errorCode: string; blocked?: boolean },
  ) => createConnectorPlacementsDb().markFailure(lease, input),
  getStatus: (key: ConnectorPlacementKey) => createConnectorPlacementsDb().getStatus(key),
  listPublicStatuses: (connectorIds: string[], memberUserId: number) =>
    createConnectorPlacementsDb().listPublicStatuses(connectorIds, memberUserId),
};
