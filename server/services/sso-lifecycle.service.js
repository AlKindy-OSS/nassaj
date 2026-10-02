/**
 * SSO enforcement transitions (ADR-194 D1, T-1962 S1).
 *
 * Ending enforcement always ends linked members' sessions, unless the owner
 * keeps them while SSO is active (the S4 route requires step-up for that).
 * Both exits — owner disable and the NASSAJ_SSO_FORCE_OFF boot transition —
 * run ONE immediate transaction: stamp linked non-owner sessions revoked, set
 * `enabled=0` on the active row, write `sso.disabled`, strict audit. Refresh
 * caches and live runs are cut after commit, best effort.
 *
 * Boot re-assertion: an enabled active row together with a disabled record is
 * an inconsistent restore; the record is removed (enabled is stricter).
 */
import { getConnection } from '../modules/database/connection.js';
import { recordStrictAuditOnConnection } from '../modules/database/repositories/audit-log.js';
import {
  deleteDisabledRecordOn,
  disabledRecordPresentOn,
  readSlotOn,
  setActiveEnabledOn,
  stampLinkedNonOwnerSessionsRevokedOn,
  writeDisabledRecordOn,
} from '../modules/database/repositories/sso-oidc-config.js';
import { revokeUserIdentity } from '../modules/account-wallet/user-identity-revocation.js';
import { SSO_ATTESTATION_EXPIRED_REVOCATION } from '../modules/account-wallet/user-realtime-revocation.js';
import { invalidateRefreshCache } from '../middleware/auth.js';
import { apiKeySsoUnavailableGateRegistered } from '../modules/database/repositories/api-key-sso-gate.js';

import { ssoForceOff, ssoState } from './sso-config.service.js';
import { sweepTestEvidence } from './sso-test-signin.service.js';

function log(level, code, fields = {}) {
  process.stderr.write(`${JSON.stringify({ level, scope: 'sso', code, ...fields })}\n`);
}

/** Default post-commit step: drop refresh grace and cut live access of each revoked member. */
export function revokeLiveAccessForUsers(userIds) {
  for (const userId of userIds) {
    try {
      invalidateRefreshCache(userId);
      revokeUserIdentity(userId, SSO_ATTESTATION_EXPIRED_REVOCATION);
    } catch {
      log('warn', 'sso_disable_live_revocation_failed');
    }
  }
}

/** The shared disable transaction body; must run inside an immediate transaction. */
function runDisableTransition(db, { reason, auditAction, actorUserId, revoke, fromState, nowMs }) {
  const revokedIds = revoke ? stampLinkedNonOwnerSessionsRevokedOn(db, nowMs) : [];
  setActiveEnabledOn(db, 0, actorUserId, nowMs);
  writeDisabledRecordOn(db, reason, nowMs);
  recordStrictAuditOnConnection(db, auditAction, {
    userId: actorUserId,
    metadata: { linkedRevoked: revokedIds.length, fromState, keptSessions: !revoke },
  });
  return { revokedIds, fromState, keptSessions: !revoke };
}

/** Refusal of a disable that needs step-up (I6): raised inside the transaction. */
export class SsoDisableStepUpRequiredError extends Error {
  constructor() {
    super('step_up_required');
    this.name = 'SsoDisableStepUpRequiredError';
    this.code = 'step_up_required';
  }
}

/**
 * Owner disable (service half of POST /api/settings/sso/disable, S4). The
 * route owns authentication and step-up verification; this function owns the
 * invariants: sessions may be kept only when SSO was active, and — when the
 * route asks for it with `requireStepUpWhenActive` — a disable from the
 * `active` state without verified step-up is refused, decided on the state
 * read INSIDE the transaction (no race with a concurrent enable). Idempotent:
 * an existing disabled record revokes nothing again.
 * @param {{ actorUserId: number, keepLinkedSessions?: boolean, nowMs?: number,
 *           requireStepUpWhenActive?: boolean, stepUpVerified?: boolean,
 *           afterCommit?: (userIds: number[]) => void }} input
 */
