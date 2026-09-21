/** Installation-local, authority-MACed activation and pure eligibility precedence. */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  KILLABLE_CONNECTOR_OPERATIONS, LIFECYCLE_CONNECTOR_OPERATIONS,
  type ConnectorPolicyOperation,
} from './connector-policy-v2.js';
import type {
  ConnectorCertificationPackChannel, ConnectorGlobalPackVerification,
} from './connector-global-certification-pack.js';
import { decideConnectorGlobalCertification } from './connector-global-certification-pack.js';
import {
  connectorDeepFreeze, connectorExactKeys, connectorJcs, connectorPositiveInteger,
  connectorStrictIsoTime, connectorValidId, connectorValidSha512,
  isConnectorPlainObject, ownConnectorJsonValue,
} from './connector-jcs.js';

export const CONNECTOR_LOCAL_ACTIVATION_DOMAIN = 'nassaj.connector-local-activation.v1' as const;
const LOCAL_ACTIVATION_PREFIX = Buffer.from('NASSAJ\0CONNECTOR_LOCAL_ACTIVATION\0V1\0', 'utf8');
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const KILLABLE_OPERATIONS = new Set<string>(KILLABLE_CONNECTOR_OPERATIONS);
const LIFECYCLE_OPERATIONS = new Set<string>(LIFECYCLE_CONNECTOR_OPERATIONS);

export type ConnectorLocalActivation = Readonly<{
  providerId: string;
  serviceId: string;
  operation: typeof KILLABLE_CONNECTOR_OPERATIONS[number];
  enabled: boolean;
  profileRevision: number | null;
}>;

export type ConnectorLocalActivationRecord = Readonly<{
  schemaVersion: 1;
  domain: typeof CONNECTOR_LOCAL_ACTIVATION_DOMAIN;
  installationId: string;
  recordRevision: number;
  policyEpoch: number;
  writerEpoch: number;
  originRevision: number;
  globalPackIssuerId: string;
  globalPackChannel: ConnectorCertificationPackChannel;
  globalPackSequence: number;
  globalPackDigest: string;
  trustBundleRevision: number;
  activations: readonly ConnectorLocalActivation[];
  issuedAt: string;
  issuedByUserId: number;
}>;

export type SignedConnectorLocalActivation = Readonly<{
  record: ConnectorLocalActivationRecord;
  mac: string;
}>;

export type ConnectorLocalActivationVerificationContext = Readonly<{
  authorityRoot: Uint8Array;
  installationId: string;
  policyEpoch: number;
  writerEpoch: number;
  originRevision: number;
  globalPackIssuerId: string;
  globalPackChannel: ConnectorCertificationPackChannel;
  globalPackSequence: number;
  globalPackDigest: string;
  trustBundleRevision: number;
  minimumRecordRevision: number;
  now: Date;
}>;

export type ConnectorLocalActivationVerification = Readonly<{ verified: false; reason: string }>
  | Readonly<{ verified: true; record: ConnectorLocalActivationRecord; digest: string }>;

const RECORD_KEYS = ['schemaVersion', 'domain', 'installationId', 'recordRevision', 'policyEpoch',
  'writerEpoch', 'originRevision', 'globalPackIssuerId', 'globalPackChannel', 'globalPackSequence',
  'globalPackDigest', 'trustBundleRevision', 'activations', 'issuedAt', 'issuedByUserId'] as const;
const ACTIVATION_KEYS = ['providerId', 'serviceId', 'operation', 'enabled', 'profileRevision'] as const;

const validChannel = (value: unknown): value is ConnectorCertificationPackChannel =>
  value === 'stable' || value === 'preview'
  || (typeof value === 'string' && value.startsWith('fork:') && connectorValidId(value.slice(5)));

const validActivation = (value: unknown): value is ConnectorLocalActivation =>
  isConnectorPlainObject(value) && connectorExactKeys(value, ACTIVATION_KEYS)
  && connectorValidId(value.providerId) && connectorValidId(value.serviceId)
  && typeof value.operation === 'string' && KILLABLE_OPERATIONS.has(value.operation)
  && typeof value.enabled === 'boolean'
  && (value.profileRevision === null || connectorPositiveInteger(value.profileRevision));

