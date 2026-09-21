/**
 * T-1191 — parsing agy's failure line.
 *
 * The literal strings below are the ones agy actually emitted, taken from the
 * production log rather than composed for the test: session 06804bb2 on
 * 2026-08-02 (`94h52m23s`) and the three sessions of 2026-08-01 that produced
 * B-394 (`119h35m`). Synthetic phrasing here would prove only that the regex
 * matches itself — the lesson from the reconcile incident of 2026-06-28, where
 * 33 green tests on invented fixtures hid a pattern that matched 6.5% of real
 * data.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyAgyFailure,
  isQuotaFailure,
  parseQuotaResetMs,
} from '@/modules/providers/list/antigravity/agy-failure-reason.js';

const NOW = Date.UTC(2026, 7, 2, 17, 38, 34);

const LIVE_QUOTA_LINE =
  'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 94h52m23s.';

describe('parseQuotaResetMs', () => {
  it('reads the live 2026-08-02 quota line into an exact instant', () => {
    const resetAt = parseQuotaResetMs(LIVE_QUOTA_LINE, NOW);
    const expectedMs = (94 * 3600 + 52 * 60 + 23) * 1000;
    assert.equal(resetAt, NOW + expectedMs);
  });

  it('reads the B-394 line, which carries hours and minutes but no seconds', () => {
    const resetAt = parseQuotaResetMs(
      'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 119h35m.',
      NOW
    );
    assert.equal(resetAt, NOW + (119 * 3600 + 35 * 60) * 1000);
  });

  it('reads a minutes-only countdown', () => {
    assert.equal(parseQuotaResetMs('Resets in 45m.', NOW), NOW + 45 * 60 * 1000);
  });

  it('reads a seconds-only countdown', () => {
    assert.equal(parseQuotaResetMs('Resets in 30s.', NOW), NOW + 30_000);
  });

  it('returns null — not a fabricated instant — when the line has no countdown', () => {
    assert.equal(
      parseQuotaResetMs('Error: authentication credentials have expired.', NOW),
      null
    );
    assert.equal(parseQuotaResetMs('Error: model not available.', NOW), null);
  });

  it('returns null for "Resets in" with nothing parseable after it', () => {
    // The regex matches (every capture group is optional), so this case has to
    // be rejected explicitly or it would silently resolve to "now".
    assert.equal(parseQuotaResetMs('Resets in soon.', NOW), null);
  });

  it('rejects an absurd countdown rather than showing a deadline months out', () => {
    assert.equal(parseQuotaResetMs('Resets in 9999h.', NOW), null);
  });

  it('rejects a zero countdown', () => {
    assert.equal(parseQuotaResetMs('Resets in 0h0m0s.', NOW), null);
  });

  it('does not read an unrelated number in the sentence as a deadline', () => {
    // Anchoring on "Resets in" is the whole point: these lines carry other
    // numbers, and a loose duration scan would happily adopt one.
    assert.equal(
      parseQuotaResetMs('Error: your plan allows 5h of daily usage on tier 3.', NOW),
      null
    );
  });

  it('is defensive about non-string and non-finite input', () => {
    assert.equal(parseQuotaResetMs('', NOW), null);
    assert.equal(parseQuotaResetMs(LIVE_QUOTA_LINE, Number.NaN), null);
  });
});

describe('classifyAgyFailure', () => {
  it('classifies quota, model, authentication, and missing CLI failures', () => {
    assert.equal(classifyAgyFailure(LIVE_QUOTA_LINE, 1), 'usage_limit');
    assert.equal(
      classifyAgyFailure('invalid model selection: model is not recognized as a known model', 1),
      'model_not_supported',
    );
    assert.equal(classifyAgyFailure('OAuth token is invalid or expired.', 1), 'authentication_required');
    assert.equal(classifyAgyFailure('', 127), 'cli_not_installed');
  });

  it('falls back to spawn_failed for an unclassified non-zero exit', () => {
    assert.equal(classifyAgyFailure('unexpected internal crash', 1), 'spawn_failed');
    assert.equal(classifyAgyFailure(null, 1), 'spawn_failed');
  });
});

describe('isQuotaFailure', () => {
  it('recognises the live quota line', () => {
    assert.equal(isQuotaFailure(LIVE_QUOTA_LINE), true);
  });

  it('does not treat an expired token as a spent quota', () => {
    // Both are non-zero exits with a stderr line; only one is a provider-wide
    // block, and conflating them would show a phantom countdown in the header.
    assert.equal(isQuotaFailure('Error: authentication credentials have expired.'), false);
    assert.equal(isQuotaFailure('Error: model gemini-3.5-flash is not available.'), false);
  });

  it('is defensive about empty input', () => {
    assert.equal(isQuotaFailure(''), false);
  });
});
