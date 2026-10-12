/**
 * vendor-key-fanout.service.test.ts — ADR-200 S6: Save (every outcome code),
 * ownership (foreign and adopted untouched without confirm), Delete with a
 * failed projection retried after a restart, the ledger outliving the key until
 * its tombstones drain, and rotation. Real AES store and real harness files,
 * all inside the hermetic sandbox (B-1544); the gate and writer are a fake over
 * those files with the same field semantics as the real writers.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME so keys.json never lands in the real one.
import { assertInsideSandbox, removeSandbox, sandboxRoot } from '../tests/helpers/hermetic-sandbox.js';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';

const store = await import('@/services/isolation/provider-secrets-store.js');
const { AppError } = await import('@/shared/utils.js');
const { createVendorKeyFanoutService } = await import('./vendor-key-fanout.service.js');
type FanoutDeps = import('./vendor-key-fanout.service.js').VendorKeyFanoutDeps;
type FanoutSlot = import('./vendor-key-fanout.service.js').FanoutSlot;
type LedgerEntry = import('./vendor-key-migration.service.js').LedgerEntry;
store._resetProviderSecretsServerKeyCache();

type Harness = 'claude' | 'codex' | 'opencode';
type Mode = 'subscription' | 'api_key' | 'unset';

const KEY = 'sk' + '-ant-api03-FANOUT-KEY-0001';
const NEW_KEY = 'sk' + '-ant-api03-ROTATED-KEY-0002';
const FOREIGN = 'sk' + '-ant-api03-FOREIGN-KEY-0003';
const OPENAI_KEY = 'sk' + '-proj-FANOUT-OPENAI-0004';
const ZAI_KEY = 'zai-FANOUT-KEY-0005';
const OAUTH = 'sk' + '-ant-oat01-SUBSCRIPTION-DO-NOT-TOUCH';
const ALL_SECRETS = [KEY, NEW_KEY, FOREIGN, OPENAI_KEY, ZAI_KEY, OAUTH];

const ANTHROPIC_SLOTS: FanoutSlot[] = [
  { vendorId: 'anthropic', provider: 'claude' },
  { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic' },
];
const OPENAI_SLOTS: FanoutSlot[] = [
  { vendorId: 'openai', provider: 'codex' },
  { vendorId: 'openai-opencode', provider: 'opencode', target: 'openai' },
];
const ZAI_SLOTS: FanoutSlot[] = [
  { vendorId: 'zai', provider: 'glm' },
  { vendorId: 'zai-opencode', provider: 'opencode', target: 'glm' },
];

let modes: Record<'claude' | 'codex', Mode> = { claude: 'api_key', codex: 'api_key' };
let failing = new Set<string>();
let shared = new Set<string>();
let elevatedOnly = new Set<string>();
let audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
let userSeq = 500;

const FILES: Record<Harness, string> = { claude: 'claude/settings.json', codex: 'codex/auth.json', opencode: 'opencode/auth.json' };

function filePath(userId: string | number, harness: Harness): string {
  return assertInsideSandbox(path.join(sandboxRoot, 'fanout-trees', String(userId), FILES[harness]));
}

function readJson(userId: string | number, harness: Harness): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(filePath(userId, harness), 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(userId: string | number, harness: Harness, value: unknown): void {
  const file = filePath(userId, harness);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function keyIn(json: Record<string, any>, harness: Harness, target?: string): string | null {
  if (harness === 'claude') return json.env?.ANTHROPIC_API_KEY ?? null;
  if (harness === 'codex') return json.OPENAI_API_KEY ?? null;
  const record = json[target ?? 'anthropic'];
  return record?.type === 'api' ? record.key ?? null : null;
}

function refuse(code: string): never {
  throw new AppError(`refused: ${code}`, { code, statusCode: 409 });
}

function failIf(op: string, provider: string, target?: string): void {
  if (failing.has(`${op}:${provider}:${target ?? ''}`)) throw new Error('simulated I/O failure');
}

/** Same field semantics as the real writers: API-key fields only, logins refused. */
function putKey(userId: string | number, harness: Harness, key: string | null, target?: string): void {
  const json = readJson(userId, harness);
  if (harness === 'claude') {
    json.env = { ...(json.env ?? {}) };
    if (key === null) delete json.env.ANTHROPIC_API_KEY;
    else json.env.ANTHROPIC_API_KEY = key;
  } else if (harness === 'codex') {
    if (key === null) json.OPENAI_API_KEY = null;
    else json.OPENAI_API_KEY = key;
  } else {
    const slot = target ?? 'anthropic';
    if (json[slot] && json[slot].type !== 'api') refuse('CREDENTIAL_IS_LOGIN');
    if (key === null) delete json[slot];
    else json[slot] = { type: 'api', key };
  }
  writeJson(userId, harness, json);
}

