/**
 * SSO re-attestation (T-1939 slice 3) — client side of `sso_reauth_required`.
 *
 * A linked team member whose SSO attestation aged out gets 401
 * `sso_reauth_required` from every nassaj endpoint. That is not a plain logout:
 * the SPA sends the browser straight back through the SSO flow and leaves a
 * one-shot notice the login page shows if the member lands there instead.
 *
 * Loop guard: if the previous SSO redirect for this reason happened less than
 * REDIRECT_COOLDOWN_MS ago, the IdP bounced straight back to a still-refused
 * session, so the member is left on the login page with the notice rather than
 * redirected again.
 */

import { SSO_REAUTH_EVENT } from '../../utils/api';

import { startOidcLogin } from './oidc';

export { SSO_REAUTH_EVENT };
export const SSO_REAUTH_NOTICE_KEY = 'nassaj:sso-reauth-notice';
export const SSO_REAUTH_REDIRECT_AT_KEY = 'nassaj:sso-reauth-redirect-at';
export const REDIRECT_COOLDOWN_MS = 60_000;

type SsoReauthDeps = {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now?: () => number;
  redirect?: () => void;
};

function safeStorage(storage?: SsoReauthDeps['storage']) {
  if (storage) return storage;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * `redirected` — this call started the SSO navigation; `in_flight` — an earlier
 * call in this page already did (a concurrent 401 burst), so the caller must not
 * navigate; `cooling` — loop guard: the caller falls back to the login page.
 */
export type SsoReauthOutcome = 'redirected' | 'in_flight' | 'cooling';

// Set once the SSO navigation starts; the page unloads with it. Cleared only if
// the page is restored from the back/forward cache or the redirect throws.
let redirectInFlight = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted) redirectInFlight = false;
  });
}

/** True while an SSO re-attestation navigation started by this page is pending. */
export function isSsoRedirectInFlight(): boolean {
  return redirectInFlight;
}

/** Test seam: forget a pending redirect (module state outlives a test). */
export function resetSsoRedirectInFlight(): void {
  redirectInFlight = false;
}

/**
 * Records the notice and starts the SSO flow unless a redirect is already in
 * flight or one for the same reason just happened.
 */
export function requestSsoReauth(
  { storage, now = Date.now, redirect = startOidcLogin }: SsoReauthDeps = {},
): SsoReauthOutcome {
  if (redirectInFlight) return 'in_flight';
  const store = safeStorage(storage);
  const nowMs = now();
  try {
    store?.setItem(SSO_REAUTH_NOTICE_KEY, '1');
    const last = Number(store?.getItem(SSO_REAUTH_REDIRECT_AT_KEY));
    if (Number.isFinite(last) && last > 0 && nowMs - last < REDIRECT_COOLDOWN_MS) return 'cooling';
    store?.setItem(SSO_REAUTH_REDIRECT_AT_KEY, String(nowMs));
  } catch {
    // Storage unavailable: still redirect once; the IdP flow itself is safe.
  }
  redirectInFlight = true;
  try {
    redirect();
  } catch (error) {
    redirectInFlight = false;
    throw error;
  }
  return 'redirected';
}

/** Whether a re-attestation notice is pending (does not clear it). */
export function hasSsoReauthNotice(storage?: SsoReauthDeps['storage']): boolean {
  try {
    return safeStorage(storage)?.getItem(SSO_REAUTH_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Reads and clears the one-shot notice. */
export function consumeSsoReauthNotice(storage?: SsoReauthDeps['storage']): boolean {
  const present = hasSsoReauthNotice(storage);
  try {
    if (present) safeStorage(storage)?.removeItem(SSO_REAUTH_NOTICE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  return present;
}
