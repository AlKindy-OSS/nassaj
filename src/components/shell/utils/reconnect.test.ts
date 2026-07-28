/**
 * Unit tests for the shell auto-reconnect helpers. These import the REAL
 * production functions so any drift in the loop-prevention logic (backoff
 * growth, the attempt cap, the intentional-vs-abnormal close split) fails here.
 *
 * Runs under `npm run test:client` (vitest).
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_RECONNECT_ATTEMPTS,
  NORMAL_CLOSE_CODE,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  computeBackoffDelay,
  isIntentionalShellClose,
  shouldRetryReconnect,
} from './reconnect';

describe('computeBackoffDelay', () => {
  it('doubles from the base delay per attempt', () => {
    expect(computeBackoffDelay(0)).toBe(1000);
    expect(computeBackoffDelay(1)).toBe(2000);
    expect(computeBackoffDelay(2)).toBe(4000);
    expect(computeBackoffDelay(3)).toBe(8000);
  });

  it('clamps to the max delay and never grows unbounded', () => {
    // 2^4 * 1000 = 16000 → capped at 10000; every later attempt stays capped.
    expect(computeBackoffDelay(4)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(computeBackoffDelay(5)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(computeBackoffDelay(50)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('treats negative attempts as the first step (defensive)', () => {
    expect(computeBackoffDelay(-3)).toBe(RECONNECT_BASE_DELAY_MS);
  });
});

describe('shouldRetryReconnect', () => {
  it('allows retries below the cap and stops at it', () => {
    for (let made = 0; made < MAX_RECONNECT_ATTEMPTS; made += 1) {
      expect(shouldRetryReconnect(made)).toBe(true);
    }
    expect(shouldRetryReconnect(MAX_RECONNECT_ATTEMPTS)).toBe(false);
    expect(shouldRetryReconnect(MAX_RECONNECT_ATTEMPTS + 1)).toBe(false);
  });

  it('a full backoff run terminates in bounded total time', () => {
    // Simulate the loop: retry while allowed, summing delays. Must terminate.
    let attempts = 0;
    let total = 0;
    while (shouldRetryReconnect(attempts)) {
      total += computeBackoffDelay(attempts);
      attempts += 1;
    }
    expect(attempts).toBe(MAX_RECONNECT_ATTEMPTS);
    // 1000+2000+4000+8000+10000+10000 = 35000ms, a finite bound.
    expect(total).toBe(35000);
  });
});

describe('isIntentionalShellClose', () => {
  it('is intentional when the caller suppressed auto-connect (user teardown)', () => {
    expect(isIntentionalShellClose(1006, true)).toBe(true);
    expect(isIntentionalShellClose(1001, true)).toBe(true);
  });

  it('is intentional on a clean normal closure', () => {
    expect(isIntentionalShellClose(NORMAL_CLOSE_CODE, false)).toBe(true);
  });

  it('is NOT intentional on an abnormal keepalive drop', () => {
    // 1006 with no suppress = the keepalive cull we must auto-reconnect.
    expect(isIntentionalShellClose(1006, false)).toBe(false);
    expect(isIntentionalShellClose(1001, false)).toBe(false);
  });
});
