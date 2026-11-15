/**
 * localModelSlot.test.ts — T-2107 stage 5 / T-2108: a local model picked for a new
 * Codex or DeepSeek Harness chat survives the boot sanitizer and the catalog
 * reconcile (the B-235 class of silent swap, found in the browser check: the pick
 * reverted to the body's default).
 *
 * Run: node --import tsx/esm --test src/components/chat/hooks/localModelSlot.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CODEX_FALLBACK_MODELS,
  DSH_FALLBACK_MODELS,
  PROVIDER_FALLBACK_MODELS,
} from '../../../constants/providerModelFallbacks';

import { localSlotCatalog, sanitizeLocalSlotModel } from './localModelSlot';

const LOCAL = 'nassaj_local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/qwen3-coder:30b';

describe('codex-model and dsh-model slots', () => {
  it('keep a local model id at boot', () => {
    assert.equal(sanitizeLocalSlotModel('codex', LOCAL), LOCAL);
    assert.equal(sanitizeLocalSlotModel('dsh', LOCAL), LOCAL);
  });

  it('still normalize an unknown cloud id to the body default', () => {
    assert.equal(sanitizeLocalSlotModel('codex', 'not-a-model'), CODEX_FALLBACK_MODELS.DEFAULT);
    assert.equal(sanitizeLocalSlotModel('codex', null), CODEX_FALLBACK_MODELS.DEFAULT);
    assert.equal(sanitizeLocalSlotModel('dsh', 'not-a-model'), DSH_FALLBACK_MODELS.DEFAULT);
  });

  it('let no catalog reconcile a local model id, and the body catalog govern the rest', () => {
    const catalog = PROVIDER_FALLBACK_MODELS.dsh;
    assert.equal(localSlotCatalog(LOCAL, catalog), undefined);
    assert.equal(localSlotCatalog(DSH_FALLBACK_MODELS.DEFAULT, catalog), catalog);
  });
});
