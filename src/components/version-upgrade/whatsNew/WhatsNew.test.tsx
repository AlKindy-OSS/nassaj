import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import arCommon from '../../../i18n/locales/ar/common.json';
import enCommon from '../../../i18n/locales/en/common.json';
import { WHATS_NEW, getWhatsNew } from './highlights';
import { WHATS_NEW_SEEN_KEY, resolveWhatsNewVersion, useWhatsNew } from './useWhatsNew';
import { WhatsNewDialog, releaseNotesUrl } from './WhatsNewDialog';

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

function Harness({ version, lang = 'ar' }: { version: string | null; lang?: string }) {
  const { version: shown, items, dismiss } = useWhatsNew(version, lang);
  return shown && items ? <WhatsNewDialog version={shown} items={items} onDismiss={dismiss} /> : null;
}

function renderHarness(version: string | null, lang: 'ar' | 'en' = 'ar') {
  void i18n.changeLanguage(lang);
  return render(
    <I18nextProvider i18n={i18n}>
      <Harness version={version} lang={lang} />
    </I18nextProvider>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe('highlights data', () => {
  it('seeds 2.3.1.10 and 2.3.1.11 with the same number of items in both languages', () => {
    for (const v of ['2.3.1.10', '2.3.1.11']) {
      expect(WHATS_NEW[v].ar.length).toBeGreaterThan(0);
      expect(WHATS_NEW[v].ar.length).toBe(WHATS_NEW[v].en.length);
    }
  });

  it('picks the language and returns null for an unknown version', () => {
    expect(getWhatsNew('2.3.1.10', 'ar')?.[0]).toBe(WHATS_NEW['2.3.1.10'].ar[0]);
    expect(getWhatsNew('2.3.1.10', 'en-US')?.[0]).toBe(WHATS_NEW['2.3.1.10'].en[0]);
    expect(getWhatsNew('9.9.9.9', 'ar')).toBeNull();
    expect(getWhatsNew('constructor', 'ar')).toBeNull();
    expect(getWhatsNew(null, 'ar')).toBeNull();
  });
});

describe('resolveWhatsNewVersion', () => {
  it('shows for a new version with an entry, never for a seen or unknown one', () => {
    expect(resolveWhatsNewVersion('2.3.1.10', null, 'ar')).toBe('2.3.1.10');
    expect(resolveWhatsNewVersion('2.3.1.10', '2.3.1.9', 'ar')).toBe('2.3.1.10');
    expect(resolveWhatsNewVersion('2.3.1.10', '2.3.1.10', 'ar')).toBeNull();
    expect(resolveWhatsNewVersion('9.9.9.9', '2.3.1.10', 'ar')).toBeNull();
    expect(resolveWhatsNewVersion('—', null, 'ar')).toBeNull();
  });
});

describe('WhatsNew popup', () => {
  it('shows the highlights once, and dismissing with OK persists the version', () => {
    renderHarness('2.3.1.10');
    const dialog = screen.getByTestId('whats-new-dialog');
    expect(dialog.textContent).toContain(WHATS_NEW['2.3.1.10'].ar[0]);
    expect(screen.getAllByRole('listitem')).toHaveLength(WHATS_NEW['2.3.1.10'].ar.length);

    fireEvent.click(screen.getByRole('button', { name: arCommon.dialog.ok }));
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe('2.3.1.10');

    cleanup();
    renderHarness('2.3.1.10');
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
  });

  it('shows again once the running version changes to another with an entry', () => {
    window.localStorage.setItem(WHATS_NEW_SEEN_KEY, '2.3.1.10');
    renderHarness('2.3.1.11', 'en');
    expect(screen.getByTestId('whats-new-dialog').textContent).toContain(WHATS_NEW['2.3.1.11'].en[0]);
  });

  it('does not show when the version has no entry', () => {
    renderHarness('9.9.9.9');
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBeNull();
  });

  it('closes and persists through the close button and Escape', () => {
    renderHarness('2.3.1.10');
    fireEvent.click(screen.getByRole('button', { name: arCommon.whatsNew.close }));
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe('2.3.1.10');

    cleanup();
    window.localStorage.clear();
    renderHarness('2.3.1.11');
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe('2.3.1.11');
  });

  it('links to the public release page and labels the dialog', () => {
    renderHarness('2.3.1.10');
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(releaseNotesUrl('2.3.1.10'));
    expect(link.getAttribute('href')).toMatch(/\/releases\/tag\/v2\.3\.1\.10$/);
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
