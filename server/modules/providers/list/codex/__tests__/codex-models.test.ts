import assert from 'node:assert/strict';
import test from 'node:test';

import { CODEX_FALLBACK_MODELS, isListedCodexModel } from '../codex-models.provider.js';

test('Codex fallback catalog is degraded so it is refreshed after the short TTL', () => {
  assert.equal(CODEX_FALLBACK_MODELS.degraded, true);
});

test('Codex models marked hide or hidden stay out of the picker', () => {
  assert.equal(isListedCodexModel({ slug: 'gpt-reserve', visibility: 'hide' }), false);
  assert.equal(isListedCodexModel({ slug: 'old-internal', visibility: 'hidden' }), false);
  assert.equal(isListedCodexModel({ slug: 'gpt-5', visibility: 'list' }), true);
  assert.equal(isListedCodexModel({ slug: 'no-api', visibility: 'list', supported_in_api: false }), false);
});