function canonicalOf(secretId: string): string | null {
  return secretId.startsWith('vendor:') ? secretId.slice('vendor:'.length) : null;
}

function makeService() {
  const deps: FanoutDeps = {
    isEnabled: () => store.isUnifiedVendorKeysEnabled(),
    fingerprint: (value, version) => store.projectionFingerprint(value, version),
    keyVersion: 1,
    now: () => new Date('2026-10-09T00:00:00.000Z'),
    listMemberIds: () => [...members],
    isOwnScope: (provider) => !shared.has(provider),
    requiresElevatedRole: (provider) => elevatedOnly.has(provider),
    projections: {
      async withWriteGate(_userId, provider, _key, work) {
        if (provider === 'claude' || provider === 'codex') {
          if (modes[provider] === 'subscription') refuse('LINK_MODE_SUBSCRIPTION');
          if (modes[provider] === 'unset') refuse('LINK_MODE_UNSET');
        }
        return work();
      },
      withDeleteGate: async (_userId, _provider, work) => work(),
      async read(userId, provider, target) {
        failIf('read', provider, target);
        return keyIn(readJson(userId, provider as Harness), provider as Harness, target);
      },
      async write(userId, provider, key, target) {
        failIf('write', provider, target);
        putKey(userId, provider as Harness, key, target);
      },
      async remove(userId, provider, target) {
        failIf('remove', provider, target);
        putKey(userId, provider as Harness, null, target);
      },
    },
    secrets: {
      write(userId, secretId, key) {
        const vendor = canonicalOf(secretId);
        if (vendor) store.setCanonicalVendorKey(userId, vendor, key);
        else store.setProviderKey(userId, secretId as 'glm', key);
      },
      remove(userId, secretId) {
        const vendor = canonicalOf(secretId);
        if (vendor) store.deleteCanonicalVendorKey(userId, vendor);
        else store.deleteProviderKey(userId, secretId as 'glm');
      },
      readState(userId, secretId) {
        const read = store.readVendorKeyState(userId, secretId) as
          { state: 'absent' } | { state: 'unreadable' } | { state: 'ok'; value: string };
        return read.state === 'ok' ? read : { state: read.state };
      },
    },
    audit: (_userId, action, metadata) => { audits.push({ action, metadata }); },
  };
  return createVendorKeyFanoutService(deps);
}

const members = new Set<string>();

function newMember(): string {
  const userId = String(userSeq++);
  members.add(userId);
  return userId;
}

function ledger(userId: string, vendorId: string): LedgerEntry[] | null {
  const read = store.readVendorLedgerState(userId, vendorId);
  return read.state === 'ok' ? read.ledger.entries as LedgerEntry[] : null;
}

function entryFor(userId: string, vendorId: string, harness: Harness, target: string | null = null): LedgerEntry | undefined {
  return ledger(userId, vendorId)?.find((entry) => entry.harness === harness && entry.target === target);
}

const outcomes = (results: Array<{ vendorId: string; outcome: string }>) =>
  Object.fromEntries(results.map((result) => [result.vendorId, result.outcome]));

