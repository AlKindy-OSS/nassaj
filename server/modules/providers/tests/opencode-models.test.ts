import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenCodeDefinitionFromIds,
  parseOpenCodeModelsStdout,
  withGlmCarrierModels,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

test('OpenCode models provider parses plain CLI output and removes duplicates', () => {
  const ids = parseOpenCodeModelsStdout(`
opencode/big-pickle
not a model
anthropic/claude-opus-4-7-fast
anthropic/claude-opus-4-7-fast
openai/gpt-5.5-pro
`);

  assert.deepEqual(ids, [
    'opencode/big-pickle',
    'anthropic/claude-opus-4-7-fast',
    'openai/gpt-5.5-pro',
  ]);
});

test('OpenCode models provider formats frontend labels from provider-prefixed ids', () => {
  const definition = buildOpenCodeDefinitionFromIds([
    'opencode/deepseek-v4-flash-free',
    'opencode/nemotron-3-super-free',
    'anthropic/claude-3-5-sonnet-20241022',
    'anthropic/claude-opus-4-7-fast',
    'openai/gpt-5.4-mini-fast',
    'openai/gpt-5.5-pro',
    'newprovider/alpha-v12-special-20261231',
  ]);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'Deepseek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
    },
    {
      value: 'opencode/nemotron-3-super-free',
      label: 'Nemotron 3 Super Free',
      description: 'opencode - opencode/nemotron-3-super-free',
    },
    {
      value: 'anthropic/claude-3-5-sonnet-20241022',
      label: 'Claude 3.5 Sonnet (2024-10-22)',
      description: 'anthropic - anthropic/claude-3-5-sonnet-20241022',
    },
    {
      value: 'anthropic/claude-opus-4-7-fast',
      label: 'Claude Opus 4.7 Fast',
      description: 'anthropic - anthropic/claude-opus-4-7-fast',
    },
    {
      value: 'openai/gpt-5.4-mini-fast',
      label: 'GPT-5.4 Mini Fast',
      description: 'openai - openai/gpt-5.4-mini-fast',
    },
    {
      value: 'openai/gpt-5.5-pro',
      label: 'GPT-5.5 Pro',
      description: 'openai - openai/gpt-5.5-pro',
    },
    {
      value: 'newprovider/alpha-v12-special-20261231',
      label: 'Alpha V12 Special (2026-12-31)',
      description: 'newprovider - newprovider/alpha-v12-special-20261231',
    },
  ]);
});

/**
 * The GLM fold (owner decision 2026-07-26): GLM is reachable ONLY as a model
 * inside OpenCode, so the OpenCode catalog must carry its models — and carry
 * them from the LIVE `opencode models` output, not from a pinned list.
 *
 * Verbatim excerpt of the real command's output on this node, 2026-07-27, AFTER the
 * B-220/B-221 config fix: lines 22-24 and the last two lines of the 60-line listing.
 * Not synthesized — and it carries the B-219 trap for real. `opencode/glm-5.2` is
 * opencode's own paid Zen route (it answers 401 "No payment method") and
 * `glm/glm-5.2` is our z.ai carrier; two different endpoints, two different bills,
 * and `labelForOpenCodeModelId` formats BOTH to the string "GLM 5.2".
 */
const LIVE_MODELS_STDOUT = `
opencode/glm-5
opencode/glm-5.1
opencode/glm-5.2
opencode/qwen3.6-plus
glm/glm-5.2
`;

test('live catalog parses the real provider-prefixed ids, in order, deduped', () => {
  assert.deepEqual(parseOpenCodeModelsStdout(LIVE_MODELS_STDOUT), [
    'opencode/glm-5',
    'opencode/glm-5.1',
    'opencode/glm-5.2',
    'opencode/qwen3.6-plus',
    'glm/glm-5.2',
  ]);
});

test('B-219: two providers sharing a model slug can never render the same label', () => {
  const definition = buildOpenCodeDefinitionFromIds(parseOpenCodeModelsStdout(LIVE_MODELS_STDOUT));
  const labelOf = (value: string) => definition.OPTIONS.find((o) => o.value === value)?.label;

  // The colliding pair is disambiguated by the half that was being dropped.
  assert.equal(labelOf('opencode/glm-5.2'), 'GLM 5.2 (opencode)');
  assert.equal(labelOf('glm/glm-5.2'), 'GLM 5.2 (glm)');

  // Non-colliding labels are left exactly as they were — no cosmetic churn.
  assert.equal(labelOf('opencode/glm-5'), 'GLM 5');
  assert.equal(labelOf('opencode/glm-5.1'), 'GLM 5.1');
  assert.equal(labelOf('opencode/qwen3.6-plus'), 'Qwen3.6 Plus');

  // The invariant, stated once over the whole catalog: labels are a unique key.
  const labels = definition.OPTIONS.map((o) => o.label);
  assert.equal(new Set(labels).size, labels.length, 'every label must be unique');
});

