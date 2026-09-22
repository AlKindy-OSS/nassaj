/**
 * OIDC single sign-on — client side of server/routes/oidc.js (B-728, ADR-046).
 *
 * Flow: the login screen navigates the whole page to `OIDC_LOGIN_PATH`; the
 * server sets the `__Host-oidc-txn` cookie and redirects to the IdP; the IdP
 * returns to the server callback, which redirects to `OIDC_RETURN_PATH` with an
 * opaque one-time code (never the JWT). The return page redeems it here with a
 * same-origin POST, so the transaction cookie proves it is the same browser.
 *
 * Everything in this module is transport + classification; the session itself
 * is established by AuthContext.loginWithOidcCode.
 */

import { api } from '../../utils/api';

import type { AuthUser, AuthUserPayload } from './types';
import { parseJsonSafely } from './utils';

export const OIDC_LOGIN_PATH = '/api/auth/oidc/login';
export const OIDC_RETURN_PATH = '/auth/oidc/return';
export const OIDC_CODE_PARAM = 'oidc_code';
export const OIDC_ERROR_PARAM = 'error';

export type OidcFailureReason =
  | 'missing_code'
  | 'invalid_state'
  | 'provider_denied'
  | 'transaction_expired'
  | 'not_linked'
  | 'account_unavailable'
  | 'disabled'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'session_failed'
  | 'network';

export type OidcExchangeResult = { ok: true; token: string } | { ok: false; reason: OidcFailureReason };

export type OidcIdentityResult =
  | { ok: true; user: AuthUser; isMultiUser: boolean }
  | { ok: false; reason: OidcFailureReason };

// `error` values a return URL may carry. The IdP ones are the standard OAuth
// 2.0 / OIDC authorization-error codes; the rest are this app's own codes for a
// server callback that fails before a one-time code exists.
const RETURN_ERROR_REASONS: Readonly<Record<string, OidcFailureReason>> = {
  access_denied: 'provider_denied',
  login_required: 'provider_denied',
  consent_required: 'provider_denied',
  interaction_required: 'provider_denied',
  account_selection_required: 'provider_denied',
  invalid_state: 'invalid_state',
  transaction_expired: 'transaction_expired',
  oidc_not_linked: 'not_linked',
  account_unavailable: 'account_unavailable',
  temporarily_unavailable: 'provider_unavailable',
  server_error: 'provider_unavailable',
};

/** Classifies an `error` query value on the return page. Unknown → provider_unavailable. */
export function reasonFromReturnError(value: string): OidcFailureReason {
  return Object.prototype.hasOwnProperty.call(RETURN_ERROR_REASONS, value)
    ? RETURN_ERROR_REASONS[value]
    : 'provider_unavailable';
}

/**
 * Classifies a failed POST /exchange. 401 is the only answer for a code that is
 * unknown, already redeemed, older than its one-minute TTL, or presented
 * without the matching transaction cookie (another browser / cleared cookies) —
 * all of which mean "start the sign-in again".
 */
export function reasonFromExchangeStatus(status: number): OidcFailureReason {
  switch (status) {
    case 400:
      return 'missing_code';
    case 401:
      return 'transaction_expired';
    case 429:
      return 'rate_limited';
    case 501:
      return 'disabled';
    default:
      return 'provider_unavailable';
  }
}

/** Redeems the one-time code for a JWT. Never throws. */
export async function exchangeOidcCode(code: string): Promise<OidcExchangeResult> {
  let response: Response;
  try {
    response = await api.auth.oidc.exchange(code);
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!response.ok) {
    return { ok: false, reason: reasonFromExchangeStatus(response.status) };
  }
  const payload = await parseJsonSafely<{ token?: unknown }>(response);
  if (typeof payload?.token !== 'string' || payload.token.length === 0) {
    return { ok: false, reason: 'provider_unavailable' };
  }
  return { ok: true, token: payload.token };
}

/**
 * Loads the full identity for a freshly minted token WITHOUT persisting it
 * first: a token that turns out to be unusable must never reach localStorage,
 * where other tabs would adopt it and then be signed out by its removal.
 */
export async function fetchOidcIdentity(token: string): Promise<OidcIdentityResult> {
  let response: Response;
  try {
    response = await fetch('/api/auth/user', { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return { ok: false, reason: 'network' };
  }
  const payload = response.ok ? await parseJsonSafely<AuthUserPayload>(response) : null;
  if (!payload?.user) {
    return { ok: false, reason: 'session_failed' };
  }
  return { ok: true, user: payload.user, isMultiUser: Boolean(payload.isMultiUser) };
}

let availability: Promise<boolean> | null = null;

async function probeOidcAvailability(): Promise<boolean> {
  // Preferred signal, once the server advertises it on the public status route.
  const statusResponse = await api.auth.status();
  const status = await parseJsonSafely<{ oidcEnabled?: unknown }>(statusResponse);
  if (typeof status?.oidcEnabled === 'boolean') {
    return status.oidcEnabled;
  }
  // Fallback for the current server: see api.auth.oidc.probe.
  const probe = await api.auth.oidc.probe();
  return probe.status === 400;
}

/**
 * Whether this server has OIDC switched on (OIDC_ENABLED=true). Resolved once
 * per page load and shared by every caller; a failed probe reads as "off" and
 * is not cached, so a later mount retries.
 */
export function detectOidcAvailability(): Promise<boolean> {
  if (!availability) {
    availability = probeOidcAvailability().catch(() => {
      availability = null;
      return false;
    });
  }
  return availability;
}

/** Test seam: forget the cached availability. */
export function resetOidcAvailabilityCache(): void {
  availability = null;
}

/** Leaves the SPA for the server-driven authorization redirect. */
export function startOidcLogin(): void {
  window.location.assign(OIDC_LOGIN_PATH);
}
