/** Pure permission-parity contracts. This module must not read runtime state. */

export const PERMISSION_DIMENSIONS = Object.freeze([
  'filesystem_read',
  'filesystem_write',
  'process_execution',
  'network_access',
  'approval',
  'tools',
  'delegation',
  'mcp',
  'connectors',
] as const);

export type PermissionDimension = typeof PERMISSION_DIMENSIONS[number];

export const EXTERNAL_SURFACES = Object.freeze([
  'mcp',
  'connectors',
  'external_delegation',
] as const);

export type ExternalSurface = typeof EXTERNAL_SURFACES[number];
export type GrantDecision = 'allow' | 'deny';
export type GrantScope = 'none' | 'workspace' | 'host' | 'external';
export type EnforcementClass = 'none' | 'advisory' | 'boundary' | 'kernel';
export type EvidenceStatus = 'measured' | 'synthetic_unmeasured';

export type Grant = Readonly<{
  decision: GrantDecision;
  scope: GrantScope;
}>;

export type MeasurementEvidence = Readonly<{
  status: EvidenceStatus;
  measuredAt: string;
  validUntil: string;
  evaluatedAt: string;
  suiteId: string;
  measuredBuildFingerprint: string;
}>;

export type ClaudeReferenceVector = Readonly<{
  contractVersion: string;
  profileId: 'full_delegation';
  referenceBody: 'claude';
  referenceBuildFingerprint: string;
  referenceSdkFingerprint: string;
  referenceCliFingerprint: string;
  dimensions: Readonly<Record<PermissionDimension, Grant>>;
  minimumEnforcement: Readonly<Record<PermissionDimension, EnforcementClass>>;
  deniedSurfaces: readonly ExternalSurface[];
  evidence: MeasurementEvidence;
  evidenceDigest: string;
}>;

export type PermissionCandidateVector = Readonly<{
  contractVersion: string;
  profileId: string;
  body: string;
  installedBuildFingerprint: string;
  dimensions: Readonly<Partial<Record<PermissionDimension, Grant>>>;
  enforcement: Readonly<Partial<Record<PermissionDimension, EnforcementClass>>>;
  deniedSurfaces: readonly ExternalSurface[];
  evidence: MeasurementEvidence;
  evidenceDigest: string;
}>;

export const PARITY_REASON_CODES = Object.freeze([
  'REFERENCE_UNAVAILABLE',
  'MALFORMED_REFERENCE',
  'MALFORMED_CANDIDATE',
  'CONTRACT_MISMATCH',
  'PROFILE_MISMATCH',
  'MISSING_DIMENSION',
  'GRANT_MISMATCH',
  'WEAKER_ENFORCEMENT',
  'FORBIDDEN_SURFACE',
  'EVIDENCE_STALE',
  'BINARY_DRIFT',
  'EVIDENCE_DIGEST_MISMATCH',
] as const);

export type ParityReasonCode = typeof PARITY_REASON_CODES[number];

export type ParityResult =
  | Readonly<{ kind: 'parity'; normalizedDigest: string }>
  | Readonly<{ kind: 'deny'; reasonCodes: readonly ParityReasonCode[] }>;

export const LAUNCH_PURPOSES = Object.freeze([
  'spawn', 'sdk_thread', 'sdk_turn', 'catalog', 'quota', 'balance', 'mcp',
  'delegation', 'external_agent_dispatch',
] as const);

export type LaunchPurpose = typeof LAUNCH_PURPOSES[number];

export type CanonicalLaunchContext = Readonly<{
  launchId: string;
  principalId: string;
  sessionId: string | null;
  projectId: string;
  workspacePath: string;
  provider: string;
  body: string;
  engine: string;
  entrypoint: string;
  purpose: LaunchPurpose;
  /** Declared by the requester (T-1593): 'local' only where the effect is a host child process. */
  effectFootprint?: 'local' | 'external';
}>;

export type SealedPermissionPolicy = Readonly<{
  source: 'sealed_release_manifest' | 'development_unsealed';
  profileId: 'full_delegation';
  contractVersion: string;
  profileDigest: string;
  capabilityDigest: string;
  protocolGeneration: number;
}>;

export type EffectivePolicy = Readonly<{
  profileId: 'full_delegation';
  contractVersion: string;
  profileDigest: string;
  capabilityDigest: string;
  protocolGeneration: number;
  dimensions: ClaudeReferenceVector['dimensions'];
  minimumEnforcement: ClaudeReferenceVector['minimumEnforcement'];
  deniedSurfaces: ClaudeReferenceVector['deniedSurfaces'];
}>;

export type PolicyReasonCode =
  | 'INVALID_LAUNCH_CONTEXT'
  | 'UNSUPPORTED_PROFILE'
  | 'POLICY_AUTHORITY_INVALID'
  | 'REFERENCE_UNAVAILABLE'
  | 'RELEASE_IDENTITY_UNSEALED'
  | 'CONTRACT_MISMATCH';

export type EffectivePolicyResult =
  | Readonly<{ kind: 'resolved'; policy: EffectivePolicy }>
  | Readonly<{ kind: 'unavailable'; reasonCodes: readonly PolicyReasonCode[] }>
  | Readonly<{ kind: 'deny'; reasonCodes: readonly PolicyReasonCode[] }>;
