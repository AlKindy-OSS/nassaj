/**
 * A compact, stable representation for elapsed work throughout the product.
 *
 * Calendar months do not have a fixed length, so an elapsed duration uses the
 * conventional fixed units of 365 days/year and 30 days/month.  This is a
 * duration formatter, not a date-range formatter.
 */
export type WorkDurationLocale = 'ar' | 'en';

export const WORK_DURATION_DASH = '—';

export function formatWorkDuration(value: unknown, locale: WorkDurationLocale = 'en'): string {
  const milliseconds = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return WORK_DURATION_DASH;

  const totalMilliseconds = Math.round(milliseconds);
  const units = locale === 'ar'
    ? { millisecond: 'ملث', second: 'ث', minute: 'د', hour: 'س', day: 'ي', month: 'شهر', year: 'سنة' }
    : { millisecond: 'ms', second: 's', minute: 'm', hour: 'h', day: 'd', month: 'mo', year: 'y' };
  if (totalMilliseconds < 1_000) return `${totalMilliseconds}${units.millisecond}`;

  // Keep one decimal second without rounding into a unit the work did not
  // reach.  Seconds are always retained once the duration reaches one second:
  // `1m 0.0s`, not an ambiguous bare `1m`.
  const totalTenths = Math.floor(totalMilliseconds / 100);
  let remainingSeconds = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const years = Math.floor(remainingSeconds / (365 * 86_400));
  remainingSeconds %= 365 * 86_400;
  const months = Math.floor(remainingSeconds / (30 * 86_400));
  remainingSeconds %= 30 * 86_400;
  const days = Math.floor(remainingSeconds / 86_400);
  remainingSeconds %= 86_400;
  const hours = Math.floor(remainingSeconds / 3_600);
  remainingSeconds %= 3_600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  const parts: string[] = [];
  if (years) parts.push(`${years}${units.year}`);
  if (months) parts.push(`${months}${units.month}`);
  if (days) parts.push(`${days}${units.day}`);
  if (hours) parts.push(`${hours}${units.hour}`);
  if (minutes) parts.push(`${minutes}${units.minute}`);
  parts.push(`${seconds}.${tenths}${units.second}`);
  return parts.join(' ');
}
