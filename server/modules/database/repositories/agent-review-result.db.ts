import type { Database } from 'better-sqlite3';

import { AgentReviewIngestionRepository } from './agent-review-ingestion.db.js';
import type { ReviewContainer } from './agent-review-ingestion-types.js';
import { AgentReviewError, hashReviewTuple } from './agent-review-validation.js';
import { type ReviewBindingEvidence, type ReviewCompletionEvidence, type ReviewResultFold, validateReviewResultFold } from './agent-review-result-types.js';

type StoredBinding = ReviewBindingEvidence & {
  taskId: string | null; lifecycle: 'active' | 'closed'; lastCompletionSequence: number | null;
  lastCompletionEvidenceSha256: string | null; revision: number; updatedAt: string;
};
type StoredResult = { resultGeneration: string; sourceSequence: number; sourceContainerId: string;
  launchEvidenceSha256: string; completionEvidenceSha256: string; resultPayloadSha256: string };

function containerArgs(container: ReviewContainer): [string, string] {
  return [container.sessionId, container.sourceContainerId];
}

function readBinding(db: Database, container: ReviewContainer, toolUseId: string): StoredBinding | undefined {
  return db.prepare(`SELECT tool_use_id AS toolUseId,agent_id AS agentId,launch_sequence AS launchSequence,
    binding_sequence AS bindingSequence,launch_evidence_sha256 AS launchEvidenceSha256,binding_evidence_sha256 AS bindingEvidenceSha256,
    task_id AS taskId,lifecycle,last_completion_sequence AS lastCompletionSequence,
    last_completion_evidence_sha256 AS lastCompletionEvidenceSha256,revision,updated_at AS updatedAt
    FROM agent_review_agent_bindings WHERE session_id=? AND source_container_id=? AND tool_use_id=?`)
    .get(...containerArgs(container), toolUseId) as StoredBinding | undefined;
}

