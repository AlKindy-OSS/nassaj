import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthenticatedLaunchActor, LaunchActorError } from './actor.js';
import { createLaunchPermitBroker, LaunchPermitError, type LaunchPermitBinding } from './permit.js';

test('actor is server-shaped, frozen, and rejects platform and stale shapes', () => {
  const actor = createAuthenticatedLaunchActor({
    id: 7,
    role: 'admin',
    status: 'active',
    is_active: 1,
    authenticationKind: 'session',
    authorizationGeneration: 4,
  }, '2030-01-01T00:00:00.000Z');
  assert.deepEqual(actor, {
    userId: 7,
    principalId: 'user:7',
    authenticationKind: 'session',
    authorizationGeneration: 4,
    roles: ['admin'],
    authenticatedAt: '2030-01-01T00:00:00.000Z',
  });
  assert.equal(Object.isFrozen(actor), true);
  assert.throws(
    () => createAuthenticatedLaunchActor({ authenticationKind: 'platform_unverified' }),
    (error: unknown) => error instanceof LaunchActorError
      && error.code === 'PLATFORM_ACTOR_UNVERIFIED',
  );
  assert.throws(() => createAuthenticatedLaunchActor({
    id: 7, role: 'admin', authenticationKind: 'session', authorizationGeneration: 0,
  }), /ACTOR_AUTHORIZATION_GENERATION_INVALID/);
  assert.throws(() => createAuthenticatedLaunchActor({
    id: 7, role: 'admin', authenticationKind: 'ck', authorizationGeneration: 1,
  }), /ACTOR_CREDENTIAL_ID_REQUIRED/);
});

test('device principal becomes a launch actor without losing wallet fencing', () => {
  const actor = createAuthenticatedLaunchActor({
    id: 9,
    role: 'user',
    status: 'active',
    is_active: 1,
    authenticationKind: 'device_session',
    authorizationGeneration: 7,
    deviceSessionId: 'device_server_issued',
    slotId: 'slot_server_issued',
    deviceGeneration: 12,
  }, '2030-01-01T00:00:00.000Z');
  assert.deepEqual(actor, {
    userId: 9,
    principalId: 'user:9',
    authenticationKind: 'session',
    authorizationGeneration: 7,
    roles: ['user'],
    authenticatedAt: '2030-01-01T00:00:00.000Z',
    deviceSessionId: 'device_server_issued',
    slotId: 'slot_server_issued',
    deviceGeneration: 12,
  });
  assert.throws(() => createAuthenticatedLaunchActor({
    id: 9, role: 'user', authenticationKind: 'device_session', authorizationGeneration: 7,
  }), /ACTOR_DEVICE_BINDING_INVALID/);
});

const binding: LaunchPermitBinding = Object.freeze({
  decisionId: 'decision-1', leaseId: 'lease-1', userId: 7, authorizationGeneration: 4,
  provider: 'codex', body: 'codex', engine: 'sdk', entrypoint: 'ws.chat',
  purpose: 'sdk_turn', launchId: 'launch-1', sessionId: null,
  workspaceDigest: 'workspace-digest', contractVersion: 'permission-parity/v1',
  profileDigest: 'profile-digest', capabilityDigest: 'capability-digest',
  protocolGeneration: 1, expiresAtMs: 1_000,
});
const expectation = Object.freeze({
  userId: 7, authorizationGeneration: 4, provider: 'codex', body: 'codex', engine: 'sdk',
  entrypoint: 'ws.chat', purpose: 'sdk_turn' as const, launchId: 'launch-1', sessionId: null,
  workspaceDigest: 'workspace-digest', contractVersion: 'permission-parity/v1',
  profileDigest: 'profile-digest', capabilityDigest: 'capability-digest', protocolGeneration: 1,
});

test('permit is opaque, broker-bound, scope-bound, and single-use', () => {
  const first = createLaunchPermitBroker();
  const second = createLaunchPermitBroker();
  const permit = first.issuer.issue(binding);
  assert.equal(Object.getPrototypeOf(permit), null);
  assert.equal(JSON.stringify(permit), '{}');
  assert.throws(() => second.consumer.consume(permit, expectation, 10), /PERMIT_FORGED/);
  assert.throws(
    () => first.consumer.consume(permit, { ...expectation, provider: 'claude' }, 10),
    /PERMIT_SCOPE_MISMATCH/,
  );
  assert.equal(first.consumer.consume(permit, expectation, 10).decisionId, 'decision-1');
  assert.throws(() => first.consumer.consume(permit, expectation, 11), /PERMIT_REPLAYED/);
});

test('expiry and revocation fail before consumption', () => {
  const broker = createLaunchPermitBroker();
  const expired = broker.issuer.issue(binding);
  assert.throws(
    () => broker.consumer.consume(expired, expectation, 1_000),
    (error: unknown) => error instanceof LaunchPermitError && error.code === 'PERMIT_EXPIRED',
  );
  const revoked = broker.issuer.issue(binding);
  assert.equal(broker.issuer.revoke(revoked), true);
  assert.equal(broker.issuer.revoke(revoked), false);
  assert.throws(() => broker.consumer.consume(revoked, expectation, 10), /PERMIT_REVOKED/);
});
