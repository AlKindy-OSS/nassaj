import { createHash } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { AgentReviewProbeAdmissions, type ReviewProbeAdmission, type ReviewProbeSelection } from './agent-review-probe-admission.db.js';
import { readIncidentObservationChain } from './agent-review-observation-chain.js';
import { AgentReviewError, assertReviewKeys, assertReviewToken, hashReviewTuple } from './agent-review-validation.js';
import {
  type ReviewContainer, type ReviewHead, type ReviewIncident, type ReviewIncidentInput, type ReviewRecovery,
  validateReviewContainer, validateReviewHead, validateReviewIncident, validateReviewRecovery,
} from './agent-review-ingestion-types.js';

const EMPTY_SHA = createHash('sha256').update('').digest('hex');
const INCIDENT_COLUMNS = `incident_id AS incidentId,session_id AS sessionId,source,source_container_id AS sourceContainerId,
  scope,scope_agent_id AS scopeAgentId,incident_generation AS incidentGeneration,reason,evidence_sha256 AS evidenceSha256,revision,state`;

function requireTransaction(db: Database): void {
  if (!db.inTransaction) throw new AgentReviewError('ingestion_transaction_required');
}

function containerArgs(container: ReviewContainer): [string, string, string] {
  return [container.sessionId, container.source, container.sourceContainerId];
}

function readHead(db: Database, container: ReviewContainer): ReviewHead | null {
  return db.prepare(`SELECT session_id AS sessionId,source,source_container_id AS sourceContainerId,file_dev AS fileDev,
    file_ino AS fileIno,last_complete_ordinal AS lastCompleteOrdinal,last_complete_offset AS lastCompleteOffset,
    stable_size AS stableSize,rolling_prefix_sha256 AS rollingPrefixSha256,last_result_sequence AS lastResultSequence,revision
    FROM agent_review_ingestion_heads WHERE session_id=? AND source=? AND source_container_id=?`)
    .get(...containerArgs(container)) as ReviewHead | undefined ?? null;
}

function assertCommittedPrefix(db: Database, input: ReviewIncidentInput): void {
  const head = readHead(db, input);
  if (input.lastCommittedOffset !== (head?.lastCompleteOffset ?? 0)
    || input.lastCommittedPrefixSha256 !== (head?.rollingPrefixSha256 ?? EMPTY_SHA)) {
    throw new AgentReviewError('stale_ingestion_head');
  }
}

function limitScope(db: Database, input: ReviewIncidentInput): ReviewIncidentInput {
  if (input.scope !== 'identity') return input;
  const count = db.prepare(`SELECT COUNT(*) AS n FROM agent_review_quarantine_incidents
    WHERE session_id=? AND source=? AND source_container_id=? AND scope='identity' AND state='active'`)
    .get(...containerArgs(input)) as { n: number };
  return count.n >= 1024 ? { ...input, scope: 'container', scopeAgentId: '', reason: 'quarantine_identity_cap' } : input;
}

function activeIncident(db: Database, input: ReviewIncidentInput): ReviewIncident | undefined {
  return db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM agent_review_quarantine_incidents
    WHERE session_id=? AND source=? AND source_container_id=? AND scope=? AND scope_agent_id=? AND state='active'`)
    .get(...containerArgs(input), input.scope, input.scopeAgentId) as ReviewIncident | undefined;
}

function insertIncident(db: Database, input: ReviewIncidentInput, evidence: string): ReviewIncident {
  const generation = db.prepare(`SELECT COALESCE(MAX(incident_generation),0) AS n FROM agent_review_quarantine_incidents
    WHERE session_id=? AND source=? AND source_container_id=? AND scope=? AND scope_agent_id=?`)
    .get(...containerArgs(input), input.scope, input.scopeAgentId) as { n: number };
  if (generation.n >= Number.MAX_SAFE_INTEGER) throw new AgentReviewError('incident_generation_exhausted');
  const result = db.prepare(`INSERT INTO agent_review_quarantine_incidents
    (session_id,source,source_container_id,scope,scope_agent_id,incident_generation,state,reason,evidence_sha256,revision,quarantined_at)
    VALUES (?,?,?,?,?,?,'active',?,?,0,?)`).run(...containerArgs(input), input.scope, input.scopeAgentId,
    generation.n + 1, input.reason, evidence, new Date().toISOString());
  return db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM agent_review_quarantine_incidents WHERE incident_id=?`)
    .get(result.lastInsertRowid) as ReviewIncident;
}

function appendObservation(db: Database, active: ReviewIncident, input: ReviewIncidentInput, evidence: string): ReviewIncident {
  const chain = readIncidentObservationChain(db, active.incidentId);
  if (active.evidenceSha256 === evidence || db.prepare(`SELECT 1 FROM agent_review_quarantine_observations
    WHERE incident_id=? AND evidence_sha256=?`).get(active.incidentId, evidence)) return active;
  if (chain.observationCount === 63) throw new AgentReviewError('quarantine_observation_cap');
  if (chain.effectivelyStructural) throw new AgentReviewError('unavailable');
  db.prepare(`INSERT INTO agent_review_quarantine_observations
    (incident_id,observation_sequence,reason,evidence_sha256,observed_at) VALUES (?,?,?,?,?)`)
    .run(active.incidentId, chain.observationCount + 1, input.reason, evidence, new Date().toISOString());
  return active;
}

