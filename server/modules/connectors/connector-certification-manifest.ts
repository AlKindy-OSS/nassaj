/** Offline certification-manifest verification for the inert Policy V2 substrate. */

import { createHash, createPublicKey, verify } from 'node:crypto';

import {
  KILLABLE_CONNECTOR_OPERATIONS,
  type ConnectorCertificationBinding,
  type ConnectorPolicyOperation,
} from './connector-policy-v2.js';

export const CONNECTOR_CERTIFICATION_DOMAIN = 'nassaj.connector-certification.v2' as const;
const DIGEST_PREFIX = Buffer.from('NASSAJ\0CONNECTOR_CERTIFICATION\0V2\0', 'utf8');
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const KILLABLE_OPERATIONS = new Set<string>(KILLABLE_CONNECTOR_OPERATIONS);
const MAX_MANIFEST_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type ConnectorCertification = Readonly<{
  providerId: string;
  serviceId: string;
  shapeRevision: number;
  shapeDigest: string;
  contractRevision: number;
  contractDigest: string;
  operations: readonly typeof KILLABLE_CONNECTOR_OPERATIONS[number][];
}>;

export type ConnectorCertificationRequirement = Readonly<Omit<ConnectorCertification, 'operations'> & {
  operation: ConnectorPolicyOperation;
}>;

export type ConnectorCertificationManifest = Readonly<{
  schemaVersion: 1;
  domain: typeof CONNECTOR_CERTIFICATION_DOMAIN;
  installationId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  originRevision: number;
  registryRevision: string;
  registryDigest: string;
  operationsRevision: string;
  operationsDigest: string;
  capabilityRevision: string;
  capabilityDigest: string;
  certifications: readonly ConnectorCertification[];
  signingKeyId: string;
}>;

export type SignedConnectorCertificationManifest = Readonly<{
  manifest: ConnectorCertificationManifest;
  signature: string;
}>;

export type ConnectorCertificationTrustRoot = Readonly<{
  keyId: string;
  algorithm: 'Ed25519';
  publicKeyPem: string;
  validFrom: string;
  validUntil: string;
}>;

export type ConnectorCertificationTrustBundle = Readonly<{
  revision: number;
  roots: readonly ConnectorCertificationTrustRoot[];
  revokedKeyIds: ReadonlySet<string>;
}>;

export interface ConnectorCertificationSequenceStore {
  /** Atomically accepts only a value greater than the durable prior sequence. */
  accept(scope: string, sequence: number): Promise<boolean>;
}

export type CertificationVerificationContext = Readonly<{
  installationId: string;
  originRevision: number;
  registryRevision: string;
  registryDigest: string;
  operationsRevision: string;
  operationsDigest: string;
  capabilityRevision: string;
  capabilityDigest: string;
  now: Date;
  clockSkewMs: number;
  minimumTrustBundleRevision: number;
  trustBundle: ConnectorCertificationTrustBundle;
  sequenceStore: ConnectorCertificationSequenceStore;
}>;

type OwnedVerificationContext = Readonly<Omit<CertificationVerificationContext, 'sequenceStore'>>;

type VerificationFailure = Readonly<{ verified: false; reason: string }>;
export type CertificationManifestVerification = VerificationFailure | Readonly<{
  verified: true;
  manifest: ConnectorCertificationManifest;
  digest: string;
  trustBundleRevision: number;
}>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};

/** Canonical JSON subset: integers only and lexicographically ordered object keys. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainObject(value)) throw new Error('connector_manifest_noncanonical_value');
  const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
};

export const connectorCertificationDigest = (manifest: ConnectorCertificationManifest): Buffer =>
  createHash('sha512').update(DIGEST_PREFIX).update(canonicalJson(manifest), 'utf8').digest();

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
};

const strictIsoTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
};

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const validId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);
const validDigest = (value: unknown): value is string =>
  typeof value === 'string' && SHA256_BASE64URL_PATTERN.test(value);

const validCertification = (value: unknown): value is ConnectorCertification => {
  if (!isPlainObject(value) || !exactKeys(value, ['providerId', 'serviceId', 'shapeRevision',
    'shapeDigest', 'contractRevision', 'contractDigest', 'operations'])) return false;
  return validId(value.providerId) && validId(value.serviceId)
    && positiveInteger(value.shapeRevision) && validDigest(value.shapeDigest)
    && positiveInteger(value.contractRevision) && validDigest(value.contractDigest)
    && Array.isArray(value.operations) && value.operations.length > 0
    && value.operations.every(operation => typeof operation === 'string'
      && KILLABLE_OPERATIONS.has(operation))
    && new Set(value.operations).size === value.operations.length;
};

const MANIFEST_KEYS = ['schemaVersion', 'domain', 'installationId', 'sequence', 'issuedAt',
  'expiresAt', 'originRevision', 'registryRevision', 'registryDigest', 'operationsRevision',
  'operationsDigest', 'capabilityRevision', 'capabilityDigest', 'certifications', 'signingKeyId'] as const;

/** Closed-schema parser returning an owned, deeply frozen clone. */
export const parseConnectorCertificationManifest = (value: unknown): ConnectorCertificationManifest | null => {
  let owned: unknown;
  try { owned = structuredClone(value); } catch { return null; }
  if (!isPlainObject(owned) || !exactKeys(owned, MANIFEST_KEYS)) return null;
  const issued = strictIsoTime(owned.issuedAt);
  const expires = strictIsoTime(owned.expiresAt);
  if (owned.schemaVersion !== 1 || owned.domain !== CONNECTOR_CERTIFICATION_DOMAIN
    || !validId(owned.installationId) || !positiveInteger(owned.sequence) || issued === null || expires === null
    || expires <= issued || expires - issued > MAX_MANIFEST_TTL_MS
    || !positiveInteger(owned.originRevision) || !validRevisionBinding(owned)
    || !validId(owned.signingKeyId) || !Array.isArray(owned.certifications)
    || owned.certifications.length < 1 || owned.certifications.length > 128
    || !owned.certifications.every(validCertification)) return null;
  const identities = owned.certifications.map(entry => {
    const certification = entry as ConnectorCertification;
    return `${certification.providerId}\0${certification.serviceId}`;
  });
  if (new Set(identities).size !== identities.length) return null;
  return deepFreeze(owned) as ConnectorCertificationManifest;
};

