/**
 * SSO apply and enable (ADR-194 D9/D1, T-1962 S4).
 *
 * applySsoDraft runs ONE immediate transaction:
 *   1. re-read the draft; its draft_version and recomputed config_hash must
 *      equal the request's AND match a passed `discovery` and a passed
 *      `sign_in` proof by this owner, under 24 hours (sso_apply_proof_missing);
 *   2. copy draft → active, re-encrypting the secret under the `active` AAD,
 *      clear runtime_fault, bump `version`;
 *   3. mapping change → null attestation of every linked non-owner (I2);
 *   4. issuer change → force JIT off on the new row and revoke sessions and
 *      API keys of the orphaned non-owners, unless the owner opted out with
 *      the typed confirmation (I3/I7);
 *   5. strict audit — a failure rolls back everything above.
 * Live-session revocation runs after commit, best effort.
 *
 * An issuer change is "the active issuer differs"; with no active row it is
 * "some non-owner is linked only under other issuers" (fail closed: a first
 * apply towards a different IdP never inherits JIT or keeps orphans signed in).
 */
import { getConnection } from '../modules/database/connection.js';
// Namespace import: tests replace this repository with partial mocks, and a
// named import of an absent binding would fail at link time.
import * as auditLogRepository from '../modules/database/repositories/audit-log.js';
import {
  clearLinkedNonOwnerAttestationOn,
  linkedNonOwnerIdsOn,
  orphanedNonOwnerIdsOn,
  revokeApiKeysForUsersOn,
  stampUsersSessionsRevokedOn,
  writeActiveSlotOn,
} from '../modules/database/repositories/sso-apply.js';
import {
  deleteDisabledRecordOn,
  disabledRecordPresentOn,
  draftFieldsOf,
  readSlotOn,
  setActiveEnabledOn,
} from '../modules/database/repositories/sso-oidc-config.js';
import { hasPassedSsoApplyProofOn } from '../modules/database/repositories/sso-test-evidence.js';
import { decryptSsoClientSecret, encryptSsoClientSecret } from '../modules/database/sso-secret-envelope.js';

import { computeSsoConfigHash, ssoConfigInvalidReason } from './sso-config-record.js';
import { ssoForceOff, ssoPolicyEnforced } from './sso-config.service.js';
import { revokeLiveAccessForUsers } from './sso-lifecycle.service.js';
import { SsoSettingsError } from './sso-settings-error.js';

/** The typed phrases (one per UI language) that keep orphaned members signed in. */
export const KEEP_SIGNED_IN_CONFIRMATIONS = Object.freeze(['KEEP SIGNED IN', 'إبقاء الجلسات']);
const MAPPING_FIELDS = Object.freeze(['role_claim_path', 'role_rules_json', 'tenant_mode', 'tenant_claim_path',
  'tenant_values_json', 'jit_enabled']);

/** Impact of applying `draft` over `active` (both may be absent), computed on `db`. */
function impactOn(db, draft, active) {
  const orphanIds = orphanedNonOwnerIdsOn(db, draft.issuer);
  const issuerChanged = active ? active.issuer !== draft.issuer : orphanIds.length > 0;
  const mappingChanged = !active || MAPPING_FIELDS.some((field) => active[field] !== draft[field]);
  return {
    issuerChanged, mappingChanged, orphanIds: issuerChanged ? orphanIds : [],
    reattestRequired: mappingChanged ? linkedNonOwnerIdsOn(db).length : 0,
    jitForcedOff: issuerChanged && draft.jit_enabled === 1,
  };
}

/**
 * Counts for the apply impact dialog (D8 step 7), or null without a draft.
 * Read-only; the apply transaction recomputes them itself.
 */
export function ssoApplyImpact() {
  const db = getConnection();
  const draft = readSlotOn(db, 'draft');
  if (!draft) return null;
  const impact = impactOn(db, draft, readSlotOn(db, 'active'));
  return {
    issuerChanged: impact.issuerChanged, mappingChanged: impact.mappingChanged,
    reattestRequired: impact.reattestRequired, orphaned: impact.orphanIds.length,
    jitForcedOff: impact.jitForcedOff, policyEnforcedNow: ssoPolicyEnforced(),
  };
}

function assertProofs(db, draft, request, nowMs) {
  const bound = draft && draft.draft_version === request.draftVersion && draft.config_hash === request.configHash
    && computeSsoConfigHash(draft) === request.configHash;
  const proven = bound && ['discovery', 'sign_in'].every((kind) => hasPassedSsoApplyProofOn(db, {
    ownerUserId: request.actorUserId, configHash: draft.config_hash, draftVersion: draft.draft_version, kind, nowMs,
  }));
  if (!proven) throw new SsoSettingsError('sso_apply_proof_missing', 409);
}

/** Re-encrypts the draft secret under the active AAD; the plaintext lives in this frame only. */
function activeSecret(draft) {
  if (draft.client_auth === 'none' || draft.client_secret_enc === null) return draft.client_secret_enc;
  const aad = { issuer: draft.issuer, clientId: draft.client_id };
  try {
    return encryptSsoClientSecret(decryptSsoClientSecret(draft.client_secret_enc, { slot: 'draft', ...aad }),
      { slot: 'active', ...aad });
  } catch {
    throw new SsoSettingsError('sso_secret_undecryptable', 409);
  }
}

