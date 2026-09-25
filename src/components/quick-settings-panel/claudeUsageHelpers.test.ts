/**
 * Extra-usage credit visibility must distinguish an explicit zero from a
 * missing amount. A zero is valid data; a missing field is not a balance.
 * RUNNER: node:test via `npm run test:src`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatCreditBalance,
  formatRemainingHarnessCredits,
  hasDisplayableExtraUsageCredits,
} from './claudeUsageHelpers';

const extraUsage = {
  enabled: true,
  usedCredits: 0,
  monthlyLimit: 8_000,
  utilization: 0,
  currency: 'USD',
};

describe('hasDisplayableExtraUsageCredits', () => {
  it('shows an explicit additional-credit balance, including a valid zero amount', () => {
    assert.equal(hasDisplayableExtraUsageCredits(extraUsage), true);
  });

  it('hides incomplete or malformed amounts instead of presenting them as zero', () => {
    assert.equal(hasDisplayableExtraUsageCredits({ ...extraUsage, usedCredits: Number.NaN }), false);
    assert.equal(hasDisplayableExtraUsageCredits({ ...extraUsage, monthlyLimit: Number.POSITIVE_INFINITY }), false);
    assert.equal(hasDisplayableExtraUsageCredits({ ...extraUsage, usedCredits: -1 }), false);
    assert.equal(hasDisplayableExtraUsageCredits({ ...extraUsage, monthlyLimit: -1 }), false);
    assert.equal(hasDisplayableExtraUsageCredits({ ...extraUsage, monthlyLimit: 0, usedCredits: 1 }), false);
    assert.equal(hasDisplayableExtraUsageCredits({ ...extraUsage, utilization: -0.1 }), false);
    assert.equal(hasDisplayableExtraUsageCredits({ ...extraUsage, utilization: 100.1 }), false);
    assert.equal(hasDisplayableExtraUsageCredits({ ...extraUsage, currency: '  ' }), false);
    assert.equal(hasDisplayableExtraUsageCredits({ ...extraUsage, enabled: false }), false);
  });
});

// Shared by HeaderUsageIndicator and ClaudeUsageCollapsed for the "+N" credit
// badges — one helper each so the two surfaces can't drift apart (T-1858
// qa-critic round 2, item 3).
describe('formatCreditBalance', () => {
  it('formats a plain balance with at most 2 fraction digits, locale-shaped', () => {
    assert.equal(formatCreditBalance(42, 'en'), '42');
    assert.equal(formatCreditBalance(17.256, 'en'), '17.26');
  });
});

describe('formatRemainingHarnessCredits', () => {
  it('formats monthlyLimit - usedCredits as currency via formatCredits', () => {
    const usage = { monthlyLimit: 8_000, usedCredits: 3_000, currency: 'USD' };
    // (8000 - 3000) cents = $50.00.
    assert.equal(formatRemainingHarnessCredits(usage, 'en-US'), '$50.00');
  });

  it('handles a fully-consumed balance (remaining zero)', () => {
    const usage = { monthlyLimit: 8_000, usedCredits: 8_000, currency: 'USD' };
    assert.equal(formatRemainingHarnessCredits(usage, 'en-US'), '$0.00');
  });
});
