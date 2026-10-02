/**
 * Owner SSO draft writes (ADR-194 D3/D8, T-1962 S4): save and test-discovery.
 *
 *   saveSsoDraft          — validated full replace of the draft. The secret is
 *                           write-only (encrypted under the `draft` AAD); the
 *                           redirect URI is computed from the owner-confirmed
 *                           installation origin; pins and flags are cleared,
 *                           so every save needs a fresh test-discovery; every
 *                           save bumps `draft_version`, which invalidates
 *                           outstanding test sign-ins and apply proofs.
 *   testSsoDraftDiscovery — discovery + JWKS for the draft (I4). On success the
 *                           pinned endpoints and discovery flags are written
 *                           onto the draft (bumping `draft_version`) together
 *                           with a passed `discovery` apply proof for the new
 *                           hash and version.
 *
 * Each write and its strict audit share one immediate transaction. Logs and
 * audit metadata carry fixed codes only: never a secret, discovery body or
 * verbatim OAuth error.
 */
import { getConnection } from '../modules/database/connection.js';
// Namespace import: tests replace this repository with partial mocks, and a
// named import of an absent binding would fail at link time.
import * as auditLogRepository from '../modules/database/repositories/audit-log.js';
import { draftFieldsOf, readSlotOn, upsertDraftOn } from '../modules/database/repositories/sso-oidc-config.js';
import { insertSsoApplyProofOn } from '../modules/database/repositories/sso-test-evidence.js';
import { encryptSsoClientSecret } from '../modules/database/sso-secret-envelope.js';
import { safeOauthError } from '../modules/net/pinned-fetch.js';

import { ssoRedirectUriForDraft } from './installation-origin.service.js';
import { computeSsoConfigHash } from './sso-config-record.js';
import { draftNeedsStepUp } from './sso-draft-input.js';
import { discoverDraftEndpoints } from './sso-oidc-runtime.service.js';
import { SsoSettingsError } from './sso-settings-error.js';

const FAILURE_CODE = /^[a-z0-9_:.-]{1,64}$/;

function log(level, code, fields = {}) {
  process.stderr.write(`${JSON.stringify({ level, scope: 'sso', code, ...fields })}\n`);
}

function encryptDraftSecret(plaintext, input) {
  try {
    return encryptSsoClientSecret(plaintext, { slot: 'draft', issuer: input.issuer, clientId: input.clientId });
  } catch {
    throw new SsoSettingsError('sso_secret_key_unavailable', 503);
  }
}

/**
 * D3 write-only secret: a new value replaces, `clearClientSecret` clears, an
 * omitted value is kept only while issuer and client id (its AAD) are
 * unchanged. Any replace or clear bumps `secret_version`.
 */
function nextSecret(previous, input) {
  const had = typeof previous?.client_secret_enc === 'string';
  const version = previous?.secret_version ?? 0;
  let enc = null;
  if (input.clientAuth !== 'none' && typeof input.clientSecret === 'string') {
    return { enc: encryptDraftSecret(input.clientSecret, input), secretVersion: version + 1, changed: true };
  }
  const sameBinding = previous?.issuer === input.issuer && previous?.client_id === input.clientId;
  if (input.clientAuth !== 'none' && !input.clearClientSecret && sameBinding && had) enc = previous.client_secret_enc;
  const changed = had && enc === null;
  return { enc, secretVersion: changed ? version + 1 : version, changed };
}

function draftFields(input, secret) {
  const fields = {
    issuer: input.issuer, client_id: input.clientId, client_auth: input.clientAuth,
    client_secret_enc: secret.enc, secret_version: secret.secretVersion, extra_scopes: input.extraScopes,
    redirect_uri: ssoRedirectUriForDraft(), role_claim_path: input.roleClaimPath,
    role_rules_json: input.roleRulesJson, tenant_mode: input.tenantMode, tenant_claim_path: input.tenantClaimPath,
    tenant_values_json: input.tenantValuesJson, jit_enabled: input.jitEnabled,
    attestation_max_age_hours: input.hours, allow_private_network: input.allowPrivateNetwork,
    issuer_port: input.issuerPort, pinned_endpoints_json: null, discovery_flags_json: null,
  };
  return { ...fields, config_hash: computeSsoConfigHash(fields) };
}

function assertExpectedVersion(previous, expected) {
  if (expected !== undefined && (previous?.draft_version ?? 0) !== expected) {
    throw new SsoSettingsError('sso_draft_changed', 409);
  }
}

/**
 * Saves the draft. `stepUpVerified` must be true when the write needs step-up
 * (I5); the requirement is re-checked inside the transaction against the row
 * actually being replaced.
 * @param {{ actorUserId: number, input: ReturnType<typeof import('./sso-draft-input.js').parseSsoDraftInput>,
 *   stepUpVerified: boolean, nowMs?: number }} params
 * @returns {object} the stored draft row
 */
