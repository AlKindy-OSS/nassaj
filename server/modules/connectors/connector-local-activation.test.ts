import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTOR_GLOBAL_PACK_DOMAIN, type ConnectorGlobalPackVerification,
} from './connector-global-certification-pack.js';
import {
  CONNECTOR_LOCAL_ACTIVATION_DOMAIN, connectorLocalActivationDigest,
  decideConnectorFoundationEligibility, parseConnectorLocalActivationRecord,
  signConnectorLocalActivation, verifyConnectorLocalActivation,
  type ConnectorFoundationEligibilityInput, type ConnectorLocalActivationRecord,
  type ConnectorLocalActivationVerificationContext,
} from './connector-local-activation.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';

const authorityRoot = Buffer.alloc(32, 7);
const globalDigest = 'g'.repeat(86);
const record = (overrides: Partial<ConnectorLocalActivationRecord> = {}): ConnectorLocalActivationRecord => ({
  schemaVersion: 1, domain: CONNECTOR_LOCAL_ACTIVATION_DOMAIN, installationId: 'install-1',
  recordRevision: 3, policyEpoch: 4, writerEpoch: 5, originRevision: 2,
  globalPackIssuerId: 'nassaj-oss', globalPackChannel: 'stable', globalPackSequence: 8,
  globalPackDigest: globalDigest, trustBundleRevision: 4, activations: [{ providerId: 'github',
    serviceId: 'github', operation: ConnectorPolicyOperation.CredentialUse, enabled: true,
    profileRevision: 2 }], issuedAt: '2026-08-15T00:00:00.000Z', issuedByUserId: 1, ...overrides,
});

const context = (overrides: Partial<ConnectorLocalActivationVerificationContext> = {}): ConnectorLocalActivationVerificationContext => ({
  authorityRoot, installationId: 'install-1', policyEpoch: 4, writerEpoch: 5, originRevision: 2,
  globalPackIssuerId: 'nassaj-oss', globalPackChannel: 'stable', globalPackSequence: 8,
  globalPackDigest: globalDigest, trustBundleRevision: 4, minimumRecordRevision: 3,
  now: new Date('2026-08-15T00:01:00.000Z'), ...overrides,
});

const verifiedPack = (status: 'certified' | 'suspended' = 'certified'): ConnectorGlobalPackVerification => ({
  verified: true, digest: globalDigest, trustBundleRevision: 4, acceptedSequence: 8,
  acceptedSequenceScope: 'nassaj-oss\0stable',
  wallClockHighWaterMs: Date.parse('2026-08-15T00:00:00.000Z'), pack: {
    schemaVersion: 1, domain: CONNECTOR_GLOBAL_PACK_DOMAIN, issuerId: 'nassaj-oss', channel: 'stable',
    sequence: 8, issuedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-31T00:00:00.000Z',
    minimumRuntimeFloor: 1, maximumPolicySchemaVersion: 2, registryRevision: 'registry-2',
    registryDigest: 'r'.repeat(43), operationsRevision: 'operations-2', operationsDigest: 'o'.repeat(43),
    capabilityRevision: 'capability-2', capabilityDigest: 'c'.repeat(43), signingKeyId: 'root-1',
    certifications: [{ providerId: 'github', serviceId: 'github',
      operation: ConnectorPolicyOperation.CredentialUse, authMethod: 'api_key', shapeRevision: 1,
      shapeDigest: 's'.repeat(43), contractRevision: 1, contractDigest: 'd'.repeat(43), status }],
  },
});

