import type {
  ClaudeReferenceVector,
  EffectivePolicyResult,
  SealedPermissionPolicy,
} from './types.js';
import {
  validateClaudeReferenceVector,
  validateLaunchContext,
  validateSealedPermissionPolicy,
} from './validation.js';
import { computeReferenceEvidenceDigest } from './parity.js';

export type ResolveEffectivePolicyInput = Readonly<{
  context: unknown;
  requestedProfile: unknown;
  authority: unknown;
  reference: unknown;
}>;

/** Resolve server-sealed policy data. It does not perform parity or grant from client/env input. */
export const resolveEffectivePolicy = (input: ResolveEffectivePolicyInput): EffectivePolicyResult => {
  if (!input || typeof input !== 'object' || !validateLaunchContext(input.context)) {
    return Object.freeze({ kind: 'deny', reasonCodes: Object.freeze(['INVALID_LAUNCH_CONTEXT'] as const) });
  }
  if (input.requestedProfile !== 'full_delegation') {
    return Object.freeze({ kind: 'deny', reasonCodes: Object.freeze(['UNSUPPORTED_PROFILE'] as const) });
  }
  if (!validateSealedPermissionPolicy(input.authority)) {
    return Object.freeze({ kind: 'deny', reasonCodes: Object.freeze(['POLICY_AUTHORITY_INVALID'] as const) });
  }
  if (input.authority.source === 'development_unsealed') {
    return Object.freeze({ kind: 'unavailable', reasonCodes: Object.freeze(['RELEASE_IDENTITY_UNSEALED'] as const) });
  }
  if (!validateClaudeReferenceVector(input.reference)
    || input.reference.evidence.status !== 'measured'
    || computeReferenceEvidenceDigest(input.reference) !== input.reference.evidenceDigest) {
    return Object.freeze({ kind: 'unavailable', reasonCodes: Object.freeze(['REFERENCE_UNAVAILABLE'] as const) });
  }

  const authority = input.authority as SealedPermissionPolicy;
  const reference = input.reference as ClaudeReferenceVector;
  if (authority.contractVersion !== reference.contractVersion) {
    return Object.freeze({ kind: 'deny', reasonCodes: Object.freeze(['CONTRACT_MISMATCH'] as const) });
  }
  const policy = {
    profileId: authority.profileId,
    contractVersion: authority.contractVersion,
    profileDigest: authority.profileDigest,
    capabilityDigest: authority.capabilityDigest,
    protocolGeneration: authority.protocolGeneration,
    dimensions: reference.dimensions,
    minimumEnforcement: reference.minimumEnforcement,
    deniedSurfaces: reference.deniedSurfaces,
  } as const;
  return Object.freeze({ kind: 'resolved', policy: Object.freeze(policy) });
};
