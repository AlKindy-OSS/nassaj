/**
 * SSO-only policy for linked team accounts (T-1939 slice 2).
 *
 * When OIDC is live (oidcEnabled()), the IdP is the single team identity: a
 * NON-OWNER account that holds an IdP link may no longer sign in with a local
 * credential (password, wallet add, passkey), and invites may no longer create
 * local-password accounts. The owner stays local (break-glass) regardless.
 * With OIDC off every predicate here is false, so nothing changes.
 *
 * Callers that check a password must run the full verification FIRST and apply
 * this gate only on a correct password, so the refusal never reveals whether
 * an account exists or is linked (same cost, same generic failure otherwise).
 */
// Namespace import: route tests replace the database module with partial
// mocks, and a named import of an absent binding would fail at link time.
import * as databaseModule from '../modules/database/index.js';

import { oidcEnabled } from './oidc-config.js';

/** Error code returned to clients when an account must use SSO. */
export const SSO_REQUIRED_CODE = 'sso_required';
/** Error code returned when an invite would create a local-password account. */
export const SSO_REQUIRED_FOR_NEW_ACCOUNTS_CODE = 'sso_required_for_new_accounts';

/**
 * True when `user` must sign in through the IdP instead of a local credential.
 * @param {{ id: number, role: string } | null | undefined} user
 * @returns {boolean}
 */
export function requiresSsoLogin(user) {
  if (!user || user.role === 'owner' || !oidcEnabled()) {
    return false;
  }
  return databaseModule.userIdentitiesDb.hasAnyLink(user.id);
}

/**
 * True when new local-password accounts (invite acceptance) are closed.
 * @returns {boolean}
 */
export function localAccountCreationClosed() {
  return oidcEnabled();
}

/**
 * Audits and answers a refused local-credential entry point. 403 (never 401)
 * so the SPA never mistakes it for a lost session.
 * @param {import('express').Response} res
 * @param {{ userId?: number | null, entry: string, code?: string,
 *           ipAddress?: string | null, userAgent?: string | null }} refusal
 */
export function refuseLocalCredential(res, {
  userId = null, entry, code = SSO_REQUIRED_CODE, ipAddress = null, userAgent = null,
}) {
  databaseModule.auditLogDb.record('sso_required_denied', { userId, metadata: { entry }, ipAddress, userAgent });
  return res.status(403).set('Cache-Control', 'no-store').json({
    error: code === SSO_REQUIRED_CODE
      ? 'This account signs in through SSO'
      : 'New accounts are created through SSO',
    code,
  });
}
