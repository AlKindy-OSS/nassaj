/**
 * SSO attestation freshness for linked team accounts (T-1939 slice 3).
 *
 * A linked NON-OWNER member stays signed in only while their last successful
 * SSO login (user_identities.last_attested_at, stamped by the OIDC callback) is
 * younger than OIDC_ATTESTATION_MAX_AGE_HOURS. Past that window every nassaj
 * credential they hold — bearer JWT, auto-renewed token, grace refresh, device
 * session, WebSocket — is refused with `sso_reauth_required` until they sign in
 * at the IdP again. The owner (local break-glass) and accounts without an IdP
 * link are never governed; with OIDC off every account is "fresh".
 */
// Namespace import: tests replace the database module with partial mocks, and
// a named import of an absent binding would fail at link time.
import * as databaseModule from '../modules/database/index.js';

import { oidcEnabled } from './oidc-config.js';

/** Error code a client maps to "sign in again through SSO". */
export const SSO_REAUTH_REQUIRED_CODE = 'sso_reauth_required';

const HOUR_MS = 60 * 60 * 1000;
export const ATTESTATION_MAX_AGE_DEFAULT_HOURS = 12;
export const ATTESTATION_MAX_AGE_MIN_HOURS = 1;
export const ATTESTATION_MAX_AGE_MAX_HOURS = 24;

/**
 * Resolves the attestation window in ms from OIDC_ATTESTATION_MAX_AGE_HOURS.
 * Unset or not a finite number → 12h; otherwise clamped to 1..24h.
 * @param {string | undefined} [raw]
 * @returns {number}
 */
export function resolveAttestationMaxAgeMs(raw = process.env.OIDC_ATTESTATION_MAX_AGE_HOURS) {
  const parsed = raw === undefined || String(raw).trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return ATTESTATION_MAX_AGE_DEFAULT_HOURS * HOUR_MS;
  const hours = Math.min(ATTESTATION_MAX_AGE_MAX_HOURS, Math.max(ATTESTATION_MAX_AGE_MIN_HOURS, parsed));
  return hours * HOUR_MS;
}

/**
 * True when `user` may keep using a nassaj credential without re-attesting.
 * @param {{ id: number, role: string } | null | undefined} user
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function userSsoAttestationFresh(user, nowMs = Date.now()) {
  if (!user || user.role === 'owner' || !oidcEnabled()) return true;
  const { linkCount, latestAttestedAt } = databaseModule.userIdentitiesDb.attestationSummary(user.id);
  if (linkCount === 0) return true;
  if (!Number.isFinite(latestAttestedAt)) return false;
  return nowMs - latestAttestedAt <= resolveAttestationMaxAgeMs();
}

/**
 * Id-based form of userSsoAttestationFresh. An unknown or inactive account is
 * not governed here (the caller's own account check refuses it).
 * @param {number} userId
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function ssoAttestationFresh(userId, nowMs = Date.now()) {
  if (!oidcEnabled()) return true;
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
