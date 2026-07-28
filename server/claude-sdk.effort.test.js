import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapCliOptionsToSDK,
  resolveEffortLevel,
  maybeApplyUltracodeKeywords,
} from './claude-sdk.js';

/**
 * Runs mapCliOptionsToSDK while capturing console.warn output, returning the
 * full sdkOptions so tests can assert the `effort` field (pattern mirrors
 * claude-sdk.model.test.js).
 */
function mapAndCaptureWarn(options) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };
  try {
    const result = mapCliOptionsToSDK(options);
    return { result, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

// --- resolveEffortLevel (allowlist unit) ---

test('resolveEffortLevel accepts every native SDK level verbatim', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(resolveEffortLevel(level), { level, alias: null, rejected: null });
  }
});

test('resolveEffortLevel maps "ultracode" to the SDK ceiling "max" (alias)', () => {
  assert.deepEqual(resolveEffortLevel('ultracode'), {
    level: 'max',
    alias: 'ultracode',
    rejected: null,
  });
});

test('resolveEffortLevel resolves "auto" to no level (model default, omit)', () => {
  assert.deepEqual(resolveEffortLevel('auto'), { level: null, alias: 'auto', rejected: null });
});

test('resolveEffortLevel is case/whitespace tolerant', () => {
  assert.equal(resolveEffortLevel('  HIGH ').level, 'high');
  assert.equal(resolveEffortLevel('XHigh').level, 'xhigh');
});

test('resolveEffortLevel rejects unknown strings (safe ignore)', () => {
  const { level, rejected } = resolveEffortLevel('turbo-9000');
  assert.equal(level, null);
  assert.equal(rejected, 'turbo-9000');
});

test('resolveEffortLevel ignores non-string and empty values silently', () => {
  for (const value of [undefined, null, 42, {}, [], '', '   ']) {
    assert.deepEqual(resolveEffortLevel(value), { level: null, alias: null, rejected: null });
  }
});

// --- mapCliOptionsToSDK integration (the UI contract path) ---

test('mapCliOptionsToSDK forwards a valid effort level to sdkOptions.effort without warning', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const { result, warnings } = mapAndCaptureWarn({ effort: level });
    assert.equal(result.effort, level, `level ${level} must pass through`);
    assert.equal(warnings.length, 0, `level ${level} must not warn`);
  }
});

test('mapCliOptionsToSDK maps "ultracode" to effort "max" with a non-silent warning', () => {
  const { result, warnings } = mapAndCaptureWarn({ effort: 'ultracode' });
  assert.equal(result.effort, 'max');
  assert.equal(warnings.length, 1, 'alias mapping must be logged (no silent substitution)');
  assert.match(warnings[0], /"ultracode"/);
  assert.match(warnings[0], /"max"/);
});

test('mapCliOptionsToSDK omits effort entirely for "auto" (model default)', () => {
  const { result, warnings } = mapAndCaptureWarn({ effort: 'auto' });
  assert.equal('effort' in result, false, '"auto" means model default — no SDK effort key');
  assert.equal(warnings.length, 0, '"auto" is a legitimate sentinel, not a rejection');
});

test('mapCliOptionsToSDK ignores an unknown effort value safely and warns with the session tag', () => {
  const { result, warnings } = mapAndCaptureWarn({ effort: 'bogus-effort', sessionId: 'sess-9' });
  assert.equal('effort' in result, false, 'unknown values must never reach the SDK');
  assert.equal(warnings.length, 1, 'rejection must be non-silent');
  assert.match(warnings[0], /"bogus-effort"/);
  assert.match(warnings[0], /session=sess-9/);
});

test('mapCliOptionsToSDK omits effort silently when the field is absent or non-string', () => {
  for (const options of [{}, { effort: undefined }, { effort: null }, { effort: 3 }]) {
    const { result, warnings } = mapAndCaptureWarn(options);
    assert.equal('effort' in result, false);
    assert.equal(warnings.length, 0, 'absence is not a rejected value, so no warning');
  }
});

// --- maybeApplyUltracodeKeywords (the CLI prompt-keyword half of ultracode) ---

test('maybeApplyUltracodeKeywords appends ultrathink + ultrawork only for ultracode', () => {
  const out = maybeApplyUltracodeKeywords('refactor the parser', 'ultracode');
  assert.match(out, /\bultrathink\b/i, 'must include ultrathink so the CLI enables deep reasoning');
  assert.match(out, /\bultrawork\b/i, 'must include ultrawork so the CLI enables workflow orchestration');
  assert.ok(out.startsWith('refactor the parser'), 'user prompt is preserved as the prefix');
});

test('maybeApplyUltracodeKeywords is a no-op for non-ultracode effort values', () => {
  for (const effort of ['max', 'xhigh', 'high', 'medium', 'low', 'auto', '', undefined, null, 3, 'bogus']) {
    assert.equal(
      maybeApplyUltracodeKeywords('do the thing', effort),
      'do the thing',
      `effort ${String(effort)} must not mutate the prompt`,
    );
  }
});

test('maybeApplyUltracodeKeywords handles an empty prompt without leading whitespace', () => {
  const out = maybeApplyUltracodeKeywords('', 'ultracode');
  assert.match(out, /\bultrathink\b/i);
  assert.match(out, /\bultrawork\b/i);
  assert.equal(out.trimStart(), out, 'no leading whitespace when the base prompt is empty');
});
