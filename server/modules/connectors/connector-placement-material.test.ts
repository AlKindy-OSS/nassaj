import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  fingerprintConnectorPlacementAbsence,
  fingerprintConnectorPlacementMaterial,
  verifyConnectorPlacementFingerprint,
  type ConnectorPlacementMaterial,
} from './connector-placement-material.js';

const MASTER_KEY = Buffer.alloc(32, 17);
const SECRET = 'credential-that-must-never-escape';

function material(body: unknown, credential = SECRET): ConnectorPlacementMaterial {
  return {
    connectorId: 'google-drive-team',
    memberUserId: 41,
    bodyProvider: 'codex',
    contractVersion: 'mcp-user-v1',
    body,
    credential,
  };
}

test('placement HMAC is semantic across object key order and binds the complete domain', () => {
  const first = fingerprintConnectorPlacementMaterial(material({
    env: { B: '2', A: '1' },
    args: ['one', 'two'],
    transport: 'stdio',
  }), { masterKey: MASTER_KEY });
  const reordered = fingerprintConnectorPlacementMaterial(material({
    transport: 'stdio',
    args: ['one', 'two'],
    env: { A: '1', B: '2' },
  }), { masterKey: MASTER_KEY });
  assert.deepEqual(first, reordered);

  const changedCredential = fingerprintConnectorPlacementMaterial(
    material({ transport: 'stdio', args: ['one', 'two'], env: { A: '1', B: '2' } }, 'other'),
    { masterKey: MASTER_KEY },
  );
  const changedBody = fingerprintConnectorPlacementMaterial(
    material({ transport: 'stdio', args: ['two', 'one'], env: { A: '1', B: '2' } }),
    { masterKey: MASTER_KEY },
  );
  assert.notEqual(first.fingerprint, changedCredential.fingerprint);
  assert.notEqual(first.fingerprint, changedBody.fingerprint);
});

test('deletion intent uses a separate credential-free authenticated purpose', () => {
  const value = material(null);
  const absence = fingerprintConnectorPlacementAbsence({
    connectorId: value.connectorId,
    memberUserId: value.memberUserId,
    bodyProvider: value.bodyProvider,
    contractVersion: value.contractVersion,
  }, { masterKey: MASTER_KEY });
  const present = fingerprintConnectorPlacementMaterial(value, { masterKey: MASTER_KEY });
  assert.notEqual(absence.fingerprint, present.fingerprint);
  assert.equal(JSON.stringify(absence).includes(SECRET), false);
});

test('previous version verifies explicitly and requires rotation; unknown versions are blocked', () => {
  const value = material({ transport: 'http', url: 'https://example.test/mcp' });
  const previous = fingerprintConnectorPlacementMaterial(value, { version: 1, masterKey: MASTER_KEY });
  const current = fingerprintConnectorPlacementMaterial(value, { version: 2, masterKey: MASTER_KEY });

  assert.deepEqual(
    verifyConnectorPlacementFingerprint(value, previous, { masterKey: MASTER_KEY }),
    { valid: true, needsRotation: true },
  );
  assert.deepEqual(
    verifyConnectorPlacementFingerprint(value, current, { masterKey: MASTER_KEY }),
    { valid: true, needsRotation: false },
  );
  assert.notEqual(previous.fingerprint, current.fingerprint);
  assert.throws(
    () => verifyConnectorPlacementFingerprint(value, {
      version: 3 as 2,
      fingerprint: current.fingerprint,
    }, { masterKey: MASTER_KEY }),
    /connector_placement_hmac_version_blocked/,
  );
});

test('HMAC key is purpose-derived, required, and errors/results disclose no material', () => {
  const value = material({ tokenAlias: 'drive' });
  const proof = fingerprintConnectorPlacementMaterial(value, { masterKey: MASTER_KEY });
  const rawMasterMac = crypto.createHmac('sha256', MASTER_KEY).update('anything').digest('hex');
  assert.notEqual(proof.fingerprint, rawMasterMac);
  assert.equal(JSON.stringify(proof).includes(SECRET), false);

  assert.throws(
    () => fingerprintConnectorPlacementMaterial(value, { masterKey: Buffer.alloc(0) }),
    (error: unknown) => {
      const rendered = String(error);
      return rendered.includes('connector_placement_hmac_key_invalid')
        && !rendered.includes(SECRET)
        && !rendered.includes(proof.fingerprint);
    },
  );
  assert.deepEqual(
    verifyConnectorPlacementFingerprint(value, {
      version: 2,
      fingerprint: '0'.repeat(64),
    }, { masterKey: MASTER_KEY }),
    { valid: false, needsRotation: false },
  );
});

test('canonical material preserves own __proto__ and rejects non-JSON array/object shapes', () => {
  const ordinary = Object.fromEntries([['transport', 'stdio'], ['command', 'drive']]);
  const withProtoKey = Object.fromEntries([
    ['transport', 'stdio'],
    ['command', 'drive'],
    ['__proto__', 'authenticated-domain-data'],
  ]);
  const ordinaryProof = fingerprintConnectorPlacementMaterial(material(ordinary), {
    masterKey: MASTER_KEY,
  });
  const protoProof = fingerprintConnectorPlacementMaterial(material(withProtoKey), {
    masterKey: MASTER_KEY,
  });
  assert.notEqual(ordinaryProof.fingerprint, protoProof.fingerprint);

  const sparse = new Array(2);
  sparse[1] = 'configured';
  assert.throws(
    () => fingerprintConnectorPlacementMaterial(material({ args: sparse }), { masterKey: MASTER_KEY }),
    /connector_placement_material_invalid/,
  );
  assert.throws(
    () => fingerprintConnectorPlacementMaterial(
      material({ env: { TOKEN: undefined } }),
      { masterKey: MASTER_KEY },
    ),
    /connector_placement_material_invalid/,
  );
  assert.throws(
    () => fingerprintConnectorPlacementMaterial(material({ createdAt: new Date(0) }), {
      masterKey: MASTER_KEY,
    }),
    /connector_placement_material_invalid/,
  );
});
