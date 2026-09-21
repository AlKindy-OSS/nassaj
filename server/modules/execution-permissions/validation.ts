import path from 'node:path';

import {
  EXTERNAL_SURFACES,
  LAUNCH_PURPOSES,
  PERMISSION_DIMENSIONS,
  type CanonicalLaunchContext,
  type ClaudeReferenceVector,
  type EnforcementClass,
  type Grant,
  type MeasurementEvidence,
  type PermissionCandidateVector,
  type SealedPermissionPolicy,
} from './types.js';

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:+@/-]{2,255}$/u;
const ENFORCEMENT = new Set<EnforcementClass>(['none', 'advisory', 'boundary', 'kernel']);
const DIMENSIONS = new Set<string>(PERMISSION_DIMENSIONS);
const SURFACES = new Set<string>(EXTERNAL_SURFACES);
const PURPOSES = new Set<string>(LAUNCH_PURPOSES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isStrictIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

const validId = (value: unknown): value is string =>
  typeof value === 'string' && ID_PATTERN.test(value);

const validFingerprint = (value: unknown): value is string =>
  typeof value === 'string' && FINGERPRINT_PATTERN.test(value);

const validGrant = (value: unknown): value is Grant => {
  if (!isRecord(value) || !hasExactKeys(value, ['decision', 'scope'])) return false;
  if (value.decision !== 'allow' && value.decision !== 'deny') return false;
  if (!['none', 'workspace', 'host', 'external'].includes(String(value.scope))) return false;
  return value.decision === 'deny' ? value.scope === 'none' : value.scope !== 'none';
};

const validEvidence = (value: unknown): value is MeasurementEvidence => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'status', 'measuredAt', 'validUntil', 'evaluatedAt', 'suiteId', 'measuredBuildFingerprint',
  ])) return false;
  if (value.status !== 'measured' && value.status !== 'synthetic_unmeasured') return false;
  if (![value.measuredAt, value.validUntil, value.evaluatedAt].every(isStrictIsoDate)) return false;
  return validId(value.suiteId) && validFingerprint(value.measuredBuildFingerprint);
};

const validSurfaces = (value: unknown): boolean => Array.isArray(value)
  && value.every(surface => typeof surface === 'string' && SURFACES.has(surface))
  && new Set(value).size === value.length;

const validDimensionMap = (value: unknown, complete: boolean): boolean => {
  if (!isRecord(value) || Object.keys(value).some(key => !DIMENSIONS.has(key))) return false;
  if (complete && Object.keys(value).length !== PERMISSION_DIMENSIONS.length) return false;
  return Object.values(value).every(validGrant);
};

const validEnforcementMap = (value: unknown, complete: boolean): boolean => {
  if (!isRecord(value) || Object.keys(value).some(key => !DIMENSIONS.has(key))) return false;
  if (complete && Object.keys(value).length !== PERMISSION_DIMENSIONS.length) return false;
  return Object.values(value).every(level => typeof level === 'string' && ENFORCEMENT.has(level as EnforcementClass));
};

/** Validate an immutable reference vector structurally, without trusting its evidence. */
export const validateClaudeReferenceVector = (value: unknown): value is ClaudeReferenceVector => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'contractVersion', 'profileId', 'referenceBody', 'referenceBuildFingerprint',
    'referenceSdkFingerprint', 'referenceCliFingerprint', 'dimensions',
    'minimumEnforcement', 'deniedSurfaces', 'evidence', 'evidenceDigest',
  ])) return false;
  return validId(value.contractVersion) && value.profileId === 'full_delegation'
    && value.referenceBody === 'claude'
    && validFingerprint(value.referenceBuildFingerprint)
    && validFingerprint(value.referenceSdkFingerprint)
    && validFingerprint(value.referenceCliFingerprint)
    && validDimensionMap(value.dimensions, true)
    && validEnforcementMap(value.minimumEnforcement, true)
    && validSurfaces(value.deniedSurfaces) && validEvidence(value.evidence)
    && typeof value.evidenceDigest === 'string' && DIGEST_PATTERN.test(value.evidenceDigest);
};

/** Validate a provider capability candidate. Partial dimension maps are valid input and deny in parity. */
export const validatePermissionCandidateVector = (value: unknown): value is PermissionCandidateVector => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'contractVersion', 'profileId', 'body', 'installedBuildFingerprint', 'dimensions',
    'enforcement', 'deniedSurfaces', 'evidence', 'evidenceDigest',
  ])) return false;
  return validId(value.contractVersion) && validId(value.profileId) && validId(value.body)
    && validFingerprint(value.installedBuildFingerprint)
    && validDimensionMap(value.dimensions, false)
    && validEnforcementMap(value.enforcement, false)
    && validSurfaces(value.deniedSurfaces) && validEvidence(value.evidence)
    && typeof value.evidenceDigest === 'string' && DIGEST_PATTERN.test(value.evidenceDigest);
};

/** Validate the canonical, server-produced launch context. Unknown fields fail closed. */
export const validateLaunchContext = (value: unknown): value is CanonicalLaunchContext => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'launchId', 'principalId', 'sessionId', 'projectId', 'workspacePath', 'provider', 'body',
    'engine', 'entrypoint', 'purpose', ...('effectFootprint' in value ? ['effectFootprint'] : []),
  ])) return false;
  if (value.effectFootprint !== undefined && value.effectFootprint !== 'local' && value.effectFootprint !== 'external') return false;
  return [value.launchId, value.principalId, value.projectId, value.provider, value.body,
    value.engine, value.entrypoint].every(validId)
    && (value.sessionId === null || validId(value.sessionId))
    && typeof value.workspacePath === 'string' && !value.workspacePath.includes('\0')
    && path.posix.isAbsolute(value.workspacePath)
    && path.posix.normalize(value.workspacePath) === value.workspacePath
    && value.workspacePath.length <= 4096
    && typeof value.purpose === 'string' && PURPOSES.has(value.purpose);
};

/** Validate policy data that can only originate in a sealed release manifest. */
export const validateSealedPermissionPolicy = (value: unknown): value is SealedPermissionPolicy => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'source', 'profileId', 'contractVersion', 'profileDigest', 'capabilityDigest',
    'protocolGeneration',
  ])) return false;
  return (value.source === 'sealed_release_manifest' || value.source === 'development_unsealed')
    && value.profileId === 'full_delegation'
    && validId(value.contractVersion)
    && typeof value.profileDigest === 'string' && DIGEST_PATTERN.test(value.profileDigest)
    && typeof value.capabilityDigest === 'string' && DIGEST_PATTERN.test(value.capabilityDigest)
    && typeof value.protocolGeneration === 'number'
    && Number.isSafeInteger(value.protocolGeneration) && value.protocolGeneration > 0;
};
