/**
 * Periodic close of long-lived connections whose SSO attestation aged out
 * (T-1939 slice 3).
 *
 * Every request and every new WebSocket is refused once a linked member's
 * attestation is stale (sso-attestation.js), but a socket, shell or terminal
 * opened while it was fresh stays open until something closes it. This sweep
 * finds active linked NON-OWNER members past the window and revokes their live
 * access once per stale attestation: reconnecting is refused at the upgrade, so
 * repeating the revocation would only churn. Bounded per tick, never throws,
 * and a no-op while the SSO policy is not enforced. Enforced but login
 * unavailable (ADR-194 D1): every linked non-owner is stale and swept.
 */
// Namespace import: tests replace the database module with partial mocks.
import * as databaseModule from '../modules/database/index.js';
import { revokeUserIdentity } from '../modules/account-wallet/user-identity-revocation.js';
import { SSO_ATTESTATION_EXPIRED_REVOCATION } from '../modules/account-wallet/user-realtime-revocation.js';

import { ssoAttestationPolicy } from './sso-config.service.js';

export const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Most revocations one tick performs; the rest wait for the next tick. */
export const SWEEP_MAX_REVOCATIONS = 50;
const PAGE_SIZE = 200;

/** userId → latest attestation value already revoked for (null = never stamped). */
const revokedAttestations = new Map();

function logSweepFailure(code) {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'sso-attestation-sweep', code })}\n`);
}

/** Revokes one stale member; false when the revocation itself failed. */
function revokeStaleMember(userId, latestAttestedAt, revoke) {
  try {
    const result = revoke(userId, SSO_ATTESTATION_EXPIRED_REVOCATION);
    revokedAttestations.set(userId, latestAttestedAt);
    const closedSockets = result?.closedSockets ?? 0;
    const endedInteractiveSessions = result?.endedInteractiveSessions ?? 0;
    // Audit only an actual close: a stale member with nothing open is routine.
    if (closedSockets + endedInteractiveSessions > 0) {
      databaseModule.auditLogDb.record('sso_attestation_expired', {
        userId, metadata: { closedSockets, endedInteractiveSessions },
      });
    }
    return true;
  } catch {
    logSweepFailure('revocation_failed');
    return false;
  }
}

/**
 * One sweep pass. Returns how many members were revoked this tick.
 * @param {{ nowMs?: number, revoke?: typeof revokeUserIdentity, maxRevocations?: number }} [options]
 * @returns {number}
 */
export function runSsoAttestationSweep({
  nowMs = Date.now(),
  revoke = revokeUserIdentity,
  maxRevocations = SWEEP_MAX_REVOCATIONS,
} = {}) {
  const policy = ssoAttestationPolicy();
  if (!policy.enforced) return 0;
  // Nobody can re-attest while login is unavailable: every attestation is stale.
  const cutoffMs = policy.loginAvailable ? nowMs - policy.maxAgeMs : Number.MAX_SAFE_INTEGER;
  let revoked = 0;
  let afterUserId = 0;
  try {
    for (;;) {
      const page = databaseModule.userIdentitiesDb.listStaleLinkedNonOwners(cutoffMs, afterUserId, PAGE_SIZE);
      for (const { userId, latestAttestedAt } of page) {
        afterUserId = userId;
        if (revoked >= maxRevocations) return revoked;
        const known = revokedAttestations.has(userId) && revokedAttestations.get(userId) === latestAttestedAt;
        if (!known && revokeStaleMember(userId, latestAttestedAt, revoke)) revoked += 1;
      }
      if (page.length < PAGE_SIZE) return revoked;
    }
  } catch {
    logSweepFailure('sweep_failed');
    return revoked;
  }
}

/** Test seam: forget which attestations were already revoked. */
export function resetSsoAttestationSweepState() {
  revokedAttestations.clear();
}

let sweepTimer = null;

/**
 * Starts the periodic sweep (idempotent). The timer is unref'd so it never
 * holds the process open. Returns a stop function.
 * @param {{ intervalMs?: number }} [options]
 * @returns {() => void}
 */
export function startSsoAttestationSweep({ intervalMs = SWEEP_INTERVAL_MS } = {}) {
  if (!sweepTimer) {
    sweepTimer = setInterval(() => { runSsoAttestationSweep(); }, intervalMs);
    sweepTimer.unref?.();
  }
  return stopSsoAttestationSweep;
}

/** Stops the periodic sweep. */
export function stopSsoAttestationSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
