/**
 * T-1906 — pure rules of the qwen-plan carrier: model-list drift against the
 * Qwen provider, the always-deny env policy, the launch decision, the inline
 * config and the single redaction function.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// eslint-disable-next-line boundaries/dependencies -- drift test pins the provider's own model list.
import { QWEN_CODING_PLAN_MODELS } from '@/modules/providers/list/qwen/qwen.provider.js';

import {
  QWEN_PLAN_BASE_URL,
  QWEN_PLAN_KEY_ENV,
  QWEN_PLAN_MODELS,
  authorizeQwenPlanLaunch,
  buildQwenPlanConfigContent,
  createRedactingLineAssembler,
  isQwenPlanModel,
  redactQwenPlanSecrets,
  withQwenPlanEnv,
} from './opencode-qwen-plan.js';
import { isDeniedHostSecretEnvKey, sanitizeHostSecretEnv, sanitizeVendorAgentEnv } from './sanitize-vendor-agent-env.js';

const KEY = ['sk', 'sp-unit-secret-0123456789abcdef'].join('-');
const good = { plan: 'coding_plan', region: 'international', key: KEY };

test('drift: qwen-plan models mirror QWEN_CODING_PLAN_MODELS exactly', () => {
  assert.deepEqual(
    QWEN_PLAN_MODELS.map((model) => ({ ...model })),
    QWEN_CODING_PLAN_MODELS.OPTIONS.map((model) => ({ value: model.value, label: model.label })),
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
  assert.ok(!text.includes('sk-sp-'));
  const config = JSON.parse(text);
  assert.equal(config.share, 'disabled');
  assert.equal(config.autoupdate, false);
  assert.equal(config.enabled_providers, undefined);
  const block = config.provider['qwen-plan'];
  assert.equal(block.npm, '@ai-sdk/openai-compatible');
  assert.equal(block.options.baseURL, QWEN_PLAN_BASE_URL);
  assert.equal(QWEN_PLAN_BASE_URL, 'https://coding-intl.dashscope.aliyuncs.com/v1');
  assert.equal(block.options.apiKey, `{env:${QWEN_PLAN_KEY_ENV}}`);
  assert.deepEqual(Object.keys(block.models), QWEN_PLAN_MODELS.map((model) => model.value));
});

test('model prefix detection', () => {
  assert.equal(isQwenPlanModel('qwen-plan/qwen3-coder-plus'), true);
  assert.equal(isQwenPlanModel(' qwen-plan/x'), true);
  assert.equal(isQwenPlanModel('qwen/qwen3-coder-plus'), false);
  assert.equal(isQwenPlanModel(undefined), false);
});

test('authorizeQwenPlanLaunch: flag, marker, key and profile are each required', () => {
  const on = { NASSAJ_OPENCODE_QWEN_PLAN: '1' };
  const code = (fn: () => unknown) => {
    try { fn(); } catch (error) { return (error as { code?: string }).code; }
    return 'ok';
  };
  const getProfile = (id: string | number) => (String(id) === '7' ? good : null);
  assert.equal(code(() => authorizeQwenPlanLaunch({ userId: 7, interactiveVerified: true, env: {}, getProfile })), 'qwen_plan_disabled');
  assert.equal(code(() => authorizeQwenPlanLaunch({ userId: 7, interactiveVerified: 'true', env: on, getProfile })), 'qwen_plan_not_interactive');
  assert.equal(code(() => authorizeQwenPlanLaunch({ userId: 8, interactiveVerified: true, env: on, getProfile })), 'missing_key');
  assert.equal(code(() => authorizeQwenPlanLaunch({ userId: null, interactiveVerified: true, env: on, getProfile })), 'missing_key');
  assert.equal(code(() => authorizeQwenPlanLaunch({
    userId: 7, interactiveVerified: true, env: on, getProfile: () => ({ ...good, plan: 'token_plan' }),
  })), 'incompatible_profile');
  assert.equal(code(() => authorizeQwenPlanLaunch({
    userId: 7, interactiveVerified: true, env: on, getProfile: () => ({ ...good, region: 'china' }),
  })), 'incompatible_profile');
  assert.deepEqual(authorizeQwenPlanLaunch({ userId: 7, interactiveVerified: true, env: on, getProfile }), { key: KEY });
});

test('redaction: literal key and any sk-sp- token; non-strings untouched', () => {
  assert.equal(redactQwenPlanSecrets(`a ${KEY} b`, KEY), 'a [REDACTED] b');
  assert.equal(redactQwenPlanSecrets('other sk-sp-someoneElse123 key'), 'other [REDACTED] key');
  assert.equal(redactQwenPlanSecrets('custom-literal', 'custom-literal'), '[REDACTED]');
  assert.equal(redactQwenPlanSecrets(null), null);
  assert.equal(redactQwenPlanSecrets('sk-sp-'), 'sk-sp-');
});

test('line assembler redacts a key split across two chunks', () => {
  const assembler = createRedactingLineAssembler(KEY);
  const half = Math.floor(KEY.length / 2);
  assert.deepEqual(assembler.push(`x=${KEY.slice(0, half)}`), []);
  assert.deepEqual(assembler.push(`${KEY.slice(half)} y\nnext`), ['x=[REDACTED] y']);
  assert.deepEqual(assembler.flush(), ['next']);
  assert.deepEqual(assembler.flush(), []);
});
