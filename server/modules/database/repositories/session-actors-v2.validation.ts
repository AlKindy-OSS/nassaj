import { validEvidenceModel, validEvidenceRole } from '../../../shared/r3-evidence-lexical.js';

/** Validated internal snapshot. Native evidence production and authorization remain caller obligations. */
export type ActorObservation = { observation_ordinal: number; source_record_ordinal: number; turn_id_sha256: string; model: string; evidence_sha256: string };
export type ActorRow = { actor_id: string; launch_link_sha256: string; launch_evidence_sha256: string;
  requested_role: string | null; requested_model: string | null; requested_reasoning_effort: string | null;
  observed_role: string | null; evidence_status: string; evidence_code: string;
  role_mismatch: number; model_mismatch: number; sort_order: number; observations: ActorObservation[] };
export type ActorSnapshot = { session_id: string; source_revision_sha256: string; parser_contract_sha256: string;
  cache_revision: number; actors_status: string; status_reason: string; actor_count: number; parsed_at_ms: number; actors: ActorRow[] };
const unavailable = new Set(['child_binding_absent', 'child_binding_invalid', 'child_lineage_invalid', 'evidence_cap_exceeded', 'source_drift', 'authorization_revoked']);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const text = (v: unknown, cap: number): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= cap
  && v.normalize('NFC') === v && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v);
const nullableRole = (v: unknown) => v === null || validEvidenceRole(v);
const nullableModel = (v: unknown) => v === null || validEvidenceModel(v);
function demand(ok: unknown): asserts ok { if (!ok) throw new Error('session_actor_snapshot_invalid'); }

function validateObservations(actor: ActorRow): void {
  demand(Array.isArray(actor.observations) && actor.observations.length <= 256);
  let previous = -1;
  const turns = new Set<string>();
  for (const [index, row] of actor.observations.entries()) {
    demand(row && row.observation_ordinal === index && integer(row.source_record_ordinal) && row.source_record_ordinal > previous);
    demand(hash(row.turn_id_sha256) && !turns.has(row.turn_id_sha256) && hash(row.evidence_sha256) && validEvidenceModel(row.model));
    previous = row.source_record_ordinal;
    turns.add(row.turn_id_sha256);
  }
  demand(actor.observations.length > 0 || (actor.evidence_status !== 'complete' && actor.model_mismatch === 0));
}
function validateActor(actor: ActorRow, index: number): void {
  demand(actor && hash(actor.launch_link_sha256) && actor.actor_id === `act_${actor.launch_link_sha256}` && hash(actor.launch_evidence_sha256));
  demand(actor.sort_order === index && nullableRole(actor.requested_role) && nullableModel(actor.requested_model)
    && (actor.requested_reasoning_effort === null || text(actor.requested_reasoning_effort, 32)) && nullableRole(actor.observed_role));
  demand(actor.requested_reasoning_effort === null || ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(actor.requested_reasoning_effort));
  demand(integer(actor.role_mismatch, 0, 1) && integer(actor.model_mismatch, 0, 1));
  validateObservations(actor);
  const roleMismatch = actor.requested_role !== null && actor.observed_role !== null && actor.requested_role !== actor.observed_role;
  const modelMismatch = actor.requested_model !== null && actor.observations.length > 0 && actor.requested_model !== actor.observations[0].model;
  demand(actor.role_mismatch === Number(roleMismatch) && actor.model_mismatch === Number(modelMismatch));
  if (actor.evidence_code === 'requested_invalid') {
    demand(actor.evidence_status === 'partial' && [actor.requested_role, actor.requested_model, actor.requested_reasoning_effort].includes(null));
  } else if (roleMismatch || modelMismatch) {
    demand(actor.evidence_status === 'mismatch' && actor.evidence_code === (roleMismatch ? 'role_mismatch' : 'model_mismatch'));
  } else if (actor.observed_role === null) {
    demand(actor.evidence_status === 'partial' && actor.evidence_code === 'observed_role_missing');
  } else if (actor.evidence_code === 'turn_evidence_conflict') {
    demand(actor.evidence_status === 'partial');
  } else if (actor.observations.length === 0) {
    demand(actor.evidence_status === 'partial' && actor.evidence_code === 'model_missing');
  } else demand(actor.evidence_status === 'complete' && actor.evidence_code === 'complete');
}

/** Shared cross-field check before CAS, after SQL readback and immediately before DTO projection. */
export function assertActorSnapshot(snapshot: ActorSnapshot): void {
  demand(snapshot && text(snapshot.session_id, 256) && hash(snapshot.source_revision_sha256) && hash(snapshot.parser_contract_sha256));
  demand(integer(snapshot.cache_revision, 1) && integer(snapshot.parsed_at_ms) && integer(snapshot.actor_count, 0, 256));
  demand(Array.isArray(snapshot.actors) && snapshot.actors.length === snapshot.actor_count);
  const ids = new Set<string>();
  snapshot.actors.forEach((actor, index) => { validateActor(actor, index); demand(!ids.has(actor.actor_id)); ids.add(actor.actor_id); });
  if (snapshot.actors_status === 'unavailable') demand(unavailable.has(snapshot.status_reason) && snapshot.actor_count === 0);
  else if (snapshot.actors_status === 'partial') demand(snapshot.status_reason === 'partial_actor_evidence' && snapshot.actor_count > 0
    && snapshot.actors.some(actor => actor.evidence_status !== 'complete'));
  else demand(snapshot.actors_status === 'complete' && snapshot.actors.every(actor => actor.evidence_status === 'complete')
    && snapshot.status_reason === (snapshot.actor_count === 0 ? 'no_children' : 'complete'));
}

/** Project only whitelisted public evidence fields; never expose source, launch or fence internals. */
export function actorSnapshotDto(snapshot: ActorSnapshot) {
  assertActorSnapshot(snapshot);
  return { schemaVersion: 2, actorsStatus: snapshot.actors_status, actorsEvidenceCode: snapshot.status_reason,
    actors: snapshot.actors.map(actor => ({ actorId: actor.actor_id, requestedRole: actor.requested_role,
      requestedModel: actor.requested_model, requestedReasoningEffort: actor.requested_reasoning_effort,
      observedRole: actor.observed_role, observedModels: actor.observations.map(row => row.model),
      evidenceStatus: actor.evidence_status, evidenceCode: actor.evidence_code,
      roleMismatch: actor.role_mismatch === 1, modelMismatch: actor.model_mismatch === 1 })) };
}
