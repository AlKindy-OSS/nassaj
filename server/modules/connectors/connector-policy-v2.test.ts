import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureConnectorPolicySnapshot,
  ConnectorPolicyCapability,
  ConnectorPolicyOperation,
  connectorOperationKilled,
  consumeConnectorPolicyCapability,
  issueConnectorPolicyCapability,
  KILLABLE_CONNECTOR_OPERATIONS,
  LIFECYCLE_CONNECTOR_OPERATIONS,
  MemoryConnectorPolicyStore,
  resolveConnectorPolicy,
  validateConnectorKillRules,
  type ConnectorCertificationBinding,
  type ConnectorKillRules,
  type ConnectorPolicyBinding,
  type ConnectorPolicyState,
} from './connector-policy-v2.js';

const MANIFEST_DIGEST = 'm'.repeat(86);
const binding = (operation = ConnectorPolicyOperation.CredentialUse): ConnectorPolicyBinding => ({
  installationId: 'install-1', userId: 7, ownership: 'personal', providerId: 'github',
  serviceId: 'github', accountId: 'account-1', grantId: 'grant-1',
  consumerBody: 'codex-1', operation,
});

const certification = (): ConnectorCertificationBinding => ({
  certified: true, providerId: 'github', serviceId: 'github',
  operation: ConnectorPolicyOperation.CredentialUse,
  manifestSequence: 8, manifestDigest: MANIFEST_DIGEST, originRevision: 1,
  registryRevision: 'registry-1', registryDigest: 'r'.repeat(43),
  operationsRevision: 'operations-1',
  operationsDigest: 'o'.repeat(43), capabilityRevision: 'capability-1',
  capabilityDigest: 'c'.repeat(43), shapeRevision: 1, shapeDigest: 's'.repeat(43),
  contractRevision: 1, contractDigest: 'd'.repeat(43),
});

const rules = (mutation: Partial<ConnectorKillRules> = {}): ConnectorKillRules => ({
  global: false, providers: [], serviceOperations: [], ...mutation,
});

const state = (mutation: Partial<ConnectorPolicyState> = {}): ConnectorPolicyState => ({
  policySchemaVersion: 2, policyEpoch: 1, registryRevision: 'registry-1',
  certificationManifestDigest: MANIFEST_DIGEST,
  installationMode: 'portable_default', originRevision: 1, killRevision: 0,
  writerEpoch: 1, kills: rules(), ...mutation,
});

const storeFixture = (): MemoryConnectorPolicyStore => new MemoryConnectorPolicyStore({
  installationId: 'install-1', state: state(),
});

const decisionFixture = async (store: MemoryConnectorPolicyStore, operation = ConnectorPolicyOperation.CredentialUse) => {
  const current = await store.read('install-1');
  const snapshot = captureConnectorPolicySnapshot(current,
    new Date('2026-08-26T00:00:00.000Z'));
  assert.ok(snapshot);
  const certified = { ...certification(), operation };
  return { binding: binding(operation), certification: certified, decision: resolveConnectorPolicy({
    snapshot, binding: binding(operation), certification: certified, kills: current.kills,
  }) };
};

test('PolicySnapshot has exactly the nine ADR fields and is deeply immutable', () => {
  const snapshot = captureConnectorPolicySnapshot(state(),
    new Date('2026-08-26T00:00:00.000Z'));
  assert.ok(snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'capturedAt', 'certificationManifestDigest', 'installationMode', 'killRevision',
    'originRevision', 'policyEpoch', 'policySchemaVersion', 'registryRevision', 'writerEpoch',
  ]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(captureConnectorPolicySnapshot(state(), new Date(Number.NaN)), null);
});

test('operation dictionary is exact: eight killable and five lifecycle operations', () => {
  assert.deepEqual(KILLABLE_CONNECTOR_OPERATIONS, [
    'profile.configure', 'grant.create', 'oauth.start', 'credential.verify',
    'credential.store_unverified', 'credential.use', 'token.refresh', 'placement.write',
  ]);
  assert.deepEqual(LIFECYCLE_CONNECTOR_OPERATIONS,
    ['grant.list', 'grant.remove', 'token.revoke', 'credential.delete', 'placement.remove']);
  assert.equal(new Set(Object.values(ConnectorPolicyOperation)).size, 13);
});

