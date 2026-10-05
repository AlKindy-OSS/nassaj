import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createShareId, createShareToken, hashShareToken, isShareId, isShareToken, verifyShareToken,
} from './share-capability.js';

test('ids are 128-bit lowercase hex and tokens 256-bit base64url', () => {
  const id = createShareId();
  const token = createShareToken();
  assert.ok(isShareId(id));
  assert.equal(Buffer.from(id, 'hex').length, 16);
  assert.ok(isShareToken(token));
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.notEqual(createShareToken(), token);
});

test('shape checks reject malformed and non-string input', () => {
  for (const bad of [undefined, null, 42, '', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(33)]) {
    assert.equal(isShareId(bad), false);
  }
  for (const bad of [undefined, null, 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}+`]) {
    assert.equal(isShareToken(bad), false);
  }
});

test('hash is SHA-256 hex and verification is exact', () => {
  const token = createShareToken();
  const hash = hashShareToken(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(verifyShareToken(token, hash), true);
  assert.equal(verifyShareToken(createShareToken(), hash), false);
  assert.equal(verifyShareToken(token, hash.toUpperCase()), false);
  assert.equal(verifyShareToken(token, hash.slice(1)), false);
  assert.equal(verifyShareToken(token, null), false);
  assert.equal(verifyShareToken(undefined, hash), false);
  assert.equal(verifyShareToken(hash, hash), false);
});