export const parseConnectorLocalActivationRecord = (
  value: unknown,
): ConnectorLocalActivationRecord | null => {
  const owned = ownConnectorJsonValue(value);
  if (!isConnectorPlainObject(owned) || !connectorExactKeys(owned, RECORD_KEYS)
    || owned.schemaVersion !== 1 || owned.domain !== CONNECTOR_LOCAL_ACTIVATION_DOMAIN
    || !connectorValidId(owned.installationId) || !connectorPositiveInteger(owned.recordRevision)
    || !connectorPositiveInteger(owned.policyEpoch) || !connectorPositiveInteger(owned.writerEpoch)
    || !connectorPositiveInteger(owned.originRevision) || !connectorValidId(owned.globalPackIssuerId)
    || !validChannel(owned.globalPackChannel) || !connectorPositiveInteger(owned.globalPackSequence)
    || !connectorValidSha512(owned.globalPackDigest)
    || !connectorPositiveInteger(owned.trustBundleRevision) || !Array.isArray(owned.activations)
    || owned.activations.length > 2_048 || !owned.activations.every(validActivation)
    || connectorStrictIsoTime(owned.issuedAt) === null
    || !connectorPositiveInteger(owned.issuedByUserId)) return null;
  const identities = owned.activations.map(entry => {
    const activation = entry as ConnectorLocalActivation;
    return `${activation.providerId}\0${activation.serviceId}\0${activation.operation}\0${activation.enabled}`;
  });
  if (new Set(identities).size !== identities.length) return null;
  try { connectorJcs(owned); } catch { return null; }
  return connectorDeepFreeze(owned) as ConnectorLocalActivationRecord;
};

export const connectorLocalActivationBytes = (record: ConnectorLocalActivationRecord): Buffer =>
  Buffer.concat([LOCAL_ACTIVATION_PREFIX, Buffer.from(connectorJcs(record), 'utf8')]);

export const connectorLocalActivationDigest = (record: ConnectorLocalActivationRecord): Buffer =>
  createHash('sha512').update(connectorLocalActivationBytes(record)).digest();

const validAuthorityRoot = (value: Uint8Array): boolean =>
  value instanceof Uint8Array && value.byteLength >= 32 && value.byteLength <= 1_024;

export const connectorLocalActivationMac = (
  record: ConnectorLocalActivationRecord,
  authorityRoot: Uint8Array,
): string => {
  if (!validAuthorityRoot(authorityRoot)) throw new Error('connector_local_authority_invalid');
  return createHmac('sha256', authorityRoot).update(connectorLocalActivationBytes(record))
    .digest('base64url');
};

export const signConnectorLocalActivation = (
  record: ConnectorLocalActivationRecord,
  authorityRoot: Uint8Array,
): SignedConnectorLocalActivation => {
  const parsed = parseConnectorLocalActivationRecord(record);
  if (!parsed) throw new Error('connector_local_activation_invalid');
  return connectorDeepFreeze({ record: parsed, mac: connectorLocalActivationMac(parsed, authorityRoot) });
};

/** Verifies the MAC before reporting binding failures, avoiding an unauthenticated record oracle. */
export const verifyConnectorLocalActivation = (
  envelope: unknown,
  context: ConnectorLocalActivationVerificationContext,
): ConnectorLocalActivationVerification => {
  let ownedEnvelope: unknown;
  let ownedContext: Omit<ConnectorLocalActivationVerificationContext, 'authorityRoot'>;
  try {
    ownedEnvelope = ownConnectorJsonValue(envelope);
    ownedContext = structuredClone({ ...context, authorityRoot: undefined }) as typeof ownedContext;
  } catch { return { verified: false, reason: 'verification_context_invalid' }; }
  if (!validAuthorityRoot(context.authorityRoot)) {
    return { verified: false, reason: 'verification_context_invalid' };
  }
  if (!isConnectorPlainObject(ownedEnvelope) || !connectorExactKeys(ownedEnvelope, ['record', 'mac'])
    || typeof ownedEnvelope.mac !== 'string') return { verified: false, reason: 'malformed_envelope' };
  const record = parseConnectorLocalActivationRecord(ownedEnvelope.record);
  if (!record) return { verified: false, reason: 'malformed_record' };
  if (!MAC_PATTERN.test(ownedEnvelope.mac)) return { verified: false, reason: 'mac_invalid' };
  const supplied = Buffer.from(ownedEnvelope.mac, 'base64url');
  const expected = Buffer.from(connectorLocalActivationMac(record, context.authorityRoot), 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { verified: false, reason: 'mac_invalid' };
  }
  const nowMs = ownedContext.now instanceof Date ? ownedContext.now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs) || connectorStrictIsoTime(record.issuedAt) as number > nowMs + 300_000
    || !connectorValidId(ownedContext.installationId)
    || !connectorPositiveInteger(ownedContext.policyEpoch)
    || !connectorPositiveInteger(ownedContext.writerEpoch)
    || !connectorPositiveInteger(ownedContext.originRevision)
    || !connectorValidId(ownedContext.globalPackIssuerId)
    || !validChannel(ownedContext.globalPackChannel)
    || !connectorPositiveInteger(ownedContext.globalPackSequence)
    || !connectorValidSha512(ownedContext.globalPackDigest)
    || !connectorPositiveInteger(ownedContext.trustBundleRevision)
    || !connectorPositiveInteger(ownedContext.minimumRecordRevision)) {
    return { verified: false, reason: 'verification_context_invalid' };
  }
  const bindings: readonly [keyof ConnectorLocalActivationRecord, unknown][] = [
    ['installationId', ownedContext.installationId], ['policyEpoch', ownedContext.policyEpoch],
    ['writerEpoch', ownedContext.writerEpoch], ['originRevision', ownedContext.originRevision],
    ['globalPackIssuerId', ownedContext.globalPackIssuerId],
    ['globalPackChannel', ownedContext.globalPackChannel],
    ['globalPackSequence', ownedContext.globalPackSequence],
    ['globalPackDigest', ownedContext.globalPackDigest],
    ['trustBundleRevision', ownedContext.trustBundleRevision],
  ];
  for (const [field, expectedValue] of bindings) {
    if (record[field] !== expectedValue) return { verified: false, reason: `${field}_mismatch` };
  }
  if (record.recordRevision < ownedContext.minimumRecordRevision) {
    return { verified: false, reason: 'record_revision_rollback' };
  }
  return connectorDeepFreeze({ verified: true, record: structuredClone(record),
    digest: connectorLocalActivationDigest(record).toString('base64url') });
};

