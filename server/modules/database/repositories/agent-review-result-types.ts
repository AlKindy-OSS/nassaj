import { type ReviewHead, validateReviewHead } from './agent-review-ingestion-types.js';
import { AgentReviewError, assertReviewInteger, assertReviewKeys, assertReviewToken } from './agent-review-validation.js';

export type ReviewBindingEvidence = {
  toolUseId: string; agentId: string; launchSequence: number; bindingSequence: number;
  launchEvidenceSha256: string; bindingEvidenceSha256: string;
};
export type ReviewCompletionEvidence = {
  agentId: string; toolUseId: string | null; taskId: string | null; sourceSequence: number; launchEvidenceSha256: string;
  completionEvidenceSha256: string; resultPayloadSha256: string;
};
export type ReviewResultFold = {
  expectedHead: ReviewHead | null; nextHead: ReviewHead; committedPrefixSha256: string;
  bindings: readonly ReviewBindingEvidence[]; completions: readonly ReviewCompletionEvidence[];
};

/** Validate binding identities without deriving authority from labels, metadata or client values. */
export function validateReviewBinding(value: ReviewBindingEvidence): void {
  assertReviewKeys(value, ['toolUseId', 'agentId', 'launchSequence', 'bindingSequence', 'launchEvidenceSha256', 'bindingEvidenceSha256']);
  assertReviewToken(value.toolUseId, 'key'); assertReviewToken(value.agentId, 'agent');
  assertReviewInteger(value.launchSequence, 1); assertReviewInteger(value.bindingSequence, 1);
  assertReviewToken(value.launchEvidenceSha256, 'sha'); assertReviewToken(value.bindingEvidenceSha256, 'sha');
  if (value.bindingSequence <= value.launchSequence) throw new AgentReviewError('invalid_sequence');
}

/** Validate stored digest domains; a trusted parser must separately establish the original evidence relation. */
export function validateReviewCompletion(value: ReviewCompletionEvidence, source: 'workflow' | 'agent'): void {
  assertReviewKeys(value, ['agentId', 'toolUseId', 'taskId', 'sourceSequence', 'launchEvidenceSha256', 'completionEvidenceSha256', 'resultPayloadSha256']);
  assertReviewToken(value.agentId, 'agent'); assertReviewInteger(value.sourceSequence, 1);
  for (const hash of [value.launchEvidenceSha256, value.completionEvidenceSha256, value.resultPayloadSha256]) assertReviewToken(hash, 'sha');
  if (source === 'agent') {
    assertReviewToken(value.toolUseId, 'key'); assertReviewToken(value.taskId, 'agent');
    if (value.taskId !== value.agentId) throw new AgentReviewError('conflicting_binding');
  } else if (value.toolUseId !== null || value.taskId !== null) throw new AgentReviewError('invalid_input');
}

/** Validate one bounded fold before entering any storage mutation. */
export function validateReviewResultFold(value: ReviewResultFold): void {
  assertReviewKeys(value, ['expectedHead', 'nextHead', 'committedPrefixSha256', 'bindings', 'completions']);
  validateReviewHead(value.nextHead);
  if (value.expectedHead !== null) validateReviewHead(value.expectedHead);
  assertReviewToken(value.committedPrefixSha256, 'sha');
  if (!Array.isArray(value.bindings) || !Array.isArray(value.completions)) throw new AgentReviewError('invalid_input');
  if (value.bindings.length > 200_000) throw new AgentReviewError('line_cap');
  if (value.completions.length > 4096) throw new AgentReviewError('completion_cap');
  if (value.nextHead.source === 'workflow' && value.bindings.length !== 0) throw new AgentReviewError('invalid_input');
  value.bindings.forEach(validateReviewBinding);
  value.completions.forEach(item => validateReviewCompletion(item, value.nextHead.source));
  if (value.bindings.some(item => item.bindingSequence > value.nextHead.lastCompleteOrdinal)
    || value.completions.some((item, i) => item.sourceSequence > value.nextHead.lastCompleteOrdinal
      || (i > 0 && item.sourceSequence <= value.completions[i - 1].sourceSequence))) throw new AgentReviewError('invalid_sequence');
  const lastSequence = value.completions.at(-1)?.sourceSequence ?? value.expectedHead?.lastResultSequence ?? 0;
  if (value.nextHead.lastResultSequence !== lastSequence) throw new AgentReviewError('invalid_sequence');
}
