import { beforeEach, describe, expect, it, vi } from 'vitest';

import html from '../../index.html?raw';

import { resolveIsDark } from './theme-mode';

const bootstrap = html.match(
  /<script id="theme-mode-bootstrap">([\s\S]*?)<\/script>/,
)?.[1];

function runBootstrap(mode: string | null, prefersDark: boolean) {
  if (mode === null) localStorage.removeItem('theme');
  else localStorage.setItem('theme', mode);
  window.matchMedia = vi.fn(() => ({ matches: prefersDark })) as unknown as typeof window.matchMedia;
  document.documentElement.classList.remove('dark');
  new Function(bootstrap ?? '')();
  return document.documentElement.classList.contains('dark');
}

describe('blocking theme bootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('exists in head before styles and the application module', () => {
    expect(bootstrap).toBeTruthy();
    expect(html.indexOf('id="theme-mode-bootstrap"')).toBeLessThan(html.indexOf('rel="icon"'));
    expect(html.indexOf('id="theme-mode-bootstrap"')).toBeLessThan(html.indexOf('src="/src/main.jsx"'));
  });

  for (const mode of [null, 'light', 'dark', 'system', 'future-value']) {
    for (const prefersDark of [false, true]) {
      it(`stays in parity with resolveIsDark (${String(mode)}, OS ${prefersDark ? 'dark' : 'light'})`, () => {
        window.matchMedia = vi.fn(() => ({ matches: prefersDark })) as unknown as typeof window.matchMedia;
        expect(runBootstrap(mode, prefersDark)).toBe(resolveIsDark(mode));
      });
    }
  }

  it('never blocks startup when storage access fails', () => {
    window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia;
    document.documentElement.classList.add('dark');
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => new Function(bootstrap ?? '')()).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    getItem.mockRestore();
  });

  it('falls back to light when matchMedia is unavailable', () => {
    const originalMatchMedia = window.matchMedia;
    // @ts-expect-error — deliberately exercising an older browser environment.
    delete window.matchMedia;
    localStorage.setItem('theme', 'system');
    document.documentElement.classList.add('dark');

    expect(() => new Function(bootstrap ?? '')()).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    window.matchMedia = originalMatchMedia;
  });
});
