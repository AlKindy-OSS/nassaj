/**
 * link-mode-switch-ledger.integration.test.ts — B-1574 (ADR-200 S10), the
 * production wiring end to end with nothing mocked: the real link-mode and
 * fan-out runtimes, the real Claude and Codex writers, the real AES store and
 * a real database with an isolated sharing policy.
 *
 *   D1. A key saved while the harness is on subscription, then projected by a
 *       switch to api_key, is ledgered like a fan-out write, so the vendor
 *       delete removes it (OAuth kept). A switch back to subscription drops
 *       the entry together with the key.
 *   D2. Deleting the Codex key over a ChatGPT login hands auth_mode back to
 *       "chatgpt", even when only a refresh token is stored.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME, CLAUDE_CONFIG_DIR, DATABASE_PATH.
import { assertInsideSandbox, removeSandbox } from './helpers/hermetic-sandbox.js';

const ANTHROPIC_KEY = 'sk' + '-ant-api03-B1574-DO-NOT-LEAK';
const OPENAI_KEY = 'sk' + '-proj-B1574-DO-NOT-LEAK';
const OAUTH = 'sk' + '-ant-oat01-B1574-OAUTH-DO-NOT-TOUCH';
const CODEX_TOKENS = { refresh_token: 'rt-B1574-DO-NOT-TOUCH', account_id: 'acc' };

process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');
process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) {
  delete process.env[name];
}

const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('@/services/provider-sharing.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const store = await import('@/services/isolation/provider-secrets-store.js');
const { harnessLinkModeService } = await import('../services/harness-link-mode.runtime.js');
const { vendorKeyFanoutService } = await import('../services/vendor-key-fanout.runtime.js');

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
const codexAuth = (id: number) => assertInsideSandbox(path.join(userConfigDir(id, '.codex'), 'auth.json'));

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;

function setSubscriptionMode(id: number, harness: 'claude' | 'codex'): void {
  store.setLinkModeRecord(id, harness, {
    v: 1, mode: 'subscription', source: 'user', projection: null, subscriptionFp: null, updatedAt: new Date(0).toISOString(),
  });
}

function ledgerEntry(id: number, vendorId: string, harness: string) {
  const read = store.readVendorLedgerState(id, vendorId);
  return read.state === 'ok' ? read.ledger.entries.find((entry) => entry.harness === harness && entry.target === null) : undefined;
}

const outcomeOf = (results: Array<{ provider: string; outcome: string }>, provider: string) =>
  results.find((result) => result.provider === provider)?.outcome;

function assertNoSecretIn(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [ANTHROPIC_KEY, OPENAI_KEY, OAUTH, CODEX_TOKENS.refresh_token]) {
    assert.equal(text.includes(secret), false, 'no credential is returned');
  }
}

/** Save while on subscription (nothing written), then switch the harness to api_key. */
async function saveThenSwitch(member: Member, harness: 'claude' | 'codex') {
  const [vendorId, key, slots] = harness === 'claude'
    ? ['anthropic', ANTHROPIC_KEY, ANTHROPIC_SLOTS] as const
    : ['openai', OPENAI_KEY, OPENAI_SLOTS] as const;
  const saved = await vendorKeyFanoutService.save(member.id, vendorId, key, {
    isElevated: false, slots, authenticatedPrincipal: member.principal,
  });
  assert.equal(outcomeOf(saved, harness), 'kept_on_subscription');
  assert.equal(ledgerEntry(member.id, vendorId, harness), undefined, 'nothing written, nothing ledgered');
  const switched = await harnessLinkModeService.switchMode(member.id, harness, {
    mode: 'api_key', confirm: true, authenticatedPrincipal: member.principal,
  });
  assert.equal(switched.outcome, 'linked');
  const entry = ledgerEntry(member.id, vendorId, harness);
  assert.deepEqual(
    [entry?.origin, entry?.state, entry?.fingerprint, entry?.keyVersion],
    ['fanout', 'synced', store.projectionFingerprint(key, store.PROJECTION_FINGERPRINT_KEY_VERSION),
      store.PROJECTION_FINGERPRINT_KEY_VERSION],
    `${harness}: the switch ledgers its projection`,
  );
  return { saved, switched };
}

