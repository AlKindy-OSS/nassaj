import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import {
  canonicalJson,
  certificationBindingForPolicy,
  CONNECTOR_CERTIFICATION_DOMAIN,
  connectorCertificationDigest,
  MemoryCertificationSequenceStore,
  parseConnectorCertificationManifest,
  verifyConnectorCertificationManifest,
  type CertificationVerificationContext,
  type ConnectorCertificationManifest,
} from './connector-certification-manifest.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';

const DIGESTS = { registryDigest: 'r'.repeat(43), operationsDigest: 'o'.repeat(43),
  capabilityDigest: 'c'.repeat(43), shapeDigest: 's'.repeat(43), contractDigest: 'd'.repeat(43) };
const keyA = generateKeyPairSync('ed25519');
const keyB = generateKeyPairSync('ed25519');

const manifest = (sequence = 1): ConnectorCertificationManifest => ({
  schemaVersion: 1, domain: CONNECTOR_CERTIFICATION_DOMAIN, installationId: 'install-1', sequence,
  issuedAt: '2026-08-26T00:00:00.000Z', expiresAt: '2026-08-26T01:00:00.000Z',
  originRevision: 1, registryRevision: 'registry-1', registryDigest: DIGESTS.registryDigest,
  operationsRevision: 'operations-1', operationsDigest: DIGESTS.operationsDigest,
  capabilityRevision: 'capability-1', capabilityDigest: DIGESTS.capabilityDigest,
  signingKeyId: 'root-a', certifications: [{ providerId: 'github', serviceId: 'github',
    shapeRevision: 1, shapeDigest: DIGESTS.shapeDigest, contractRevision: 1,
    contractDigest: DIGESTS.contractDigest,
    operations: [ConnectorPolicyOperation.CredentialVerify, ConnectorPolicyOperation.CredentialUse] }],
});

const envelope = (payload = manifest(), privateKey = keyA.privateKey) => ({ manifest: payload,
  signature: sign(null, connectorCertificationDigest(payload), privateKey).toString('base64url') });

