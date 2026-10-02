/**
 * Non-component helpers of the SSO tab: shared input classes and small hooks.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../../lib/utils';

import { ssoMessageFor } from './ssoMessages';

/** Input style of FieldWithAction, for fields that save with a step-level button. */
export const INPUT_CLASS = cn(
  'w-full min-w-0 rounded-md border border-input bg-background px-3 py-1.5',
  'text-sm text-foreground placeholder:text-muted-foreground',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  'disabled:cursor-not-allowed disabled:opacity-60',
);
export const TECH_INPUT_CLASS = cn(INPUT_CLASS, 'font-mono text-[13px]');
export const LABEL_CLASS = 'block text-[13px] font-medium text-foreground';
export const HINT_CLASS = 'text-[13px] leading-relaxed text-muted-foreground';

/** Plain-language sentence for a server code; unknown codes show the raw code beside the generic text. */
export function useSsoMessage() {
  const { t } = useTranslation('settings');
  return (code: string, details?: Record<string, unknown>) => {
    const message = ssoMessageFor(code, details);
    return { text: t(message.key, message.params), known: message.known };
  };
}

/** Shows "Contacting your identity provider…" once a request has run for 2 s (brief §11). */
export function useSlowFlag(active: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) { setSlow(false); return undefined; }
    const timer = setTimeout(() => setSlow(true), 2000);
    return () => clearTimeout(timer);
  }, [active]);
  return slow;
}

/** Relative "12 minutes ago" in the UI language. */
export function useRelativeTime() {
  const { i18n } = useTranslation('settings');
  return (value: number | string | null | undefined): string => {
    const ms = typeof value === 'number' ? value : value ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms)) return '';
    const minutes = Math.round((ms - Date.now()) / 60_000);
    const format = new Intl.RelativeTimeFormat([`${i18n.language}-u-nu-latn`, 'en'], { numeric: 'auto' });
    if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 48) return format.format(hours, 'hour');
    return format.format(Math.round(hours / 24), 'day');
  };
}
