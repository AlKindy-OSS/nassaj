import { createHash } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { type ReviewContainer, validateReviewContainer } from './agent-review-ingestion-types.js';
import { readIncidentObservationChain } from './agent-review-observation-chain.js';
import { AgentReviewError, assertReviewKeys, assertReviewToken, hashReviewTuple } from './agent-review-validation.js';

/** Opaque process-local marker: its properties never constitute admission evidence. */
export type ReviewProbeAdmission = Readonly<Record<never, never>>;
export type ReviewProbeSelection = { scope: 'container' | 'identity'; scopeAgentId: string };
type Snapshot = {
  schema: 'nassaj-agent-review-probe-admission/v1'; mode: 'fresh' | 'recovery';
  sessionId: string; source: string; sourceContainerId: string; sessionPathBindingSha256: string;
  headRevision: number | null; committedPrefixSha256: string; headSha256: string;
  activeSetSha256: string; historySha256: string; incidentId: number | null; incidentGeneration: number | null;
  incidentScope: 'container' | 'identity' | null; incidentScopeAgentId: string | null;
  incidentRevision: number | null; observationCount: number | null; observationChainSha256: string | null;
};
type IncidentIdentity = { incidentId: number; incidentGeneration: number; revision: number; state: string; scope: 'container' | 'identity'; scopeAgentId: string };
const EMPTY = createHash('sha256').update('').digest('hex');

function pathBinding(db: Database, container: ReviewContainer, sessionPath: string): string {
  if (typeof sessionPath !== 'string' || !sessionPath || sessionPath.length > 4096
    || !db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND provider='claude' AND jsonl_path=?")
      .get(container.sessionId, sessionPath)) throw new AgentReviewError('untrusted_provenance');
  return hashReviewTuple({ sessionId: container.sessionId, provider: 'claude', sessionPath });
}

function validateSelection(selection: ReviewProbeSelection): void {
  assertReviewKeys(selection, ['scope', 'scopeAgentId']);
  if (selection.scope === 'identity') assertReviewToken(selection.scopeAgentId, 'agent');
  else if (selection.scope !== 'container' || selection.scopeAgentId !== '') throw new AgentReviewError('invalid_input');
}

function activeSnapshot(db: Database, container: ReviewContainer, selection?: ReviewProbeSelection) {
  const rows = db.prepare(`SELECT incident_id AS incidentId,incident_generation AS incidentGeneration,revision,state,scope,scope_agent_id AS scopeAgentId
    FROM agent_review_quarantine_incidents WHERE session_id=? AND source=? AND source_container_id=? AND state='active'
    ORDER BY incident_id LIMIT 1026`).all(container.sessionId, container.source, container.sourceContainerId) as IncidentIdentity[];
  if (rows.length > 1025) throw new AgentReviewError('unavailable');
  const active = rows.map(row => ({ ...row, ...readIncidentObservationChain(db, row.incidentId) }));
  if (active.some(row => row.effectivelyStructural)) throw new AgentReviewError('unavailable');
  if (selection) validateSelection(selection);
  const selected = selection ? active.find(row => row.scope === selection.scope && row.scopeAgentId === selection.scopeAgentId) : active[0];
  if ((selection && !selected) || (!selection && active.length > 1)) throw new AgentReviewError('probe_selection_required');
  // Hash each bounded row first: a full identity-cap ledger exceeds the canonical tuple byte budget.
  return { first: selected, sha: createHash('sha256').update(active.map(row => hashReviewTuple(row)).join('')).digest('hex') };
}

function closedHistorySha(db: Database, container: ReviewContainer): string {
  // Exact index prefix plus implicit rowid order: one historical row, never an unbounded history scan.
  const row = db.prepare(`SELECT incident_id AS incidentId FROM agent_review_quarantine_incidents
    INDEXED BY idx_agent_review_quarantine_session_state
    WHERE session_id=? AND state='recovered' AND source=? AND source_container_id=?
    ORDER BY incident_id DESC LIMIT 1`).get(container.sessionId, container.source, container.sourceContainerId) as { incidentId: number } | undefined;
  if (!row) return EMPTY;
  return hashReviewTuple({ incidentId: row.incidentId, ...readIncidentObservationChain(db, row.incidentId) });
}

