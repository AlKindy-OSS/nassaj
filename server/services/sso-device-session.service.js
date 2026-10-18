/**
 * SSO device sessions (ADR-H20 S6; ADR-194 amendment A2).
 *
 * A Nassaj device session that started through SSO is bound, at sign-in, to
 * the IdP session id (`sid`) of that browser. The binding (keyed by the JWT
 * `refreshSid`, so it survives every refresh) carries:
 *
 *   - the 24 h idle clock (N8): the session ends after 24 h with no use and is
 *     renewed by use, throttled to one write per 5 minutes;
 *   - the silent re-check clock (D9-1): every N hours (12 by default, at most
 *     24) the SPA re-asks the IdP with prompt=none at the next page load;
 *   - the owner tier (N2): an owner who entered with no click from an IdP
 *     session holds full read access, but privileged actions need a fresh
 *     passkey step-up whose grant (about 60 minutes) lives on THIS row only, so
 *     it never crosses to another browser and ends with the session;
 *   - the login hint of the session's own user, for the re-check (V10a).
 *
 * Password sessions are never bound and are out of reach of the linked
 * sign-out (ADR-H20 D7).
 */
// Namespace import: route tests replace the database barrel with partial mocks.
import * as databaseModule from '../modules/database/index.js';
import { revokeTokenSession } from '../modules/account-wallet/token-session.js';

/** One idle-clock write per device session per this interval. */
export const SSO_SESSION_TOUCH_THROTTLE_MS = 5 * 60_000;
/** Lifetime of an owner's privileged step-up grant (ADR-H20 D6 A1: "about 60 minutes"). */
export const OWNER_PRIVILEGE_TTL_MS = 60 * 60_000;
/**
 * Longest a token of one device session can outlive its last use: the JWT
 * lifetime (7 d, middleware/auth.js TOKEN_TTL_MS) plus the largest refresh
 * grace (72 h, REFRESH_GRACE_MAX_HOURS) plus the touch throttle. A row is kept
 * at least this long after its last use, so pruning it can never make an idle
 * token current again. Asserted against the middleware constants in tests.
 */
export const MAX_SESSION_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60_000 + 72 * 60 * 60_000 + SSO_SESSION_TOUCH_THROTTLE_MS;
const PRUNE_MARGIN_MS = 60 * 60_000;
/** How long a signed-out device session stays revoked (every token of it has expired by then). */
const REVOCATION_LIFETIME_MS = MAX_SESSION_TOKEN_LIFETIME_MS + PRUNE_MARGIN_MS;

const MAX_IDP_SID_LENGTH = 255;
const MAX_LOGIN_HINT_LENGTH = 255;

