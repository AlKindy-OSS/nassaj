import type { Database } from 'better-sqlite3';

import { runReviewOwnedTransaction, type ReviewTransactionInvocation } from './agent-review-transaction-evidence.js';
import { projectIncidentObservationChain } from './agent-review-observation-chain.js';
import {
  AgentReviewError, assertReviewInteger, assertReviewKeys, assertReviewSession, assertReviewToken, hashReviewTuple,
} from './agent-review-validation.js';

export type ReviewSource = 'workflow' | 'agent' | 'external';
export type ReviewStatus = 'awaiting_review' | 'reviewing' | 'approved' | 'rejected';
export type ReviewAction = 'start_review' | 'approve' | 'reject';
export type ReviewTransition = {
  sessionId: string; source: ReviewSource; agentId: string; resultGeneration: string;
  action: ReviewAction; expectedRevision: number; idempotencyKey: string;
};
export type ReviewSuccess = {
  sessionId: string; source: ReviewSource; agentId: string; resultGeneration: string;
  status: ReviewStatus; revision: number;
};
/** Must synchronously recheck the captured principal, session write access and project fence. */
export type ReviewAuthorization = Readonly<{
  actorUserId: number;
  assertCurrent: (db: Database, sessionId: string) => true;
}>;
type StoredState = { status: ReviewStatus; revision: number };
type Receipt = { fingerprint: string; status: ReviewStatus; revision: number };

function validateTransition(input: ReviewTransition): void {
  assertReviewKeys(input, ['sessionId', 'source', 'agentId', 'resultGeneration', 'action', 'expectedRevision', 'idempotencyKey']);
  assertReviewSession(input.sessionId);
  assertReviewToken(input.agentId, 'agent');
  assertReviewToken(input.resultGeneration, 'sha');
  assertReviewToken(input.idempotencyKey, 'key');
  assertReviewInteger(input.expectedRevision);
  if (input.expectedRevision === Number.MAX_SAFE_INTEGER) throw new AgentReviewError('stale_revision');
  if (!['workflow', 'agent', 'external'].includes(input.source)
    || !['start_review', 'approve', 'reject'].includes(input.action)) throw new AgentReviewError('invalid_input');
}

function strictController(db: Database, sessionId: string, actor: number): void {
  const owner = db.prepare(`SELECT MIN(user_id) AS userId FROM session_participants
    WHERE session_id=? AND role='owner' AND attribution='spawn' HAVING COUNT(*)=1`).get(sessionId) as { userId: number } | undefined;
  if (owner?.userId !== actor) throw new AgentReviewError('forbidden');
}

function assertAvailable(db: Database, input: ReviewTransition, container: string): void {
  const incident = db.prepare(`SELECT 1 FROM agent_review_quarantine_incidents WHERE session_id=? AND source=?
    AND source_container_id=? AND state='active' AND (scope='container' OR scope_agent_id=?) LIMIT 1`)
    .get(input.sessionId, input.source, container, input.agentId);
  if (incident) throw new AgentReviewError('unavailable');
}

function currentState(db: Database, input: ReviewTransition): StoredState {
  const current = db.prepare(`SELECT result_generation AS generation,source_container_id AS container
    FROM agent_review_current WHERE session_id=? AND source=? AND agent_id=?`)
    .get(input.sessionId, input.source, input.agentId) as { generation: string; container: string } | undefined;
  if (!current) throw new AgentReviewError('stale_generation');
  assertAvailable(db, input, current.container);
  if (current.generation !== input.resultGeneration) throw new AgentReviewError('stale_generation');
  if (input.source === 'external') throw new AgentReviewError('immutable_source');
  const state = db.prepare(`SELECT status,revision FROM agent_review_states
    WHERE session_id=? AND source=? AND agent_id=? AND result_generation=?`)
    .get(input.sessionId, input.source, input.agentId, input.resultGeneration) as StoredState | undefined;
  if (!state || state.revision !== input.expectedRevision) throw new AgentReviewError('stale_revision');
  const required = input.action === 'start_review' ? 'awaiting_review' : 'reviewing';
  if (state.status !== required) throw new AgentReviewError('invalid_transition');
  return state;
}

