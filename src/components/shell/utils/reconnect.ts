// Pure auto-reconnect helpers shared by the shell terminal and (via re-export)
// the standalone terminals feature. Kept side-effect free so the loop-prevention
// logic — backoff growth, the hard attempt cap, and the intentional-vs-abnormal
// close classification — is unit-testable without a live WebSocket.

/** First backoff step; the delay doubles from here. */
export const RECONNECT_BASE_DELAY_MS = 1000;
/** Backoff ceiling: no retry waits longer than this. */
export const RECONNECT_MAX_DELAY_MS = 10000;
/**
 * Hard cap on consecutive failed re-attaches before we give up and fall back to
 * a manual affordance. This is the primary guard against an unbounded reconnect
 * loop against a permanently dead endpoint.
 */
export const MAX_RECONNECT_ATTEMPTS = 6;
/**
 * A normal WebSocket closure (1000) is treated as intentional and never
 * auto-reconnected; the server keepalive culls stale sockets with the abnormal
 * 1006 instead, which is exactly what we want to re-attach.
 */
export const NORMAL_CLOSE_CODE = 1000;

/**
 * Application close codes the shell endpoint uses to REFUSE a session outright:
 * 4401 unauthenticated, 4403 role/permission, 4404 project not visible. Each is
 * preceded by an `error` frame carrying the reason, and none of them can be
 * fixed by retrying with the same credentials, role or project — so they are
 * final, exactly the way the terminals mirror classifies its own 4xxx codes.
 *
 * Deliberately NOT a catch-all "the server sent an error, so stop": the update
 * gate refuses with an `error` frame and leaves the socket OPEN for a later
 * retry, so a drop that happens afterwards (a server restart during the very
 * update that closed the gate) must still re-attach.
 */
export const FINAL_SHELL_REFUSAL_CLOSE_CODES = Object.freeze([4401, 4403, 4404]);

/**
 * B-1448: the close reason (and `error` frame code) when the owner closed every
 * terminal to install an update. It rides on a final 4404, so both terminal
 * clients stop; the reason only decides which explanation the user sees.
 */
export const UPDATE_TERMINALS_CLOSED_REASON = 'update_terminals_closed';

/** Whether a close code is one of the endpoint's outright refusals. */
export function isFinalShellRefusalClose(code: number): boolean {
  return FINAL_SHELL_REFUSAL_CLOSE_CODES.includes(code);
}

/**
 * Exponential backoff: `base * 2^attempt`, clamped to `max`. `attempt` is the
 * zero-based retry index, so the sequence with the defaults is
 * 1s, 2s, 4s, 8s, 10s, 10s, … (capped).
 */
export function computeBackoffDelay(
  attempt: number,
  base: number = RECONNECT_BASE_DELAY_MS,
  max: number = RECONNECT_MAX_DELAY_MS,
): number {
  const safeAttempt = attempt < 0 ? 0 : attempt;
  return Math.min(base * 2 ** safeAttempt, max);
}

/** Whether another re-attach is allowed given how many have already failed. */
export function shouldRetryReconnect(
  attemptsMade: number,
  maxAttempts: number = MAX_RECONNECT_ATTEMPTS,
): boolean {
  return attemptsMade < maxAttempts;
}

/**
 * Classify a shell socket close: intentional closes (user disconnect/restart,
 * project/session switch, unmount — all surfaced via `suppressAutoConnect` after
 * the ref-nulling teardown) and clean 1000 closures stop; everything else is an
 * abnormal drop we re-attach.
 */
export function isIntentionalShellClose(
  code: number,
  suppressAutoConnect: boolean,
): boolean {
  return suppressAutoConnect || code === NORMAL_CLOSE_CODE;
}

/**
 * T-2037: `error` frame codes with which the server refuses a one-shot run.
 * Every one of them is final — a retry would either be refused again or, worse,
 * replay a command the user never re-confirmed — so a one-shot shell that
 * receives any of them stops auto-connecting at once, before the 4403 close.
 */
export const ONESHOT_REFUSAL_CODES = Object.freeze([
  'forbidden',
  'raw_exec_blocked',
  'raw_exec_disabled',
  'config_denied',
  'forbidden_control_char',
  'carriage_return_forbidden',
  'command_too_long',
  'too_many_lines',
  'oneshot_shape_invalid',
  'oneshot_limit',
  'audit_unavailable',
  'oneshot_in_progress',
  'oneshot_start_failed',
  'invalid_command',
  'provider_removed',
  'oneshot_ledger_unavailable',
]);

/**
 * The one `error` code a one-shot shell must NOT treat as final: the capture
 * could not be served (other user, TTL expired, identity revoked). The server
 * keeps the socket open; only the attach request fails.
 */
export const ONESHOT_CAPTURE_UNAVAILABLE_CODE = 'oneshot_capture_unavailable';

/** Prefix of the per-rule denylist refusal (`denied_command:<rule>`). */
export const ONESHOT_DENIED_COMMAND_PREFIX = 'denied_command:';

/**
 * Whether an `error` frame ends a one-shot run for good. Every code except the
 * capture miss is final — the listed refusals, `denied_command:<rule>`, and any
 * code the server adds later (brakes on a live run, the update gate…): a runId
 * refused once is consumed, so the only way forward is a new, confirmed submit.
 */
export function isOneShotRefusalCode(code: string | null | undefined): boolean {
  return code !== ONESHOT_CAPTURE_UNAVAILABLE_CODE;
}

/** Whether a code has its own localized reason (else the generic one is shown). */
export function isKnownOneShotRefusalCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return ONESHOT_REFUSAL_CODES.includes(code) || code.startsWith(ONESHOT_DENIED_COMMAND_PREFIX);
}
