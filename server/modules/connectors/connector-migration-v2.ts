/** Inert M4 migration engine. It never imports live repositories or performs crypto-shred. */

import { createHash, randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import {
  ConnectorPolicyOperation,
  resolveConnectorPolicy,
  type ConnectorCertificationBinding,
  type ConnectorKillRules,
  type ConnectorPolicySnapshot,
} from './connector-policy-v2.js';

export type ConnectorCredentialGeneration = 'legacy' | 'm1' | 'm2';
export type MigrationAccountKey = Readonly<{ installationId: string; sourceId: string }>;
export type MigrationState = 'inventory' | 'legacy_read_pending' | 'legacy_read' | 'shaped' | 'verified' | 'candidate'
  | 'promoted' | 'placements_confirmed' | 'cleanup_pending' | 'quarantined' | 'failed';

export type SecretFreeLegacyInventory = Readonly<{
  sourceId: string; installationId: string; userId: number; ownership: 'personal' | 'team';
  providerId: string; serviceId: string; accountId: string; grantId: string;
  generation: ConnectorCredentialGeneration | 'unknown'; provenanceMarkers: readonly string[];
  envelopeDigest: string; corrupt: boolean;
}>;

type MigrationPolicyAuthority = Readonly<{
  installationId: string; userId: number; ownership: 'personal' | 'team'; providerId: string;
  serviceId: string; accountId: string; grantId: string; snapshot: ConnectorPolicySnapshot;
  certification: ConnectorCertificationBinding; kills: ConnectorKillRules;
  issuedAtMs: number; expiresAtMs: number;
}>;
const migrationPolicyAuthorities = new WeakMap<ConnectorMigrationPolicyCapability, MigrationPolicyAuthority>();
const consumedMigrationPolicies = new WeakSet<ConnectorMigrationPolicyCapability>();

/** Opaque certified Policy V2 decision fixture; production will receive it from the policy authority. */
export class ConnectorMigrationPolicyCapability {
  private constructor() { Object.freeze(this); }
  static fixture(authority: MigrationPolicyAuthority): ConnectorMigrationPolicyCapability {
    const capability = new ConnectorMigrationPolicyCapability();
    migrationPolicyAuthorities.set(capability, authority); return capability;
  }
  toJSON(): never { throw new Error('connector_migration_policy_capability_not_serializable'); }
}

export const CONNECTOR_MIGRATION_V2_ENABLED = false as const;
export const CONNECTOR_MIGRATION_V2_CUTOVER_EXIT_CONDITIONS = Object.freeze([
  'write_and_read_v2_presence_from_the_canonical_M2_fenced_authority',
  'add_all_migration_tables_to_the_M2_guarded_inventory_before_activation',
  'start_no_migration_when_canonical_v2_authority_is_unavailable',
]);
export const CONNECTOR_MIGRATION_V2_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connector_migration_v2_installation (
  installation_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode = 'legacy_quarantined'),
  v2_marker_present INTEGER NOT NULL CHECK (v2_marker_present IN (0,1))
);
CREATE TABLE IF NOT EXISTS connector_migration_v2_account (
  source_id TEXT NOT NULL,
  installation_id TEXT NOT NULL, user_id INTEGER NOT NULL, ownership TEXT NOT NULL,
  provider_id TEXT NOT NULL, service_id TEXT NOT NULL, account_id TEXT NOT NULL, grant_id TEXT NOT NULL,
  generation TEXT NOT NULL CHECK (generation IN ('legacy','m1','m2','unknown')),
  envelope_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('inventory','legacy_read_pending','legacy_read','shaped',
    'verified','candidate','promoted','placements_confirmed','cleanup_pending','quarantined','failed')),
  revision INTEGER NOT NULL DEFAULT 1, source_revision INTEGER NOT NULL DEFAULT 1,
  candidate_revision INTEGER,
  lease_token TEXT, lease_fence INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER,
  failure_code TEXT,
  inventory_fingerprint TEXT NOT NULL,
  verification_digest TEXT, verification_manifest_digest TEXT,
  verification_contract_revision INTEGER, verification_source_revision INTEGER,
  verification_inventory_fingerprint TEXT,
  PRIMARY KEY (installation_id,source_id)
);
CREATE TABLE IF NOT EXISTS connector_migration_v2_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, installation_id TEXT NOT NULL, source_id TEXT NOT NULL,
  event TEXT NOT NULL, at_ms INTEGER NOT NULL, detail_code TEXT NOT NULL
);
`;

export type OwnerAuthority = Readonly<{ installationId: string; userId: number; csrfVerified: true;
  consent: 'migrate_connectors'; issuedAtMs: number; expiresAtMs: number }>;
const ownerAuthorities = new WeakMap<ConnectorMigrationOwnerCapability, OwnerAuthority>();

/** Opaque trusted fixture representing upstream recent-auth, CSRF, and explicit consent. */
export class ConnectorMigrationOwnerCapability {
  private constructor() { Object.freeze(this); }
  static fixture(authority: OwnerAuthority): ConnectorMigrationOwnerCapability {
    const capability = new ConnectorMigrationOwnerCapability(); ownerAuthorities.set(capability, authority);
    return capability;
  }
  toJSON(): never { throw new Error('connector_migration_owner_capability_not_serializable'); }
}

const consumedAuthorities = new WeakSet<ConnectorMigrationOwnerCapability>();
const consumeAuthority = (capability: ConnectorMigrationOwnerCapability, installationId: string,
  userId: number, nowMs: number): boolean => {
  const authority = ownerAuthorities.get(capability);
  if (!authority || consumedAuthorities.has(capability)) return false;
  consumedAuthorities.add(capability);
  return authority.installationId === installationId && authority.userId === userId
    && authority.csrfVerified && authority.consent === 'migrate_connectors'
    && authority.issuedAtMs <= nowMs && authority.expiresAtMs > nowMs;
};

export type MigrationAdapters = Readonly<{
  readLegacyOnce(key: MigrationAccountKey, idempotencyKey: string): Promise<void>;
  shape(key: MigrationAccountKey, idempotencyKey: string): Promise<void>;
  verifyLive(key: MigrationAccountKey, providerId: string, serviceId: string): Promise<Readonly<{
    verified: boolean; certificationDigest: string;
  }>>;
  writeM2Candidate(key: MigrationAccountKey, candidateRevision: number, idempotencyKey: string): Promise<void>;
  promoteCandidateCas(key: MigrationAccountKey, expectedRevision: number, candidateRevision: number):
    Promise<'promoted' | 'already_promoted' | 'conflict'>;
  confirmRevisionPlacements(key: MigrationAccountKey, candidateRevision: number): Promise<boolean>;
}>;

type AccountRow = {
  source_id: string; installation_id: string; user_id: number; ownership: 'personal' | 'team';
  provider_id: string; service_id: string; account_id: string; grant_id: string;
  state: MigrationState; revision: number; candidate_revision: number | null;
  source_revision: number;
  inventory_fingerprint: string;
  lease_token: string | null; lease_fence: number; lease_until_ms: number | null;
};

const migrationStates = new Set<MigrationState>(['inventory', 'legacy_read_pending', 'legacy_read', 'shaped', 'verified',
  'candidate', 'promoted', 'placements_confirmed', 'cleanup_pending', 'quarantined', 'failed']);
const transitionGraph: Readonly<Record<string, MigrationState>> = Object.freeze({
  inventory: 'legacy_read_pending', legacy_read_pending: 'legacy_read', legacy_read: 'shaped',
  shaped: 'verified', verified: 'candidate', candidate: 'promoted',
  promoted: 'placements_confirmed', placements_confirmed: 'cleanup_pending',
});
const auditEvents = new Set(['inventory.inventory', 'inventory.quarantined', 'inventory.idempotent',
  ...[...migrationStates].map(state => `state.${state}`)]);
const auditDetails = new Set(['ok', 'provenance', 'collision', 'source_collision', 'verify_rejected']);
const idValid = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const digestValid = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/u.test(value);
const operationKey = (key: MigrationAccountKey, stage: string, revision = 0): string => createHash('sha256')
  .update('NASSAJ\0CONNECTOR_MIGRATION_OPERATION\0V2\0')
  .update(JSON.stringify([key.installationId, key.sourceId, stage, revision])).digest('base64url');

export class ConnectorMigrationV2Store {
  readonly #database: Database;

  constructor(database: Database) { this.#database = database; database.exec(CONNECTOR_MIGRATION_V2_SCHEMA_SQL); }

  inventory(installationId: string, items: readonly SecretFreeLegacyInventory[],
    v2MarkerPresent: boolean, nowMs: number): void {
    if (items.some(item => item.installationId !== installationId)) {
      throw new Error('connector_migration_inventory_mixed_installation');
    }
    const marker = v2MarkerPresent || items.some(item => item.generation === 'm2');
    if (marker) {
      this.#database.prepare(`INSERT INTO connector_migration_v2_installation
        (installation_id,mode,v2_marker_present) VALUES (?,'legacy_quarantined',1)
        ON CONFLICT(installation_id) DO UPDATE SET v2_marker_present = 1`).run(installationId);
      throw new Error('connector_migration_v2_fallback_blocked');
    }
    if (this.#hasAnyV2State(installationId)) throw new Error('connector_migration_v2_fallback_blocked');
    if (items.length === 0) return;
    const keyCounts = new Map<string, number>();
    for (const item of items) {
      const key = this.#identityKey(item); keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
    const run = this.#database.transaction(() => {
      this.#database.prepare(`INSERT OR IGNORE INTO connector_migration_v2_installation
        (installation_id,mode,v2_marker_present) VALUES (?,'legacy_quarantined',0)`).run(installationId);
      for (const item of items) this.#inventoryOne(item, (keyCounts.get(this.#identityKey(item)) ?? 0) > 1, nowMs);
    });
    run.immediate();
  }

  acquire(key: MigrationAccountKey, ownerToken: string, nowMs: number, leaseMs: number): MigrationLease {
    if (!idValid(ownerToken) || !Number.isSafeInteger(nowMs) || nowMs < 0
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 30_000) {
      throw new Error('migration_lease_invalid');
    }
    return this.#database.transaction(() => {
      const row = this.#read(key);
      if (row.lease_until_ms !== null && row.lease_until_ms > nowMs) throw new Error('migration_lease_busy');
      const token = randomUUID(); const fence = row.lease_fence + 1;
      const acquired = this.#database.prepare(`UPDATE connector_migration_v2_account SET lease_token = ?,
        lease_fence = ?, lease_until_ms = ? WHERE installation_id = ? AND source_id = ? AND lease_fence = ?`)
        .run(token, fence, nowMs + leaseMs, key.installationId, key.sourceId, row.lease_fence);
      if (acquired.changes !== 1) throw new Error('migration_lease_conflict');
      return Object.freeze({ ...key, ownerToken, token, fence, expiresAtMs: nowMs + leaseMs });
    }).immediate();
  }

  transition(lease: MigrationLease, expected: MigrationState, next: MigrationState,
    nowMs: number, mutation: Readonly<{ candidateRevision?: number; sourceRevision?: number;
      failureCode?: string; verificationDigest?: string; verificationManifestDigest?: string;
      verificationContractRevision?: number; verificationSourceRevision?: number;
      verificationInventoryFingerprint?: string }> = {}): void {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('migration_transition_time_invalid');
    if (!migrationStates.has(next)) throw new Error('migration_state_invalid');
    if (transitionGraph[expected] !== next && !(expected === 'shaped' && next === 'failed')) {
      throw new Error('migration_transition_graph_rejected');
    }
    const mutationKeys = Object.keys(mutation).filter(key => mutation[key as keyof typeof mutation] !== undefined).sort();
    const expectedKeys = expected === 'shaped' && next === 'verified'
      ? ['verificationContractRevision', 'verificationDigest', 'verificationInventoryFingerprint',
        'verificationManifestDigest', 'verificationSourceRevision']
      : expected === 'shaped' && next === 'failed' ? ['failureCode']
        : expected === 'verified' ? ['candidateRevision']
          : expected === 'candidate' ? ['sourceRevision'] : [];
    if (JSON.stringify(mutationKeys) !== JSON.stringify(expectedKeys)
      || (mutation.candidateRevision !== undefined && mutation.candidateRevision < 2)
      || (mutation.sourceRevision !== undefined && mutation.sourceRevision < 2)
      || (mutation.verificationDigest !== undefined && !digestValid(mutation.verificationDigest))
      || (mutation.verificationManifestDigest !== undefined
        && !/^[A-Za-z0-9_-]{86}$/u.test(mutation.verificationManifestDigest))
      || (mutation.verificationContractRevision !== undefined
        && (!Number.isSafeInteger(mutation.verificationContractRevision)
          || mutation.verificationContractRevision < 1))
      || (mutation.verificationSourceRevision !== undefined
        && (!Number.isSafeInteger(mutation.verificationSourceRevision)
          || mutation.verificationSourceRevision < 1))
      || (mutation.verificationInventoryFingerprint !== undefined
        && !digestValid(mutation.verificationInventoryFingerprint))) {
      throw new Error('migration_transition_mutation_rejected');
    }
    const detail = mutation.failureCode ?? 'ok';
    if (!auditDetails.has(detail)) throw new Error('migration_audit_code_rejected');
    const run = this.#database.transaction(() => {
      const current = this.#read({ installationId: lease.installationId, sourceId: lease.sourceId });
      if ((expected === 'verified' && mutation.candidateRevision !== current.source_revision + 1)
        || (expected === 'candidate' && mutation.sourceRevision !== current.candidate_revision)
        || (expected === 'shaped' && next === 'failed' && mutation.failureCode !== 'verify_rejected')) {
        throw new Error('migration_transition_relation_rejected');
      }
      const result = this.#database.prepare(`UPDATE connector_migration_v2_account SET state = ?,
        candidate_revision = COALESCE(?,candidate_revision), failure_code = ?, revision = revision + 1,
        source_revision = COALESCE(?,source_revision),
        verification_digest = COALESCE(?,verification_digest),
        verification_manifest_digest = COALESCE(?,verification_manifest_digest),
        verification_contract_revision = COALESCE(?,verification_contract_revision),
        verification_source_revision = COALESCE(?,verification_source_revision),
        verification_inventory_fingerprint = COALESCE(?,verification_inventory_fingerprint),
        lease_token = NULL, lease_until_ms = NULL
        WHERE installation_id = ? AND source_id = ? AND state = ?
          AND lease_token = ? AND lease_fence = ? AND lease_until_ms > ?`)
        .run(next, mutation.candidateRevision ?? null, mutation.failureCode ?? null,
          mutation.sourceRevision ?? null, mutation.verificationDigest ?? null,
          mutation.verificationManifestDigest ?? null, mutation.verificationContractRevision ?? null,
          mutation.verificationSourceRevision ?? null, mutation.verificationInventoryFingerprint ?? null,
          lease.installationId, lease.sourceId,
          expected, lease.token, lease.fence, nowMs);
      if (result.changes !== 1) throw new Error('migration_transition_stale');
      this.#insertAudit({ installationId: lease.installationId, sourceId: lease.sourceId },
        `state.${next}`, nowMs, detail);
    });
    run.immediate();
  }

  read(key: MigrationAccountKey): Readonly<{ state: MigrationState; revision: number;
    sourceRevision: number; candidateRevision: number | null; failureCode: string | null }> {
    const row = this.#database.prepare(`SELECT state,revision,candidate_revision AS candidateRevision,
      source_revision AS sourceRevision, failure_code AS failureCode
      FROM connector_migration_v2_account WHERE installation_id = ? AND source_id = ?`)
      .get(key.installationId, key.sourceId) as {
        state: MigrationState; revision: number; sourceRevision: number;
        candidateRevision: number | null; failureCode: string | null;
      } | undefined;
    if (!row) throw new Error('migration_account_missing');
    return Object.freeze(row);
  }

  metadata(key: MigrationAccountKey): Readonly<{ installationId: string; userId: number;
    ownership: 'personal' | 'team'; providerId: string; serviceId: string;
    accountId: string; grantId: string }> {
    const row = this.#read(key);
    return Object.freeze({ installationId: row.installation_id, userId: row.user_id,
      ownership: row.ownership, providerId: row.provider_id, serviceId: row.service_id,
      accountId: row.account_id, grantId: row.grant_id });
  }

  issueLegacyContinuation(key: MigrationAccountKey, capturedAtMs: number, deadlineMs: number,
    policyEpoch: number): LegacyContinuationCapability {
    const row = this.#read(key);
    if (!['inventory', 'legacy_read_pending', 'legacy_read', 'shaped', 'verified'].includes(row.state)
      || this.#hasAnyV2State(row.installation_id) || deadlineMs <= capturedAtMs
      || deadlineMs - capturedAtMs > 86_400_000) throw new Error('legacy_continuation_issue_rejected');
    return LegacyContinuationCapability.create(legacySnapshotAuthority, {
      installationId: row.installation_id, sourceId: key.sourceId, capturedAtMs, deadlineMs, policyEpoch,
      rowRevision: row.revision, inventoryFingerprint: row.inventory_fingerprint,
    });
  }

  evaluateLegacyContinuation(snapshot: LegacyContinuationCapability,
    expected: Readonly<{ installationId: string; sourceId: string; policyEpoch: number }>, nowMs: number): boolean {
    const record = legacySnapshots.get(snapshot);
    if (!record || this.#hasAnyV2State(expected.installationId)) return false;
    const row = this.#readOptional({ installationId: expected.installationId, sourceId: expected.sourceId });
    if (!row || !['inventory', 'legacy_read_pending', 'legacy_read', 'shaped', 'verified'].includes(row.state)
      || row.revision !== record.rowRevision
      || row.inventory_fingerprint !== record.inventoryFingerprint) return false;
    return record.installationId === expected.installationId && record.sourceId === expected.sourceId
      && record.policyEpoch === expected.policyEpoch && record.capturedAtMs <= nowMs
      && nowMs < record.deadlineMs && record.deadlineMs - record.capturedAtMs <= 86_400_000;
  }

  verificationEvidenceMatches(key: MigrationAccountKey,
    certification: ConnectorCertificationBinding): boolean {
    const row = this.#database.prepare(`SELECT verification_digest,verification_manifest_digest,
      verification_contract_revision,verification_source_revision,
      verification_inventory_fingerprint,source_revision,inventory_fingerprint
      FROM connector_migration_v2_account
      WHERE installation_id = ? AND source_id = ?`).get(key.installationId, key.sourceId) as {
        verification_digest: string | null; verification_manifest_digest: string | null;
        verification_contract_revision: number | null; verification_source_revision: number | null;
        verification_inventory_fingerprint: string | null; source_revision: number;
        inventory_fingerprint: string;
      } | undefined;
    return Boolean(row && row.verification_digest === certification.contractDigest
      && row.verification_manifest_digest === certification.manifestDigest
      && row.verification_contract_revision === certification.contractRevision
      && row.verification_source_revision === row.source_revision
      && row.verification_inventory_fingerprint === row.inventory_fingerprint);
  }

  verificationSubject(key: MigrationAccountKey): Readonly<{ sourceRevision: number;
    inventoryFingerprint: string }> {
    const row = this.#read(key);
    return { sourceRevision: row.source_revision, inventoryFingerprint: row.inventory_fingerprint };
  }

  audit(key: MigrationAccountKey, event: string, atMs: number, detailCode: string): void {
    if (!auditEvents.has(event) || !auditDetails.has(detailCode)) throw new Error('migration_audit_code_rejected');
    if (!Number.isSafeInteger(atMs) || atMs < 0 || !this.#readOptional(key)) {
      throw new Error('migration_audit_subject_rejected');
    }
    this.#insertAudit(key, event, atMs, detailCode);
  }

  #insertAudit(key: MigrationAccountKey, event: string, atMs: number, detailCode: string): void {
    this.#database.prepare(`INSERT INTO connector_migration_v2_audit
      (installation_id,source_id,event,at_ms,detail_code) VALUES (?,?,?,?,?)`)
      .run(key.installationId, key.sourceId, event, atMs, detailCode);
  }

  #inventoryOne(item: SecretFreeLegacyInventory, collision: boolean, nowMs: number): void {
    const fingerprint = createHash('sha256').update('NASSAJ\0MIGRATION_INVENTORY\0V2\0')
      .update(JSON.stringify([item.installationId, item.sourceId, item.userId, item.ownership,
        item.providerId, item.serviceId, item.accountId, item.grantId, item.generation,
        [...item.provenanceMarkers].sort(), item.envelopeDigest, item.corrupt])).digest('base64url');
    const invalid = !Number.isSafeInteger(item.userId) || item.userId < 1
      || !['personal', 'team'].includes(item.ownership)
      || ![item.sourceId, item.installationId, item.providerId, item.serviceId,
      item.accountId, item.grantId].every(idValid) || !digestValid(item.envelopeDigest);
    const ambiguous = item.generation === 'unknown' || item.provenanceMarkers.length !== 1
      || item.provenanceMarkers[0] !== item.generation;
    const state: MigrationState = invalid || ambiguous || item.corrupt || collision
      ? 'quarantined' : 'inventory';
    const existing = this.#database.prepare(`SELECT inventory_fingerprint,state
      FROM connector_migration_v2_account WHERE installation_id = ? AND source_id = ?`)
      .get(item.installationId, item.sourceId) as { inventory_fingerprint: string; state: string } | undefined;
    if (existing) {
      const exact = existing.inventory_fingerprint === fingerprint;
      if (!exact) this.#database.prepare(`UPDATE connector_migration_v2_account
        SET state = 'quarantined', failure_code = 'source_collision'
        WHERE installation_id = ? AND source_id = ?`).run(item.installationId, item.sourceId);
      this.audit({ installationId: item.installationId, sourceId: item.sourceId },
        exact ? 'inventory.idempotent' : 'inventory.quarantined',
        nowMs, exact ? 'ok' : 'source_collision');
      return;
    }
    try {
      this.#database.prepare(`INSERT INTO connector_migration_v2_account
        (source_id,installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,
         generation,envelope_digest,state,inventory_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.sourceId,
        item.installationId, item.userId, item.ownership, item.providerId, item.serviceId,
        item.accountId, item.grantId, item.generation, item.envelopeDigest, state, fingerprint);
    } catch { this.audit({ installationId: item.installationId, sourceId: item.sourceId },
      'inventory.quarantined', nowMs, 'collision'); return; }
    this.audit({ installationId: item.installationId, sourceId: item.sourceId },
      `inventory.${state}`, nowMs, state === 'inventory' ? 'ok' : 'provenance');
  }

  #identityKey(item: SecretFreeLegacyInventory): string {
    return JSON.stringify([item.installationId, item.userId, item.ownership, item.providerId,
      item.serviceId, item.accountId, item.grantId]);
  }

  #hasAnyV2State(installationId: string): boolean {
    return Boolean(this.#database.prepare(`SELECT 1 FROM connector_migration_v2_installation
      WHERE installation_id = ? AND v2_marker_present = 1 LIMIT 1`).get(installationId)
      || this.#database.prepare(`SELECT 1 FROM connector_migration_v2_account
        WHERE installation_id = ? AND (generation = 'm2' OR state IN
          ('candidate','promoted','placements_confirmed','cleanup_pending')) LIMIT 1`).get(installationId));
  }

  #readOptional(key: MigrationAccountKey): AccountRow | undefined {
    return this.#database.prepare(`SELECT * FROM connector_migration_v2_account
      WHERE installation_id = ? AND source_id = ?`).get(key.installationId, key.sourceId) as AccountRow | undefined;
  }

  #read(key: MigrationAccountKey): AccountRow {
    const row = this.#readOptional(key);
    if (!row) throw new Error('migration_account_missing');
    return row;
  }
}

export type MigrationLease = Readonly<{ sourceId: string; ownerToken: string; token: string;
  installationId: string; fence: number; expiresAtMs: number }>;

export class ConnectorMigrationV2Engine {
  constructor(private readonly store: ConnectorMigrationV2Store,
    private readonly adapters: MigrationAdapters, private readonly nowMs: () => number,
    private readonly policyCapability: (key: MigrationAccountKey,
      operation: ConnectorPolicyOperation) => ConnectorMigrationPolicyCapability) {}

  async migrate(key: MigrationAccountKey, owner: ConnectorMigrationOwnerCapability,
    userId: number): Promise<MigrationState> {
    const now = this.nowMs();
    const metadata = this.store.metadata(key);
    if (metadata.userId !== userId
      || !consumeAuthority(owner, metadata.installationId, userId, now)) {
      throw new Error('migration_owner_authority_rejected');
    }
    this.#requireAllowed(key, ConnectorPolicyOperation.CredentialVerify);
    for (let steps = 0; steps < 8; steps += 1) {
      const current = this.store.read(key);
      if (['cleanup_pending', 'quarantined', 'failed'].includes(current.state)) return current.state;
      await this.#step(key, current);
    }
    return this.store.read(key).state;
  }

  async #step(key: MigrationAccountKey, current: ReturnType<ConnectorMigrationV2Store['read']>): Promise<void> {
    const operation = this.#operationForState(current.state);
    this.#requireAllowed(key, operation);
    const lease = this.store.acquire(key, 'migration-engine', this.nowMs(), 30_000);
    if (current.state === 'inventory') {
      this.store.transition(lease, 'inventory', 'legacy_read_pending', this.nowMs());
    } else if (current.state === 'legacy_read_pending') {
      await this.adapters.readLegacyOnce(key, operationKey(key, 'legacy_read'));
      this.#requireAllowed(key, operation);
      this.store.transition(lease, 'legacy_read_pending', 'legacy_read', this.nowMs());
    } else if (current.state === 'legacy_read') {
      await this.adapters.shape(key, operationKey(key, 'shape'));
      this.#requireAllowed(key, operation);
      this.store.transition(lease, 'legacy_read', 'shaped', this.nowMs());
    }
    else if (current.state === 'shaped') await this.#verify(lease);
    else if (current.state === 'verified') await this.#candidate(lease, current.sourceRevision + 1);
    else if (current.state === 'candidate') await this.#promote(lease, current);
    else if (current.state === 'promoted') await this.#confirm(lease, current);
    else if (current.state === 'placements_confirmed') {
      this.store.transition(lease, 'placements_confirmed', 'cleanup_pending', this.nowMs());
    }
  }

  async #verify(lease: MigrationLease): Promise<void> {
    const key = { installationId: lease.installationId, sourceId: lease.sourceId };
    const row = this.store.metadata(key);
    const result = await this.adapters.verifyLive(key, row.providerId, row.serviceId);
    if (!result.verified || !digestValid(result.certificationDigest)) {
      this.store.transition(lease, 'shaped', 'failed', this.nowMs(), { failureCode: 'verify_rejected' }); return;
    }
    const authority = this.#requireAllowed(key, ConnectorPolicyOperation.CredentialVerify);
    if (result.certificationDigest !== authority.certification.contractDigest) {
      throw new Error('migration_verification_evidence_mismatch');
    }
    const subject = this.store.verificationSubject(key);
    this.store.transition(lease, 'shaped', 'verified', this.nowMs(), {
      verificationDigest: result.certificationDigest,
      verificationManifestDigest: authority.certification.manifestDigest,
      verificationContractRevision: authority.certification.contractRevision,
      verificationSourceRevision: subject.sourceRevision,
      verificationInventoryFingerprint: subject.inventoryFingerprint,
    });
  }

  async #candidate(lease: MigrationLease, revision: number): Promise<void> {
    const key = { installationId: lease.installationId, sourceId: lease.sourceId };
    const verificationAuthority = this.#requireAllowed(key, ConnectorPolicyOperation.CredentialVerify);
    if (!this.store.verificationEvidenceMatches(key, verificationAuthority.certification)) {
      throw new Error('migration_verification_evidence_stale');
    }
    this.#requireAllowed(key, ConnectorPolicyOperation.CredentialStoreUnverified);
    await this.adapters.writeM2Candidate(key, revision, operationKey(key, 'candidate', revision));
    this.#requireAllowed(key, ConnectorPolicyOperation.CredentialStoreUnverified);
    this.store.transition(lease, 'verified', 'candidate', this.nowMs(), { candidateRevision: revision });
  }

  async #promote(lease: MigrationLease, current: ReturnType<ConnectorMigrationV2Store['read']>): Promise<void> {
    if (current.candidateRevision === null) throw new Error('migration_promote_cas_failed');
    const result = await this.adapters.promoteCandidateCas(
      { installationId: lease.installationId, sourceId: lease.sourceId },
      current.sourceRevision, current.candidateRevision);
    if (result === 'conflict') {
      throw new Error('migration_promote_cas_failed');
    }
    this.#requireAllowed({ installationId: lease.installationId, sourceId: lease.sourceId },
      ConnectorPolicyOperation.CredentialStoreUnverified);
    this.store.transition(lease, 'candidate', 'promoted', this.nowMs(),
      { sourceRevision: current.candidateRevision });
  }

  async #confirm(lease: MigrationLease, current: ReturnType<ConnectorMigrationV2Store['read']>): Promise<void> {
    if (current.candidateRevision === null
      || !await this.adapters.confirmRevisionPlacements(
        { installationId: lease.installationId, sourceId: lease.sourceId }, current.candidateRevision)) {
      throw new Error('migration_placements_unconfirmed');
    }
    this.#requireAllowed({ installationId: lease.installationId, sourceId: lease.sourceId },
      ConnectorPolicyOperation.PlacementWrite);
    this.store.transition(lease, 'promoted', 'placements_confirmed', this.nowMs());
  }

  #requireAllowed(key: MigrationAccountKey, operation: ConnectorPolicyOperation): MigrationPolicyAuthority {
    const capability = this.policyCapability(key, operation);
    const authority = migrationPolicyAuthorities.get(capability);
    if (!authority || consumedMigrationPolicies.has(capability)) throw new Error('migration_policy_rejected');
    consumedMigrationPolicies.add(capability);
    const metadata = this.store.metadata(key); const now = this.nowMs();
    const binding = { ...metadata, consumerBody: 'migration-engine',
      operation };
    const decision = resolveConnectorPolicy({ snapshot: authority.snapshot, binding,
      certification: authority.certification, kills: authority.kills });
    const identityMatches = authority.installationId === metadata.installationId
      && authority.userId === metadata.userId && authority.ownership === metadata.ownership
      && authority.providerId === metadata.providerId && authority.serviceId === metadata.serviceId
      && authority.accountId === metadata.accountId && authority.grantId === metadata.grantId;
    if (!identityMatches || authority.issuedAtMs > now || authority.expiresAtMs <= now || !decision.eligible) {
      throw new Error('migration_policy_rejected');
    }
    return authority;
  }

  #operationForState(state: MigrationState): ConnectorPolicyOperation {
    if (state === 'verified' || state === 'candidate') return ConnectorPolicyOperation.CredentialStoreUnverified;
    if (state === 'promoted' || state === 'placements_confirmed') return ConnectorPolicyOperation.PlacementWrite;
    return ConnectorPolicyOperation.CredentialVerify;
  }

}

type LegacyContinuationSnapshot = Readonly<{ installationId: string; sourceId: string;
  capturedAtMs: number; deadlineMs: number; policyEpoch: number; rowRevision: number;
  inventoryFingerprint: string }>;
const legacySnapshotAuthority = Symbol('legacy-snapshot-authority');
const legacySnapshots = new WeakMap<LegacyContinuationCapability, LegacyContinuationSnapshot>();

export class LegacyContinuationCapability {
  private constructor() { Object.freeze(this); }
  static create(authority: symbol, snapshot: LegacyContinuationSnapshot): LegacyContinuationCapability {
    if (authority !== legacySnapshotAuthority) throw new Error('legacy_continuation_authority_rejected');
    const capability = new LegacyContinuationCapability(); legacySnapshots.set(capability, Object.freeze(snapshot));
    return capability;
  }
  toJSON(): never { throw new Error('legacy_continuation_not_serializable'); }
}

/** The only legacy-continuation evaluator; no ambient or indefinite fallback exists. */
export const evaluateLegacyOperationalContinuation = (store: ConnectorMigrationV2Store,
  snapshot: LegacyContinuationCapability,
  expected: Pick<LegacyContinuationSnapshot, 'installationId' | 'sourceId' | 'policyEpoch'>,
  nowMs: number): boolean => store.evaluateLegacyContinuation(snapshot, expected, nowMs);
