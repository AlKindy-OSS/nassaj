import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import i18n from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arWiki from '../../../i18n/locales/ar/wiki.json';
import enWiki from '../../../i18n/locales/en/wiki.json';

import WikiPanel from './WikiPanel';

function mockDesktop() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('768'),
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockDesktop();
});
afterEach(cleanup);

describe('the Arabic-only wiki shell', () => {
  it('stays Arabic when the application language and an obsolete preference are English', () => {
    i18n.language = 'en';
    localStorage.setItem('wikiLanguage', 'en');
    render(<WikiPanel />);

    const root = document.querySelector('[data-wiki-panel]') as HTMLElement;
    expect(root.getAttribute('dir')).toBe('rtl');
    expect(root.getAttribute('lang')).toBe('ar');
    expect(screen.getByText(arWiki.home.title)).toBeTruthy();
    expect(screen.queryByText(enWiki.home.title)).toBeNull();
    expect(document.querySelector('[data-wiki-language-notice]')).toBeNull();
  });

  it('replaces the TOC completely when navigating between real pages', () => {
    i18n.language = 'en';
    render(<WikiPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'التحديثات' }));
    const updatesToc = document.querySelector('[data-wiki-toc-inline]') as HTMLElement;
    const updatesDisclosure = within(updatesToc).getByRole('button', { name: 'في هذه الصفحة' });
    if (updatesDisclosure.getAttribute('aria-expanded') === 'false') {
      fireEvent.click(updatesDisclosure);
    }
    expect(within(updatesToc).getByText(/الإصدار 1\.44\.0\.0/)).toBeTruthy();
    expect(within(updatesToc).queryByText('الإصدار X.x.x.x — اليوم الشهر السنة')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'لوحة الأوامر: الأصفر والأحمر' }));
    const commandToc = document.querySelector('[data-wiki-toc-inline]') as HTMLElement;
    const commandDisclosure = within(commandToc).getByRole('button', { name: 'في هذه الصفحة' });
    if (commandDisclosure.getAttribute('aria-expanded') === 'false') {
      fireEvent.click(commandDisclosure);
    }
    expect(within(commandToc).getByText('أين أجد اللوحة؟')).toBeTruthy();
    expect(within(commandToc).queryByText(/الإصدار 1\.44\.0\.0/)).toBeNull();
  });
});
