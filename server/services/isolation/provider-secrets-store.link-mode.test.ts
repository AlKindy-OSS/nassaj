/**
 * provider-secrets-store.link-mode.test.ts — ADR-200 S4 storage: the encrypted
 * per-(user, harness) link-mode record and the projection fingerprint.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME so keys.json never lands in the real one.
// eslint-disable-next-line boundaries/dependencies -- the shared test-only sandbox helper, not module code.
import { removeSandbox } from '../../modules/providers/tests/helpers/hermetic-sandbox.js';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 3).toString('base64');

const store = await import('./provider-secrets-store.js');
store._resetProviderSecretsServerKeyCache();

const RECORD = { v: 1, mode: 'api_key', source: 'user', updatedAt: 'now', projection: null, subscriptionFp: null };
const keysFile = (userId: string) => path.join(os.homedir(), '.nassaj-users', userId, '.provider-secrets', 'keys.json');

after(() => removeSandbox());

beforeEach(() => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
});

test('a link-mode record round-trips encrypted, per user and per harness', () => {
  store.setLinkModeRecord('41', 'claude', RECORD);
  assert.deepEqual(store.getLinkModeRecord('41', 'claude'), RECORD);
  assert.equal(store.getLinkModeRecord('41', 'codex'), null);
  assert.equal(store.getLinkModeRecord('42', 'claude'), null);
  const raw = fs.readFileSync(keysFile('41'), 'utf8');
  assert.equal(raw.includes('api_key'), false, 'stored inside the AES envelope');
  assert.equal(fs.statSync(keysFile('41')).mode & 0o777, 0o600);
});

test('a null member id uses the operator scope', () => {
  store.setLinkModeRecord(null, 'codex', { ...RECORD, mode: 'subscription' });
  assert.equal(store.getLinkModeRecord(null, 'codex')?.mode, 'subscription');
  assert.equal(store.getLinkModeRecord('41', 'codex'), null);
});

test('writes are refused with the flag off; reads stay open', () => {
  store.setLinkModeRecord('43', 'claude', RECORD);
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  assert.throws(() => store.setLinkModeRecord('43', 'claude', RECORD), /NASSAJ_UNIFIED_VENDOR_KEYS is off/);
  assert.equal(store.getLinkModeRecord('43', 'claude')?.mode, 'api_key');
});

test('unsupported harnesses and a tampered record are refused or read as absent', () => {
  assert.throws(() => store.setLinkModeRecord('44', 'opencode' as 'claude', RECORD), /Unsupported link-mode harness/);
  assert.throws(() => store.getLinkModeRecord('44', 'antigravity' as 'claude'), /Unsupported link-mode harness/);
  store.setLinkModeRecord('44', 'claude', RECORD);
  const keys = JSON.parse(fs.readFileSync(keysFile('44'), 'utf8'));
  keys['linkmode:claude'] = keys['linkmode:claude'].replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'));
  fs.writeFileSync(keysFile('44'), JSON.stringify(keys));
  assert.equal(store.getLinkModeRecord('44', 'claude'), null);
});

test('B-1547: the record state tells absent from unreadable', () => {
  assert.deepEqual(store.readLinkModeRecordState('45', 'claude'), { state: 'absent' }, 'no keys file');
  store.setLinkModeRecord('45', 'codex', RECORD);
  assert.deepEqual(store.readLinkModeRecordState('45', 'claude'), { state: 'absent' }, 'no entry');
  assert.deepEqual(store.readLinkModeRecordState('45', 'codex'), { state: 'ok', record: RECORD });

  process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');
  store._resetProviderSecretsServerKeyCache();
  try {
    assert.deepEqual(store.readLinkModeRecordState('45', 'codex'), { state: 'unreadable' }, 'wrong server key');
    assert.equal(store.getLinkModeRecord('45', 'codex'), null, 'display reader keeps null');
  } finally {
    process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 3).toString('base64');
    store._resetProviderSecretsServerKeyCache();
  }

  fs.writeFileSync(keysFile('45'), '{not json');
  assert.deepEqual(store.readLinkModeRecordState('45', 'codex'), { state: 'unreadable', store: true }, 'corrupt keys.json');
  assert.deepEqual(store.readLinkModeRecordState('45', 'claude'), { state: 'unreadable', store: true }, 'whole file is unreadable');
});

test('B-1547: a corrupt keys file is never rewritten by a link-mode write', () => {
  store.setLinkModeRecord('46', 'claude', RECORD);
  fs.writeFileSync(keysFile('46'), '[]');
  assert.throws(() => store.setLinkModeRecord('46', 'claude', RECORD),
    (error: { code?: string; message?: string }) => error.code === 'PROVIDER_SECRETS_STORE_UNREADABLE'
      && error.message === 'The credential store needs operator repair.');
  assert.equal(fs.readFileSync(keysFile('46'), 'utf8'), '[]', 'the corrupt file is left for the operator');
});

test('B-1547: a bad entry (tampered) is replaceable; the other secrets survive', () => {
  store.setLinkModeRecord('47', 'claude', RECORD);
  store.setLinkModeRecord('47', 'codex', RECORD);
  const keys = JSON.parse(fs.readFileSync(keysFile('47'), 'utf8'));
  keys['linkmode:claude'] = 'v1:garbage';
  fs.writeFileSync(keysFile('47'), JSON.stringify(keys));
  assert.deepEqual(store.readLinkModeRecordState('47', 'claude'), { state: 'unreadable' });
  store.setLinkModeRecord('47', 'claude', { ...RECORD, mode: 'subscription' });
  assert.equal(store.getLinkModeRecord('47', 'claude')?.mode, 'subscription');
  assert.deepEqual(store.getLinkModeRecord('47', 'codex'), RECORD);
});

test('projection fingerprints are keyed, versioned and never contain the value', () => {
  const value = 'sk' + '-ant-api03-FP-DO-NOT-LEAK';
  const v1 = store.projectionFingerprint(value);
  assert.match(v1, /^[0-9a-f]{64}$/);
  assert.equal(store.projectionFingerprint(value, 1), v1, 'stable');
  assert.notEqual(store.projectionFingerprint(value, 2), v1, 'the HKDF label version changes the key');
  assert.notEqual(store.projectionFingerprint(`${value}x`), v1);
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 4).toString('base64');
  store._resetProviderSecretsServerKeyCache();
  try {
    assert.notEqual(store.projectionFingerprint(value), v1, 'bound to the server key');
  } finally {
    process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 3).toString('base64');
    store._resetProviderSecretsServerKeyCache();
  }
  assert.throws(() => store.projectionFingerprint(''), /non-empty/);
});