export function saveSsoDraft({ actorUserId, input, stepUpVerified, nowMs = Date.now() }) {
  const db = getConnection();
  return db.transaction(() => {
    const previous = readSlotOn(db, 'draft');
    assertExpectedVersion(previous, input.expectedDraftVersion);
    if (draftNeedsStepUp(previous, input) && stepUpVerified !== true) {
      throw new SsoSettingsError('step_up_required', 403);
    }
    const secret = nextSecret(previous, input);
    const fields = draftFields(input, secret);
    upsertDraftOn(db, fields, actorUserId, nowMs);
    const saved = readSlotOn(db, 'draft');
    auditLogRepository.recordStrictAuditOnConnection(db, 'sso_draft_saved', {
      userId: actorUserId,
      metadata: {
        draftVersion: saved.draft_version, secretChanged: secret.changed,
        privateNetwork: fields.allow_private_network === 1, issuerPortSet: fields.issuer_port !== null,
      },
    });
    return saved;
  }).immediate();
}

// Address categories the `private_allowed` policy admits (D7): only these can be
// fixed by allowing private networks; every other blocked category never can.
const PRIVATE_ALLOWABLE_CATEGORIES = new Set(['private', 'cgnat', 'ula']);
const ADDRESS_BLOCKED_PREFIX = 'fetch_address_blocked:';

/**
 * Owner-facing failure for a thrown discovery fetch: the typed pinnedFetchJson
 * code when the transport produced one (never a body), with an address block
 * split into `fetch_address_private` (allowing private networks would help)
 * and `fetch_address_blocked` (never reachable), plus the stage that failed.
 */
export function discoveryFailureOf(error, row) {
  const stage = typeof error?.code === 'string' && FAILURE_CODE.test(error.code) ? error.code : 'discovery_unavailable';
  const fetchCode = typeof error?.fetchCode === 'string' ? error.fetchCode : null;
  if (fetchCode === null) return { failure: stage, failureStage: stage, privateNetworkMayHelp: false };
  if (!fetchCode.startsWith(ADDRESS_BLOCKED_PREFIX)) {
    return { failure: fetchCode, failureStage: stage, privateNetworkMayHelp: false };
  }
  const category = fetchCode.slice(ADDRESS_BLOCKED_PREFIX.length);
  const allowable = PRIVATE_ALLOWABLE_CATEGORIES.has(category);
  return {
    failure: allowable ? 'fetch_address_private' : 'fetch_address_blocked', failureStage: stage,
    addressCategory: category, privateNetworkMayHelp: allowable && row.allow_private_network !== 1,
  };
}

/** The fetch half of test-discovery: fixed failure codes (and a filtered OAuth error) or the inspection. */
async function runDiscovery(row) {
  try {
    return { ...(await discoverDraftEndpoints(row)), privateNetworkMayHelp: false };
  } catch (error) {
    const oauthError = safeOauthError({ error: error?.oauthError }) ?? undefined;
    if (oauthError !== undefined) log('warn', 'sso_discovery_oauth_error', { oauth_error_present: true });
    return { ...discoveryFailureOf(error, row), endpoints: null, flags: null, warnings: [], jwksKeyCount: 0, oauthError };
  }
}

function pinnedDraftFields(row, inspection) {
  const { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint, jwks_uri: jwksUri } =
    inspection.endpoints;
  const fields = {
    ...draftFieldsOf(row),
    pinned_endpoints_json: JSON.stringify({
      authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint, jwks_uri: jwksUri,
    }),
    discovery_flags_json: JSON.stringify(inspection.flags),
  };
  return { ...fields, config_hash: computeSsoConfigHash(fields) };
}

/** Writes the outcome; refuses when the draft moved while the fetch ran. */
function recordDiscovery(db, { actorUserId, snapshot, inspection, nowMs }) {
  const current = readSlotOn(db, 'draft');
  if (!current || current.draft_version !== snapshot.draft_version || current.config_hash !== snapshot.config_hash) {
    throw new SsoSettingsError('sso_draft_changed', 409);
  }
  const passed = inspection.failure === null;
  let bound = current;
  if (passed) {
    upsertDraftOn(db, pinnedDraftFields(current, inspection), actorUserId, nowMs);
    bound = readSlotOn(db, 'draft');
  }
  insertSsoApplyProofOn(db, {
    ownerUserId: actorUserId, configHash: bound.config_hash, draftVersion: bound.draft_version,
    kind: 'discovery', passed, shapeFlags: null,
  }, nowMs);
  auditLogRepository.recordStrictAuditOnConnection(db, 'sso_discovery_tested', {
    userId: actorUserId,
    metadata: { passed, failure: inspection.failure, stage: inspection.failureStage ?? null, warnings: inspection.warnings },
  });
  return bound;
}

/**
 * D8 test-discovery. Returns the per-step result and the stored draft.
 * @param {{ actorUserId: number, nowMs?: number }} params
 */
export async function testSsoDraftDiscovery({ actorUserId, nowMs = Date.now() }) {
  const db = getConnection();
  const snapshot = readSlotOn(db, 'draft');
  if (!snapshot) throw new SsoSettingsError('sso_draft_missing', 404);
  const inspection = await runDiscovery(snapshot);
  const draft = db.transaction(() => recordDiscovery(db, { actorUserId, snapshot, inspection, nowMs })).immediate();
  return {
    passed: inspection.failure === null, failure: inspection.failure, warnings: inspection.warnings,
    failureStage: inspection.failureStage ?? null, addressCategory: inspection.addressCategory ?? null,
    privateNetworkMayHelp: inspection.privateNetworkMayHelp, endpoints: inspection.endpoints, flags: inspection.flags,
    jwksKeyCount: inspection.jwksKeyCount, ...(inspection.oauthError ? { oauthError: inspection.oauthError } : {}), draft,
  };
}
