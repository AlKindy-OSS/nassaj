/**
 * Relying-party runtime over the SSO configuration rows (ADR-194 D2/D3/D9,
 * T-1962 S3). Routes never read OIDC_* env for sign-in; they ask this module.
 *
 *   activeSsoClient()      — the active row's client (issuer, client id, pinned
 *                            redirect URI, scope, discovery flags, mapping,
 *                            verifier) while SSO login is available; null
 *                            otherwise. Verifier cache key: issuer|client|version.
 *   draftSsoClient(entry)  — the draft's client for a `test` PKCE entry, after
 *                            the hash, draft-version and owner bindings hold.
 *                            Separate cache keyed by config_hash. No discovery.
 *   backchannelSsoVerifier — the D1 back-channel column: active or broken row
 *                            verify with the row's issuer, client id and pinned
 *                            jwks_uri (never a fresh discovery); legacy env uses
 *                            discovery under the `public` policy; else 503.
 *   runUnderVersionFence   — N1: the version check and the privileged writes
 *                            share ONE immediate transaction.
 *
 * Secrets: a confidential client's secret is decrypted inside the verifier's
 * token request only (AAD slot `active` or `draft`); nothing here caches it.
 */
import { getConnection } from '../modules/database/connection.js';
// Namespace import: tests replace this repository with partial mocks, and a
// named import of an absent binding would fail at link time.
import * as auditLogRepository from '../modules/database/repositories/audit-log.js';
import {
  readActiveVersionOn,
  readSlotOn,
  recordActiveRuntimeFaultOn,
} from '../modules/database/repositories/sso-oidc-config.js';
import { decryptSsoClientSecret } from '../modules/database/sso-secret-envelope.js';

import { createOidcVerifier } from './oidc-verifier.service.js';
import { computeSsoConfigHash, pinnedEndpointsValid, redirectUriValid } from './sso-config-record.js';
import { ssoRuntimeState } from './sso-config.service.js';
import { buildSsoMapping } from './sso-role-mapping.js';

export const DISCOVERY_ENDPOINT_CHANGED = 'discovery_endpoint_changed';
export const SSO_FENCE_REFUSED = Symbol('sso_fence_refused');
const BASE_SCOPES = 'openid profile email';
const MAX_DRAFT_VERIFIERS = 4;

/** Test seam: network options merged into every verifier (pinnedFetchJson dependencies). */
let networkOverrides = {};
/** @type {{ key: string, verifier: ReturnType<typeof createOidcVerifier> } | null} */
let activeCache = null;
/** @type {Map<string, ReturnType<typeof createOidcVerifier>>} config_hash → verifier */
const draftCache = new Map();
/** @type {{ key: string, verifier: ReturnType<typeof createOidcVerifier> } | null} */
let backchannelCache = null;

function log(level, code, fields = {}) {
  process.stderr.write(`${JSON.stringify({ level, scope: 'sso', code, ...fields })}\n`);
}

function parseJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** D7: `private_allowed` only with allow_private_network = 1, and then 443 or the row's port. */
function networkFor(row) {
  const privateAllowed = row.allow_private_network === 1;
  return {
    ...networkOverrides,
    addressPolicy: privateAllowed ? 'private_allowed' : 'public',
    allowedPort: privateAllowed && Number.isInteger(row.issuer_port) ? row.issuer_port : undefined,
  };
}

function scopeFor(row) {
  return row.extra_scopes ? `${BASE_SCOPES} ${row.extra_scopes}` : BASE_SCOPES;
}

/** A pinned verifier for one row; `onDrift` persists the D3 runtime fault (active only). */
function buildRowVerifier(row, slot, onDrift) {
  return createOidcVerifier({
    issuer: row.issuer,
    clientId: row.client_id,
    clientAuth: row.client_auth,
    readClientSecret: row.client_auth === 'none' ? undefined
      : () => decryptSsoClientSecret(row.client_secret_enc, { slot, issuer: row.issuer, clientId: row.client_id }),
    endpoints: parseJsonObject(row.pinned_endpoints_json),
    network: networkFor(row),
    onDiscoveryDrift: onDrift,
  });
}

