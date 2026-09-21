/** Ensures the agent usage surface never falls back to untranslated Arabic copy. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('./AgentUsageSection.tsx', import.meta.url), 'utf8');

function settingsLocale(language: 'ar' | 'en') {
  return JSON.parse(readFileSync(new URL(`../../../../../../../i18n/locales/${language}/settings.json`, import.meta.url), 'utf8')) as {
    agentUsage?: Record<string, string>;
    claudeUsage?: { windows?: Record<string, string> };
  };
}

describe('AgentUsageSection translations', () => {
  it('defines the usage and additional-credit copy in Arabic and English', () => {
    const ar = settingsLocale('ar');
    assert.deepEqual(ar.agentUsage, {
      title: 'حدود الاستخدام',
      claudeDescription: 'نوافذ الاستخدام ورصيد الاستخدام الإضافي لحساب Claude',
      providerDescription: 'نوافذ الاستخدام التي يعلنها المزوّد',
      noData: 'لا يوفّر هذا المزوّد بيانات استخدام لهذا الحساب.',
      codexExtraCredits: 'رصيد Codex الإضافي',
      unlimited: 'غير محدود',
      creditUnits: '{{formattedCount}} وحدة كريديت',
    });
    assert.equal(ar.claudeUsage?.windows?.extraUsage, 'رصيد الاستخدام الإضافي');

    const en = settingsLocale('en');
    assert.deepEqual(en.agentUsage, {
      title: 'Usage limits',
      claudeDescription: 'Usage windows and extra usage credits for this Claude account',
      providerDescription: 'Usage windows reported by the provider',
      noData: 'This provider does not expose usage data for this account.',
      codexExtraCredits: 'Extra Codex credits',
      unlimited: 'Unlimited',
      creditUnits: '{{formattedCount}} credit units',
    });
    assert.equal(en.claudeUsage?.windows?.extraUsage, 'Extra usage credits');
  });

  it('does not leave an Arabic default value in the translated agent usage surface', () => {
    assert.doesNotMatch(source, /defaultValue:\s*['"](?:حدود الاستخدام|نوافذ استخدام|لا يوفّر)/);
  });
});
