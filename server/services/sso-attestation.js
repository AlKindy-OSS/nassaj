/**
 * SSO attestation freshness for linked team accounts (T-1939 slice 3).
 *
 * A linked NON-OWNER member stays signed in only while their last successful
 * SSO login (user_identities.last_attested_at, stamped by the OIDC callback) is
 * younger than the active SSO config's attestation window. Past it every nassaj
 * credential they hold — bearer JWT, auto-renewed token, grace refresh, device
 * session, WebSocket — is refused with `sso_reauth_required` until they sign in
 * at the IdP again. The owner (local break-glass) and accounts without an IdP
 * link are never governed; while the SSO policy is not enforced every account
 * is "fresh". Enforced but login unavailable (ADR-194 D1): a linked member
 * cannot re-attest, so they are stale until SSO works again.
 */
// Namespace import: tests replace the database module with partial mocks, and
// a named import of an absent binding would fail at link time.
import * as databaseModule from '../modules/database/index.js';

import { ssoAttestationPolicy, ssoPolicyEnforced } from './sso-config.service.js';

/** Error code a client maps to "sign in again through SSO". */
export const SSO_REAUTH_REQUIRED_CODE = 'sso_reauth_required';

export const ATTESTATION_MAX_AGE_DEFAULT_HOURS = 12;
export const ATTESTATION_MAX_AGE_MIN_HOURS = 1;
export const ATTESTATION_MAX_AGE_MAX_HOURS = 24;

/**
 * Whole hours from a legacy OIDC_ATTESTATION_MAX_AGE_HOURS value, for the
 * legacy env import only (runtime reads the active row, ADR-194 D6). Unset or
 * not a finite number → 12; a fraction is truncated; clamped to 1..24.
 * @param {string | undefined} raw
 * @returns {number}
 */
export function resolveLegacyAttestationHours(raw) {
  const parsed = raw === undefined || String(raw).trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return ATTESTATION_MAX_AGE_DEFAULT_HOURS;
  return Math.min(ATTESTATION_MAX_AGE_MAX_HOURS, Math.max(ATTESTATION_MAX_AGE_MIN_HOURS, Math.trunc(parsed)));
}

/**
 * True when `user` may keep using a nassaj credential without re-attesting.
 * @param {{ id: number, role: string } | null | undefined} user
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function userSsoAttestationFresh(user, nowMs = Date.now()) {
  if (!user || user.role === 'owner') return true;
  const policy = ssoAttestationPolicy();
  if (!policy.enforced) return true;
  const { linkCount, latestAttestedAt } = databaseModule.userIdentitiesDb.attestationSummary(user.id);
  if (linkCount === 0) return true;
  if (!policy.loginAvailable || !Number.isFinite(latestAttestedAt)) return false;
  return nowMs - latestAttestedAt <= policy.maxAgeMs;
}

/**
 * Id-based form of userSsoAttestationFresh. An unknown or inactive account is
 * not governed here (the caller's own account check refuses it).
 * @param {number} userId
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function ssoAttestationFresh(userId, nowMs = Date.now()) {
  if (!ssoPolicyEnforced()) return true;
  return userSsoAttestationFresh(databaseModule.userDb.getUserById(userId), nowMs);
}

/**
 * Answers a request whose linked account must re-attest at the IdP. 401 so the
 * credential is treated as spent; the code tells the SPA to start SSO rather
 * than show the plain login page.
 * @param {import('express').Response} res
 */
export function refuseStaleAttestation(res) {
  return res.status(401).set('Cache-Control', 'no-store').json({
    error: 'Sign in again through SSO',
    code: SSO_REAUTH_REQUIRED_CODE,
  });
}
