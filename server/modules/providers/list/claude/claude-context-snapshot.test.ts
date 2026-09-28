import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claudeContextSnapshot,
  claudeTranscriptContextSnapshot,
  claudeTranscriptWindowTokens,
  readClaudeContextSnapshot,
} from './claude-token-usage.js';
const identity = { sessionId: 'session-a', modelId: 'claude-model-a' };

test('native control response preserves zero, actual window, native baseline and owner thresholds', () => {
  const snapshot = claudeContextSnapshot({ model: 'claude-model-a', totalTokens: 0, maxTokens: 1000000, autoCompactThreshold: 900000 }, identity);
  assert.equal(snapshot.usedTokens, 0);
  assert.equal(snapshot.usageKind, 'native_reported_context');
  assert.equal(snapshot.nativeCompactTokens, 900000);
  assert.equal(snapshot.proposedCompactTokens, 150000);
  assert.equal(snapshot.newSessionTokens, 200000);
});

test('invalid or missing measurements cannot become an occupancy or pressure trigger', () => {
  for (const response of [null, {}, { model: 'claude-model-a', totalTokens: -1, maxTokens: 200000 }, { model: 'claude-model-a', totalTokens: 10, maxTokens: NaN }]) {
    const snapshot = claudeContextSnapshot(response, identity, 1200);
    assert.equal(snapshot.usageKind, 'last_request_input');
    assert.equal(snapshot.windowTokens, null);
    assert.equal(snapshot.proposedCompactTokens, null);
  }
  const unknownModel = claudeContextSnapshot({ model: 'claude-model-a', totalTokens: 50, maxTokens: 200000 }, { ...identity, modelId: null });
  assert.equal(unknownModel.modelId, 'claude-model-a');
  assert.equal(unknownModel.proposedCompactTokens, 150000);
});

test('control request failure and missing SDK support are nonfatal and never fabricate context', async () => {
  for (const query of [null, {}, { getContextUsage: async () => { throw new Error('failure'); } }]) {
    assert.equal((await readClaudeContextSnapshot(query, identity)).usageKind, 'unknown');
  }
});

test('postcompact native response replaces the prior value without inheritance', async () => {
  const snapshot = await readClaudeContextSnapshot({ getContextUsage: async () => ({ model: 'claude-model-a', totalTokens: 200, maxTokens: 200000 }) }, identity);
  assert.equal(snapshot.usedTokens, 200);
});

test('hung native control request is bounded and leaves unavailable telemetry', async () => {
  const snapshot = await readClaudeContextSnapshot({ getContextUsage: () => new Promise(() => {}) }, identity);
  assert.equal(snapshot.usageKind, 'unknown');
  assert.equal(snapshot.usedTokens, null);
});

test('caller-supplied identity is preserved; control model does not override it; missing control model still blocks occupancy', () => {
  // B-1295: control.model ('model-b') must not overwrite a provided identity.
  const next = claudeContextSnapshot({ model: 'model-b', totalTokens: 50, maxTokens: 200000 }, identity);
  assert.equal(next.modelId, 'claude-model-a');  // identity wins, not control.model
  assert.equal(next.windowTokens, 200000);         // window still read from control
  assert.equal(next.usageKind, 'native_reported_context');
  // When no identity is provided, control.model may populate it.
  const noId = claudeContextSnapshot({ model: 'model-b', totalTokens: 50, maxTokens: 200000 }, { ...identity, modelId: null });
  assert.equal(noId.modelId, 'model-b');
  assert.equal(claudeContextSnapshot({ totalTokens: 50, maxTokens: 200000 }, identity).usageKind, 'unknown');
});

test('picker alias identity survives getContextUsage round-trip (B-1295)', async () => {
  // The SDK returns the native model id ('claude-opus-5') but the caller passes
  // the picker alias ('opus[1m]').  The snapshot must carry the alias so that
  // contextUsagePresentation can match it against sessionCurrentModel.
  const aliasIdentity = { sessionId: 'session-x', modelId: 'opus[1m]' };
  const snapshot = await readClaudeContextSnapshot(
    { getContextUsage: async () => ({ model: 'claude-opus-5', totalTokens: 150_000, maxTokens: 1_048_576 }) },
    aliasIdentity,
  );
  assert.equal(snapshot.modelId, 'opus[1m]');
  assert.equal(snapshot.windowTokens, 1_048_576);
  assert.equal(snapshot.usageKind, 'native_reported_context');
});

test('B-1356: transcript window follows the model id and never guesses an unknown one', () => {
  const cases: Array<[string | null, number | null]> = [
    ['claude-opus-5-5', 1_000_000],
    ['claude-opus-4-8', 1_000_000],
    ['claude-opus-4-6', 1_000_000],
    ['claude-opus-4-1-20250805', 200_000],
    ['claude-opus-4-20250514', 200_000],
    ['claude-fable-5', 1_000_000],
    // The transcript records the base id for sonnet[1m] too: ambiguity takes the smaller window.
    ['claude-sonnet-4-6', 200_000],
    ['claude-sonnet-4-6[1m]', 1_000_000],
    ['claude-haiku-4-5-20251001', 200_000],
    ['claude-3-5-sonnet-20241022', 200_000],
    ['<synthetic>', null],
    ['gpt-5', null],
    ['claude-unknown', null],
    ['', null],
    [null, null],
  ];
  for (const [modelId, expected] of cases) {
    assert.equal(claudeTranscriptWindowTokens(modelId), expected, String(modelId));
  }
});

test('B-1356: transcript snapshot keeps restoration semantics and carries the window', () => {
  const snapshot = claudeTranscriptContextSnapshot('session-a', 'claude-opus-5-5', 81392);
  assert.equal(snapshot.observedAt, null);
  assert.equal(snapshot.usageKind, 'last_request_input');
  assert.equal(snapshot.usedTokens, 81392);
  assert.equal(snapshot.windowTokens, 1_000_000);
  assert.equal(snapshot.proposedCompactTokens, null);
  assert.equal(snapshot.newSessionTokens, null);

  const unknown = claudeTranscriptContextSnapshot('session-a', '<synthetic>', 10);
  assert.equal(unknown.windowTokens, null);
  const noModel = claudeTranscriptContextSnapshot('session-a', null, 81392);
  assert.equal(noModel.usageKind, 'unknown');
  assert.equal(noModel.windowTokens, null);
});
