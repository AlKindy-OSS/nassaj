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
