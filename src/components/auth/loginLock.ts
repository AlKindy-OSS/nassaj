/**
 * T-2035 (ADR-212) client side of the login throttle and of sign-out
 * everywhere.
 *
 * - `login_temporarily_locked` (429) comes from /api/auth/login,
 *   /api/auth/accounts/add and PATCH /api/auth/me/password. It is a form
 *   error with a wait time, never a session failure: nothing signs out.
 * - A successful sign-out with `scope: 'all'` ended every token the user
 *   held; the login page says so once (one-shot notice, like ssoReauth).
 */

export const LOGIN_LOCKED_CODE = 'login_temporarily_locked';
export const SIGNED_OUT_EVERYWHERE_NOTICE_KEY = 'nassaj:signed-out-everywhere';

type NoticeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type TranslateLock = (key: string, options: { minutes: number; ns?: string }) => string;

/** Whole minutes to show for a lock, never below one. */
export function loginLockMinutes(retryAfterSeconds: number | undefined): number {
  const seconds = Number.isFinite(retryAfterSeconds) ? Number(retryAfterSeconds) : 60;
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * The lock's wait in seconds when `response` is a throttle lock, else null.
 * Prefers the body's `retryAfterSeconds`, then the Retry-After header.
 */
export function readLoginLock(
  response: Pick<Response, 'status' | 'headers'>,
  payload: unknown,
): number | null {
  if (response.status !== 429) return null;
  const body = payload && typeof payload === 'object' ? payload as { code?: unknown; retryAfterSeconds?: unknown } : null;
  if (body?.code !== LOGIN_LOCKED_CODE) return null;
  if (typeof body.retryAfterSeconds === 'number' && body.retryAfterSeconds > 0) return body.retryAfterSeconds;
  const header = Number(response.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? header : 60;
}

/** The localized lock message (`auth:loginLocked`). */
export function loginLockedMessage(t: TranslateLock, retryAfterSeconds: number | undefined): string {
  return t('loginLocked', { ns: 'auth', minutes: loginLockMinutes(retryAfterSeconds) });
}

function sessionStore(storage?: NoticeStorage): NoticeStorage | null {
  if (storage) return storage;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Leaves the one-shot "signed out on all devices" notice for the login page. */
export function recordSignedOutEverywhereNotice(storage?: NoticeStorage): void {
  try {
    sessionStore(storage)?.setItem(SIGNED_OUT_EVERYWHERE_NOTICE_KEY, '1');
  } catch {
    // Without storage the notice is simply not shown.
  }
}

/** Whether the notice is pending (does not clear it). */
export function hasSignedOutEverywhereNotice(storage?: NoticeStorage): boolean {
  try {
    return sessionStore(storage)?.getItem(SIGNED_OUT_EVERYWHERE_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Reads and clears the notice. */
export function consumeSignedOutEverywhereNotice(storage?: NoticeStorage): boolean {
  const present = hasSignedOutEverywhereNotice(storage);
  try {
    if (present) sessionStore(storage)?.removeItem(SIGNED_OUT_EVERYWHERE_NOTICE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  return present;
}
