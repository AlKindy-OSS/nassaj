import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accumulateCodexCoordinatorUsage,
  extractCodexTokenBudget,
  selectCodexPostTurnUsage,
} from '../codex-token-budget.js';

const native = (context: unknown = 120, window: unknown = 258400, input: unknown = 100) => ({
  timestamp: '2026-09-13T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: {
    model_context_window: window, last_token_usage: { input_tokens: input, output_tokens: 20, total_tokens: context },
    total_token_usage: { input_tokens: 10000, output_tokens: 1000, total_tokens: 11000 },
  } },
});

test('same-event last total and positive window become native context occupancy', () => {
  const value = extractCodexTokenBudget(native(), 'model-a', 'session-a')!;
  assert.equal(value.used, 120);
  assert.equal(value.total, 258400);
  assert.equal(value.cumulativeUsed, 11000);
  assert.equal(value.inputTokens, 100);
  assert.equal(value.contextSnapshot?.usageKind, 'native_reported_context');
  assert.equal(value.contextSnapshot?.usedTokens, 120);
  assert.equal(value.contextSnapshot?.modelId, 'model-a');
  assert.equal(value.contextSnapshot?.sessionId, 'session-a');
  assert.equal(value.contextSnapshot?.nativeCompactTokens, null);
  assert.equal(value.contextSnapshot?.proposedCompactTokens, null);
});

test('cumulative-only telemetry never becomes context input', () => {
  const value = extractCodexTokenBudget({ info: { total_token_usage: { input_tokens: 1000000, output_tokens: 12 } } })!;
  assert.equal(value.used, null);
  assert.equal(value.inputTokens, null);
  assert.equal(value.total, null);
  assert.equal(value.contextSnapshot?.usageKind, 'unknown');
});

test('request input stays separate and never substitutes for native context', () => {
  const row = native(undefined);
  delete row.payload.info.last_token_usage.total_tokens;
  const value = extractCodexTokenBudget(row)!;
  assert.equal(value.used, null);
  assert.equal(value.inputTokens, 100);
  assert.equal(value.contextSnapshot?.usageKind, 'unknown');
  assert.equal(value.contextSnapshot?.usedTokens, null);
});

test('SDK turn.completed aggregates consumption, not the last request or occupancy', () => {
  const value = extractCodexTokenBudget({
    type: 'turn.completed',
    usage: {
      input_tokens: 123,
      output_tokens: 456,
      model_context_window: 258400,
      last_token_usage: { input_tokens: 123, total_tokens: 999 },
    },
  }, 'gpt-5.4')!;
  assert.equal(value.cumulativeUsed, 579);
  assert.equal(value.used, null);
  assert.equal(value.contextSnapshot?.usageKind, 'unknown');
  assert.equal(value.contextSnapshot?.usedTokens, null);
  assert.equal(value.total, null);
});

test('zero context survives while invalid context or window values cannot become occupancy', () => {
  assert.equal(extractCodexTokenBudget(native(0))?.contextSnapshot?.usedTokens, 0);
  assert.equal(extractCodexTokenBudget(native(0))?.contextSnapshot?.usageKind, 'native_reported_context');
  for (const invalid of [-1, NaN, Infinity, '200', null, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidContext = extractCodexTokenBudget(native(invalid))!;
    assert.equal(invalidContext.used, null);
    assert.equal(invalidContext.contextSnapshot?.usageKind, 'unknown');
    assert.equal(invalidContext.contextSnapshot?.usedTokens, null);
    const invalidWindow = extractCodexTokenBudget(native(200, invalid))!;
    assert.equal(invalidWindow.used, null);
    assert.equal(invalidWindow.total, null);
    assert.equal(invalidWindow.contextSnapshot?.usageKind, 'unknown');
  }
});

test('context is not reduced by a guessed baseline', () => {
  const value = extractCodexTokenBudget(native(12_000, 258_400))!;
  assert.equal(value.used, 12_000);
  assert.equal(value.contextSnapshot?.usedTokens, 12_000);
});

test('model swap, missing identity, replay and postcompact cannot inherit a window or earlier input', () => {
  const previous = extractCodexTokenBudget(native(), 'model-a', 'session-a')!;
  const next = extractCodexTokenBudget({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }, 'model-b', 'session-a')!;
  const accumulated = accumulateCodexCoordinatorUsage(previous, next);
  assert.equal(accumulated.total, null);
  assert.equal(accumulated.contextSnapshot?.usedTokens, null);
  assert.equal(accumulated.contextSnapshot?.usageKind, 'unknown');
  assert.equal(accumulated.contextSnapshot?.modelId, 'model-b');
  assert.equal(accumulated.cumulativeUsed, 11012);
  assert.equal(accumulateCodexCoordinatorUsage(previous, previous).cumulativeUsed, 11000);
  assert.equal(extractCodexTokenBudget({}, 'model-a'), null);
});

test('post-turn selection rejects late history, unknown identity and non-native samples', () => {
  const current = extractCodexTokenBudget(native(), 'model-a', 'session-a', 'history')!;
  assert.equal(selectCodexPostTurnUsage(current, {
    sessionId: 'session-a', modelId: 'model-a', notBefore: '2026-09-13T09:59:59Z',
  }), current);
  for (const identity of [
    { sessionId: 'session-b', modelId: 'model-a', notBefore: '2026-09-13T09:59:59Z' },
    { sessionId: 'session-a', modelId: 'model-b', notBefore: '2026-09-13T09:59:59Z' },
    { sessionId: 'session-a', modelId: 'model-a', notBefore: '2026-09-13T10:00:01Z' },
    { sessionId: 'session-a', modelId: 'model-a', notBefore: null },
  ]) assert.equal(selectCodexPostTurnUsage(current, identity), null);

  const completed = extractCodexTokenBudget({
    type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 },
  }, 'model-a', 'session-a')!;
  assert.equal(selectCodexPostTurnUsage(completed, {
    sessionId: 'session-a', modelId: 'model-a', notBefore: '2026-09-13T09:59:59Z',
  }), null);
});
