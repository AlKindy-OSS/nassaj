/** Durable, inert M3 store. This module is not imported by production connector paths. */

import { createHash, randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { runLocalUpdateBackground } from '../../services/update-writer-lease.js';

import {
  connectorOperationKilled,
  ConnectorPolicyOperation,
  validateConnectorKillRules,
  type ConnectorKillRules,
  type ConnectorPolicyBinding,
  type ConnectorPolicyDurableStore,
  type ConnectorPolicyState,
} from './connector-policy-v2.js';

type CapabilityRegistration = Parameters<ConnectorPolicyDurableStore['registerCapability']>[0];
type CapabilityConsumption = Parameters<ConnectorPolicyDurableStore['consumeCapability']>[0];
type SnapshotRevision = Parameters<ConnectorPolicyDurableStore['replace']>[1];

export const CONNECTOR_POLICY_V2_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connector_policy_v2_state (
  installation_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  kill_revision INTEGER NOT NULL CHECK (kill_revision >= 0)
);
CREATE TABLE IF NOT EXISTS connector_policy_v2_capability_nonce (
  nonce TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS connector_policy_v2_oauth_pending (
  transaction_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  ownership TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  consumer_body TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation = 'oauth.start'),
  state TEXT NOT NULL CHECK (state IN ('pending','invalidated','consumed')),
  created_at_ms INTEGER NOT NULL,
  invalidated_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS connector_policy_v2_placement (
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  ownership TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  consumer_body TEXT NOT NULL CHECK (consumer_body IN ('claude','codex')),
  opaque_grant_ref TEXT NOT NULL,
  bridge_open INTEGER NOT NULL CHECK (bridge_open IN (0,1)),
  PRIMARY KEY (installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,consumer_body)
);
CREATE TABLE IF NOT EXISTS connector_policy_v2_grant_owner (
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  ownership TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','pending_cleanup')),
  PRIMARY KEY (installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id)
);
CREATE TABLE IF NOT EXISTS connector_policy_v2_placement_intent (
  intent_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  ownership TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  consumer_body TEXT NOT NULL CHECK (consumer_body IN ('claude','codex')),
  opaque_grant_ref TEXT NOT NULL,
  expected_revision_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applying','committed','compensating')),
  created_at_ms INTEGER NOT NULL,
  removal_origin_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS connector_policy_v2_removal_queue (
  task_key TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  ownership TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('claude','codex','bridge')),
  state TEXT NOT NULL CHECK (state IN ('pending','leased','done')),
  enqueued_at_ms INTEGER NOT NULL,
  lease_until_ms INTEGER,
  lease_token TEXT,
  completed_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
`;

type StateRow = { state_json: string; kill_revision: number };
type CapabilityRow = { record_json: string; consumed_at: string | null };
type PendingRow = ConnectorPolicyBinding & { transaction_id: string; state: string };
type PlacementIntentRow = ConnectorPolicyBinding & { intentId: string; opaqueGrantRef: string;
  expectedRevisionJson: string; state: 'applying' | 'committed' | 'compensating';
  createdAtMs: number; removalOriginAtMs: number | null };

const parseState = (row: StateRow | undefined): ConnectorPolicyState => {
  if (!row) throw new Error('connector_policy_state_missing');
  const state = JSON.parse(row.state_json) as ConnectorPolicyState;
  if (state.killRevision !== row.kill_revision) throw new Error('connector_policy_state_corrupt');
  return state;
};

const sameRevision = (state: ConnectorPolicyState, expected: SnapshotRevision): boolean =>
  state.policySchemaVersion === expected.policySchemaVersion && state.policyEpoch === expected.policyEpoch
  && state.registryRevision === expected.registryRevision
  && state.certificationManifestDigest === expected.certificationManifestDigest
  && state.installationMode === expected.installationMode && state.originRevision === expected.originRevision
  && state.killRevision === expected.killRevision && state.writerEpoch === expected.writerEpoch;

const capabilityCurrent = (record: CapabilityRegistration, state: ConnectorPolicyState): boolean =>
  sameRevision(state, record.snapshot) && !connectorOperationKilled(state.kills, record);

const placementAffectedByKill = (rules: ConnectorKillRules, binding: ConnectorPolicyBinding): boolean =>
  rules.global || rules.providers.includes(binding.providerId)
  || rules.serviceOperations.some(entry => entry.serviceId === binding.serviceId
    && [ConnectorPolicyOperation.CredentialUse, ConnectorPolicyOperation.TokenRefresh,
      ConnectorPolicyOperation.PlacementWrite].includes(entry.operation));

const removalTaskKey = (row: ConnectorPolicyBinding, target: string, generation: string): string =>
  createHash('sha256').update('NASSAJ\0CONNECTOR_REMOVAL_TASK\0V2\0').update(JSON.stringify([
    row.installationId, row.userId, row.ownership, row.providerId, row.serviceId,
    row.accountId, row.grantId, target, generation,
  ])).digest('base64url');

const validReplacement = (current: ConnectorPolicyState, next: ConnectorPolicyState): boolean => {
  const killsChanged = JSON.stringify(current.kills) !== JSON.stringify(next.kills);
  return next.policySchemaVersion === 2 && Number.isSafeInteger(next.policyEpoch)
    && next.policyEpoch >= current.policyEpoch && next.originRevision >= current.originRevision
    && next.writerEpoch > current.writerEpoch && validateConnectorKillRules(next.kills)
    && next.killRevision === current.killRevision + (killsChanged ? 1 : 0);
};

const pendingBinding = (row: PendingRow): ConnectorPolicyBinding => ({
  installationId: row.installationId, userId: row.userId, ownership: row.ownership,
  providerId: row.providerId, serviceId: row.serviceId, accountId: row.accountId,
  grantId: row.grantId, consumerBody: row.consumerBody, operation: row.operation,
});

/** SQLite implementation used only by the inert M3 adapter and its conformance suite. */
export class SqliteConnectorPolicyV2Store implements ConnectorPolicyDurableStore {
  readonly #database: Database;

  constructor(database: Database, installationId: string, initialState: ConnectorPolicyState,
    options: Readonly<{ recoverPlacementIntents?: boolean; initializeSchema?: boolean }> = {}) {
    this.#database = database;
    if (options.initializeSchema !== false) {
      database.exec(CONNECTOR_POLICY_V2_STORE_SCHEMA_SQL);
      database.prepare(`INSERT OR IGNORE INTO connector_policy_v2_state
        (installation_id,state_json,kill_revision) VALUES (?,?,?)`)
        .run(installationId, JSON.stringify(initialState), initialState.killRevision);
    }
    if (options.recoverPlacementIntents !== false) this.recoverPlacementIntents(installationId);
  }

  async read(installationId: string): Promise<ConnectorPolicyState> {
    return this.#read(installationId);
  }

  /** Synchronous canonical read for same-process administrative transactions. */
  readCurrent(installationId: string): ConnectorPolicyState {
    return this.#read(installationId);
  }

  async replace(installationId: string, expected: SnapshotRevision,
    replacement: ConnectorPolicyState): Promise<ConnectorPolicyState> {
    const run = this.#database.transaction(() => {
      const current = this.#read(installationId);
      if (!sameRevision(current, expected) || !validReplacement(current, replacement)) {
        throw new Error('connector_policy_revision_conflict');
      }
      const result = this.#database.prepare(`UPDATE connector_policy_v2_state
        SET state_json = ?, kill_revision = ? WHERE installation_id = ? AND kill_revision = ?`)
        .run(JSON.stringify(replacement), replacement.killRevision, installationId, current.killRevision);
      if (result.changes !== 1) throw new Error('connector_policy_revision_conflict');
      return replacement;
    });
    return run();
  }

  /**
   * Canonical administrative origin mutation. The supplied local persistence
   * callback runs inside the same immediate transaction as Policy V2 state.
   */
  advanceOriginRevision(input: Readonly<{
    installationId: string;
    expectedOriginRevision: number;
    nowMs: number;
    persistOrigin: (originRevision: number) => void;
  }>): ConnectorPolicyState {
    if (!Number.isSafeInteger(input.expectedOriginRevision) || input.expectedOriginRevision < 1
      || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
      throw new Error('connector_origin_policy_input_invalid');
    }
    const advance = this.#database.transaction(() => {
      const current = this.#read(input.installationId);
      if (current.originRevision !== input.expectedOriginRevision) {
        throw new Error('connector_origin_revision_conflict');
      }
      if (this.#pendingOauthCount(input.installationId) > 0) throw new Error('connector_origin_oauth_pending');
      const next = { ...current, policyEpoch: current.policyEpoch + 1,
        originRevision: current.originRevision + 1, writerEpoch: current.writerEpoch + 1 };
      if (!validReplacement(current, next)) throw new Error('connector_origin_policy_invalid');
      input.persistOrigin(next.originRevision);
      const result = this.#database.prepare(`UPDATE connector_policy_v2_state
        SET state_json = ? WHERE installation_id = ? AND state_json = ? AND kill_revision = ?`)
        .run(JSON.stringify(next), input.installationId, JSON.stringify(current), current.killRevision);
      if (result.changes !== 1) throw new Error('connector_origin_revision_conflict');
      this.#invalidateInstallationCapabilities(input.installationId, input.nowMs);
      return next;
    });
    return advance.immediate();
  }

  /** Binds first origin only while the installation has produced no connector effects. */
  bindInitialOrigin(input: Readonly<{
    installationId: string;
    nowMs: number;
    persistOrigin: (originRevision: number) => void;
  }>): ConnectorPolicyState {
    const bind = this.#database.transaction(() => {
      const current = this.#read(input.installationId);
      if (current.originRevision !== 1 || this.#hasInstallationEffects(input.installationId)) {
        throw new Error('connector_origin_bootstrap_unsafe');
      }
      input.persistOrigin(current.originRevision);
      return current;
    });
    return bind.immediate();
  }

  async registerCapability(record: CapabilityRegistration): Promise<boolean> {
    const run = this.#database.transaction(() => {
      if (!capabilityCurrent(record, this.#read(record.installationId))) return false;
      return this.#database.prepare(`INSERT OR IGNORE INTO connector_policy_v2_capability_nonce
        (nonce,installation_id,record_json,binding_digest,subject_digest) VALUES (?,?,?,?,?)`)
        .run(record.nonce, record.installationId, JSON.stringify(record), record.bindingDigest,
          record.subjectDigest).changes === 1;
    });
    return run();
  }

  async consumeCapability(input: CapabilityConsumption): Promise<boolean> {
    const run = this.#database.transaction(() => this.#consume(input));
    return run();
  }

  applyKills(installationId: string, kills: ConnectorKillRules, nowMs: number): ConnectorPolicyState {
    if (!validateConnectorKillRules(kills) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error('connector_kill_update_invalid');
    }
    const apply = this.#database.transaction(() => {
      const current = this.#read(installationId);
      const next = { ...current, policyEpoch: current.policyEpoch + 1,
        killRevision: current.killRevision + 1, writerEpoch: current.writerEpoch + 1, kills };
      this.#database.prepare(`UPDATE connector_policy_v2_state SET state_json = ?, kill_revision = ?
        WHERE installation_id = ?`).run(JSON.stringify(next), next.killRevision, installationId);
      this.#invalidatePending(installationId, kills, nowMs);
      this.#enqueueMatchingPlacements(installationId, kills, nowMs);
      this.#compensateMatchingIntents(installationId, kills, nowMs);
      return next;
    });
    return apply.immediate();
  }

  createOauthPending(transactionId: string, binding: ConnectorPolicyBinding, nowMs: number): void {
    this.#database.prepare(`INSERT INTO connector_policy_v2_oauth_pending
      (transaction_id,installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,
       consumer_body,operation,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`)
      .run(transactionId, binding.installationId, binding.userId, binding.ownership, binding.providerId,
        binding.serviceId, binding.accountId, binding.grantId, binding.consumerBody,
        binding.operation, nowMs);
  }

  invalidateOauthPending(transactionId: string, nowMs: number): void {
    this.#database.prepare(`UPDATE connector_policy_v2_oauth_pending SET state = 'invalidated',
      invalidated_at_ms = ? WHERE transaction_id = ? AND state = 'pending'`).run(nowMs, transactionId);
  }

  consumeOauthPending(transactionId: string, expected: ConnectorPolicyBinding): 'consumed' | 'invalidated' | 'missing' {
    return this.#database.transaction(() => {
      const row = this.#database.prepare(`SELECT transaction_id, installation_id AS installationId,
        user_id AS userId, ownership, provider_id AS providerId, service_id AS serviceId,
        account_id AS accountId, grant_id AS grantId, consumer_body AS consumerBody, operation, state
        FROM connector_policy_v2_oauth_pending WHERE transaction_id = ?`).get(transactionId) as PendingRow | undefined;
      if (!row || JSON.stringify(pendingBinding(row)) !== JSON.stringify(expected)) return 'missing';
      if (row.state !== 'pending') return row.state === 'invalidated' ? 'invalidated' : 'missing';
      this.#database.prepare(`UPDATE connector_policy_v2_oauth_pending SET state = 'consumed'
        WHERE transaction_id = ? AND state = 'pending'`).run(transactionId);
      return 'consumed';
    })();
  }

  recordPlacement(binding: ConnectorPolicyBinding, opaqueGrantRef: string): void {
    this.#database.transaction(() => {
      const values = this.recordGrantOwner(binding);
      this.#database.prepare(`INSERT OR REPLACE INTO connector_policy_v2_placement
        (installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,consumer_body,
         opaque_grant_ref,bridge_open) VALUES (?,?,?,?,?,?,?,?,?,1)`)
        .run(...values, binding.consumerBody, opaqueGrantRef);
    })();
  }

  beginPlacementIntent(binding: ConnectorPolicyBinding, opaqueGrantRef: string,
    expected: SnapshotRevision, nowMs: number): string {
    const intentId = randomUUID();
    const begin = this.#database.transaction(() => {
      const current = this.#read(binding.installationId);
      if (!sameRevision(current, expected) || connectorOperationKilled(current.kills, binding)) {
        throw new Error('connector_placement_intent_stale');
      }
      this.#database.prepare(`INSERT INTO connector_policy_v2_placement_intent
        (intent_id,installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,
         consumer_body,opaque_grant_ref,expected_revision_json,state,created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'applying',?)`).run(intentId, binding.installationId,
        binding.userId, binding.ownership, binding.providerId, binding.serviceId, binding.accountId,
        binding.grantId, binding.consumerBody, opaqueGrantRef, JSON.stringify(expected), nowMs);
    });
    begin.immediate();
    return intentId;
  }

  commitPlacementIntent(intentId: string): boolean {
    const commit = this.#database.transaction(() => {
      const row = this.#database.prepare(`SELECT installation_id AS installationId,
        user_id AS userId, ownership, provider_id AS providerId, service_id AS serviceId,
        account_id AS accountId, grant_id AS grantId, consumer_body AS consumerBody,
        opaque_grant_ref AS opaqueGrantRef, expected_revision_json AS expectedRevisionJson,
        state, created_at_ms AS createdAtMs, removal_origin_at_ms AS removalOriginAtMs,
        'placement.write' AS operation FROM connector_policy_v2_placement_intent
        WHERE intent_id = ?`).get(intentId) as PlacementIntentRow | undefined;
      if (!row) throw new Error('connector_placement_intent_missing');
      if (row.state === 'compensating') {
        this.#enqueueBinding(row, row.removalOriginAtMs ?? row.createdAtMs,
          `${row.intentId}:post-effect`);
        return false;
      }
      if (row.state !== 'applying') throw new Error('connector_placement_intent_replayed');
      const expected = JSON.parse(row.expectedRevisionJson) as SnapshotRevision;
      const current = this.#read(row.installationId);
      if (!sameRevision(current, expected) || connectorOperationKilled(current.kills, row)) {
        const originAtMs = row.removalOriginAtMs ?? row.createdAtMs;
        this.#enqueueBinding(row, originAtMs, `${row.intentId}:post-effect`);
        this.#database.prepare(`UPDATE connector_policy_v2_placement_intent SET state = 'compensating'
          , removal_origin_at_ms = COALESCE(removal_origin_at_ms, ?)
          WHERE intent_id = ? AND state = 'applying'`).run(originAtMs, intentId);
        return false;
      }
      this.recordPlacement(row, row.opaqueGrantRef);
      this.#database.prepare(`UPDATE connector_policy_v2_placement_intent SET state = 'committed'
        WHERE intent_id = ? AND state = 'applying'`).run(intentId);
      return true;
    });
    return commit.immediate();
  }

  recoverPlacementIntents(installationId: string): number {
    const recover = this.#database.transaction(() => {
      const rows = this.#intentRows(installationId);
      for (const row of rows) {
        const originAtMs = row.removalOriginAtMs ?? row.createdAtMs;
        this.#enqueueBinding(row, originAtMs, `${row.intentId}:recovery`);
        this.#database.prepare(`UPDATE connector_policy_v2_placement_intent SET state = 'compensating',
          removal_origin_at_ms = COALESCE(removal_origin_at_ms, ?)
          WHERE intent_id = ? AND state = 'applying'`).run(originAtMs, row.intentId);
      }
      return rows.length;
    });
    return recover.immediate();
  }

  compensatePlacementIntent(intentId: string): void {
    const compensate = this.#database.transaction(() => {
      const row = this.#database.prepare(`SELECT intent_id AS intentId,
        installation_id AS installationId, user_id AS userId, ownership,
        provider_id AS providerId, service_id AS serviceId, account_id AS accountId,
        grant_id AS grantId, consumer_body AS consumerBody, opaque_grant_ref AS opaqueGrantRef,
        expected_revision_json AS expectedRevisionJson, state, created_at_ms AS createdAtMs,
        removal_origin_at_ms AS removalOriginAtMs, 'placement.write' AS operation
        FROM connector_policy_v2_placement_intent WHERE intent_id = ?`).get(intentId) as PlacementIntentRow | undefined;
      if (!row || row.state === 'committed') return;
      const originAtMs = row.removalOriginAtMs ?? row.createdAtMs;
      this.#enqueueBinding(row, originAtMs, `${intentId}:effect-failed`);
      this.#database.prepare(`UPDATE connector_policy_v2_placement_intent SET state = 'compensating',
        removal_origin_at_ms = COALESCE(removal_origin_at_ms, ?)
        WHERE intent_id = ? AND state = 'applying'`).run(originAtMs, intentId);
    });
    compensate.immediate();
  }

  recordGrantOwner(binding: ConnectorPolicyBinding): readonly [string, number, string, string, string, string, string] {
    const values = [binding.installationId, binding.userId, binding.ownership, binding.providerId,
      binding.serviceId, binding.accountId, binding.grantId] as const;
    this.#database.prepare(`INSERT OR REPLACE INTO connector_policy_v2_grant_owner
      (installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,state)
      VALUES (?,?,?,?,?,?,?,'active')`).run(...values);
    return values;
  }

  claimGrantOwner(binding: ConnectorPolicyBinding): void {
    const values = [binding.installationId, binding.userId, binding.ownership, binding.providerId,
      binding.serviceId, binding.accountId, binding.grantId] as const;
    this.#database.prepare(`INSERT OR IGNORE INTO connector_policy_v2_grant_owner
      (installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,state)
      VALUES (?,?,?,?,?,?,?,'pending_cleanup')`).run(...values);
    if (!this.owns(binding)) throw new Error('connector_grant_owner_conflict');
  }

  finalizeGrantOwner(binding: ConnectorPolicyBinding): void {
    const result = this.#database.prepare(`UPDATE connector_policy_v2_grant_owner SET state = 'active'
      WHERE installation_id = ? AND user_id = ? AND ownership = ? AND provider_id = ?
        AND service_id = ? AND account_id = ? AND grant_id = ?`).run(binding.installationId,
      binding.userId, binding.ownership, binding.providerId, binding.serviceId,
      binding.accountId, binding.grantId);
    if (result.changes !== 1) throw new Error('connector_grant_owner_missing');
  }

  owns(binding: ConnectorPolicyBinding): boolean {
    return Boolean(this.#database.prepare(`SELECT 1 FROM connector_policy_v2_grant_owner
      WHERE installation_id = ? AND user_id = ? AND ownership = ? AND provider_id = ?
        AND service_id = ? AND account_id = ? AND grant_id = ?`).get(binding.installationId,
      binding.userId, binding.ownership, binding.providerId, binding.serviceId,
      binding.accountId, binding.grantId));
  }

  allows(binding: ConnectorPolicyBinding): boolean {
    return !connectorOperationKilled(this.#read(binding.installationId).kills, binding);
  }

  claimRemoval(nowMs: number, leaseMs: number): RemovalTask | null {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(leaseMs)
      || leaseMs < 1 || leaseMs > 30_000) throw new Error('connector_removal_lease_invalid');
    const claim = this.#database.transaction(() => {
      this.#database.prepare(`UPDATE connector_policy_v2_removal_queue SET state = 'pending',
        lease_until_ms = NULL, lease_token = NULL
        WHERE state = 'leased' AND lease_until_ms <= ?`).run(nowMs);
      const task = this.#database.prepare(`SELECT task_key AS taskKey, installation_id AS installationId,
        user_id AS userId, ownership, provider_id AS providerId, service_id AS serviceId,
        account_id AS accountId, grant_id AS grantId, target, target AS consumerBody,
        enqueued_at_ms AS enqueuedAtMs, attempts
        FROM connector_policy_v2_removal_queue WHERE state = 'pending'
        ORDER BY enqueued_at_ms, task_key LIMIT 1`).get() as Omit<RemovalTask, 'leaseToken'> | undefined;
      if (!task) return null;
      const leaseToken = randomUUID();
      const updated = this.#database.prepare(`UPDATE connector_policy_v2_removal_queue SET state = 'leased',
        lease_until_ms = ?, lease_token = ?, attempts = attempts + 1
        WHERE task_key = ? AND state = 'pending'`).run(nowMs + leaseMs, leaseToken, task.taskKey);
      if (updated.changes !== 1) throw new Error('connector_removal_claim_conflict');
      return { ...task, attempts: task.attempts + 1, leaseToken };
    });
    return claim.immediate();
  }

  completeRemoval(task: RemovalTask, completedAtMs: number): void {
    this.#database.transaction(() => {
      const completed = this.#database.prepare(`UPDATE connector_policy_v2_removal_queue SET state = 'done',
        completed_at_ms = ?, lease_until_ms = NULL, lease_token = NULL
        WHERE task_key = ? AND state = 'leased' AND lease_token = ? AND lease_until_ms > ?`)
        .run(completedAtMs, task.taskKey, task.leaseToken, completedAtMs);
      if (completed.changes !== 1) throw new Error('connector_removal_lease_stale');
      const outstanding = this.#database.prepare(`SELECT 1 FROM connector_policy_v2_removal_queue
        WHERE installation_id = ? AND user_id = ? AND ownership = ? AND provider_id = ?
          AND service_id = ? AND account_id = ? AND grant_id = ? AND state != 'done' LIMIT 1`)
        .get(task.installationId, task.userId, task.ownership, task.providerId, task.serviceId,
          task.accountId, task.grantId);
      if (!outstanding) this.#database.prepare(`DELETE FROM connector_policy_v2_placement
        WHERE installation_id = ? AND user_id = ? AND ownership = ? AND provider_id = ?
          AND service_id = ? AND account_id = ? AND grant_id = ?`)
        .run(task.installationId, task.userId, task.ownership, task.providerId, task.serviceId,
          task.accountId, task.grantId);
    })();
  }

  removalTelemetry(nowMs: number, slaMs = 30_000): RemovalTelemetry {
    const row = this.#database.prepare(`SELECT
      SUM(CASE WHEN state != 'done' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state != 'done' AND ? - enqueued_at_ms > ? THEN 1 ELSE 0 END) AS overdue
      FROM connector_policy_v2_removal_queue`).get(nowMs, slaMs) as Record<string, number | null>;
    const latencies: Array<{ latency: number }> = this.#database.prepare(
      `SELECT completed_at_ms - enqueued_at_ms AS latency FROM connector_policy_v2_removal_queue
       WHERE completed_at_ms IS NOT NULL ORDER BY latency`,
    ).all() as Array<{ latency: number }>;
    const p99Index = Math.max(0, Math.ceil(latencies.length * 0.99) - 1);
    const p99LatencyMs = latencies[p99Index]?.latency ?? 0;
    const pending = row.pending ?? 0; const overdue = row.overdue ?? 0;
    return { pending, overdue, p99LatencyMs, withinSla: overdue === 0 && p99LatencyMs <= slaMs, slaMs };
  }

  killRevision(installationId: string): number { return this.#read(installationId).killRevision; }

  #read(installationId: string): ConnectorPolicyState {
    const row = this.#database.prepare(`SELECT state_json, kill_revision FROM connector_policy_v2_state
      WHERE installation_id = ?`).get(installationId) as StateRow | undefined;
    return parseState(row);
  }

  #pendingOauthCount(installationId: string): number {
    const row = this.#database.prepare(`SELECT COUNT(*) AS count FROM connector_policy_v2_oauth_pending
      WHERE installation_id = ? AND state = 'pending'`).get(installationId) as { count: number };
    return row.count;
  }

  #invalidateInstallationCapabilities(installationId: string, nowMs: number): void {
    this.#database.prepare(`UPDATE connector_policy_v2_capability_nonce SET consumed_at = ?
      WHERE installation_id = ? AND consumed_at IS NULL`)
      .run(new Date(nowMs).toISOString(), installationId);
  }

  #hasInstallationEffects(installationId: string): boolean {
    const tables = ['connector_policy_v2_capability_nonce', 'connector_policy_v2_oauth_pending',
      'connector_policy_v2_placement', 'connector_policy_v2_grant_owner',
      'connector_policy_v2_placement_intent', 'connector_policy_v2_removal_queue'];
    return tables.some(table => Boolean(this.#database.prepare(
      `SELECT 1 FROM ${table} WHERE installation_id = ? LIMIT 1`,
    ).get(installationId)));
  }

  #consume(input: CapabilityConsumption): boolean {
    const row = this.#database.prepare(`SELECT record_json, consumed_at FROM connector_policy_v2_capability_nonce
      WHERE nonce = ? AND installation_id = ?`).get(input.nonce, input.installationId) as CapabilityRow | undefined;
    if (!row || row.consumed_at !== null) return false;
    this.#database.prepare(`UPDATE connector_policy_v2_capability_nonce SET consumed_at = ?
      WHERE nonce = ? AND consumed_at IS NULL`).run(input.now, input.nonce);
    const record = JSON.parse(row.record_json) as CapabilityRegistration;
    return record.bindingDigest === input.bindingDigest && record.subjectDigest === input.subjectDigest
      && record.issuedAt <= input.now && record.expiresAt > input.now
      && capabilityCurrent(record, this.#read(input.installationId));
  }

  #invalidatePending(installationId: string, kills: ConnectorKillRules, nowMs: number): void {
    const rows = this.#database.prepare(`SELECT transaction_id, installation_id AS installationId,
      user_id AS userId, ownership, provider_id AS providerId, service_id AS serviceId,
      account_id AS accountId, grant_id AS grantId, consumer_body AS consumerBody,
      operation, state FROM connector_policy_v2_oauth_pending
      WHERE installation_id = ? AND state = 'pending'`).all(installationId) as PendingRow[];
    const update = this.#database.prepare(`UPDATE connector_policy_v2_oauth_pending
      SET state = 'invalidated', invalidated_at_ms = ? WHERE transaction_id = ? AND state = 'pending'`);
    for (const row of rows) if (connectorOperationKilled(kills, pendingBinding(row))) {
      update.run(nowMs, row.transaction_id);
    }
  }

  #enqueueMatchingPlacements(installationId: string, kills: ConnectorKillRules, nowMs: number): void {
    const rows = this.#database.prepare(`SELECT installation_id AS installationId, user_id AS userId,
      ownership, provider_id AS providerId, service_id AS serviceId, account_id AS accountId,
      grant_id AS grantId, consumer_body AS consumerBody, 'placement.write' AS operation
      FROM connector_policy_v2_placement WHERE installation_id = ?`).all(installationId) as ConnectorPolicyBinding[];
    for (const row of rows) if (placementAffectedByKill(kills, row)) this.#enqueueBinding(row, nowMs);
  }

  #intentRows(installationId: string): PlacementIntentRow[] {
    return this.#database.prepare(`SELECT intent_id AS intentId, installation_id AS installationId,
      user_id AS userId, ownership, provider_id AS providerId, service_id AS serviceId,
      account_id AS accountId, grant_id AS grantId, consumer_body AS consumerBody,
      opaque_grant_ref AS opaqueGrantRef, expected_revision_json AS expectedRevisionJson,
      state, created_at_ms AS createdAtMs, removal_origin_at_ms AS removalOriginAtMs,
      'placement.write' AS operation FROM connector_policy_v2_placement_intent
      WHERE installation_id = ? AND state = 'applying'`).all(installationId) as PlacementIntentRow[];
  }

  #compensateMatchingIntents(installationId: string, kills: ConnectorKillRules, nowMs: number): void {
    for (const row of this.#intentRows(installationId)) if (placementAffectedByKill(kills, row)) {
      this.#enqueueBinding(row, nowMs, `${row.intentId}:kill`);
      this.#database.prepare(`UPDATE connector_policy_v2_placement_intent SET state = 'compensating',
        removal_origin_at_ms = COALESCE(removal_origin_at_ms, ?)
        WHERE intent_id = ? AND state = 'applying'`).run(nowMs, row.intentId);
    }
  }

  #enqueueBinding(row: ConnectorPolicyBinding, nowMs: number, generation = 'current'): void {
    const insert = this.#database.prepare(`INSERT OR IGNORE INTO connector_policy_v2_removal_queue
      (task_key,installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,
       target,state,enqueued_at_ms) VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`);
    const targets = [row.consumerBody, 'bridge'] as const;
    for (const target of targets) insert.run(
      removalTaskKey(row, target, generation),
      row.installationId, row.userId, row.ownership, row.providerId, row.serviceId,
      row.accountId, row.grantId, target, nowMs);
  }
}

export type RemovalTask = Readonly<{ taskKey: string; installationId: string; userId: number;
  ownership: string; providerId: string; serviceId: string; accountId: string; grantId: string;
  target: 'claude' | 'codex' | 'bridge'; consumerBody: 'claude' | 'codex' | 'bridge';
  enqueuedAtMs: number; attempts: number; leaseToken: string }>;
export type RemovalTelemetry = Readonly<{ pending: number; overdue: number; p99LatencyMs: number;
  withinSla: boolean; slaMs: number }>;

/** Poll-based durable revision watcher. Polling above 60 seconds is rejected. */
export class ConnectorKillRevisionWatcher {
  readonly #store: SqliteConnectorPolicyV2Store;
  readonly #installationId: string;
  readonly intervalMs: number;
  #seen: number;

  constructor(store: SqliteConnectorPolicyV2Store, installationId: string, intervalMs: number) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 30_000) {
      throw new Error('connector_kill_watch_interval_invalid');
    }
    this.#store = store; this.#installationId = installationId; this.intervalMs = intervalMs;
    this.#seen = store.killRevision(installationId);
  }

  poll(): boolean {
    const revision = this.#store.killRevision(this.#installationId);
    const changed = revision !== this.#seen;
    this.#seen = revision;
    return changed;
  }
}

/** Active inert runner; cutover owns its lifecycle and must stop it during shutdown. */
export class ConnectorKillRevisionWatchRunner {
  readonly #watcher: ConnectorKillRevisionWatcher;
  readonly #onChange: () => void;
  #timer: NodeJS.Timeout | null = null;

  constructor(watcher: ConnectorKillRevisionWatcher, onChange: () => void) {
    this.#watcher = watcher; this.#onChange = onChange;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void runLocalUpdateBackground('connector-kill-revision', () => {
        if (this.#watcher.poll()) return this.#onChange();
      }).catch(() => { /* preserve the cursor until the next admitted poll */ });
    }, this.#watcher.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
