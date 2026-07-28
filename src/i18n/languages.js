/**
 * Supported Languages Configuration
 *
 * This file contains the list of supported languages for the application.
 * Each language includes:
 * - value: Language code (e.g., 'en', 'zh-CN')
 * - label: Display name in English
 * - nativeName: Native language name for display
 * - dir: (optional) preferred text direction hint for this language ('ltr' | 'rtl').
 *        Note: actual UI direction is controlled automatically by RtlContext based
 *        on the selected language — Arabic selects RTL, English selects LTR.
 */

// Languages exposed in the UI picker. Restricted to Arabic + English by owner
// decision (other locales caused UX issues). The other translation bundles stay
// on disk and remain wired in i18n/config.js — they are simply not selectable.
// Re-add an entry here to re-enable a language (fully reversible, no file moves).
export const languages = [
  {
    value: 'en',
    label: 'English',
    nativeName: 'English',
    dir: 'ltr',
  },
  {
    value: 'ar',
    label: 'Arabic',
    nativeName: 'العربية',
    dir: 'rtl',
  },
];

/**
 * Fallback UI language for users whose stored preference is no longer
 * selectable (e.g. a previously chosen de/it/ko/ru/zh-CN/tr/ja). The app is
 * Arabic-first, so such users land on Arabic rather than English.
 */
export const FALLBACK_UI_LANGUAGE = 'ar';

/**
 * Get language object by value
 * @param {string} value - Language code
 * @returns {Object|undefined} Language object or undefined if not found
 */
export const getLanguage = (value) => {
  return languages.find(lang => lang.value === value);
};

/**
 * Get all language values
 * @returns {string[]} Array of language codes
 */
export const getLanguageValues = () => {
  return languages.map(lang => lang.value);
};

/**
 * Check if a language is supported
 * @param {string} value - Language code to check
 * @returns {boolean} True if language is supported
 */
export const isLanguageSupported = (value) => {
  return languages.some(lang => lang.value === value);
};