function assertNoSecretIn(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of ALL_SECRETS) assert.equal(text.includes(secret), false, 'no key value is returned or audited');
}

after(() => removeSandbox());

beforeEach(() => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  modes = { claude: 'api_key', codex: 'api_key' };
  failing = new Set();
  shared = new Set();
  elevatedOnly = new Set();
  audits = [];
  members.clear();
});

test('save writes the AES record, projects each slot, verifies and records the ledger', async () => {
  const userId = newMember();
  writeJson(userId, 'claude', { theme: 'dark', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  const results = await makeService().save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });

  assert.deepEqual(outcomes(results), { anthropic: 'linked', 'anthropic-opencode': 'linked' });
  assert.equal(store.getCanonicalVendorKey(userId, 'anthropic'), KEY);
  const claude = readJson(userId, 'claude');
  assert.equal(claude.env.ANTHROPIC_API_KEY, KEY);
  assert.equal(claude.env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH, 'the subscription token is never touched');
  assert.equal(claude.theme, 'dark');
  assert.ok(Object.keys(claude.env).every((name) => !name.endsWith('_BASE_URL')), 'iron rule: no base URL is written');
  assert.equal(entryFor(userId, 'anthropic', 'claude')?.state, 'synced');
  assert.equal(entryFor(userId, 'anthropic', 'opencode', 'anthropic')?.origin, 'fanout');
  assert.equal(audits.at(-1)?.action, 'vendor_key_saved');
  assertNoSecretIn({ results, audits, ledger: ledger(userId, 'anthropic') });
});

test('every save outcome code is produced', async () => {
  const seen = new Set<string>();
  const service = makeService();

  const a = newMember();
  modes.claude = 'subscription';
  writeJson(a, 'opencode', { anthropic: { type: 'oauth', refresh: 'oc-refresh' } });
  (await service.save(a, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS })).forEach((r) => seen.add(r.outcome));
  assert.deepEqual(readJson(a, 'opencode').anthropic, { type: 'oauth', refresh: 'oc-refresh' }, 'a login is never overwritten');
  assert.equal(readJson(a, 'claude').env, undefined, 'a subscription-mode harness gets no key');

  const b = newMember();
  modes.codex = 'unset';
  writeJson(b, 'opencode', { openai: { type: 'api', key: FOREIGN } });
  (await service.save(b, 'openai', OPENAI_KEY, { isElevated: false, slots: OPENAI_SLOTS })).forEach((r) => seen.add(r.outcome));

  const c = newMember();
  elevatedOnly = new Set(['claude']);
  shared = new Set(['claude', 'opencode']);
  (await service.save(c, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS })).forEach((r) => seen.add(r.outcome));
  elevatedOnly = new Set();

  const d = newMember();
  shared = new Set();
  failing = new Set(['write:opencode:glm']);
  (await service.save(d, 'zai', ZAI_KEY, { isElevated: false, slots: ZAI_SLOTS })).forEach((r) => seen.add(r.outcome));

  for (const code of ['linked', 'kept_on_subscription', 'mode_unset', 'login_present', 'shared_scope_refused',
    'foreign_credential', 'forbidden', 'failed']) {
    assert.ok(seen.has(code), `outcome ${code} is produced`);
  }
  assert.equal(entryFor(d, 'zai', 'opencode', 'glm')?.state, 'failed');
});

test('a Claude subscription token is refused before anything is written', async () => {
  const userId = newMember();
  await assert.rejects(
    makeService().save(userId, 'anthropic', 'sk' + '-ant-oat07-FUTURE-GEN-TOKEN', { isElevated: false, slots: ANTHROPIC_SLOTS }),
    (error: unknown) => (error as { code?: string }).code === 'SUBSCRIPTION_TOKEN_FORBIDDEN_TARGET',
  );
  assert.equal(store.getCanonicalVendorKey(userId, 'anthropic'), null);
  assert.equal(fs.existsSync(filePath(userId, 'opencode')), false);
});

