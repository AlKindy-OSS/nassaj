/**
 * OIDC back-channel logout, per the ADR-H20 D5 standard and the D6 matrix
 * (ADR-194 amendment A2).
 *
 * Responses:
 *   200  only for a verified logout token, whether or not it matched a session
 *        (an already-processed `jti` is a 200 with no effect);
 *   400  for an invalid token or request;
 *   503  + Retry-After for our own failures (keys, an unknown kid after the
 *        throttled refetch, the session or jti store, a full jti store).
 *
 * Matrix (V8: the IdP sends a logout only on a real sign-out, always with sid):
 *   - sid matched: that browser's Nassaj device session ends (revocation
 *     stored, sockets close 4401). Running turns continue and API keys are
 *     untouched, for the owner and members alike. The owner is affected only
 *     while the node's kill switch "IdP sign-out affects the owner" is on.
 *   - sid unmatched: no effect, audited. Never a fallback to `sub`.
 *   - no sid: refused 400 (`logout_sid_required`), no effect.
 *
 * The `jti` is recorded only once the answer is a 200 (V4: the IdP retries
 * 3 times within 5 minutes with a fresh iat and the same jti, so a jti stored
 * before success would refuse the legitimate retry after our 503). The store
 * is persistent and never evicts an unexpired entry; full → 503.
 */
// Namespace import: route tests replace the database barrel with partial mocks.
import * as databaseModule from '../modules/database/index.js';

import { endSsoDeviceSession } from './sso-device-session.service.js';

export const BACKCHANNEL_MAX_BODY_BYTES = 8 * 1024;
export const BACKCHANNEL_RETRY_AFTER_SECONDS = 300;
export const BACKCHANNEL_TIMEOUT_MS = 5_000;
export const LOGOUT_JTI_MAX_ENTRIES = 10_000;
/** A jti is remembered at least as long as the IdP may retry (token lifetime 15 min, V4). */
const JTI_MIN_RETENTION_MS = 15 * 60_000;
const JTI_MAX_RETENTION_MS = 24 * 60 * 60_000;
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const SAFE_CODE = /^[a-z0-9_:]{1,80}$/;

/**
 * Verifier failure codes (oidc-verifier.service.js) that mean "we could not
 * verify right now": keys or endpoints unavailable, or a kid still unknown
 * after the throttled refetch. Answered 503 + Retry-After, never 400.
 */
const RETRYABLE_VERIFIER_CODES = new Set([
  'jwks_unavailable', 'invalid_jwks', 'unknown_or_ambiguous_kid', 'endpoint_unpinned',
  'discovery_unavailable', 'invalid_discovery', 'invalid_discovery_jwks_uri',
  'invalid_discovery_authorization_endpoint', 'invalid_discovery_token_endpoint',
]);

/**
 * True when a verifier error is a failure on our side, false for an invalid
 * token. Classified by the fixed code only.
 * @param {unknown} error
 */
export function isRetryableVerifierFailure(error) {
  return typeof error?.code === 'string' && RETRYABLE_VERIFIER_CODES.has(error.code);
}

