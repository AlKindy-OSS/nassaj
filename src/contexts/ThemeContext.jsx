import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  loadThemePresetState,
  saveThemePresetState,
  applyThemePreset,
} from '../lib/theme-presets';
import {
  UI_FONT_STORAGE_KEY,
  applyUiFont,
  loadUiFont,
  saveUiFont,
} from '../lib/ui-font';
import { onApplyServerPreference } from '../preferences/preferencesSync';
// resolveIsDark is the single source of truth — also used by theme-presets.ts
// at boot time (applyStoredThemePreset) to prevent light/dark flash.
import { resolveIsDark, THEME_MODES } from '../lib/theme-mode';

// Re-export so existing consumers of ThemeContext.jsx keep working.
export { THEME_MODES };

/** Apply DOM changes (class + meta tags) for a computed dark/light state. */
function applyDarkClass(isDark) {
  if (isDark) {
    document.documentElement.classList.add('dark');
    const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (statusBarMeta) statusBarMeta.setAttribute('content', 'black-translucent');
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) themeColorMeta.setAttribute('content', '#0c1117');
  } else {
    document.documentElement.classList.remove('dark');
    const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (statusBarMeta) statusBarMeta.setAttribute('content', 'default');
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) themeColorMeta.setAttribute('content', '#ffffff');
  }
}

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }) => {
  // themeMode: 'light' | 'dark' | 'system'
  // Back-compat: existing 'light'/'dark' values in localStorage are preserved as-is.
  // A missing key (new user / first load after upgrade) defaults to 'system'.
  const [themeMode, setThemeMode] = useState(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    // No saved value → default to system (new users and post-upgrade first load).
    // We intentionally do NOT write 'system' to localStorage here so that the
    // preferencesSync layer treats the key as unset (seeding behaviour intact).
    return 'system';
  });

  // Derived boolean — what the DOM actually shows right now.
  const [isDarkMode, setIsDarkMode] = useState(() => resolveIsDark(themeMode));

  // Apply DOM class + persist to localStorage whenever themeMode changes.
  useEffect(() => {
    const resolved = resolveIsDark(themeMode);
    setIsDarkMode(resolved);
    applyDarkClass(resolved);
    // Persist themeMode — but only write 'system' when the user has explicitly
    // chosen it (i.e. the key already exists in localStorage). A new user
    // whose key is null stays null until they make a deliberate selection,
    // so preferencesSync treats the account as having no preference yet
    // (seeding behaviour stays correct).
    if (themeMode !== 'system' || localStorage.getItem('theme') !== null) {
      localStorage.setItem('theme', themeMode);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeMode]);

  // When themeMode is 'system', listen for OS preference changes and update live.
  useEffect(() => {
    if (!window.matchMedia || themeMode !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      const resolved = e.matches;
      setIsDarkMode(resolved);
      applyDarkClass(resolved);
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themeMode]);

  // Legacy helper — still exported so existing callers keep working.
  // Toggles between light and dark (drops 'system' if currently set).
  const toggleDarkMode = () => {
    setThemeMode(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  // Brand-tinted theme presets (see src/lib/theme-presets.ts). The preset is
  // applied on top of light/dark mode and re-derived whenever either changes.
  const [presetState, setPresetState] = useState(loadThemePresetState);

  useEffect(() => {
    applyThemePreset(presetState, isDarkMode);
    saveThemePresetState(presetState);
  }, [presetState, isDarkMode]);

  // Interface font (see src/lib/ui-font.ts). Same ownership model as the theme
  // preset: React state here, DOM + localStorage written from one effect, and
  // boot-time application in main.jsx so nothing flashes before React mounts.
  // Independent of light/dark, hence its own effect.
  const [uiFont, setUiFontState] = useState(loadUiFont);

  useEffect(() => {
    applyUiFont(uiFont);
    saveUiFont(uiFont);
  }, [uiFont]);

  // Reflect account-sourced values live when the sync layer hydrates them
  // after sign-in (server is authoritative — no reload). The localStorage write
  // has already happened; we only refresh React state so the UI updates.
  useEffect(() => {
    const offTheme = onApplyServerPreference('theme', (raw) => {
      // raw may be 'light', 'dark', 'system', or (legacy) null/other
      if (raw === 'light' || raw === 'dark' || raw === 'system') {
        setThemeMode(raw);
      } else if (raw === null) {
        // Server cleared the preference → fall back to system
        setThemeMode('system');
      } else {
        // Unexpected / unrecognised value → fall back to system default
        setThemeMode('system');
      }
    });
    const offPreset = onApplyServerPreference('nassaj-theme-preset', () => {
      setPresetState(loadThemePresetState());
    });
    const offFont = onApplyServerPreference(UI_FONT_STORAGE_KEY, () => {
      setUiFontState(loadUiFont());
    });
    return () => {
      offTheme();
      offPreset();
      offFont();
    };
  }, []);

  const setThemePreset = (preset) => {
    setPresetState(prev => ({ ...prev, preset }));
  };

  const setCustomThemeColors = (patch) => {
    setPresetState(prev => ({ ...prev, custom: { ...prev.custom, ...patch } }));
  };

  const value = {
    isDarkMode,
    themeMode,
    setThemeMode,
    toggleDarkMode,
    themePreset: presetState.preset,
    customThemeColors: presetState.custom,
    setThemePreset,
    setCustomThemeColors,
    uiFont,
    setUiFont: setUiFontState,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};