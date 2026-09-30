/** T-1906 — the qwen-plan model overlay (static list, caller's own key, flag-gated). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProviderModelsDefinition } from '@/shared/types.js';

import { withQwenPlanModels } from './opencode-models.provider.js';

const base: ProviderModelsDefinition = {
  OPTIONS: [{ value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }],
  DEFAULT: 'anthropic/claude-sonnet-4-5',
};
const good = { plan: 'coding_plan', region: 'international', key: 'sk-sp-0123456789abcdef' };
const on = { NASSAJ_OPENCODE_QWEN_PLAN: 'true' };

describe('withQwenPlanModels (T-1906)', () => {
  it('offers the static qwen-plan list to a caller with a compatible key while the flag is on', () => {
    const merged = withQwenPlanModels(base, good, on);
    assert.equal(merged.DEFAULT, base.DEFAULT);
    assert.ok(merged.OPTIONS.some((option) => option.value === 'qwen-plan/qwen3-coder-plus'));
    assert.ok(!JSON.stringify(merged).includes(good.key));
  });

  it('offers nothing without a key, with an incompatible profile, or with the flag off', () => {
    for (const [profile, env] of [
      [null, on], [{ ...good, plan: 'token_plan' }, on], [{ ...good, region: 'china' }, on], [good, {}],
    ] as const) {
      const merged = withQwenPlanModels(base, profile, env);
      assert.ok(!merged.OPTIONS.some((option) => option.value.startsWith('qwen-plan/')));
    }
  });

  it('strips a stale qwen-plan entry from a cached catalog for a caller without a key', () => {
    const stale = { ...base, OPTIONS: [...base.OPTIONS, { value: 'qwen-plan/qwen3.7-plus', label: 'x' }] };
    const merged = withQwenPlanModels(stale, null, on);
    assert.deepEqual(merged.OPTIONS.map((option) => option.value), ['anthropic/claude-sonnet-4-5']);
  });

  it('returns the same object when nothing changes (cache identity preserved)', () => {
    assert.equal(withQwenPlanModels(base, null, {}), base);
  });
});
