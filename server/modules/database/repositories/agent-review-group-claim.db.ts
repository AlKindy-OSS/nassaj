import { createHash } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { type ReviewContainer, type ReviewHead, type ReviewIncident, validateReviewContainer, validateReviewHead } from './agent-review-ingestion-types.js';
import { type IncidentChainBase, type IncidentChildObservation, type IncidentChain,
  readIncidentObservationChain, validateIncidentObservationChain } from './agent-review-observation-chain.js';
import { AgentReviewError, assertReviewInteger, assertReviewKeys, assertReviewToken, hashReviewTuple } from './agent-review-validation.js';

export type ReviewGroupClaim = Readonly<Record<never, never>>;
type ActiveMember = ReviewIncident & IncidentChainBase;
type BoundMember = Readonly<ActiveMember & Pick<IncidentChain, 'observationCount' | 'observationChainSha256' | 'effectivelyStructural'>>;
export type ReviewGroupCapture = Readonly<{
  container: Readonly<ReviewContainer>; sessionPathBindingSha256: string; head: Readonly<ReviewHead> | null;
  mode: 'fresh' | 'recovery'; historySha256: string; activeSetSha256: string; bindingSha256: string;
  active: readonly BoundMember[];
}>;
type ChildRow = IncidentChildObservation & { incidentId: number };
const EMPTY = createHash('sha256').update('').digest('hex');
const MAX_ACTIVE = 1025;
const MAX_DETECTION_CHILDREN = 64576;
const MAX_RECOVERABLE_CHILDREN = 63550;

function args(container: ReviewContainer): [string, string, string] {
  return [container.sessionId, container.source, container.sourceContainerId];
}

function boundPath(db: Database, container: ReviewContainer, sessionPath: string): string {
  if (typeof sessionPath !== 'string' || !sessionPath || sessionPath.length > 4096
    || !db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND provider='claude' AND jsonl_path=?")
      .get(container.sessionId, sessionPath)) throw new AgentReviewError('untrusted_provenance');
  return hashReviewTuple({ sessionId: container.sessionId, provider: 'claude', sessionPath });
}

function headFor(db: Database, container: ReviewContainer): ReviewHead | null {
  const head = db.prepare(`SELECT session_id AS sessionId,source,source_container_id AS sourceContainerId,
    file_dev AS fileDev,file_ino AS fileIno,last_complete_ordinal AS lastCompleteOrdinal,
    last_complete_offset AS lastCompleteOffset,stable_size AS stableSize,rolling_prefix_sha256 AS rollingPrefixSha256,
    last_result_sequence AS lastResultSequence,revision FROM agent_review_ingestion_heads
    WHERE session_id=? AND source=? AND source_container_id=?`).get(...args(container)) as ReviewHead | undefined;
  if (!head) return null;
  validateReviewHead(head);
  return Object.freeze(head);
}

function historyFor(db: Database, container: ReviewContainer): string {
  const row = db.prepare(`SELECT incident_id AS incidentId FROM agent_review_quarantine_incidents
    INDEXED BY idx_agent_review_quarantine_session_state
    WHERE session_id=? AND state='recovered' AND source=? AND source_container_id=?
    ORDER BY incident_id DESC LIMIT 1`).get(...args(container)) as { incidentId: number } | undefined;
  return row ? hashReviewTuple({ incidentId: row.incidentId, ...readIncidentObservationChain(db, row.incidentId) }) : EMPTY;
}

function activeRows(db: Database, container: ReviewContainer): ActiveMember[] {
  const rows = db.prepare(`SELECT incident_id AS incidentId,session_id AS sessionId,source,
    source_container_id AS sourceContainerId,scope,scope_agent_id AS scopeAgentId,incident_generation AS incidentGeneration,
    reason,evidence_sha256 AS evidenceSha256,revision,state,recovery_observation_count AS recoveryObservationCount,
    recovery_observation_chain_sha256 AS recoveryObservationChainSha256 FROM agent_review_quarantine_incidents
    WHERE session_id=? AND source=? AND source_container_id=? AND state='active' ORDER BY incident_id LIMIT 1026`)
    .all(...args(container)) as ActiveMember[];
  if (rows.length > MAX_ACTIVE) throw new AgentReviewError('unavailable');
  let identities = 0; let containers = 0;
  const scopes = new Set<string>();
  for (const row of rows) {
    assertReviewInteger(row.incidentId, 1); assertReviewInteger(row.incidentGeneration, 1); assertReviewInteger(row.revision);
    if (row.scope === 'identity') { assertReviewToken(row.scopeAgentId, 'agent'); identities++; }
    else if (row.scope === 'container' && row.scopeAgentId === '') containers++;
    else throw new AgentReviewError('quarantine_chain_invalid');
    const key = `${row.scope}:${row.scopeAgentId}`;
    if (scopes.has(key)) throw new AgentReviewError('quarantine_chain_invalid');
    scopes.add(key);
  }
  if (identities > 1024 || containers > 1) throw new AgentReviewError('unavailable');
  return rows;
}

