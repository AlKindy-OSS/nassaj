/**
 * ScheduledWaitPanel — real i18next rendering (not the flat key-lookup mock
 * VersionUpgradeModal.test.tsx uses), so Arabic CLDR plural resolution
 * (zero/one/two/few/many/other) is actually exercised, not merely assumed.
 *
 * Covers two qa-critic findings on T-1912:
 *  5. An `earliestAt` in the past (or exactly now) must read as "due now",
 *     never "in 1 minute" (the old floor-at-1 clamp lied about the time).
 *  6. Arabic message/minute counts must use the full CLDR plural set, not
 *     just one/other (which reads "2 رسائل" / "3 دقيقة" — both wrong).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import arCommon from '../../../i18n/locales/ar/common.json';
import enCommon from '../../../i18n/locales/en/common.json';
import type { ScheduledDueSoon } from '../updateJobClient';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));

const { ScheduledWaitPanel } = await import('./ScheduledWaitPanel');

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { ar: { common: arCommon }, en: { common: enCommon } },
  lng: 'ar',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

afterEach(() => {
  cleanup();
});

function renderPanel(dueSoon: ScheduledDueSoon, lang: 'ar' | 'en' = 'ar') {
  i18n.changeLanguage(lang);
  return render(
    <I18nextProvider i18n={i18n}>
      <ScheduledWaitPanel dueSoon={dueSoon} jobId="job-1" overridden={false} onOverridden={vi.fn()} />
    </I18nextProvider>,
  );
}

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const inPast = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe('ScheduledWaitPanel — overdue wording (finding 5)', () => {
  it('shows "due now" wording when earliestAt is in the past', () => {
    renderPanel({ count: 1, earliestAt: inPast(5) });
    expect(screen.getByText(/مستحقة الآن/)).not.toBeNull();
    // "بعد إرسالها" (after it's sent) is unrelated boilerplate; only the
    // "due in N minutes" phrasing ("موعدها بعد") must be absent.
    expect(screen.queryByText(/موعدها بعد/)).toBeNull();
  });

  it('shows "due now" wording when earliestAt is exactly now', () => {
    renderPanel({ count: 1, earliestAt: new Date().toISOString() });
    expect(screen.getByText(/مستحقة الآن/)).not.toBeNull();
  });

  it('shows the future "in N minutes" wording when earliestAt is ahead', () => {
    renderPanel({ count: 1, earliestAt: inMinutes(10) });
    expect(screen.queryByText(/مستحقة الآن/)).toBeNull();
    expect(screen.getByText(/دقيقة/)).not.toBeNull();
  });

  it('shows the English "due now" wording when earliestAt is in the past', () => {
    renderPanel({ count: 1, earliestAt: inPast(5) }, 'en');
    expect(screen.getByText(/due now/)).not.toBeNull();
  });
});

describe('ScheduledWaitPanel — Arabic plural forms (finding 6)', () => {
  it.each([
    [1, 'رسالة مجدولة واحدة'],
    [2, 'رسالتان'],
    [3, '3 رسائل'],
    [11, '11 رسالة'],
  ])('renders the correct Arabic message-count form for count=%s', (count, expected) => {
    renderPanel({ count, earliestAt: inMinutes(10) });
    expect(screen.getByText(new RegExp(expected))).not.toBeNull();
  });

  it.each([
    [1, 'دقيقة واحدة'],
    [2, 'دقيقتان'],
    [3, '3 دقائق'],
    [11, '11 دقيقة'],
  ])('renders the correct Arabic minutes form for minutes=%s', (minutes, expected) => {
    renderPanel({ count: 1, earliestAt: inMinutes(minutes) });
    expect(screen.getByText(new RegExp(expected))).not.toBeNull();
  });

  it('never renders the broken "N رسائل" / "N دقيقة" one-size-fits-all form for count=2', () => {
    renderPanel({ count: 2, earliestAt: inMinutes(2) });
    expect(screen.queryByText(/2 رسائل/)).toBeNull();
    expect(screen.queryByText(/2 دقيقة(?!تان)/)).toBeNull();
  });
});
