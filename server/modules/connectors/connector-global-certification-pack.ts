/** Pure verifier for globally distributed connector certification packs. */

import { createHash, createPublicKey, verify } from 'node:crypto';

import {
  KILLABLE_CONNECTOR_OPERATIONS, type ConnectorPolicyOperation,
} from './connector-policy-v2.js';
import {
  connectorDeepFreeze, connectorExactKeys, connectorJcs, connectorPositiveInteger,
  connectorStrictIsoTime, connectorValidId, connectorValidSha256, isConnectorPlainObject,
  ownConnectorJsonValue,
} from './connector-jcs.js';
import {
  parseConnectorTrustBundle, selectConnectorTrustRoot, type ConnectorTrustBundle,
} from './connector-trust-bundle.js';

export const CONNECTOR_GLOBAL_PACK_DOMAIN = 'nassaj.connector-certification-pack.v1' as const;
const GLOBAL_PACK_PREFIX = Buffer.from('NASSAJ\0CONNECTOR_GLOBAL_PACK\0V1\0', 'utf8');
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const KILLABLE_OPERATIONS = new Set<string>(KILLABLE_CONNECTOR_OPERATIONS);
export const CONNECTOR_GLOBAL_PACK_CLOCK_SKEW_MS = 300_000 as const;
export const CONNECTOR_GLOBAL_PACK_STANDARD_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const CONNECTOR_GLOBAL_PACK_MAX_TTL_MS = 45 * 24 * 60 * 60 * 1_000;

export type ConnectorCertificationPackChannel = 'stable' | 'preview' | `fork:${string}`;
export type ConnectorCertificationAuthMethod = 'dcr_pkce' | 'byo_app' | 'api_key';

export type ConnectorGlobalCertification = Readonly<{
  providerId: string;
  serviceId: string;
  operation: typeof KILLABLE_CONNECTOR_OPERATIONS[number];
  authMethod: ConnectorCertificationAuthMethod;
  shapeRevision: number;
  shapeDigest: string;
  contractRevision: number;
  contractDigest: string;
  status: 'certified' | 'suspended';
}>;

export type ConnectorGlobalCertificationPack = Readonly<{
  schemaVersion: 1;
  domain: typeof CONNECTOR_GLOBAL_PACK_DOMAIN;
  issuerId: string;
  channel: ConnectorCertificationPackChannel;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  minimumRuntimeFloor: number;
  maximumPolicySchemaVersion: number;
  registryRevision: string;
  registryDigest: string;
  operationsRevision: string;
  operationsDigest: string;
  capabilityRevision: string;
  capabilityDigest: string;
  certifications: readonly ConnectorGlobalCertification[];
  signingKeyId: string;
}>;

export type SignedConnectorGlobalCertificationPack = Readonly<{
  pack: ConnectorGlobalCertificationPack;
  signature: string;
}>;

export type ConnectorGlobalPackVerificationContext = Readonly<{
  now: Date;
  wallClockHighWaterMs: number;
  priorSequence: number;
  minimumTrustBundleRevision: number;
  runtimeFloor: number;
  policySchemaVersion: number;
  trustBundle: ConnectorTrustBundle;
  expectedRegistryRevision: string;
  expectedRegistryDigest: string;
  expectedOperationsRevision: string;
  expectedOperationsDigest: string;
  expectedCapabilityRevision: string;
  expectedCapabilityDigest: string;
}>;

export type ConnectorGlobalPackVerification = Readonly<{ verified: false; reason: string }>
  | Readonly<{
    verified: true;
    pack: ConnectorGlobalCertificationPack;
    digest: string;
    trustBundleRevision: number;
    acceptedSequenceScope: string;
    acceptedSequence: number;
    wallClockHighWaterMs: number;
  }>;

const PACK_KEYS = ['schemaVersion', 'domain', 'issuerId', 'channel', 'sequence', 'issuedAt',
  'expiresAt', 'minimumRuntimeFloor', 'maximumPolicySchemaVersion', 'registryRevision',
  'registryDigest', 'operationsRevision', 'operationsDigest', 'capabilityRevision',
  'capabilityDigest', 'certifications', 'signingKeyId'] as const;
const CERTIFICATION_KEYS = ['providerId', 'serviceId', 'operation', 'authMethod', 'shapeRevision',
  'shapeDigest', 'contractRevision', 'contractDigest', 'status'] as const;

const validChannel = (value: unknown): value is ConnectorCertificationPackChannel =>
  value === 'stable' || value === 'preview'
  || (typeof value === 'string' && value.startsWith('fork:') && connectorValidId(value.slice(5)));