function clientView(row, { slot, version, mapping, verifier }) {
  return Object.freeze({
    slot, version, issuer: row.issuer, clientId: row.client_id, redirectUri: row.redirect_uri,
    scope: scopeFor(row), discoveryFlags: Object.freeze(parseJsonObject(row.discovery_flags_json) ?? {}),
    mapping, verifier,
  });
}

/**
 * Persists `runtime_fault` on the active row for the version the verifier was
 * built from (CAS), with a strict audit. Best effort: a failure is logged and
 * the request that saw the drift is refused anyway.
 */
export function recordDiscoveryDrift(version, nowMs = Date.now()) {
  try {
    const db = getConnection();
    const recorded = db.transaction(() => {
      if (!recordActiveRuntimeFaultOn(db, DISCOVERY_ENDPOINT_CHANGED, version, nowMs)) return false;
      auditLogRepository.recordStrictAuditOnConnection(db, 'sso_runtime_fault_recorded', {
        userId: null, metadata: { fault: DISCOVERY_ENDPOINT_CHANGED },
      });
      return true;
    }).immediate();
    if (recorded) log('warn', 'sso_runtime_fault_recorded', { fault: DISCOVERY_ENDPOINT_CHANGED });
    return recorded;
  } catch {
    log('warn', 'sso_runtime_fault_record_failed');
    return false;
  }
}

/** The active client while SSO login is available, else null. Never throws. */
export function activeSsoClient() {
  try {
    const state = ssoRuntimeState();
    if (!state.loginAvailable || state.snapshot === null) return null;
    const { row, version, mapping } = state.snapshot;
    const key = `${row.issuer}|${row.client_id}|${version}`;
    if (activeCache?.key !== key) {
      activeCache = { key, verifier: buildRowVerifier(row, 'active', () => recordDiscoveryDrift(version)) };
    }
    return clientView(row, { slot: 'active', version, mapping, verifier: activeCache.verifier });
  } catch {
    log('warn', 'sso_active_client_unavailable');
    return null;
  }
}

/** Fresh `SELECT version` of the active row (null when absent). Throws on read failure. */
export function currentActiveVersion() {
  return readActiveVersionOn(getConnection());
}

/** Post-mint re-check (D9): true only when the active version still equals `configVersion`. */
export function activeVersionStillIs(configVersion) {
  try {
    return Number.isInteger(configVersion) && currentActiveVersion() === configVersion;
  } catch {
    return false;
  }
}

/**
 * N1 version fence: re-reads `version` and runs `work` in ONE immediate
 * transaction, so a concurrent apply serializes against the privileged
 * writes. Returns SSO_FENCE_REFUSED (nothing written) on mismatch; a throw
 * inside `work` rolls everything back and propagates.
 */
export function runUnderVersionFence(configVersion, work) {
  const db = getConnection();
  return db.transaction(() => (
    Number.isInteger(configVersion) && readActiveVersionOn(db) === configVersion ? work() : SSO_FENCE_REFUSED
  )).immediate();
}

