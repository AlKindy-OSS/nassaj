/**
 * theme-mode.ts — shared theme-mode resolution logic.
 *
 * Single source of truth for mapping a stored theme mode value
 * ('light' | 'dark' | 'system' | null/unknown) to a boolean isDark flag.
 *
 * Consumed by:
 *  - ThemeContext.jsx (React runtime)
 *  - theme-presets.ts → applyStoredThemePreset() (pre-React boot)
 *
 * Keeping this in one place prevents the two call-sites from diverging
 * (which previously caused a visible flash when 'system' was stored).
 */

/** All valid values that may be written to localStorage under key 'theme'. */
export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/**
 * Resolve whether dark mode is active for a given theme mode string.
 *
 * - 'dark'   → true
 * - 'light'  → false
 * - 'system' → follow window.matchMedia('(prefers-color-scheme: dark)')
 * - null / unknown value → treat as 'system' (safe default for new users
 *   and for any value written by a future version we haven't seen yet)
 */
export function resolveIsDark(mode: string | null | undefined): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  // 'system', null, or any unrecognised value → defer to OS preference
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}
