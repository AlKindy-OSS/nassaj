/**
 * Shared username availability policy (T-1939 slice 4, qa follow-up).
 *
 * One rule for every path that assigns a username chosen by (or derived for) a
 * member — self-rename, invite acceptance and SSO just-in-time creation: the
 * name must not be reserved and must not match any existing account, active or
 * not, case-insensitively. The first-owner bootstrap is deliberately outside
 * it: that operator-supplied name (default 'owner') predates every member.
 */

// Namespace import: route tests replace the database module with partial
// mocks, and a named import of an absent binding would fail at link time.
import * as databaseModule from '../modules/database/index.js';

// Module-private so no caller can add to or remove from it; read it only
// through isReservedUsername().
const RESERVED_USERNAMES = new Set([
  'owner', 'admin', 'administrator', 'root', 'superuser', 'system', 'nassaj', 'api',
  'support', 'guest', 'user', 'null', 'undefined',
]);

/**
 * Whether `username` is a reserved name (compared lower-case).
 * @param {unknown} username
 * @returns {boolean}
 */
export function isReservedUsername(username) {
  return typeof username === 'string' && RESERVED_USERNAMES.has(username.toLowerCase());
}

/**
 * Whether `username` may be taken: not reserved and not held — case-insensitively,
 * by any account in any status — by an account other than `excludeUserId`.
 * @param {string} username
 * @param {{ excludeUserId?: number | null }} [options]
 * @returns {boolean}
 */
export function isUsernameAvailable(username, { excludeUserId = null } = {}) {
  if (isReservedUsername(username)) {
    return false;
  }
  return !databaseModule.userDb.isUsernameTaken(username, excludeUserId);
}
