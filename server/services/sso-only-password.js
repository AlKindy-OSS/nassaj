/**
 * Password sentinel for SSO-only accounts (T-1939 slice 4).
 *
 * An account created just-in-time from an SSO sign-in has no local
 * password. Its `password_hash` column holds this fixed marker, which is not
 * a hash of anything: password.service.verifyPassword recognises it, spends
 * the same argon2id work as a real check (so response timing never reveals
 * the account kind), and always answers false. needsRehash never upgrades it.
 *
 * Kept in its own dependency-free module so routes can import the constant
 * without depending on the hashing service (route tests mock that service).
 */

/** Stored in users.password_hash for accounts that can only sign in via SSO. */
export const SSO_ONLY_PASSWORD_HASH = '!sso-only:v1';

/**
 * Whether a stored password hash is the SSO-only sentinel.
 * @param {unknown} hash
 * @returns {boolean}
 */
export function isSsoOnlyPasswordHash(hash) {
  return hash === SSO_ONLY_PASSWORD_HASH;
}