function groupedChildren(db: Database, container: ReviewContainer, rows: readonly ActiveMember[]): Map<number, ChildRow[]> {
  const children = db.prepare(`SELECT o.incident_id AS incidentId,o.observation_sequence AS sequence,
    o.reason,o.evidence_sha256 AS evidenceSha256 FROM agent_review_quarantine_observations o
    JOIN agent_review_quarantine_incidents q ON q.incident_id=o.incident_id
    WHERE q.session_id=? AND q.source=? AND q.source_container_id=? AND q.state='active'
    ORDER BY o.incident_id,o.observation_sequence LIMIT 64576`).all(...args(container)) as ChildRow[];
  if (children.length >= MAX_DETECTION_CHILDREN || children.length > MAX_RECOVERABLE_CHILDREN) throw new AgentReviewError('unavailable');
  const grouped = new Map(rows.map(row => [row.incidentId, [] as ChildRow[]]));
  for (const child of children) {
    const siblings = grouped.get(child.incidentId);
    if (!siblings) throw new AgentReviewError('quarantine_chain_invalid');
    siblings.push(child);
  }
  return grouped;
}

/** Reconstruct a bounded complete group inside a caller-owned coherent SQLite read/write transaction. */
export function captureReviewGroup(db: Database, container: ReviewContainer, sessionPath: string): ReviewGroupCapture {
  if (!db.inTransaction) throw new AgentReviewError('ingestion_transaction_required');
  assertReviewKeys(container, ['sessionId', 'source', 'sourceContainerId']); validateReviewContainer(container);
  const sessionPathBindingSha256 = boundPath(db, container, sessionPath);
  const head = headFor(db, container); const historySha256 = historyFor(db, container);
  const rows = activeRows(db, container); const children = groupedChildren(db, container, rows);
  const active = Object.freeze(rows.map(row => {
    const chain = validateIncidentObservationChain(row, children.get(row.incidentId)!);
    if (chain.effectivelyStructural || chain.observationCount > 62) throw new AgentReviewError('unavailable');
    return Object.freeze({ ...row, observationCount: chain.observationCount,
      observationChainSha256: chain.observationChainSha256, effectivelyStructural: chain.effectivelyStructural });
  }));
  const activeSetSha256 = createHash('sha256').update(active.map(row => hashReviewTuple(row)).join('')).digest('hex');
  const binding = { schema: 'nassaj-agent-review-group-capture/v1', ...container, sessionPathBindingSha256,
    headSha256: head ? hashReviewTuple(head) : EMPTY, historySha256, activeSetSha256 };
  return Object.freeze({ container: Object.freeze({ ...container }), sessionPathBindingSha256, head,
    mode: active.length ? 'recovery' : 'fresh', historySha256, activeSetSha256,
    bindingSha256: hashReviewTuple(binding), active });
}

/** Internal pre-filesystem claims; consumed evidence alone never authorizes a database write. */
export class AgentReviewGroupClaimStore {
  readonly #claims = new WeakMap<object, { identity: object; capture: ReviewGroupCapture }>();
  constructor(private readonly db: Database) {}

  /** Capture before provider filesystem work; every call creates a distinct instance-owned opaque identity. */
  capture(container: ReviewContainer, sessionPath: string): ReviewGroupClaim {
    if (this.db.inTransaction) throw new AgentReviewError('nested_transaction');
    const capture = this.db.transaction(() => captureReviewGroup(this.db, container, sessionPath))();
    const claim = Object.freeze(Object.create(null)) as ReviewGroupClaim;
    this.#claims.set(claim, { identity: Object.freeze(Object.create(null)), capture });
    return claim;
  }

  /** Retire before the future runner attempts BEGIN; cross-instance, serialized and reused claims reject. */
  consume(claim: ReviewGroupClaim): ReviewGroupCapture {
    const owned = claim && typeof claim === 'object' ? this.#claims.get(claim) : undefined;
    if (claim && typeof claim === 'object') this.#claims.delete(claim);
    if (!owned || this.db.inTransaction) throw new AgentReviewError('stale_group_claim');
    return owned.capture;
  }
}