function checkedIncident(db: Database, input: ReviewIncidentInput): ReviewIncident {
  assertCommittedPrefix(db, input);
  const exact = activeIncident(db, input);
  const inputHash = hashReviewTuple({ schema: 'nassaj-agent-review-incident/v2', ...input });
  if (exact) {
    if (exact.evidenceSha256 !== inputHash) throw new AgentReviewError('quarantine_active_conflict');
    return exact;
  }
  const bounded = limitScope(db, input);
  const evidence = hashReviewTuple({ schema: 'nassaj-agent-review-incident/v2', ...bounded });
  const active = activeIncident(db, bounded);
  if (active) {
    if (active.evidenceSha256 !== evidence) throw new AgentReviewError('quarantine_active_conflict');
    return active;
  }
  return insertIncident(db, bounded, evidence);
}

function recoveryHash(input: ReviewRecovery): string {
  return hashReviewTuple({ schema: 'nassaj-agent-review-recovery/v2', incidentId: input.incidentId,
    incidentGeneration: input.incidentGeneration, incidentEvidenceSha256: input.incidentEvidenceSha256,
    expectedRevision: input.expectedRevision, observationCount: input.observationCount, observationChainSha256: input.observationChainSha256,
    stableFileDev: input.stableFileDev, stableFileIno: input.stableFileIno, stableSize: input.stableSize,
    stablePrefixSha256: input.stablePrefixSha256, uniqueRelationEvidenceSha256: input.uniqueRelationEvidenceSha256 });
}

function assertRecoveryHead(db: Database, incident: ReviewIncident, input: ReviewRecovery): void {
  const head = readHead(db, incident);
  if (input.committedPrefixSha256 !== (head?.rollingPrefixSha256 ?? EMPTY_SHA)
    || (head && (head.fileDev !== input.stableFileDev || head.fileIno !== input.stableFileIno
      || input.stableSize < head.stableSize))) throw new AgentReviewError('stale_ingestion_head');
}

/** Internal storage for trusted ingestion only; no route, parser or filesystem authority is created here. */
export class AgentReviewIngestionRepository {
  readonly #admissions: AgentReviewProbeAdmissions;
  constructor(private readonly db: Database) { this.#admissions = new AgentReviewProbeAdmissions(db); }

  /** Capture a one-shot database snapshot before trusted ingestion touches provider bytes. */
  captureProbeAdmission(container: ReviewContainer, expectedSessionPath: string, selection?: ReviewProbeSelection): ReviewProbeAdmission {
    assertReviewKeys(container, ['sessionId', 'source', 'sourceContainerId']);
    return this.#admissions.capture(container, expectedSessionPath, selection);
  }

  /** Append or create only under the exact captured admission; stale recovery never becomes fresh creation. */
  recordAdmittedIncident(input: ReviewIncidentInput, expectedSessionPath: string, token: ReviewProbeAdmission): ReviewIncident {
    try {
      validateReviewIncident(input);
      if (this.db.inTransaction) throw new AgentReviewError('nested_transaction');
      return this.db.transaction(() => {
        const admitted = this.#admissions.consume(token, { sessionId: input.sessionId, source: input.source,
          sourceContainerId: input.sourceContainerId }, expectedSessionPath);
        if (admitted.mode === 'fresh') return checkedIncident(this.db, input);
        if (input.scope !== admitted.incidentScope || input.scopeAgentId !== admitted.incidentScopeAgentId) {
          throw new AgentReviewError('stale_probe_admission');
        }
        const selected = activeIncident(this.db, input);
        if (!selected || selected.incidentId !== admitted.incidentId) throw new AgentReviewError('stale_probe_admission');
        assertCommittedPrefix(this.db, input);
        return appendObservation(this.db, selected, input, hashReviewTuple({ schema: 'nassaj-agent-review-incident/v2', ...input }));
      }).immediate();
    } finally { this.#admissions.discard(token); }
  }

  /** Read committed evidence without repairing or creating state. */
  readHead(container: ReviewContainer): ReviewHead | null {
    assertReviewKeys(container, ['sessionId', 'source', 'sourceContainerId']);
    validateReviewContainer(container);
    return readHead(this.db, container);
  }

  /** Record one durable incident in a separate transaction after a failed ingestion attempt has rolled back. */
  recordIncident(input: ReviewIncidentInput): ReviewIncident {
    validateReviewIncident(input);
    if (this.db.inTransaction) throw new AgentReviewError('nested_transaction');
    return this.db.transaction(() => checkedIncident(this.db, input)).immediate();
  }

