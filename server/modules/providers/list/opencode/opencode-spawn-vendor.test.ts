/**
 * ADR-200 S8 — the OpenCode Moonshot / DeepSeek spawn-time providers, unit level.
 *
 *  • a turn is a spawn-vendor run only under NASSAJ_OPENCODE_SPAWN_VENDORS
 *    with unified vendor keys on (B-1575);
 *  • the key is the sender's OWN slot: a grant holder (no own key) gets
 *    missing_key even when the grantor and the operator slot hold one;
 *  • a Claude subscription token is refused at injection (L2);
 *  • only the selected vendor's key is in the env, and the config text names it
 *    by {env:…}, with a constant OpenAI-wire base URL and no ANTHROPIC_* at all;
 *  • both new variable names are host secrets for every other run;
 *  • the inline-config guard admits only this turn's vendor origin;
 *  • the model ids mirror the measured vendor fallback catalogs.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, afterEach, test } from 'node:test';

// B-1544: must stay the first app-side import (HOME, DATABASE_PATH, harness roots).
import { removeSandbox } from '@/modules/providers/tests/helpers/hermetic-sandbox.js';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const spawnVendor = await import('@/services/isolation/opencode-spawn-vendor.js');
const sanitizer = await import('@/services/isolation/sanitize-vendor-agent-env.js');
const guard = await import('@/services/isolation/opencode-baseurl-guard.js');
const store = await import('@/services/isolation/provider-secrets-store.js');
const { providerSecretsService } = await import('@/modules/providers/services/provider-secrets.service.js');
const { KIMI_FALLBACK_MODELS, DEEPSEEK_FALLBACK_MODELS } = await import(
  '@/modules/providers/shared/vendor/vendor-config.js'
);
const { VENDOR_KEY_CATALOGUE } = await import('../../../../../shared/vendors.js');

const {
  OPENCODE_SPAWN_VENDORS: VENDORS,
  OPENCODE_SPAWN_VENDOR_KEY_ENVS,
  authorizeSpawnVendorLaunch,
  buildSpawnVendorConfigContent,
  canonicalSpawnVendorModel,
  spawnVendorAuditModel,
  spawnVendorOfModel,
  spawnVendorOrigins,
  spawnVendorRunOf,
  withSpawnVendorEnv,
} = spawnVendor;

const MOONSHOT_KEY = ['ms', 'live-secret-ABCDEFGHIJ0123456789'].join('-');
const DEEPSEEK_KEY = ['sk', 'ds-live-secret-0123456789ABCDEF'].join('-');
const FLAG = 'NASSAJ_OPENCODE_SPAWN_VENDORS';
const ORIGINAL_FLAG = process.env[FLAG];

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
  else process.env[FLAG] = ORIGINAL_FLAG;
});
after(() => removeSandbox());

test('a spawn-vendor run needs the prefix AND the spawn-vendor flag; flag off is the legacy path', () => {
  assert.equal(spawnVendorOfModel('moonshot/kimi-k2.6'), VENDORS.moonshot);
  assert.equal(spawnVendorOfModel(' deepseek/deepseek-v4-pro'), VENDORS.deepseek);
  for (const other of ['qwen-plan/qwen3.7-plus', 'glm/glm-5.2', 'moonshot', 'moonshotx/kimi', '/kimi', 'anthropic/x', '', null, 7]) {
    assert.equal(spawnVendorOfModel(other), null, String(other));
  }
  assert.equal(spawnVendorRunOf('moonshot/kimi-k2.6', {}), null);
  assert.equal(spawnVendorRunOf('deepseek/deepseek-v4-pro', { [FLAG]: '0' }), null);
  assert.equal(spawnVendorRunOf('deepseek/deepseek-v4-pro', { [FLAG]: 'true' }), VENDORS.deepseek);
  assert.equal(spawnVendorRunOf('deepseek/deepseek-v4-pro', { NASSAJ_UNIFIED_VENDOR_KEYS: '1' }), null);
  assert.equal(spawnVendorRunOf('deepseek/deepseek-v4-pro', { [FLAG]: '1', NASSAJ_UNIFIED_VENDOR_KEYS: '0' }), null);
});

test('B-1551 M2: case variants and models.dev aliases route to the canonical vendor', () => {
  for (const [model, row] of [
    ['Moonshot/kimi-k2.6', VENDORS.moonshot], ['MOONSHOTAI/Kimi-K3', VENDORS.moonshot],
    ['moonshotai/kimi-k2.7-code', VENDORS.moonshot], ['DEEPSEEK/deepseek-v4-pro', VENDORS.deepseek],
    ['moonshotai-cn/kimi-k2.6', VENDORS['moonshot-cn']], ['MoonshotAI-CN/kimi-k3', VENDORS['moonshot-cn']],
  ] as const) {
    assert.equal(spawnVendorOfModel(model), row, model);
    assert.equal(spawnVendorRunOf(model, { [FLAG]: 'on' }), row, model);
    assert.equal(spawnVendorRunOf(model, {}), null, `${model}: flag off stays legacy`);
  }
  assert.equal(canonicalSpawnVendorModel(' MOONSHOTAI/Kimi-K3 '), 'moonshot/kimi-k3');
  assert.equal(canonicalSpawnVendorModel('Deepseek/DeepSeek-V4-Flash'), 'deepseek/deepseek-v4-flash');
  assert.equal(canonicalSpawnVendorModel('moonshotai-cn/kimi-k2.6'), 'moonshot-cn/kimi-k2.6');
  assert.equal(canonicalSpawnVendorModel('moonshotai/kimi-unlisted'), 'moonshot/kimi-unlisted', 'unknown model part kept');
  assert.equal(canonicalSpawnVendorModel('glm/glm-5.2'), 'glm/glm-5.2', 'other ids unchanged');
  // The China alias has its own constant host, the same slot and key variable.
  const cn = VENDORS['moonshot-cn'];
  assert.equal(cn.baseUrl, 'https://api.moonshot.cn/v1');
  assert.equal(cn.slot, VENDORS.moonshot.slot);
  assert.equal(cn.keyEnv, VENDORS.moonshot.keyEnv);
  assert.equal(cn.offered, false, 'routed, never offered in the picker');
  const config = JSON.parse(buildSpawnVendorConfigContent(cn));
  assert.deepEqual(Object.keys(config.provider), ['moonshot-cn']);
  assert.equal(config.provider['moonshot-cn'].options.baseURL, 'https://api.moonshot.cn/v1');
  assert.deepEqual(spawnVendorOrigins(cn), { 'moonshot-cn': 'https://api.moonshot.cn/v1' });
});

test('B-1551 item 6: the audit model is the canonical catalog id, else the id cut to 128 chars', () => {
  assert.equal(spawnVendorAuditModel('MoonshotAI/KIMI-K2.6'), 'moonshot/kimi-k2.6');
  assert.equal(spawnVendorAuditModel('deepseek/deepseek-v4-pro'), 'deepseek/deepseek-v4-pro');
  assert.equal(spawnVendorAuditModel(' moonshot/not-listed '), 'moonshot/not-listed');
  const long = `deepseek/${'x'.repeat(300)}`;
  assert.equal(spawnVendorAuditModel(long), long.slice(0, 128));
  assert.equal(spawnVendorAuditModel(undefined), '');
});

test('authorize: the sender key only; missing or subscription keys are refused without the key', () => {
  const keys: Record<string, string> = { '7:kimi': ` ${MOONSHOT_KEY} ` };
  const getOwnKey = (userId: string | number, slot: string) => keys[`${userId}:${slot}`] ?? null;
  assert.deepEqual(authorizeSpawnVendorLaunch({ vendor: VENDORS.moonshot, userId: 7, getOwnKey }), { key: MOONSHOT_KEY });
  for (const userId of [8, null, undefined, '']) {
    assert.throws(
      () => authorizeSpawnVendorLaunch({ vendor: VENDORS.moonshot, userId, getOwnKey }),
      (error: any) => error.code === 'missing_key',
    );
  }
  // DeepSeek's slot is separate: a Moonshot key never serves a DeepSeek turn.
  assert.throws(
    () => authorizeSpawnVendorLaunch({ vendor: VENDORS.deepseek, userId: 7, getOwnKey }),
    (error: any) => error.code === 'missing_key',
  );
  const token = ['sk', 'ant', 'oat02', 'abcdefghijklmnop'].join('-');
  assert.throws(
    () => authorizeSpawnVendorLaunch({ vendor: VENDORS.deepseek, userId: 7, getOwnKey: () => token }),
    (error: any) => error.code === 'subscription_token_refused' && !error.message.includes(token),
  );
});

test('the env carries only the selected vendor key; config names it by {env:} on the OpenAI wire', () => {
  const inherited = { PATH: '/usr/bin', NASSAJ_DEEPSEEK_API_KEY: DEEPSEEK_KEY, NASSAJ_MOONSHOT_API_KEY: 'stale' };
  const env = withSpawnVendorEnv(inherited, VENDORS.moonshot, MOONSHOT_KEY);
  assert.equal(env.NASSAJ_MOONSHOT_API_KEY, MOONSHOT_KEY);
  assert.equal(env.NASSAJ_DEEPSEEK_API_KEY, undefined, 'the other vendor key is removed');
  assert.equal(inherited.NASSAJ_MOONSHOT_API_KEY, 'stale', 'input env is not mutated');
  const text = String(env.OPENCODE_CONFIG_CONTENT);
  assert.ok(!text.includes(MOONSHOT_KEY), 'config never holds the literal key');
  assert.ok(!/anthropic/i.test(text), 'no Anthropic routing in the config');
  assert.ok(!Object.keys(env).some((name) => name.startsWith('ANTHROPIC_')));
  const config = JSON.parse(text);
  assert.deepEqual(Object.keys(config.provider), ['moonshot']);
  assert.equal(config.share, 'disabled');
  assert.equal(config.provider.moonshot.npm, '@ai-sdk/openai-compatible');
  assert.equal(config.provider.moonshot.options.baseURL, 'https://api.moonshot.ai/v1');
  assert.equal(config.provider.moonshot.options.apiKey, '{env:NASSAJ_MOONSHOT_API_KEY}');
  const deepseek = JSON.parse(buildSpawnVendorConfigContent(VENDORS.deepseek));
  assert.equal(deepseek.provider.deepseek.options.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(deepseek.provider.deepseek.options.apiKey, '{env:NASSAJ_DEEPSEEK_API_KEY}');
});

test('both new variable names are host secrets, scrubbed from every run', () => {
  assert.deepEqual([...OPENCODE_SPAWN_VENDOR_KEY_ENVS].sort(), ['NASSAJ_DEEPSEEK_API_KEY', 'NASSAJ_MOONSHOT_API_KEY']);
  const host = { PATH: '/usr/bin', NASSAJ_MOONSHOT_API_KEY: MOONSHOT_KEY, nassaj_deepseek_api_key: DEEPSEEK_KEY };
  for (const name of OPENCODE_SPAWN_VENDOR_KEY_ENVS) {
    assert.ok(sanitizer.NASSAJ_HOST_SECRET_EXACT_DENY.includes(name), name);
    assert.equal(sanitizer.isDeniedHostSecretEnvKey(name), true, name);
  }
  for (const cleaned of [sanitizer.sanitizeHostSecretEnv(host), sanitizer.sanitizeVendorAgentEnv(host)]) {
    assert.ok(!JSON.stringify(cleaned).includes(MOONSHOT_KEY));
    assert.ok(!JSON.stringify(cleaned).includes(DEEPSEEK_KEY));
    assert.equal(cleaned.PATH, '/usr/bin');
  }
});

test('the inline-config guard admits only this turn\'s vendor origin', () => {
  const moonshotEnv = withSpawnVendorEnv({}, VENDORS.moonshot, MOONSHOT_KEY);
  guard.assertOpenCodeInlineConfigAllowed(moonshotEnv, spawnVendorOrigins(VENDORS.moonshot));
  guard.assertOpenCodeInlineConfigAllowed({}, {});
  const refused = (env: Record<string, string>, origins: Record<string, string>) => assert.throws(
    () => guard.assertOpenCodeInlineConfigAllowed(env, origins),
    (error: any) => error.code === guard.OPENCODE_BASEURL_NOT_ALLOWED,
  );
  // The moonshot block on a DeepSeek turn has no approved origin.
  refused(moonshotEnv, spawnVendorOrigins(VENDORS.deepseek));
  refused(moonshotEnv, {});
  // A tampered block (competitor host, or an extra block) fails closed.
  const tampered = JSON.parse(String(moonshotEnv.OPENCODE_CONFIG_CONTENT));
  tampered.provider.moonshot.options.baseURL = 'https://evil.example/v1';
  refused({ OPENCODE_CONFIG_CONTENT: JSON.stringify(tampered) }, spawnVendorOrigins(VENDORS.moonshot));
  const extra = JSON.parse(String(moonshotEnv.OPENCODE_CONFIG_CONTENT));
  extra.provider.anthropic = { options: { baseURL: 'https://api.moonshot.ai/anthropic' } };
  refused({ OPENCODE_CONFIG_CONTENT: JSON.stringify(extra) }, spawnVendorOrigins(VENDORS.moonshot));
  refused({ OPENCODE_CONFIG_CONTENT: '{not json' }, spawnVendorOrigins(VENDORS.moonshot));
});

test('model ids mirror the measured vendor fallback catalogs; catalogue env names match', () => {
  assert.deepEqual(VENDORS.moonshot.models.map((model) => model.value), KIMI_FALLBACK_MODELS.OPTIONS.map((o) => o.value));
  assert.deepEqual(VENDORS.deepseek.models.map((model) => model.value), DEEPSEEK_FALLBACK_MODELS.OPTIONS.map((o) => o.value));
  for (const row of Object.values(VENDORS).filter((vendor) => vendor.offered)) {
    const catalogueRow = VENDOR_KEY_CATALOGUE.find((entry) => entry.id === row.id);
    const cell = catalogueRow?.consumers.find((consumer) => consumer.how === 'spawn_provider');
    assert.deepEqual(cell?.delivery, { kind: 'spawn', env: row.keyEnv }, row.id);
    assert.equal(catalogueRow?.secretId, row.slot, row.id);
    assert.equal(cell?.keyOwner, 'sender');
    assert.equal(cell?.sharedFallback, false);
  }
});

test('getOwnVendorKey: a grant holder never reads the grantor or the operator slot', () => {
  const grantor = 501;
  const holder = 502;
  store.setProviderKey(grantor, 'kimi', MOONSHOT_KEY);
  store.setSharedVendorKey('deepseek', DEEPSEEK_KEY);
  assert.equal(providerSecretsService.getOwnVendorKey(grantor, 'kimi'), MOONSHOT_KEY);
  assert.equal(providerSecretsService.getOwnVendorKey(holder, 'kimi'), null);
  assert.equal(providerSecretsService.getOwnVendorKey(holder, 'deepseek'), null, 'no operator fallback');
  assert.equal(providerSecretsService.getOwnVendorKey(null, 'deepseek'), null, 'no identity, no key');
  const ownKey = ['ms', 'holder-own-0123456789'].join('-');
  store.setProviderKey(holder, 'kimi', ownKey);
  assert.equal(providerSecretsService.getOwnVendorKey(holder, 'kimi'), ownKey);
});
