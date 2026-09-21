import capabilityArtifact from './permission-capabilities.v1.json' with { type: 'json' };

import type { ClaudeReferenceVector } from '../types.js';
import { validateClaudeReferenceVector } from '../validation.js';

if (!validateClaudeReferenceVector(capabilityArtifact.reference)) {
  throw new Error('PERMISSION_REFERENCE_ARTIFACT_INVALID');
}

/** Live-path Claude reference; changes require a fresh measured artifact and review. */
export const CLAUDE_REFERENCE_VECTOR_V1: ClaudeReferenceVector = Object.freeze(
  capabilityArtifact.reference,
);