/** Fixed-code structured log line; never a token, subject or sid. */
export function logBackchannel(reason) {
  const code = typeof reason === 'string' && SAFE_CODE.test(reason) ? reason : 'unclassified';
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'oidc_backchannel', code })}\n`);
}

/**
 * D5 request limits checked before any parsing of the token: form encoding
 * only, a declared length of at most 8 KB, and one string `logout_token`.
 * @param {import('express').Request} req
 * @returns {{ status: number, reason: string } | { token: string }}
 */
export function readBackchannelRequest(req) {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== FORM_CONTENT_TYPE) return { status: 415, reason: 'content_type_refused' };
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > BACKCHANNEL_MAX_BODY_BYTES) {
    return { status: 413, reason: 'body_too_large' };
  }
  const token = req.body?.logout_token;
  if (typeof token !== 'string' || token.length === 0) return { status: 400, reason: 'logout_token_missing' };
  if (Buffer.byteLength(token, 'utf8') > BACKCHANNEL_MAX_BODY_BYTES) return { status: 413, reason: 'body_too_large' };
  return { token };
}

function jtiExpiry(claims, nowMs) {
  const tokenExpiry = Number.isFinite(claims.exp) ? claims.exp * 1000 : nowMs;
  return Math.min(nowMs + JTI_MAX_RETENTION_MS, Math.max(tokenExpiry, nowMs + JTI_MIN_RETENTION_MS));
}

function unavailable(reason) {
  return { status: 503, reason };
}

/**
 * The D6 matrix for one verified token. Returns what happened, or throws
 * (a store failure: the caller answers 503).
 */
function applyLogoutMatrix(issuer, claims, { idpSignOutAffectsOwner, nowMs }) {
  const rows = databaseModule.ssoDeviceSessionsDb.findByIdpSid(issuer, claims.sid);
  if (rows.length === 0) return { outcome: 'sid_unmatched', ended: [] };
  const identity = databaseModule.userIdentitiesDb.findByIssuerAndSubject(issuer, claims.sub);
  const ended = [];
  const skipped = [];
  for (const row of rows) {
    if (!identity || identity.user_id !== row.user_id) {
      skipped.push({ userId: row.user_id, reason: 'subject_mismatch' });
      continue;
    }
    const role = databaseModule.userDb.getRawById(row.user_id)?.role ?? null;
    if (role === 'owner' && !idpSignOutAffectsOwner) {
      skipped.push({ userId: row.user_id, reason: 'owner_kill_switch_off', role });
      continue;
    }
    const closedSockets = endSsoDeviceSession({ userId: row.user_id, refreshSid: row.refresh_sid, nowMs });
    ended.push({ userId: row.user_id, role, closedSockets });
  }
  return { outcome: ended.length > 0 ? 'session_ended' : 'no_effect', ended, skipped };
}

/**
 * Verifies and applies one logout token. Never throws.
 * @param {{ verifier: { verifyLogoutToken: (token: string) => Promise<Record<string, unknown>> },
 *   issuer: string, token: string, nowMs?: number }} input
 * @returns {Promise<{ status: number, reason: string, outcome?: object }>}
 */
export async function processBackchannelLogout({ verifier, issuer, token, nowMs = Date.now() }) {
  let claims;
  try {
    claims = await verifier.verifyLogoutToken(token);
  } catch (error) {
    if (isRetryableVerifierFailure(error)) return unavailable(`verifier_unavailable:${error.code}`);
    return { status: 400, reason: typeof error?.code === 'string' ? error.code : 'invalid_token' };
  }
  let settings;
  try {
    if (databaseModule.oidcLogoutJtisDb.seen(issuer, claims.jti, nowMs)) return { status: 200, reason: 'replay_noop' };
    if (databaseModule.oidcLogoutJtisDb.countActive(nowMs) >= LOGOUT_JTI_MAX_ENTRIES) return unavailable('jti_store_full');
    settings = databaseModule.ssoLinkedSettingsDb.read();
  } catch {
    return unavailable('store_unavailable');
  }
  let outcome;
  try {
    outcome = applyLogoutMatrix(issuer, claims, { idpSignOutAffectsOwner: settings.idpSignOutAffectsOwner, nowMs });
  } catch {
    return unavailable('revocation_failed');
  }
  try {
    const recorded = databaseModule.oidcLogoutJtisDb.record(issuer, claims.jti, {
      expiresAt: jtiExpiry(claims, nowMs), nowMs, maxEntries: LOGOUT_JTI_MAX_ENTRIES,
    });
    if (recorded === 'full') return { ...unavailable('jti_store_full'), outcome };
  } catch {
    return { ...unavailable('store_unavailable'), outcome };
  }
  return { status: 200, reason: outcome.outcome, outcome };
}

/**
 * Bounds processing to BACKCHANNEL_TIMEOUT_MS (D5): past it the answer is 503
 * so the IdP retries; the work in flight may still finish (idempotent).
 * @param {Promise<{ status: number, reason: string }>} work
 * @param {number} [timeoutMs]
 */
export function withBackchannelTimeout(work, timeoutMs = BACKCHANNEL_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(unavailable('timeout')), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