test('local activation uses prefixed SHA-512 and constant-length authority HMAC', () => {
  const signed = signConnectorLocalActivation(record(), authorityRoot);
  assert.match(signed.mac, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(connectorLocalActivationDigest(signed.record).length, 64);
  const result = verifyConnectorLocalActivation(signed, context());
  assert.equal(result.verified, true);
  if (!result.verified) return;
  assert.equal(result.digest, connectorLocalActivationDigest(record()).toString('base64url'));
  assert.equal(Object.isFrozen(result.record.activations[0]), true);
});

test('local parser rejects extra keys, unsafe integers, invalid ISO/channel/digest and lifecycle operations', () => {
  const invalid = [
    { ...record(), extra: true }, { ...record(), recordRevision: -0 },
    { ...record(), policyEpoch: 1.5 }, { ...record(), writerEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...record(), issuedAt: '2026-02-30T00:00:00.000Z' },
    { ...record(), globalPackChannel: 'fork:' }, { ...record(), globalPackDigest: 'x'.repeat(43) },
    { ...record(), activations: [{ ...record().activations[0], operation: 'grant.remove' }] },
    { ...record(), activations: [{ ...record().activations[0], profileRevision: 0 }] },
    { ...record(), activations: [{ ...record().activations[0], surprise: true }] },
  ];
  for (const candidate of invalid) assert.equal(parseConnectorLocalActivationRecord(candidate), null);
});

test('MAC tampering and short authority fail closed before record bindings', () => {
  const signed = signConnectorLocalActivation(record(), authorityRoot);
  assert.deepEqual(verifyConnectorLocalActivation({ ...signed, mac: `${signed.mac.slice(0, 42)}A` },
    context()), { verified: false, reason: 'mac_invalid' });
  const tampered = { ...signed, record: { ...signed.record, installationId: 'other' } };
  assert.deepEqual(verifyConnectorLocalActivation(tampered, context()),
    { verified: false, reason: 'mac_invalid' });
  assert.deepEqual(verifyConnectorLocalActivation(signed, context({ authorityRoot: Buffer.alloc(16) })),
    { verified: false, reason: 'verification_context_invalid' });
});

test('every local/global/policy binding and record rollback is rejected after authentic MAC', () => {
  const cases: readonly [Partial<ConnectorLocalActivationRecord>, Partial<ConnectorLocalActivationVerificationContext>, string][] = [
    [{ installationId: 'other' }, {}, 'installationId_mismatch'],
    [{ policyEpoch: 3 }, {}, 'policyEpoch_mismatch'], [{ writerEpoch: 4 }, {}, 'writerEpoch_mismatch'],
    [{ originRevision: 1 }, {}, 'originRevision_mismatch'],
    [{ globalPackIssuerId: 'other' }, {}, 'globalPackIssuerId_mismatch'],
    [{ globalPackChannel: 'preview' }, {}, 'globalPackChannel_mismatch'],
    [{ globalPackSequence: 7 }, {}, 'globalPackSequence_mismatch'],
    [{ globalPackDigest: 'x'.repeat(86) }, {}, 'globalPackDigest_mismatch'],
    [{ trustBundleRevision: 3 }, {}, 'trustBundleRevision_mismatch'],
    [{ recordRevision: 2 }, { minimumRecordRevision: 3 }, 'record_revision_rollback'],
  ];
  for (const [recordOverride, contextOverride, reason] of cases) {
    const candidate = record(recordOverride);
    assert.deepEqual(verifyConnectorLocalActivation(signConnectorLocalActivation(candidate, authorityRoot),
      context(contextOverride)), { verified: false, reason });
  }
});

test('caller mutation cannot alter the verified owned local record', () => {
  const signed = structuredClone(signConnectorLocalActivation(record(), authorityRoot));
  const result = verifyConnectorLocalActivation(signed, context());
  (signed.record as { recordRevision: number }).recordRevision = 99;
  assert.equal(result.verified, true);
  if (result.verified) assert.equal(result.record.recordRevision, 3);
});

const eligibility = (
  overrides: Partial<ConnectorFoundationEligibilityInput> = {},
): ConnectorFoundationEligibilityInput => ({
  operation: ConnectorPolicyOperation.CredentialUse, providerId: 'github', serviceId: 'github',
  foundationQuarantined: false, globalKilled: false, providerKilled: false,
  serviceOperationKilled: false, globalPack: verifiedPack(),
  localActivation: verifyConnectorLocalActivation(signConnectorLocalActivation(record(), authorityRoot), context()),
  profileReady: true, grantReady: true, verificationReady: true, ...overrides,
});

test('D9 deny precedence is exact and strongest denial wins', () => {
  const ordered: readonly [Partial<ConnectorFoundationEligibilityInput>, string][] = [
    [{ foundationQuarantined: true, globalKilled: true }, 'foundation_quarantined'],
    [{ globalKilled: true, providerKilled: true }, 'global_killed'],
    [{ providerKilled: true, serviceOperationKilled: true }, 'provider_killed'],
    [{ serviceOperationKilled: true, globalPack: { verified: false, reason: 'bad' } }, 'service_operation_killed'],
    [{ globalPack: { verified: false, reason: 'bad' } }, 'pack_invalid'],
    [{ globalPack: verifiedPack('suspended') }, 'pack_suspended'],
    [{ serviceId: 'other' }, 'pack_uncertified'],
    [{ localActivation: { verified: false, reason: 'bad' }, profileReady: false }, 'local_disabled'],
    [{ profileReady: false, grantReady: false }, 'profile_unready'],
    [{ grantReady: false, verificationReady: false }, 'grant_unready'],
    [{ verificationReady: false }, 'verification_unready'],
  ];
  for (const [override, reason] of ordered) assert.deepEqual(
    decideConnectorFoundationEligibility(eligibility(override)), { eligible: false, reason });
  assert.deepEqual(decideConnectorFoundationEligibility(eligibility()), { eligible: true, reason: 'eligible' });
});

test('local disabled wins over enabled duplicate while lifecycle safety operations are always allowed', () => {
  const disabledRecord = record({ activations: [record().activations[0],
    { ...record().activations[0], enabled: false }] });
  const localActivation = verifyConnectorLocalActivation(
    signConnectorLocalActivation(disabledRecord, authorityRoot), context());
  assert.deepEqual(decideConnectorFoundationEligibility(eligibility({ localActivation })),
    { eligible: false, reason: 'local_disabled' });
  for (const operation of [ConnectorPolicyOperation.GrantList, ConnectorPolicyOperation.GrantRemove,
    ConnectorPolicyOperation.TokenRevoke, ConnectorPolicyOperation.CredentialDelete,
    ConnectorPolicyOperation.PlacementRemove]) {
    assert.deepEqual(decideConnectorFoundationEligibility(eligibility({ operation,
      foundationQuarantined: true, globalKilled: true, providerKilled: true,
      serviceOperationKilled: true, globalPack: { verified: false, reason: 'bad' },
      localActivation: { verified: false, reason: 'bad' }, profileReady: false,
      grantReady: false, verificationReady: false })), { eligible: true, reason: 'safety_operation' });
  }
});

test('D9 independently binds an authenticated local record to the selected global pack', () => {
  const mismatchedPack = { ...verifiedPack(), digest: 'x'.repeat(86) } as ConnectorGlobalPackVerification;
  assert.deepEqual(decideConnectorFoundationEligibility(eligibility({ globalPack: mismatchedPack })),
    { eligible: false, reason: 'local_disabled' });
});
