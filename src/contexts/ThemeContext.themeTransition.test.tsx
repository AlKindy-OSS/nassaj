import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider, useTheme } from './ThemeContext';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en' } }),
}));

function ThemeControls() {
  const { setThemeMode } = useTheme();
  return (
    <>
      <button onClick={() => setThemeMode('light')}>light</button>
      <button onClick={() => setThemeMode('dark')}>dark</button>
      <button onClick={() => setThemeMode('system')}>system</button>
    </>
  );
}

function themeColor() {
  return document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content;
}

function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  window.matchMedia = vi.fn(() => ({
    matches,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    matches = next;
    listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent));
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  document.head.innerHTML = [
    '<meta name="theme-color" content="#ffffff">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  ].join('');
});

afterEach(cleanup);

describe('ThemeProvider transitions', () => {
  it('commits mode class, preset tokens, and theme-color together', () => {
    installMatchMedia(false);
    localStorage.setItem('theme', 'light');
    render(<ThemeProvider><ThemeControls /></ThemeProvider>);
    expect(themeColor()).toBe('#f7f7f4');

    fireEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('221 47% 11%');
    expect(themeColor()).toBe('#0f1729');

    fireEvent.click(screen.getByRole('button', { name: 'light' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('60 15.789% 96.275%');
    expect(themeColor()).toBe('#f7f7f4');
  });

  it('commits a live system-mode change through the same path', () => {
    const changeSystemMode = installMatchMedia(false);
    localStorage.setItem('theme', 'system');
    render(<ThemeProvider><ThemeControls /></ThemeProvider>);

    act(() => changeSystemMode(true));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('221 47% 11%');
    expect(themeColor()).toBe('#0f1729');
  });
});
