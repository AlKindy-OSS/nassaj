/**
 * T-2035 (ADR-212) client side of the login throttle and of sign-out
 * everywhere.
 *
 * - `login_temporarily_locked` (429) comes from /api/auth/login,
 *   /api/auth/accounts/add and PATCH /api/auth/me/password. It is a form
 *   error with a wait time, never a session failure: nothing signs out.
 * - A successful sign-out with `scope: 'all'` ended every token the user
 *   held; the login page says so once (one-shot notice, like ssoReauth).
 * - B-1652: a sign-out the server could not complete (5xx, 400
 *   ambiguous_authentication, network failure) after the local session was
 *   already cleared leaves a one-shot warning: the server session may survive.
 */

export const LOGIN_LOCKED_CODE = 'login_temporarily_locked';
export const SIGNED_OUT_EVERYWHERE_NOTICE_KEY = 'nassaj:signed-out-everywhere';
export const SIGN_OUT_INCOMPLETE_NOTICE_KEY = 'nassaj:sign-out-incomplete';
/** Fired on `window` when the incomplete notice is recorded after the login page mounted. */
export const SIGN_OUT_INCOMPLETE_EVENT = 'nassaj:sign-out-incomplete';

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

function recordNotice(key: string, storage?: NoticeStorage): void {
  try {
    sessionStore(storage)?.setItem(key, '1');
  } catch {
    // Without storage the notice is simply not shown.
  }
}

function hasNotice(key: string, storage?: NoticeStorage): boolean {
  try {
    return sessionStore(storage)?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function consumeNotice(key: string, storage?: NoticeStorage): boolean {
  const present = hasNotice(key, storage);
  try {
    if (present) sessionStore(storage)?.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  return present;
}

/** Leaves the one-shot "signed out on all devices" notice for the login page. */
export function recordSignedOutEverywhereNotice(storage?: NoticeStorage): void {
  recordNotice(SIGNED_OUT_EVERYWHERE_NOTICE_KEY, storage);
}

/** Whether the notice is pending (does not clear it). */
export function hasSignedOutEverywhereNotice(storage?: NoticeStorage): boolean {
  return hasNotice(SIGNED_OUT_EVERYWHERE_NOTICE_KEY, storage);
}

/** Reads and clears the notice. */
export function consumeSignedOutEverywhereNotice(storage?: NoticeStorage): boolean {
  return consumeNotice(SIGNED_OUT_EVERYWHERE_NOTICE_KEY, storage);
}

/**
 * B-1652: leaves the one-shot "sign-out did not reach the server" warning and
 * tells an already-mounted login page, since the answer arrives after the
 * local session was cleared.
 */
export function recordSignOutIncompleteNotice(storage?: NoticeStorage): void {
  recordNotice(SIGN_OUT_INCOMPLETE_NOTICE_KEY, storage);
  try {
    window.dispatchEvent(new Event(SIGN_OUT_INCOMPLETE_EVENT));
  } catch {
    // No window (tests with injected storage): the stored notice still shows.
  }
}

/** Whether the incomplete warning is pending (does not clear it). */
export function hasSignOutIncompleteNotice(storage?: NoticeStorage): boolean {
  return hasNotice(SIGN_OUT_INCOMPLETE_NOTICE_KEY, storage);
}

/** Reads and clears the incomplete warning. */
export function consumeSignOutIncompleteNotice(storage?: NoticeStorage): boolean {
  return consumeNotice(SIGN_OUT_INCOMPLETE_NOTICE_KEY, storage);
}

/**
 * Whether a sign-out answer leaves the server session possibly alive: any
 * non-2xx except 401, which means the session was already gone.
 */
export function isIncompleteSignOutStatus(status: number): boolean {
  return (status < 200 || status >= 300) && status !== 401;
}
