/**
 * T-2113: surfaces SDK stream messages the chat used to drop (SDK 0.3.317–0.3.325,
 * shapes read from sdk.d.ts and the bundled CLI 2.1.325):
 *
 * - `tool_progress` with a `tool_use_id` starting `hook-` is the periodic heartbeat
 *   of a turn waiting on hooks (`tool_name` is the hook event). It becomes ONE
 *   `status` line; repeats are collapsed until model output resumes, which moves the
 *   line back to "Working".
 * - `system/informational` tagged `hook_no_verdict` (a PreToolUse hook gave no
 *   verdict and did not refuse the call; carries `hook_no_verdict.timed_out`) and
 *   tagged `hook_callback_failed` become warning notices. A callback failure's text
 *   comes from nassaj's own server-side hooks and may name server paths, so viewers
 *   and the replay buffer get a generic line and the run owner alone gets the
 *   detail (`noticeDetailOf` links it to the shared line).
 * - `system/session_writes_lost` (`error_code`, `lost`) becomes an error notice.
 * - `credential_expires_at` on a result becomes an owner-only warning when the
 *   sign-in ends within {@link CREDENTIAL_WARNING_WINDOW_MS}. The date is never logged.
 *
 * Everything here is live-only: none of these messages is a transcript row.
 */
import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

const PROVIDER = 'claude';

/** Status text while hooks run; the client maps it to `claudeStatus.actions.runningChecks`. */
export const HOOK_RUNNING_STATUS_TEXT = 'Running checks';
/** Status text once model output resumes after a hook heartbeat. */
export const HOOK_DONE_STATUS_TEXT = 'Working';

export const HOOK_NO_VERDICT_NOTICE_CODE = 'hook_no_verdict';
export const HOOK_FAILED_NOTICE_CODE = 'hook_failed';
export const SESSION_WRITES_LOST_NOTICE_CODE = 'session_writes_lost';
export const CREDENTIAL_EXPIRING_NOTICE_CODE = 'credential_expiring';

/** A sign-in ending within this window (or already past) is announced. */
export const CREDENTIAL_WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

const HOOK_HEARTBEAT_PREFIX = 'hook-';
const MODEL_OUTPUT_TYPES: ReadonlySet<string> = new Set(['assistant', 'user', 'stream_event']);
const KNOWN_LOST_WRITES: ReadonlySet<string> = new Set(['transcript', 'global_config']);

/** Frames for every viewer (`broadcast`) and for the run owner's socket only (`ownerOnly`). */
export type StreamNoticeFrames = {
  broadcast: NormalizedMessage[];
  ownerOnly: NormalizedMessage[];
};

type Raw = Record<string, unknown>;

const NONE = (): StreamNoticeFrames => ({ broadcast: [], ownerOnly: [] });
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function statusFrame(text: string, sessionId: string | null): NormalizedMessage {
  return createNormalizedMessage({ kind: 'status', text, canInterrupt: true, sessionId, provider: PROVIDER });
}

function noticeFrame(raw: Raw, sessionId: string | null, fields: Raw): NormalizedMessage {
  return createNormalizedMessage({
    ...(str(raw.uuid) ? { id: str(raw.uuid) } : {}),
    kind: 'notice', sessionId, provider: PROVIDER, ...fields,
  });
}

/** Shared (viewers + replay) text of a hook callback failure; the detail is owner-only. */
export const HOOK_FAILED_SHARED_TEXT = 'A hook failed, so its answer was treated as empty.';

/** A callback failure: a generic shared line plus the raw detail for the run owner. */
function hookFailure(raw: Raw, sessionId: string | null, out: StreamNoticeFrames): void {
  const shared = noticeFrame(raw, sessionId, {
    noticeCode: HOOK_FAILED_NOTICE_CODE, noticeLevel: 'warning', content: HOOK_FAILED_SHARED_TEXT,
  });
  out.broadcast.push(shared);
  const detail = str(raw.content);
  if (!detail) return;
  out.ownerOnly.push(createNormalizedMessage({
    id: `${shared.id}:detail`, kind: 'notice', sessionId, provider: PROVIDER,
    noticeCode: HOOK_FAILED_NOTICE_CODE, noticeLevel: 'warning', noticeDetailOf: shared.id,
    content: detail,
  }));
}

