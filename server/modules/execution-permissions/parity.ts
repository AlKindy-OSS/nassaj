import { createHash } from 'node:crypto';

import {
  PERMISSION_DIMENSIONS,
  type ClaudeReferenceVector,
  type EnforcementClass,
  type ParityReasonCode,
  type ParityResult,
  type PermissionCandidateVector,
} from './types.js';
import {
  validateClaudeReferenceVector,
  validatePermissionCandidateVector,
} from './validation.js';

const ENFORCEMENT_RANK: Readonly<Record<EnforcementClass, number>> = Object.freeze({
  none: 0, advisory: 1, boundary: 2, kernel: 3,
});

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
};

const digest = (value: unknown): string => `sha256:${createHash('sha256')
  .update(JSON.stringify(stableValue(value))).digest('hex')}`;

/** Compute the evidence seal over every reference field except the seal itself. */
export const computeReferenceEvidenceDigest = (
  reference: Omit<ClaudeReferenceVector, 'evidenceDigest'>,
): string => {
  const { evidenceDigest: _ignored, ...payload } = reference as ClaudeReferenceVector;
  return digest(payload);
};

/** Compute the evidence seal over every candidate field except the seal itself. */
export const computeCandidateEvidenceDigest = (
  candidate: Omit<PermissionCandidateVector, 'evidenceDigest'>,
): string => {
  const { evidenceDigest: _ignored, ...payload } = candidate as PermissionCandidateVector;
  return digest(payload);
};

const evidenceIsFresh = (reference: ClaudeReferenceVector, candidate: PermissionCandidateVector): boolean => {
  if (reference.evidence.status !== 'measured' || candidate.evidence.status !== 'measured') return false;
  const evaluatedAt = Date.parse(candidate.evidence.evaluatedAt);
  const candidateMeasuredAt = Date.parse(candidate.evidence.measuredAt);
  const referenceMeasuredAt = Date.parse(reference.evidence.measuredAt);
  return candidateMeasuredAt <= evaluatedAt && referenceMeasuredAt <= evaluatedAt
    && evaluatedAt <= Date.parse(candidate.evidence.validUntil)
    && evaluatedAt <= Date.parse(reference.evidence.validUntil);
};

/** Compare a measured candidate with the immutable Claude reference. No I/O or ambient clock is used. */
export const evaluateParity = (referenceValue: unknown, candidateValue: unknown): ParityResult => {
  const reasons = new Set<ParityReasonCode>();
  if (!validateClaudeReferenceVector(referenceValue)) reasons.add('MALFORMED_REFERENCE');
  if (!validatePermissionCandidateVector(candidateValue)) reasons.add('MALFORMED_CANDIDATE');
  if (reasons.size > 0) return Object.freeze({ kind: 'deny', reasonCodes: Object.freeze([...reasons]) });

  const reference = referenceValue as ClaudeReferenceVector;
  const candidate = candidateValue as PermissionCandidateVector;
  if (reference.evidence.status !== 'measured') reasons.add('REFERENCE_UNAVAILABLE');
  if (reference.contractVersion !== candidate.contractVersion) reasons.add('CONTRACT_MISMATCH');
  if (reference.profileId !== candidate.profileId) reasons.add('PROFILE_MISMATCH');

  for (const dimension of PERMISSION_DIMENSIONS) {
    const grant = candidate.dimensions[dimension];
    const enforcement = candidate.enforcement[dimension];
    if (!grant || !enforcement) {
      reasons.add('MISSING_DIMENSION');
      continue;
    }
    const referenceGrant = reference.dimensions[dimension];
    if (grant.decision !== referenceGrant.decision || grant.scope !== referenceGrant.scope) {
      reasons.add('GRANT_MISMATCH');
    }
    if (ENFORCEMENT_RANK[enforcement] < ENFORCEMENT_RANK[reference.minimumEnforcement[dimension]]) {
      reasons.add('WEAKER_ENFORCEMENT');
    }
  }

  const referenceSurfaces = [...reference.deniedSurfaces].sort();
  const candidateSurfaces = [...candidate.deniedSurfaces].sort();
  if (referenceSurfaces.length !== candidateSurfaces.length
    || referenceSurfaces.some((surface, index) => surface !== candidateSurfaces[index])) {
    reasons.add('FORBIDDEN_SURFACE');
  }
  if (!evidenceIsFresh(reference, candidate)) reasons.add('EVIDENCE_STALE');
  if (reference.referenceBuildFingerprint !== reference.evidence.measuredBuildFingerprint
    || candidate.installedBuildFingerprint !== candidate.evidence.measuredBuildFingerprint) {
    reasons.add('BINARY_DRIFT');
  }
  const expectedReferenceDigest = computeReferenceEvidenceDigest(reference);
  const expectedCandidateDigest = computeCandidateEvidenceDigest(candidate);
  if (expectedReferenceDigest !== reference.evidenceDigest
    || expectedCandidateDigest !== candidate.evidenceDigest) reasons.add('EVIDENCE_DIGEST_MISMATCH');

  if (reasons.size > 0) return Object.freeze({ kind: 'deny', reasonCodes: Object.freeze([...reasons]) });
  return Object.freeze({ kind: 'parity', normalizedDigest: digest({
    contractVersion: reference.contractVersion,
    profileId: reference.profileId,
    dimensions: candidate.dimensions,
    enforcement: candidate.enforcement,
    deniedSurfaces: candidateSurfaces,
    candidateEvidenceDigest: candidate.evidenceDigest,
    referenceEvidenceDigest: reference.evidenceDigest,
  }) });
};