test('kill hierarchy is global, provider, then service×operation with strongest deny', () => {
  const target = binding();
  const cases = [
    rules({ global: true }), rules({ providers: ['github'] }),
    rules({ serviceOperations: [{ serviceId: 'github', operation: ConnectorPolicyOperation.CredentialUse }] }),
  ];
  for (const killRules of cases) assert.equal(connectorOperationKilled(killRules, target), true);
  assert.equal(connectorOperationKilled(rules({ providers: ['stripe'] }), target), false);
  assert.equal(connectorOperationKilled(rules({ serviceOperations: [{
    serviceId: 'github', operation: ConnectorPolicyOperation.CredentialVerify,
  }] }), target), false, 'service kill is operation-specific');
});

test('lifecycle operations cannot be killed, while malformed policy denies external operations', () => {
  const malformed = { global: true, providers: ['bad provider'], serviceOperations: [{
    serviceId: 'github', operation: 'grant.remove',
  }] } as unknown as ConnectorKillRules;
  assert.equal(validateConnectorKillRules(malformed), false);
  assert.equal(connectorOperationKilled(malformed, binding()), true);
  for (const operation of LIFECYCLE_CONNECTOR_OPERATIONS) {
    assert.equal(connectorOperationKilled(malformed, binding(operation)), false, operation);
  }
});

test('kill denial has precedence over missing or invalid certification', () => {
  const snapshot = captureConnectorPolicySnapshot(state(), new Date('2026-08-26T00:00:00.000Z'));
  assert.ok(snapshot);
  const result = resolveConnectorPolicy({ snapshot, binding: binding(),
    certification: { ...certification(), certified: false }, kills: rules({ global: true }) });
  assert.equal(result.reason, 'policy_killed');
});

test('resolver rejects malformed ownership, NaN user, invalid dates, and certification drift', () => {
  const snapshot = captureConnectorPolicySnapshot(state(),
    new Date('2026-08-26T00:00:00.000Z'));
  assert.ok(snapshot);
  for (const invalidBinding of [
    { ...binding(), ownership: 'owner' as 'personal' }, { ...binding(), userId: Number.NaN },
  ]) assert.equal(resolveConnectorPolicy({ snapshot, binding: invalidBinding,
    certification: certification(), kills: rules() }).reason, 'binding_invalid');
  assert.equal(resolveConnectorPolicy({ snapshot: { ...snapshot, capturedAt: '2026-02-30T00:00:00.000Z' },
    binding: binding(), certification: certification(), kills: rules() }).reason, 'snapshot_invalid');
  assert.equal(resolveConnectorPolicy({ snapshot, binding: binding(),
    certification: { ...certification(), originRevision: 2 }, kills: rules() }).reason,
  'certification_mismatch');
});

test('capability is opaque, nonserializable, and atomically one-use', async () => {
  const store = storeFixture();
  const fixture = await decisionFixture(store);
  const capability = await issueConnectorPolicyCapability(fixture.decision, fixture.binding,
    fixture.certification, store, { now: new Date('2026-08-26T00:00:00.000Z'),
      ttlMs: 5_000, nonce: 'nonce-1' });
  assert.ok(capability instanceof ConnectorPolicyCapability);
  assert.deepEqual(Object.keys(capability), []);
  assert.throws(() => JSON.stringify(capability), /not_serializable/u);
  assert.equal(await consumeConnectorPolicyCapability(capability, fixture.binding, store,
    new Date('2026-08-26T00:00:01.000Z')), true);
  assert.equal(await consumeConnectorPolicyCapability(capability, fixture.binding, store,
    new Date('2026-08-26T00:00:02.000Z')), false);
});

test('atomic consume rejects and burns capability after any current revision change', async () => {
  const store = storeFixture();
  const fixture = await decisionFixture(store);
  const capability = await issueConnectorPolicyCapability(fixture.decision, fixture.binding,
    fixture.certification, store, { now: new Date('2026-08-26T00:00:00.000Z'), ttlMs: 5_000 });
  assert.ok(capability);
  await store.replace('install-1', state(), state({ policyEpoch: 2, writerEpoch: 2 }));
  assert.equal(await consumeConnectorPolicyCapability(capability, fixture.binding, store,
    new Date('2026-08-26T00:00:01.000Z')), false);
  assert.equal(await consumeConnectorPolicyCapability(capability, fixture.binding, store,
    new Date('2026-08-26T00:00:02.000Z')), false);
});

