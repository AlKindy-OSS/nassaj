/**
 * claudeModelSlot.test.ts — B-235 regression (node:test, no React).
 *
 * Pins the rule that the `claude-model` slot is governed by the ENGINE's catalog
 * while an engine is engaged. The bug this replaces was not a wrong catalog
 * lookup in isolation: validating the slot against the Claude catalog rejected
 * `glm-5.2` the instant the user picked "Claude engine on GLM", wrote the Claude
 * default over it, and shipped the run as "engine = GLM, model = a Claude id".
 *
 * The two helpers exercised here are the real ones the hook calls, so a
 * regression in either of them fails this test rather than the picker.
 *
 * Run: node --import tsx/esm --test src/components/chat/hooks/claudeModelSlot.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLAUDE_FALLBACK_MODELS,
  GLM_FALLBACK_MODELS,
  PROVIDER_FALLBACK_MODELS,
} from '../../../constants/providerModelFallbacks';

import { claudeSlotCatalogProvider, sanitizeClaudeSlotModel } from './claudeModelSlot';
import { pickStoredOrCurrent } from './normalizeProviderModel';

const GLM_WIRE_MODEL = 'glm-5.2';

describe('claudeSlotCatalogProvider', () => {
  it('hands the slot to the engine while one is engaged', () => {
    assert.equal(claudeSlotCatalogProvider('glm'), 'glm');
    assert.equal(claudeSlotCatalogProvider('kimi'), 'kimi');
  });

  it('hands the slot back to claude on the official path', () => {
    assert.equal(claudeSlotCatalogProvider(null), 'claude');
  });
});

describe('local engine (ADR-227)', () => {
  const LOCAL_MODEL = 'nassaj_local_0123456789abcdef0123456789abcdef/qwen3:8b';

  it('leaves the slot to no catalog on the local engine', () => {
    assert.equal(claudeSlotCatalogProvider('local'), null);
  });

  it('keeps a local model id when the local engine is stamped', () => {
    assert.equal(sanitizeClaudeSlotModel('local', LOCAL_MODEL), LOCAL_MODEL);
  });

  it('falls back to the Claude default for a non-local id on the local engine', () => {
    assert.equal(sanitizeClaudeSlotModel('local', GLM_WIRE_MODEL), CLAUDE_FALLBACK_MODELS.DEFAULT);
  });

  it('drops a local model id once the local engine is cleared', () => {
    assert.equal(sanitizeClaudeSlotModel(null, LOCAL_MODEL), CLAUDE_FALLBACK_MODELS.DEFAULT);
  });
});

describe('boot read of claude-model (sanitizeStoredModel)', () => {
  it('keeps the vendor model id when the stamped engine governs the slot', () => {
    assert.equal(
      sanitizeClaudeSlotModel('glm', GLM_WIRE_MODEL),
      GLM_WIRE_MODEL,
    );
  });

  it('normalizes a leftover vendor id back to Claude once the engine is cleared', () => {
    assert.equal(
      sanitizeClaudeSlotModel(null, GLM_WIRE_MODEL),
      CLAUDE_FALLBACK_MODELS.DEFAULT,
    );
  });

  it('normalizes a leftover Claude id to the engine default when a session is stamped', () => {
    assert.equal(
      sanitizeClaudeSlotModel('glm', CLAUDE_FALLBACK_MODELS.DEFAULT),
      GLM_FALLBACK_MODELS.DEFAULT,
    );
  });
});

describe('reconcile of claude-model against the governing catalog', () => {
  const reconcile = (engine: 'glm' | null, stored: string, current: string): string =>
    pickStoredOrCurrent(
      stored,
      current,
      PROVIDER_FALLBACK_MODELS[claudeSlotCatalogProvider(engine) ?? 'claude'],
    );

  it('leaves the just-picked engine model untouched (the exact B-235 path)', () => {
    // selectClaudeEngineProvider writes BOTH the stamp and the model, so the
    // reconcile that fires on the next render sees glm-5.2 in state and storage.
    assert.equal(reconcile('glm', GLM_WIRE_MODEL, GLM_WIRE_MODEL), GLM_WIRE_MODEL);
  });

  it('would have replaced it with the Claude default under the old rule', () => {
    // Documents the regression itself: same inputs, Claude catalog, silent swap.
    assert.equal(
      pickStoredOrCurrent(GLM_WIRE_MODEL, GLM_WIRE_MODEL, PROVIDER_FALLBACK_MODELS.claude),
      CLAUDE_FALLBACK_MODELS.DEFAULT,
    );
  });

  it('restores a Claude model when the engine is cleared', () => {
    assert.equal(reconcile(null, GLM_WIRE_MODEL, GLM_WIRE_MODEL), CLAUDE_FALLBACK_MODELS.DEFAULT);
  });

  it('never yields a bracketed variant id — those are not z.ai wire ids (B-220)', () => {
    assert.equal(
      PROVIDER_FALLBACK_MODELS.glm.OPTIONS.some((option) => option.value.includes('[')),
      false,
    );
  });
});
