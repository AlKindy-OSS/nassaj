/**
 * vendor-key-migration.service.test.ts — ADR-200 S5: read-only inventory,
 * conflicts (D9), adoption, backups and the restore drill, the 30-day purge
 * (D8), idempotence, keyVersion rotation and the audit rows. Real AES store and
 * real harness files, all inside the hermetic sandbox (B-1544).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME so keys.json never lands in the real one.
import { assertInsideSandbox, removeSandbox, sandboxRoot } from '../tests/helpers/hermetic-sandbox.js';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';

const store = await import('@/services/isolation/provider-secrets-store.js');
const { createVendorKeyMigrationService, BACKUP_RETENTION_MS } = await import('./vendor-key-migration.service.js');
store._resetProviderSecretsServerKeyCache();

type Harness = 'claude' | 'codex' | 'opencode';
type Audit = { userId: string | number; action: string; metadata: Record<string, unknown> };

const ANTHROPIC_KEY = 'sk' + '-ant-api03-MIGRATE-ME-0001';
const OTHER_ANTHROPIC_KEY = 'sk' + '-ant-api03-OTHER-0002';
const OPENAI_KEY = 'sk' + '-proj-MIGRATE-OPENAI-0003';
const OAUTH_TOKEN = 'sk' + '-ant-oat01-SUBSCRIPTION-DO-NOT-TOUCH';
const ZAI_A = 'zai-key-AAAA';
const ZAI_B = 'zai-key-BBBB';

let audits: Audit[] = [];
let clock = new Date('2026-10-09T00:00:00.000Z');
let sharedHarnesses = new Set<Harness>();
let userSeq = 100;
let lockCalls: string[] = [];

const FILES: Record<Harness, string> = {
  claude: 'claude/settings.json',
  codex: 'codex/auth.json',
  opencode: 'opencode/auth.json',
};

function harnessPath(userId: string | number, harness: Harness): string {
  return assertInsideSandbox(path.join(sandboxRoot, 'trees', String(userId), FILES[harness]));
}

function writeHarness(userId: string | number, harness: Harness, content: unknown): Buffer {
  const file = harnessPath(userId, harness);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(content, null, 2)}\n`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return bytes;
}

function keysFile(userId: string | number): string {
  return assertInsideSandbox(path.join(sandboxRoot, 'home', '.nassaj-users', String(userId), '.provider-secrets', 'keys.json'));
}

function keysBytes(userId: string | number): string | null {
  try {
    return fs.readFileSync(keysFile(userId), 'utf8');
  } catch {
    return null;
  }
}

function makeService(keyVersion = 1) {
  return createVendorKeyMigrationService({
    isEnabled: () => store.isUnifiedVendorKeysEnabled(),
    locateHarnessFiles: (userId) => (['claude', 'codex', 'opencode'] as Harness[]).map((harness) => (
      sharedHarnesses.has(harness)
        ? { harness, scope: 'shared' as const }
        : { harness, scope: 'own' as const, path: harnessPath(userId, harness) }
    )),
    fingerprint: (value, version) => store.projectionFingerprint(value, version),
    keyVersion,
    listMemberIds: () => [],
    audit: (userId, action, metadata) => { audits.push({ userId, action, metadata }); },
    now: () => clock,
    withHarnessLock: async (userId, harness, work) => {
      lockCalls.push(`${userId}:${harness}`);
      return work();
    },
  });
}

/** A member with Anthropic in Claude settings (next to an OAuth token) and OpenCode, and OpenAI in Codex. */
function seedAgreeingMember(): { userId: string; originals: Record<Harness, Buffer> } {
  const userId = String(userSeq++);
  const originals = {
    claude: writeHarness(userId, 'claude', {
      theme: 'dark',
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
    }),
    codex: writeHarness(userId, 'codex', {
      OPENAI_API_KEY: OPENAI_KEY,
      tokens: { refresh_token: 'codex-refresh-DO-NOT-TOUCH', account_id: 'acct' },
    }),
    opencode: writeHarness(userId, 'opencode', {
      anthropic: { type: 'api', key: ANTHROPIC_KEY },
      github: { type: 'oauth', refresh: 'oc-refresh' },
    }),
  };
  return { userId, originals };
}

