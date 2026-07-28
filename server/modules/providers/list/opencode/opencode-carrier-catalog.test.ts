import assert from 'node:assert/strict';
import test from 'node:test';

import { GLM_CARRIER_MODELS } from '@/modules/providers/shared/vendor/vendor-config.js';

import {
  OPENCODE_CARRIER_PROVIDER_ID,
  OPENCODE_FALLBACK_MODELS,
  buildGlmCarrierModelOptions,
  isOpenCodeCarrierEnabled,
  withGlmCarrierModels,
} from './opencode-models.provider.js';

test('GL-9: buildGlmCarrierModelOptions shapes GLM models as opencode glm/<id> options', () => {
  const options = buildGlmCarrierModelOptions();
  const entries = Object.entries(GLM_CARRIER_MODELS);

  assert.equal(options.length, entries.length);
  assert.ok(entries.length > 0, 'GLM carrier catalog must not be empty');

  for (const [modelId, { name }] of entries) {
    const value = `${OPENCODE_CARRIER_PROVIDER_ID}/${modelId}`;
    const option = options.find((candidate) => candidate.value === value);
    assert.ok(option, `expected carrier option for ${value}`);
    assert.equal(option?.label, name);
    assert.equal(option?.description, `${OPENCODE_CARRIER_PROVIDER_ID} - ${value}`);
    // A GLM carrier model must NEVER masquerade as an Anthropic built-in (OCC-2).
    assert.ok(!value.startsWith('anthropic/'), 'carrier model id must not collide with anthropic/*');
  }
});

test('GL-9: isOpenCodeCarrierEnabled defaults OFF and only truthy tokens enable it', () => {
  assert.equal(isOpenCodeCarrierEnabled({}), false);
  assert.equal(isOpenCodeCarrierEnabled({ NASSAJ_OPENCODE_CARRIER: '' }), false);
  assert.equal(isOpenCodeCarrierEnabled({ NASSAJ_OPENCODE_CARRIER: '0' }), false);
  assert.equal(isOpenCodeCarrierEnabled({ NASSAJ_OPENCODE_CARRIER: 'off' }), false);
  assert.equal(isOpenCodeCarrierEnabled({ NASSAJ_OPENCODE_CARRIER: 'false' }), false);

  for (const raw of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(
      isOpenCodeCarrierEnabled({ NASSAJ_OPENCODE_CARRIER: raw }),
      true,
      `expected ${JSON.stringify(raw)} to enable the carrier`,
    );
  }
});

test('GL-9: withGlmCarrierModels is a byte-for-byte identity when the carrier flag is OFF', () => {
  const merged = withGlmCarrierModels(OPENCODE_FALLBACK_MODELS, {});
  // Same reference: no carrier options leak in when the flag is off (backward compat).
  assert.equal(merged, OPENCODE_FALLBACK_MODELS);
});

test('GL-9: withGlmCarrierModels appends carrier options and preserves DEFAULT when flag ON', () => {
  const merged = withGlmCarrierModels(OPENCODE_FALLBACK_MODELS, { NASSAJ_OPENCODE_CARRIER: '1' });

  // DEFAULT is never disturbed by the carrier merge.
  assert.equal(merged.DEFAULT, OPENCODE_FALLBACK_MODELS.DEFAULT);

  // Every original option is preserved, in order, ahead of the carrier options.
  for (let i = 0; i < OPENCODE_FALLBACK_MODELS.OPTIONS.length; i += 1) {
    assert.deepEqual(merged.OPTIONS[i], OPENCODE_FALLBACK_MODELS.OPTIONS[i]);
  }

  // Every carrier option is present after the originals.
  for (const carrierOption of buildGlmCarrierModelOptions()) {
    assert.ok(
      merged.OPTIONS.some((option) => option.value === carrierOption.value),
      `expected carrier option ${carrierOption.value} in merged catalog`,
    );
  }

  assert.equal(
    merged.OPTIONS.length,
    OPENCODE_FALLBACK_MODELS.OPTIONS.length + buildGlmCarrierModelOptions().length,
  );
});

test('GL-9: withGlmCarrierModels dedups on a value collision (live catalog wins)', () => {
  const [firstCarrier] = buildGlmCarrierModelOptions();
  const liveDefinition = {
    OPTIONS: [
      // A live catalog that already lists the same glm/<id>, with its own label.
      { value: firstCarrier.value, label: 'Live GLM label', description: 'live authoritative' },
    ],
    DEFAULT: firstCarrier.value,
  };

  const merged = withGlmCarrierModels(liveDefinition, { NASSAJ_OPENCODE_CARRIER: 'true' });

  const matches = merged.OPTIONS.filter((option) => option.value === firstCarrier.value);
  assert.equal(matches.length, 1, 'no duplicate row for a colliding carrier id');
  assert.equal(matches[0]?.label, 'Live GLM label', 'the live catalog entry wins the collision');
});
