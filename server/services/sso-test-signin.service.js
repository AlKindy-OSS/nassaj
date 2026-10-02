/**
 * Terminal branch of a `test` callback (ADR-194 D2/D8, T-1962 S3).
 *
 * The owner signs in at the IdP against the UNAPPLIED draft. This module
 * evaluates the draft's D4/D5 mapping on the owner's own verified claims,
 * writes a one-time display row to `sso_test_results` and an apply proof to
 * `sso_apply_proofs`, and returns the display id. The token is discarded.
 *
 * Isolation (D2): this module imports nothing from the session, provisioning,
 * linking, attestation or grant paths — only the database connection, its own
 * evidence repository, the strict audit writer and the pure mapping helpers.
 * A test sign-in can therefore never mint a session, write a link, change a
 * role, stamp an attestation, revoke anyone or issue a grant.
 */
import crypto from 'node:crypto';

import { getConnection } from '../modules/database/connection.js';
// Namespace import: tests replace this repository with partial mocks, and a
// named import of an absent binding would fail at link time.
import * as auditLogRepository from '../modules/database/repositories/audit-log.js';
import {
  consumeSsoTestResultOn,
  insertSsoApplyProofOn,
  insertSsoTestResultOn,
  sweepSsoTestEvidenceOn,
} from '../modules/database/repositories/sso-test-evidence.js';

import { claimNames } from './sso-claim-path.js';
import {
  buildSsoMapping,
  evaluateSsoClaims,
  mapRoleNames,
  roleClaimIsObjectOfObjects,
} from './sso-role-mapping.js';

const AUTH_TIME_FRESH_MS = 5 * 60_000;
const AUTH_TIME_SKEW_MS = 60_000;
const MAX_CLAIM_NAMES = 64;
const DIAGNOSTIC_CODE = /^[a-z0-9_:.-]{1,64}$/;

function newResultId() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Normalized names at a path for display (capped by the D4 rules), or null. */
function displayNames(claims, segments) {
  if (!segments) return null;
  const names = claimNames(claims, segments);
  if (names.status === 'too_large') return { tooLarge: true };
  return names.status === 'ok' ? names.names : null;
}

function authTimeFacts(claims, nowMs) {
  const authTime = claims?.auth_time;
  const present = Number.isInteger(authTime) && authTime > 0;
  const fresh = present && nowMs - authTime * 1000 <= AUTH_TIME_FRESH_MS + AUTH_TIME_SKEW_MS;
  return { authTimePresent: present, authTimeFresh: fresh };
}

/**
 * The D8 display result for the owner's own claims against the draft mapping.
 * `passed` is true only when a role maps AND the tenant restriction holds.
 */
export function evaluateTestClaims(claims, draftRow, nowMs) {
  const mapping = buildSsoMapping(draftRow);
  const facts = authTimeFacts(claims, nowMs);
  const claimKeys = Object.keys(claims ?? {}).slice(0, MAX_CLAIM_NAMES);
  if (mapping === null) {
    return {
      passed: false,
      result: { claimNames: claimKeys, roleClaimValue: null, tenantClaimValue: null, mappedRole: null,
        tenantOk: false, ...facts, diagnostics: ['mapping_incomplete'] },
      shapeFlags: { roleClaimObjectOfObjects: false, ...facts },
    };
  }
  const roleNames = displayNames(claims, mapping.roleSegments);
  const decision = evaluateSsoClaims(claims, mapping);
  const mappedRole = Array.isArray(roleNames) ? mapRoleNames(roleNames, mapping.rules) : null;
  const tenantOk = decision.role !== null || (mapping.tenantMode === 'none' && mappedRole !== null);
  return {
    passed: decision.role !== null,
    result: {
      claimNames: claimKeys, roleClaimValue: roleNames,
      tenantClaimValue: displayNames(claims, mapping.tenantSegments), mappedRole, tenantOk, ...facts,
      diagnostics: decision.reason === null ? [] : [decision.reason],
    },
    shapeFlags: { roleClaimObjectOfObjects: roleClaimIsObjectOfObjects(claims, mapping), ...facts },
  };
}

