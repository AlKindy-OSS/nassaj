/**
 * Extra-usage credit visibility must distinguish an explicit zero from a
 * missing amount. A zero is valid data; a missing field is not a balance.
 * RUNNER: node:test via `npm run test:src`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatClaudeExtraBadgeText,
  formatClaudeExtraDetailAmounts,
  formatCreditBalance,
  hasDisplayableExtraUsageCredits,
  resolveClaudeExtraUsageDisplay,
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

describe('resolveClaudeExtraUsageDisplay', () => {
  it('hidden: missing/disabled/malformed, and enabled with a null limit', () => {
    assert.deepEqual(resolveClaudeExtraUsageDisplay(null), { kind: 'hidden' });
    assert.deepEqual(resolveClaudeExtraUsageDisplay(undefined), { kind: 'hidden' });
    assert.deepEqual(resolveClaudeExtraUsageDisplay({ ...extraUsage, enabled: false }), {
      kind: 'hidden',
    });
    // monthlyLimit: null means its meaning is unverified — must not be
    // zero-filled, so the badge stays hidden rather than claiming $0.
    assert.deepEqual(resolveClaudeExtraUsageDisplay({ ...extraUsage, monthlyLimit: null }), {
      kind: 'hidden',
    });
    assert.deepEqual(resolveClaudeExtraUsageDisplay({ ...extraUsage, usedCredits: null }), {
      kind: 'hidden',
    });
  });

  it('zero: the harness confirms the pool is fully consumed (used === limit)', () => {
    assert.deepEqual(
      resolveClaudeExtraUsageDisplay({ ...extraUsage, usedCredits: 8_000, monthlyLimit: 8_000 }),
      { kind: 'zero', usedCents: 8_000, limitCents: 8_000, currency: 'USD' },
    );
  });

  it('zero: an overage (used > limit) is also a confirmed empty pool, not hidden', () => {
    assert.deepEqual(
      resolveClaudeExtraUsageDisplay({ ...extraUsage, usedCredits: 9_000, monthlyLimit: 8_000 }),
      { kind: 'zero', usedCents: 9_000, limitCents: 8_000, currency: 'USD' },
    );
  });

  it('zero: the decision needs neither utilization nor currency — both may be null', () => {
    assert.deepEqual(
      resolveClaudeExtraUsageDisplay({
        enabled: true,
        usedCredits: 9_000,
        monthlyLimit: 8_000,
        utilization: null,
        currency: null,
      }),
      { kind: 'zero', usedCents: 9_000, limitCents: 8_000, currency: null },
    );
  });

  it('amount: a positive remaining balance carries its cents and currency', () => {
    assert.deepEqual(
      resolveClaudeExtraUsageDisplay({ ...extraUsage, usedCredits: 3_000, monthlyLimit: 8_000 }),
      { kind: 'amount', remainingCents: 5_000, usedCents: 3_000, limitCents: 8_000, currency: 'USD' },
    );
  });

  it('amount requires a currency to state a truthful sum; missing currency hides it', () => {
    assert.deepEqual(
      resolveClaudeExtraUsageDisplay({
        enabled: true,
        usedCredits: 3_000,
        monthlyLimit: 8_000,
        utilization: null,
        currency: null,
      }),
      { kind: 'hidden' },
    );
  });
});

describe('formatClaudeExtraBadgeText', () => {
  it('hidden ⇒ null', () => {
    assert.equal(formatClaudeExtraBadgeText({ kind: 'hidden' }, 'en-US'), null);
  });

  it('zero with a known currency ⇒ "$0.00"', () => {
    assert.equal(
      formatClaudeExtraBadgeText(
        { kind: 'zero', usedCents: 9_000, limitCents: 8_000, currency: 'USD' },
        'en-US',
      ),
      '$0.00',
    );
  });

  it('zero without a currency (overage, no unit reported) ⇒ plain "0"', () => {
    assert.equal(
      formatClaudeExtraBadgeText(
        { kind: 'zero', usedCents: 9_000, limitCents: 8_000, currency: null },
        'en-US',
      ),
      '0',
    );
  });

  it('amount ⇒ formatted currency', () => {
    assert.equal(
      formatClaudeExtraBadgeText(
        { kind: 'amount', remainingCents: 5_000, usedCents: 3_000, limitCents: 8_000, currency: 'USD' },
        'en-US',
      ),
      '$50.00',
    );
  });
});

describe('formatClaudeExtraDetailAmounts', () => {
  it('hidden or no known currency ⇒ null (no truthful amount to state)', () => {
    assert.equal(formatClaudeExtraDetailAmounts({ kind: 'hidden' }, 'en-US'), null);
    assert.equal(
      formatClaudeExtraDetailAmounts(
        { kind: 'zero', usedCents: 9_000, limitCents: 8_000, currency: null },
        'en-US',
      ),
      null,
    );
  });

  it('currency known ⇒ used/limit both formatted', () => {
    assert.deepEqual(
      formatClaudeExtraDetailAmounts(
        { kind: 'amount', remainingCents: 5_000, usedCents: 3_000, limitCents: 8_000, currency: 'USD' },
        'en-US',
      ),
      { used: '$30.00', limit: '$80.00' },
    );
  });
});
