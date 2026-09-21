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

// Languages exposed in the UI picker. Every locale with a bundle on disk and a
// `resources` entry in i18n/config.js is listed here (owner call 2026-08-01,
// reversing the earlier ar+en-only restriction). The list order is the picker
// order: the two first-class locales first, then the rest alphabetically.
//
// Coverage is honest, not uniform: `ar` and `en` are fully translated; the
// other seven translate common/settings/auth/sidebar/chat/codeEditor/presence/
// projectBoard/terminals and fall back to English for anything missing (i18next
// `fallbackLng`), which is the repo convention rather than an oversight.
//
// (This paragraph used to say ar/en were "the only two carrying the `presence`
// namespace". That was never true of the DISK — all twelve locales ship a
// translated presence.json — only of `resources` in config.js, where seven were
// left unregistered. B-523 registered them; the claim is corrected here so the
// comment stops certifying the bug as a design choice.)
//
// `fa`, `id` and `ur` (added 2026-08-01) translate common/auth/sidebar — the
// chrome a user meets before anything else — and fall back to English for the
// remaining namespaces. Listing them with partial coverage is deliberate: the
// fallback is per KEY, so a half-translated locale is a usable locale, whereas
// withholding it until every namespace is done ships nothing. `fa` and `ur` are
// RTL, which the `dir` field below is enough to deliver — RtlContext reads it
// and the stylesheet keys off `:root[dir="rtl"]`, not off `lang="ar"`.
//
// Removing an entry disables that language everywhere (picker + RtlContext +
// getSavedLanguage), and a stored preference for a removed locale lands on
// FALLBACK_UI_LANGUAGE. No file moves either way.
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
  {
    value: 'de',
    label: 'German',
    nativeName: 'Deutsch',
    dir: 'ltr',
  },
  {
    value: 'fa',
    label: 'Persian',
    nativeName: 'فارسی',
    dir: 'rtl',
  },
  {
    value: 'id',
    label: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    dir: 'ltr',
  },
  {
    value: 'it',
    label: 'Italian',
    nativeName: 'Italiano',
    dir: 'ltr',
  },
  {
    value: 'ja',
    label: 'Japanese',
    nativeName: '日本語',
    dir: 'ltr',
  },
  {
    value: 'ko',
    label: 'Korean',
    nativeName: '한국어',
    dir: 'ltr',
  },
  {
    value: 'ru',
    label: 'Russian',
    nativeName: 'Русский',
    dir: 'ltr',
  },
  {
    value: 'tr',
    label: 'Turkish',
    nativeName: 'Türkçe',
    dir: 'ltr',
  },
  {
    value: 'ur',
    label: 'Urdu',
    nativeName: 'اردو',
    dir: 'rtl',
  },
  {
    value: 'zh-CN',
    label: 'Chinese (Simplified)',
    nativeName: '简体中文',
    dir: 'ltr',
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