const context = (overrides: Partial<CertificationVerificationContext> = {}): CertificationVerificationContext => ({
  installationId: 'install-1', originRevision: 1, registryRevision: 'registry-1',
  registryDigest: DIGESTS.registryDigest, operationsRevision: 'operations-1',
  operationsDigest: DIGESTS.operationsDigest, capabilityRevision: 'capability-1',
  capabilityDigest: DIGESTS.capabilityDigest, now: new Date('2026-08-26T00:30:00.000Z'),
  clockSkewMs: 30_000, minimumTrustBundleRevision: 2,
  sequenceStore: new MemoryCertificationSequenceStore(), trustBundle: {
    revision: 2, revokedKeyIds: new Set(), roots: [{ keyId: 'root-a', algorithm: 'Ed25519',
      publicKeyPem: keyA.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z' },
    { keyId: 'root-b', algorithm: 'Ed25519',
      publicKeyPem: keyB.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z' }] },
  ...overrides,
});

const requirement = () => ({ providerId: 'github', serviceId: 'github', shapeRevision: 1,
  shapeDigest: DIGESTS.shapeDigest, contractRevision: 1, contractDigest: DIGESTS.contractDigest,
  operation: ConnectorPolicyOperation.CredentialUse });

test('canonical serialization is order-invariant and rejects noncanonical numbers', () => {
  assert.equal(canonicalJson({ z: [3, { b: true, a: 'x' }], a: 1 }),
    canonicalJson({ a: 1, z: [3, { a: 'x', b: true }] }));
  assert.throws(() => canonicalJson({ bad: 1.5 }), /noncanonical/u);
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /noncanonical/u);
  assert.throws(() => canonicalJson({ bad: undefined }), /noncanonical/u);
});

test('valid Ed25519 manifest binds every policy and contract revision digest', async () => {
  const result = await verifyConnectorCertificationManifest(envelope(), context());
  assert.equal(result.verified, true);
  if (!result.verified) return;
  const bound = certificationBindingForPolicy(result, requirement());
  assert.ok(bound);
  assert.deepEqual({ registryRevision: bound.registryRevision,
    registryDigest: bound.registryDigest,
    operationsRevision: bound.operationsRevision, operationsDigest: bound.operationsDigest,
    capabilityRevision: bound.capabilityRevision, capabilityDigest: bound.capabilityDigest,
    shapeDigest: bound.shapeDigest, contractDigest: bound.contractDigest }, {
    registryRevision: 'registry-1', registryDigest: DIGESTS.registryDigest,
    operationsRevision: 'operations-1',
    operationsDigest: DIGESTS.operationsDigest, capabilityRevision: 'capability-1',
    capabilityDigest: DIGESTS.capabilityDigest, shapeDigest: DIGESTS.shapeDigest,
    contractDigest: DIGESTS.contractDigest });
  assert.equal(certificationBindingForPolicy(result,
    { ...requirement(), contractDigest: 'x'.repeat(43) }), null);
});

test('manifest parser strictly validates calendar dates, TTL, integer revisions, and string operations', () => {
  const invalid = [
    { ...manifest(), issuedAt: '2026-02-30T00:00:00.000Z' },
    { ...manifest(), expiresAt: '2026-09-03T00:00:00.001Z' },
    { ...manifest(), originRevision: Number.NaN }, { ...manifest(), sequence: 1.5 },
    { ...manifest(), registryDigest: 'x'.repeat(86) },
    { ...manifest(), certifications: [{ ...manifest().certifications[0], operations: [{}] }] },
    { ...manifest(), certifications: [{ ...manifest().certifications[0], operations: ['grant.remove'] }] },
    { ...manifest(), surprise: true },
  ];
  for (const payload of invalid) assert.equal(parseConnectorCertificationManifest(payload), null);
});

test('all origin/registry/operations/capability binding drift fails closed', async () => {
  const cases: readonly [Partial<CertificationVerificationContext>, string][] = [
    [{ originRevision: 2 }, 'origin_revision_mismatch'],
    [{ registryRevision: 'registry-2' }, 'registry_revision_mismatch'],
    [{ registryDigest: 'x'.repeat(43) }, 'registry_digest_mismatch'],
    [{ operationsRevision: 'operations-2' }, 'operations_revision_mismatch'],
    [{ operationsDigest: 'x'.repeat(43) }, 'operations_digest_mismatch'],
    [{ capabilityRevision: 'capability-2' }, 'capability_revision_mismatch'],
    [{ capabilityDigest: 'x'.repeat(43) }, 'capability_digest_mismatch'],
  ];
  for (const [override, reason] of cases) assert.deepEqual(
    await verifyConnectorCertificationManifest(envelope(), context(override)),
    { verified: false, reason });
});

test('signature, replay, expiry, skew, trust rotation and revocation fail closed', async () => {
  assert.deepEqual(await verifyConnectorCertificationManifest(envelope(manifest(), keyB.privateKey), context()),
    { verified: false, reason: 'signature_invalid' });
  const sequenceStore = new MemoryCertificationSequenceStore();
  const replayContext = context({ sequenceStore });
  assert.equal((await verifyConnectorCertificationManifest(envelope(manifest(10)), replayContext)).verified, true);
  assert.deepEqual(await verifyConnectorCertificationManifest(envelope(manifest(10)), replayContext),
    { verified: false, reason: 'sequence_replayed' });
  assert.deepEqual(await verifyConnectorCertificationManifest(envelope(),
    context({ now: new Date('2026-08-26T01:00:31.000Z') })), { verified: false, reason: 'manifest_expired' });
  assert.deepEqual(await verifyConnectorCertificationManifest(envelope(),
    context({ clockSkewMs: Number.NaN })), { verified: false, reason: 'clock_skew_invalid' });
  const rotated = { ...manifest(2), signingKeyId: 'root-b' };
  assert.equal((await verifyConnectorCertificationManifest(envelope(rotated, keyB.privateKey), context())).verified, true);
  assert.deepEqual(await verifyConnectorCertificationManifest(envelope(), context({
    trustBundle: { ...context().trustBundle, revokedKeyIds: new Set(['root-a']) },
  })), { verified: false, reason: 'trust_root_unavailable' });
  assert.deepEqual(await verifyConnectorCertificationManifest(envelope(), context({
    trustBundle: { ...context().trustBundle, revision: 1 },
  })), { verified: false, reason: 'trust_bundle_revision_rollback' });
  const lateRoot = context().trustBundle.roots.map(root => root.keyId === 'root-a'
    ? { ...root, validFrom: '2026-08-26T00:10:00.000Z' } : root);
  assert.deepEqual(await verifyConnectorCertificationManifest(envelope(), context({
    trustBundle: { ...context().trustBundle, roots: lateRoot },
  })), { verified: false, reason: 'trust_root_unavailable' },
  'root must be valid both when issued and when verified');
});

test('malformed verification context and sequence-store outage fail closed without throwing', async () => {
  assert.deepEqual(await verifyConnectorCertificationManifest(envelope(), context({
    trustBundle: { ...context().trustBundle, roots: null as unknown as [] },
  })), { verified: false, reason: 'trust_root_unavailable' });
  assert.deepEqual(await verifyConnectorCertificationManifest(envelope(), context({
    sequenceStore: { accept: async () => { throw new Error('offline'); } },
  })), { verified: false, reason: 'sequence_store_unavailable' });
});

test('verifier owns and deep-freezes manifest across asynchronous sequence acceptance', async () => {
  let release: (() => void) | undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const sequenceStore = { accept: async () => { await barrier; return true; } };
  const payload = manifest();
  const signed = envelope(payload);
  const mutableContext = context({ sequenceStore });
  const pending = verifyConnectorCertificationManifest(signed, mutableContext);
  (signed.manifest as { registryRevision: string }).registryRevision = 'attacker';
  (mutableContext.trustBundle as { revision: number }).revision = 99;
  release?.();
  const result = await pending;
  assert.equal(result.verified, true);
  if (!result.verified) return;
  assert.equal(result.manifest.registryRevision, 'registry-1');
  assert.equal(result.trustBundleRevision, 2);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.manifest), true);
  assert.equal(Object.isFrozen(result.manifest.certifications), true);
  assert.equal(Object.isFrozen(result.manifest.certifications[0]), true);
});

test('unsigned development input has no certification binding', () => {
  assert.equal(certificationBindingForPolicy(null, requirement()), null);
});