test('B-1574 D1: Claude — save on subscription → switch to api_key → delete removes the key, OAuth kept', async () => {
  const member = newMember('b1574-claude');
  writeJson(claudeSettings(member.id), { theme: 'dark', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  setSubscriptionMode(member.id, 'claude');

  const { saved, switched } = await saveThenSwitch(member, 'claude');
  assert.equal(readJson(claudeSettings(member.id)).env.ANTHROPIC_API_KEY, ANTHROPIC_KEY);

  const removed = await vendorKeyFanoutService.remove(member.id, 'anthropic', { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.equal(outcomeOf(removed, 'claude'), 'removed', 'nassaj owns what its switch wrote');
  assert.equal(store.getCanonicalVendorKey(member.id, 'anthropic'), null);
  const settings = readJson(claudeSettings(member.id));
  assert.equal(settings.env.ANTHROPIC_API_KEY, undefined, 'the key is gone from settings.json');
  assert.equal(settings.env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH, 'the OAuth token is kept');
  assert.equal(settings.theme, 'dark');
  assert.equal(ledgerEntry(member.id, 'anthropic', 'claude'), undefined, 'the ledger is drained');
  assertNoSecretIn({ saved, switched, removed });
});

test('B-1574 D1+D2: Codex — save on subscription → switch to api_key → delete restores the ChatGPT login', async () => {
  const member = newMember('b1574-codex');
  const original = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS };
  writeJson(codexAuth(member.id), original);
  setSubscriptionMode(member.id, 'codex');

  const { saved, switched } = await saveThenSwitch(member, 'codex');
  const linked = readJson(codexAuth(member.id));
  assert.equal(linked.OPENAI_API_KEY, OPENAI_KEY);
  assert.deepEqual(linked.tokens, CODEX_TOKENS, 'tokens kept by the switch');

  const removed = await vendorKeyFanoutService.remove(member.id, 'openai', { isElevated: false, slots: OPENAI_SLOTS });
  assert.equal(outcomeOf(removed, 'codex'), 'removed');
  assert.equal(store.getCanonicalVendorKey(member.id, 'openai'), null);
  assert.deepEqual(readJson(codexAuth(member.id)), original, 'auth_mode back to "chatgpt", tokens intact');
  assert.equal(ledgerEntry(member.id, 'openai', 'codex'), undefined);
  assertNoSecretIn({ saved, switched, removed });
});

test('B-1574 D1: switching back to subscription removes the key and drops its ledger entry', async () => {
  const member = newMember('b1574-back');
  writeJson(claudeSettings(member.id), { env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  writeJson(codexAuth(member.id), { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: CODEX_TOKENS });
  setSubscriptionMode(member.id, 'claude');
  setSubscriptionMode(member.id, 'codex');

  for (const [harness, vendorId] of [['claude', 'anthropic'], ['codex', 'openai']] as const) {
    await saveThenSwitch(member, harness);
    const back = await harnessLinkModeService.switchMode(member.id, harness, {
      mode: 'subscription', confirm: true, authenticatedPrincipal: member.principal,
    });
    assert.equal(back.outcome, 'key_removed', `${harness}: nassaj's own projection is removed`);
    assert.equal(ledgerEntry(member.id, vendorId, harness), undefined, `${harness}: the entry goes with the key`);
  }
  assert.equal(readJson(claudeSettings(member.id)).env.ANTHROPIC_API_KEY, undefined);
  assert.equal(readJson(claudeSettings(member.id)).env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
  assert.equal(readJson(codexAuth(member.id)).auth_mode, 'chatgpt');

  // The AES records survive a mode switch; a later delete has nothing left to remove.
  const removed = await vendorKeyFanoutService.remove(member.id, 'anthropic', { isElevated: false, slots: ANTHROPIC_SLOTS });
  assert.equal(outcomeOf(removed, 'claude'), 'absent');
});
