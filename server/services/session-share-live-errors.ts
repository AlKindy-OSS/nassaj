/**
 * Typed failures of the live session projection (ADR-205 D2). The guest route
 * (stage 3) maps them to responses; none of them is a 500.
 */

export type LiveProjectionErrorCode = 'HISTORY_UNAVAILABLE' | 'CURSOR_STALE';

/** A retryable unavailability (503) or a stale cursor (409). */
export class LiveProjectionError extends Error {
  readonly statusCode: 503 | 409;

  constructor(readonly code: LiveProjectionErrorCode, readonly retryAfterMs?: number, readonly detail?: string) {
    super(code);
    this.name = 'LiveProjectionError';
    this.statusCode = code === 'CURSOR_STALE' ? 409 : 503;
  }
}

/** 503 HISTORY_UNAVAILABLE with a retry hint; `detail` is for server logs only. */
export function unavailable(retryAfterMs: number, detail?: string): LiveProjectionError {
  return new LiveProjectionError('HISTORY_UNAVAILABLE', Math.max(1, Math.ceil(retryAfterMs)), detail);
}

/** 409 CURSOR_STALE: the anchor is not in the current projection. */
export function cursorStale(): LiveProjectionError {
  return new LiveProjectionError('CURSOR_STALE');
}
