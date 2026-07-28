/**
 * Pure timestamp-parsing helpers for the database module.
 *
 * WHY THIS LIVES OUTSIDE `repositories/sessions.db.ts`
 * `parseStoredTimestampMs` is a pure function with no connection, no query and
 * no repository state, but it used to be defined in the sessions repository and
 * re-exported from the module barrel. Every test that mocks the sessions
 * repository (`mock.module('.../sessions.db.js', { namedExports: { sessionsDb } })`)
 * therefore also erased this unrelated function, and the barrel died at
 * instantiation with
 *   SyntaxError: ... does not provide an export named 'parseStoredTimestampMs'
 * Keeping the pure helper in its own module means repository mocks can no longer
 * take it down with them.
 */

/**
 * `YYYY-MM-DD HH:MM[:SS[.fff]]` with NO timezone designator — the shape SQLite's
 * CURRENT_TIMESTAMP / datetime() produce. Anchored and with no allowance for a
 * trailing `Z` or `±HH:MM`, so a genuine ISO-8601 string never matches.
 */
const NAIVE_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;

/**
 * Parses a stored timestamp to epoch milliseconds, reading a timezone-less value
 * as UTC.
 *
 * `sessions.created_at` holds two formats: ISO-8601 UTC written by the sessions
 * repository (`toISOString()`), and the `2026-06-27 09:34:00` form written by
 * SQLite's `DEFAULT CURRENT_TIMESTAMP` / `CURRENT_TIMESTAMP` — which is UTC but
 * carries no designator to say so. `new Date('2026-06-27 09:34:00')` interprets
 * that as LOCAL time, so on this server (Asia/Riyadh, UTC+3) every such value is
 * read three hours EARLIER than it happened, and any comparison mixing the two
 * formats orders rows wrongly. SQL-side ordering was never affected — SQLite's
 * `datetime()` reads both forms as UTC — only JavaScript-side comparisons were.
 *
 * Returns null for empty/unparseable input so callers can apply their own
 * fallback rather than silently sorting on NaN or epoch 0.
 */
export function parseStoredTimestampMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const naive = NAIVE_DATETIME_PATTERN.exec(trimmed);
  if (naive) {
    const [, year, month, day, hours, minutes, seconds, fraction] = naive;
    const milliseconds = fraction ? Math.round(Number(fraction) * 1000) : 0;
    const epoch = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hours),
      Number(minutes),
      seconds ? Number(seconds) : 0,
      milliseconds
    );
    return Number.isNaN(epoch) ? null : epoch;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}
