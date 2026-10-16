/**
 * Read model of the owner SSO settings page (ADR-194 D8 `GET /`, T-1962 S4).
 *
 * Both slots are returned REDACTED: the ciphertext never leaves the server,
 * only `hasClientSecret`. Environment variables are listed by name only.
 * Counts cover non-owners only (the owner signs in locally and is never
 * governed by the identity provider).
 */
import { getConnection } from '../modules/database/connection.js';
import { identityCountsByIssuerOn, latestApplyProofOn } from '../modules/database/repositories/sso-apply.js';
import { disabledRecordPresentOn, readSlotOn } from '../modules/database/repositories/sso-oidc-config.js';

import {
  confirmedInstallationOrigin,
  ssoRedirectOriginStatus,
  ssoRedirectUriForDraft,
} from './installation-origin.service.js';
import { ssoApplyImpact } from './sso-apply.service.js';
import { ssoConfigInvalidReason } from './sso-config-record.js';
import { legacyEnvPresent, ssoForceOff, ssoState } from './sso-config.service.js';

const BASE_SCOPES = 'openid profile email';
const BACKCHANNEL_PATH = '/api/auth/oidc/backchannel-logout';

function parsedJson(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Fixed codes naming what a draft still lacks before it can be tested and applied. */
function draftMissing(row) {
  const missing = [];
  if (row.role_claim_path === '') missing.push('role_claim_path');
  if (parsedJson(row.role_rules_json, []).length === 0) missing.push('role_rules');
  if (row.client_auth !== 'none' && row.client_secret_enc === null) missing.push('client_secret');
  if (row.redirect_uri === null) missing.push('redirect_uri');
  if (row.pinned_endpoints_json === null) missing.push('pinned_endpoints');
  return missing;
}

/**
 * The API shape of one slot (camelCase), redacted. `null` when absent.
 * @param {import('../modules/database/repositories/sso-oidc-config.js').SsoOidcConfigRow | undefined} row
 */
export function ssoConfigView(row) {
  if (!row) return null;
  return {
    slot: row.slot, enabled: row.enabled === 1, issuer: row.issuer, clientId: row.client_id,
    clientAuth: row.client_auth, hasClientSecret: typeof row.client_secret_enc === 'string',
    secretVersion: row.secret_version, extraScopes: row.extra_scopes, redirectUri: row.redirect_uri,
    roleClaimPath: row.role_claim_path, roleRules: parsedJson(row.role_rules_json, []),
    tenantMode: row.tenant_mode, tenantClaimPath: row.tenant_claim_path,
    tenantValues: parsedJson(row.tenant_values_json, []), jitEnabled: row.jit_enabled === 1,
    attestationMaxAgeHours: row.attestation_max_age_hours, allowPrivateNetwork: row.allow_private_network === 1,
    issuerPort: row.issuer_port, pinnedEndpoints: parsedJson(row.pinned_endpoints_json, null),
    discoveryFlags: parsedJson(row.discovery_flags_json, null), runtimeFault: row.runtime_fault,
    configHash: row.config_hash, draftVersion: row.draft_version, version: row.version, updatedAt: row.updated_at,
    ...(row.slot === 'draft' ? { missing: draftMissing(row) } : { invalidReason: ssoConfigInvalidReason(row) }),
  };
}

function proofView(proof, draft) {
  if (!proof) return null;
  const current = draft !== undefined && proof.configHash === draft.config_hash
    && proof.draftVersion === draft.draft_version;
  return { passed: proof.passed, current, shapeFlags: proof.shapeFlags, createdAt: proof.createdAt };
}

function ourValues(draft) {
  const origin = confirmedInstallationOrigin();
  const extra = draft?.extra_scopes ? ` ${draft.extra_scopes}` : '';
  return {
    origin, originConfirmed: origin !== null, redirectUri: ssoRedirectUriForDraft(),
    backchannelLogoutUri: origin === null ? null : `${origin}${BACKCHANNEL_PATH}`, scopes: `${BASE_SCOPES}${extra}`,
  };
}

/** OIDC_* variable NAMES made irrelevant by an active row (D3); never their values. */
function ignoredEnvNames(active) {
  if (!active) return [];
  return Object.keys(process.env).filter((name) => name.startsWith('OIDC_')).sort();
}

/**
 * The full GET /api/settings/sso payload for `ownerUserId`.
 * @param {number} ownerUserId
 */
export function ssoSettingsStatus(ownerUserId) {
  const db = getConnection();
  const active = readSlotOn(db, 'active');
  const draft = readSlotOn(db, 'draft');
  return {
    ssoState: ssoState(), hostDisabled: ssoForceOff(), disabledRecord: disabledRecordPresentOn(db),
    legacyEnvPresent: legacyEnvPresent(), active: ssoConfigView(active), draft: ssoConfigView(draft),
    redirectOriginStatus: active ? ssoRedirectOriginStatus(active.redirect_uri) : null,
    ourValues: ourValues(draft),
    lastProofs: {
      discovery: proofView(latestApplyProofOn(db, ownerUserId, 'discovery'), draft),
      signIn: proofView(latestApplyProofOn(db, ownerUserId, 'sign_in'), draft),
    },
    ignoredEnv: ignoredEnvNames(active), identityCountsByIssuer: identityCountsByIssuerOn(db),
    applyImpact: ssoApplyImpact(),
  };
}
