/**
 * Linked SSO sign-in and sign-out, client side (ADR-H20 S6).
 *
 * - N1 auto sign-in: with the node setting on, an unauthenticated visit goes
 *   straight to the IdP, except on the explicit local path (`?local=1`), once
 *   right after an explicit sign-out, and when the loop guard fires (3 bounces
 *   within 30 s).
 * - N4 sign-out: after the local sign-out the browser goes to the IdP
 *   end_session URL the server returned, so every linked app signs out.
 * - D9-1 re-check: when the server says it is due, one silent prompt=none
 *   round trip at page load (guarded so a failing IdP cannot loop).
 *
 * Only timestamps and flags are stored; never a user id or token.
 */
import { api } from '../../utils/api';

export const EXPLICIT_SIGN_OUT_KEY = 'nassaj:sso-explicit-sign-out';
export const AUTO_SIGN_IN_BOUNCES_KEY = 'nassaj:sso-auto-sign-in-bounces';
export const RECHECK_STARTED_AT_KEY = 'nassaj:sso-recheck-started-at';
export const LOOP_GUARD_BOUNCES = 3;
export const LOOP_GUARD_WINDOW_MS = 30_000;
/** An explicit sign-out suppresses auto sign-in once, if it happened this recently. */
export const EXPLICIT_SIGN_OUT_TTL_MS = 30 * 60_000;
/** At most one silent re-check navigation per tab in this interval. */
export const RECHECK_COOLDOWN_MS = 10 * 60_000;

type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Deps = { local?: KeyStorage | null; session?: KeyStorage | null; now?: () => number };

function storageOf(kind: 'localStorage' | 'sessionStorage', override?: KeyStorage | null): KeyStorage | null {
  if (override !== undefined) return override;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** True when the URL asks for the local password sign-in (break-glass). */
export function localLoginRequested(search: string): boolean {
  return new URLSearchParams(search).get('local') === '1';
}

/** Records an explicit sign-out, so the next visit does not sign straight back in. */
export function markExplicitSignOut({ local, now = Date.now }: Deps = {}): void {
  const store = storageOf('localStorage', local);
  safely(() => store?.setItem(EXPLICIT_SIGN_OUT_KEY, String(now())), undefined);
}

/** True once after a recent explicit sign-out; clears the mark. */
export function consumeExplicitSignOut({ local, now = Date.now }: Deps = {}): boolean {
  const store = storageOf('localStorage', local);
  const raw = safely(() => store?.getItem(EXPLICIT_SIGN_OUT_KEY) ?? null, null);
  if (raw === null) return false;
  safely(() => store?.removeItem(EXPLICIT_SIGN_OUT_KEY), undefined);
  const age = now() - Number(raw);
  return Number.isFinite(age) && age >= 0 && age <= EXPLICIT_SIGN_OUT_TTL_MS;
}

/**
 * Counts one automatic IdP redirect. Each one that comes back unauthenticated
 * is a bounce; after 3 bounces within 30 s the loop guard answers false and
 * the caller shows the sign-in page with the reason instead (ADR-H20 F12).
 */
export function admitAutoSignIn({ session, now = Date.now }: Deps = {}): boolean {
  const store = storageOf('sessionStorage', session);
  const at = now();
  const raw = safely(() => store?.getItem(AUTO_SIGN_IN_BOUNCES_KEY), null);
  const parsed = safely(() => (raw ? JSON.parse(raw) : []), [] as unknown);
  const recent = (Array.isArray(parsed) ? parsed : [])
    .filter((value): value is number => typeof value === 'number' && at - value >= 0 && at - value < LOOP_GUARD_WINDOW_MS);
  if (recent.length >= LOOP_GUARD_BOUNCES) return false;
  safely(() => store?.setItem(AUTO_SIGN_IN_BOUNCES_KEY, JSON.stringify([...recent, at])), undefined);
  return true;
}

/** Forgets the bounce count after a successful sign-in. */
export function resetAutoSignInGuard({ session }: Deps = {}): void {
  safely(() => storageOf('sessionStorage', session)?.removeItem(AUTO_SIGN_IN_BOUNCES_KEY), undefined);
}

export type AutoSignInDecision = 'redirect' | 'show_login' | 'loop_guard';

/**
 * N1: whether the sign-in page should leave for the IdP right away. The
 * explicit-sign-out mark is consumed here, so it suppresses exactly one visit.
 */
export function decideAutoSignIn(
  { autoSignIn, loginAvailable, search }: { autoSignIn: boolean; loginAvailable: boolean; search: string },
  deps: Deps = {},
): AutoSignInDecision {
  if (!autoSignIn || !loginAvailable || localLoginRequested(search)) return 'show_login';
  if (consumeExplicitSignOut(deps)) return 'show_login';
  return admitAutoSignIn(deps) ? 'redirect' : 'loop_guard';
}

/** N4: leaves for the IdP end_session URL (an absolute https URL from our own server). */
export function followEndSession(endSessionUrl: unknown, assign: (url: string) => void = (url) => window.location.assign(url)): boolean {
  if (typeof endSessionUrl !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(endSessionUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  assign(parsed.toString());
  return true;
}

async function authorizationUrlFrom(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { authorizationUrl?: unknown } | null;
  return typeof body?.authorizationUrl === 'string' ? body.authorizationUrl : null;
}

// The re-check runs at a page load only: never in the middle of work after a
// token refresh re-runs the auth check.
let recheckAttemptedThisPage = false;

/** Test seam: forget that this page already asked. */
export function resetRecheckPageGuard(): void {
  recheckAttemptedThisPage = false;
}

/**
 * D9-1: once per page load, asks the server whether this SSO session is due
 * for its silent re-check and, if so (and not attempted in the last 10
 * minutes in this tab), leaves for the IdP with prompt=none. Resolves true
 * when it navigated.
 */
export async function runSsoRecheckIfDue(
  { session, now = Date.now, assign = (url: string) => window.location.assign(url) }: Deps & { assign?: (url: string) => void } = {},
): Promise<boolean> {
  if (recheckAttemptedThisPage) return false;
  recheckAttemptedThisPage = true;
  try {
    const status = await api.auth.oidc.session();
    if (!status.ok) return false;
    const body = await status.json().catch(() => null) as { recheckDue?: unknown } | null;
    if (body?.recheckDue !== true) return false;
    const store = storageOf('sessionStorage', session);
    const last = Number(safely(() => store?.getItem(RECHECK_STARTED_AT_KEY), null));
    if (last && now() - last >= 0 && now() - last < RECHECK_COOLDOWN_MS) return false;
    const url = await authorizationUrlFrom(await api.auth.oidc.startRecheck());
    if (!url) return false;
    safely(() => store?.setItem(RECHECK_STARTED_AT_KEY, String(now())), undefined);
    assign(url);
    return true;
  } catch {
    return false;
  }
}

export type SsoSessionReturn = { kind: 'recheck'; outcome: 'ok' | 'kept' | 'signed_out' };

/** Classifies a re-check return (`/auth/oidc/return?...`), else null. */
export function readSsoSessionReturn(params: URLSearchParams): SsoSessionReturn | null {
  const recheck = params.get('oidc_recheck');
  if (recheck === 'ok' || recheck === 'kept' || recheck === 'signed_out') return { kind: 'recheck', outcome: recheck };
  return null;
}
