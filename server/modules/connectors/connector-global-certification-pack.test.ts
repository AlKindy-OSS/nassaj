import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import {
  CONNECTOR_GLOBAL_PACK_DOMAIN, connectorGlobalPackDigest, connectorGlobalPackSignedBytes,
  decideConnectorGlobalCertification, effectiveConnectorGlobalCertifications,
  parseConnectorGlobalCertificationPack,
  verifyConnectorGlobalCertificationPack, type ConnectorGlobalCertificationPack,
  type ConnectorGlobalPackVerificationContext,
} from './connector-global-certification-pack.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';
import { connectorJcs } from './connector-jcs.js';
import { CONNECTOR_RUNTIME_MANIFEST,
  CONNECTOR_RUNTIME_PACK_EXPECTATIONS } from './connector-runtime-manifest.js';
import type { ConnectorTrustBundle } from './connector-trust-bundle.js';

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const digests = { registry: 'r'.repeat(43), operations: 'o'.repeat(43), capability: 'c'.repeat(43),
  shape: 's'.repeat(43), contract: 'd'.repeat(43) };

const pack = (overrides: Partial<ConnectorGlobalCertificationPack> = {}): ConnectorGlobalCertificationPack => ({
  schemaVersion: 1, domain: CONNECTOR_GLOBAL_PACK_DOMAIN, issuerId: 'nassaj-oss', channel: 'stable',
  sequence: 8, issuedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-31T00:00:00.000Z',
  minimumRuntimeFloor: 1, maximumPolicySchemaVersion: 2, registryRevision: 'registry-2',
  registryDigest: digests.registry, operationsRevision: 'operations-2',
  operationsDigest: digests.operations, capabilityRevision: 'capability-2',
  capabilityDigest: digests.capability, signingKeyId: 'root-1', certifications: [{
    providerId: 'github', serviceId: 'github', operation: ConnectorPolicyOperation.CredentialUse,
    authMethod: 'api_key', shapeRevision: 1, shapeDigest: digests.shape, contractRevision: 1,
    contractDigest: digests.contract, status: 'certified',
  }], ...overrides,
});