function buildActiveFields(draft, impact) {
  const fields = {
    ...draftFieldsOf(draft), client_secret_enc: activeSecret(draft),
    jit_enabled: impact.issuerChanged ? 0 : draft.jit_enabled,
  };
  return { ...fields, config_hash: computeSsoConfigHash(fields) };
}

function assertKeepConfirmation(request, impact) {
  if (request.keepOrphanedSessions !== true || impact.orphanIds.length === 0) return;
  if (!KEEP_SIGNED_IN_CONFIRMATIONS.includes(request.confirmation)) {
    throw new SsoSettingsError('sso_keep_confirmation_required', 400);
  }
}

/** Writes the new active row after full validation (enabled as requested or as before). */
function writeActive(db, { draft, active, fields, request, nowMs }) {
  const enabled = request.enable === true ? 1 : (active?.enabled ?? 0);
  const version = (active?.version ?? 0) + 1;
  const reason = ssoConfigInvalidReason({ ...fields, slot: 'active', enabled, runtime_fault: null, version });
  if (reason !== null) throw new SsoSettingsError('sso_config_invalid', 409, { reason });
  writeActiveSlotOn(db, fields, {
    enabled, version, draftVersion: draft.draft_version, actorUserId: request.actorUserId, nowMs,
  });
  if (request.enable === true) deleteDisabledRecordOn(db);
  return { enabled, version };
}

/** Steps 3–4: attestation reset and orphan revocation; returns the ids to cut live. */
function applySideEffects(db, impact, request, nowMs) {
  const reattestRequired = impact.mappingChanged ? clearLinkedNonOwnerAttestationOn(db) : 0;
  const revoke = impact.orphanIds.length > 0 && request.keepOrphanedSessions !== true;
  const revokedIds = revoke ? stampUsersSessionsRevokedOn(db, impact.orphanIds, nowMs) : [];
  const keysRevoked = revoke ? revokeApiKeysForUsersOn(db, impact.orphanIds) : 0;
  return { reattestRequired, revokedIds, keysRevoked, revoked: revoke };
}

function applyTransaction(db, request, nowMs) {
  const draft = readSlotOn(db, 'draft');
  assertProofs(db, draft, request, nowMs);
  if (request.enable === true && ssoForceOff()) throw new SsoSettingsError('sso_force_off', 409);
  const active = readSlotOn(db, 'active');
  const impact = impactOn(db, draft, active);
  assertKeepConfirmation(request, impact);
  const fields = buildActiveFields(draft, impact);
  const written = writeActive(db, { draft, active, fields, request, nowMs });
  const effects = applySideEffects(db, impact, request, nowMs);
  const summary = {
    version: written.version, enabled: written.enabled === 1, mappingChanged: impact.mappingChanged,
    reattestRequired: effects.reattestRequired, issuerChanged: impact.issuerChanged,
    orphaned: impact.orphanIds.length, revoked: effects.revoked, keysRevoked: effects.keysRevoked,
    jitForcedOff: impact.jitForcedOff,
  };
  auditLogRepository.recordStrictAuditOnConnection(db, 'sso_config_applied', {
    userId: request.actorUserId, metadata: summary,
  });
  return { summary, revokedIds: effects.revokedIds };
}

/**
 * POST /api/settings/sso/apply (service half; the route owns step-up).
 * @param {{ actorUserId: number, draftVersion: number, configHash: string, enable?: boolean,
 *   keepOrphanedSessions?: boolean, confirmation?: string, nowMs?: number,
 *   afterCommit?: (userIds: number[]) => void }} request
 */
export function applySsoDraft({ nowMs = Date.now(), afterCommit = revokeLiveAccessForUsers, ...request }) {
  const db = getConnection();
  const { summary, revokedIds } = db.transaction(() => applyTransaction(db, request, nowMs)).immediate();
  afterCommit(revokedIds);
  return summary;
}

/**
 * POST /api/settings/sso/enable (service half; the route owns step-up): a
 * valid, fault-free active row is enabled and the disabled record removed in
 * one transaction with its strict audit.
 * @param {{ actorUserId: number, nowMs?: number }} params
 */
export function enableSso({ actorUserId, nowMs = Date.now() }) {
  const db = getConnection();
  return db.transaction(() => {
    if (ssoForceOff()) throw new SsoSettingsError('sso_force_off', 409);
    const active = readSlotOn(db, 'active');
    if (!active) throw new SsoSettingsError('sso_active_config_missing', 409);
    if (active.runtime_fault !== null) throw new SsoSettingsError('sso_runtime_fault', 409, { reason: active.runtime_fault });
    const reason = ssoConfigInvalidReason(active);
    if (reason !== null) throw new SsoSettingsError('sso_config_invalid', 409, { reason });
    const disabledRecordCleared = disabledRecordPresentOn(db) && deleteDisabledRecordOn(db);
    if (active.enabled !== 1) setActiveEnabledOn(db, 1, actorUserId, nowMs);
    auditLogRepository.recordStrictAuditOnConnection(db, 'sso_enabled', {
      userId: actorUserId, metadata: { disabledRecordCleared },
    });
    return { enabled: true, disabledRecordCleared };
  }).immediate();
}
