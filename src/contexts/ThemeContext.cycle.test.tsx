import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextThemeMode } from '../lib/theme-mode';

import { ThemeProvider, useTheme } from './ThemeContext';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en' } }),
}));

const serverHandlers = vi.hoisted(() => new Map<string, (raw: unknown) => void>());
const applyServerPreference = (key: string, raw: unknown) => serverHandlers.get(key)?.(raw);

vi.mock('../preferences/preferencesSync', () => ({
  onApplyServerPreference: (key: string, handler: (raw: unknown) => void) => {
    serverHandlers.set(key, handler);
    return () => serverHandlers.delete(key);
  },
}));

function Probe() {
  const { themeMode, cycleThemeMode, toggleDarkMode, setThemeMode } = useTheme();
  return (
    <>
      <output data-testid="mode">{themeMode}</output>
      <button onClick={cycleThemeMode}>cycle</button>
      <button onClick={toggleDarkMode}>legacy</button>
      <button onClick={() => setThemeMode('system')}>pick-system</button>
    </>
  );
}

const mode = () => screen.getByTestId('mode').textContent;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(cleanup);

describe('nextThemeMode', () => {
  it('cycles light → dark → system → light', () => {
    expect(nextThemeMode('light')).toBe('dark');
    expect(nextThemeMode('dark')).toBe('system');
    expect(nextThemeMode('system')).toBe('light');
  });

  it('starts unknown or missing values at light', () => {
    expect(nextThemeMode(null)).toBe('light');
    expect(nextThemeMode(undefined)).toBe('light');
    expect(nextThemeMode('sepia')).toBe('light');
  });
});

describe('ThemeProvider quick toggle', () => {
  it('cycles through all three modes and persists each, including system', () => {
    localStorage.setItem('theme', 'light');
    render(<ThemeProvider><Probe /></ThemeProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'cycle' }));
    expect(mode()).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'cycle' }));
    expect(mode()).toBe('system');
    expect(localStorage.getItem('theme')).toBe('system');

    fireEvent.click(screen.getByRole('button', { name: 'cycle' }));
    expect(mode()).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('keeps the legacy toggleDarkMode name on the same cycle', () => {
    localStorage.setItem('theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'legacy' }));
    expect(mode()).toBe('system');
    expect(localStorage.getItem('theme')).toBe('system');
  });

  it('a new user with no stored key stays unset until a deliberate choice', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(mode()).toBe('system');
    expect(localStorage.getItem('theme')).toBeNull();

    // system → light → dark → system: the explicit return to system is written.
    fireEvent.click(screen.getByRole('button', { name: 'cycle' }));
    expect(localStorage.getItem('theme')).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'cycle' }));
    fireEvent.click(screen.getByRole('button', { name: 'cycle' }));
    expect(localStorage.getItem('theme')).toBe('system');
  });

  it('persists an explicit settings pick of system even when the key was unset', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'pick-system' }));
    expect(localStorage.getItem('theme')).toBe('system');
  });

  it('a server-applied system value does not seed an unset key by itself', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => applyServerPreference('theme', 'system'));
    expect(mode()).toBe('system');
    expect(localStorage.getItem('theme')).toBeNull();
  });
});
