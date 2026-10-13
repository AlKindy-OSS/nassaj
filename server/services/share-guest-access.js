/**
 * The guest authorization order shared by every share-token reader of
 * session shares (ADR-205 D1 "Authorization order per guest request"):
 *
 *   1. token shape            → uniform 404, nothing charged
 *   2. row lookup + constant-time token verification (DUMMY_HASH without a row),
 *      before any shared throttle: a valid token is never refused by pre-auth state
 *   3. failed verification only → per-IP failure buckets: 429 over a limit, else 404
 *   4. liveness incl. owner_unreadable → uniform 404
 *   5. admission (per-share bucket, concurrency, slots) → 429 with Retry-After
 *
 * The guest principal is never a user: nothing here touches req.user.
 */
import { ipRateKey } from '../utils/ip-rate-key.js';
import { clientIp } from '../utils/client-ip.js';

import { SessionShareError, evaluateReadLiveness } from './session-share-policy.js';
import { isShareToken, verifyShareToken } from './share-capability.js';

/** Stored-hash stand-in for a missing row, so a miss costs the same SHA-256 and compare. */
const DUMMY_HASH = 'f'.repeat(64);

/** The uniform guest refusal: unknown, revoked, expired, dead or wrong-mode shares all look alike. */
export const shareUnavailable = () => new SessionShareError('SHARE_UNAVAILABLE', 404);

/** 429 carrying the Retry-After seconds the responder sends. */
export function shareRateLimited(retryAfterSec) {
  return new SessionShareError('RATE_LIMITED', 429, { retryAfterSec: Math.max(1, Math.ceil(retryAfterSec)) });
}

/** The caller's rate-limit bucket (IPv6 collapsed to its /64). */
export function guestIpKey(req) {
  return ipRateKey(clientIp(req));
}

/**
 * Steps 1-3: verifies `X-Share-Token` against the row of `id`.
 * @param {import('express').Request} req
 * @param {string} id share id, already shape-checked
 * @param {{ getStore: Function, guards: { failedVerification: (ipKey: string) => boolean } }} deps
 * @returns {object} the verified share row
 * @throws SessionShareError 404 SHARE_UNAVAILABLE | 429 RATE_LIMITED
 */
export function verifyGuestToken(req, id, deps) {
  const token = req.get('X-Share-Token');
  if (!isShareToken(token)) throw shareUnavailable();
  const row = deps.getStore().get(id);
  const valid = verifyShareToken(token, row ? row.token_hash : DUMMY_HASH);
  if (row && valid) return row;
  if (deps.guards.failedVerification(guestIpKey(req))) throw shareRateLimited(60);
  throw shareUnavailable();
}

/**
 * Step 4: the share must be alive and its pinned owner must still read the session.
 * @throws SessionShareError 404 SHARE_UNAVAILABLE
 */
export function assertGuestReadable(row, policy, nowMs) {
  if (evaluateReadLiveness(row, policy, nowMs) !== null) throw shareUnavailable();
}

/**
 * Step 5: turns an admission verdict into its release function.
 * @param {{ release: Function } | { refused: true, retryAfterSec: number }} admission
 * @throws SessionShareError 429 RATE_LIMITED
 */
export function admittedOrThrow(admission) {
  if ('refused' in admission) throw shareRateLimited(admission.retryAfterSec);
  return admission.release;
}

/**
 * Releases a slot exactly once when the response finishes, the socket closes
 * or errors, or (backstop) after `deadlineMs`, destroying a reader that is
 * still connected so it cannot pin the slot.
 */
export function releaseWhenDone(res, release, deadlineMs) {
  let released = false;
  const timer = setTimeout(() => { done(); res.destroy(); }, deadlineMs);
  timer.unref?.();
  function done() {
    if (released) return;
    released = true;
    clearTimeout(timer);
    release();
  }
  res.once('finish', done);
  res.once('close', done);
  res.once('error', done);
}

/** The headers every guest response carries (ADR-205 D1 point 4). */
export function setGuestHeaders(res) {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'X-Share-Token', 'Access-Control-Max-Age': '600' });
}
