/**
 * The one per-user step-up quota (T-1939 6A/6B): 5 attempts per user per 15
 * minutes, shared by password, passkey and OIDC step-up starts across every
 * audience, under the key `stepup:<id>`.
 *
 * Its own module (no database import) so the OIDC routes can count an IdP
 * step-up start against the same bucket without pulling the step-up
 * verifier's dependencies into their tests.
 */

import { createKeyedLimiter } from '../middleware/keyed-limiter.js';

const stepUpLimiter = createKeyedLimiter({ windowMs: 15 * 60_000, max: 5 });

/**
 * Counts one step-up attempt for `userId`.
 * @param {number} userId
 * @returns {{ allowed: boolean, retryAfterSeconds: number }}
 */
export function consumeStepUpAttempt(userId) {
  return stepUpLimiter.hit(`stepup:${userId}`);
}

/**
 * Returns one attempt to `userId`'s bucket after a SUCCESSFUL password or
 * passkey step-up (ADR-194 D8), so only failures consume the quota. Never
 * called for OIDC step-up starts or oidc_grant redemption.
 * @param {number} userId
 */
export function refundStepUpAttempt(userId) {
  stepUpLimiter.refund(`stepup:${userId}`);
}
