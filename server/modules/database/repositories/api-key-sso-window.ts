/**
 * SSO attestation window for API keys (T-1946, owner decision 2026-09-29).
 *
 * An API key of an SSO-linked NON-OWNER member authenticates only while that
 * member's newest SSO sign-in (user_identities.last_attested_at) is at most
 * N whole days old. N lives in app_config so the owner changes it from
 * Settings and the next key check applies it. The key is never deleted on
 * expiry: the member's next SSO sign-in restamps the attestation and the key
 * works again. Unlinked (local-only) accounts and the owner are not governed.
 *
 * The window itself never depends on SSO being on (ADR-194 D6). In addition,
 * while SSO is enforced but login is unavailable (unavailable, paused or a
 * state read failure), linked non-owners' keys are refused outright through
 * the same clause: the SSO state model registers that gate at load in the
 * leaf module api-key-sso-gate.ts, so this repository never imports a service.
 */
import type { Database } from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

import { apiKeySsoUnavailable } from './api-key-sso-gate.js';

export { apiKeySsoUnavailableGateRegistered, setApiKeySsoUnavailableGate } from './api-key-sso-gate.js';

export const API_KEY_SSO_WINDOW_CONFIG_KEY = 'api_keys.sso_attestation_window_days';
export const API_KEY_SSO_WINDOW_DEFAULT_DAYS = 7;
export const API_KEY_SSO_WINDOW_MIN_DAYS = 1;
export const API_KEY_SSO_WINDOW_MAX_DAYS = 365;
/** Error code a client maps to "sign in through SSO to use your API keys again". */
export const API_KEY_SSO_ATTESTATION_EXPIRED_CODE = 'api_key_sso_attestation_expired';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixed-code structured warning; never carries a value, key or identifier. */
function logApiKeyWindowWarning(code: string): void {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'api_keys', code })}\n`);
}

/** One warning per corrupt stretch, not one per key check. */
let corruptWindowLogged = false;

/**
 * Validates an owner-supplied window. Only a JSON integer within 1..365 is
 * accepted; strings, fractions, booleans and out-of-range values return null.
 */
export function parseApiKeySsoWindowDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < API_KEY_SSO_WINDOW_MIN_DAYS || value > API_KEY_SSO_WINDOW_MAX_DAYS) return null;
  return value;
}

/**
 * The effective window in days. An absent row means the owner's default (7).
 * A stored value that is not a valid window (only reachable by writing the
 * database directly) resolves to the MINIMUM, never to a longer window.
 * Read errors propagate so the key check fails closed.
 */
export function readApiKeySsoWindowDays(db: Database): number {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?')
    .get(API_KEY_SSO_WINDOW_CONFIG_KEY) as { value: unknown } | undefined;
  if (row === undefined) return API_KEY_SSO_WINDOW_DEFAULT_DAYS;
  const stored = typeof row.value === 'string' && /^\d{1,3}$/.test(row.value)
    ? parseApiKeySsoWindowDays(Number(row.value))
    : null;
  if (stored !== null) {
    corruptWindowLogged = false;
    return stored;
  }
  if (!corruptWindowLogged) {
    corruptWindowLogged = true;
    logApiKeyWindowWarning('api_key_sso_window_corrupt');
  }
  return API_KEY_SSO_WINDOW_MIN_DAYS;
}

/** Persists a window already validated by parseApiKeySsoWindowDays. */
export function writeApiKeySsoWindowDays(db: Database, days: number): void {
  if (parseApiKeySsoWindowDays(days) === null) throw new RangeError('invalid_window_days');
  db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(API_KEY_SSO_WINDOW_CONFIG_KEY, String(days));
}

/** Oldest attestation (epoch ms) that still keeps a linked member's keys alive. */
export function apiKeySsoAttestationCutoffMs(db: Database, nowMs: number = Date.now()): number {
  return nowMs - readApiKeySsoWindowDays(db) * DAY_MS;
}

/**
 * How a schema can express SSO attestation:
 * - `attested`: user_identities.last_attested_at exists; the window applies.
 * - `unattestable`: links exist but carry no attestation stamp (an older or
 *   forward-compatible schema). No linked member can be attested, so their
 *   keys fail closed while the owner and unlinked members keep working.
 * - `no_identities`: no user_identities table, so no account is linked.
 */
type AttestationSchemaMode = 'attested' | 'unattestable' | 'no_identities';

const schemaModes = new WeakMap<Database, { schemaVersion: number; mode: AttestationSchemaMode }>();

/** Detects the attestation mode once per connection and schema version (PRAGMA schema_version). */
function attestationSchemaMode(db: Database): AttestationSchemaMode {
  const schemaVersion = Number(db.pragma('schema_version', { simple: true }));
  const cached = schemaModes.get(db);
  if (cached && cached.schemaVersion === schemaVersion) return cached.mode;
  const columns = db.prepare('PRAGMA table_info(user_identities)').all() as { name: string }[];
  const mode: AttestationSchemaMode = columns.length === 0
    ? 'no_identities'
    : columns.some((column) => column.name === 'last_attested_at') ? 'attested' : 'unattestable';
  if (mode === 'unattestable') logApiKeyWindowWarning('api_key_sso_attestation_column_missing');
  schemaModes.set(db, { schemaVersion, mode });
  return mode;
}

const LINKED_EXEMPT_SQL = `u.role = 'owner'
  OR NOT EXISTS (SELECT 1 FROM user_identities ui WHERE ui.user_id = u.id)`;

/** A SQL fragment plus the values it binds, in order. */
export type ApiKeySsoAttestationClause = Readonly<{ sql: string; params: readonly number[] }>;

/**
 * THE single "SSO window allows this account's API keys" predicate (T-1946),
 * over a `users` row aliased `u`. Every key check (authentication, in-flight
 * revalidation, launch gateway, engine restamp, C4 review) splices `sql` and
 * spreads `params` at the same position. MAX() skips NULLs, so a linked member
 * whose links were never stamped compares NULL >= cutoff, which is not true:
 * a missing attestation fails closed. Schemas without the stamp column never
 * throw; see AttestationSchemaMode. While the SSO-unavailable gate holds, the
 * clause admits only the owner and unlinked accounts.
 */
export function apiKeySsoAttestationClause(db: Database, nowMs: number = Date.now()): ApiKeySsoAttestationClause {
  const mode = attestationSchemaMode(db);
  if (mode === 'no_identities') return { sql: '(1 = 1)', params: [] };
  // ADR-194 D6: SSO enforced but unavailable → no linked non-owner can attest.
  if (mode === 'unattestable' || apiKeySsoUnavailable()) return { sql: `(${LINKED_EXEMPT_SQL})`, params: [] };
  return {
    sql: `(${LINKED_EXEMPT_SQL}
  OR (SELECT MAX(ui.last_attested_at) FROM user_identities ui WHERE ui.user_id = u.id) >= ?)`,
    params: [apiKeySsoAttestationCutoffMs(db, nowMs)],
  };
}

/** Why an exact API key credential is or is not usable right now. */
export type ApiKeyCredentialState = 'current' | 'invalid' | 'sso_attestation_expired';

/**
 * Revalidates one exact key row (`api-key:<id>`) and its owning account:
 * key active, account active, and the SSO window. `authorizationGeneration`,
 * when given, must also match. Shared by every launch-time and in-flight check
 * so they cannot drift (T-1946 review M3).
 */
export function apiKeyCredentialState(db: Database, input: Readonly<{
  apiKeyId: number;
  userId: number;
  authorizationGeneration?: number;
  nowMs?: number;
}>): ApiKeyCredentialState {
  const { apiKeyId, userId, authorizationGeneration } = input;
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (!positive(apiKeyId) || !positive(userId)
    || (authorizationGeneration !== undefined && !positive(authorizationGeneration))) {
    return 'invalid';
  }
  const clause = apiKeySsoAttestationClause(db, input.nowMs);
  const generationSql = authorizationGeneration === undefined ? '' : 'AND u.authorization_generation = ?';
  const row = db.prepare(`SELECT CASE WHEN ${clause.sql} THEN 1 ELSE 0 END AS attested
    FROM api_keys ak JOIN users u ON u.id = ak.user_id
    WHERE ak.id = ? AND ak.user_id = ? AND ak.is_active = 1
      AND u.is_active = 1 AND u.status = 'active' ${generationSql}`)
    .get(...clause.params, apiKeyId, userId,
      ...(authorizationGeneration === undefined ? [] : [authorizationGeneration])) as
    { attested: number } | undefined;
  if (!row) return 'invalid';
  return row.attested === 1 ? 'current' : 'sso_attestation_expired';
}

/** Parses the canonical `api-key:<id>` credential id; null when malformed. */
export function parseApiKeyCredentialId(credentialId: string | null | undefined): number | null {
  const match = /^api-key:(\d+)$/u.exec(credentialId ?? '');
  return match ? Number(match[1]) : null;
}

/** Connection-bound accessors for the settings service. */
export const apiKeySsoWindowDb = {
  /** Effective window in days (see readApiKeySsoWindowDays). */
  getDays(): number {
    return readApiKeySsoWindowDays(getConnection());
  },

  /** Stores a validated window; throws RangeError on an invalid value. */
  setDays(days: number): void {
    writeApiKeySsoWindowDays(getConnection(), days);
  },
};