export function disableSso({
  actorUserId, keepLinkedSessions = false, nowMs = Date.now(), afterCommit = revokeLiveAccessForUsers,
  requireStepUpWhenActive = false, stepUpVerified = false,
}) {
  const db = getConnection();
  const result = db.transaction(() => {
    if (disabledRecordPresentOn(db)) return null;
    const fromState = ssoState();
    if (requireStepUpWhenActive && fromState === 'active' && stepUpVerified !== true) {
      throw new SsoDisableStepUpRequiredError();
    }
    const revoke = !(keepLinkedSessions === true && fromState === 'active');
    return runDisableTransition(db, {
      reason: 'owner', auditAction: 'sso_disabled', actorUserId, revoke, fromState, nowMs,
    });
  }).immediate();
  if (result === null) return { alreadyDisabled: true, linkedRevoked: 0, fromState: 'off', keptSessions: false };
  afterCommit(result.revokedIds);
  return {
    alreadyDisabled: false, linkedRevoked: result.revokedIds.length,
    fromState: result.fromState, keptSessions: result.keptSessions,
  };
}

/** FORCE_OFF at boot: once, revoking linked sessions; later boots find the record. */
function applyForceOff(db, nowMs, afterCommit) {
  const result = db.transaction(() => {
    if (disabledRecordPresentOn(db)) return null;
    const fromState = ssoState();
    return runDisableTransition(db, {
      reason: 'force_off', auditAction: 'sso_force_off_applied', actorUserId: null, revoke: true, fromState, nowMs,
    });
  }).immediate();
  if (result === null) return { action: 'none' };
  afterCommit(result.revokedIds);
  log('warn', 'sso_force_off_applied', { linkedRevoked: result.revokedIds.length });
  return { action: 'force_off_applied', linkedRevoked: result.revokedIds.length };
}

/** Enabled wins over a stale disabled record (inconsistent restore). */
function reassertEnabled(db) {
  const cleared = db.transaction(() => {
    if (readSlotOn(db, 'active')?.enabled !== 1 || !disabledRecordPresentOn(db)) return false;
    deleteDisabledRecordOn(db);
    recordStrictAuditOnConnection(db, 'sso_disabled_record_cleared', { userId: null });
    return true;
  }).immediate();
  if (cleared) log('warn', 'sso_disabled_record_cleared');
  return { action: cleared ? 'disabled_record_cleared' : 'none' };
}

/** One warning naming (never valuing) OIDC_* variables an active row makes irrelevant. */
function warnIgnoredLegacyEnv(db) {
  if (readSlotOn(db, 'active') === undefined) return;
  const ignored = Object.keys(process.env).filter((name) => name.startsWith('OIDC_')).sort();
  if (ignored.length > 0) log('warn', 'sso_legacy_env_ignored', { variables: ignored });
}

/**
 * Boot step, after migrations and before the listener. Never throws: a failure
 * is logged and the live predicates stay fail-closed (FORCE_OFF lifts nothing
 * until its record is committed).
 * @param {{ nowMs?: number, afterCommit?: (userIds: number[]) => void }} [options]
 */
export function applySsoBootPolicy({ nowMs = Date.now(), afterCommit = revokeLiveAccessForUsers } = {}) {
  try {
    const db = getConnection();
    const outcome = ssoForceOff() ? applyForceOff(db, nowMs, afterCommit) : reassertEnabled(db);
    warnIgnoredLegacyEnv(db);
    sweepTestEvidence(nowMs);
    log('info', 'sso_boot_state', { state: ssoState() });
    return outcome;
  } catch {
    log('warn', 'sso_boot_policy_failed');
    return { action: 'failed' };
  }
}

/**
 * ADR-194 D6 boot assertion (S9 M1): the API key clause refuses linked
 * members while SSO is enforced but unavailable only if the SSO state model
 * registered its gate. A missing gate would silently fall back to the plain
 * window, so boot refuses to serve instead (fail closed).
 * @throws {Error} SSO_API_KEY_GATE_MISSING
 */
export function assertSsoApiKeyGateRegistered() {
  if (apiKeySsoUnavailableGateRegistered()) return;
  log('error', 'sso_api_key_gate_missing');
  throw new Error('SSO_API_KEY_GATE_MISSING');
}
