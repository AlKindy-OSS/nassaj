/** T-2095 helpers for the "Turn changes" tab. */

const BINARY_DIFF = /^Binary files .* differ$/m;

const KNOWN_REASONS = new Set([
  'too_large', 'secret_content', 'secret_container', 'denied_path',
  'budget', 'hardlink', 'special', 'protected_content',
]);

/** True when git reported the file as binary instead of a text diff. */
export function isBinaryDiff(diff: string): boolean {
  return BINARY_DIFF.test(diff);
}

/** i18n key suffix of a withheld reason; unknown codes fall back to the generic label. */
export function withheldReasonKey(reason: string | undefined): string | null {
  return reason && KNOWN_REASONS.has(reason) ? reason : null;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600], ['month', 30 * 24 * 3600], ['week', 7 * 24 * 3600],
  ['day', 24 * 3600], ['hour', 3600], ['minute', 60], ['second', 1],
];

/** Localized relative time of an ISO instant ("5 minutes ago"), or '' when unreadable. */
export function formatRelativeTime(iso: string | null, language: string, now = Date.now()): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const seconds = Math.round((time - now) / 1000);
  const [unit, size] = UNITS.find(([, length]) => Math.abs(seconds) >= length) ?? ['second', 1];
  try {
    return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(Math.round(seconds / size), unit);
  } catch {
    return new Date(time).toISOString();
  }
}
