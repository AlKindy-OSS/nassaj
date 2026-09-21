import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTOR_CREDENTIAL_CONTRACTS,
  GEIDEA_RUNTIME_SUPPORTED,
  connectorCredentialContractFor,
  validateConnectorCredentialBundle,
} from './connector-credential-contracts.js';

test('credential contracts are closed, deeply frozen, and server-owned', () => {
  assert.ok(Object.isFrozen(CONNECTOR_CREDENTIAL_CONTRACTS));
  assert.equal(connectorCredentialContractFor('unknown'), null);
  const geidea = connectorCredentialContractFor('geidea');
  assert.equal(geidea?.shape.id, 'geidea_basic');
  assert.ok(Object.isFrozen(geidea));
  assert.ok(Object.isFrozen(geidea?.shape.fields));
  assert.deepEqual(geidea?.shape.fields.map(field => field.id), [
    'merchant_public_key', 'api_password',
  ]);
  assert.equal(JSON.stringify(geidea).includes('endpoint'), false);
  assert.equal(JSON.stringify(geidea).includes('header'), false);
  assert.equal(JSON.stringify(geidea).includes('env'), false);
});

test('Geidea is an indivisible fixed-field bundle', () => {
  assert.throws(
    () => validateConnectorCredentialBundle('geidea', {
      merchant_public_key: Buffer.from('merchant'),
    }),
    /connector_credential_bundle_incomplete/,
  );
  assert.throws(
    () => validateConnectorCredentialBundle('geidea', {
      merchant_public_key: Buffer.from('merchant'), api_password: Buffer.from('password'),
      endpoint: Buffer.from('https://attacker.invalid'),
    }),
    /connector_credential_bundle_incomplete/,
  );
});

test('Geidea has no forgeable runtime assembler before its atomic consumer is certified', () => {
  assert.equal(GEIDEA_RUNTIME_SUPPORTED, false);
});
