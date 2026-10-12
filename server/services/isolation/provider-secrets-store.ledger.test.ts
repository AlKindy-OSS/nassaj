/**
 * provider-secrets-store.ledger.test.ts — ADR-200 S5 storage: the encrypted
 * `ledger:<vendor>` records, the `backup:<harness>` byte backups and the
 * migration record. Runs in the hermetic sandbox (B-1544).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME so keys.json never lands in the real one.
// eslint-disable-next-line boundaries/dependencies -- the shared test-only sandbox helper, not module code.
import { removeSandbox } from '../../modules/providers/tests/helpers/hermetic-sandbox.js';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');

const store = await import('./provider-secrets-store.js');
store._resetProviderSecretsServerKeyCache();

const keysFile = (userId: string) => path.join(os.homedir(), '.nassaj-users', userId, '.provider-secrets', 'keys.json');

function entry(overrides: Record<string, unknown> = {}) {
  return {
    harness: 'claude',
    target: null,
    fingerprint: store.projectionFingerprint('sk-ant-api03-LEDGER'),
    keyVersion: 1,
    state: 'synced',
    origin: 'adopted',
    updatedAt: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

after(() => removeSandbox());

beforeEach(() => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
});

test('a ledger round-trips encrypted and an empty ledger removes the record', () => {
  store.setVendorLedger('61', 'anthropic', { v: 1, entries: [entry(), entry({ harness: 'opencode', target: 'anthropic' })] });
  const read = store.readVendorLedgerState('61', 'anthropic');
  assert.equal(read.state, 'ok');
  assert.equal(read.state === 'ok' && read.ledger.entries.length, 2);
  assert.equal(fs.readFileSync(keysFile('61'), 'utf8').includes('adopted'), false, 'inside the AES envelope');

  store.setVendorLedger('61', 'anthropic', { v: 1, entries: [] });
  assert.equal(store.readVendorLedgerState('61', 'anthropic').state, 'absent');
});

test('a malformed ledger is refused on write and unreadable on read', () => {
  assert.throws(() => store.setVendorLedger('62', 'anthropic', { v: 1, entries: [entry({ state: 'gone' })] }), /Malformed/);
  assert.throws(() => store.setVendorLedger('62', 'anthropic', { v: 1, entries: [entry(), entry()] }), /Malformed/);
  assert.throws(() => store.setVendorLedger('62', 'anthropic', { v: 1, entries: [entry({ fingerprint: 'x' })] }), /Malformed/);
  assert.throws(() => store.setVendorLedger('62', 'google', { v: 1, entries: [] }), /Unsupported ledger vendor/);

  store.setVendorLedger('62', 'zai', { v: 1, entries: [entry({ harness: 'opencode', target: 'glm' })] });
  const keys = JSON.parse(fs.readFileSync(keysFile('62'), 'utf8'));
  keys['ledger:zai'] = keys['ledger:zai'].replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'));
  fs.writeFileSync(keysFile('62'), JSON.stringify(keys));
  assert.equal(store.readVendorLedgerState('62', 'zai').state, 'unreadable', 'tampered is never absent');
});

test('ledger, backup and migration records are member-scoped', () => {
  assert.throws(() => store.readVendorLedgerState(store.SYSTEM_SECRET_SCOPE, 'anthropic'), /member-scoped/);
  assert.throws(() => store.putHarnessBackupIfAbsent(store.SYSTEM_SECRET_SCOPE, 'claude', null, 'now'), /member-scoped/);
  assert.throws(() => store.readVendorMigrationState(null as unknown as string), /userId is required/);
});

test('a backup keeps the first bytes, verifies its digest and deletes idempotently', () => {
  const bytes = Buffer.from('{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-B"}}\n');
  assert.equal(store.putHarnessBackupIfAbsent('63', 'claude', bytes, 't1'), true);
  assert.equal(store.putHarnessBackupIfAbsent('63', 'claude', Buffer.from('later'), 't2'), false);
  const backup = store.readHarnessBackup('63', 'claude');
  assert.deepEqual(backup?.bytes, bytes);
  assert.equal(backup?.intact, true);
  assert.equal(backup?.takenAt, 't1');
  assert.equal(fs.readFileSync(keysFile('63'), 'utf8').includes('sk-ant-api03-B'), false);

  assert.equal(store.putHarnessBackupIfAbsent('63', 'opencode', null, 't1'), true);
  assert.equal(store.readHarnessBackup('63', 'opencode')?.existed, false);
  assert.deepEqual(store.listHarnessBackups('63'), ['claude', 'opencode']);
  assert.throws(() => store.putHarnessBackupIfAbsent('63', 'antigravity' as 'claude', null, 't'), /Unsupported backup harness/);

  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  assert.equal(store.deleteHarnessBackup('63', 'claude'), true, 'delete stays open with the flag off');
  assert.equal(store.deleteHarnessBackup('63', 'claude'), false);
});

test('a backup write over an unreadable keys file is refused', () => {
  fs.mkdirSync(path.dirname(keysFile('64')), { recursive: true });
  fs.writeFileSync(keysFile('64'), '{ truncated');
  assert.throws(() => store.putHarnessBackupIfAbsent('64', 'codex', null, 't'), { code: store.PROVIDER_SECRETS_STORE_UNREADABLE });
  assert.equal(fs.readFileSync(keysFile('64'), 'utf8'), '{ truncated');
});

test('the migration record round-trips', () => {
  store.setVendorMigrationState('65', { v: 1, verifiedAt: 'x' });
  const read = store.readVendorMigrationState('65');
  assert.equal(read.state === 'ok' && read.record.verifiedAt, 'x');
});