function assertNoSecretIn(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [ANTHROPIC_KEY, OTHER_ANTHROPIC_KEY, OPENAI_KEY, OAUTH_TOKEN, ZAI_A, ZAI_B]) {
    assert.equal(text.includes(secret), false, 'no key value is returned or audited');
  }
}

after(() => removeSandbox());

beforeEach(() => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  audits = [];
  clock = new Date('2026-10-09T00:00:00.000Z');
  sharedHarnesses = new Set();
  lockCalls = [];
});

test('the inventory is read-only and previews the adoption', () => {
  const { userId, originals } = seedAgreeingMember();
  const result = makeService().inventory(userId);

  assert.equal(result.status, 'done');
  assert.equal(result.vendors.find((v) => v.vendorId === 'anthropic')?.outcome, 'adopted');
  assert.equal(result.vendors.find((v) => v.vendorId === 'openai')?.outcome, 'adopted');
  assert.equal(keysBytes(userId), null, 'no keys file was created');
  for (const harness of ['claude', 'codex', 'opencode'] as Harness[]) {
    assert.deepEqual(fs.readFileSync(harnessPath(userId, harness)), originals[harness]);
  }
  assert.deepEqual(audits, []);
  assertNoSecretIn(result);
});

test('a Z.AI conflict (AES glm differs from opencode glm) writes nothing and is surfaced', async () => {
  const userId = String(userSeq++);
  store.setProviderKey(userId, 'glm', ZAI_A);
  const opencode = writeHarness(userId, 'opencode', { glm: { type: 'api', key: ZAI_B } });
  const before = keysBytes(userId);

  const result = await makeService().run(userId);

  const zai = result.vendors.find((v) => v.vendorId === 'zai');
  assert.equal(zai?.outcome, 'conflict');
  assert.deepEqual(zai?.sources, [
    { harness: 'store', target: 'glm', group: 0 },
    { harness: 'opencode', target: 'glm', group: 1 },
  ]);
  assert.equal(keysBytes(userId), before, 'keys.json is byte-identical: no ledger, no backup, no state');
  assert.deepEqual(fs.readFileSync(harnessPath(userId, 'opencode')), opencode);
  assert.equal(store.getProviderKey(userId, 'glm'), ZAI_A);
  assert.equal(result.verifiedAt, null);
  assert.deepEqual(audits, []);
  assertNoSecretIn(result);
});