test('a foreign value is untouched without confirm and replaced only with it', async () => {
  const userId = newMember();
  writeJson(userId, 'opencode', { anthropic: { type: 'api', key: FOREIGN } });
  const service = makeService();

  const first = await service.save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.equal(outcomes(first)['anthropic-opencode'], 'foreign_credential');
  assert.equal(readJson(userId, 'opencode').anthropic.key, FOREIGN);
  assert.equal(entryFor(userId, 'anthropic', 'opencode', 'anthropic'), undefined);

  const confirmed = await service.save(userId, 'anthropic', KEY, {
    isElevated: false, replaceForeignKey: true, slots: ANTHROPIC_SLOTS,
  });
  assert.equal(outcomes(confirmed)['anthropic-opencode'], 'linked');
  assert.equal(readJson(userId, 'opencode').anthropic.key, KEY);
  assert.equal(entryFor(userId, 'anthropic', 'opencode', 'anthropic')?.origin, 'fanout');
});

test('rotation is the same save: owned projections are replaced, an unchanged key rewrites nothing', async () => {
  const userId = newMember();
  const service = makeService();
  await service.save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  const before = fs.statSync(filePath(userId, 'opencode')).mtimeMs;
  const bytes = fs.readFileSync(filePath(userId, 'opencode'));
  await service.save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.deepEqual(fs.readFileSync(filePath(userId, 'opencode')), bytes);
  assert.equal(fs.statSync(filePath(userId, 'opencode')).mtimeMs, before, 'an idempotent save writes nothing');

  const rotated = await service.save(userId, 'anthropic', NEW_KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.deepEqual(outcomes(rotated), { anthropic: 'linked', 'anthropic-opencode': 'linked' });
  assert.equal(readJson(userId, 'claude').env.ANTHROPIC_API_KEY, NEW_KEY);
  assert.equal(entryFor(userId, 'anthropic', 'claude')?.fingerprint, store.projectionFingerprint(NEW_KEY, 1));
});

/** Seeds what S5's migration leaves behind: the AES record and an `adopted` ledger entry. */
function seedAdopted(userId: string): void {
  writeJson(userId, 'opencode', { anthropic: { type: 'api', key: KEY } });
  store.setCanonicalVendorKey(userId, 'anthropic', KEY);
  store.setVendorLedger(userId, 'anthropic', { v: 1, entries: [{
    harness: 'opencode', target: 'anthropic', fingerprint: store.projectionFingerprint(KEY, 1),
    keyVersion: 1, state: 'synced', origin: 'adopted', updatedAt: '2026-10-08T00:00:00.000Z',
  }] });
}

test('an adopted projection survives a delete without confirm and goes with it', async () => {
  const userId = newMember();
  seedAdopted(userId);
  writeJson(userId, 'claude', { env: { ANTHROPIC_API_KEY: FOREIGN, CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  const service = makeService();

  const kept = await service.remove(userId, 'anthropic', { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.deepEqual(outcomes(kept), { anthropic: 'foreign_credential', 'anthropic-opencode': 'adopted_credential' });
  assert.equal(readJson(userId, 'opencode').anthropic.key, KEY, 'adopted: untouched without confirm');
  assert.equal(readJson(userId, 'claude').env.ANTHROPIC_API_KEY, FOREIGN, 'foreign: untouched without confirm');
  assert.equal(store.getCanonicalVendorKey(userId, 'anthropic'), null, 'the AES record is removed');
  assert.equal(entryFor(userId, 'anthropic', 'opencode', 'anthropic')?.origin, 'adopted', 'the adopted entry stays listed');

  const confirmed = await service.remove(userId, 'anthropic', { isElevated: false, removeForeignKey: true, slots: ANTHROPIC_SLOTS });
  assert.deepEqual(outcomes(confirmed), { anthropic: 'removed', 'anthropic-opencode': 'removed' });
  assert.equal(readJson(userId, 'opencode').anthropic, undefined);
  const claude = readJson(userId, 'claude');
  assert.equal(claude.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(claude.env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH, 'deletion removes ANTHROPIC_API_KEY only');
  assert.equal(ledger(userId, 'anthropic'), null);
  assertNoSecretIn({ kept, confirmed, audits });
});

test('an adopted projection is replaced by a save (only its deletion needs a confirm)', async () => {
  const userId = newMember();
  seedAdopted(userId);
  const results = await makeService().save(userId, 'anthropic', NEW_KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.equal(outcomes(results)['anthropic-opencode'], 'linked');
  assert.equal(readJson(userId, 'opencode').anthropic.key, NEW_KEY);
  assert.equal(entryFor(userId, 'anthropic', 'opencode', 'anthropic')?.origin, 'fanout');
});

test('a delete with one failed projection is retried after a restart; the ledger outlives the key', async () => {
  const userId = newMember();
  await makeService().save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });

  failing = new Set(['remove:opencode:anthropic']);
  const removed = await makeService().remove(userId, 'anthropic', { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.deepEqual(outcomes(removed), { anthropic: 'removed', 'anthropic-opencode': 'failed' });
  assert.equal(store.getCanonicalVendorKey(userId, 'anthropic'), null, 'the key is gone');
  assert.equal(readJson(userId, 'claude').env.ANTHROPIC_API_KEY, undefined);
  assert.equal(entryFor(userId, 'anthropic', 'opencode', 'anthropic')?.state, 'tombstone', 'the ledger outlives the key');

  // Still failing at the next start: the tombstone survives the sweep.
  await makeService().sweepAll();
  assert.equal(entryFor(userId, 'anthropic', 'opencode', 'anthropic')?.state, 'tombstone');
  assert.equal(readJson(userId, 'opencode').anthropic.key, KEY);

  // "Restart": a fresh service instance over the same store and files.
  failing = new Set();
  const swept = await makeService().sweepAll();
  assert.deepEqual(swept, { status: 'done', failed: 0 });
  assert.equal(readJson(userId, 'opencode').anthropic, undefined, 'the projection is removed on retry');
  assert.equal(ledger(userId, 'anthropic'), null, 'drained: the ledger goes once its tombstones do');
});

test('a tombstone never removes a value that changed since it was marked', async () => {
  const userId = newMember();
  await makeService().save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  failing = new Set(['remove:opencode:anthropic']);
  await makeService().remove(userId, 'anthropic', { isElevated: false, slots: ANTHROPIC_SLOTS });
  writeJson(userId, 'opencode', { anthropic: { type: 'api', key: FOREIGN } });
  failing = new Set();
  await makeService().sweepAll();
  assert.equal(readJson(userId, 'opencode').anthropic.key, FOREIGN);
  assert.equal(ledger(userId, 'anthropic'), null);
});

test('a failed save is retried by the sweep at server start', async () => {
  const userId = newMember();
  failing = new Set(['write:opencode:anthropic']);
  const results = await makeService().save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.equal(outcomes(results)['anthropic-opencode'], 'failed');
  assert.equal(entryFor(userId, 'anthropic', 'opencode', 'anthropic')?.state, 'failed');

  failing = new Set();
  await makeService().sweepAll();
  assert.equal(readJson(userId, 'opencode').anthropic.key, KEY);
  assert.equal(entryFor(userId, 'anthropic', 'opencode', 'anthropic')?.state, 'synced');
});

test('B-1575: a stale entry whose file the user emptied is released by the sweep, not rewritten', async () => {
  const userId = newMember();
  await makeService().save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  writeJson(userId, 'opencode', {});
  const entries = ledger(userId, 'anthropic') ?? [];
  store.setVendorLedger(userId, 'anthropic', { v: 1, entries: entries.map((entry) => (
    entry.harness === 'opencode' ? { ...entry, state: 'stale' as const } : entry
  )) });
  await makeService().sweepAll();
  assert.deepEqual(readJson(userId, 'opencode'), {}, 'the emptied file stays empty');
  assert.equal(entryFor(userId, 'anthropic', 'opencode', 'anthropic'), undefined);
  assert.equal(entryFor(userId, 'anthropic', 'claude')?.state, 'synced', 'other projections are untouched');
});

test('a key removed while the flag was off tombstones its fan-out projections at the next sweep', async () => {
  const userId = newMember();
  await makeService().save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  store.deleteCanonicalVendorKey(userId, 'anthropic');
  await makeService().sweepAll();
  assert.equal(readJson(userId, 'claude').env.ANTHROPIC_API_KEY, undefined);
  assert.equal(readJson(userId, 'opencode').anthropic, undefined);
  assert.equal(ledger(userId, 'anthropic'), null);
});

test('a shared tree is never written or removed (shared_scope_refused)', async () => {
  const userId = newMember();
  shared = new Set(['opencode']);
  const saved = await makeService().save(userId, 'zai', ZAI_KEY, { isElevated: true, slots: ZAI_SLOTS });
  assert.deepEqual(outcomes(saved), { zai: 'linked', 'zai-opencode': 'shared_scope_refused' });
  assert.equal(store.getProviderKey(userId, 'glm'), ZAI_KEY);
  assert.equal(fs.existsSync(filePath(userId, 'opencode')), false);
  const removed = await makeService().remove(userId, 'zai', { isElevated: true, slots: ZAI_SLOTS });
  assert.deepEqual(outcomes(removed), { zai: 'removed', 'zai-opencode': 'shared_scope_refused' });
  assert.equal(store.getProviderKey(userId, 'glm'), null);
});

test('the service refuses with the flag off and without a member', async () => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  await assert.rejects(makeService().save('7', 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS }),
    (error: unknown) => (error as { code?: string }).code === 'UNIFIED_VENDOR_KEYS_OFF');
  assert.deepEqual(await makeService().sweepAll(), { status: 'flag_off', failed: 0 });
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  await assert.rejects(makeService().remove(null, 'anthropic', { isElevated: false, slots: ANTHROPIC_SLOTS }),
    (error: unknown) => (error as { code?: string }).code === 'MEMBER_REQUIRED');
});

/** Replaces one keys.json entry with an envelope that does not decrypt (wrong server key, tampering). */
function corruptEntry(userId: string, storageKey: string): void {
  const file = assertInsideSandbox(path.join(sandboxRoot, 'home', '.nassaj-users', userId, '.provider-secrets', 'keys.json'));
  const keys = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  keys[storageKey] = 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA';
  fs.writeFileSync(file, JSON.stringify(keys));
}

test('G2: an undecryptable AES record is skipped by the sweep, never read as a deleted key', async () => {
  const userId = newMember();
  await makeService().save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  const before = ledger(userId, 'anthropic');
  corruptEntry(userId, 'vendor:anthropic');
  assert.equal(store.readVendorKeyState(userId, 'vendor:anthropic').state, 'unreadable');

  assert.deepEqual(await makeService().sweepAll(), { status: 'done', failed: 0 });
  assert.deepEqual(ledger(userId, 'anthropic'), before, 'nothing is tombstoned');
  assert.equal(readJson(userId, 'claude').env.ANTHROPIC_API_KEY, KEY, 'nothing is removed');
  assert.equal(readJson(userId, 'opencode').anthropic.key, KEY);
});

test('G2: a delete records the deletion marker and an explicit save clears it', async () => {
  const userId = newMember();
  const deleted = () => {
    const read = store.readVendorMigrationState(userId);
    return read.state === 'ok' ? (read.record.deletedVendors as Record<string, string> | undefined) ?? {} : {};
  };
  await makeService().save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  await makeService().remove(userId, 'anthropic', { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.equal(deleted().anthropic, '2026-10-09T00:00:00.000Z');
  await makeService().save(userId, 'anthropic', KEY, { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.equal('anthropic' in deleted(), false);
});
