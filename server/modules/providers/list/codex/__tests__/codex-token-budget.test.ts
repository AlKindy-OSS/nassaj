import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCodexTokenBudget, windowForModel } from '../codex-token-budget.js';

test('windowForModel resolves a known exact model id', () => {
  assert.equal(windowForModel('gpt-5-codex'), 400000);
  assert.equal(windowForModel('gpt-4.1'), 1000000);
  assert.equal(windowForModel('o3'), 200000);
  assert.equal(windowForModel('o4-mini'), 200000);
  assert.equal(windowForModel('o1-mini'), 128000);
});

test('windowForModel matches dot-release/variant ids nassaj\'s catalog actually carries', () => {
  // These are the live CODEX_FALLBACK_MODELS values (codex-models.provider.ts) —
  // none of them are exact keys in CODEX_MODEL_CONTEXT_WINDOWS, so this exercises
  // the family-regex fallback, not the exact table.
  assert.equal(windowForModel('gpt-5.5'), 400000);
  assert.equal(windowForModel('gpt-5.4'), 400000);
  assert.equal(windowForModel('gpt-5.4-mini'), 400000);
  assert.equal(windowForModel('gpt-5.3-codex'), 400000);
  assert.equal(windowForModel('gpt-5.2'), 400000);
});

test('windowForModel strips stacked reasoning-effort/speed suffixes before matching', () => {
  assert.equal(windowForModel('gpt-5.3-codex-xhigh-fast'), 400000);
  assert.equal(windowForModel('gpt-5.1-codex-max-high'), 400000);
});

test('windowForModel returns undefined for a genuinely unknown model id', () => {
  assert.equal(windowForModel('totally-unknown-model'), undefined);
  assert.equal(windowForModel(undefined), undefined);
  assert.equal(windowForModel(null), undefined);
});

test('extractCodexTokenBudget uses the model-derived window when the event carries none', () => {
  const event = {
    usage: {
      total_token_usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
    },
  };

  const budget = extractCodexTokenBudget(event, 'gpt-5.3-codex');
  assert.equal(budget?.total, 400000);
  assert.equal(budget?.used, 1500);
  assert.equal(budget?.inputTokens, 1000);
  assert.equal(budget?.outputTokens, 500);
});

test('extractCodexTokenBudget falls back to 200000 for an unmapped model', () => {
  const event = {
    usage: {
      total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  };

  const budget = extractCodexTokenBudget(event, 'some-future-model-nobody-mapped-yet');
  assert.equal(budget?.total, 200000);
});

test('extractCodexTokenBudget respects model_context_window on the event when present', () => {
  const event = {
    info: {
      model_context_window: 321000,
      total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  };

  // Passing a model whose real window is 400000 must NOT override the event's
  // own reported window — the event, if present, is always authoritative.
  const budget = extractCodexTokenBudget(event, 'gpt-5-codex');
  assert.equal(budget?.total, 321000);
});

test('extractCodexTokenBudget returns null when there is no usage payload at all', () => {
  assert.equal(extractCodexTokenBudget({}, 'gpt-5.4'), null);
});
