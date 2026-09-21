/**
 * Client side of the read-only update pre-flight (ADR-156 أ.5, WI-7).
 *
 * GET /api/system/update/preflight diagnoses the failures that are predictable
 * BEFORE any write and reports the first one as a single bilingual cause with a
 * single action. The update modal consults it before every POST to
 * /api/system/update/jobs, so a blocker is shown to the owner instead of being
 * discovered half-way through a job.
 */

export const UPDATE_PREFLIGHT_PATH = '/api/system/update/preflight';

export interface PreflightBlocker {
  code: string;
  reasonAr: string | null;
  reasonEn: string | null;
  actionAr: string | null;
  actionEn: string | null;
  /** A governed operator command, shown verbatim; never executed by the UI. */
  command: string | null;
}

export type PreflightErrorReason = 'authorization' | 'unavailable' | 'connection';

export type PreflightState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'clear' }
  | { status: 'blocked'; blocker: PreflightBlocker }
  | { status: 'rate_limited'; retryAfterSeconds: number | null }
  | { status: 'error'; reason: PreflightErrorReason; code: string | null };

/** Outcomes of one completed request (never `idle` or `checking`). */
export type PreflightOutcome = Exclude<PreflightState, { status: 'idle' } | { status: 'checking' }>;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

function parseBlocker(raw: unknown): PreflightBlocker | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const action = source.action && typeof source.action === 'object'
    ? source.action as Record<string, unknown>
    : {};
  return {
    code: text(source.code) ?? 'unknown',
    reasonAr: text(source.ar),
    reasonEn: text(source.en),
    actionAr: text(action.ar),
    actionEn: text(action.en),
    command: text(action.command),
  };
}

function parseRetryAfter(value: string | null): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * Map one pre-flight HTTP response to a UI state. Fail-closed: only an explicit
 * `ok: true` body with no blocker is `clear`; a 200 that is malformed, or
 * `ok: false` without a readable blocker, is reported as unavailable so the
 * Start button never opens on evidence the client could not read.
 */
export function interpretPreflightResponse(
  status: number,
  body: Record<string, unknown>,
  retryAfterHeader: string | null = null,
): PreflightOutcome {
  if (status === 429) return { status: 'rate_limited', retryAfterSeconds: parseRetryAfter(retryAfterHeader) };
  if (status === 401 || status === 403) return { status: 'error', reason: 'authorization', code: null };
  if (status < 200 || status >= 300) {
    return { status: 'error', reason: 'unavailable', code: text(body.code) };
  }
  if (body.ok === true && !body.blocker) return { status: 'clear' };
  const blocker = body.ok === false ? parseBlocker(body.blocker) : null;
  return blocker
    ? { status: 'blocked', blocker }
    : { status: 'error', reason: 'unavailable', code: null };
}

/** Pick the server's cause/action text for the active UI language (Arabic or English). */
export function localizeBlocker(blocker: PreflightBlocker, language: string | undefined) {
  const arabic = typeof language === 'string' && language.toLowerCase().startsWith('ar');
  return {
    reason: arabic ? blocker.reasonAr ?? blocker.reasonEn : blocker.reasonEn ?? blocker.reasonAr,
    action: arabic ? blocker.actionAr ?? blocker.actionEn : blocker.actionEn ?? blocker.actionAr,
  };
}