function updateState(db: Database, input: ReviewTransition, actor: number, now: string): ReviewSuccess {
  const status = input.action === 'start_review' ? 'reviewing' : input.action === 'approve' ? 'approved' : 'rejected';
  const changed = db.prepare(`UPDATE agent_review_states SET status=?,revision=revision+1,
    review_started_at=CASE WHEN ?='reviewing' THEN ? ELSE review_started_at END,
    resolved_at=CASE WHEN ?='reviewing' THEN NULL ELSE ? END,reviewed_by_user_id=?
    WHERE session_id=? AND source=? AND agent_id=? AND result_generation=? AND revision=?`)
    .run(status, status, now, status, now, actor, input.sessionId, input.source, input.agentId,
      input.resultGeneration, input.expectedRevision);
  if (changed.changes !== 1) throw new AgentReviewError('stale_revision');
  return { sessionId: input.sessionId, source: input.source, agentId: input.agentId,
    resultGeneration: input.resultGeneration, status, revision: input.expectedRevision + 1 };
}

function recordSuccess(db: Database, input: ReviewTransition, result: ReviewSuccess,
  evidence: { actor: number; fingerprint: string; prior: StoredState; now: string }): void {
  const { actor, fingerprint, prior, now } = evidence;
  const eventType = input.action === 'start_review' ? 'review_started' : result.status;
  db.prepare(`INSERT INTO agent_review_events (session_id,source,agent_id,result_generation,event_sequence,
    event_type,prior_status,new_status,prior_revision,new_revision,actor_user_id,server_time,idempotency_key,request_fingerprint_sha256)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.sessionId, input.source, input.agentId, input.resultGeneration,
    result.revision, eventType, prior.status, result.status, prior.revision, result.revision, actor, now, input.idempotencyKey, fingerprint);
  db.prepare(`INSERT INTO agent_review_receipts (idempotency_key,request_fingerprint_sha256,actor_user_id,
    session_id,source,agent_id,result_generation,action,expected_revision,resulting_revision,resulting_status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.idempotencyKey, fingerprint, actor, input.sessionId, input.source,
    input.agentId, input.resultGeneration, input.action, input.expectedRevision, result.revision, result.status, now);
}

/** DB-injected review storage; no imports of application singletons or authorization fallbacks. */
export class AgentReviewRepository {
  private readonly authorization: ReviewAuthorization;

  constructor(private readonly db: Database, authorization: ReviewAuthorization) {
    assertReviewInteger(authorization?.actorUserId, 1);
    if (typeof authorization?.assertCurrent !== 'function') throw new AgentReviewError('forbidden');
    this.authorization = Object.freeze({ actorUserId: authorization.actorUserId, assertCurrent: authorization.assertCurrent });
  }

  /** Atomically authorize, replay a receipt or CAS state together with its event and receipt. */
  transition(input: ReviewTransition, invocation?: ReviewTransactionInvocation): ReviewSuccess {
    if (this.db.inTransaction) throw new AgentReviewError('nested_transaction');
    return runReviewOwnedTransaction(this.db, this.authorization.actorUserId, invocation, () => {
      assertReviewSession(input?.sessionId);
      if (this.authorization.assertCurrent(this.db, input.sessionId) !== true) throw new AgentReviewError('forbidden');
      const actor = this.authorization.actorUserId;
      strictController(this.db, input.sessionId, actor);
      validateTransition(input);
      const fingerprint = hashReviewTuple({ schema: 'nassaj-agent-review-request/v1', actorUserId: actor,
        sessionId: input.sessionId, source: input.source, agentId: input.agentId, resultGeneration: input.resultGeneration,
        action: input.action, expectedRevision: input.expectedRevision });
      const receipt = this.db.prepare(`SELECT request_fingerprint_sha256 AS fingerprint,resulting_status AS status,
        resulting_revision AS revision FROM agent_review_receipts WHERE idempotency_key=?`).get(input.idempotencyKey) as Receipt | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new AgentReviewError('idempotency_conflict');
        return { sessionId: input.sessionId, source: input.source, agentId: input.agentId,
          resultGeneration: input.resultGeneration, status: receipt.status, revision: receipt.revision };
      }
      const prior = currentState(this.db, input);
      const now = new Date().toISOString();
      const result = updateState(this.db, input, actor, now);
      recordSuccess(this.db, input, result, { actor, fingerprint, prior, now });
      return result;
    });
  }

  /** Read exactly the same sole spawn-owner predicate used by transition; roles never bypass it. */
  isController(sessionId: string): boolean {
    assertReviewSession(sessionId);
    try { strictController(this.db, sessionId, this.authorization.actorUserId); return true; }
    catch (error) { if (error instanceof AgentReviewError && error.code === 'forbidden') return false; throw error; }
  }

  /** Read a bounded, deterministically ordered page; caller must first assert session read access. */
  listCurrent(sessionId: string, page: { limit: number; offset: number }): unknown[] {
    assertReviewSession(sessionId);
    assertReviewKeys(page, ['limit', 'offset']);
    assertReviewInteger(page.limit, 1);
    assertReviewInteger(page.offset);
    if (page.limit > 100) throw new AgentReviewError('invalid_input');
    return this.db.prepare(`SELECT c.source,c.agent_id AS agentId,c.result_generation AS resultGeneration,
      s.status,s.revision,EXISTS(SELECT 1 FROM agent_review_quarantine_incidents q
        WHERE q.session_id=c.session_id AND q.source=c.source AND q.source_container_id=c.source_container_id
        AND q.state='active' AND (q.scope='container' OR q.scope_agent_id=c.agent_id)) AS unavailable
      FROM agent_review_current c JOIN agent_review_states s USING(session_id,source,agent_id,result_generation)
      WHERE c.session_id=? ORDER BY c.source,c.agent_id LIMIT ? OFFSET ?`).all(sessionId, page.limit, page.offset);
  }

  /** Read current-generation counts separately from durable quarantine, including containers with no result yet. */
  readSummary(sessionId: string): Record<string, number> {
    assertReviewSession(sessionId);
    const counts = this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(s.status='approved'),0) AS approved,
      COALESCE(SUM(s.status='rejected'),0) AS rejected,COALESCE(SUM(s.status='awaiting_review'),0) AS awaitingReview,
      COALESCE(SUM(s.status='reviewing'),0) AS reviewing
      FROM agent_review_current c JOIN agent_review_states s USING(session_id,source,agent_id,result_generation)
      WHERE c.session_id=?`).get(sessionId) as Record<string, number>;
    const quarantine = this.db.prepare(`SELECT COUNT(*) AS activeIncidents FROM agent_review_quarantine_incidents
      WHERE session_id=? AND state='active'`).get(sessionId) as { activeIncidents: number };
    return { ...counts, ...quarantine };
  }

  /** Read bounded incident references without parsing artifacts or recovering quarantine. */
  listActiveIncidents(sessionId: string, page: { limit: number; afterId: number }): unknown[] {
    assertReviewSession(sessionId);
    assertReviewKeys(page, ['limit', 'afterId']);
    assertReviewInteger(page.limit, 1);
    assertReviewInteger(page.afterId);
    if (page.limit > 100) throw new AgentReviewError('invalid_input');
    return this.db.prepare(`SELECT incident_id AS incidentId,source,scope,scope_agent_id AS agentId,
      source_container_id AS sourceContainerId,incident_generation AS incidentGeneration,
      reason,evidence_sha256 AS evidenceSha256,revision FROM agent_review_quarantine_incidents
      WHERE session_id=? AND state='active' AND incident_id>? ORDER BY incident_id LIMIT ?`)
      .all(sessionId, page.afterId, page.limit).map(value => {
        const row = value as { incidentId: number };
        const chain = projectIncidentObservationChain(this.db, row.incidentId);
        return { ...row, reason: chain.reason, evidenceSha256: chain.evidenceSha256,
          observationChainSha256: chain.observationChainSha256 };
      });
  }
}