const validCertification = (value: unknown): value is ConnectorGlobalCertification => {
  if (!isConnectorPlainObject(value) || !connectorExactKeys(value, CERTIFICATION_KEYS)) return false;
  return connectorValidId(value.providerId) && connectorValidId(value.serviceId)
    && typeof value.operation === 'string' && KILLABLE_OPERATIONS.has(value.operation)
    && (value.authMethod === 'dcr_pkce' || value.authMethod === 'byo_app' || value.authMethod === 'api_key')
    && connectorPositiveInteger(value.shapeRevision) && connectorValidSha256(value.shapeDigest)
    && connectorPositiveInteger(value.contractRevision) && connectorValidSha256(value.contractDigest)
    && (value.status === 'certified' || value.status === 'suspended');
};

/** Closed-schema parser; stable packs live at most 30 days, preview/fork packs at most 45. */
export const parseConnectorGlobalCertificationPack = (
  value: unknown,
): ConnectorGlobalCertificationPack | null => {
  const owned = ownConnectorJsonValue(value);
  if (!isConnectorPlainObject(owned) || !connectorExactKeys(owned, PACK_KEYS)) return null;
  const issuedAt = connectorStrictIsoTime(owned.issuedAt);
  const expiresAt = connectorStrictIsoTime(owned.expiresAt);
  if (owned.schemaVersion !== 1 || owned.domain !== CONNECTOR_GLOBAL_PACK_DOMAIN
    || !connectorValidId(owned.issuerId) || !validChannel(owned.channel)
    || !connectorPositiveInteger(owned.sequence) || issuedAt === null || expiresAt === null
    || expiresAt <= issuedAt || expiresAt - issuedAt > CONNECTOR_GLOBAL_PACK_MAX_TTL_MS
    || (owned.channel === 'stable' && expiresAt - issuedAt > CONNECTOR_GLOBAL_PACK_STANDARD_TTL_MS)
    || !connectorPositiveInteger(owned.minimumRuntimeFloor)
    || !connectorPositiveInteger(owned.maximumPolicySchemaVersion)
    || !connectorValidId(owned.registryRevision) || !connectorValidSha256(owned.registryDigest)
    || !connectorValidId(owned.operationsRevision) || !connectorValidSha256(owned.operationsDigest)
    || !connectorValidId(owned.capabilityRevision) || !connectorValidSha256(owned.capabilityDigest)
    || !Array.isArray(owned.certifications)
    || owned.certifications.length > 2_048 || !owned.certifications.every(validCertification)
    || !connectorValidId(owned.signingKeyId)) return null;
  const identities = owned.certifications.map(entry => {
    const certification = entry as ConnectorGlobalCertification;
    return [certification.providerId, certification.serviceId, certification.operation,
      certification.status].join('\0');
  });
  if (new Set(identities).size !== identities.length) return null;
  try { connectorJcs(owned); } catch { return null; }
  return connectorDeepFreeze(owned) as ConnectorGlobalCertificationPack;
};

export const connectorGlobalPackSignedBytes = (pack: ConnectorGlobalCertificationPack): Buffer =>
  Buffer.concat([GLOBAL_PACK_PREFIX, Buffer.from(connectorJcs(pack), 'utf8')]);

export const connectorGlobalPackDigest = (pack: ConnectorGlobalCertificationPack): Buffer =>
  createHash('sha512').update(connectorGlobalPackSignedBytes(pack)).digest();

