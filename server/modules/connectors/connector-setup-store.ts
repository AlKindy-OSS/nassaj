/** Durable, secret-free installation setup substrate. No runtime connector imports this store. */

import { randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

export const CONNECTOR_SETUP_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connector_setup_trust_bundle (
  installation_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  bundle_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_setup_certification_sequence (
  installation_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  channel TEXT NOT NULL,
  highest_sequence INTEGER NOT NULL CHECK (highest_sequence >= 0),
  highest_digest TEXT NOT NULL,
  accepted_wall_ms INTEGER NOT NULL,
  clock_high_water_ms INTEGER NOT NULL,
  PRIMARY KEY (installation_id,issuer,channel)
);
CREATE TABLE IF NOT EXISTS connector_global_certification_packs (
  installation_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  channel TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  envelope_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  trust_bundle_revision INTEGER NOT NULL CHECK (trust_bundle_revision > 0),
  accepted_wall_ms INTEGER NOT NULL CHECK (accepted_wall_ms >= 0),
  clock_high_water_ms INTEGER NOT NULL CHECK (clock_high_water_ms >= accepted_wall_ms),
  state TEXT NOT NULL CHECK (state IN ('active','superseded')),
  PRIMARY KEY (installation_id,issuer,channel,sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_global_certification_pack_one_active
ON connector_global_certification_packs(installation_id,issuer,channel) WHERE state='active';
CREATE TABLE IF NOT EXISTS connector_setup_local_activation (
  installation_id TEXT PRIMARY KEY,
  record_revision INTEGER NOT NULL CHECK (record_revision > 0),
  envelope_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL CHECK (policy_epoch > 0),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
  origin_revision INTEGER NOT NULL CHECK (origin_revision > 0),
  valid INTEGER NOT NULL CHECK (valid IN (0,1))
);
CREATE TABLE IF NOT EXISTS connector_setup_projection (
  installation_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  readiness TEXT NOT NULL CHECK (readiness IN ('none','R0','R1','R2','R3','R4','quarantine')),
  evidence_digest TEXT,
  projection_revision INTEGER NOT NULL CHECK (projection_revision >= 0),
  invalid_reason TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (installation_id,scope_key)
);
CREATE TABLE IF NOT EXISTS connector_setup_event (
  event_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  from_readiness TEXT NOT NULL CHECK (from_readiness IN ('none','R0','R1','R2','R3','R4','quarantine')),
  to_readiness TEXT NOT NULL CHECK (to_readiness IN ('none','R0','R1','R2','R3','R4','quarantine')),
  evidence_digest TEXT,
  policy_epoch INTEGER NOT NULL CHECK (policy_epoch > 0),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
  created_at_ms INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS connector_setup_event_append_only_update
BEFORE UPDATE ON connector_setup_event BEGIN
  SELECT RAISE(ABORT,'connector_setup_event_append_only');
END;
CREATE TRIGGER IF NOT EXISTS connector_setup_event_append_only_delete
BEFORE DELETE ON connector_setup_event BEGIN
  SELECT RAISE(ABORT,'connector_setup_event_append_only');
END;
CREATE TABLE IF NOT EXISTS connector_setup_owner_wizard (
  installation_id TEXT PRIMARY KEY,
  wizard_revision INTEGER NOT NULL CHECK (wizard_revision >= 0),
  current_step TEXT NOT NULL,
  completed_steps_json TEXT NOT NULL,
  bound_origin_revision INTEGER NOT NULL CHECK (bound_origin_revision >= 0),
  bound_trust_revision INTEGER NOT NULL CHECK (bound_trust_revision >= 0),
  bound_pack_digest TEXT,
  bound_profile_revisions_json TEXT NOT NULL,
  last_idempotency_key TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_setup_owner_idempotency (
  installation_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL CHECK (owner_user_id > 0),
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','committed','failed')),
  response_status INTEGER,
  response_json TEXT,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
  phase TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (installation_id,owner_user_id,route,idempotency_key)
);
CREATE TABLE IF NOT EXISTS connector_setup_removal_intent (
  intent_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  ownership TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  consumer_body TEXT NOT NULL CHECK (consumer_body IN ('claude','codex','bridge')),
  operation TEXT NOT NULL CHECK (operation IN ('grant.remove','token.revoke','credential.delete','placement.remove')),
  state TEXT NOT NULL CHECK (state IN ('pending','leased','proved','failed')),
  proof_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_setup_authority_intent (
  intent_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  intent_type TEXT NOT NULL CHECK (intent_type IN ('origin_rotation','trust_rotation','activation_rotation','recovery')),
  expected_writer_epoch INTEGER NOT NULL CHECK (expected_writer_epoch > 0),
  minimum_policy_epoch INTEGER NOT NULL CHECK (minimum_policy_epoch > 0),
  minimum_origin_revision INTEGER NOT NULL CHECK (minimum_origin_revision > 0),
  minimum_trust_revision INTEGER NOT NULL CHECK (minimum_trust_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','committed','compensating','proved')),
  evidence_digest TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`;

export type ConnectorSetupReadiness = 'none' | 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'quarantine';

export type ConnectorSetupPrerequisites = Readonly<{
  substrateReady: boolean;
  authorityRootReady: boolean;
  authorityAnchorReady: boolean;
  originReady: boolean;
  trustReady: boolean;
  providerPackReady: boolean;
  clockReady: boolean;
  digestsReady: boolean;
  profileReady: boolean;
  profileRequired: boolean;
  activationReady: boolean;
  eligibilityReady: boolean;
  tampered: boolean;
}>;

export type ConnectorSetupProjection = Readonly<{
  installationId: string;
  scopeKey: string;
  readiness: ConnectorSetupReadiness;
  evidenceDigest: string | null;
  projectionRevision: number;
  invalidReason: string | null;
  updatedAtMs: number;
}>;

export type ConnectorSetupWizardStep = 'origin' | 'trust' | 'provider_pack' | 'profiles' | 'activation' | 'complete';
export type ConnectorSetupWizard = Readonly<{
  installationId: string; wizardRevision: number; currentStep: ConnectorSetupWizardStep;
  completedSteps: readonly ConnectorSetupWizardStep[]; boundOriginRevision: number;
  boundTrustRevision: number; boundPackDigest: string | null;
  boundProfileRevisions: Readonly<Record<string, number>>; lastIdempotencyKey: string | null;
  updatedAtMs: number;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const DIGEST = /^[A-Za-z0-9_-]{43,128}$/u;
const validId = (value: string): boolean => typeof value === 'string' && ID.test(value);
const validDigest = (value: string | null): boolean => value === null || DIGEST.test(value);
const validMs = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const jsonObject = (value: string): boolean => {
  try { const parsed = JSON.parse(value) as unknown; return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)); }
  catch { return false; }
};

/** Computes the highest effective milestone. Any integrity failure is quarantined. */
export const effectiveConnectorSetupReadiness = (input: ConnectorSetupPrerequisites): ConnectorSetupReadiness => {
  if (input.tampered) return 'quarantine';
  if (!input.substrateReady || !input.authorityRootReady || !input.authorityAnchorReady) return 'none';
  if (!input.originReady) return 'R0';
  if (!input.trustReady || !input.providerPackReady || !input.clockReady || !input.digestsReady) return 'R1';
  if (input.profileRequired && !input.profileReady) return 'R2';
  if (!input.activationReady || !input.eligibilityReady) return 'R3';
  return 'R4';
};

type ProjectionRow = { installationId: string; scopeKey: string; readiness: ConnectorSetupReadiness;
  evidenceDigest: string | null; projectionRevision: number; invalidReason: string | null; updatedAtMs: number };

/** SQLite setup repository. All methods are local and perform no decryption or external I/O. */
export class ConnectorSetupStore {
  readonly #database: Database;

  constructor(database: Database, initializeSchema = true) {
    this.#database = database;
    if (initializeSchema) database.exec(CONNECTOR_SETUP_STORE_SCHEMA_SQL);
  }

  readProjection(installationId: string, scopeKey: string): ConnectorSetupProjection | null {
    if (!validId(installationId) || !validId(scopeKey)) throw new Error('connector_setup_scope_invalid');
    const row = this.#database.prepare(`SELECT installation_id AS installationId,scope_key AS scopeKey,
      readiness,evidence_digest AS evidenceDigest,projection_revision AS projectionRevision,
      invalid_reason AS invalidReason,updated_at_ms AS updatedAtMs FROM connector_setup_projection
      WHERE installation_id = ? AND scope_key = ?`).get(installationId, scopeKey) as ProjectionRow | undefined;
    return row ? Object.freeze(row) : null;
  }

  /** Recomputes prerequisites and records every actual transition in the same transaction. */
  recomputeProjection(input: Readonly<{ installationId: string; scopeKey: string;
    prerequisites: ConnectorSetupPrerequisites; expectedProjectionRevision: number;
    evidenceDigest: string | null; invalidReason: string | null; policyEpoch: number;
    writerEpoch: number; nowMs: number; allowQuarantineRecovery?: boolean }>): ConnectorSetupProjection {
    this.#validateProjectionInput(input);
    const run = this.#database.transaction(() => {
      const prior = this.readProjection(input.installationId, input.scopeKey);
      const revision = prior?.projectionRevision ?? 0;
      if (revision !== input.expectedProjectionRevision) throw new Error('connector_setup_projection_cas_conflict');
      const computed = effectiveConnectorSetupReadiness(input.prerequisites);
      const nextReadiness = prior?.readiness === 'quarantine' && computed !== 'quarantine'
        && input.allowQuarantineRecovery !== true ? 'quarantine' : computed;
      const nextRevision = revision + (prior?.readiness === nextReadiness
        && prior.evidenceDigest === input.evidenceDigest && prior.invalidReason === input.invalidReason ? 0 : 1);
      if (nextRevision === revision && prior) return prior;
      this.#database.prepare(`INSERT INTO connector_setup_projection
        (installation_id,scope_key,readiness,evidence_digest,projection_revision,invalid_reason,updated_at_ms)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(installation_id,scope_key) DO UPDATE SET
        readiness=excluded.readiness,evidence_digest=excluded.evidence_digest,
        projection_revision=excluded.projection_revision,invalid_reason=excluded.invalid_reason,
        updated_at_ms=excluded.updated_at_ms WHERE connector_setup_projection.projection_revision = ?`)
        .run(input.installationId, input.scopeKey, nextReadiness, input.evidenceDigest, nextRevision,
          input.invalidReason, input.nowMs, revision);
      this.#appendEvent(input.installationId, input.scopeKey, prior?.readiness ?? 'none', nextReadiness,
        input.evidenceDigest, input.policyEpoch, input.writerEpoch, input.nowMs);
      return this.readProjection(input.installationId, input.scopeKey)!;
    });
    return run.immediate();
  }

  /** Downgrades every R1+ projection after an origin rotation; quarantine remains sticky. */
  downgradeForOriginRotation(installationId: string, policyEpoch: number,
    writerEpoch: number, nowMs: number): number {
    if (!validId(installationId) || ![policyEpoch, writerEpoch].every(value => Number.isSafeInteger(value) && value > 0)
      || !validMs(nowMs)) throw new Error('connector_setup_rotation_input_invalid');
    const rows = this.#database.prepare(`SELECT installation_id AS installationId,scope_key AS scopeKey,
      readiness,evidence_digest AS evidenceDigest,projection_revision AS projectionRevision,
      invalid_reason AS invalidReason,updated_at_ms AS updatedAtMs FROM connector_setup_projection
      WHERE installation_id = ? AND readiness IN ('R1','R2','R3','R4')`).all(installationId) as ProjectionRow[];
    for (const row of rows) {
      const result = this.#database.prepare(`UPDATE connector_setup_projection SET readiness='R0',
        evidence_digest=NULL,projection_revision=projection_revision+1,invalid_reason='origin_rotated',updated_at_ms=?
        WHERE installation_id=? AND scope_key=? AND projection_revision=?`).run(nowMs, installationId,
          row.scopeKey, row.projectionRevision);
      if (result.changes !== 1) throw new Error('connector_setup_projection_cas_conflict');
      this.#appendEvent(installationId, row.scopeKey, row.readiness, 'R0', null,
        policyEpoch, writerEpoch, nowMs);
    }
    return rows.length;
  }

  saveTrustBundle(input: Readonly<{ installationId: string; expectedRevision: number;
    bundleJson: string; digest: string; nowMs: number }>): number {
    if (!validId(input.installationId) || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0 || !jsonObject(input.bundleJson) || !validDigest(input.digest)
      || !validMs(input.nowMs)) throw new Error('connector_setup_trust_input_invalid');
    const next = input.expectedRevision + 1;
    const result = input.expectedRevision === 0
      ? this.#database.prepare(`INSERT OR IGNORE INTO connector_setup_trust_bundle
        (installation_id,revision,bundle_json,digest,updated_at_ms) VALUES (?,?,?,?,?)`)
        .run(input.installationId, next, input.bundleJson, input.digest, input.nowMs)
      : this.#database.prepare(`UPDATE connector_setup_trust_bundle SET revision=?,bundle_json=?,digest=?,updated_at_ms=?
        WHERE installation_id=? AND revision=?`).run(next, input.bundleJson, input.digest,
        input.nowMs, input.installationId, input.expectedRevision);
    if (result.changes !== 1) throw new Error('connector_setup_trust_cas_conflict');
    return next;
  }

  readTrustBundle(installationId: string): Readonly<{ revision: number; bundleJson: string;
    digest: string; updatedAtMs: number }> | null {
    if (!validId(installationId)) throw new Error('connector_setup_scope_invalid');
    const row = this.#database.prepare(`SELECT revision,bundle_json AS bundleJson,digest,
      updated_at_ms AS updatedAtMs FROM connector_setup_trust_bundle WHERE installation_id=?`)
      .get(installationId) as { revision: number; bundleJson: string; digest: string; updatedAtMs: number } | undefined;
    return row ? Object.freeze(row) : null;
  }

  readActivePack(installationId: string): Readonly<{ issuer: string; channel: string;
    sequence: number; envelopeJson: string; digest: string; trustBundleRevision: number;
    acceptedWallMs: number; clockHighWaterMs: number }> | null {
    if (!validId(installationId)) throw new Error('connector_setup_scope_invalid');
    const rows = this.#database.prepare(`SELECT issuer,channel,sequence,envelope_json AS envelopeJson,
      digest,trust_bundle_revision AS trustBundleRevision,accepted_wall_ms AS acceptedWallMs,
      clock_high_water_ms AS clockHighWaterMs FROM connector_global_certification_packs
      WHERE installation_id=? AND state='active'`).all(installationId) as Array<{
        issuer: string; channel: string; sequence: number; envelopeJson: string; digest: string;
        trustBundleRevision: number; acceptedWallMs: number; clockHighWaterMs: number }>;
    if (rows.length > 1) throw new Error('connector_setup_pack_state_invalid');
    return rows[0] ? Object.freeze(rows[0]) : null;
  }

  /** Atomically advances the accepted sequence and exact verified envelope. */
  saveVerifiedPack(input: Readonly<{ installationId: string; issuer: string; channel: string;
    sequence: number; envelopeJson: string; digest: string; trustBundleRevision: number;
    acceptedWallMs: number; clockHighWaterMs: number }>): void {
    if (![input.installationId, input.issuer, input.channel].every(validId)
      || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !jsonObject(input.envelopeJson)
      || !validDigest(input.digest) || !Number.isSafeInteger(input.trustBundleRevision)
      || input.trustBundleRevision < 1 || !validMs(input.acceptedWallMs)
      || !validMs(input.clockHighWaterMs) || input.clockHighWaterMs < input.acceptedWallMs) {
      throw new Error('connector_setup_pack_input_invalid');
    }
    const save = this.#database.transaction(() => {
      const active = this.readActivePack(input.installationId);
      if (active && (active.issuer !== input.issuer || active.channel !== input.channel)) {
        throw new Error('connector_setup_pack_channel_conflict');
      }
      if (active && input.sequence <= active.sequence) throw new Error('connector_setup_sequence_rollback');
      this.acceptCertificationSequence({ installationId: input.installationId, issuer: input.issuer,
        channel: input.channel, sequence: input.sequence, digest: input.digest,
        acceptedWallMs: input.acceptedWallMs, clockHighWaterMs: input.clockHighWaterMs });
      this.#database.prepare(`UPDATE connector_global_certification_packs SET state='superseded'
        WHERE installation_id=? AND issuer=? AND channel=? AND state='active'`)
        .run(input.installationId, input.issuer, input.channel);
      this.#database.prepare(`INSERT INTO connector_global_certification_packs
        (installation_id,issuer,channel,sequence,envelope_json,digest,trust_bundle_revision,
         accepted_wall_ms,clock_high_water_ms,state) VALUES (?,?,?,?,?,?,?,?,?,'active')`)
        .run(input.installationId, input.issuer, input.channel, input.sequence, input.envelopeJson,
          input.digest, input.trustBundleRevision, input.acceptedWallMs, input.clockHighWaterMs);
    });
    save.immediate();
  }

  saveLocalActivation(input: Readonly<{ installationId: string; expectedRevision: number;
    envelopeJson: string; digest: string; policyEpoch: number; writerEpoch: number;
    originRevision: number }>): number {
    if (!validId(input.installationId) || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0 || !jsonObject(input.envelopeJson) || !validDigest(input.digest)
      || ![input.policyEpoch, input.writerEpoch, input.originRevision]
        .every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('connector_setup_activation_input_invalid');
    }
    const next = input.expectedRevision + 1;
    const result = input.expectedRevision === 0
      ? this.#database.prepare(`INSERT OR IGNORE INTO connector_setup_local_activation
        (installation_id,record_revision,envelope_json,digest,policy_epoch,writer_epoch,origin_revision,valid)
        VALUES (?,?,?,?,?,?,?,1)`).run(input.installationId, next, input.envelopeJson, input.digest,
        input.policyEpoch, input.writerEpoch, input.originRevision)
      : this.#database.prepare(`UPDATE connector_setup_local_activation SET record_revision=?,envelope_json=?,
        digest=?,policy_epoch=?,writer_epoch=?,origin_revision=?,valid=1
        WHERE installation_id=? AND record_revision=?`).run(next, input.envelopeJson, input.digest,
        input.policyEpoch, input.writerEpoch, input.originRevision, input.installationId, input.expectedRevision);
    if (result.changes !== 1) throw new Error('connector_setup_activation_cas_conflict');
    return next;
  }

  acceptCertificationSequence(input: Readonly<{ installationId: string; issuer: string; channel: string;
    sequence: number; digest: string; acceptedWallMs: number; clockHighWaterMs: number }>): void {
    if (![input.installationId, input.issuer, input.channel].every(validId)
      || !Number.isSafeInteger(input.sequence) || input.sequence < 0 || !validDigest(input.digest)
      || !validMs(input.acceptedWallMs) || !validMs(input.clockHighWaterMs)
      || input.acceptedWallMs < input.clockHighWaterMs) throw new Error('connector_setup_sequence_input_invalid');
    const row = this.#database.prepare(`SELECT highest_sequence AS sequence,highest_digest AS digest,
      clock_high_water_ms AS clock FROM connector_setup_certification_sequence
      WHERE installation_id=? AND issuer=? AND channel=?`).get(input.installationId, input.issuer, input.channel) as
      { sequence: number; digest: string; clock: number } | undefined;
    if (row && (input.sequence < row.sequence || input.clockHighWaterMs < row.clock
      || (input.sequence === row.sequence && input.digest !== row.digest))) {
      throw new Error('connector_setup_sequence_rollback');
    }
    this.#database.prepare(`INSERT INTO connector_setup_certification_sequence
      (installation_id,issuer,channel,highest_sequence,highest_digest,accepted_wall_ms,clock_high_water_ms)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(installation_id,issuer,channel) DO UPDATE SET
      highest_sequence=excluded.highest_sequence,highest_digest=excluded.highest_digest,
      accepted_wall_ms=excluded.accepted_wall_ms,clock_high_water_ms=excluded.clock_high_water_ms`)
      .run(input.installationId, input.issuer, input.channel, input.sequence, input.digest,
        input.acceptedWallMs, input.clockHighWaterMs);
  }

  beginIdempotent(input: Readonly<{ installationId: string; ownerUserId: number; route: string;
    key: string; bodySha256: string; writerEpoch: number; phase: string; nowMs: number; expiresAtMs: number }> ):
    'started' | 'pending' | 'committed' | 'failed' {
    if (!validId(input.installationId) || !validId(input.route) || !validId(input.key)
      || !validId(input.phase) || !DIGEST.test(input.bodySha256) || !Number.isSafeInteger(input.ownerUserId)
      || input.ownerUserId < 1 || !Number.isSafeInteger(input.writerEpoch) || input.writerEpoch < 1
      || !validMs(input.nowMs) || !validMs(input.expiresAtMs) || input.expiresAtMs <= input.nowMs) {
      throw new Error('connector_setup_idempotency_input_invalid');
    }
    const result = this.#database.prepare(`INSERT OR IGNORE INTO connector_setup_owner_idempotency
      (installation_id,owner_user_id,route,idempotency_key,body_sha256,state,writer_epoch,phase,created_at_ms,expires_at_ms)
      VALUES (?,?,?,?,?,'pending',?,?,?,?)`).run(input.installationId, input.ownerUserId, input.route,
      input.key, input.bodySha256, input.writerEpoch, input.phase, input.nowMs, input.expiresAtMs);
    if (result.changes === 1) return 'started';
    const row = this.#database.prepare(`SELECT body_sha256 AS body,state FROM connector_setup_owner_idempotency
      WHERE installation_id=? AND owner_user_id=? AND route=? AND idempotency_key=?`)
      .get(input.installationId, input.ownerUserId, input.route, input.key) as { body: string; state: 'pending'|'committed'|'failed' };
    if (row.body !== input.bodySha256) throw new Error('connector_setup_idempotency_body_conflict');
    return row.state;
  }

  finishIdempotent(input: Readonly<{ installationId: string; ownerUserId: number; route: string;
    key: string; bodySha256: string; state: 'committed'|'failed'; responseStatus: number; responseJson: string }> ): void {
    if (!jsonObject(input.responseJson) || !Number.isSafeInteger(input.responseStatus)
      || input.responseStatus < 100 || input.responseStatus > 599) throw new Error('connector_setup_response_invalid');
    const result = this.#database.prepare(`UPDATE connector_setup_owner_idempotency SET state=?,response_status=?,response_json=?
      WHERE installation_id=? AND owner_user_id=? AND route=? AND idempotency_key=? AND body_sha256=? AND state='pending'`)
      .run(input.state, input.responseStatus, input.responseJson, input.installationId, input.ownerUserId,
        input.route, input.key, input.bodySha256);
    if (result.changes !== 1) throw new Error('connector_setup_idempotency_cas_conflict');
  }

  saveWizard(input: Readonly<{ installationId: string; expectedRevision: number; currentStep: ConnectorSetupWizardStep;
    completedSteps: readonly ConnectorSetupWizardStep[]; boundOriginRevision: number; boundTrustRevision: number;
    boundPackDigest: string | null; boundProfileRevisions: Readonly<Record<string, number>>;
    lastIdempotencyKey: string | null; nowMs: number }>): number {
    if (!validId(input.installationId) || !validId(input.currentStep)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || !Number.isSafeInteger(input.boundOriginRevision) || input.boundOriginRevision < 0
      || !Number.isSafeInteger(input.boundTrustRevision) || input.boundTrustRevision < 0
      || !validDigest(input.boundPackDigest) || !validMs(input.nowMs)
      || !input.completedSteps.every(validId) || Object.values(input.boundProfileRevisions)
        .some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('connector_setup_wizard_input_invalid');
    const revision = input.expectedRevision + 1;
    const values = [input.installationId, revision, input.currentStep, JSON.stringify(input.completedSteps),
      input.boundOriginRevision, input.boundTrustRevision, input.boundPackDigest,
      JSON.stringify(input.boundProfileRevisions), input.lastIdempotencyKey, input.nowMs];
    const result = input.expectedRevision === 0
      ? this.#database.prepare(`INSERT OR IGNORE INTO connector_setup_owner_wizard
        (installation_id,wizard_revision,current_step,completed_steps_json,bound_origin_revision,
         bound_trust_revision,bound_pack_digest,bound_profile_revisions_json,last_idempotency_key,updated_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(...values)
      : this.#database.prepare(`UPDATE connector_setup_owner_wizard SET wizard_revision=?,current_step=?,
        completed_steps_json=?,bound_origin_revision=?,bound_trust_revision=?,bound_pack_digest=?,
        bound_profile_revisions_json=?,last_idempotency_key=?,updated_at_ms=?
        WHERE installation_id=? AND wizard_revision=?`).run(...values.slice(1), input.installationId, input.expectedRevision);
    if (result.changes !== 1) throw new Error('connector_setup_wizard_cas_conflict');
    return revision;
  }

  /** Rebinds a resumed wizard to current durable prerequisites before returning it. */
  resumeWizard(input: Readonly<{ installationId: string; expectedRevision: number;
    originRevision: number; trustRevision: number; packDigest: string | null;
    profileRevisions: Readonly<Record<string, number>>; nowMs: number }>): ConnectorSetupWizard | null {
    if (!validId(input.installationId) || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0 || !Number.isSafeInteger(input.originRevision) || input.originRevision < 0
      || !Number.isSafeInteger(input.trustRevision) || input.trustRevision < 0
      || !validDigest(input.packDigest) || !validMs(input.nowMs)) throw new Error('connector_setup_wizard_resume_invalid');
    const row = this.#readWizard(input.installationId);
    if (!row) return null;
    if (row.wizardRevision !== input.expectedRevision) throw new Error('connector_setup_wizard_cas_conflict');
    const profilesJson = JSON.stringify(input.profileRevisions);
    let completed = [...row.completedSteps]; let current = row.currentStep;
    if (row.boundOriginRevision !== input.originRevision) { completed = []; current = 'origin'; }
    else if (row.boundTrustRevision !== input.trustRevision) {
      completed = completed.filter(step => step === 'origin'); current = 'trust';
    } else if (row.boundPackDigest !== input.packDigest) {
      completed = completed.filter(step => step === 'origin' || step === 'trust'); current = 'provider_pack';
    } else if (JSON.stringify(row.boundProfileRevisions) !== profilesJson) {
      completed = completed.filter(step => ['origin', 'trust', 'provider_pack'].includes(step)); current = 'profiles';
    } else return row;
    this.saveWizard({ installationId: input.installationId, expectedRevision: row.wizardRevision,
      currentStep: current, completedSteps: completed, boundOriginRevision: input.originRevision,
      boundTrustRevision: input.trustRevision, boundPackDigest: input.packDigest,
      boundProfileRevisions: input.profileRevisions, lastIdempotencyKey: row.lastIdempotencyKey,
      nowMs: input.nowMs });
    return this.#readWizard(input.installationId);
  }

  createRemovalIntent(input: Readonly<{ installationId: string; userId: number; ownership: string;
    providerId: string; serviceId: string; accountId: string; grantId: string;
    consumerBody: 'claude'|'codex'|'bridge'; operation: 'grant.remove'|'token.revoke'|'credential.delete'|'placement.remove';
    nowMs: number }>): string {
    if (![input.installationId, input.ownership, input.providerId, input.serviceId,
      input.accountId, input.grantId].every(validId) || !Number.isSafeInteger(input.userId)
      || input.userId < 1 || !validMs(input.nowMs)) throw new Error('connector_setup_removal_input_invalid');
    const intentId = randomUUID();
    this.#database.prepare(`INSERT INTO connector_setup_removal_intent
      (intent_id,installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,
       consumer_body,operation,state,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(intentId, input.installationId, input.userId,
      input.ownership, input.providerId, input.serviceId, input.accountId, input.grantId,
      input.consumerBody, input.operation, input.nowMs, input.nowMs);
    return intentId;
  }

  proveRemoval(intentId: string, proofJson: string, nowMs: number): void {
    if (!validId(intentId) || !jsonObject(proofJson) || !validMs(nowMs)) {
      throw new Error('connector_setup_removal_proof_invalid');
    }
    const result = this.#database.prepare(`UPDATE connector_setup_removal_intent
      SET state='proved',proof_json=?,updated_at_ms=? WHERE intent_id=? AND state IN ('pending','leased')`)
      .run(proofJson, nowMs, intentId);
    if (result.changes !== 1) throw new Error('connector_setup_removal_cas_conflict');
  }

  createAuthorityIntent(input: Readonly<{ installationId: string; intentType: 'origin_rotation'|'trust_rotation'|'activation_rotation'|'recovery';
    expectedWriterEpoch: number; minimumPolicyEpoch: number; minimumOriginRevision: number;
    minimumTrustRevision: number; evidenceDigest: string | null; nowMs: number }>): string {
    if (!validId(input.installationId) || ![input.expectedWriterEpoch, input.minimumPolicyEpoch,
      input.minimumOriginRevision].every(value => Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(input.minimumTrustRevision) || input.minimumTrustRevision < 0
      || !validDigest(input.evidenceDigest) || !validMs(input.nowMs)) throw new Error('connector_setup_authority_input_invalid');
    const intentId = randomUUID();
    this.#database.prepare(`INSERT INTO connector_setup_authority_intent
      (intent_id,installation_id,intent_type,expected_writer_epoch,minimum_policy_epoch,
       minimum_origin_revision,minimum_trust_revision,state,evidence_digest,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`).run(intentId, input.installationId, input.intentType,
      input.expectedWriterEpoch, input.minimumPolicyEpoch, input.minimumOriginRevision,
      input.minimumTrustRevision, input.evidenceDigest, input.nowMs, input.nowMs);
    return intentId;
  }

  #appendEvent(installationId: string, scopeKey: string, from: ConnectorSetupReadiness,
    to: ConnectorSetupReadiness, evidence: string | null, policyEpoch: number,
    writerEpoch: number, nowMs: number): void {
    this.#database.prepare(`INSERT INTO connector_setup_event
      (event_id,installation_id,scope_key,from_readiness,to_readiness,evidence_digest,
       policy_epoch,writer_epoch,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), installationId, scopeKey, from, to, evidence, policyEpoch, writerEpoch, nowMs);
  }

  #validateProjectionInput(input: Readonly<{ installationId: string; scopeKey: string;
    expectedProjectionRevision: number; evidenceDigest: string|null; invalidReason: string|null;
    policyEpoch: number; writerEpoch: number; nowMs: number; allowQuarantineRecovery?: boolean }>): void {
    if (!validId(input.installationId) || !validId(input.scopeKey)
      || !Number.isSafeInteger(input.expectedProjectionRevision) || input.expectedProjectionRevision < 0
      || !validDigest(input.evidenceDigest) || (input.invalidReason !== null && !validId(input.invalidReason))
      || ![input.policyEpoch, input.writerEpoch].every(value => Number.isSafeInteger(value) && value > 0)
      || !validMs(input.nowMs)) throw new Error('connector_setup_projection_input_invalid');
  }

  #readWizard(installationId: string): ConnectorSetupWizard | null {
    const row = this.#database.prepare(`SELECT installation_id AS installationId,wizard_revision AS wizardRevision,
      current_step AS currentStep,completed_steps_json AS completedStepsJson,
      bound_origin_revision AS boundOriginRevision,bound_trust_revision AS boundTrustRevision,
      bound_pack_digest AS boundPackDigest,bound_profile_revisions_json AS boundProfilesJson,
      last_idempotency_key AS lastIdempotencyKey,updated_at_ms AS updatedAtMs
      FROM connector_setup_owner_wizard WHERE installation_id=?`).get(installationId) as
      (Omit<ConnectorSetupWizard, 'completedSteps'|'boundProfileRevisions'>
      & { completedStepsJson: string; boundProfilesJson: string }) | undefined;
    if (!row) return null;
    const { completedStepsJson, boundProfilesJson, ...fields } = row;
    return Object.freeze({ ...fields,
      completedSteps: Object.freeze(JSON.parse(completedStepsJson) as ConnectorSetupWizardStep[]),
      boundProfileRevisions: Object.freeze(JSON.parse(boundProfilesJson) as Record<string, number>) });
  }
}
