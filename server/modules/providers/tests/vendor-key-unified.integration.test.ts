/**
 * vendor-key-unified.integration.test.ts — ADR-200 G2 (B-1570), the production
 * wiring end to end: the real migration and fan-out runtimes, the real
 * dispatcher gate (`withKeyWriteGate`: backup → link mode → (user, harness)
 * lock), the real Claude and Codex writers, the real AES store and a real
 * database with an isolated sharing policy. Nothing is mocked.
 *
 *   1. A deleted key never comes back: adopt → delete without confirm → the
 *      migration and the sweep run again (a restart) → the AES record stays
 *      absent. An explicit Save clears the deletion marker.
 *   2. A fan-out Save through the real gate takes the backup first, writes the
 *      key with the real writers (OAuth material kept), and records the
 *      projection in the link-mode record and the ledger.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME, CLAUDE_CONFIG_DIR, DATABASE_PATH.
import { assertInsideSandbox, removeSandbox } from './helpers/hermetic-sandbox.js';

const ANTHROPIC_KEY = 'sk' + '-ant-api03-INTEGRATION-DO-NOT-LEAK';
const OPENAI_KEY = 'sk' + '-proj-INTEGRATION-DO-NOT-LEAK';
const OAUTH = 'sk' + '-ant-oat01-INTEGRATION-OAUTH-DO-NOT-TOUCH';
const CODEX_REFRESH = 'rt-INTEGRATION-DO-NOT-TOUCH';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) {
  delete process.env[name];
}

const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('@/services/provider-sharing.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const store = await import('@/services/isolation/provider-secrets-store.js');
const { vendorKeyMigrationService } = await import('../services/vendor-key-migration.runtime.js');
const { vendorKeyFanoutService } = await import('../services/vendor-key-fanout.runtime.js');
const { listSweepMemberIds } = await import('../services/vendor-key-sweep-members.js');

await initializeDatabase();
_resetProviderSharingCache();
setProviderSharingConfig({ claude: 'isolated', codex: 'isolated', opencode: 'isolated' });
store._resetProviderSecretsServerKeyCache();

after(() => {
  closeConnection();
  removeSandbox();
});

const ANTHROPIC_SLOTS = [
  { vendorId: 'anthropic', provider: 'claude' },
  { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic' },
];
const OPENAI_SLOTS = [{ vendorId: 'openai', provider: 'codex' }];

type Member = { id: number; principal: Record<string, unknown> };

function newMember(name: string): Member {
  const user = userDb.createUser(name, 'hash', 'user') as { id: number };
  return {
    id: user.id,
    principal: { id: user.id, role: 'user', status: 'active', is_active: 1, authenticationKind: 'session', authorizationGeneration: 1 },
  };
}

const claudeSettings = (id: number) => assertInsideSandbox(path.join(userConfigDir(id, '.claude'), 'settings.json'));
const opencodeAuth = (id: number) => assertInsideSandbox(path.join(userConfigDir(id, '.local/share/opencode'), 'auth.json'));
const codexAuth = (id: number) => assertInsideSandbox(path.join(userConfigDir(id, '.codex'), 'auth.json'));

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;

function setApiKeyMode(id: number, harness: 'claude' | 'codex'): void {
  store.setLinkModeRecord(id, harness, {
    v: 1, mode: 'api_key', source: 'user', projection: null, subscriptionFp: null, updatedAt: new Date(0).toISOString(),
  });
}

function deletedVendors(id: number): Record<string, unknown> {
  const read = store.readVendorMigrationState(id);
  return read.state === 'ok' ? (read.record.deletedVendors as Record<string, unknown> | undefined) ?? {} : {};
}

const outcomeOf = (results: Array<{ provider: string; outcome: string }>, provider: string) =>
  results.find((result) => result.provider === provider)?.outcome;

function assertNoSecretIn(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [ANTHROPIC_KEY, OPENAI_KEY, OAUTH, CODEX_REFRESH]) {
    assert.equal(text.includes(secret), false, 'no credential is returned');
  }
}

test('G2 veto: a key deleted without confirm is not re-adopted after a restart; a Save clears the marker', async () => {
  const member = newMember('g2-resurrect');
  writeJson(claudeSettings(member.id), { env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } });

  const adopted = await vendorKeyMigrationService.run(member.id);
  assert.equal(adopted.vendors.find((v) => v.vendorId === 'anthropic')?.outcome, 'adopted');
  assert.equal(store.getCanonicalVendorKey(member.id, 'anthropic'), ANTHROPIC_KEY);

  const removed = await vendorKeyFanoutService.remove(member.id, 'anthropic', { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.equal(outcomeOf(removed, 'claude'), 'adopted_credential', 'the adopted value stays without confirm');
  assert.equal(store.getCanonicalVendorKey(member.id, 'anthropic'), null);
  assert.equal(readJson(claudeSettings(member.id)).env.ANTHROPIC_API_KEY, ANTHROPIC_KEY);

  // "Restart": the server-start migration and fan-out sweep, twice.
  for (let round = 0; round < 2; round += 1) {
    const rerun = await vendorKeyMigrationService.run(member.id);
    assert.equal(rerun.vendors.find((v) => v.vendorId === 'anthropic')?.outcome, 'deleted');
    await vendorKeyFanoutService.sweepMember(member.id);
    assert.equal(store.getCanonicalVendorKey(member.id, 'anthropic'), null, 'the AES record stays absent');
  }

  setApiKeyMode(member.id, 'claude');
  const saved = await vendorKeyFanoutService.save(member.id, 'anthropic', ANTHROPIC_KEY, {
    isElevated: false, slots: ANTHROPIC_SLOTS, authenticatedPrincipal: member.principal,
  });
  assert.equal(outcomeOf(saved, 'claude'), 'linked');
  assert.equal('anthropic' in deletedVendors(member.id), false, 'an explicit Save clears the marker');
  assert.equal((await vendorKeyMigrationService.run(member.id)).vendors.find((v) => v.vendorId === 'anthropic')?.outcome, 'unchanged');
  assertNoSecretIn({ adopted, removed, saved });
});

test('G2: a fan-out Save runs the real gate (backup, link mode, lock) and the real Claude and Codex writers', async () => {
  const member = newMember('g2-gate');
  const originalClaude = { theme: 'dark', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } };
  writeJson(claudeSettings(member.id), originalClaude);
  writeJson(codexAuth(member.id), { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { refresh_token: CODEX_REFRESH, account_id: 'acc' } });
  setApiKeyMode(member.id, 'claude');
  setApiKeyMode(member.id, 'codex');
  const options = { isElevated: false, authenticatedPrincipal: member.principal };

  const anthropic = await vendorKeyFanoutService.save(member.id, 'anthropic', ANTHROPIC_KEY, { ...options, slots: ANTHROPIC_SLOTS });
  const openai = await vendorKeyFanoutService.save(member.id, 'openai', OPENAI_KEY, { ...options, slots: OPENAI_SLOTS });
  assert.equal(outcomeOf(anthropic, 'claude'), 'linked');
  assert.equal(outcomeOf(openai, 'codex'), 'linked');

  const backup = store.readHarnessBackup(member.id, 'claude');
  assert.deepEqual(JSON.parse(backup!.bytes.toString('utf8')), originalClaude, 'the backup holds the file as it was');
  const settings = readJson(claudeSettings(member.id));
  assert.equal(settings.env.ANTHROPIC_API_KEY, ANTHROPIC_KEY);
  assert.equal(settings.env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH, 'the OAuth token is kept');
  const auth = readJson(codexAuth(member.id));
  assert.equal(auth.OPENAI_API_KEY, OPENAI_KEY);
  assert.equal(auth.tokens.refresh_token, CODEX_REFRESH, 'Codex tokens are kept');

  for (const [harness, key] of [['claude', ANTHROPIC_KEY], ['codex', OPENAI_KEY]] as const) {
    const record = store.getLinkModeRecord(member.id, harness) as { projection?: { fp?: string } } | null;
    assert.equal(record?.projection?.fp, store.projectionFingerprint(key, 1), `${harness}: the gate recorded the projection`);
  }
  const ledger = store.readVendorLedgerState(member.id, 'anthropic');
  const claudeEntry = ledger.state === 'ok' ? ledger.ledger.entries.find((entry) => entry.harness === 'claude') : undefined;
  assert.deepEqual([claudeEntry?.state, claudeEntry?.origin], ['synced', 'fanout']);
  assertNoSecretIn({ anthropic, openai });
});

test('G2: a restore under the real lock puts the key fields back and survives the next sweep', async () => {
  const member = newMember('g2-restore');
  writeJson(claudeSettings(member.id), { env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  setApiKeyMode(member.id, 'claude');
  await vendorKeyFanoutService.save(member.id, 'anthropic', ANTHROPIC_KEY, {
    isElevated: false, slots: ANTHROPIC_SLOTS, authenticatedPrincipal: member.principal,
  });
  assert.equal(readJson(claudeSettings(member.id)).env.ANTHROPIC_API_KEY, ANTHROPIC_KEY);

  const restored = await vendorKeyMigrationService.restoreBackup(member.id, 'claude');
  assert.equal(restored.mode, 'keys');
  await vendorKeyMigrationService.run(member.id);
  await vendorKeyFanoutService.sweepMember(member.id);
  const settings = readJson(claudeSettings(member.id));
  assert.equal(settings.env.ANTHROPIC_API_KEY, undefined, 'the sweep does not re-project over the restore');
  assert.equal(settings.env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
});

function opencodeLedgerEntry(id: number) {
  const ledger = store.readVendorLedgerState(id, 'anthropic');
  return ledger.state === 'ok' ? ledger.ledger.entries.find((entry) => entry.harness === 'opencode') : undefined;
}

test('B-1575: a key the user removed from OpenCode auth.json is not re-projected by the sweep', async () => {
  const member = newMember('b1575-opencode-removed');
  writeJson(opencodeAuth(member.id), { anthropic: { type: 'api', key: ANTHROPIC_KEY } });
  const adopted = await vendorKeyMigrationService.run(member.id);
  assert.equal(adopted.vendors.find((v) => v.vendorId === 'anthropic')?.outcome, 'adopted');
  assert.equal(opencodeLedgerEntry(member.id)?.origin, 'adopted');

  writeJson(opencodeAuth(member.id), {});
  for (let round = 0; round < 2; round += 1) {
    await vendorKeyMigrationService.run(member.id);
    await vendorKeyFanoutService.sweepMember(member.id);
    assert.deepEqual(readJson(opencodeAuth(member.id)), {}, 'the sweep leaves the emptied file alone');
    assert.equal(opencodeLedgerEntry(member.id), undefined, 'the stale entry is released from the ledger');
  }
  assert.equal(store.getCanonicalVendorKey(member.id, 'anthropic'), ANTHROPIC_KEY, 'the stored key is untouched');

  const saved = await vendorKeyFanoutService.save(member.id, 'anthropic', ANTHROPIC_KEY, {
    isElevated: false, slots: ANTHROPIC_SLOTS, authenticatedPrincipal: member.principal,
  });
  assert.equal(outcomeOf(saved, 'opencode'), 'linked', 'an explicit Save still projects');
  assert.equal(readJson(opencodeAuth(member.id)).anthropic?.key, ANTHROPIC_KEY);
  assert.deepEqual([opencodeLedgerEntry(member.id)?.state, opencodeLedgerEntry(member.id)?.origin], ['synced', 'fanout']);
  assertNoSecretIn({ adopted, saved });
});

test('B-1575: the background sweeps visit active members with an existing tree, and provision nobody', async () => {
  const withTree = newMember('b1575-active-tree');
  writeJson(claudeSettings(withTree.id), { theme: 'dark' });
  const noTree = newMember('b1575-active-no-tree');
  const disabled = newMember('b1575-disabled');
  writeJson(claudeSettings(disabled.id), { theme: 'dark' });
  userDb.setStatus(disabled.id, 'disabled');

  const visited = listSweepMemberIds();
  assert.equal(visited.includes(withTree.id), true);
  assert.equal(visited.includes(noTree.id), false, 'an active member without a tree is skipped');
  assert.equal(visited.includes(disabled.id), false, 'a disabled member is skipped');

  await vendorKeyMigrationService.runAll();
  await vendorKeyFanoutService.sweepAll();
  assert.equal(fs.existsSync(userConfigDir(noTree.id, '')), false, 'the sweep created no tree');
  assert.deepEqual(readJson(claudeSettings(disabled.id)), { theme: 'dark' }, 'a disabled member is untouched');
});