const validRevisionBinding = (value: Record<string, unknown>): boolean =>
  ['registryRevision', 'operationsRevision', 'capabilityRevision'].every(key =>
    validId(value[key]))
  && ['registryDigest', 'operationsDigest', 'capabilityDigest'].every(key =>
    validDigest(value[key]));

const locateTrustRoot = (
  manifest: ConnectorCertificationManifest,
  bundle: ConnectorCertificationTrustBundle,
  nowMs: number,
  issuedAtMs: number,
): ConnectorCertificationTrustRoot | null => {
  if (!positiveInteger(bundle.revision) || !(bundle.revokedKeyIds instanceof Set)
    || !Array.isArray(bundle.roots) || bundle.revokedKeyIds.has(manifest.signingKeyId)) return null;
  const matching = bundle.roots.filter(candidate => candidate.keyId === manifest.signingKeyId);
  if (matching.length !== 1 || matching[0].algorithm !== 'Ed25519') return null;
  const root = matching[0];
  const from = strictIsoTime(root.validFrom);
  const until = strictIsoTime(root.validUntil);
  return from !== null && until !== null && from < until
    && from <= issuedAtMs && issuedAtMs < until && from <= nowMs && nowMs < until ? root : null;
};

const validateBindings = (
  manifest: ConnectorCertificationManifest,
  context: OwnedVerificationContext,
): string | null => {
  if (manifest.installationId !== context.installationId) return 'installation_mismatch';
  if (manifest.originRevision !== context.originRevision) return 'origin_revision_mismatch';
  for (const field of ['registryRevision', 'registryDigest', 'operationsRevision',
    'operationsDigest', 'capabilityRevision', 'capabilityDigest'] as const) {
    if (manifest[field] !== context[field]) return `${field.replace(/[A-Z]/gu, match => `_${match.toLowerCase()}`)}_mismatch`;
  }
  if (!Number.isSafeInteger(context.clockSkewMs) || context.clockSkewMs < 0
    || context.clockSkewMs > 300_000) return 'clock_skew_invalid';
  if (!positiveInteger(context.minimumTrustBundleRevision)
    || context.trustBundle.revision < context.minimumTrustBundleRevision) return 'trust_bundle_revision_rollback';
  const nowMs = context.now.getTime();
  if (!Number.isFinite(nowMs)) return 'clock_invalid';
  const issued = strictIsoTime(manifest.issuedAt) as number;
  const expires = strictIsoTime(manifest.expiresAt) as number;
  if (issued > nowMs + context.clockSkewMs) return 'manifest_not_yet_valid';
  if (expires <= nowMs - context.clockSkewMs) return 'manifest_expired';
  return null;
};

const cloneVerificationContext = (
  context: CertificationVerificationContext,
): OwnedVerificationContext | null => {
  try {
    const owned = structuredClone({
      installationId: context.installationId, originRevision: context.originRevision,
      registryRevision: context.registryRevision, registryDigest: context.registryDigest,
      operationsRevision: context.operationsRevision, operationsDigest: context.operationsDigest,
      capabilityRevision: context.capabilityRevision, capabilityDigest: context.capabilityDigest,
      now: context.now, clockSkewMs: context.clockSkewMs,
      minimumTrustBundleRevision: context.minimumTrustBundleRevision,
      trustBundle: context.trustBundle,
    });
    return deepFreeze(owned) as OwnedVerificationContext;
  } catch { return null; }
};

