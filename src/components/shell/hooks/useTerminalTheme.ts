import { useCallback, useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import {
  TERMINAL_THEMES,
  TERMINAL_THEME_STORAGE_KEY,
  findTerminalTheme,
  type TerminalThemeId,
} from '../constants/constants';

function readStoredThemeId(): TerminalThemeId | null {
  try {
    const stored = localStorage.getItem(TERMINAL_THEME_STORAGE_KEY);
    if (stored && findTerminalTheme(stored)) {
      return stored as TerminalThemeId;
    }
  } catch {
    // localStorage unavailable (SSR / private mode)
  }
  return null;
}

function resolveDefaultTheme(isDark: boolean): TerminalThemeId {
  return isDark ? 'vs-dark' : 'light';
}

type UseTerminalThemeResult = {
  themeId: TerminalThemeId;
  setThemeId: (id: TerminalThemeId) => void;
};

/**
 * Manages the active xterm theme as a single source of truth.
 *
 * - On mount, reads from localStorage; falls back to app colour-scheme.
 * - When changed, applies the new theme to the live terminal instance and
 *   calls term.refresh() so existing content repaints immediately.
 * - Persists the selection to localStorage.
 */
export function useTerminalTheme(terminalRef: MutableRefObject<Terminal | null>): UseTerminalThemeResult {
  const [themeId, setThemeIdState] = useState<TerminalThemeId>(() => {
    const stored = readStoredThemeId();
    if (stored) return stored;
    const prefersDark =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    return resolveDefaultTheme(prefersDark);
  });

  // Apply theme to terminal whenever themeId or the terminal instance changes.
  const applyTheme = useCallback(
    (id: TerminalThemeId) => {
      const term = terminalRef.current;
      if (!term) return;
      const entry = findTerminalTheme(id);
      if (!entry) return;
      term.options.theme = entry.theme;
      term.refresh(0, term.rows - 1);
    },
    [terminalRef],
  );

  useEffect(() => {
    applyTheme(themeId);
  }, [applyTheme, themeId]);

  const setThemeId = useCallback(
    (id: TerminalThemeId) => {
      try {
        localStorage.setItem(TERMINAL_THEME_STORAGE_KEY, id);
      } catch {
        // ignore
      }
      setThemeIdState(id);
    },
    [],
  );

  return { themeId, setThemeId };
}

export { TERMINAL_THEMES };
