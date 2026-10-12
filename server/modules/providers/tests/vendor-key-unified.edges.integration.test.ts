/**
 * vendor-key-unified.edges.integration.test.ts — ADR-200 S10 (T-1998): the edge
 * and error cases of the production wiring, with the REAL runtimes, writers and
 * AES store in the hermetic sandbox (B-1544). Nothing is mocked.
 *
 *   1. The flag default is ON (unset and blank), `0`/`false`/`off` and any
 *      unrecognised value are the kill switch, and the T-unverified spawn-vendor
 *      cells need their own flag NASSAJ_OPENCODE_SPAWN_VENDORS (B-1575).
 *   2. Hostile or degenerate input never reaches a harness file: a Claude
 *      subscription token, a blank key, an unknown vendor, a non-member.
 *   3. A flag-off request is refused before anything is written.
 *   4. A second delete is idempotent and a delete never touches OAuth material.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME, CLAUDE_CONFIG_DIR, DATABASE_PATH.
import { assertInsideSandbox, removeSandbox } from './helpers/hermetic-sandbox.js';

const KEY = 'sk' + '-ant-api03-EDGES-DO-NOT-LEAK';
const OAUTH = 'sk' + '-ant-oat01-EDGES-OAUTH-DO-NOT-TOUCH';
const FLAG = 'NASSAJ_UNIFIED_VENDOR_KEYS';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');
delete process.env[FLAG];
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) {
  delete process.env[name];
}

const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('@/services/provider-sharing.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const store = await import('@/services/isolation/provider-secrets-store.js');
const { isOpencodeSpawnVendorsEnabled, spawnVendorRunOf } = await import('@/services/isolation/opencode-spawn-vendor.js');
const { vendorKeyFanoutService } = await import('../services/vendor-key-fanout.runtime.js');

await initializeDatabase();
_resetProviderSharingCache();
setProviderSharingConfig({ claude: 'isolated', codex: 'isolated', opencode: 'isolated' });
store._resetProviderSecretsServerKeyCache();

after(() => {
  delete process.env[FLAG];
  closeConnection();
  removeSandbox();
});

const SLOTS = [{ vendorId: 'anthropic', provider: 'claude' }];

function newMember(name: string) {
  const user = userDb.createUser(name, 'hash', 'user') as { id: number };
  return {
    id: user.id,
    principal: { id: user.id, role: 'user', status: 'active', is_active: 1, authenticationKind: 'session', authorizationGeneration: 1 },
  };
}

const claudeSettings = (id: number) => assertInsideSandbox(path.join(userConfigDir(id, '.claude'), 'settings.json'));
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;

function seedApiKeyMode(id: number, settings: unknown): void {
  fs.mkdirSync(path.dirname(claudeSettings(id)), { recursive: true });
  fs.writeFileSync(claudeSettings(id), JSON.stringify(settings, null, 2));
  store.setLinkModeRecord(id, 'claude', {
    v: 1, mode: 'api_key', source: 'user', projection: null, subscriptionFp: null, updatedAt: new Date(0).toISOString(),
  });
}

const optionsOf = (member: { principal: unknown }) => ({ isElevated: false, slots: SLOTS, authenticatedPrincipal: member.principal });

test('S10 flag default: unset and blank are ON; 0/false/no/off and unrecognised values are OFF', () => {
  assert.equal(store.isUnifiedVendorKeysEnabled({}), true, 'unset');
  assert.equal(store.isUnifiedVendorKeysEnabled({ [FLAG]: '' }), true, 'empty');
  assert.equal(store.isUnifiedVendorKeysEnabled({ [FLAG]: '   ' }), true, 'blank');
  for (const on of ['1', 'true', 'TRUE', ' yes ', 'On']) {
    assert.equal(store.isUnifiedVendorKeysEnabled({ [FLAG]: on }), true, on);
  }
  for (const off of ['0', 'false', 'FALSE', 'no', 'off', ' 0 ', 'disabled', 'nope', '2']) {
    assert.equal(store.isUnifiedVendorKeysEnabled({ [FLAG]: off }), false, `kill switch: ${off}`);
  }
});

test('B-1575: the T-unverified spawn-vendor cells need their own flag, on top of unified keys', () => {
  const SPAWN = 'NASSAJ_OPENCODE_SPAWN_VENDORS';
  assert.equal(isOpencodeSpawnVendorsEnabled({}), false, 'unset: default-ON unified keys do not arm them');
  assert.equal(isOpencodeSpawnVendorsEnabled({ [FLAG]: '1' }), false, 'unified keys alone do not arm them');
  for (const off of ['', '0', 'off', 'enabled', '2']) {
    assert.equal(isOpencodeSpawnVendorsEnabled({ [SPAWN]: off }), false, `spawn flag: ${off}`);
  }
  for (const on of ['1', 'true', ' YES ', 'On']) {
    assert.equal(isOpencodeSpawnVendorsEnabled({ [SPAWN]: on }), true, `spawn flag: ${on}`);
  }
  assert.equal(isOpencodeSpawnVendorsEnabled({ [SPAWN]: '1', [FLAG]: '0' }), false, 'the unified kill switch wins');
  assert.equal(spawnVendorRunOf('moonshot/kimi-k3', {}), null, 'a default-ON flag leaves Moonshot on the legacy path');
  assert.equal(spawnVendorRunOf('deepseek/deepseek-v4-pro', { [FLAG]: '1' }), null, 'and DeepSeek');
  assert.equal(spawnVendorRunOf('moonshot/kimi-k3', { [SPAWN]: '1' })?.id, 'moonshot');
  assert.equal(spawnVendorRunOf('deepseek/deepseek-v4-pro', { [SPAWN]: '1', [FLAG]: 'off' }), null);
});

test('S10 default ON: a Save works with the variable unset and keeps the OAuth token', async () => {
  const member = newMember('edge-default-on');
  seedApiKeyMode(member.id, { env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  const saved = await vendorKeyFanoutService.save(member.id, 'anthropic', KEY, optionsOf(member));
  assert.equal(saved.find((r) => r.provider === 'claude')?.outcome, 'linked');
  const settings = readJson(claudeSettings(member.id));
  assert.equal(settings.env.ANTHROPIC_API_KEY, KEY);
  assert.equal(settings.env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
});

test('S10 kill switch: with the flag at 0 a Save and a Delete are refused and write nothing', async () => {
  const member = newMember('edge-kill-switch');
  seedApiKeyMode(member.id, { env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  const before = fs.readFileSync(claudeSettings(member.id), 'utf8');
  process.env[FLAG] = '0';
  try {
    for (const run of [
      () => vendorKeyFanoutService.save(member.id, 'anthropic', KEY, optionsOf(member)),
      () => vendorKeyFanoutService.remove(member.id, 'anthropic', { isElevated: false, slots: SLOTS }),
    ]) {
      await assert.rejects(run(), (error: { code?: string }) => error.code === 'UNIFIED_VENDOR_KEYS_OFF');
    }
  } finally {
    delete process.env[FLAG];
  }
  assert.equal(fs.readFileSync(claudeSettings(member.id), 'utf8'), before, 'the harness file is byte-identical');
  assert.equal(store.getCanonicalVendorKey(member.id, 'anthropic'), null);
});

test('S10 hostile input: a subscription token, a blank key and an unknown vendor never reach a file', async () => {
  const member = newMember('edge-hostile');
  seedApiKeyMode(member.id, { env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  const before = fs.readFileSync(claudeSettings(member.id), 'utf8');
  await assert.rejects(vendorKeyFanoutService.save(member.id, 'anthropic', OAUTH, optionsOf(member)));
  await assert.rejects(vendorKeyFanoutService.save(member.id, 'anthropic', '   ', optionsOf(member)));
  await assert.rejects(vendorKeyFanoutService.save(member.id, 'no-such-vendor', KEY, optionsOf(member)));
  await assert.rejects(vendorKeyFanoutService.save(null, 'anthropic', KEY, optionsOf(member)), (e: { code?: string }) => e.code === 'MEMBER_REQUIRED');
  await assert.rejects(vendorKeyFanoutService.save('', 'anthropic', KEY, optionsOf(member)), (e: { code?: string }) => e.code === 'MEMBER_REQUIRED');
  assert.equal(fs.readFileSync(claudeSettings(member.id), 'utf8'), before);
  assert.equal(store.getCanonicalVendorKey(member.id, 'anthropic'), null);
});

test('S10 delete: a second delete is idempotent and OAuth material survives both', async () => {
  const member = newMember('edge-delete-twice');
  seedApiKeyMode(member.id, { env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  await vendorKeyFanoutService.save(member.id, 'anthropic', KEY, optionsOf(member));
  const options = { isElevated: false, slots: SLOTS };
  const first = await vendorKeyFanoutService.remove(member.id, 'anthropic', options);
  const second = await vendorKeyFanoutService.remove(member.id, 'anthropic', options);
  assert.equal(first.find((r) => r.provider === 'claude')?.outcome, 'removed');
  assert.ok(second.length > 0, 'the second delete still reports');
  const settings = readJson(claudeSettings(member.id));
  assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(settings.env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
  assert.equal(store.getCanonicalVendorKey(member.id, 'anthropic'), null);
});

test('S10 a provider without a projectable credential file is reported, not thrown through the runtime', async () => {
  const member = newMember('edge-terminal-only');
  const saved = await vendorKeyFanoutService.save(member.id, 'anthropic', KEY, {
    ...optionsOf(member), slots: [{ vendorId: 'anthropic', provider: 'kimi' }],
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].outcome, 'linked', 'an AES-only slot needs no projection');
  assert.equal(store.getCanonicalVendorKey(member.id, 'anthropic'), KEY);
});
