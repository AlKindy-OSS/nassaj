/**
 * SSO state model (ADR-194 D1, T-1962 S1). Two predicates replace the old
 * env-only switch:
 *
 *   ssoLoginAvailable()  — an SSO round trip can work right now: a valid,
 *                          enabled, fault-free active row whose secret (if
 *                          any) decrypts. Gates the routes that START or
 *                          FINISH a sign-in, JIT, and the SPA button.
 *   ssoPolicyEnforced()  — linked members are governed by SSO: their local
 *                          credentials are refused, invites are closed, and
 *                          their attestation must be fresh. ON whenever a
 *                          non-owner holds a link, the active row is enabled,
 *                          or legacy env is present — unless the owner (or the
 *                          FORCE_OFF boot transition) wrote `sso.disabled`.
 *
 * Fail closed: any exception while evaluating enforces the policy and makes
 * login unavailable. The owner is local-only and never governed here.
 *
 * Hot reload: every evaluation runs a prepared `SELECT version` and reloads the
 * active snapshot only when the version moved (D3). Secret decryptability is
 * computed once per active version and secret version, never per request.
 */
import { getConnection } from '../modules/database/connection.js';
import {
  anySsoRowExistsOn,
  disabledRecordPresentOn,
  nonOwnerLinkExistsOn,
  readActiveVersionOn,
  readSlotOn,
} from '../modules/database/repositories/sso-oidc-config.js';
import { decryptSsoClientSecret } from '../modules/database/sso-secret-envelope.js';
import { setApiKeySsoUnavailableGate } from '../modules/database/repositories/api-key-sso-gate.js';

import { ssoConfigInvalidReason } from './sso-config-record.js';
import { buildSsoMapping } from './sso-role-mapping.js';

export const SSO_FORCE_OFF_ENV = 'NASSAJ_SSO_FORCE_OFF';
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_ATTESTATION_HOURS = 12;

/** Last loaded active row: { version, row, invalidReason, mapping }. */
let snapshot = null;
/** `${version}:${secretVersion}` → decryptable, for the current active row only. */
let decryptability = { key: null, ok: false };
const loggedCodes = new Set();

