import type { Database } from 'better-sqlite3';

import { REVIEW_INCIDENT_REASONS, type ReviewIncidentReason } from './agent-review-ingestion-types.js';
import { AgentReviewError, assertReviewInteger, assertReviewToken, hashReviewTuple } from './agent-review-validation.js';

export type StoredIncidentReason = ReviewIncidentReason;
export type IncidentTransportReason = StoredIncidentReason | 'quarantine_observation_cap' | 'quarantine_chain_invalid';
export type IncidentChainBase = {
  incidentId: number; incidentGeneration: number; reason: StoredIncidentReason; evidenceSha256: string;
  state: 'active' | 'recovered'; recoveryObservationCount: number | null; recoveryObservationChainSha256: string | null;
};
export type IncidentChildObservation = { sequence: number; reason: StoredIncidentReason; evidenceSha256: string };
export type IncidentChain = {
  observationCount: number; observationChainSha256: string; effectivelyStructural: boolean;
  reason: IncidentTransportReason; evidenceSha256: string;
};
const RETRYABLE = new Set<string>(['unstable_read', 'source_grew', 'read_timeout']);

function validateReason(reason: unknown): void {
  if (!REVIEW_INCIDENT_REASONS.includes(reason as StoredIncidentReason)) throw new AgentReviewError('quarantine_chain_invalid');
}

/** Validate the same immutable chain for storage, recovery, restart and read-only transport. */
export function validateIncidentObservationChain(base: IncidentChainBase, observations: readonly IncidentChildObservation[]): IncidentChain {
  assertReviewInteger(base.incidentId, 1); assertReviewInteger(base.incidentGeneration, 1);
  assertReviewToken(base.evidenceSha256, 'sha'); validateReason(base.reason);
  if (observations.length > 63) throw new AgentReviewError('quarantine_chain_invalid');
  const seen = new Set([base.evidenceSha256]);
  let structural = !RETRYABLE.has(base.reason);
  let effective = { reason: base.reason, evidenceSha256: base.evidenceSha256 };
  for (const [index, child] of observations.entries()) {
    validateReason(child.reason); assertReviewToken(child.evidenceSha256, 'sha');
    if (structural || child.sequence !== index + 1 || seen.has(child.evidenceSha256)) throw new AgentReviewError('quarantine_chain_invalid');
    seen.add(child.evidenceSha256);
    if (!RETRYABLE.has(child.reason)) { structural = true; effective = child; }
  }
  const observationChainSha256 = hashReviewTuple({ schema: 'nassaj-agent-review-observation-chain/v1',
    incidentId: base.incidentId, incidentGeneration: base.incidentGeneration, baseEvidenceSha256: base.evidenceSha256,
    observations: observations.map(({ sequence, reason, evidenceSha256 }) => ({ sequence, reason, evidenceSha256 })) });
  const saturated = observations.length === 63;
  validateClosure(base, observations.length, observationChainSha256, structural || saturated);
  return { observationCount: observations.length, observationChainSha256, effectivelyStructural: structural || saturated,
    reason: saturated && !structural ? 'quarantine_observation_cap' : effective.reason,
    evidenceSha256: saturated && !structural ? observationChainSha256 : effective.evidenceSha256 };
}

function validateClosure(base: IncidentChainBase, count: number, sha: string, structural: boolean): void {
  if (base.state === 'active' && base.recoveryObservationCount === null && base.recoveryObservationChainSha256 === null) return;
  if (base.state === 'recovered' && !structural && base.recoveryObservationCount === count
    && base.recoveryObservationChainSha256 === sha) return;
  throw new AgentReviewError('quarantine_chain_invalid');
}

/** Read a hard bounded child ledger, including one overflow sentinel for corrupt databases. */
export function readIncidentObservationChain(db: Database, incidentId: number): IncidentChain {
  assertReviewInteger(incidentId, 1);
  const base = db.prepare(`SELECT incident_id AS incidentId,incident_generation AS incidentGeneration,reason,
    evidence_sha256 AS evidenceSha256,state,recovery_observation_count AS recoveryObservationCount,
    recovery_observation_chain_sha256 AS recoveryObservationChainSha256
    FROM agent_review_quarantine_incidents WHERE incident_id=?`).get(incidentId) as IncidentChainBase | undefined;
  if (!base) throw new AgentReviewError('stale_incident');
  const children = db.prepare(`SELECT observation_sequence AS sequence,reason,evidence_sha256 AS evidenceSha256
    FROM agent_review_quarantine_observations WHERE incident_id=? ORDER BY observation_sequence LIMIT 64`)
    .all(incidentId) as IncidentChildObservation[];
  return validateIncidentObservationChain(base, children);
}

/** Fail closed without echoing unknown stored reasons or exposing provider evidence rows. */
export function projectIncidentObservationChain(db: Database, incidentId: number): IncidentChain {
  try { return readIncidentObservationChain(db, incidentId); }
  catch (error) {
    if (!(error instanceof AgentReviewError)) throw error;
    const base = db.prepare(`SELECT substr(CAST(reason AS TEXT),1,64) AS reason,
      substr(CAST(evidence_sha256 AS TEXT),1,65) AS evidence,state,
      substr(CAST(recovery_observation_count AS TEXT),1,32) AS count,
      substr(CAST(recovery_observation_chain_sha256 AS TEXT),1,65) AS seal
      FROM agent_review_quarantine_incidents WHERE incident_id=?`).get(incidentId);
    const children = db.prepare(`SELECT substr(CAST(observation_sequence AS TEXT),1,32) AS sequence,
      substr(CAST(reason AS TEXT),1,64) AS reason,substr(CAST(evidence_sha256 AS TEXT),1,65) AS evidence
      FROM agent_review_quarantine_observations WHERE incident_id=? ORDER BY observation_sequence LIMIT 64`).all(incidentId);
    const sha = hashReviewTuple({ schema: 'nassaj-agent-review-invalid-chain/v1', incidentId, base: base ?? null, children });
    return { observationCount: children.length, observationChainSha256: sha, effectivelyStructural: true,
      reason: 'quarantine_chain_invalid', evidenceSha256: sha };
  }
}