function safeDiagnostics(diagnostics) {
  return diagnostics.filter((code) => typeof code === 'string' && DIAGNOSTIC_CODE.test(code));
}

/** One transaction: display row, optional apply proof, strict audit. Returns the display id. */
function writeEvidence(entry, { result, proof, nowMs }) {
  const db = getConnection();
  const id = newResultId();
  db.transaction(() => {
    sweepSsoTestEvidenceOn(db, nowMs);
    insertSsoTestResultOn(db, {
      id, ownerUserId: entry.ownerUserId, configHash: entry.configHash, resultJson: JSON.stringify(result), nowMs,
    });
    if (proof) {
      insertSsoApplyProofOn(db, {
        ownerUserId: entry.ownerUserId, configHash: entry.configHash, draftVersion: entry.draftVersion,
        kind: 'sign_in', passed: proof.passed, shapeFlags: proof.shapeFlags,
      }, nowMs);
    }
    auditLogRepository.recordStrictAuditOnConnection(db, 'sso_test_sign_in', {
      userId: entry.ownerUserId,
      metadata: { passed: proof?.passed === true, diagnostics: safeDiagnostics(result.diagnostics) },
    });
  }).immediate();
  return id;
}

/**
 * D2 step 6, `test` purpose: a completed sign-in against the draft. Writes the
 * display row and a `sign_in` apply proof (passed only when a role mapped and
 * the tenant restriction held). Terminal: returns the display id only.
 * @param {{ purpose: 'test', ownerUserId: number, configHash: string, draftVersion: number }} entry
 * @param {Record<string, unknown>} claims verified id_token claims (owner's own)
 * @param {{ draftRow: object, nowMs?: number }} context
 * @returns {{ resultId: string, passed: boolean }}
 */
export function completeTestSignIn(entry, claims, { draftRow, nowMs = Date.now() }) {
  if (entry?.purpose !== 'test') throw new Error('sso_test_entry_required');
  const evaluated = evaluateTestClaims(claims, draftRow, nowMs);
  const resultId = writeEvidence(entry, {
    result: evaluated.result, proof: { passed: evaluated.passed, shapeFlags: evaluated.shapeFlags }, nowMs,
  });
  return { resultId, passed: evaluated.passed };
}

/**
 * A `test` round trip that ended without verified claims (cancelled, OAuth
 * error, changed draft, verification failure). Display row only, no proof.
 * `oauthError` must already be a filtered RFC 6749 token or undefined.
 */
export function recordTestFailure(entry, { diagnostic, oauthError, nowMs = Date.now() }) {
  if (entry?.purpose !== 'test') throw new Error('sso_test_entry_required');
  const result = {
    claimNames: [], roleClaimValue: null, tenantClaimValue: null, mappedRole: null, tenantOk: false,
    authTimePresent: false, authTimeFresh: false, diagnostics: safeDiagnostics([diagnostic]),
    ...(typeof oauthError === 'string' ? { oauthError } : {}),
  };
  return { resultId: writeEvidence(entry, { result, proof: null, nowMs }) };
}

/**
 * One-time, owner-bound read of a display result (service half of
 * GET /api/settings/sso/draft/test-login/result/:id, S4). Null when absent,
 * expired, already read or owned by someone else.
 */
export function readTestResult(id, ownerUserId, nowMs = Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id) || !Number.isInteger(ownerUserId)) return null;
  const db = getConnection();
  const raw = db.transaction(() => consumeSsoTestResultOn(db, id, ownerUserId, nowMs)).immediate();
  return raw === null ? null : JSON.parse(raw);
}

/** Boot and periodic sweep of expired evidence. Never throws. */
export function sweepTestEvidence(nowMs = Date.now()) {
  try {
    sweepSsoTestEvidenceOn(getConnection(), nowMs);
    return true;
  } catch {
    process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'sso', code: 'sso_test_evidence_sweep_failed' })}\n`);
    return false;
  }
}