/** Offline-only verifier; it clones before validation and never retains caller-owned data. */
export const verifyConnectorCertificationManifest = async (
  envelope: unknown,
  context: CertificationVerificationContext,
): Promise<CertificationManifestVerification> => {
  let ownedEnvelope: unknown;
  try { ownedEnvelope = structuredClone(envelope); } catch { return { verified: false, reason: 'malformed_envelope' }; }
  const ownedContext = cloneVerificationContext(context);
  if (!ownedContext) return { verified: false, reason: 'verification_context_invalid' };
  let acceptSequence: ((scope: string, sequence: number) => Promise<boolean>);
  try { acceptSequence = context.sequenceStore.accept.bind(context.sequenceStore); }
  catch { return { verified: false, reason: 'verification_context_invalid' }; }
  if (!isPlainObject(ownedEnvelope) || !exactKeys(ownedEnvelope, ['manifest', 'signature'])
    || typeof ownedEnvelope.signature !== 'string') return { verified: false, reason: 'malformed_envelope' };
  const manifest = parseConnectorCertificationManifest(ownedEnvelope.manifest);
  if (!manifest) return { verified: false, reason: 'malformed_manifest' };
  let bindingFailure: string | null;
  try { bindingFailure = validateBindings(manifest, ownedContext); }
  catch { return { verified: false, reason: 'verification_context_invalid' }; }
  if (bindingFailure) return { verified: false, reason: bindingFailure };
  let root: ConnectorCertificationTrustRoot | null;
  try { root = locateTrustRoot(manifest, ownedContext.trustBundle, ownedContext.now.getTime(),
    strictIsoTime(manifest.issuedAt) as number); }
  catch { return { verified: false, reason: 'verification_context_invalid' }; }
  if (!root) return { verified: false, reason: 'trust_root_unavailable' };
  if (!/^[A-Za-z0-9_-]{86}$/u.test(ownedEnvelope.signature)) return { verified: false, reason: 'signature_invalid' };
  const signature = Buffer.from(ownedEnvelope.signature, 'base64url');
  const digest = connectorCertificationDigest(manifest);
  try {
    if (!verify(null, digest, createPublicKey(root.publicKeyPem), signature)) {
      return { verified: false, reason: 'signature_invalid' };
    }
  } catch { return { verified: false, reason: 'trust_root_invalid' }; }
  const scope = `${manifest.installationId}:${manifest.domain}`;
  let accepted: boolean;
  try { accepted = await acceptSequence(scope, manifest.sequence); }
  catch { return { verified: false, reason: 'sequence_store_unavailable' }; }
  if (!accepted) {
    return { verified: false, reason: 'sequence_replayed' };
  }
  return deepFreeze({ verified: true, manifest: structuredClone(manifest),
    digest: digest.toString('base64url'), trustBundleRevision: ownedContext.trustBundle.revision });
};

/** Converts only an exactly bound entry; unsigned development remains uncertified. */
export const certificationBindingForPolicy = (
  result: CertificationManifestVerification | null,
  requirement: ConnectorCertificationRequirement,
): ConnectorCertificationBinding | null => {
  if (!result?.verified || !KILLABLE_OPERATIONS.has(requirement.operation)) return null;
  const entry = result.manifest.certifications.find(candidate =>
    candidate.providerId === requirement.providerId && candidate.serviceId === requirement.serviceId
    && candidate.shapeRevision === requirement.shapeRevision && candidate.shapeDigest === requirement.shapeDigest
    && candidate.contractRevision === requirement.contractRevision
    && candidate.contractDigest === requirement.contractDigest
    && candidate.operations.includes(requirement.operation as typeof KILLABLE_CONNECTOR_OPERATIONS[number]));
  if (!entry) return null;
  return deepFreeze({ certified: true, providerId: entry.providerId, serviceId: entry.serviceId,
    operation: requirement.operation as typeof KILLABLE_CONNECTOR_OPERATIONS[number],
    manifestSequence: result.manifest.sequence,
    manifestDigest: result.digest, originRevision: result.manifest.originRevision,
    registryRevision: result.manifest.registryRevision,
    registryDigest: result.manifest.registryDigest,
    operationsRevision: result.manifest.operationsRevision,
    operationsDigest: result.manifest.operationsDigest,
    capabilityRevision: result.manifest.capabilityRevision,
    capabilityDigest: result.manifest.capabilityDigest,
    shapeRevision: entry.shapeRevision, shapeDigest: entry.shapeDigest,
    contractRevision: entry.contractRevision, contractDigest: entry.contractDigest });
};

/** Deterministic fixture with an atomic monotonic comparison. */
export class MemoryCertificationSequenceStore implements ConnectorCertificationSequenceStore {
  readonly #sequences = new Map<string, number>();
  async accept(scope: string, sequence: number): Promise<boolean> {
    const prior = this.#sequences.get(scope) ?? 0;
    if (!positiveInteger(sequence) || sequence <= prior) return false;
    this.#sequences.set(scope, sequence);
    return true;
  }
}