export type ConnectorFoundationEligibilityInput = Readonly<{
  operation: ConnectorPolicyOperation;
  providerId: string;
  serviceId: string;
  foundationQuarantined: boolean;
  globalKilled: boolean;
  providerKilled: boolean;
  serviceOperationKilled: boolean;
  globalPack: ConnectorGlobalPackVerification;
  localActivation: ConnectorLocalActivationVerification;
  profileReady: boolean;
  grantReady: boolean;
  verificationReady: boolean;
}>;

export type ConnectorFoundationEligibility = Readonly<{
  eligible: boolean;
  reason: 'safety_operation' | 'foundation_quarantined' | 'global_killed' | 'provider_killed'
  | 'service_operation_killed' | 'pack_invalid' | 'pack_suspended' | 'pack_uncertified'
  | 'local_disabled' | 'profile_unready' | 'grant_unready' | 'verification_unready' | 'eligible';
}>;

/** Exact D9 precedence. This decision creates no capability and performs no external work. */
export const decideConnectorFoundationEligibility = (
  input: ConnectorFoundationEligibilityInput,
): ConnectorFoundationEligibility => {
  if (LIFECYCLE_OPERATIONS.has(input.operation)) return { eligible: true, reason: 'safety_operation' };
  if (!KILLABLE_OPERATIONS.has(input.operation)) return { eligible: false, reason: 'pack_uncertified' };
  if (input.foundationQuarantined) return { eligible: false, reason: 'foundation_quarantined' };
  if (input.globalKilled) return { eligible: false, reason: 'global_killed' };
  if (input.providerKilled) return { eligible: false, reason: 'provider_killed' };
  if (input.serviceOperationKilled) return { eligible: false, reason: 'service_operation_killed' };
  if (!input.globalPack.verified) return { eligible: false, reason: 'pack_invalid' };
  const certification = decideConnectorGlobalCertification(input.globalPack, input.providerId,
    input.serviceId, input.operation);
  if (certification.status === 'suspended') return { eligible: false, reason: 'pack_suspended' };
  if (certification.status !== 'certified') return { eligible: false, reason: 'pack_uncertified' };
  if (!input.localActivation.verified) return { eligible: false, reason: 'local_disabled' };
  const localRecord = input.localActivation.record;
  if (localRecord.globalPackIssuerId !== input.globalPack.pack.issuerId
    || localRecord.globalPackChannel !== input.globalPack.pack.channel
    || localRecord.globalPackSequence !== input.globalPack.pack.sequence
    || localRecord.globalPackDigest !== input.globalPack.digest
    || localRecord.trustBundleRevision !== input.globalPack.trustBundleRevision) {
    return { eligible: false, reason: 'local_disabled' };
  }
  const matches = localRecord.activations.filter(entry =>
    entry.providerId === input.providerId && entry.serviceId === input.serviceId
    && entry.operation === input.operation);
  if (matches.length === 0 || matches.some(entry => !entry.enabled)) {
    return { eligible: false, reason: 'local_disabled' };
  }
  if (!input.profileReady) return { eligible: false, reason: 'profile_unready' };
  if (!input.grantReady) return { eligible: false, reason: 'grant_unready' };
  if (!input.verificationReady) return { eligible: false, reason: 'verification_unready' };
  return { eligible: true, reason: 'eligible' };
};