const trustBundle = (): ConnectorTrustBundle => ({ schemaVersion: 1, revision: 4,
  distributionIssuerId: 'nassaj-oss', revokedKeyIds: [], roots: [{ issuerId: 'nassaj-oss',
    keyId: 'root-1', algorithm: 'Ed25519', publicKeyPem: keys.publicKey
      .export({ type: 'spki', format: 'pem' }).toString(), validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z', source: 'distribution' }] });

const envelope = (candidate = pack(), privateKey = keys.privateKey) => ({ pack: candidate,
  signature: sign(null, connectorGlobalPackSignedBytes(candidate), privateKey).toString('base64url') });

const context = (overrides: Partial<ConnectorGlobalPackVerificationContext> = {}): ConnectorGlobalPackVerificationContext => ({
  now: new Date('2026-08-15T00:00:00.000Z'), wallClockHighWaterMs: Date.parse('2026-08-14T00:00:00.000Z'),
  priorSequence: 7, minimumTrustBundleRevision: 4, runtimeFloor: 1, policySchemaVersion: 2,
  trustBundle: trustBundle(),
  expectedRegistryRevision: 'registry-2', expectedRegistryDigest: digests.registry,
  expectedOperationsRevision: 'operations-2', expectedOperationsDigest: digests.operations,
  expectedCapabilityRevision: 'capability-2', expectedCapabilityDigest: digests.capability,
  ...overrides,
});

test('global pack verifies Ed25519 over prefixed JCS bytes and returns SHA-512 digest/state', () => {
  const result = verifyConnectorGlobalCertificationPack(envelope(), context());
  assert.equal(result.verified, true);
  if (!result.verified) return;
  assert.equal(result.digest, connectorGlobalPackDigest(pack()).toString('base64url'));
  assert.equal(result.acceptedSequenceScope, 'nassaj-oss\0stable');
  assert.equal(result.acceptedSequence, 8);
  assert.equal(result.wallClockHighWaterMs, context().now.getTime());
  assert.equal(Object.isFrozen(result.pack.certifications[0]), true);
});

test('pack parser rejects extra keys, unsafe integers, noncanonical dates, bad TTL/channel/digests', () => {
  const invalid = [
    { ...pack(), surprise: true }, { ...pack(), sequence: -0 }, { ...pack(), sequence: 1.5 },
    { ...pack(), sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...pack(), issuedAt: '2026-02-30T00:00:00.000Z' },
    { ...pack(), expiresAt: '2026-09-01T00:00:00.001Z' },
    { ...pack(), channel: 'fork:' }, { ...pack(), registryDigest: 'x'.repeat(86) },
    { ...pack(), certifications: [{ ...pack().certifications[0], operation: 'grant.remove' }] },
    { ...pack(), certifications: [{ ...pack().certifications[0], extra: true }] },
  ];
  for (const candidate of invalid) assert.equal(parseConnectorGlobalCertificationPack(candidate), null);
  assert.equal(parseConnectorGlobalCertificationPack(connectorJcs(pack()).replace(
    '"channel":"stable"', '"channel":"stable","channel":"preview"')), null);
  assert.ok(parseConnectorGlobalCertificationPack(pack({ channel: 'preview',
    expiresAt: '2026-09-15T00:00:00.000Z' })));
  assert.equal(parseConnectorGlobalCertificationPack(pack({ channel: 'preview',
    expiresAt: '2026-09-15T00:00:00.001Z' })), null);
});

test('signature, issuer/key trust, revocation, bundle rollback and signature shape fail closed', () => {
  assert.deepEqual(verifyConnectorGlobalCertificationPack(envelope(pack(), otherKeys.privateKey), context()),
    { verified: false, reason: 'signature_invalid' });
  assert.deepEqual(verifyConnectorGlobalCertificationPack(envelope(), context({ trustBundle: {
    ...trustBundle(), revokedKeyIds: ['root-1'],
  } })), { verified: false, reason: 'trust_root_unavailable' });
  assert.deepEqual(verifyConnectorGlobalCertificationPack(envelope(), context({
    minimumTrustBundleRevision: 5,
  })), { verified: false, reason: 'trust_bundle_revision_rollback' });
  assert.deepEqual(verifyConnectorGlobalCertificationPack({ ...envelope(), signature: 'bad' }, context()),
    { verified: false, reason: 'signature_invalid' });
  assert.deepEqual(verifyConnectorGlobalCertificationPack(envelope(pack({ issuerId: 'attacker' })), context()),
    { verified: false, reason: 'trust_root_unavailable' });
});

test('sequence, strict expiry, future skew, clock rollback, runtime and policy floors fail closed', () => {
  const cases: readonly [Partial<ConnectorGlobalPackVerificationContext>, string][] = [
    [{ priorSequence: 8 }, 'sequence_replayed'],
    [{ now: new Date('2026-08-31T00:00:00.000Z') }, 'pack_expired'],
    [{ now: new Date('2026-07-31T23:54:59.999Z'), wallClockHighWaterMs: 0 }, 'pack_not_yet_valid'],
    [{ now: new Date('2026-08-13T23:54:59.999Z') }, 'clock_untrusted'],
    [{ runtimeFloor: 0 }, 'verification_context_invalid'],
    [{ policySchemaVersion: 3 }, 'policy_schema_unsupported'],
  ];
  for (const [override, reason] of cases) assert.deepEqual(
    verifyConnectorGlobalCertificationPack(envelope(), context(override)), { verified: false, reason });
  assert.deepEqual(verifyConnectorGlobalCertificationPack(envelope(pack({ minimumRuntimeFloor: 2 })), context()),
    { verified: false, reason: 'runtime_floor_unsupported' });
});

test('sequence is scoped by caller to issuer/channel and mutation cannot race verification', () => {
  assert.equal(verifyConnectorGlobalCertificationPack(envelope(pack({ channel: 'preview' })),
    context({ priorSequence: 0 })).verified, true, 'a separate channel has an independent prior sequence');
  const signed = envelope();
  const verificationContext = context();
  const result = verifyConnectorGlobalCertificationPack(signed, verificationContext);
  (signed.pack as { sequence: number }).sequence = 999;
  verificationContext.now.setUTCFullYear(2030);
  assert.equal(result.verified, true);
  if (result.verified) assert.equal(result.pack.sequence, 8);
});

test('pack is bound to exact binary registry, operations, and capability revisions and digests', () => {
  const exact = pack({ registryRevision: CONNECTOR_RUNTIME_MANIFEST.registryRevision,
    registryDigest: CONNECTOR_RUNTIME_MANIFEST.registryDigest,
    operationsRevision: CONNECTOR_RUNTIME_MANIFEST.operationsRevision,
    operationsDigest: CONNECTOR_RUNTIME_MANIFEST.operationsDigest,
    capabilityRevision: CONNECTOR_RUNTIME_MANIFEST.capabilityRevision,
    capabilityDigest: CONNECTOR_RUNTIME_MANIFEST.capabilityDigest });
  const exactContext = context(CONNECTOR_RUNTIME_PACK_EXPECTATIONS);
  assert.equal(verifyConnectorGlobalCertificationPack(envelope(exact), exactContext).verified, true);
  for (const [key, reason] of [
    ['registryDigest', 'registry_digest_mismatch'],
    ['operationsDigest', 'operations_digest_mismatch'],
    ['capabilityDigest', 'capability_digest_mismatch'],
  ] as const) {
    const candidate = { ...exact, [key]: 'x'.repeat(43) };
    assert.deepEqual(verifyConnectorGlobalCertificationPack(envelope(candidate), exactContext),
      { verified: false, reason });
  }
});

test('suspended certification wins over a simultaneous certified entry', () => {
  const suspended = { ...pack().certifications[0], status: 'suspended' as const };
  const candidate = pack({ certifications: [...pack().certifications, suspended] });
  const result = verifyConnectorGlobalCertificationPack(envelope(candidate), context());
  assert.equal(result.verified, true);
  assert.equal(decideConnectorGlobalCertification(result, 'github', 'github',
    ConnectorPolicyOperation.CredentialUse).status, 'suspended');
  assert.deepEqual(effectiveConnectorGlobalCertifications(candidate).map(item => item.status),
    ['suspended']);
  assert.equal(decideConnectorGlobalCertification(result, 'github', 'other',
    ConnectorPolicyOperation.CredentialUse).status, 'uncertified');
});
