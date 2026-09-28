/**
 * `normalizeClaudeExtraUsage` — the shared credit-display rule for Claude.
 *
 * Upstream `extra_usage` carries `is_enabled`, `monthly_limit`, `used_credits`
 * (cents), `utilization`, `currency`. Only `is_enabled: true` means a pool
 * exists; everything else must surface as `null` (hide), never as zero.
 *
 * RUNNER: node:test via `npm run test:server`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeClaudeExtraUsage } from '@/modules/providers/services/claude-usage.service.js';

const ENABLED = {
  is_enabled: true,
  monthly_limit: 8000,
  used_credits: 5127,
  utilization: 64.09,
  currency: 'USD',
};

test('extra usage disabled or absent is hidden (null), never zero', () => {
  for (const value of [
    undefined,
    null,
    'x',
    {},
    { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    { is_enabled: false, monthly_limit: 0, used_credits: 0, utilization: 0 },
    { ...ENABLED, is_enabled: 'true' },
  ]) {
    assert.equal(normalizeClaudeExtraUsage(value), null, JSON.stringify(value));
  }
});

test('enabled pool with a positive remainder is passed through', () => {
  assert.deepEqual(normalizeClaudeExtraUsage(ENABLED), {
    enabled: true,
    monthlyLimit: 8000,
    usedCredits: 5127,
    utilization: 64.09,
    currency: 'USD',
  });
});

test('enabled pool that is fully spent keeps its confirmed numbers', () => {
  const result = normalizeClaudeExtraUsage({ ...ENABLED, used_credits: 8000, utilization: 100 });
  assert.equal(result?.monthlyLimit, 8000);
  assert.equal(result?.usedCredits, 8000);
});

test('enabled pool with missing or invalid numbers leaves them null, not zero', () => {
  const result = normalizeClaudeExtraUsage({
    is_enabled: true,
    monthly_limit: null,
    used_credits: -1,
    utilization: 'high',
  });
  assert.deepEqual(result, {
    enabled: true,
    monthlyLimit: null,
    usedCredits: null,
    utilization: null,
    currency: null,
  });
});