test('differing Anthropic keys are a conflict; nothing is written for that vendor', async () => {
  const userId = String(userSeq++);
  writeHarness(userId, 'claude', { env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
  writeHarness(userId, 'opencode', { anthropic: { type: 'api', key: OTHER_ANTHROPIC_KEY } });

  const result = await makeService().run(userId);

  assert.equal(result.vendors.find((v) => v.vendorId === 'anthropic')?.outcome, 'conflict');
  assert.equal(store.getCanonicalVendorKey(userId, 'anthropic'), null);
  assert.equal(store.readVendorLedgerState(userId, 'anthropic').state, 'absent');
  assert.equal(keysBytes(userId), null);
});

test('non-conflicting keys are adopted with origin adopted; harness files are untouched', async () => {
  const { userId, originals } = seedAgreeingMember();
  const result = await makeService().run(userId);

  assert.equal(store.getCanonicalVendorKey(userId, 'anthropic'), ANTHROPIC_KEY);
  assert.equal(store.getCanonicalVendorKey(userId, 'openai'), OPENAI_KEY);
  const ledger = store.readVendorLedgerState(userId, 'anthropic');
  assert.equal(ledger.state, 'ok');
  const entries = ledger.state === 'ok' ? ledger.ledger.entries : [];
  assert.deepEqual(entries.map((e) => [e.harness, e.target, e.origin, e.state, e.keyVersion]), [
    ['claude', null, 'adopted', 'synced', 1],
    ['opencode', 'anthropic', 'adopted', 'synced', 1],
  ]);
  assert.ok(entries.every((e) => e.fingerprint === store.projectionFingerprint(ANTHROPIC_KEY, 1)));
  for (const harness of ['claude', 'codex', 'opencode'] as Harness[]) {
    assert.deepEqual(fs.readFileSync(harnessPath(userId, harness)), originals[harness], `${harness} unchanged`);
  }
  assert.ok(!keysBytes(userId)?.includes(ANTHROPIC_KEY), 'stored encrypted only');
  assert.ok(result.verifiedAt, 'adoption re-verified and backups intact → verified');
  assertNoSecretIn(result);
  assertNoSecretIn(audits);
});

test('an audit row is written per adoption', async () => {
  const { userId } = seedAgreeingMember();
  await makeService().run(userId);

  const adopted = audits.filter((a) => a.action === 'vendor_key_adopted').map((a) => a.metadata);
  assert.deepEqual(adopted.map((m) => `${m.vendorId}:${m.harness}:${m.target ?? '-'}`).sort(), [
    'anthropic:claude:-',
    'anthropic:opencode:anthropic',
    'anthropic:store:vendor:anthropic',
    'openai:codex:-',
    'openai:store:vendor:openai',
  ]);
});

test('a Claude subscription token in a key field is never adopted', async () => {
  const userId = String(userSeq++);
  writeHarness(userId, 'claude', { env: { ANTHROPIC_API_KEY: OAUTH_TOKEN } });

  const result = await makeService().run(userId);

  const anthropic = result.vendors.find((v) => v.vendorId === 'anthropic');
  assert.deepEqual(anthropic?.sources, [{ harness: 'claude', target: null, group: null, refused: 'subscription_token' }]);
  assert.equal(anthropic?.outcome, 'nothing');
  assert.equal(store.getCanonicalVendorKey(userId, 'anthropic'), null);
});

test('a backup exists before the first write, and a restore drill reproduces it byte for byte', async () => {
  const { userId, originals } = seedAgreeingMember();
  const service = makeService();
  assert.deepEqual((await service.ensureBackups(userId)).sort(), ['claude', 'codex', 'opencode']);

  // Simulate nassaj's first harness write after the backup.
  writeHarness(userId, 'claude', { env: { ANTHROPIC_API_KEY: OTHER_ANTHROPIC_KEY } });
  writeHarness(userId, 'codex', { OPENAI_API_KEY: 'changed' });
  assert.deepEqual(await service.ensureBackups(userId), [], 'the first backup is kept');

  for (const harness of ['claude', 'codex'] as Harness[]) {
    const backup = store.readHarnessBackup(userId, harness);
    assert.equal(backup?.intact, true);
    assert.deepEqual(backup?.bytes, originals[harness]);
    await service.restoreBackup(userId, harness, { mode: 'full', confirm: true });
    assert.deepEqual(fs.readFileSync(harnessPath(userId, harness)), originals[harness], `${harness} restored`);
  }
  assert.equal(audits.filter((a) => a.action === 'vendor_key_backup_restored').length, 2);
  assert.deepEqual(lockCalls, [`${userId}:claude`, `${userId}:codex`], 'each restore ran under the (user, harness) lock');
});

test('a backup of an absent file restores to absent; restore works with the flag off', async () => {
  const userId = String(userSeq++);
  writeHarness(userId, 'claude', { env: {} });
  await makeService().ensureBackups(userId);
  writeHarness(userId, 'opencode', { openai: { type: 'api', key: OPENAI_KEY } });

  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  await makeService().restoreBackup(userId, 'opencode');
  assert.deepEqual(JSON.parse(fs.readFileSync(harnessPath(userId, 'opencode'), 'utf8')), {}, 'keys mode: the api entry goes');
  await makeService().restoreBackup(userId, 'opencode', { mode: 'full', confirm: true });
  assert.equal(fs.existsSync(harnessPath(userId, 'opencode')), false, 'full mode: the file goes');
});

test('backups are purged 30 days after verification, with one audit row per purge', async () => {
  const { userId } = seedAgreeingMember();
  const service = makeService();
  const first = await service.run(userId);
  assert.equal(first.verifiedAt, clock.toISOString());

  clock = new Date(clock.getTime() + BACKUP_RETENTION_MS - 60_000);
  assert.deepEqual((await service.run(userId)).purged, []);
  assert.equal(store.listHarnessBackups(userId).length, 3);

  clock = new Date(Date.parse(first.verifiedAt!) + BACKUP_RETENTION_MS);
  const purge = await service.run(userId);
  assert.deepEqual(purge.purged.sort(), ['claude', 'codex', 'opencode']);
  assert.deepEqual(store.listHarnessBackups(userId), []);
  const rows = audits.filter((a) => a.action === 'vendor_key_backup_purged');
  assert.deepEqual(rows.map((a) => a.metadata.harness).sort(), ['claude', 'codex', 'opencode']);
  assert.deepEqual(await service.ensureBackups(userId), [], 'no new backups once verified');
});

test('re-running the migration is idempotent', async () => {
  const { userId } = seedAgreeingMember();
  const service = makeService();
  await service.run(userId);
  const bytes = keysBytes(userId);
  const auditCount = audits.length;

  const again = await service.run(userId);

  assert.equal(keysBytes(userId), bytes, 'keys.json is not rewritten');
  assert.equal(audits.length, auditCount, 'no new audit rows');
  assert.ok(again.vendors.filter((v) => v.outcome !== 'nothing').every((v) => v.outcome === 'unchanged'));
  assert.deepEqual(again.backupsTaken, []);
});

test('a keyVersion rotation re-verifies old entries and re-fingerprints them', async () => {
  const { userId } = seedAgreeingMember();
  await makeService(1).run(userId);
  writeHarness(userId, 'opencode', { anthropic: { type: 'api', key: OTHER_ANTHROPIC_KEY } });

  await makeService(2).run(userId);

  const read = store.readVendorLedgerState(userId, 'anthropic');
  const entries = read.state === 'ok' ? read.ledger.entries : [];
  const claude = entries.find((e) => e.harness === 'claude');
  const opencode = entries.find((e) => e.harness === 'opencode');
  assert.equal(claude?.keyVersion, 2);
  assert.equal(claude?.fingerprint, store.projectionFingerprint(ANTHROPIC_KEY, 2));
  assert.equal(claude?.state, 'synced');
  assert.equal(opencode?.keyVersion, 1, 'a changed file does not verify under its old version');
  assert.equal(opencode?.state, 'stale');
});

test('the user resolves a conflict; the choice is adopted and the re-run stays resolved', async () => {
  const userId = String(userSeq++);
  store.setProviderKey(userId, 'glm', ZAI_A);
  writeHarness(userId, 'opencode', { glm: { type: 'api', key: ZAI_B } });
  const service = makeService();

  const result = await service.resolveConflict(userId, 'zai', { harness: 'opencode', target: 'glm' });

  assert.equal(store.getProviderKey(userId, 'glm'), ZAI_B);
  assert.equal(result.vendors.find((v) => v.vendorId === 'zai')?.outcome, 'adopted');
  assert.equal(audits.filter((a) => a.action === 'vendor_key_conflict_resolved').length, 1);
  const bytes = keysBytes(userId);
  assert.equal((await service.run(userId)).vendors.find((v) => v.vendorId === 'zai')?.outcome, 'unchanged');
  assert.equal(keysBytes(userId), bytes);
  await assert.rejects(service.resolveConflict(userId, 'zai', { harness: 'store', target: 'glm' }), {
    code: 'VENDOR_MIGRATION_NO_CONFLICT',
  });
});

test('flag off: run is a no-op and the store refuses in-flag writes; reads stay open', async () => {
  const { userId } = seedAgreeingMember();
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  const service = makeService();

  assert.equal((await service.run(userId)).status, 'flag_off');
  assert.equal(service.inventory(userId).status, 'flag_off');
  assert.deepEqual(await service.ensureBackups(userId), []);
  assert.equal(keysBytes(userId), null);
  assert.throws(() => store.setVendorLedger(userId, 'anthropic', { v: 1, entries: [] }), /is off/);
  assert.throws(() => store.putHarnessBackupIfAbsent(userId, 'claude', null, 'now'), /is off/);
  assert.throws(() => store.setVendorMigrationState(userId, {}), /is off/);
  assert.equal(store.readVendorLedgerState(userId, 'anthropic').state, 'absent');
});

test('a shared harness tree is never inventoried or backed up', async () => {
  const { userId } = seedAgreeingMember();
  sharedHarnesses = new Set(['claude', 'codex']);

  const result = await makeService().run(userId);

  assert.deepEqual(result.harnesses.filter((h) => h.scope === 'shared').map((h) => h.harness), ['claude', 'codex']);
  const read = store.readVendorLedgerState(userId, 'anthropic');
  const entries = read.state === 'ok' ? read.ledger.entries : [];
  assert.deepEqual(entries.map((e) => e.harness), ['opencode']);
  assert.deepEqual(store.listHarnessBackups(userId), ['opencode']);
  assert.equal(store.readVendorLedgerState(userId, 'openai').state, 'absent');
});

test('the operator scope and a null user are never migrated', async () => {
  const service = makeService();
  assert.equal((await service.run(null)).status, 'no_member');
  assert.equal((await service.run(store.SYSTEM_SECRET_SCOPE)).status, 'no_member');
});

test('the write-path backup guard ignores non-file providers and the flag-off path', async () => {
  const { backupBeforeFirstWrite } = await import('./vendor-key-backup.guard.js');
  const { userId } = seedAgreeingMember();
  await backupBeforeFirstWrite(userId, 'kimi');
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  await backupBeforeFirstWrite(userId, 'claude');
  assert.equal(keysBytes(userId), null, 'nothing stored for a spawn-only provider or with the flag off');
});

test('G2: the default restore puts back API-key fields only; OAuth and other settings stay', async () => {
  const { userId } = seedAgreeingMember();
  const service = makeService();
  await service.ensureBackups(userId);
  // After the backup: nassaj rotated the keys, and the user signed in again and changed settings.
  writeHarness(userId, 'claude', { theme: 'light', env: { ANTHROPIC_API_KEY: OTHER_ANTHROPIC_KEY, CLAUDE_CODE_OAUTH_TOKEN: 'new-oauth' } });
  writeHarness(userId, 'codex', { auth_mode: 'apikey', OPENAI_API_KEY: 'rotated', tokens: { refresh_token: 'new-refresh' } });
  writeHarness(userId, 'opencode', {
    anthropic: { type: 'api', key: OTHER_ANTHROPIC_KEY }, openai: { type: 'api', key: 'added' }, github: { type: 'oauth', refresh: 'new' },
  });

  for (const harness of ['claude', 'codex', 'opencode'] as Harness[]) await service.restoreBackup(userId, harness);

  const read = (harness: Harness) => JSON.parse(fs.readFileSync(harnessPath(userId, harness), 'utf8'));
  assert.deepEqual(read('claude'), { theme: 'light', env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, CLAUDE_CODE_OAUTH_TOKEN: 'new-oauth' } });
  assert.deepEqual(read('codex'), { auth_mode: 'apikey', OPENAI_API_KEY: OPENAI_KEY, tokens: { refresh_token: 'new-refresh' } },
    'auth_mode is left as is when the backup recorded none');
  assert.deepEqual(read('opencode'), { anthropic: { type: 'api', key: ANTHROPIC_KEY }, github: { type: 'oauth', refresh: 'new' } });
  assert.deepEqual(audits.filter((a) => a.action === 'vendor_key_backup_restored').map((a) => a.metadata.mode), ['keys', 'keys', 'keys']);
  assertNoSecretIn(audits);
});

test('G2: a full restore needs an explicit confirm; an unknown mode is a 400', async () => {
  const { userId } = seedAgreeingMember();
  const service = makeService();
  await service.ensureBackups(userId);
  await assert.rejects(service.restoreBackup(userId, 'claude', { mode: 'full' }),
    (error: unknown) => (error as { code?: string }).code === 'VENDOR_RESTORE_CONFIRM_REQUIRED');
  await assert.rejects(service.restoreBackup(userId, 'claude', { mode: 'bytes' as 'full', confirm: true }),
    (error: unknown) => (error as { code?: string; statusCode?: number }).statusCode === 400);
  assert.deepEqual(lockCalls, [], 'refused before any lock or write');
});

test('G2: a restore keeps a symlink and the file permission bits', async () => {
  const userId = String(userSeq++);
  const real = assertInsideSandbox(path.join(sandboxRoot, 'trees', userId, 'real-settings.json'));
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, JSON.stringify({ env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } }), { mode: 0o640 });
  fs.chmodSync(real, 0o640);
  const link = harnessPath(userId, 'claude');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  const service = makeService();
  await service.ensureBackups(userId);
  fs.writeFileSync(real, JSON.stringify({ env: { ANTHROPIC_API_KEY: OTHER_ANTHROPIC_KEY } }));

  await service.restoreBackup(userId, 'claude');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link is kept');
  assert.equal(fs.statSync(real).mode & 0o777, 0o640, 'the permission bits are kept');
  assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).env.ANTHROPIC_API_KEY, ANTHROPIC_KEY);
});

