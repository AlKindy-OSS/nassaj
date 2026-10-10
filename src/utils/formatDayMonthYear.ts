/**
 * Formats an ISO timestamp as `DD/MM/YYYY HH:mm` (24h, Latin digits, no seconds,
 * local time zone). Independent of the browser locale, so an Arabic UI never
 * falls back to the US month-first order.
 *
 * @param value ISO string (or anything `Date` accepts).
 * @returns the formatted text, or `null` when the value is empty or unparseable
 *          so callers can hide the field rather than print "Invalid Date".
 */
export function formatDayMonthYear(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
