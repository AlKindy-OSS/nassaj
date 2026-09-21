/**
 * Reads agy's failure line (T-1191).
 *
 * agy announces a non-fatal condition — exhausted quota, expired auth, an
 * unavailable model — on stderr and exits non-zero **without writing anything
 * to its transcript**. That line is therefore the only account of the failure
 * that exists anywhere, which is why B-394 surfaced it to the chat and why this
 * module extracts what is machine-readable inside it.
 *
 * The measured shape, from the live incident on session 06804bb2 (2026-08-02):
 *
 *   Error: Individual quota reached. Please upgrade your subscription to
 *   increase your limits. Resets in 94h52m23s.
 *
 * SCOPE, deliberately narrow: this parses a countdown into an instant. It does
 * NOT model agy's quota — no total, no consumed fraction, no percentage. agy
 * exposes no usage command at all (`agy --help` on 1.1.9 lists agent/agents/
 * changelog/help/install/models/plugin/update — no `usage`, no `quota`), so an
 * exhaustion deadline is the entire truth available, and a progress bar built
 * on top of it would be an invention.
 */

/**
 * `Resets in 94h52m23s` — hours/minutes/seconds, each part optional but at
 * least one required, and always in descending order.
 *
 * Anchored on the literal `Resets in` rather than scanning for any duration in
 * the line: other numbers appear in these messages (plan tiers, limits), and a
 * loose scan would happily read one of those as a deadline. Case-insensitive
 * because only the sentence casing has been observed, not guaranteed.
 */
const RESETS_IN_PATTERN =
  /resets\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i;

/** Upper bound on an accepted countdown: 30 days. */
const MAX_RESET_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Extracts the quota reset instant from an agy failure line.
 *
 * @param line   the stderr line as agy wrote it
 * @param nowMs  the instant the failure was observed (injected, not read from
 *               the clock, so the caller stamps once and the value is testable)
 * @returns epoch ms of the reset, or null when the line carries no countdown
 *
 * Returns null — never a fabricated instant — when the line has no `Resets in`
 * clause, when every capture group is absent, or when the resulting duration is
 * zero or absurd. A missing deadline renders as nothing; a wrong one would
 * render as a confident countdown to a moment that means nothing, and the UI
 * cannot tell the two apart once it has a number.
 */
export function parseQuotaResetMs(line: string, nowMs: number): number | null {
  if (!line || typeof line !== 'string') return null;
  if (!Number.isFinite(nowMs)) return null;

  const match = RESETS_IN_PATTERN.exec(line);
  if (!match) return null;

  const [, hours, minutes, seconds] = match;
  // `resets in` followed by nothing parseable: the regex still matches (every
  // group is optional), so reject it here rather than returning `now`.
  if (hours === undefined && minutes === undefined && seconds === undefined) return null;

  const durationMs =
    (Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000;

  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_RESET_MS) return null;

  return nowMs + durationMs;
}

/**
 * True when the failure line reports an exhausted quota rather than any other
 * cause. Used to decide whether the conversation-level failure also becomes a
 * provider-level block, so an expired token never masquerades as a spent quota.
 */
export function isQuotaFailure(line: string): boolean {
  if (!line || typeof line !== 'string') return false;
  return /quota\s+reached|quota\s+exceeded|out\s+of\s+quota/i.test(line);
}

/** Map agy stderr or its exit status to a chat error code. */
export function classifyAgyFailure(line?: string | null, exitCode?: number | null): string {
  if (exitCode === 127) return 'cli_not_installed';

  if (typeof line === 'string' && line) {
    if (isQuotaFailure(line)) return 'usage_limit';
    if (/invalid model|not recognized as a known model|model .* not found/i.test(line)) {
      return 'model_not_supported';
    }
    if (/authentication|unauthorized|not authenticated|login required|oauth token|credentials/i.test(line)) {
      return 'authentication_required';
    }
    if (/command not found|no such file or directory.*agy/i.test(line)) {
      return 'cli_not_installed';
    }
  }

  return 'spawn_failed';
}
