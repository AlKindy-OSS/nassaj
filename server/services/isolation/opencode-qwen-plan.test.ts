/**
 * T-1906 / ADR-200 S7 — pure rules of the Token Plan carrier: model-list drift
 * against the Qwen provider, the always-deny env policy, the launch decision,
 * the inline config and the single redaction function.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// eslint-disable-next-line boundaries/dependencies -- drift test pins the provider's own model list.
import { QWEN_TOKEN_PLAN_MODELS } from '@/modules/providers/list/qwen/qwen.provider.js';

import {
  QWEN_PLAN_BASE_URL,
  QWEN_PLAN_KEY_ENV,
  QWEN_PLAN_MODELS,
  authorizeQwenPlanLaunch,
  buildQwenPlanConfigContent,
  createRedactingLineAssembler,
  isQwenPlanModel,
  qwenPlanProfileVerdict,
  redactLiteralSecrets,
  withQwenPlanEnv,
} from './opencode-qwen-plan.js';
import { isDeniedHostSecretEnvKey, sanitizeHostSecretEnv, sanitizeVendorAgentEnv } from './sanitize-vendor-agent-env.js';

// A Token Plan key carries no vendor prefix (ADR-200 D3).
const KEY = ['tp', 'unit-secret-0123456789abcdef'].join('-');
const LEGACY_KEY = ['sk', 'sp-unit-secret-0123456789abcdef'].join('-');
const good = { plan: 'token_plan', region: 'international', key: KEY };

test('drift: qwen-plan models mirror QWEN_TOKEN_PLAN_MODELS exactly', () => {
  assert.deepEqual(
    QWEN_PLAN_MODELS.map((model) => ({ ...model })),
    QWEN_TOKEN_PLAN_MODELS.OPTIONS.map((model) => ({ value: model.value, label: model.label })),
  );
});

test('the key variable and Alibaba namespaces are denied for every run', () => {
  for (const name of [QWEN_PLAN_KEY_ENV, 'BAILIAN_CODING_PLAN_API_KEY', 'bailian_token_plan_api_key', 'DASHSCOPE_API_KEY']) {
    assert.equal(isDeniedHostSecretEnvKey(name), true, name);
  }
  const env = { PATH: '/usr/bin', [QWEN_PLAN_KEY_ENV]: KEY, DASHSCOPE_API_KEY: 'd', BAILIAN_X: 'b', GLM_API_KEY: 'kept' };
  assert.deepEqual(sanitizeHostSecretEnv(env), { PATH: '/usr/bin', GLM_API_KEY: 'kept' });
  assert.deepEqual(sanitizeVendorAgentEnv(env), { PATH: '/usr/bin', GLM_API_KEY: 'kept' });
});

test('withQwenPlanEnv sets the key and the config after sanitizing, and nothing else', () => {
  const env = withQwenPlanEnv({ PATH: '/usr/bin' }, KEY);
  assert.deepEqual(Object.keys(env).sort(), ['OPENCODE_CONFIG_CONTENT', 'PATH', QWEN_PLAN_KEY_ENV].sort());
  assert.equal(env[QWEN_PLAN_KEY_ENV], KEY);
});

test('inline config: constant endpoint, {env:} key reference, no literal key, no enabled_providers', () => {
  const text = buildQwenPlanConfigContent();
  assert.ok(!text.includes(KEY));
  const config = JSON.parse(text);
  assert.equal(config.share, 'disabled');
  assert.equal(config.autoupdate, false);
  assert.equal(config.enabled_providers, undefined);
  const block = config.provider['qwen-plan'];
  assert.equal(block.npm, '@ai-sdk/openai-compatible');
  assert.equal(block.options.baseURL, QWEN_PLAN_BASE_URL);
  // D4: international region only — the same constant as qwen-cli.js token_plan.
  assert.equal(QWEN_PLAN_BASE_URL, 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(block.options.apiKey, `{env:${QWEN_PLAN_KEY_ENV}}`);
  assert.deepEqual(Object.keys(block.models), QWEN_PLAN_MODELS.map((model) => model.value));
});

test('model prefix detection', () => {
  assert.equal(isQwenPlanModel('qwen-plan/qwen3-coder-plus'), true);
  assert.equal(isQwenPlanModel(' qwen-plan/x'), true);
  assert.equal(isQwenPlanModel('qwen/qwen3-coder-plus'), false);
  assert.equal(isQwenPlanModel(undefined), false);
});

test('authorizeQwenPlanLaunch: kill switch, key and profile are required; no interactive marker', () => {
  const on = { NASSAJ_OPENCODE_QWEN_PLAN: '1' };
  const code = (fn: () => unknown) => {
    try { fn(); } catch (error) { return (error as { code?: string }).code; }
    return 'ok';
  };
  const getProfile = (id: string | number) => (String(id) === '7' ? good : null);
  assert.equal(code(() => authorizeQwenPlanLaunch({ userId: 7, env: {}, getProfile })), 'qwen_plan_disabled');
  assert.equal(code(() => authorizeQwenPlanLaunch({ userId: 7, env: { NASSAJ_OPENCODE_QWEN_PLAN: '0' }, getProfile })),
    'qwen_plan_disabled');
  assert.equal(code(() => authorizeQwenPlanLaunch({ userId: 8, env: on, getProfile })), 'missing_key');
  assert.equal(code(() => authorizeQwenPlanLaunch({ userId: null, env: on, getProfile })), 'missing_key');
  // Automation, resume and API-key turns carry no marker; the launch is allowed (D9).
  assert.deepEqual(authorizeQwenPlanLaunch({ userId: 7, env: on, getProfile }), { key: KEY });
});

test('a stored Coding Plan or non-international profile is a legacy_profile, never used', () => {
  const on = { NASSAJ_OPENCODE_QWEN_PLAN: '1' };
  const code = (profile: typeof good) => {
    try { authorizeQwenPlanLaunch({ userId: 7, env: on, getProfile: () => profile }); } catch (error) {
      return (error as { code?: string }).code;
    }
    return 'ok';
  };
  assert.equal(code({ plan: 'coding_plan', region: 'international', key: LEGACY_KEY }), 'legacy_profile');
  assert.equal(code({ ...good, region: 'china' }), 'legacy_profile');
  assert.equal(qwenPlanProfileVerdict({ plan: 'coding_plan', region: 'international', key: LEGACY_KEY }), 'legacy_profile');
  assert.equal(qwenPlanProfileVerdict(good), 'ok');
  assert.equal(qwenPlanProfileVerdict(null), 'missing_key');
});

test('redaction: every literal key and any sk-sp- token; non-strings untouched', () => {
  const other = 'member-two-token-plan-key-0011';
  assert.equal(redactLiteralSecrets(`a ${KEY} b ${other}`, [KEY, other]), 'a [REDACTED] b [REDACTED]');
  assert.equal(redactLiteralSecrets(`a ${KEY} b`, [KEY]), 'a [REDACTED] b');
  assert.equal(redactLiteralSecrets('other sk-sp-someoneElse123 key'), 'other [REDACTED] key');
  assert.equal(redactLiteralSecrets('custom-literal', ['custom-literal']), '[REDACTED]');
  assert.equal(redactLiteralSecrets(null, [KEY]), null);
  assert.equal(redactLiteralSecrets('sk-sp-'), 'sk-sp-');
  // Short or non-string entries are ignored, so ordinary text is never shredded.
  assert.equal(redactLiteralSecrets('a b c', ['a', '', null, 42]), 'a b c');
  // A key that contains another is replaced whole.
  assert.equal(redactLiteralSecrets(`${KEY}-suffix`, [KEY, `${KEY}-suffix`]), '[REDACTED]');
});

test('line assembler redacts a key split across two chunks', () => {
  const assembler = createRedactingLineAssembler([KEY]);
  const half = Math.floor(KEY.length / 2);
  assert.deepEqual(assembler.push(`x=${KEY.slice(0, half)}`), []);
  assert.deepEqual(assembler.push(`${KEY.slice(half)} y\nnext`), ['x=[REDACTED] y']);
  assert.deepEqual(assembler.flush(), ['next']);
  assert.deepEqual(assembler.flush(), []);
});
