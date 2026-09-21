import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickStoredOrCurrent } from './normalizeProviderModel.js';
import {
  CLAUDE_FALLBACK_MODELS,
  FALLBACK_DEFAULT_MODEL,
  sanitizeStoredModel,
} from '../../../constants/providerModelFallbacks.js';

// Regression coverage for the stuck-"auto" / invalid-"opus" model bug.
//
// Root cause: when the live model catalog failed to load, the catalog entry was
// undefined and the self-sanitizer never ran, so a stale localStorage value
// such as "auto" (a permission mode that was wrongly persisted as a model) or
// the invalid hard-coded default "opus" leaked through to the server. The fix
// guarantees the sanitizer always has a valid catalog (live or fallback).

describe('pickStoredOrCurrent (self-sanitizer)', () => {
  it('falls back to DEFAULT when the stored value is "auto" and the (fallback) catalog has no such option', () => {
    // Simulates: live catalog failed → fallback catalog is authoritative.
    const result = pickStoredOrCurrent('auto', 'auto', CLAUDE_FALLBACK_MODELS);
    assert.equal(result, CLAUDE_FALLBACK_MODELS.DEFAULT);
    assert.equal(result, 'default');
  });

  it('coerces the legacy invalid "opus" value to the catalog default', () => {
    const result = pickStoredOrCurrent('opus', 'opus', CLAUDE_FALLBACK_MODELS);
    assert.equal(result, 'default');
  });

  it('respects a valid stored value', () => {
    assert.equal(pickStoredOrCurrent('sonnet', 'default', CLAUDE_FALLBACK_MODELS), 'sonnet');
    assert.equal(pickStoredOrCurrent('sonnet[1m]', 'default', CLAUDE_FALLBACK_MODELS), 'sonnet[1m]');
  });

  it('prefers a valid stored value over a valid current value', () => {
    assert.equal(pickStoredOrCurrent('haiku', 'sonnet', CLAUDE_FALLBACK_MODELS), 'haiku');
  });

  it('falls back to the current value when stored is invalid but current is valid', () => {
    assert.equal(pickStoredOrCurrent('auto', 'sonnet', CLAUDE_FALLBACK_MODELS), 'sonnet');
  });

  it('returns DEFAULT when both stored and current are invalid', () => {
    assert.equal(pickStoredOrCurrent('auto', 'opus', CLAUDE_FALLBACK_MODELS), 'default');
  });

  it('returns DEFAULT when stored is null/empty', () => {
    assert.equal(pickStoredOrCurrent(null, '', CLAUDE_FALLBACK_MODELS), 'default');
  });
});

describe('sanitizeStoredModel (synchronous initial read)', () => {
  it('coerces a stuck "auto" claude value at first render before async normalization', () => {
    assert.equal(sanitizeStoredModel('claude', 'auto'), 'default');
  });

  it('coerces the legacy "opus" claude value', () => {
    assert.equal(sanitizeStoredModel('claude', 'opus'), 'default');
  });

  it('keeps a valid stored value for each provider', () => {
    assert.equal(sanitizeStoredModel('claude', 'sonnet'), 'sonnet');
    assert.equal(sanitizeStoredModel('cursor', 'composer-2.5-fast'), 'composer-2.5-fast');
    assert.equal(sanitizeStoredModel('codex', 'gpt-5.4'), 'gpt-5.4');
    assert.equal(sanitizeStoredModel('gemini', 'gemini-2.5-pro'), 'gemini-2.5-pro');
    assert.equal(sanitizeStoredModel('antigravity', 'auto'), 'auto');
    assert.equal(
      sanitizeStoredModel('opencode', 'anthropic/claude-sonnet-4-5'),
      'anthropic/claude-sonnet-4-5',
    );
  });

  it('returns the provider default for null storage', () => {
    assert.equal(sanitizeStoredModel('claude', null), FALLBACK_DEFAULT_MODEL.claude);
    assert.equal(sanitizeStoredModel('codex', null), FALLBACK_DEFAULT_MODEL.codex);
  });
});

describe('FALLBACK_DEFAULT_MODEL is internally consistent', () => {
  it('every provider default is a valid option in its own fallback catalog', () => {
    const providers = ['claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode'] as const;
    for (const provider of providers) {
      const def = FALLBACK_DEFAULT_MODEL[provider];
      // sanitizeStoredModel returns the default unchanged only when it is a
      // valid option, so this asserts no provider default drifts out of catalog.
      assert.equal(
        sanitizeStoredModel(provider, def),
        def,
        `Default "${def}" for provider "${provider}" is not present in its fallback catalog`,
      );
    }
  });

  it('claude default is "default", never the invalid "opus"', () => {
    assert.equal(FALLBACK_DEFAULT_MODEL.claude, 'default');
    assert.notEqual(FALLBACK_DEFAULT_MODEL.claude, 'opus');
  });
});