test('B-219: the rule is general — it breaks a collision between any two providers', () => {
  // Nothing GLM-specific: the same slug under two unrelated providers must separate.
  const definition = buildOpenCodeDefinitionFromIds([
    'openrouter/gpt-5.1',
    'openai/gpt-5.1',
    'openai/gpt-5.4-mini',
  ]);
  const labelOf = (value: string) => definition.OPTIONS.find((o) => o.value === value)?.label;

  assert.equal(labelOf('openrouter/gpt-5.1'), 'GPT-5.1 (openrouter)');
  assert.equal(labelOf('openai/gpt-5.1'), 'GPT-5.1 (openai)');
  assert.equal(labelOf('openai/gpt-5.4-mini'), 'GPT-5.4 Mini', 'untouched: no collision');
});

test('B-219: a collision the provider name cannot break falls back to the raw id', () => {
  // Same provider, two ids that format to one label — the residual case. The value is
  // unique by construction, so it is the guaranteed-terminating fallback.
  const definition = buildOpenCodeDefinitionFromIds(['acme/gpt-5.1', 'acme/gpt-5-1']);
  const labels = definition.OPTIONS.map((o) => o.label);

  assert.deepEqual(labels.slice().sort(), ['acme/gpt-5-1', 'acme/gpt-5.1']);
  assert.equal(new Set(labels).size, labels.length, 'still unique after the fallback');
});

test('the carrier merge keeps labels unique across the combined catalog', () => {
  // The pinned carrier list is what INTRODUCES the cross-provider collision when the
  // live catalog has not yet picked the carrier up, so uniqueness must survive the merge.
  const live = buildOpenCodeDefinitionFromIds([
    'opencode/glm-5.2',
    'opencode/qwen3.6-plus',
  ]);
  const merged = withGlmCarrierModels(live, { NASSAJ_OPENCODE_CARRIER: '1' });

  const values = merged.OPTIONS.map((option) => option.value);
  assert.deepEqual(values, [...new Set(values)], 'no duplicate model ids after the merge');
  assert.equal(merged.OPTIONS.find((o) => o.value === 'opencode/glm-5.2')?.label, 'GLM 5.2 (opencode)');
  assert.equal(merged.OPTIONS.find((o) => o.value === 'glm/glm-5.2')?.label, 'GLM 5.2 (glm)');

  const labels = merged.OPTIONS.map((o) => o.label);
  assert.equal(new Set(labels).size, labels.length, 'every label unique after the merge');
});

test('the pinned carrier list never duplicates a model the live catalog already lists', () => {
  const live = buildOpenCodeDefinitionFromIds(parseOpenCodeModelsStdout(LIVE_MODELS_STDOUT));
  const merged = withGlmCarrierModels(live, { NASSAJ_OPENCODE_CARRIER: '1' });

  const values = merged.OPTIONS.map((option) => option.value);
  assert.deepEqual(values, [...new Set(values)], 'no duplicate model ids after the fallback merge');
  // Live labels win the value collision; disambiguation still applies on top.
  assert.equal(merged.OPTIONS.find((o) => o.value === 'glm/glm-5.2')?.label, 'GLM 5.2 (glm)');
});

/**
 * Bracket-variant NOTATION regression. The fixture below is the real pre-B-220 live
 * output (2026-07-26): `glm/glm-5.2[1m]` no longer exists anywhere — B-220 deleted it
 * as a phantom (z.ai answers `1211 Unknown Model`) — but the brackets are opencode's
 * own variant notation and can reappear for ANY provider, and the parser regex used to
 * drop every `[…]` id silently. Kept as a pinned regression for that regex, explicitly
 * NOT as a claim that this id is live.
 */
const HISTORICAL_BRACKET_VARIANT_STDOUT = `
opencode/qwen3.6-plus
glm/glm-5.2[1m]
`;

test('the parser keeps bracketed variant ids instead of silently dropping them', () => {
  assert.deepEqual(parseOpenCodeModelsStdout(HISTORICAL_BRACKET_VARIANT_STDOUT), [
    'opencode/qwen3.6-plus',
    'glm/glm-5.2[1m]',
  ]);

  const definition = buildOpenCodeDefinitionFromIds(
    parseOpenCodeModelsStdout(HISTORICAL_BRACKET_VARIANT_STDOUT),
  );
  assert.equal(
    definition.OPTIONS.find((o) => o.value === 'glm/glm-5.2[1m]')?.label,
    'GLM 5.2 (1M)',
    'the variant is peeled off before tokenizing, so brand-casing still applies',
  );
});
