import { AgentReviewError, assertReviewInteger, assertReviewKeys, assertReviewSession, assertReviewToken } from './agent-review-validation.js';

export type ReviewContainer = { sessionId: string; source: 'workflow' | 'agent'; sourceContainerId: string };
export type ReviewHead = ReviewContainer & {
  fileDev: string; fileIno: string; lastCompleteOrdinal: number; lastCompleteOffset: number;
  stableSize: number; rollingPrefixSha256: string; lastResultSequence: number; revision: number;
};
export const REVIEW_INCIDENT_REASONS = ['unstable_read', 'source_grew', 'read_timeout', 'artifact_too_large',
  'line_too_large', 'line_cap', 'completion_cap', 'quarantine_identity_cap', 'inode_replaced', 'prefix_changed',
  'truncated_source', 'ambiguous_launch', 'reused_launch', 'conflicting_binding', 'invalid_sequence', 'invalid_shape'] as const;
export type ReviewIncidentReason = typeof REVIEW_INCIDENT_REASONS[number];
export type ReviewObservation = { phase: 'preopen'; failure: 'nofollow' | 'symlink' | 'open_failed' | 'read_timeout' }
  | { phase: 'postopen'; fileDev: string; fileIno: string; capturedSize: number };
export type ReviewIncidentInput = ReviewContainer & {
  scope: 'container' | 'identity'; scopeAgentId: string; reason: ReviewIncidentReason;
  lastCommittedOffset: number; lastCommittedPrefixSha256: string; attemptEvidenceSha256: string; observation: ReviewObservation;
};
export type ReviewIncident = ReviewContainer & {
  incidentId: number; scope: 'container' | 'identity'; scopeAgentId: string; incidentGeneration: number;
  reason: ReviewIncidentReason; evidenceSha256: string; revision: number; state: 'active' | 'recovered';
};
export type ReviewRecovery = {
  incidentId: number; incidentGeneration: number; incidentEvidenceSha256: string; expectedRevision: number;
  observationCount: number; observationChainSha256: string;
  stableFileDev: string; stableFileIno: string; stableSize: number; stablePrefixSha256: string;
  committedPrefixSha256: string; uniqueRelationEvidenceSha256: string;
};

/** Validate the immutable logical container identity; no path or mtime participates. */
export function validateReviewContainer(value: ReviewContainer): void {
  assertReviewSession(value.sessionId);
  assertReviewToken(value.sourceContainerId, 'sha');
  if (value.source !== 'workflow' && value.source !== 'agent') throw new AgentReviewError('invalid_input');
}

/** Decimal stat identifiers remain strings so 64-bit inode values never lose precision. */
export function validateReviewFileIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9]{1,32}$/.test(value)) throw new AgentReviewError('invalid_input');
}

/** Validate a bounded committed prefix projection, excluding any provider text. */
export function validateReviewHead(value: ReviewHead): void {
  assertReviewKeys(value, ['sessionId', 'source', 'sourceContainerId', 'fileDev', 'fileIno', 'lastCompleteOrdinal',
    'lastCompleteOffset', 'stableSize', 'rollingPrefixSha256', 'lastResultSequence', 'revision']);
  validateReviewContainer(value);
  validateReviewFileIdentity(value.fileDev); validateReviewFileIdentity(value.fileIno);
  for (const integer of [value.lastCompleteOrdinal, value.lastCompleteOffset, value.stableSize, value.lastResultSequence, value.revision]) {
    assertReviewInteger(integer);
  }
  assertReviewToken(value.rollingPrefixSha256, 'sha');
  if (value.stableSize > 67_108_864 || value.lastCompleteOffset > value.stableSize
    || value.lastResultSequence > value.lastCompleteOrdinal) throw new AgentReviewError('invalid_input');
}

/** Validate the tagged observation without inventing stat fields before a file is open. */
export function validateReviewObservation(value: ReviewObservation): void {
  if (value?.phase === 'preopen') {
    assertReviewKeys(value, ['phase', 'failure']);
    if (!['nofollow', 'symlink', 'open_failed', 'read_timeout'].includes(value.failure)) throw new AgentReviewError('invalid_input');
    return;
  }
  assertReviewKeys(value, ['phase', 'fileDev', 'fileIno', 'capturedSize']);
  if (value.phase !== 'postopen') throw new AgentReviewError('invalid_input');
  validateReviewFileIdentity(value.fileDev); validateReviewFileIdentity(value.fileIno);
  assertReviewInteger(value.capturedSize);
}

/** Validate a quarantine tuple before hashing or acquiring a mutation transaction. */
export function validateReviewIncident(value: ReviewIncidentInput): void {
  assertReviewKeys(value, ['sessionId', 'source', 'sourceContainerId', 'scope', 'scopeAgentId', 'reason',
    'lastCommittedOffset', 'lastCommittedPrefixSha256', 'attemptEvidenceSha256', 'observation']);
  validateReviewContainer(value);
  if (value.scope === 'identity') assertReviewToken(value.scopeAgentId, 'agent');
  else if (value.scope !== 'container' || value.scopeAgentId !== '') throw new AgentReviewError('invalid_input');
  if (!REVIEW_INCIDENT_REASONS.includes(value.reason)) throw new AgentReviewError('invalid_input');
  assertReviewInteger(value.lastCommittedOffset);
  assertReviewToken(value.lastCommittedPrefixSha256, 'sha'); assertReviewToken(value.attemptEvidenceSha256, 'sha');
  validateReviewObservation(value.observation);
}

/** Validate the exact recovery CAS and independently bounded full-snapshot evidence. */
export function validateReviewRecovery(value: ReviewRecovery): void {
  assertReviewKeys(value, ['incidentId', 'incidentGeneration', 'incidentEvidenceSha256', 'expectedRevision',
    'observationCount', 'observationChainSha256', 'stableFileDev', 'stableFileIno', 'stableSize', 'stablePrefixSha256', 'committedPrefixSha256', 'uniqueRelationEvidenceSha256']);
  assertReviewInteger(value.incidentId, 1); assertReviewInteger(value.incidentGeneration, 1);
  assertReviewInteger(value.observationCount); assertReviewToken(value.observationChainSha256, 'sha');
  if (value.observationCount > 62) throw new AgentReviewError('invalid_input');
  assertReviewInteger(value.expectedRevision); assertReviewInteger(value.stableSize);
  validateReviewFileIdentity(value.stableFileDev); validateReviewFileIdentity(value.stableFileIno);
  for (const sha of [value.incidentEvidenceSha256, value.stablePrefixSha256, value.committedPrefixSha256, value.uniqueRelationEvidenceSha256]) {
    assertReviewToken(sha, 'sha');
  }
  if (value.stableSize > 67_108_864 || value.expectedRevision === Number.MAX_SAFE_INTEGER) throw new AgentReviewError('invalid_input');
}
