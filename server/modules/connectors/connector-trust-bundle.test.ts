import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { connectorJcs, parseConnectorCanonicalJson } from './connector-jcs.js';
import {
  connectorTrustBundleDigest, parseConnectorTrustBundle, selectConnectorTrustRoot,
  type ConnectorTrustBundle,
} from './connector-trust-bundle.js';

const publicKeyPem = generateKeyPairSync('ed25519').publicKey
  .export({ type: 'spki', format: 'pem' }).toString();
const bundle = (): ConnectorTrustBundle => ({
  schemaVersion: 1, revision: 3, distributionIssuerId: 'nassaj-oss',
  roots: [{ issuerId: 'nassaj-oss', keyId: 'root-1', algorithm: 'Ed25519', publicKeyPem,
    validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z',
    source: 'distribution' }], revokedKeyIds: [],
});

test('trust bundle is closed, owned, frozen, and SHA-512 domain separated', () => {
  const parsed = parseConnectorTrustBundle(bundle());
  assert.ok(parsed);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.roots[0]), true);
  assert.equal(connectorTrustBundleDigest(parsed).length, 64);
  assert.notEqual(connectorTrustBundleDigest(parsed).toString('hex'),
    connectorTrustBundleDigest({ ...parsed, revision: 4 }).toString('hex'));
  assert.equal(parseConnectorTrustBundle({ ...bundle(), extra: true }), null);
});

test('trust parser rejects unsafe revisions, bad dates, duplicates, revocation duplicates, and invalid unicode', () => {
  const root = bundle().roots[0];
  const invalid = [
    { ...bundle(), revision: -0 }, { ...bundle(), revision: 1.5 },
    { ...bundle(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...bundle(), roots: [{ ...root, validFrom: '2026-02-30T00:00:00.000Z' }] },
    { ...bundle(), roots: [root, { ...root }] },
    { ...bundle(), roots: [{ ...root, issuerId: 'other', source: 'distribution' }] },
    { ...bundle(), revokedKeyIds: ['root-1', 'root-1'] },
    { ...bundle(), distributionIssuerId: `bad\ud800` },
    { ...bundle(), roots: [{ ...root, surprise: true }] },
  ];
  for (const candidate of invalid) assert.equal(parseConnectorTrustBundle(candidate), null);
});

test('root selection binds issuer and key and enforces revocation and both validity instants', () => {
  const issued = Date.parse('2026-06-01T00:00:00.000Z');
  const now = Date.parse('2026-06-02T00:00:00.000Z');
  assert.ok(selectConnectorTrustRoot(bundle(), 'nassaj-oss', 'root-1', issued, now));
  assert.equal(selectConnectorTrustRoot(bundle(), 'other', 'root-1', issued, now), null);
  assert.equal(selectConnectorTrustRoot({ ...bundle(), revokedKeyIds: ['root-1'] },
    'nassaj-oss', 'root-1', issued, now), null);
  assert.equal(selectConnectorTrustRoot(bundle(), 'nassaj-oss', 'root-1',
    Date.parse('2025-12-01T00:00:00.000Z'), now), null);
  assert.equal(selectConnectorTrustRoot(bundle(), 'nassaj-oss', 'root-1', issued,
    Date.parse('2027-01-01T00:00:00.000Z')), null);
});

test('JCS sorts UTF-16 keys and canonical text rejects duplicates, whitespace, -0 and lone surrogates', () => {
  assert.equal(connectorJcs({ z: 1, a: 'x', nested: [true, null] }),
    '{"a":"x","nested":[true,null],"z":1}');
  assert.deepEqual(parseConnectorCanonicalJson('{"a":1,"b":2}'), { a: 1, b: 2 });
  for (const text of ['{"a":1,"a":2}', '{ "a":1}', '{"a":-0}', '{"a":1.0}']) {
    assert.equal(parseConnectorCanonicalJson(text), null);
  }
  assert.throws(() => connectorJcs(`bad\ud800`), /invalid_unicode/u);
  assert.throws(() => connectorJcs(-0), /invalid_number/u);
});