test('concurrent capability consumption has exactly one transaction winner', async () => {
  const store = storeFixture();
  const fixture = await decisionFixture(store);
  const capability = await issueConnectorPolicyCapability(fixture.decision, fixture.binding,
    fixture.certification, store, { now: new Date('2026-08-26T00:00:00.000Z'), ttlMs: 5_000 });
  assert.ok(capability);
  const results = await Promise.all([0, 1].map(() => consumeConnectorPolicyCapability(
    capability, fixture.binding, store, new Date('2026-08-26T00:00:01.000Z'))));
  assert.deepEqual(results.sort(), [false, true]);
});

test('capability cannot be consumed before its issuedAt and mismatch burns it', async () => {
  const store = storeFixture();
  const fixture = await decisionFixture(store);
  const capability = await issueConnectorPolicyCapability(fixture.decision, fixture.binding,
    fixture.certification, store, { now: new Date('2026-08-26T00:10:00.000Z'), ttlMs: 5_000 });
  assert.ok(capability);
  assert.equal(await consumeConnectorPolicyCapability(capability, fixture.binding, store,
    new Date('2026-08-26T00:09:59.999Z')), false);
  assert.equal(await consumeConnectorPolicyCapability(capability, fixture.binding, store,
    new Date('2026-08-26T00:10:01.000Z')), false);
});

test('capability cannot authorize a different consumer body or operation and burns on mismatch', async () => {
  for (const expected of [
    { ...binding(), consumerBody: 'claude-1' },
    { ...binding(), operation: ConnectorPolicyOperation.PlacementWrite },
  ]) {
    const store = storeFixture();
    const fixture = await decisionFixture(store);
    const capability = await issueConnectorPolicyCapability(fixture.decision, fixture.binding,
      fixture.certification, store, { now: new Date('2026-08-26T00:00:00.000Z'), ttlMs: 5_000 });
    assert.ok(capability);
    assert.equal(await consumeConnectorPolicyCapability(capability, expected, store,
      new Date('2026-08-26T00:00:01.000Z')), false);
    assert.equal(await consumeConnectorPolicyCapability(capability, fixture.binding, store,
      new Date('2026-08-26T00:00:02.000Z')), false);
  }
});

test('decision cannot issue a capability for a different binding or revision digest', async () => {
  const store = storeFixture();
  const fixture = await decisionFixture(store);
  assert.equal(await issueConnectorPolicyCapability(fixture.decision,
    { ...fixture.binding, accountId: 'account-2' }, fixture.certification, store,
    { now: new Date('2026-08-26T00:00:00.000Z'), ttlMs: 5_000 }), null);
  assert.equal(await issueConnectorPolicyCapability(fixture.decision, fixture.binding,
    { ...fixture.certification, shapeDigest: 'x'.repeat(43) }, store,
    { now: new Date('2026-08-26T00:00:00.000Z'), ttlMs: 5_000 }), null);
});

test('kill rules and epochs update in one CAS transaction with no separate advance API', async () => {
  const store = storeFixture();
  const killed = state({ writerEpoch: 2, killRevision: 1,
    kills: rules({ providers: ['github'] }) });
  assert.deepEqual(await store.replace('install-1', state(), killed), killed);
  await assert.rejects(store.replace('install-1', state(), state({ writerEpoch: 3 })),
    /revision_conflict/u);
  assert.equal('advanceEpoch' in store, false);
  assert.equal('advanceKillRevision' in store, false);
});

test('malformed replacement state and non-monotonic epochs fail closed', async () => {
  const store = storeFixture();
  for (const replacement of [
    state({ policyEpoch: Number.NaN, writerEpoch: 2 }), state({ writerEpoch: 1 }),
    state({ writerEpoch: 2, kills: { ...rules(), providers: ['bad provider'] } }),
  ]) await assert.rejects(store.replace('install-1', state(), replacement), /revision_conflict/u);
});