  /** Recheck the exact server binding under the incident write lock, before its first effect. */
  recordBoundIncident(input: ReviewIncidentInput, expectedSessionPath: string): ReviewIncident {
    validateReviewIncident(input);
    if (typeof expectedSessionPath !== 'string' || !expectedSessionPath || expectedSessionPath.length > 4096) {
      throw new AgentReviewError('untrusted_provenance');
    }
    if (this.db.inTransaction) throw new AgentReviewError('nested_transaction');
    return this.db.transaction(() => {
      const bound = this.db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND provider='claude' AND jsonl_path=?")
        .get(input.sessionId, expectedSessionPath);
      if (!bound) throw new AgentReviewError('untrusted_provenance');
      return checkedIncident(this.db, input);
    }).immediate();
  }

  /** CAS a committed head inside the same caller-owned transaction as its result/binding/event writes. */
  advanceHead(expected: ReviewHead | null, next: ReviewHead, committedPrefixSha256: string): boolean {
    requireTransaction(this.db); validateReviewHead(next);
    if (expected) validateReviewHead(expected);
    assertReviewToken(committedPrefixSha256, 'sha');
    const current = readHead(this.db, next);
    if ((current ? hashReviewTuple(current) : null) !== (expected ? hashReviewTuple(expected) : null)) throw new AgentReviewError('stale_ingestion_head');
    if (committedPrefixSha256 !== (current?.rollingPrefixSha256 ?? EMPTY_SHA)) throw new AgentReviewError('prefix_changed');
    const active = this.db.prepare(`SELECT 1 FROM agent_review_quarantine_incidents
      WHERE session_id=? AND source=? AND source_container_id=? AND state='active' LIMIT 1`).get(...containerArgs(next));
    if (active) throw new AgentReviewError('unavailable');
    if (current && hashReviewTuple(current) === hashReviewTuple(next)) return false;
    this.assertHeadAdvance(current, next);
    this.writeHead(current, next);
    return true;
  }

  /** Persist only an exact retryable recovery, after trusted ingestion has verified a stable full snapshot and unique relation. */
  recoverIncident(input: ReviewRecovery): void {
    requireTransaction(this.db); validateReviewRecovery(input);
    const incident = this.db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM agent_review_quarantine_incidents WHERE incident_id=?`)
      .get(input.incidentId) as ReviewIncident | undefined;
    if (!incident || incident.state !== 'active' || incident.incidentGeneration !== input.incidentGeneration
      || incident.evidenceSha256 !== input.incidentEvidenceSha256 || incident.revision !== input.expectedRevision) {
      throw new AgentReviewError('stale_incident');
    }
    if (!['unstable_read', 'source_grew', 'read_timeout'].includes(incident.reason)) throw new AgentReviewError('recovery_forbidden');
    const chain = readIncidentObservationChain(this.db, incident.incidentId);
    if (chain.effectivelyStructural) throw new AgentReviewError('recovery_forbidden');
    if (chain.observationCount !== input.observationCount || chain.observationChainSha256 !== input.observationChainSha256) {
      throw new AgentReviewError('stale_incident');
    }
    assertRecoveryHead(this.db, incident, input);
    const updated = this.db.prepare(`UPDATE agent_review_quarantine_incidents SET state='recovered',revision=revision+1,
      recovered_at=?,recovery_evidence_sha256=?,recovery_observation_count=?,recovery_observation_chain_sha256=? WHERE incident_id=? AND incident_generation=? AND evidence_sha256=?
      AND revision=? AND state='active'`).run(new Date().toISOString(), recoveryHash(input), chain.observationCount, chain.observationChainSha256, input.incidentId,
      input.incidentGeneration, input.incidentEvidenceSha256, input.expectedRevision);
    if (updated.changes !== 1) throw new AgentReviewError('stale_incident');
  }

  private assertHeadAdvance(current: ReviewHead | null, next: ReviewHead): void {
    if (!current) {
      if (next.revision !== 0) throw new AgentReviewError('stale_ingestion_head');
      return;
    }
    if (current.revision === Number.MAX_SAFE_INTEGER || next.revision !== current.revision + 1
      || next.fileDev !== current.fileDev || next.fileIno !== current.fileIno
      || next.lastCompleteOffset <= current.lastCompleteOffset || next.lastCompleteOrdinal <= current.lastCompleteOrdinal
      || next.stableSize < current.stableSize || next.lastResultSequence < current.lastResultSequence) {
      throw new AgentReviewError('invalid_sequence');
    }
  }

  private writeHead(current: ReviewHead | null, next: ReviewHead): void {
    const fields = [next.fileDev, next.fileIno, next.lastCompleteOrdinal, next.lastCompleteOffset, next.stableSize,
      next.rollingPrefixSha256, next.lastResultSequence, next.revision, new Date().toISOString()];
    if (!current) {
      this.db.prepare(`INSERT INTO agent_review_ingestion_heads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...containerArgs(next), ...fields);
      return;
    }
    const changed = this.db.prepare(`UPDATE agent_review_ingestion_heads SET file_dev=?,file_ino=?,last_complete_ordinal=?,
      last_complete_offset=?,stable_size=?,rolling_prefix_sha256=?,last_result_sequence=?,revision=?,updated_at=?
      WHERE session_id=? AND source=? AND source_container_id=? AND revision=?`).run(...fields, ...containerArgs(next), current.revision);
    if (changed.changes !== 1) throw new AgentReviewError('stale_ingestion_head');
  }
}