function warnOnce(code, fields = {}) {
  if (loggedCodes.has(code)) return;
  loggedCodes.add(code);
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'sso', code, ...fields })}\n`);
}

/** Host-level kill switch (D1). */
export function ssoForceOff() {
  return process.env[SSO_FORCE_OFF_ENV] === '1';
}

function legacyEnvFlag() {
  return process.env.OIDC_ENABLED === 'true';
}

/** The active snapshot, reloaded only when the per-call version read moved. Throws on read failure. */
function activeSnapshot(db) {
  const version = readActiveVersionOn(db);
  if (version === null) {
    snapshot = null;
    return null;
  }
  if (snapshot !== null && snapshot.version === version) return snapshot;
  const row = readSlotOn(db, 'active');
  if (!row) {
    snapshot = null;
    return null;
  }
  const invalidReason = ssoConfigInvalidReason(row);
  const mapping = invalidReason === null ? buildSsoMapping(row) : null;
  snapshot = Object.freeze({ version: row.version, row: Object.freeze({ ...row }), invalidReason, mapping });
  if (invalidReason !== null) {
    process.stderr.write(`${JSON.stringify({
      level: 'warn', scope: 'sso', code: 'sso_active_config_invalid', reason: invalidReason,
    })}\n`);
  }
  return snapshot;
}

/** Decrypts the active secret once per (version, secret_version); the plaintext is discarded. */
function secretDecryptable(snap) {
  const { row } = snap;
  if (row.client_auth === 'none') return true;
  const key = `${snap.version}:${row.secret_version}`;
  if (decryptability.key === key) return decryptability.ok;
  let ok = false;
  try {
    decryptSsoClientSecret(row.client_secret_enc, { slot: 'active', issuer: row.issuer, clientId: row.client_id });
    ok = true;
  } catch {
    warnOnce(`sso_secret_undecryptable:${key}`, { code: 'sso_secret_undecryptable' });
  }
  decryptability = { key, ok };
  return ok;
}

function loginAvailableFor(snap) {
  if (snap === null || snap.row.enabled !== 1 || snap.invalidReason !== null || snap.mapping === null) return false;
  if (snap.row.runtime_fault !== null) return false;
  return secretDecryptable(snap);
}

const OFF = Object.freeze({ enforced: false, loginAvailable: false, legacy: false, snapshot: null });

/** One evaluation pass over every D1 input. Throws on any read failure. */
function evaluateUnsafe() {
  const db = getConnection();
  const forceOff = ssoForceOff();
  // FORCE_OFF lifts enforcement only once its boot transition (revocation +
  // record) has committed; until then the normal, stricter rule applies.
  if (disabledRecordPresentOn(db)) return OFF;
  const snap = activeSnapshot(db);
  const legacy = snap === null && legacyEnvFlag();
  const loginAvailable = !forceOff && loginAvailableFor(snap);
  const enforced = snap?.row.enabled === 1 || legacy || nonOwnerLinkExistsOn(db);
  return { enforced, loginAvailable, legacy, snapshot: snap };
}

/** Fail-closed evaluation: a read failure enforces and makes login unavailable. */
function evaluate() {
  try {
    const state = evaluateUnsafe();
    loggedCodes.delete('sso_state_read_failed');
    return state;
  } catch {
    warnOnce('sso_state_read_failed');
    return { enforced: true, loginAvailable: false, legacy: false, snapshot: null, readFailed: true };
  }
}

// ADR-194 D6: while SSO is enforced and login is unavailable (unavailable,
// paused or a read failure, which evaluate() turns into enforced), linked
// non-owners' API keys are refused by the shared key clause.
setApiKeySsoUnavailableGate(() => {
  const state = evaluate();
  return state.enforced && !state.loginAvailable;
});

/** D1: linked non-owners are governed by SSO. Any exception → true. */
export function ssoPolicyEnforced() {
  return evaluate().enforced;
}

/** D1: an SSO round trip can work right now. Any exception → false. */
export function ssoLoginAvailable() {
  return evaluate().loginAvailable;
}

/**
 * D1 `legacyEnvPresent`: OIDC_ENABLED=true, the active-row read succeeded and
 * found no row. A failed read is NOT legacy (the exception rule enforces).
 */
export function legacyEnvPresent() {
  if (!legacyEnvFlag()) return false;
  try {
    return readActiveVersionOn(getConnection()) === null;
  } catch {
    return false;
  }
}

/**
 * D1 caller table, connector origin proposal: OIDC_REDIRECT_URI may seed the
 * installation-origin proposal only on a legacy env node with NO SSO row at
 * all (draft or active). A read failure answers false (never read the env).
 */
export function ssoLegacyRedirectProposalAllowed() {
  if (!legacyEnvFlag()) return false;
  try {
    return !anySsoRowExistsOn(getConnection());
  } catch {
    return false;
  }
}

/**
 * One fail-closed evaluation for the relying party (S3): the predicates plus
 * the active snapshot they were computed from, so a caller selects the
 * verifier, mapping and version from the SAME read.
 * @returns {{ enforced: boolean, loginAvailable: boolean, legacy: boolean, readFailed: boolean,
 *   snapshot: { version: number, row: object, invalidReason: string | null, mapping: object | null } | null }}
 */
export function ssoRuntimeState() {
  const state = evaluate();
  return Object.freeze({ ...state, readFailed: state.readFailed === true });
}

/** Public state for the status route and the SPA: 'off' | 'active' | 'unavailable' | 'paused'. */
export function ssoState() {
  const state = evaluate();
  if (state.loginAvailable) return 'active';
  if (!state.enforced) return 'off';
  return state.legacy ? 'paused' : 'unavailable';
}

/**
 * Everything the attestation gate needs from one evaluation: whether the
 * policy governs, whether members can re-attest, and the window (D6).
 */
export function ssoAttestationPolicy() {
  const state = evaluate();
  const hours = state.snapshot?.row.attestation_max_age_hours ?? DEFAULT_ATTESTATION_HOURS;
  return { enforced: state.enforced, loginAvailable: state.loginAvailable, maxAgeMs: hours * HOUR_MS };
}

/** D1 caller table: JIT needs login available AND the active row's opt-in. */
export function ssoJitEnabled() {
  const state = evaluate();
  return state.loginAvailable && state.snapshot?.row.jit_enabled === 1;
}

/**
 * The active row's role and tenant mapping (D4/D5), only while SSO login is
 * available; null otherwise, so every caller refuses (fail closed).
 * @returns {import('./sso-role-mapping.js').SsoMapping | null}
 */
export function activeSsoMapping() {
  const state = evaluate();
  return state.loginAvailable ? state.snapshot.mapping : null;
}

/** Test seam: forget the cached snapshot, decryptability and one-shot warnings. */
export function resetSsoConfigCacheForTests() {
  snapshot = null;
  decryptability = { key: null, ok: false };
  loggedCodes.clear();
}