function captureSnapshot(db: Database, container: ReviewContainer, sessionPath: string, selection?: ReviewProbeSelection): Snapshot {
  validateReviewContainer(container);
  const sessionPathBindingSha256 = pathBinding(db, container, sessionPath);
  const historySha256 = closedHistorySha(db, container);
  const active = activeSnapshot(db, container, selection);
  const head = db.prepare(`SELECT file_dev,file_ino,last_complete_ordinal,last_complete_offset,stable_size,
    rolling_prefix_sha256,last_result_sequence,revision FROM agent_review_ingestion_heads
    WHERE session_id=? AND source=? AND source_container_id=?`).get(container.sessionId, container.source,
    container.sourceContainerId) as Record<string, string | number> | undefined;
  return Object.freeze({ schema: 'nassaj-agent-review-probe-admission/v1', ...container,
    mode: active.first ? 'recovery' : 'fresh', sessionPathBindingSha256,
    headRevision: head ? Number(head.revision) : null, committedPrefixSha256: head ? String(head.rolling_prefix_sha256) : EMPTY,
    headSha256: head ? hashReviewTuple(head) : EMPTY, activeSetSha256: active.sha, historySha256,
    incidentScope: active.first?.scope ?? null, incidentScopeAgentId: active.first?.scopeAgentId ?? null,
    incidentId: active.first?.incidentId ?? null, incidentGeneration: active.first?.incidentGeneration ?? null,
    incidentRevision: active.first?.revision ?? null, observationCount: active.first?.observationCount ?? null,
    observationChainSha256: active.first?.observationChainSha256 ?? null });
}

/** Connection-bound, one-shot admissions for trusted ingestion; no client or persisted token is accepted. */
export class AgentReviewProbeAdmissions {
  readonly #tokens = new WeakMap<object, Snapshot>();
  constructor(private readonly db: Database) {}

  /** Capture one coherent pre-filesystem snapshot without acquiring write authority or writing state. */
  capture(container: ReviewContainer, sessionPath: string, selection?: ReviewProbeSelection): ReviewProbeAdmission {
    if (this.db.inTransaction) throw new AgentReviewError('nested_transaction');
    const snapshot = this.db.transaction(() => captureSnapshot(this.db, container, sessionPath, selection))();
    const token = Object.freeze(Object.create(null)) as ReviewProbeAdmission;
    this.#tokens.set(token, snapshot);
    return token;
  }

  /** Retire an attempted operation even when SQLite refused BEGIN before its callback. */
  discard(token: ReviewProbeAdmission): void {
    if (token && typeof token === 'object') this.#tokens.delete(token);
  }

  /** Consume even rejected admissions, then compare every bound field under the caller's write transaction. */
  consume(token: ReviewProbeAdmission, container: ReviewContainer, sessionPath: string): Readonly<Snapshot> {
    const expected = token && typeof token === 'object' ? this.#tokens.get(token) : undefined;
    if (token && typeof token === 'object') this.#tokens.delete(token);
    if (!this.db.inTransaction || !expected) throw new AgentReviewError('stale_probe_admission');
    const selection = expected.incidentScope === null ? undefined
      : { scope: expected.incidentScope, scopeAgentId: expected.incidentScopeAgentId! };
    let actual: Snapshot;
    try { actual = captureSnapshot(this.db, container, sessionPath, selection); }
    catch (error) {
      if (error instanceof AgentReviewError && error.code === 'probe_selection_required') throw new AgentReviewError('stale_probe_admission');
      throw error;
    }
    if (hashReviewTuple(actual) !== hashReviewTuple(expected)) throw new AgentReviewError('stale_probe_admission');
    return expected;
  }
}