/** Adds the frames of a tagged hook warning; any other informational line adds none. */
function hookWarning(raw: Raw, sessionId: string | null, out: StreamNoticeFrames): void {
  if (raw.tag === 'hook_no_verdict') {
    const detail = (raw.hook_no_verdict ?? {}) as Raw;
    out.broadcast.push(noticeFrame(raw, sessionId, {
      noticeCode: HOOK_NO_VERDICT_NOTICE_CODE, noticeLevel: 'warning',
      noticeReason: detail.timed_out === true ? 'timed_out' : 'no_answer',
      content: str(raw.content) || 'A hook gave no verdict, so it did not check this action.',
    }));
  } else if (raw.tag === 'hook_callback_failed') {
    hookFailure(raw, sessionId, out);
  }
}

function writesLost(raw: Raw, sessionId: string | null): NormalizedMessage {
  const lost = Array.isArray(raw.lost) ? raw.lost.filter(v => KNOWN_LOST_WRITES.has(v as string)) : [];
  const reason = str(raw.error_code) || 'unknown';
  return noticeFrame(raw, sessionId, {
    noticeCode: SESSION_WRITES_LOST_NOTICE_CODE, noticeLevel: 'error', noticeReason: reason,
    lostWrites: lost,
    content: `Part of this session could not be saved to disk (${reason}).`,
  });
}

/** Owner-only warning when `credential_expires_at` falls inside the window; else null. */
function credentialWarning(raw: Raw, sessionId: string | null, now: number): NormalizedMessage | null {
  const expiresAt = str(raw.credential_expires_at);
  const endsAt = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(endsAt) || endsAt - now > CREDENTIAL_WARNING_WINDOW_MS) return null;
  return createNormalizedMessage({
    kind: 'notice', sessionId, provider: PROVIDER,
    noticeCode: CREDENTIAL_EXPIRING_NOTICE_CODE, noticeLevel: 'warning',
    noticeReason: endsAt <= now ? 'expired' : 'soon',
    credentialExpiresAt: expiresAt,
    content: 'Your Claude sign-in ends soon. Re-link your Claude account in Settings.',
  });
}

/**
 * Creates the per-run tracker. `observe` is called with every raw SDK message and
 * returns the extra frames to send; it never alters the normal adapter output.
 */
export function createClaudeStreamNotices({ now = Date.now }: { now?: () => number } = {}) {
  let hooksRunning = false;
  let credentialWarned = false;

  function observe(message: unknown, sessionId: string | null): StreamNoticeFrames {
    const out = NONE();
    if (!message || typeof message !== 'object') return out;
    const raw = message as Raw;

    if (raw.type === 'tool_progress' && str(raw.tool_use_id).startsWith(HOOK_HEARTBEAT_PREFIX)) {
      if (!hooksRunning) out.broadcast.push(statusFrame(HOOK_RUNNING_STATUS_TEXT, sessionId));
      hooksRunning = true;
      return out;
    }
    if (hooksRunning && (MODEL_OUTPUT_TYPES.has(str(raw.type)) || raw.type === 'tool_progress')) {
      hooksRunning = false;
      out.broadcast.push(statusFrame(HOOK_DONE_STATUS_TEXT, sessionId));
      return out;
    }
    if (raw.type === 'result') {
      hooksRunning = false;
      const warning = credentialWarned ? null : credentialWarning(raw, sessionId, now());
      if (warning) {
        credentialWarned = true;
        out.ownerOnly.push(warning);
      }
      return out;
    }
    if (raw.type === 'system' && raw.subtype === 'informational' && raw.level === 'warning') {
      hookWarning(raw, sessionId, out);
    } else if (raw.type === 'system' && raw.subtype === 'session_writes_lost') {
      out.broadcast.push(writesLost(raw, sessionId));
    }
    return out;
  }

  return { observe };
}