function activeOwner(db, userId) {
  return Number.isInteger(userId) && db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'owner'
    AND is_active = 1 AND status = 'active'`).get(userId) !== undefined;
}

function draftRefusal(row, entry, db) {
  if (!row || row.draft_version !== entry.draftVersion || row.config_hash !== entry.configHash
    || computeSsoConfigHash(row) !== entry.configHash) return 'sso_test_config_changed';
  if (!activeOwner(db, entry.ownerUserId)) return 'sso_test_owner_invalid';
  if (!pinnedEndpointsValid(row.pinned_endpoints_json) || !redirectUriValid(row.redirect_uri)) {
    return 'sso_test_discovery_required';
  }
  return null;
}

function draftVerifierFor(row) {
  let verifier = draftCache.get(row.config_hash);
  if (!verifier) {
    verifier = buildRowVerifier(row, 'draft', undefined);
    if (draftCache.size >= MAX_DRAFT_VERIFIERS) draftCache.delete(draftCache.keys().next().value);
    draftCache.set(row.config_hash, verifier);
  }
  return verifier;
}

/**
 * D2 step 3, `test` purpose: the draft client when the entry's bindings still
 * hold (same hash and draft_version, owner still an active owner, pins and
 * redirect present). No discovery fetch. `{ refusal }` otherwise.
 * @returns {{ client: object, draftRow: object } | { refusal: string }}
 */
export function draftSsoClient(entry) {
  try {
    const db = getConnection();
    const row = readSlotOn(db, 'draft');
    const refusal = draftRefusal(row, entry, db);
    if (refusal !== null) return { refusal };
    const client = clientView(row, {
      slot: 'draft', version: row.draft_version, mapping: buildSsoMapping(row), verifier: draftVerifierFor(row),
    });
    return { client, draftRow: Object.freeze({ ...row }) };
  } catch {
    return { refusal: 'sso_test_config_invalid' };
  }
}

/**
 * D8 test-discovery fetch for a draft row (S4): discovery and JWKS under the
 * row's own address policy and port, never through pins (there are none yet),
 * and never touching the verifier caches. The secret is not needed for
 * discovery, so a confidential client gets a reader that refuses.
 * @returns {Promise<{ failure: string | null, endpoints: object | null, flags: object | null,
 *   warnings: string[], jwksKeyCount: number }>} throws OidcVerificationError on a fetch failure
 */
export async function discoverDraftEndpoints(row) {
  const verifier = createOidcVerifier({
    issuer: row.issuer,
    clientId: row.client_id,
    clientAuth: row.client_auth,
    readClientSecret: row.client_auth === 'none' ? undefined : () => { throw new Error('secret_not_needed'); },
    endpoints: null,
    network: networkFor(row),
  });
  return verifier.fetchDiscoveryForPinning();
}

/**
 * The draft row and hash a test entry must bind at start (S4 start route), or
 * `{ refusal }`: `sso_test_discovery_required` until test-discovery pinned the
 * endpoints and a redirect URI is stored.
 */
export function draftTestBinding() {
  const row = readSlotOn(getConnection(), 'draft');
  if (!row || computeSsoConfigHash(row) !== row.config_hash) return { refusal: 'sso_test_config_invalid' };
  if (!pinnedEndpointsValid(row.pinned_endpoints_json) || !redirectUriValid(row.redirect_uri)) {
    return { refusal: 'sso_test_discovery_required' };
  }
  return { configHash: row.config_hash, draftVersion: row.draft_version };
}

function cachedBackchannel(key, build) {
  if (backchannelCache?.key !== key) backchannelCache = { key, verifier: build() };
  return backchannelCache.verifier;
}

/** Verify-only verifier from a (possibly broken) row: issuer, client id and pinned jwks_uri. */
function rowBackchannelVerifier(row) {
  const pins = parseJsonObject(row.pinned_endpoints_json);
  const key = `row|${row.issuer}|${row.client_id}|${pins?.jwks_uri}|${row.version}`;
  return cachedBackchannel(key, () => createOidcVerifier({
    issuer: row.issuer, clientId: row.client_id, endpoints: { jwks_uri: pins?.jwks_uri }, network: networkFor(row),
  }));
}

function legacyBackchannelVerifier() {
  const issuer = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  return cachedBackchannel(`legacy|${issuer}|${clientId}`, () => createOidcVerifier({
    issuer, clientId, network: { ...networkOverrides, addressPolicy: 'public', allowedPort: undefined },
  }));
}

/**
 * D1 back-channel column. `{ status: 501 }` when the policy is not enforced;
 * `{ status: 503 }` when nothing verifiable is configured (unreadable state,
 * unparseable row or env); otherwise `{ verifier, issuer }`.
 */
export function backchannelSsoVerifier() {
  const state = ssoRuntimeState();
  if (!state.enforced) return { status: 501 };
  if (state.readFailed) return { status: 503 };
  try {
    if (state.snapshot !== null) {
      const verifier = rowBackchannelVerifier(state.snapshot.row);
      return { verifier, issuer: verifier.issuer };
    }
    if (state.legacy) {
      const verifier = legacyBackchannelVerifier();
      return { verifier, issuer: verifier.issuer };
    }
  } catch {
    return { status: 503 };
  }
  return { status: 503 };
}

/**
 * Test seam: network options (e.g. a pinnedFetchJson transport and resolver
 * standing in for the IdP) for every verifier built afterwards; also drops
 * every cached verifier.
 */
export function setSsoNetworkOverridesForTests(overrides = {}) {
  networkOverrides = { ...overrides };
  activeCache = null;
  backchannelCache = null;
  draftCache.clear();
}