function recordBinding(db: Database, container: ReviewContainer, input: ReviewBindingEvidence): boolean {
  const existing = readBinding(db, container, input.toolUseId);
  if (existing) {
    if (Object.entries(input).some(([key, value]) => existing[key as keyof StoredBinding] !== value)) {
      throw new AgentReviewError('conflicting_binding');
    }
    return false;
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agent_review_agent_bindings
    (session_id,source_container_id,tool_use_id,task_id,agent_id,launch_sequence,binding_sequence,
    launch_evidence_sha256,binding_evidence_sha256,lifecycle,last_completion_sequence,last_completion_evidence_sha256,
    revision,created_at,updated_at) VALUES (?,?,?,NULL,?,?,?,?,?,'active',NULL,NULL,0,?,?)`)
    .run(...containerArgs(container), input.toolUseId, input.agentId, input.launchSequence, input.bindingSequence,
      input.launchEvidenceSha256, input.bindingEvidenceSha256, now, now);
  return true;
}

function advanceBinding(db: Database, container: ReviewContainer, input: ReviewCompletionEvidence): void {
  const binding = readBinding(db, container, input.toolUseId as string);
  if (!binding || binding.agentId !== input.agentId || binding.launchEvidenceSha256 !== input.launchEvidenceSha256
    || binding.lifecycle !== 'active' || binding.revision >= Number.MAX_SAFE_INTEGER
    || (binding.taskId !== null && binding.taskId !== input.agentId)) throw new AgentReviewError('conflicting_binding');
  if (input.sourceSequence <= (binding.lastCompletionSequence ?? binding.bindingSequence)
    || input.completionEvidenceSha256 === binding.lastCompletionEvidenceSha256) throw new AgentReviewError('invalid_sequence');
  const now = distinctTime(binding.updatedAt);
  const updated = db.prepare(`UPDATE agent_review_agent_bindings SET task_id=?,last_completion_sequence=?,
    last_completion_evidence_sha256=?,revision=revision+1,updated_at=?
    WHERE session_id=? AND source_container_id=? AND tool_use_id=? AND revision=? AND lifecycle='active'
    AND task_id IS ? AND last_completion_sequence IS ?`).run(input.agentId, input.sourceSequence,
    input.completionEvidenceSha256, now, ...containerArgs(container), input.toolUseId,
    binding.revision, binding.taskId, binding.lastCompletionSequence);
  if (updated.changes !== 1) throw new AgentReviewError('conflicting_binding');
}

// The accepted DDL requires a distinct audit timestamp, not clock-based identity or ordering.
function distinctTime(previous: string): string {
  const now = new Date().toISOString();
  return now === previous ? `${now.slice(0, -1)}0Z` : now;
}

function generation(container: ReviewContainer, input: ReviewCompletionEvidence): string {
  return hashReviewTuple({ schema: 'nassaj-agent-review-generation/v1', sessionId: container.sessionId,
    source: container.source, sourceContainerId: container.sourceContainerId, agentId: input.agentId,
    sourceSequence: input.sourceSequence, launchEvidenceSha256: input.launchEvidenceSha256,
    completionEvidenceSha256: input.completionEvidenceSha256, resultPayloadSha256: input.resultPayloadSha256 });
}

function isRecorded(db: Database, container: ReviewContainer, input: ReviewCompletionEvidence, resultGeneration: string): boolean {
  const row = db.prepare(`SELECT result_generation AS resultGeneration,source_sequence AS sourceSequence,
    source_container_id AS sourceContainerId,launch_evidence_sha256 AS launchEvidenceSha256,
    completion_evidence_sha256 AS completionEvidenceSha256,result_payload_sha256 AS resultPayloadSha256
    FROM agent_review_results WHERE session_id=? AND source=? AND agent_id=? AND result_generation=?`)
    .get(container.sessionId, container.source, input.agentId, resultGeneration) as StoredResult | undefined;
  if (!row) return false;
  if (row.sourceContainerId !== container.sourceContainerId || row.sourceSequence !== input.sourceSequence
    || row.launchEvidenceSha256 !== input.launchEvidenceSha256 || row.completionEvidenceSha256 !== input.completionEvidenceSha256
    || row.resultPayloadSha256 !== input.resultPayloadSha256) throw new AgentReviewError('conflicting_binding');
  return true;
}

function selectCurrent(db: Database, container: ReviewContainer, input: ReviewCompletionEvidence, resultGeneration: string): void {
  const current = db.prepare(`SELECT source_container_id AS container,source_sequence AS sequence,pointer_revision AS revision,selected_at AS selectedAt
    FROM agent_review_current WHERE session_id=? AND source=? AND agent_id=?`)
    .get(container.sessionId, container.source, input.agentId) as { container: string; sequence: number; revision: number; selectedAt: string } | undefined;
  if (!current) {
    db.prepare('INSERT INTO agent_review_current VALUES (?,?,?,?,?,?,0,?)')
      .run(container.sessionId, container.source, input.agentId, resultGeneration, container.sourceContainerId,
        input.sourceSequence, new Date().toISOString());
    return;
  }
  if (current.container !== container.sourceContainerId) throw new AgentReviewError('conflicting_binding');
  if (input.sourceSequence <= current.sequence || current.revision >= Number.MAX_SAFE_INTEGER) throw new AgentReviewError('invalid_sequence');
  const updated = db.prepare(`UPDATE agent_review_current SET result_generation=?,source_sequence=?,pointer_revision=pointer_revision+1,selected_at=?
    WHERE session_id=? AND source=? AND agent_id=? AND pointer_revision=?`).run(resultGeneration, input.sourceSequence,
    distinctTime(current.selectedAt), container.sessionId, container.source, input.agentId, current.revision);
  if (updated.changes !== 1) throw new AgentReviewError('invalid_sequence');
}

function assertUnconsumedWorkflowLaunch(db: Database, container: ReviewContainer, input: ReviewCompletionEvidence): void {
  const used = db.prepare(`SELECT 1 FROM agent_review_results WHERE session_id=? AND source='workflow'
    AND source_container_id=? AND agent_id=? AND launch_evidence_sha256=? LIMIT 1`)
    .get(container.sessionId, container.sourceContainerId, input.agentId, input.launchEvidenceSha256);
  if (used) throw new AgentReviewError('reused_launch');
}

function recordCompletion(db: Database, container: ReviewContainer, input: ReviewCompletionEvidence): boolean {
  const resultGeneration = generation(container, input);
  if (isRecorded(db, container, input, resultGeneration)) return false;
  if (container.source === 'agent') advanceBinding(db, container, input);
  else assertUnconsumedWorkflowLaunch(db, container, input);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO agent_review_results VALUES (?,?,?,?,?,?,?,?,?,?)').run(container.sessionId, container.source,
    input.agentId, resultGeneration, container.sourceContainerId, input.sourceSequence, input.launchEvidenceSha256,
    input.completionEvidenceSha256, input.resultPayloadSha256, now);
  db.prepare(`INSERT INTO agent_review_states VALUES (?,?,?,?,'awaiting_review',0,NULL,NULL,NULL)`)
    .run(container.sessionId, container.source, input.agentId, resultGeneration);
  db.prepare(`INSERT INTO agent_review_events (session_id,source,agent_id,result_generation,event_sequence,event_type,
    new_status,new_revision,server_time) VALUES (?,?,?,?,0,'completed','awaiting_review',0,?)`)
    .run(container.sessionId, container.source, input.agentId, resultGeneration, now);
  selectCurrent(db, container, input, resultGeneration);
  return true;
}

// Called only after fold validation and the synchronous trusted provenance guard succeed.
function withProvedIdentity(agentId: string, write: () => boolean): boolean {
  try { return write(); }
  catch (error) {
    if (error instanceof AgentReviewError && ['conflicting_binding', 'invalid_sequence', 'reused_launch'].includes(error.code)) {
      throw new AgentReviewError(error.code, agentId);
    }
    throw error;
  }
}

/** Internal digest storage; construction requires the trusted parser's synchronous provenance assertion. */
export class AgentReviewResultRepository {
  constructor(private readonly db: Database, private readonly assertTrustedFold: (fold: ReviewResultFold) => true) {
    if (typeof assertTrustedFold !== 'function') throw new AgentReviewError('untrusted_provenance');
  }

  /** Fold proved evidence and advance its head atomically within the caller's BEGIN IMMEDIATE transaction. */
  applyFold(fold: ReviewResultFold): { bindings: number; completions: number; headAdvanced: boolean } {
    if (!this.db.inTransaction) throw new AgentReviewError('ingestion_transaction_required');
    validateReviewResultFold(fold);
    if (this.assertTrustedFold(fold) !== true) throw new AgentReviewError('untrusted_provenance');
    const container = fold.nextHead;
    let bindings = 0; let completions = 0;
    for (const binding of fold.bindings) if (withProvedIdentity(binding.agentId, () => recordBinding(this.db, container, binding))) bindings++;
    for (const completion of fold.completions) if (withProvedIdentity(completion.agentId, () => recordCompletion(this.db, container, completion))) completions++;
    const headAdvanced = new AgentReviewIngestionRepository(this.db)
      .advanceHead(fold.expectedHead, fold.nextHead, fold.committedPrefixSha256);
    return { bindings, completions, headAdvanced };
  }
}
