/** Durable, fail-closed provisioning for new connector installations (ADR-162). */

import { createHash, randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { PROVIDER_AUTH_SPECS } from '../../../shared/connector-auth-registry.js';

import type { ConnectorInstallationOriginResolver } from './connector-installation-origin-resolver.js';

export const CONNECTOR_PROVISIONING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connector_provisioning_attempts (
  provisioning_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  request_key_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned','verifying_origin','registering_dcr','ready','blocked','manual_recovery','cancelled')),
  origin TEXT,
  origin_revision INTEGER,
  trust_generation TEXT,
  trust_digest TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  external_receipt_digest TEXT,
  reason_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (installation_id, request_key_hash)
);
CREATE TABLE IF NOT EXISTS connector_provisioning_locks (
  installation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provisioning_id TEXT NOT NULL,
  owner_token_hash TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (installation_id, provider_id)
);
CREATE TABLE IF NOT EXISTS connector_provisioning_installation_eligibility (
  installation_id TEXT PRIMARY KEY,
  eligible INTEGER NOT NULL CHECK (eligible = 1),
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_provisioning_provider_effects (
  installation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provisioning_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('dcr_reserved','dcr_possible_effect','dcr_registered')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (installation_id, provider_id),
  UNIQUE (provisioning_id)
);
CREATE INDEX IF NOT EXISTS idx_connector_provisioning_attempt_state
  ON connector_provisioning_attempts(installation_id, state, updated_at_ms);
`;

export type ConnectorProvisioningState = 'planned'|'verifying_origin'|'registering_dcr'|'ready'|'blocked'|'manual_recovery'|'cancelled';
type AttemptRow = { provisioningId: string; installationId: string; providerId: string; nonceHash: string;
  state: ConnectorProvisioningState; origin: string|null; originRevision: number|null;
  trustGeneration: string|null; trustDigest: string|null; evidenceJson: string; externalReceiptDigest: string|null;
  reasonCode: string|null; createdAtMs: number; updatedAtMs: number };
export type ConnectorProvisioningAttempt = Readonly<AttemptRow & { evidence: Readonly<Record<string, string>> }>;

/** This is intentionally an injected production channel, never a fixture or a stored inert pack. */
export type ConnectorProvisioningTrustChannel = Readonly<{ readCurrent: () => Promise<Readonly<{
  generation: string; digest: string; dcrProviderIds: readonly string[]; valid: boolean;
}>> }>;
export type ConnectorOriginProofVerifier = Readonly<{ verify: (input: Readonly<{
  canonicalOrigin: string; originRevision: number; provisioningId: string; nonceHash: string;
}>) => Promise<Readonly<{ evidenceDigest: string }>> }>;
export type ConnectorDcrRegistrar = Readonly<{ register: (input: Readonly<{
  providerId: string; callbackUrl: string; provisioningId: string; nonceHash: string; trustGeneration: string;
  /** Must be submitted to the provider's idempotency mechanism; it is stable across lease recovery. */
  externalIdempotencyKey: string;
}>) => Promise<Readonly<{ outcome: 'registered'|'uncertain'; receiptDigest?: string }>> }>;

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const providerAllowed = (providerId: string): boolean => providerId !== 'google-workspace' && providerId !== 'canva'
  && PROVIDER_AUTH_SPECS.some(spec => spec.profileId === providerId && spec.method === 'dcr_pkce');
const parseEvidence = (raw: string): Readonly<Record<string, string>> => {
  try { const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
    return Object.freeze(Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item === 'string').map(([key, item]) => [key, String(item)])));
  } catch { return Object.freeze({}); }
};
const normalize = (row: AttemptRow): ConnectorProvisioningAttempt => Object.freeze({ ...row, evidence: parseEvidence(row.evidenceJson) });

/** Coordinates durable evidence and external DCR effects; absent production dependencies always recover manually. */
export class ConnectorProvisioningService {
  constructor(private readonly database: Database, private readonly installationId: string,
    private readonly origins: ConnectorInstallationOriginResolver, private readonly executeWrite: (effect: () => void) => boolean,
    private readonly dependencies: Readonly<{ trustChannel?: ConnectorProvisioningTrustChannel;
      originProofVerifier?: ConnectorOriginProofVerifier; dcrRegistrar?: ConnectorDcrRegistrar }> = {},
    private readonly now: () => number = Date.now, private readonly ids: () => string = randomUUID) {}

  /** Starts or returns one idempotent provisioning attempt. It never manufactures an origin. */
  async start(providerId: string, idempotencyKey: string): Promise<ConnectorProvisioningAttempt> {
    if (!providerAllowed(providerId)) throw new Error('connector_provisioning_provider_excluded');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)) throw new Error('connector_provisioning_idempotency_invalid');
    if (!this.#eligible()) throw new Error('connector_provisioning_existing_installation');
    const requestKeyHash = hash(idempotencyKey); let attempt = this.#findByRequest(requestKeyHash);
    if (attempt) {
      if (attempt.providerId !== providerId) throw new Error('connector_provisioning_idempotency_conflict');
      return this.#drive(attempt);
    }
    const provisioningId = this.ids(); const nonceHash = hash(this.ids()); const nowMs = this.now();
    const wrote = this.executeWrite(() => { this.database.prepare(`INSERT INTO connector_provisioning_attempts
      (provisioning_id,installation_id,provider_id,request_key_hash,nonce_hash,state,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,'planned',?,?) ON CONFLICT(installation_id,request_key_hash) DO NOTHING`)
      .run(provisioningId, this.installationId, providerId, requestKeyHash, nonceHash, nowMs, nowMs); });
    if (!wrote) throw new Error('connector_provisioning_write_unavailable');
    attempt = this.#findByRequest(requestKeyHash); if (!attempt) throw new Error('connector_provisioning_persistence_unavailable');
    return this.#drive(attempt);
  }

  /** Returns an attempt without exposing its nonce, request key, or any credential material. */
  read(provisioningId: string): ConnectorProvisioningAttempt|null { return this.#find(provisioningId); }

  async #drive(initial: ConnectorProvisioningAttempt): Promise<ConnectorProvisioningAttempt> {
    if (['ready', 'manual_recovery', 'cancelled'].includes(initial.state)) return initial;
    // A process may have died while an external registration was in flight. Its
    // result is unknowable, so a resumed process records recovery and never repeats DCR.
    if (initial.state === 'registering_dcr') {
      if (this.#lockActive(initial)) return initial;
      return this.#transition(initial, 'manual_recovery', 'CONNECTOR_PROVISIONING_DCR_EFFECT_UNRESOLVED');
    }
    const lockToken = hash(this.ids());
    if (!this.#acquire(initial, lockToken)) return this.#transition(initial, 'blocked', 'CONNECTOR_PROVISIONING_LOCKED');
    try {
      const origin = this.origins.resolve(this.installationId);
      if (!origin) return this.#transition(initial, 'manual_recovery', 'CONNECTOR_PROVISIONING_ORIGIN_UNAVAILABLE');
      const trustChannel = this.dependencies.trustChannel;
      if (!trustChannel) return this.#transition(initial, 'manual_recovery', 'CONNECTOR_PROVISIONING_TRUST_CHANNEL_UNAVAILABLE');
      let trust: Awaited<ReturnType<ConnectorProvisioningTrustChannel['readCurrent']>>;
      try { trust = await trustChannel.readCurrent(); } catch { return this.#transition(initial, 'blocked', 'CONNECTOR_PROVISIONING_TRUST_UNAVAILABLE'); }
      if (!trust.valid || !trust.dcrProviderIds.includes(initial.providerId)) {
        return this.#transition(initial, 'manual_recovery', 'CONNECTOR_PROVISIONING_DCR_NOT_CERTIFIED');
      }
      const verifying = this.#transition(initial, 'verifying_origin', null, origin.canonicalOrigin, origin.originRevision,
        trust.generation, trust.digest);
      const verifier = this.dependencies.originProofVerifier;
      if (!verifier) return this.#transition(verifying, 'manual_recovery', 'CONNECTOR_PROVISIONING_ORIGIN_PROOF_UNAVAILABLE');
      let proof: Readonly<{ evidenceDigest: string }>;
      try { proof = await verifier.verify({ canonicalOrigin: origin.canonicalOrigin, originRevision: origin.originRevision,
        provisioningId: verifying.provisioningId, nonceHash: verifying.nonceHash }); }
      catch { return this.#transition(verifying, 'blocked', 'CONNECTOR_PROVISIONING_ORIGIN_PROOF_FAILED'); }
      const currentOrigin = this.origins.resolve(this.installationId);
      if (!currentOrigin || currentOrigin.canonicalOrigin !== origin.canonicalOrigin || currentOrigin.originRevision !== origin.originRevision) {
        return this.#transition(verifying, 'blocked', 'CONNECTOR_PROVISIONING_ORIGIN_CHANGED');
      }
      const currentTrust = await this.#readSameTrust(trust, initial.providerId);
      if (!currentTrust) return this.#transition(verifying, 'blocked', 'CONNECTOR_PROVISIONING_TRUST_CHANGED');
      const registrar = this.dependencies.dcrRegistrar;
      if (!registrar) return this.#transition(verifying, 'manual_recovery', 'CONNECTOR_PROVISIONING_DCR_CHANNEL_UNAVAILABLE', undefined, undefined,
        undefined, undefined, { originProofDigest: proof.evidenceDigest });
      const registering = this.#transition(verifying, 'registering_dcr', null, undefined, undefined, undefined, undefined,
        { originProofDigest: proof.evidenceDigest });
      if (!this.#reserveDcrEffect(registering)) {
        return this.#transition(registering, 'manual_recovery', 'CONNECTOR_PROVISIONING_DCR_RECONCILIATION_REQUIRED');
      }
      if (!this.#renew(registering, lockToken)) {
        return this.#transition(registering, 'manual_recovery', 'CONNECTOR_PROVISIONING_LEASE_LOST_BEFORE_DCR');
      }
      let result: Awaited<ReturnType<ConnectorDcrRegistrar['register']>>;
      try { result = await registrar.register({ providerId: registering.providerId, callbackUrl: `${origin.canonicalOrigin}/connectors/oauth/callback`,
        provisioningId: registering.provisioningId, nonceHash: registering.nonceHash, trustGeneration: trust.generation,
        externalIdempotencyKey: hash(`${this.installationId}\0${registering.providerId}`) }); }
      catch { this.#markDcrEffect(registering, 'dcr_possible_effect'); return this.#transition(registering, 'manual_recovery', 'CONNECTOR_PROVISIONING_DCR_UNCERTAIN', undefined,
        undefined, undefined, undefined, { dcrPossibleEffect: 'unknown' }); }
      // Persist the possible external effect before inspecting mutable local evidence.
      const receipted = this.#transition(registering, 'registering_dcr', null, undefined, undefined, undefined, undefined,
        result.outcome === 'uncertain' ? { dcrPossibleEffect: 'reported_uncertain' } : {}, result.receiptDigest);
      if (result.outcome !== 'registered' || !result.receiptDigest) {
        this.#markDcrEffect(receipted, 'dcr_possible_effect');
        return this.#transition(receipted, 'manual_recovery', 'CONNECTOR_PROVISIONING_DCR_UNCERTAIN');
      }
      this.#markDcrEffect(receipted, 'dcr_registered');
      const after = this.origins.resolve(this.installationId);
      if (!after || after.canonicalOrigin !== origin.canonicalOrigin || after.originRevision !== origin.originRevision) {
        return this.#transition(receipted, 'manual_recovery', 'CONNECTOR_PROVISIONING_ORIGIN_CHANGED_AFTER_DCR');
      }
      if (!await this.#readSameTrust(trust, initial.providerId)) {
        return this.#transition(receipted, 'manual_recovery', 'CONNECTOR_PROVISIONING_TRUST_CHANGED_AFTER_DCR');
      }
      return this.#transition(receipted, 'ready', null, undefined, undefined, undefined, undefined,
        { originProofDigest: proof.evidenceDigest }, result.receiptDigest);
    } finally { this.#release(initial, lockToken); }
  }

  #transition(attempt: ConnectorProvisioningAttempt, state: ConnectorProvisioningState, reason: string|null,
    origin?: string, originRevision?: number, trustGeneration?: string, trustDigest?: string,
    addedEvidence: Readonly<Record<string, string>> = {}, receipt?: string): ConnectorProvisioningAttempt {
    const evidence = JSON.stringify({ ...attempt.evidence, ...addedEvidence }); const nowMs = this.now(); let changed = false;
    const wrote = this.executeWrite(() => { const result = this.database.prepare(`UPDATE connector_provisioning_attempts SET
      state=?,origin=COALESCE(?,origin),origin_revision=COALESCE(?,origin_revision),trust_generation=COALESCE(?,trust_generation),
      trust_digest=COALESCE(?,trust_digest),evidence_json=?,external_receipt_digest=COALESCE(?,external_receipt_digest),reason_code=?,updated_at_ms=?
      WHERE provisioning_id=? AND nonce_hash=? AND state=? AND (trust_generation IS NULL OR trust_generation=COALESCE(?,trust_generation))`)
      .run(state, origin ?? null, originRevision ?? null, trustGeneration ?? null, trustDigest ?? null, evidence, receipt ?? null,
        reason, nowMs, attempt.provisioningId, attempt.nonceHash, attempt.state, attempt.trustGeneration); changed = result.changes === 1; });
    if (!wrote || !changed) throw new Error('connector_provisioning_cas_conflict');
    return this.#find(attempt.provisioningId)!;
  }

  async #readSameTrust(expected: Awaited<ReturnType<ConnectorProvisioningTrustChannel['readCurrent']>>,
    providerId: string): Promise<boolean> {
    try { const current = await this.dependencies.trustChannel!.readCurrent();
      return current.valid && current.generation === expected.generation && current.digest === expected.digest
        && current.dcrProviderIds.includes(providerId);
    } catch { return false; }
  }

  #acquire(attempt: ConnectorProvisioningAttempt, token: string): boolean { const nowMs = this.now(); let acquired = false;
    const wrote = this.executeWrite(() => { this.database.prepare(`INSERT INTO connector_provisioning_locks
      (installation_id,provider_id,provisioning_id,owner_token_hash,expires_at_ms) VALUES (?,?,?,?,?)
      ON CONFLICT(installation_id,provider_id) DO UPDATE SET provisioning_id=excluded.provisioning_id,
      owner_token_hash=excluded.owner_token_hash,expires_at_ms=excluded.expires_at_ms
      WHERE connector_provisioning_locks.expires_at_ms < ?`).run(this.installationId, attempt.providerId,
      attempt.provisioningId, token, nowMs + 30_000, nowMs); acquired = this.database.prepare(`SELECT 1 FROM connector_provisioning_locks
      WHERE installation_id=? AND provider_id=? AND provisioning_id=? AND owner_token_hash=? AND expires_at_ms>?`).get(
      this.installationId, attempt.providerId, attempt.provisioningId, token, nowMs) !== undefined; }); return wrote && acquired; }
  #renew(attempt: ConnectorProvisioningAttempt, token: string): boolean { const nowMs = this.now(); let renewed = false;
    const wrote = this.executeWrite(() => { const result = this.database.prepare(`UPDATE connector_provisioning_locks
      SET expires_at_ms=? WHERE installation_id=? AND provider_id=? AND provisioning_id=? AND owner_token_hash=? AND expires_at_ms>?`)
      .run(nowMs + 30_000, this.installationId, attempt.providerId, attempt.provisioningId, token, nowMs); renewed = result.changes === 1; });
    return wrote && renewed; }
  #lockActive(attempt: ConnectorProvisioningAttempt): boolean { return this.database.prepare(`SELECT 1 FROM connector_provisioning_locks
    WHERE installation_id=? AND provider_id=? AND provisioning_id=? AND expires_at_ms>?`).get(
    this.installationId, attempt.providerId, attempt.provisioningId, this.now()) !== undefined; }
  /** A reservation is never deleted automatically: only authenticated reconciliation may release it. */
  #reserveDcrEffect(attempt: ConnectorProvisioningAttempt): boolean { const nowMs = this.now(); let reserved = false;
    const wrote = this.executeWrite(() => { const result = this.database.prepare(`INSERT INTO connector_provisioning_provider_effects
      (installation_id,provider_id,provisioning_id,nonce_hash,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,'dcr_reserved',?,?)
      ON CONFLICT(installation_id,provider_id) DO NOTHING`).run(this.installationId, attempt.providerId,
      attempt.provisioningId, attempt.nonceHash, nowMs, nowMs); reserved = result.changes === 1; }); return wrote && reserved; }
  #markDcrEffect(attempt: ConnectorProvisioningAttempt, state: 'dcr_possible_effect'|'dcr_registered'): void {
    const nowMs = this.now(); const wrote = this.executeWrite(() => { const result = this.database.prepare(`UPDATE connector_provisioning_provider_effects
      SET state=?,updated_at_ms=? WHERE installation_id=? AND provider_id=? AND provisioning_id=? AND nonce_hash=?`)
      .run(state, nowMs, this.installationId, attempt.providerId, attempt.provisioningId, attempt.nonceHash);
      if (result.changes !== 1) throw new Error('connector_provisioning_effect_fence_lost'); });
    if (!wrote) throw new Error('connector_provisioning_effect_write_unavailable'); }
  #release(attempt: ConnectorProvisioningAttempt, token: string): void { this.executeWrite(() => { this.database.prepare(`DELETE FROM connector_provisioning_locks
    WHERE installation_id=? AND provider_id=? AND provisioning_id=? AND owner_token_hash=?`).run(this.installationId, attempt.providerId, attempt.provisioningId, token); }); }
  #find(id: string): ConnectorProvisioningAttempt|null { const row = this.database.prepare(`SELECT provisioning_id AS provisioningId,installation_id AS installationId,provider_id AS providerId,nonce_hash AS nonceHash,state,origin,origin_revision AS originRevision,trust_generation AS trustGeneration,trust_digest AS trustDigest,evidence_json AS evidenceJson,external_receipt_digest AS externalReceiptDigest,reason_code AS reasonCode,created_at_ms AS createdAtMs,updated_at_ms AS updatedAtMs FROM connector_provisioning_attempts WHERE provisioning_id=? AND installation_id=?`).get(id, this.installationId) as AttemptRow|undefined; return row ? normalize(row) : null; }
  #findByRequest(requestKeyHash: string): ConnectorProvisioningAttempt|null { const row = this.database.prepare(`SELECT provisioning_id AS provisioningId,installation_id AS installationId,provider_id AS providerId,nonce_hash AS nonceHash,state,origin,origin_revision AS originRevision,trust_generation AS trustGeneration,trust_digest AS trustDigest,evidence_json AS evidenceJson,external_receipt_digest AS externalReceiptDigest,reason_code AS reasonCode,created_at_ms AS createdAtMs,updated_at_ms AS updatedAtMs FROM connector_provisioning_attempts WHERE installation_id=? AND request_key_hash=?`).get(this.installationId, requestKeyHash) as AttemptRow|undefined; return row ? normalize(row) : null; }
  #eligible(): boolean { return this.database.prepare(`SELECT 1 FROM connector_provisioning_installation_eligibility
    WHERE installation_id=? AND eligible=1`).get(this.installationId) !== undefined; }
}