/** Pure verification: callers durably CAS the returned sequence/high-water only after success. */
export const verifyConnectorGlobalCertificationPack = (
  envelope: unknown,
  context: ConnectorGlobalPackVerificationContext,
): ConnectorGlobalPackVerification => {
  let ownedEnvelope: unknown;
  let ownedContext: ConnectorGlobalPackVerificationContext;
  try {
    ownedEnvelope = ownConnectorJsonValue(envelope);
    ownedContext = structuredClone(context);
  } catch { return { verified: false, reason: 'verification_context_invalid' }; }
  if (!isConnectorPlainObject(ownedEnvelope) || !connectorExactKeys(ownedEnvelope, ['pack', 'signature'])
    || typeof ownedEnvelope.signature !== 'string') return { verified: false, reason: 'malformed_envelope' };
  const pack = parseConnectorGlobalCertificationPack(ownedEnvelope.pack);
  if (!pack) return { verified: false, reason: 'malformed_pack' };
  const nowMs = ownedContext.now instanceof Date ? ownedContext.now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(ownedContext.wallClockHighWaterMs)
    || ownedContext.wallClockHighWaterMs < 0 || !Number.isSafeInteger(ownedContext.priorSequence)
    || ownedContext.priorSequence < 0 || !connectorPositiveInteger(ownedContext.minimumTrustBundleRevision)
    || !connectorPositiveInteger(ownedContext.runtimeFloor)
    || !connectorPositiveInteger(ownedContext.policySchemaVersion)) {
    return { verified: false, reason: 'verification_context_invalid' };
  }
  const runtimeBindings = [
    [pack.registryRevision, ownedContext.expectedRegistryRevision, 'registry_revision_mismatch'],
    [pack.registryDigest, ownedContext.expectedRegistryDigest, 'registry_digest_mismatch'],
    [pack.operationsRevision, ownedContext.expectedOperationsRevision, 'operations_revision_mismatch'],
    [pack.operationsDigest, ownedContext.expectedOperationsDigest, 'operations_digest_mismatch'],
    [pack.capabilityRevision, ownedContext.expectedCapabilityRevision, 'capability_revision_mismatch'],
    [pack.capabilityDigest, ownedContext.expectedCapabilityDigest, 'capability_digest_mismatch'],
  ] as const;
  for (const [actual, expected, reason] of runtimeBindings) {
    if (actual !== expected) return { verified: false, reason };
  }
  if (nowMs + CONNECTOR_GLOBAL_PACK_CLOCK_SKEW_MS < ownedContext.wallClockHighWaterMs) {
    return { verified: false, reason: 'clock_untrusted' };
  }
  const issuedAt = connectorStrictIsoTime(pack.issuedAt) as number;
  const expiresAt = connectorStrictIsoTime(pack.expiresAt) as number;
  if (issuedAt > nowMs + CONNECTOR_GLOBAL_PACK_CLOCK_SKEW_MS) {
    return { verified: false, reason: 'pack_not_yet_valid' };
  }
  if (expiresAt <= nowMs) return { verified: false, reason: 'pack_expired' };
  if (pack.sequence <= ownedContext.priorSequence) return { verified: false, reason: 'sequence_replayed' };
  if (ownedContext.runtimeFloor < pack.minimumRuntimeFloor) {
    return { verified: false, reason: 'runtime_floor_unsupported' };
  }
  if (ownedContext.policySchemaVersion > pack.maximumPolicySchemaVersion) {
    return { verified: false, reason: 'policy_schema_unsupported' };
  }
  const trustBundle = parseConnectorTrustBundle(ownedContext.trustBundle);
  if (!trustBundle) return { verified: false, reason: 'trust_bundle_invalid' };
  if (trustBundle.revision < ownedContext.minimumTrustBundleRevision) {
    return { verified: false, reason: 'trust_bundle_revision_rollback' };
  }
  const root = selectConnectorTrustRoot(trustBundle, pack.issuerId, pack.signingKeyId,
    issuedAt, nowMs);
  if (!root) return { verified: false, reason: 'trust_root_unavailable' };
  if (!SIGNATURE_PATTERN.test(ownedEnvelope.signature)) {
    return { verified: false, reason: 'signature_invalid' };
  }
  try {
    const valid = verify(null, connectorGlobalPackSignedBytes(pack), createPublicKey(root.publicKeyPem),
      Buffer.from(ownedEnvelope.signature, 'base64url'));
    if (!valid) return { verified: false, reason: 'signature_invalid' };
  } catch { return { verified: false, reason: 'trust_root_invalid' }; }
  const digest = connectorGlobalPackDigest(pack).toString('base64url');
  return connectorDeepFreeze({ verified: true, pack: structuredClone(pack), digest,
    trustBundleRevision: trustBundle.revision,
    acceptedSequenceScope: `${pack.issuerId}\0${pack.channel}`,
    acceptedSequence: pack.sequence,
    wallClockHighWaterMs: Math.max(ownedContext.wallClockHighWaterMs, nowMs) });
};

export type ConnectorGlobalCertificationDecision = Readonly<{
  status: 'certified' | 'suspended' | 'uncertified';
  certification: ConnectorGlobalCertification | null;
}>;

/** One effective entry per provider/service/operation; a suspension always wins. */
export const effectiveConnectorGlobalCertifications = (
  pack: ConnectorGlobalCertificationPack,
): readonly ConnectorGlobalCertification[] => {
  const effective = new Map<string, ConnectorGlobalCertification>();
  for (const candidate of pack.certifications) {
    const key = `${candidate.providerId}\0${candidate.serviceId}\0${candidate.operation}`;
    const prior = effective.get(key);
    if (!prior || candidate.status === 'suspended') effective.set(key, candidate);
  }
  return connectorDeepFreeze([...effective.values()]);
};

/** Suspended wins even if another entry for the same operation says certified. */
export const decideConnectorGlobalCertification = (
  verification: ConnectorGlobalPackVerification,
  providerId: string,
  serviceId: string,
  operation: ConnectorPolicyOperation,
): ConnectorGlobalCertificationDecision => {
  if (!verification.verified) return { status: 'uncertified', certification: null };
  const matches = effectiveConnectorGlobalCertifications(verification.pack).filter(entry => entry.providerId === providerId
    && entry.serviceId === serviceId && entry.operation === operation);
  const suspended = matches.find(entry => entry.status === 'suspended');
  if (suspended) return connectorDeepFreeze({ status: 'suspended', certification: suspended });
  const certified = matches.find(entry => entry.status === 'certified');
  return certified ? connectorDeepFreeze({ status: 'certified', certification: certified })
    : { status: 'uncertified', certification: null };
};
