import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../../../contexts/ThemeContext';

import DarkModeToggle from './DarkModeToggle';

const LABELS: Record<string, string> = {
  'appearanceSettings.themeMode.light': 'Light',
  'appearanceSettings.themeMode.dark': 'Dark',
  'appearanceSettings.themeMode.system': 'System',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, opts?: { current?: string; next?: string }) =>
      key === 'appearanceSettings.themeMode.cycleLabel'
        ? `Theme: ${opts?.current}. Switch to ${opts?.next}`
        : LABELS[key] ?? key,
  }),
}));

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(cleanup);

describe('DarkModeToggle', () => {
  it('cycles light → dark → system → light with a label naming current and next', () => {
    localStorage.setItem('theme', 'light');
    render(<ThemeProvider><DarkModeToggle /></ThemeProvider>);
    const button = screen.getByRole('button');

    expect(button.getAttribute('aria-label')).toBe('Theme: Light. Switch to Dark');
    expect(button.getAttribute('data-theme-mode')).toBe('light');

    fireEvent.click(button);
    expect(button.getAttribute('aria-label')).toBe('Theme: Dark. Switch to System');
    expect(button.getAttribute('data-theme-mode')).toBe('dark');

    fireEvent.click(button);
    expect(button.getAttribute('aria-label')).toBe('Theme: System. Switch to Light');
    expect(button.getAttribute('data-theme-mode')).toBe('system');
    expect(localStorage.getItem('theme')).toBe('system');

    fireEvent.click(button);
    expect(button.getAttribute('data-theme-mode')).toBe('light');
  });

  it('is a plain button, not a two-state switch', () => {
    render(<ThemeProvider><DarkModeToggle /></ThemeProvider>);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });
});
