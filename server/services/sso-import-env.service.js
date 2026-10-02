/**
 * Legacy env import (ADR-194 D3, T-1962 S1): pre-fills the SSO draft from the
 * OIDC_* variables of an env-configured node. Service half of
 * POST /api/settings/sso/import-env (the HTTP route, owner gate and rate limit
 * are S4). The draft is never applied here, so nothing it writes can sign
 * anyone in; the owner still enters the role claim path, tests and applies.
 *
 * Field list: issuer byte-identical; client id; public PKCE client; JIT from
 * OIDC_JIT_ENABLED; attestation hours clamped 1–24 (default 12); default rules
 * admin→admin, member→user, viewer→user; OIDC_ALLOWED_ORG_IDS as
 * `role_grant_scope` tenant values (`none` when empty). Private network is
 * never set by import. A differing OIDC_REDIRECT_URI is reported so the owner
 * updates the IdP registration.
 */
import { getConnection } from '../modules/database/connection.js';
import { recordStrictAuditOnConnection } from '../modules/database/repositories/audit-log.js';
import { readActiveVersionOn, readSlotOn, upsertDraftOn } from '../modules/database/repositories/sso-oidc-config.js';

import { computeSsoConfigHash, redactSsoConfigRow, SSO_CALLBACK_PATH } from './sso-config-record.js';
import { resolveLegacyAttestationHours } from './sso-attestation.js';

export const LEGACY_DEFAULT_ROLE_RULES = Object.freeze([
  Object.freeze({ value: 'admin', role: 'admin' }),
  Object.freeze({ value: 'member', role: 'user' }),
  Object.freeze({ value: 'viewer', role: 'user' }),
]);

const MAX_ENV_VALUE_LENGTH = 2048;
const LEGACY_ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The legacy comma-separated OIDC_ALLOWED_ORG_IDS list as unique tenant
 * values; malformed entries are dropped.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseLegacyOrgIds(raw) {
  if (typeof raw !== 'string') return [];
  const ids = raw.split(',').map((entry) => entry.trim()).filter((entry) => LEGACY_ORG_ID_PATTERN.test(entry));
  return [...new Set(ids)];
}

export class SsoImportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SsoImportError';
    this.code = code;
  }
}

function envString(env, name) {
  const raw = env[name];
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_ENV_VALUE_LENGTH ? raw : null;
}

/** `<origin>/api/auth/oidc/callback` from an owner-confirmed origin, or null when it is not a bare origin. */
export function computeRedirectUri(installationOrigin) {
  if (typeof installationOrigin !== 'string') return null;
  try {
    const parsed = new URL(installationOrigin);
    return parsed.origin === installationOrigin ? `${parsed.origin}${SSO_CALLBACK_PATH}` : null;
  } catch {
    return null;
  }
}

function redirectWarnings(env, redirectUri) {
  if (redirectUri === null) return [{ code: 'installation_origin_unconfirmed' }];
  const legacy = envString(env, 'OIDC_REDIRECT_URI');
  return legacy !== null && legacy !== redirectUri
    ? [{ code: 'redirect_uri_mismatch', legacyRedirectUri: legacy, redirectUri }]
    : [];
}

/**
 * Pure mapping from env to draft fields (no secret: import is a public client).
 * Throws SsoImportError('legacy_env_incomplete') without issuer and client id.
 */
export function buildDraftFromLegacyEnv(env, { installationOrigin, secretVersion = 0 }) {
  const issuer = envString(env, 'OIDC_ISSUER_URL');
  const clientId = envString(env, 'OIDC_CLIENT_ID');
  if (issuer === null || clientId === null) throw new SsoImportError('legacy_env_incomplete');
  const orgs = parseLegacyOrgIds(env.OIDC_ALLOWED_ORG_IDS);
  const redirectUri = computeRedirectUri(installationOrigin);
  const fields = {
    issuer, client_id: clientId, client_auth: 'none', client_secret_enc: null, secret_version: secretVersion,
    extra_scopes: '', redirect_uri: redirectUri, role_claim_path: '',
    role_rules_json: JSON.stringify(LEGACY_DEFAULT_ROLE_RULES),
    tenant_mode: orgs.length > 0 ? 'role_grant_scope' : 'none', tenant_claim_path: null,
    tenant_values_json: JSON.stringify(orgs), jit_enabled: env.OIDC_JIT_ENABLED === 'true' ? 1 : 0,
    attestation_max_age_hours: resolveLegacyAttestationHours(env.OIDC_ATTESTATION_MAX_AGE_HOURS),
    allow_private_network: 0, issuer_port: null, pinned_endpoints_json: null, discovery_flags_json: null,
  };
  return { fields: { ...fields, config_hash: computeSsoConfigHash(fields) }, warnings: redirectWarnings(env, redirectUri) };
}

/** A cleared secret bumps secret_version (D3); an absent one keeps it. */
function nextSecretVersion(previous) {
  if (!previous) return 0;
  return previous.client_secret_enc === null ? previous.secret_version : previous.secret_version + 1;
}

/**
 * Writes the imported draft (bumping draft_version) with a strict audit in one
 * immediate transaction. Refused once an active row exists: from then on the
 * OIDC_* env is ignored (D3).
 * @param {{ actorUserId: number, installationOrigin: string | null,
 *           env?: NodeJS.ProcessEnv, nowMs?: number }} input
 */
export function importLegacyEnvToDraft({ actorUserId, installationOrigin, env = process.env, nowMs = Date.now() }) {
  const db = getConnection();
  return db.transaction(() => {
    if (readActiveVersionOn(db) !== null) throw new SsoImportError('sso_active_config_exists');
    const secretVersion = nextSecretVersion(readSlotOn(db, 'draft'));
    const { fields, warnings } = buildDraftFromLegacyEnv(env, { installationOrigin, secretVersion });
    upsertDraftOn(db, fields, actorUserId, nowMs);
    recordStrictAuditOnConnection(db, 'sso_legacy_env_imported', {
      userId: actorUserId, metadata: { warnings: warnings.map((warning) => warning.code) },
    });
    return { draft: redactSsoConfigRow(readSlotOn(db, 'draft')), warnings };
  }).immediate();
}
