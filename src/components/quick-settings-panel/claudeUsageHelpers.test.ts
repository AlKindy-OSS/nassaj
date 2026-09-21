/**
 * Extra-usage credit visibility must distinguish an explicit zero from a
 * missing amount. A zero is valid data; a missing field is not a balance.
 * RUNNER: node:test via `npm run test:src`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasDisplayableExtraUsageCredits } from './claudeUsageHelpers';

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