test('G2: a restore forgets the harness ledger entries and a stale link-mode projection', async () => {
  const { userId } = seedAgreeingMember();
  const service = makeService();
  await service.run(userId);
  const fp = store.projectionFingerprint(OTHER_ANTHROPIC_KEY, 1);
  store.setLinkModeRecord(userId, 'claude', {
    v: 1, mode: 'api_key', source: 'user', projection: { fp, keyVersion: 1 }, subscriptionFp: null, updatedAt: 'x',
  });
  writeHarness(userId, 'claude', { env: { ANTHROPIC_API_KEY: OTHER_ANTHROPIC_KEY } });

  await service.restoreBackup(userId, 'claude');
  const read = store.readVendorLedgerState(userId, 'anthropic');
  const harnesses = read.state === 'ok' ? read.ledger.entries.map((entry) => entry.harness) : [];
  assert.deepEqual(harnesses, ['opencode'], 'the restored harness has no ledger entry left');
  const record = store.getLinkModeRecord(userId, 'claude');
  assert.equal(record?.mode, 'api_key', 'the mode is kept');
  assert.equal(record?.projection, null, 'the projection no longer claims the restored value');
});

test('G2: a deleted vendor is never adopted again from a harness file', async () => {
  const userId = String(userSeq++);
  writeHarness(userId, 'claude', { env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
  store.setVendorMigrationState(userId, { v: 1, deletedVendors: { anthropic: '2026-10-09T00:00:00.000Z' } });
  const result = await makeService().run(userId);
  assert.equal(result.vendors.find((v) => v.vendorId === 'anthropic')?.outcome, 'deleted');
  assert.equal(store.getCanonicalVendorKey(userId, 'anthropic'), null);
  const state = store.readVendorMigrationState(userId);
  assert.deepEqual(state.state === 'ok' ? state.record.deletedVendors : null, { anthropic: '2026-10-09T00:00:00.000Z' },
    'the run keeps the marker');
});

test('G2: nothing is adopted over an AES record that does not decrypt', async () => {
  const userId = String(userSeq++);
  writeHarness(userId, 'claude', { env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
  store.setCanonicalVendorKey(userId, 'anthropic', OTHER_ANTHROPIC_KEY);
  const keys = JSON.parse(fs.readFileSync(keysFile(userId), 'utf8')) as Record<string, string>;
  keys['vendor:anthropic'] = 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA';
  fs.writeFileSync(keysFile(userId), JSON.stringify(keys));

  const result = await makeService().run(userId);
  assert.equal(result.vendors.find((v) => v.vendorId === 'anthropic')?.outcome, 'key_unreadable');
  assert.equal(JSON.parse(fs.readFileSync(keysFile(userId), 'utf8'))['vendor:anthropic'], keys['vendor:anthropic'], 'untouched');
  assert.equal(store.readVendorLedgerState(userId, 'anthropic').state, 'absent');
});

test('G2 N-1: a keys restore never replaces or removes an OpenCode login, and reports it', async () => {
  const userId = String(userSeq++);
  writeHarness(userId, 'opencode', { anthropic: { type: 'api', key: ANTHROPIC_KEY } });
  const service = makeService();
  await service.ensureBackups(userId);
  // After the backup the user signed in to Anthropic and OpenAI through OpenCode.
  const logins = {
    anthropic: { type: 'oauth', refresh: 'oc-anthropic-refresh', access: 'a', expires: 1 },
    openai: { type: 'oauth', refresh: 'oc-openai-refresh' },
  };
  writeHarness(userId, 'opencode', logins);

  const result = await service.restoreBackup(userId, 'opencode');
  assert.deepEqual(JSON.parse(fs.readFileSync(harnessPath(userId, 'opencode'), 'utf8')), logins, 'both logins intact');
  assert.deepEqual(result.skipped, [{ target: 'anthropic', outcome: 'login_present' }]);
  const audit = audits.find((a) => a.action === 'vendor_key_backup_restored');
  assert.deepEqual(audit?.metadata.skipped, [{ target: 'anthropic', outcome: 'login_present' }]);
  assertNoSecretIn(result);
});

const CHATGPT_TOKENS = { id_token: 'id', access_token: 'access', refresh_token: 'refresh', account_id: 'acct' };

/** Backs up `before`, writes `now`, restores keys, and returns the resulting Codex file. */
async function restoreCodex(before: Record<string, unknown>, now: Record<string, unknown>) {
  const userId = String(userSeq++);
  writeHarness(userId, 'codex', before);
  const service = makeService();
  await service.ensureBackups(userId);
  writeHarness(userId, 'codex', now);
  await service.restoreBackup(userId, 'codex');
  return JSON.parse(fs.readFileSync(harnessPath(userId, 'codex'), 'utf8')) as Record<string, unknown>;
}

test('G2 N-2: a restored key never moves a ChatGPT login in effect onto the key', async () => {
  const after = await restoreCodex(
    { auth_mode: 'apikey', OPENAI_API_KEY: OPENAI_KEY, tokens: CHATGPT_TOKENS },
    { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CHATGPT_TOKENS },
  );
  assert.deepEqual(after, { auth_mode: 'chatgpt', OPENAI_API_KEY: OPENAI_KEY, tokens: CHATGPT_TOKENS },
    'the key is back, the backup\'s "apikey" is not copied over the login');
  const noMode = await restoreCodex({ OPENAI_API_KEY: OPENAI_KEY }, { tokens: CHATGPT_TOKENS });
  assert.equal(noMode.auth_mode, 'chatgpt', 'a mode-less login is pinned so the restored key does not take over');
});

test('G2 N-2: auth_mode follows the restored key — no key with tokens is chatgpt, a key alone is apikey', async () => {
  const keyGone = await restoreCodex(
    { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CHATGPT_TOKENS },
    { auth_mode: 'apikey', OPENAI_API_KEY: OPENAI_KEY, tokens: CHATGPT_TOKENS },
  );
  assert.deepEqual(keyGone, { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CHATGPT_TOKENS });
  const keyOnly = await restoreCodex(
    { auth_mode: 'chatgpt', OPENAI_API_KEY: OPENAI_KEY },
    { auth_mode: 'chatgpt', OPENAI_API_KEY: null },
  );
  assert.deepEqual(keyOnly, { auth_mode: 'apikey', OPENAI_API_KEY: OPENAI_KEY });
});

test('G2 N-3: the deletion marker blocks adoption even while the AES record still exists', async () => {
  const userId = String(userSeq++);
  writeHarness(userId, 'claude', { env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
  store.setCanonicalVendorKey(userId, 'anthropic', ANTHROPIC_KEY);
  store.setVendorMigrationState(userId, { v: 1, deletedVendors: { anthropic: '2026-10-09T00:00:00.000Z' } });
  const result = await makeService().run(userId);
  assert.equal(result.vendors.find((v) => v.vendorId === 'anthropic')?.outcome, 'deleted');
  assert.equal(store.readVendorLedgerState(userId, 'anthropic').state, 'absent', 'no ledger entry is adopted');
});
