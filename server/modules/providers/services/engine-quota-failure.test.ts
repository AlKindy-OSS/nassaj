/**
 * engine-quota-failure.test.ts — B-411.
 *
 * The guarantee under test is a DISTINCTION, not a match: a spent allowance and
 * a per-second throttle both answer 429 over an Anthropic-compatible endpoint,
 * and they need opposite responses from the user (buy/wait-for-reset vs. slow
 * down). Every case below is one side of that line, plus the refusal to invent a
 * reset instant the vendor never stated.
 *
 * Error shapes are taken from what the vendors actually emit — OpenAI-compatible
 * `insufficient_quota` bodies, Anthropic-compatible `credit balance is too low`,
 * and Z.AI's own 429 — rather than invented, because a classifier tested only on
 * strings its author imagined is the synthetic-fixture trap this repo has paid
 * for before.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyEngineFailure,
  engineFailureMessage,
  parseEngineRetryAfterMs,
} from '@/modules/providers/services/engine-quota-failure.js';

const NOW = 1_754_000_000_000;

// ── exhaustion ────────────────────────────────────────────────────────────────

test('quota: OpenAI-compatible insufficient_quota body is an exhaustion', () => {
  const verdict = classifyEngineFailure(
    { status: 429, error: { type: 'insufficient_quota', message: 'You exceeded your current quota' } },
    NOW,
  );
  assert.equal(verdict.kind, 'quota_exhausted');
});

test('quota: Anthropic-compatible credit-balance body is an exhaustion', () => {
  const verdict = classifyEngineFailure(
    { status: 400, message: 'Your credit balance is too low to access the API' },
    NOW,
  );
  assert.equal(verdict.kind, 'quota_exhausted');
});

test('quota: an exhaustion phrase WINS over a 429 status', () => {
  // Both signals present. The sentence is the only thing that separates a spent
  // allowance from a throttle, so it must decide.
  const verdict = classifyEngineFailure(
    { status: 429, message: 'Daily quota exceeded for glm-4.7-flash' },
    NOW,
  );
  assert.equal(verdict.kind, 'quota_exhausted');
});

// ── throttling ────────────────────────────────────────────────────────────────

test('rate limit: a bare 429 with no quota vocabulary is read as throttling', () => {
  // The conservative reading: telling a user their quota is finished when it is
  // not sends them to buy capacity they already have.
  const verdict = classifyEngineFailure({ status: 429, message: 'Too Many Requests' }, NOW);
  assert.equal(verdict.kind, 'rate_limited');
});

test('rate limit: the free tier one-per-second refusal is throttling, not exhaustion', () => {
  const verdict = classifyEngineFailure(
    { status: 429, message: 'Rate limit reached: 1 requests per second' },
    NOW,
  );
  assert.equal(verdict.kind, 'rate_limited');
});

// ── everything else stays out ─────────────────────────────────────────────────

test('other: auth and network faults are NOT claimed by this classifier', () => {
  assert.equal(classifyEngineFailure({ status: 401, message: 'invalid api key' }, NOW).kind, 'other');
  assert.equal(classifyEngineFailure({ code: 'ECONNRESET' }, NOW).kind, 'other');
  assert.equal(classifyEngineFailure(null, NOW).kind, 'other');
  assert.equal(classifyEngineFailure('some unrelated stderr', NOW).kind, 'other');
});

test('other: a non-quota failure carries NO reset instant even if the text has a number', () => {
  const verdict = classifyEngineFailure({ status: 500, message: 'retry-after 30 internal' }, NOW);
  assert.equal(verdict.kind, 'other');
  // `other` is not our business, so it never exports a deadline.
  assert.equal(verdict.quotaResetsAtMs, null);
});

// ── the reset instant: stated or nothing ──────────────────────────────────────

test('reset: a stated retry-after becomes an instant', () => {
  assert.equal(parseEngineRetryAfterMs('retry-after: 60', NOW), NOW + 60_000);
  assert.equal(parseEngineRetryAfterMs('"retry_after": 30', NOW), NOW + 30_000);
});

test('reset: no retry-after ⇒ null, never a fabricated deadline', () => {
  const verdict = classifyEngineFailure({ status: 429, message: 'insufficient_quota' }, NOW);
  assert.equal(verdict.kind, 'quota_exhausted');
  // The vendor said nothing about when capacity returns, so neither do we — a
  // wrong countdown renders identically to a right one once the UI has a number.
  assert.equal(verdict.quotaResetsAtMs, null);
});

test('reset: absurd or zero durations are rejected', () => {
  assert.equal(parseEngineRetryAfterMs('retry-after: 0', NOW), null);
  // Past the 30-day bound.
  assert.equal(parseEngineRetryAfterMs('retry-after: 9999999', NOW), null);
  assert.equal(parseEngineRetryAfterMs('retry-after: 60', Number.NaN), null);
});

// ── the message names the ENGINE ──────────────────────────────────────────────

test('message: names the engine, not Claude, and differs per kind', () => {
  const quota = engineFailureMessage({ kind: 'quota_exhausted', quotaResetsAtMs: null }, 'GLM');
  assert.match(quota as string, /GLM/);
  assert.doesNotMatch(quota as string, /Claude/);

  const throttled = engineFailureMessage({ kind: 'rate_limited', quotaResetsAtMs: null }, 'GLM');
  assert.match(throttled as string, /GLM/);
  // The two must not read alike: one says buy/wait for reset, the other says slow down.
  assert.notEqual(quota, throttled);

  assert.equal(engineFailureMessage({ kind: 'other', quotaResetsAtMs: null }, 'GLM'), null);
});
