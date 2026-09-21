import assert from 'node:assert/strict';
import test from 'node:test';

import { CODEX_FALLBACK_MODELS } from '../codex-models.provider.js';

test('Codex fallback catalog is degraded so it is refreshed after the short TTL', () => {
  assert.equal(CODEX_FALLBACK_MODELS.degraded, true);
});
