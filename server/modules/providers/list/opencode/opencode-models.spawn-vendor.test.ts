/** ADR-200 S8 — the in-flag Moonshot / DeepSeek model overlay (caller's own keys only). */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

// B-1544: must stay the first app-side import (HOME, DATABASE_PATH, harness roots).
import { removeSandbox } from '@/modules/providers/tests/helpers/hermetic-sandbox.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';

const { withSpawnVendorModels } = await import('./opencode-models.provider.js');

after(() => removeSandbox());

const base: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    // opencode's own built-in DeepSeek entry (auth.json) — same prefix.
    { value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
  ],
  DEFAULT: 'deepseek/deepseek-chat',
};
const on = { NASSAJ_OPENCODE_SPAWN_VENDORS: 'true' };
const values = (definition: ProviderModelsDefinition) => definition.OPTIONS.map((option) => option.value);

describe('withSpawnVendorModels (ADR-200 S8)', () => {
  it('flag off returns the definition unchanged, whatever keys the caller holds', () => {
    assert.equal(withSpawnVendorModels(base, { moonshot: true, deepseek: true }, {}), base);
  });

  it('B-1575: the unified vendor-key flag alone does not offer them', () => {
    assert.equal(withSpawnVendorModels(base, { moonshot: true }, { NASSAJ_UNIFIED_VENDOR_KEYS: '1' }), base);
    assert.equal(withSpawnVendorModels(base, { moonshot: true }, { ...on, NASSAJ_UNIFIED_VENDOR_KEYS: '0' }), base);
  });

  it('offers only the vendors whose key the caller holds, replacing same-prefix entries', () => {
    const merged = withSpawnVendorModels(base, { moonshot: true }, on);
    assert.ok(values(merged).includes('moonshot/kimi-k2.6'));
    assert.ok(!values(merged).some((value) => value.startsWith('deepseek/')));
    assert.equal(merged.DEFAULT, 'anthropic/claude-sonnet-4-5', 'a hidden default falls back');
    const both = withSpawnVendorModels(base, { moonshot: true, deepseek: true }, on);
    assert.ok(values(both).includes('deepseek/deepseek-v4-pro'));
    assert.ok(!values(both).includes('deepseek/deepseek-chat'));
  });

  it('a caller without keys sees no moonshot/ or deepseek/ entry', () => {
    const merged = withSpawnVendorModels(base, {}, on);
    assert.deepEqual(values(merged), ['anthropic/claude-sonnet-4-5']);
  });

  it('B-1551 M2: built-in moonshotai/, moonshotai-cn/ and case variants are hidden; only canonical ids shown', () => {
    const builtIns: ProviderModelsDefinition = {
      OPTIONS: [
        ...base.OPTIONS,
        { value: 'moonshotai/kimi-k2-0905-preview', label: 'Kimi K2' },
        { value: 'moonshotai-cn/kimi-k2-turbo-preview', label: 'Kimi K2 Turbo' },
        { value: 'Moonshot/kimi-k2.6', label: 'Kimi upper' },
        { value: 'DEEPSEEK/deepseek-reasoner', label: 'DeepSeek upper' },
      ],
      DEFAULT: 'anthropic/claude-sonnet-4-5',
    };
    const merged = withSpawnVendorModels(builtIns, { moonshot: true, deepseek: true, 'moonshot-cn': true }, on);
    const shown = values(merged).filter((value) => value !== 'anthropic/claude-sonnet-4-5');
    assert.ok(shown.length > 0);
    assert.ok(shown.every((value) => /^(moonshot|deepseek)\/[a-z0-9.-]+$/.test(value)), shown.join(','));
    assert.ok(!shown.some((value) => value.startsWith('moonshot-cn/')), 'the China row is routed, never offered');
    assert.deepEqual(values(withSpawnVendorModels(builtIns, {}, on)), ['anthropic/claude-sonnet-4-5']);
  });
});
