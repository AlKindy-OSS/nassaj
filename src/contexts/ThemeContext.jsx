import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  loadThemePresetState,
  saveThemePresetState,
  applyThemePreset,
} from '../lib/theme-presets';
import {
  UI_FONT_STORAGE_KEY,
  applyUiFont,
  fontForLanguage,
  loadUiFont,
  saveUiFont,
} from '../lib/ui-font';
import { onApplyServerPreference } from '../preferences/preferencesSync';
// resolveIsDark is the single source of truth — also used by theme-presets.ts
// at boot time (applyStoredThemePreset) to prevent light/dark flash.
import { nextThemeMode, resolveIsDark, THEME_MODES } from '../lib/theme-mode';

// Re-export so existing consumers of ThemeContext.jsx keep working.
export { THEME_MODES };

/** Apply dark/light DOM state not owned by the preset token engine. */
function applyDarkClass(isDark) {
  if (isDark) {
    document.documentElement.classList.add('dark');
    const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (statusBarMeta) statusBarMeta.setAttribute('content', 'black-translucent');
  } else {
    document.documentElement.classList.remove('dark');
    const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (statusBarMeta) statusBarMeta.setAttribute('content', 'default');
  }
}

/** Commit every visible part of a resolved theme in one effect/callback. */
function applyResolvedTheme(isDark, presetState) {
  applyDarkClass(isDark);
  applyThemePreset(presetState, isDark);
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
  // Only for the language→font rule below; no string is translated here.
  const { i18n } = useTranslation();

  // themeMode: 'light' | 'dark' | 'system'
  // Back-compat: existing 'light'/'dark' values in localStorage are preserved as-is.
  // A missing key (new user / first load after upgrade) defaults to 'system'.
  const [themeMode, setThemeModeState] = useState(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    // No saved value → default to system (new users and post-upgrade first load).
    // We intentionally do NOT write 'system' to localStorage here so that the
    // preferencesSync layer treats the key as unset (seeding behaviour intact).
    return 'system';
  });

  // Set once the user deliberately picks a mode (settings control or quick
  // toggle), so an explicit 'system' is persisted — and therefore synced to the
  // account — even when the key was never written before.
  const explicitChoiceRef = useRef(false);

  // Derived boolean — what the DOM actually shows right now.
  const [isDarkMode, setIsDarkMode] = useState(() => resolveIsDark(themeMode));

  // Brand-tinted theme presets (see src/lib/theme-presets.ts).
  const [presetState, setPresetState] = useState(loadThemePresetState);

  // Apply class, preset tokens, and browser chrome together. Keeping these in
  // one effect prevents a paint where `.dark` belongs to the new mode while
  // inline preset tokens / theme-color still belong to the old one.
  useEffect(() => {
    const resolved = resolveIsDark(themeMode);
    applyResolvedTheme(resolved, presetState);
    setIsDarkMode(resolved);
    saveThemePresetState(presetState);
    // Persist themeMode — but only write 'system' when the user has explicitly
    // chosen it (this session, or earlier so the key already exists). A new
    // user whose key is null stays null until they make a deliberate
    // selection, so preferencesSync treats the account as having no
    // preference yet (seeding behaviour stays correct).
    if (
      themeMode !== 'system'
      || explicitChoiceRef.current
      || localStorage.getItem('theme') !== null
    ) {
      localStorage.setItem('theme', themeMode);
    }
  }, [themeMode, presetState]);

  // When themeMode is 'system', listen for OS preference changes and update live.
  useEffect(() => {
    if (!window.matchMedia || themeMode !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      const resolved = e.matches;
      applyResolvedTheme(resolved, presetState);
      setIsDarkMode(resolved);
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themeMode, presetState]);

  /**
   * User-facing setter: marks the choice explicit so 'system' persists. Picking
   * the mode already shown (e.g. 'system' for a new user) changes no state and
   * so runs no effect — write it here so that deliberate choice still syncs.
   */
  const setThemeMode = (mode) => {
    explicitChoiceRef.current = true;
    if (THEME_MODES.includes(mode)) localStorage.setItem('theme', mode);
    setThemeModeState(mode);
  };

  /** Quick toggle: cycles light → dark → system → light (keeps 'system' reachable). */
  const cycleThemeMode = () => {
    explicitChoiceRef.current = true;
    setThemeModeState(nextThemeMode);
  };

  // Interface font (see src/lib/ui-font.ts). Same ownership model as the theme
  // preset: React state here, DOM + localStorage written from one effect, and
  // boot-time application in main.jsx so nothing flashes before React mounts.
  // Independent of light/dark, hence its own effect.
  const [uiFont, setUiFontState] = useState(loadUiFont);

  useEffect(() => {
    applyUiFont(uiFont);
    saveUiFont(uiFont);
  }, [uiFont]);

  // T-1174 — a language whose script is essential (Urdu → nastaliq) carries its
  // face with it. Subscribed to i18next rather than wired into the picker, so
  // EVERY route into the language reaches it: the settings picker, the quick
  // panel, and the server-hydrated preference after sign-in. Run once on mount
  // too, for the reader whose stored language is already Urdu at boot.
  useEffect(() => {
    // Taken from the hook rather than imported from '../i18n/config': importing
    // the instance drags i18next's whole init into every test that renders a
    // ThemeProvider behind a mocked react-i18next, and those mocks do not carry
    // `initReactI18next`. The guard covers the same mocks, whose fake instance
    // has no event emitter — a missing font switch must never break a render.
    if (typeof i18n?.on !== 'function') return undefined;
    const onLanguageChanged = (language) => {
      const next = fontForLanguage(language, loadUiFont());
      if (next) setUiFontState(next);
    };
    i18n.on('languageChanged', onLanguageChanged);
    onLanguageChanged(i18n.language);
    return () => i18n.off('languageChanged', onLanguageChanged);
  }, [i18n]);

  // Reflect account-sourced values live when the sync layer hydrates them
  // after sign-in (server is authoritative — no reload). The localStorage write
  // has already happened; we only refresh React state so the UI updates.
  useEffect(() => {
    const offTheme = onApplyServerPreference('theme', (raw) => {
      // raw may be 'light', 'dark', 'system', or (legacy) null/other
      if (raw === 'light' || raw === 'dark' || raw === 'system') {
        setThemeModeState(raw);
      } else if (raw === null) {
        // Server cleared the preference → fall back to system
        setThemeModeState('system');
      } else {
        // Unexpected / unrecognised value → fall back to system default
        setThemeModeState('system');
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
    cycleThemeMode,
    // Legacy name kept for existing callers; it now cycles all three modes.
    toggleDarkMode: cycleThemeMode,
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