function logSessionFailure(code) {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'sso_device_session', code })}\n`);
}

function pruneAfter(nowMs) {
  return nowMs + MAX_SESSION_TOKEN_LIFETIME_MS + PRUNE_MARGIN_MS;
}

/**
 * The IdP session id of verified claims, or null. Only a bounded printable
 * string is used (it is a lookup key, never echoed).
 * @param {Record<string, unknown> | null | undefined} claims
 * @returns {string | null}
 */
export function idpSidOf(claims) {
  const sid = claims?.sid;
  if (typeof sid !== 'string' || sid.length === 0 || sid.length > MAX_IDP_SID_LENGTH) return null;
  return /[\u0000-\u001f\u007f]/.test(sid) ? null : sid;
}

/**
 * The login name to send as `login_hint` on a re-check or step-up: the
 * session's own user (never a "last user" cookie, ADR-H20 D3/V10a).
 * @param {Record<string, unknown> | null | undefined} claims
 * @returns {string | null}
 */
export function sessionLoginHintOf(claims) {
  const name = claims?.preferred_username;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_LOGIN_HINT_LENGTH) return null;
  return /[\u0000- \u007f]/.test(name) ? null : name;
}

/**
 * Binds a new SSO device session. A write failure throws: the caller refuses
 * the sign-in rather than hand out a session the linked sign-out cannot reach.
 * @param {{ refreshSid: string, userId: number, issuer: string, claims: Record<string, unknown>,
 *   ownerTier: boolean, privilegedUntil?: number | null, nowMs?: number }} input
 */
export function bindSsoDeviceSession({
  refreshSid, userId, issuer, claims, ownerTier, privilegedUntil = null, nowMs = Date.now(),
}) {
  // A barrel without the repository (a mocked test store) binds nothing,
  // exactly as token-session.ts treats revocations.
  if (!databaseModule.ssoDeviceSessionsDb) return;
  databaseModule.ssoDeviceSessionsDb.bind({
    refreshSid,
    userId,
    issuer,
    idpSid: idpSidOf(claims),
    loginHint: sessionLoginHintOf(claims),
    ownerTier: ownerTier === true,
    privilegedUntil: ownerTier === true && Number.isFinite(privilegedUntil) ? privilegedUntil : null,
    nowMs,
    pruneAfter: pruneAfter(nowMs),
  });
}

/**
 * The binding of one device session, or undefined for a password session.
 * Read errors propagate (callers fail closed).
 * @param {string | null | undefined} refreshSid
 */
export function ssoDeviceSessionOf(refreshSid) {
  if (typeof refreshSid !== 'string' || !refreshSid) return undefined;
  return databaseModule.ssoDeviceSessionsDb?.get(refreshSid);
}

/**
 * Records use of an SSO device session (throttled). Best effort: a failed
 * write is logged and never refuses the request, because the next request
 * retries it and the idle window is 24 h.
 * @param {string | null | undefined} refreshSid
 * @param {number} [nowMs]
 */
export function touchSsoDeviceSession(refreshSid, nowMs = Date.now()) {
  if (typeof refreshSid !== 'string' || !refreshSid || !databaseModule.ssoDeviceSessionsDb) return;
  try {
    databaseModule.ssoDeviceSessionsDb.touch(refreshSid, nowMs, SSO_SESSION_TOUCH_THROTTLE_MS, pruneAfter(nowMs));
  } catch {
    logSessionFailure('touch_failed');
  }
}

/**
 * Whether the silent prompt=none re-check is due for this session (D9-1).
 * @param {{ last_recheck_at: number } | undefined} row
 * @param {number} intervalHours 1..24
 * @param {number} [nowMs]
 */
export function ssoRecheckDue(row, intervalHours, nowMs = Date.now()) {
  if (!row) return false;
  return nowMs - row.last_recheck_at >= intervalHours * 60 * 60_000;
}

/**
 * Whether an owner's request in this device session must first pass the
 * passkey step-up: true for an owner-tier SSO session without a live grant
 * and for an SSO session bound before its user became owner (the step-up then
 * answers session_ended, forcing a fresh owner sign-in). Fails closed (true)
 * when the binding cannot be read for an owner.
 * @param {{ role?: string, refreshSid?: string | null } | null | undefined} principal
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function ownerStepUpRequired(principal, nowMs = Date.now()) {
  if (principal?.role !== 'owner') return false;
  if (typeof principal.refreshSid !== 'string' || !principal.refreshSid) return false;
  let row;
  try {
    row = ssoDeviceSessionOf(principal.refreshSid);
  } catch {
    logSessionFailure('privilege_read_failed');
    return true;
  }
  if (!row) return false;
  // A member promoted to owner keeps a member-tier binding (owner_tier is set
  // at sign-in, the role is read live): refuse until a fresh owner sign-in.
  if (row.owner_tier !== 1) return true;
  return !(Number.isFinite(row.privileged_until) && row.privileged_until > nowMs);
}

/**
 * Grants this browser's owner session the privileged tier for
 * OWNER_PRIVILEGE_TTL_MS. Returns the expiry, or null when the session is not
 * an owner-tier SSO session (nothing written).
 * @param {string} refreshSid
 * @param {number} [nowMs]
 * @returns {number | null}
 */
export function grantOwnerPrivilege(refreshSid, nowMs = Date.now()) {
  const row = ssoDeviceSessionOf(refreshSid);
  if (!row || row.owner_tier !== 1) return null;
  const until = nowMs + OWNER_PRIVILEGE_TTL_MS;
  return databaseModule.ssoDeviceSessionsDb.grantPrivilege(refreshSid, until) ? until : null;
}

/**
 * Ends one device session: stores its revocation (every token of it is then
 * refused and its sockets close with 4401), then forgets its binding, which
 * also ends any privileged grant. Running agent turns and API keys are not
 * touched. A revocation failure throws before anything is reported.
 * @param {{ userId: number, refreshSid: string, nowMs?: number }} input
 * @returns {number} sockets closed
 */
export function endSsoDeviceSession({ userId, refreshSid, nowMs = Date.now() }) {
  const closed = revokeTokenSession({ sid: refreshSid, userId, expiresAt: nowMs + REVOCATION_LIFETIME_MS, nowMs });
  try {
    databaseModule.ssoDeviceSessionsDb?.remove(refreshSid);
  } catch {
    // The revocation is authoritative; the row ages out by prune_after.
    logSessionFailure('binding_remove_failed');
  }
  return closed;
}

/**
 * Forgets the binding of a device session that signed out by itself (the
 * revocation is stored by the caller). Best effort.
 * @param {string | null | undefined} refreshSid
 */
export function forgetSsoDeviceSession(refreshSid) {
  if (typeof refreshSid !== 'string' || !refreshSid || !databaseModule.ssoDeviceSessionsDb) return;
  try {
    databaseModule.ssoDeviceSessionsDb.remove(refreshSid);
  } catch {
    logSessionFailure('binding_remove_failed');
  }
}

/**
 * Restarts the silent re-check interval of one device session. Throws on a
 * write failure.
 * @param {string} refreshSid
 * @param {number} [nowMs]
 */
export function markSsoRechecked(refreshSid, nowMs = Date.now()) {
  return databaseModule.ssoDeviceSessionsDb.markRechecked(refreshSid, nowMs);
}

/**
 * Records another IdP sid for this device session (a step-up or re-check may
 * open a new IdP session). Best effort: the earlier sid stays bound.
 * @param {string} refreshSid
 * @param {string} idpSid
 * @param {number} [nowMs]
 */
export function addSsoIdpSid(refreshSid, idpSid, nowMs = Date.now()) {
  try {
    return databaseModule.ssoDeviceSessionsDb.addIdpSid(refreshSid, idpSid, nowMs);
  } catch {
    logSessionFailure('idp_sid_add_failed');
    return false;
  }
}
