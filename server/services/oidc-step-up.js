/**
 * OIDC step-up freshness rule (T-1939 6B).
 *
 * An SSO-linked member steps up by signing in again at the IdP with
 * prompt=login&max_age=0. The id_token's auth_time must prove that sign-in
 * happened for THIS request: not before it was started (minus clock skew),
 * and at most STEP_UP_MAX_AUTH_AGE_MS ago — two minutes, which already
 * includes the one minute of skew tolerated in either direction. A missing
 * auth_time, or one further in the future than the skew, is refused.
 */

/** Clock skew tolerated between this server and the IdP, in either direction. */
export const STEP_UP_CLOCK_SKEW_MS = 60_000;
/** Oldest acceptable IdP sign-in for a step-up, skew included. */
export const STEP_UP_MAX_AUTH_AGE_MS = 120_000;

/**
 * Why auth_time cannot prove a fresh step-up sign-in, or null when it can.
 * @param {{ authTimeMs: number | null, requestedAtMs: number, nowMs: number }} input
 * @returns {'auth_time_missing' | 'auth_time_before_request' | 'auth_time_in_future'
 *   | 'auth_time_stale' | null}
 */
export function stepUpAuthTimeFailure({ authTimeMs, requestedAtMs, nowMs }) {
  if (!Number.isFinite(authTimeMs)) return 'auth_time_missing';
  if (authTimeMs < requestedAtMs - STEP_UP_CLOCK_SKEW_MS) return 'auth_time_before_request';
  if (authTimeMs > nowMs + STEP_UP_CLOCK_SKEW_MS) return 'auth_time_in_future';
  if (nowMs - authTimeMs > STEP_UP_MAX_AUTH_AGE_MS) return 'auth_time_stale';
  return null;
}
