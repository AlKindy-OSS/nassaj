import type { TFunction } from 'i18next';

import { parseSessionTimestamp } from './utils';

/**
 * Compact, localized relative age for sidebar rows ("5m"/"٥ د", "3h", "2d").
 *
 * One formatter for the active and the archived rows, so the two lists read
 * the same (B-1668). Absent or unparseable input yields an empty string.
 */
export function formatCompactAge(dateString: string | null | undefined, now: number, t: TFunction): string {
  const time = parseSessionTimestamp(dateString);
  if (!time) return '';

  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return t('sessions.age.now', { defaultValue: 'now' });
  if (minutes < 60) return t('sessions.age.minutes', { count: minutes, defaultValue: '{{count}}m' });

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('sessions.age.hours', { count: hours, defaultValue: '{{count}}h' });

  return t('sessions.age.days', { count: Math.floor(hours / 24), defaultValue: '{{count}}d' });
}

/** Full local date and time of a row, for the accessible label next to the age. */
export function formatAbsoluteSessionTime(dateString: string | null | undefined, locale: string): string {
  const time = parseSessionTimestamp(dateString);
  if (!time) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time);
}
