/**
 * The OIDC browser-transaction cookie (P-IDP-3, T-1939 6B).
 *
 * One secure, HttpOnly cookie ties an IdP round trip to the browser tab that
 * started it: the login code exchange, the self-link, and the step-up grant
 * all require it. Shared here so the step-up verifier can read it without
 * importing the OIDC routes.
 */

export const BROWSER_TRANSACTION_COOKIE = '__Host-oidc-txn';

export const BROWSER_TRANSACTION_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
});

/**
 * The request's transaction value, or null when absent, malformed, or sent
 * more than once (an ambiguous duplicate is never guessed at).
 * @param {{ headers: { cookie?: unknown } }} req
 * @returns {string | null}
 */
export function readBrowserTransaction(req) {
  const cookieHeader = req?.headers?.cookie;
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 4096) {
    return null;
  }
  const prefix = `${BROWSER_TRANSACTION_COOKIE}=`;
  const values = cookieHeader.split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => part.slice(prefix.length));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]) ? values[0] : null;
}
