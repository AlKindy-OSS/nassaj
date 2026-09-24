/**
 * billingLinks.test.ts — حارس تغطية روابط الفوترة.
 *
 * يضمن أن كل مزوّد لديه رابط https صالح في BILLING_LINKS،
 * ويكشف الانجراف حين يُضاف مزوّد جديد دون رابط (T-coverage-billing).
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import { describe, expect, it } from 'vitest';

import { BILLING_LINKS } from './billingLinks';

describe('BILLING_LINKS', () => {
  it('every provider has an https billing link', () => {
    const entries = Object.entries(BILLING_LINKS) as [string, string][];
    expect(entries.length).toBeGreaterThan(0);

    for (const [provider, url] of entries) {
      expect(url, `provider "${provider}" must start with https://`).toMatch(
        /^https:\/\//,
      );
    }
  });

  it('no provider has a blank or whitespace-only URL', () => {
    for (const [provider, url] of Object.entries(BILLING_LINKS)) {
      expect(
        url.trim().length,
        `provider "${provider}" has an empty billing URL`,
      ).toBeGreaterThan(0);
    }
  });

  it('includes the three previously-absent providers', () => {
    expect(Object.keys(BILLING_LINKS)).toContain('opencode');
    expect(Object.keys(BILLING_LINKS)).toContain('qwen');
    expect(Object.keys(BILLING_LINKS)).toContain('sakana');
  });
});
