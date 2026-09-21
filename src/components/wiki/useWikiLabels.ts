/**
 * Arabic labels for the Arabic-only Nassaj wiki.
 *
 * The application language intentionally does not participate here. Mixing an
 * English shell with Arabic page titles and prose made every article switch
 * direction mid-line and added a permanent translation disclaimer. Until the
 * wiki has translated content, its shell and content form one Arabic surface.
 */

import { useCallback } from 'react';

import ar from '../../i18n/locales/ar/wiki.json';

export type WikiLabelBundle = typeof ar;

type Section = keyof WikiLabelBundle;
type WikiLabelKey = {
  [S in Section]: `${S & string}.${keyof WikiLabelBundle[S] & string}`;
}[Section];

export type WikiLabels = {
  language: 'ar';
  isTranslated: false;
  langAttr: undefined;
  labelDir: 'rtl';
  t: (key: WikiLabelKey, vars?: Record<string, string>) => string;
};

function lookup(key: string): string {
  const [section, leaf] = key.split('.');
  return (ar as Record<string, Record<string, string>>)[section]?.[leaf] ?? key;
}

export function useWikiLabels(): WikiLabels {
  const t = useCallback((key: WikiLabelKey, vars?: Record<string, string>) => {
    const raw = lookup(key);
    if (!vars) return raw;
    return raw.replace(/\{\{(\w+)\}\}/g, (match, name: string) => vars[name] ?? match);
  }, []);

  return {
    language: 'ar',
    isTranslated: false,
    langAttr: undefined,
    labelDir: 'rtl',
    t,
  };
}
