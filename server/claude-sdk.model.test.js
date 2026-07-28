import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK, buildValidClaudeModelValues, isUnreleasedModelFailure } from './claude-sdk.js';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
// Client-side mirror of the Claude catalog. This test runs under
// server/tsconfig.json, and the client constants module only imports types
// (erased at runtime), so importing it here is runtime-safe and lets us guard
// the two copies against drift. See the drift-guard test at the bottom.
import { CLAUDE_FALLBACK_MODELS as CLIENT_CLAUDE_FALLBACK_MODELS } from '../src/constants/providerModelFallbacks.js';

const DEFAULT = CLAUDE_FALLBACK_MODELS.DEFAULT;

/**
 * Runs mapCliOptionsToSDK while capturing any console.warn output so tests can
 * assert that fallbacks are NOT silent (critic-mandated requirement).
 */
function mapAndCaptureWarn(options, validModelValues) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };
  try {
    const result = mapCliOptionsToSDK(options, validModelValues);
    return { model: result.model, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

// A representative dynamic catalog: the live picker source surfaces models that
// are NOT in the static CLAUDE_FALLBACK_MODELS list (e.g. claude-opus-4-9). This
// mirrors the shape of providerModelsService.getProviderModels('claude').models.
// Note: claude-fable-5 is deliberately NOT used as the example here — it is
// hidden from the live catalog as an unreleased model, so it is no longer a
// representative selectable value (see claude-catalog.client.ts).
const DYNAMIC_CATALOG = {
  OPTIONS: [
    { value: 'default', label: 'Default' },
    { value: 'claude-opus-4-9', label: 'Opus 4.9' },
  ],
  DEFAULT: 'default',
};

test('mapCliOptionsToSDK coerces the invalid "auto" sentinel to the provider default and warns', () => {
  const { model, warnings } = mapAndCaptureWarn({ model: 'auto', sessionId: 'sess-1' });

  assert.equal(model, DEFAULT);
  assert.equal(warnings.length, 1, 'expected exactly one warning (no silent substitution)');
  assert.match(warnings[0], /"auto"/, 'warning should name the rejected value');
  assert.match(warnings[0], new RegExp(`"${DEFAULT}"`), 'warning should name the fallback');
  assert.match(warnings[0], /session=sess-1/, 'warning should include the sessionId');
});

test('mapCliOptionsToSDK passes through "sonnet[1m]" verbatim (literal match, brackets preserved)', () => {
  const { model, warnings } = mapAndCaptureWarn({ model: 'sonnet[1m]' });

  assert.equal(model, 'sonnet[1m]');
  assert.equal(warnings.length, 0, 'a known model must not trigger a fallback warning');
});

test('mapCliOptionsToSDK passes through every known CLAUDE_FALLBACK_MODELS option', () => {
  for (const option of CLAUDE_FALLBACK_MODELS.OPTIONS) {
    const { model, warnings } = mapAndCaptureWarn({ model: option.value });
    assert.equal(model, option.value, `known model ${option.value} should pass through`);
    assert.equal(warnings.length, 0, `known model ${option.value} should not warn`);
  }
});

test('mapCliOptionsToSDK falls back silently (no warn) for null model', () => {
  const { model, warnings } = mapAndCaptureWarn({ model: null });

  assert.equal(model, DEFAULT);
  assert.equal(warnings.length, 0, 'an absent model is not a rejected value, so no warning');
});

test('mapCliOptionsToSDK falls back for undefined model (no model key)', () => {
  const { model, warnings } = mapAndCaptureWarn({});

  assert.equal(model, DEFAULT);
  assert.equal(warnings.length, 0);
});

test('mapCliOptionsToSDK falls back for an empty string model', () => {
  const { model, warnings } = mapAndCaptureWarn({ model: '' });

  assert.equal(model, DEFAULT);
  assert.equal(warnings.length, 0, 'empty string trims to empty -> treated as absent, no warning');
});

test('mapCliOptionsToSDK falls back for a whitespace-only model', () => {
  const { model, warnings } = mapAndCaptureWarn({ model: '   ' });

  assert.equal(model, DEFAULT);
  assert.equal(warnings.length, 0, 'whitespace trims to empty -> treated as absent, no warning');
});

// Drift guard: the client fallback catalog (src/constants/providerModelFallbacks.ts)
// is a hand-maintained mirror of the Claude server source of truth here.
// Only the *contract* is guarded: the set of valid option `value`s and the
// `DEFAULT`. Labels/descriptions are presentational and intentionally allowed
// to differ (the server descriptions name specific model versions), so they
// are NOT asserted here to avoid a brittle test.
test('client Claude fallback mirror does not drift from the server source (values + default)', () => {
  const serverValues = CLAUDE_FALLBACK_MODELS.OPTIONS.map((option) => option.value);
  const clientValues = CLIENT_CLAUDE_FALLBACK_MODELS.OPTIONS.map((option) => option.value);

  assert.deepEqual(
    clientValues,
    serverValues,
    'client option values (and order) must match the server Claude catalog; '
    + 'update src/constants/providerModelFallbacks.ts when the server changes',
  );
  assert.equal(
    CLIENT_CLAUDE_FALLBACK_MODELS.DEFAULT,
    CLAUDE_FALLBACK_MODELS.DEFAULT,
    'client DEFAULT must match the server Claude DEFAULT',
  );
});

// --- Dynamic-catalog acceptance (the bug fix) ---

test('buildValidClaudeModelValues unions the dynamic catalog with the static fallback list', () => {
  const values = buildValidClaudeModelValues(DYNAMIC_CATALOG);

  // Dynamic-only model is accepted.
  assert.equal(values.has('claude-opus-4-9'), true, 'dynamic catalog value must be included');
  // Static safety-net values survive even though the dynamic catalog omits them.
  for (const option of CLAUDE_FALLBACK_MODELS.OPTIONS) {
    assert.equal(values.has(option.value), true, `static value ${option.value} must remain valid`);
  }
});

test('buildValidClaudeModelValues degrades to the static list when the catalog is unavailable', () => {
  for (const catalog of [null, undefined, {}, { OPTIONS: null }]) {
    const values = buildValidClaudeModelValues(catalog);
    const staticValues = CLAUDE_FALLBACK_MODELS.OPTIONS.map((o) => o.value);
    assert.deepEqual([...values].sort(), [...staticValues].sort(),
      'with no usable catalog the accepted set is exactly the static list');
  }
});

test('mapCliOptionsToSDK passes through a dynamic-catalog model (claude-opus-4-9) verbatim', () => {
  const valid = buildValidClaudeModelValues(DYNAMIC_CATALOG);
  const { model, warnings } = mapAndCaptureWarn({ model: 'claude-opus-4-9' }, valid);

  assert.equal(model, 'claude-opus-4-9', 'a live picker model must be sent as-is, not coerced to default');
  assert.equal(warnings.length, 0, 'a model present in the dynamic catalog must not warn');
});

test('mapCliOptionsToSDK still coerces "auto" to default (protection NOT weakened) with a dynamic catalog', () => {
  const valid = buildValidClaudeModelValues(DYNAMIC_CATALOG);
  const { model, warnings } = mapAndCaptureWarn({ model: 'auto', sessionId: 'sess-2' }, valid);

  assert.equal(model, DEFAULT, 'auto is not a real model and must coerce to default');
  assert.equal(warnings.length, 1, 'coercion of a rejected value must warn (non-silent)');
  assert.match(warnings[0], /"auto"/);
});

test('mapCliOptionsToSDK coerces empty/whitespace/unknown to default even with a dynamic catalog', () => {
  const valid = buildValidClaudeModelValues(DYNAMIC_CATALOG);

  const empty = mapAndCaptureWarn({ model: '' }, valid);
  assert.equal(empty.model, DEFAULT);
  assert.equal(empty.warnings.length, 0, 'empty trims to absent -> no warning');

  const ws = mapAndCaptureWarn({ model: '   ' }, valid);
  assert.equal(ws.model, DEFAULT);
  assert.equal(ws.warnings.length, 0, 'whitespace trims to absent -> no warning');

  const unknown = mapAndCaptureWarn({ model: 'totally-made-up-model' }, valid);
  assert.equal(unknown.model, DEFAULT);
  assert.equal(unknown.warnings.length, 1, 'a non-empty unknown value warns');
  assert.match(unknown.warnings[0], /"totally-made-up-model"/);
});

test('mapCliOptionsToSDK falls back to the static list when no validModelValues is passed (catalog unavailable)', () => {
  // claude-opus-4-9 is dynamic-only; without a catalog set it must NOT be accepted.
  const dyn = mapAndCaptureWarn({ model: 'claude-opus-4-9' });
  assert.equal(dyn.model, DEFAULT, 'without a catalog, a dynamic-only model is rejected (static floor)');
  assert.equal(dyn.warnings.length, 1);

  // claude-fable-5 is NOT in the static fallback list. The static list is the
  // degraded-path floor used when the live probe is unavailable; it must never
  // offer a model the account might not be entitled to. fable-5 became available
  // on 2026-07-02, but it surfaces via the LIVE catalog probe (which runs under
  // the user's real credentials) — NOT via the static list. When no live catalog
  // is present (this test's scenario), fable-5 must still be rejected and coerce
  // to DEFAULT with a non-silent warning.
  const fable = mapAndCaptureWarn({ model: 'claude-fable-5' });
  assert.equal(fable.model, DEFAULT, 'fable-5 is not a static-list model and must coerce to default');
  assert.equal(fable.warnings.length, 1, 'rejecting the unreleased fable-5 must warn (non-silent)');
  assert.match(fable.warnings[0], /"claude-fable-5"/);

  // sonnet[1m] is in the static list and must still pass through.
  const stat = mapAndCaptureWarn({ model: 'sonnet[1m]' });
  assert.equal(stat.model, 'sonnet[1m]', 'static-list model still accepted on the degraded path');
  assert.equal(stat.warnings.length, 0);

  // claude-opus-4-8 is in the static list.
  const opus = mapAndCaptureWarn({ model: 'claude-opus-4-8' });
  assert.equal(opus.model, 'claude-opus-4-8');
  assert.equal(opus.warnings.length, 0);
});

test('an empty Set for validModelValues degrades to the static list (size-0 guard)', () => {
  // A defensively-empty set must not reject everything — it falls back to static.
  const stat = mapAndCaptureWarn({ model: 'sonnet[1m]' }, new Set());
  assert.equal(stat.model, 'sonnet[1m]', 'empty set must not lock out static models');
  assert.equal(stat.warnings.length, 0);
});

// --- Lazy model-discovery: unreleased-model failure detector ---

test('isUnreleasedModelFailure: true for an assistant message with error model_not_found', () => {
  assert.equal(
    isUnreleasedModelFailure({ type: 'assistant', error: 'model_not_found' }),
    true,
  );
});

test('isUnreleasedModelFailure: true for a result message with api_error_status 404', () => {
  assert.equal(
    isUnreleasedModelFailure({ type: 'result', subtype: 'success', api_error_status: 404 }),
    true,
  );
});

test('isUnreleasedModelFailure: false for unrelated errors and non-404 statuses', () => {
  // A different assistant error is NOT a model-unreleased signal.
  assert.equal(isUnreleasedModelFailure({ type: 'assistant', error: 'rate_limit' }), false);
  // A non-404 api_error_status on a result is NOT this signal.
  assert.equal(isUnreleasedModelFailure({ type: 'result', api_error_status: 500 }), false);
  // A 404 on a non-result message type does not match the result branch.
  assert.equal(isUnreleasedModelFailure({ type: 'assistant', api_error_status: 404 }), false);
  // model_not_found on a non-assistant type does not match the assistant branch.
  assert.equal(isUnreleasedModelFailure({ type: 'result', error: 'model_not_found' }), false);
});

test('isUnreleasedModelFailure: false for normal/empty messages', () => {
  assert.equal(isUnreleasedModelFailure(null), false);
  assert.equal(isUnreleasedModelFailure(undefined), false);
  assert.equal(isUnreleasedModelFailure({}), false);
  assert.equal(isUnreleasedModelFailure({ type: 'assistant', message: { model: 'claude-opus-4-8' } }), false);
  assert.equal(isUnreleasedModelFailure({ type: 'result', subtype: 'success', api_error_status: null }), false);
});
