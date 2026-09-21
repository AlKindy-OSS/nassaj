import { createContext, useContext, useEffect, useState } from 'react';
import i18n from '../i18n/config.js';
import { getLanguage } from '../i18n/languages.js';

const RtlContext = createContext(null);

/**
 * useRtl
 *
 * Returns the application-wide RTL layout state derived automatically from the
 * active i18n language. Arabic (and any future RTL language tagged with
 * `dir: 'rtl'` in languages.js) yields `rtlLayout: true`; all other languages
 * yield `false`.
 *
 * The manual toggle has been removed (2026-06-16). Direction is no longer a
 * separate user preference — it follows the language selection so the two
 * settings can never diverge. AuthScreenLayout already applies its own language-
 * aware direction logic and is unaffected.
 *
 * Returns `{ rtlLayout: boolean }`.
 */
export const useRtl = () => {
  const ctx = useContext(RtlContext);
  if (!ctx) {
    throw new Error('useRtl must be used within an RtlProvider');
  }
  return ctx;
};

const isRtlLanguage = (lng) => {
  if (!lng) return false;
  const langCode = lng.split('-')[0];
  const entry = getLanguage(lng) ?? getLanguage(langCode);
  return entry?.dir === 'rtl';
};

export const RtlProvider = ({ children }) => {
  const [activeLang, setActiveLang] = useState(() => i18n.language || 'en');
  const rtlLayout = isRtlLanguage(activeLang);

  // Keep direction in sync when the user changes the language.
  useEffect(() => {
    const handler = (lng) => {
      setActiveLang(lng || 'en');
    };
    i18n.on('languageChanged', handler);
    return () => {
      i18n.off('languageChanged', handler);
    };
  }, []);

  // Apply direction at the document root so CSS selectors such as
  // `:root[dir="rtl"]` in index.css activate the correct typography and layout
  // corrections. The lang attribute is derived from the active i18n language so
  // browsers pick the right font fallback chains and a11y tools announce content
  // in the correct language regardless of direction.
  useEffect(() => {
    document.documentElement.dir = rtlLayout ? 'rtl' : 'ltr';
    // Strip region code for the root lang: 'zh-CN' → 'zh', 'ar' → 'ar'.
    document.documentElement.lang = activeLang.split('-')[0];
  }, [rtlLayout, activeLang]);

  return (
    <RtlContext.Provider value={{ rtlLayout }}>
      {children}
    </RtlContext.Provider>
  );
};
