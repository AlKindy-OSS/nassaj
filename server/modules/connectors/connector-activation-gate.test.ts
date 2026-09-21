import assert from 'node:assert/strict';
import test from 'node:test';

import { decideConnectorActivation } from './connector-activation-gate.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';

const base = { operation: ConnectorPolicyOperation.CredentialUse, providerId: 'github', serviceId: 'github',
  foundationQuarantined: false, globalKilled: false, providerKilled: false,
  serviceOperationKilled: false, globalPack: { verified: false as const, reason: 'absent' },
  localActivation: { verified: false as const, reason: 'absent' }, profileReady: false,
  grantReady: false, verificationReady: false };

test('activation defaults to deny and global kill has emergency precedence', () => {
  assert.deepEqual(decideConnectorActivation(base), { eligible: false, reason: 'runtime_unready' });
  assert.deepEqual(decideConnectorActivation({ ...base, globalKilled: true }),
    { eligible: false, reason: 'global_killed' });
  assert.deepEqual(decideConnectorActivation({ ...base, runtimeReady: true }),
    { eligible: false, reason: 'pack_invalid' });
});

test('lifecycle cleanup remains available without opening provider activation', () => {
  assert.deepEqual(decideConnectorActivation({ ...base, operation: ConnectorPolicyOperation.GrantRemove,
    globalKilled: true }), { eligible: true, reason: 'safety_operation' });
});
