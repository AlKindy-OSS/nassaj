/**
 * SSO configuration repository (ADR-194 D1/D3, T-1962 S1).
 *
 * Owns the `sso_oidc_config` table and the `sso.disabled` record in app_config.
 * Reads here PROPAGATE database errors: the state model turns any read failure
 * into "policy enforced" (fail closed), so swallowing an error would fail open.
 * Every helper takes the connection so a state change and its revocation and
 * audit run on the caller's transaction and commit or roll back together.
 */
import type { Database } from 'better-sqlite3';

export const SSO_DISABLED_CONFIG_KEY = 'sso.disabled';

export type SsoSlot = 'active' | 'draft';

export type SsoOidcConfigRow = {
  slot: SsoSlot;
  enabled: number;
  issuer: string;
  client_id: string;
  client_auth: 'none' | 'client_secret_basic' | 'client_secret_post';
  client_secret_enc: string | null;
  secret_version: number;
  extra_scopes: string;
  redirect_uri: string | null;
  role_claim_path: string;
  role_rules_json: string;
  tenant_mode: 'none' | 'claim' | 'role_grant_scope';
  tenant_claim_path: string | null;
  tenant_values_json: string;
  jit_enabled: number;
  attestation_max_age_hours: number;
  allow_private_network: number;
  issuer_port: number | null;
  pinned_endpoints_json: string | null;
  discovery_flags_json: string | null;
  runtime_fault: string | null;
  config_hash: string;
  draft_version: number;
  version: number;
  updated_at: number | null;
  updated_by: number | null;
};

/** Every column a draft write supplies; counters and timestamps are derived here. */
export type SsoDraftFields = Omit<SsoOidcConfigRow,
  'slot' | 'enabled' | 'runtime_fault' | 'draft_version' | 'version' | 'updated_at' | 'updated_by'>;

/** Every column a draft write supplies (also what apply copies to the active slot). */
export const SSO_DRAFT_COLUMNS = [
  'issuer', 'client_id', 'client_auth', 'client_secret_enc', 'secret_version', 'extra_scopes',
  'redirect_uri', 'role_claim_path', 'role_rules_json', 'tenant_mode', 'tenant_claim_path',
  'tenant_values_json', 'jit_enabled', 'attestation_max_age_hours', 'allow_private_network',
  'issuer_port', 'pinned_endpoints_json', 'discovery_flags_json', 'config_hash',
] as const satisfies readonly (keyof SsoDraftFields)[];

const UPSERT_DRAFT_SQL = `INSERT INTO sso_oidc_config
  (slot, ${SSO_DRAFT_COLUMNS.join(', ')}, draft_version, updated_at, updated_by)
  VALUES ('draft', ${SSO_DRAFT_COLUMNS.map((column) => `@${column}`).join(', ')}, 1, @updated_at, @updated_by)
  ON CONFLICT(slot) DO UPDATE SET
  ${SSO_DRAFT_COLUMNS.map((column) => `${column} = excluded.${column}`).join(',\n  ')},
  draft_version = sso_oidc_config.draft_version + 1,
  updated_at = excluded.updated_at, updated_by = excluded.updated_by`;

/** The active row's version, or null when no active row exists (per-call read, D3). */
export function readActiveVersionOn(db: Database): number | null {
  const row = db.prepare("SELECT version FROM sso_oidc_config WHERE slot = 'active'")
    .get() as { version: number } | undefined;
  return row === undefined ? null : row.version;
}

/** Whether any SSO row (draft or active) exists; propagates read errors. */
export function anySsoRowExistsOn(db: Database): boolean {
  return db.prepare('SELECT 1 FROM sso_oidc_config LIMIT 1').get() !== undefined;
}

/**
 * Persists a runtime fault on the active row (D3, e.g. discovery drift) and
 * bumps `version` so every per-call version read reloads the snapshot. CAS on
 * the version the caller observed and on an empty fault: a stale verifier can
 * never fault a newer configuration. True when the row changed.
 */
export function recordActiveRuntimeFaultOn(db: Database, fault: string, expectedVersion: number, nowMs: number): boolean {
  return db.prepare(`UPDATE sso_oidc_config SET runtime_fault = ?, version = version + 1, updated_at = ?
    WHERE slot = 'active' AND version = ? AND runtime_fault IS NULL`)
    .run(fault, nowMs, expectedVersion).changes === 1;
}

/** One slot's row, or undefined when absent. */
export function readSlotOn(db: Database, slot: SsoSlot): SsoOidcConfigRow | undefined {
  return db.prepare('SELECT * FROM sso_oidc_config WHERE slot = ?').get(slot) as SsoOidcConfigRow | undefined;
}

/** Whether the owner-written (or FORCE_OFF-written) disabled record exists. */
export function disabledRecordPresentOn(db: Database): boolean {
  return db.prepare('SELECT 1 FROM app_config WHERE key = ?').get(SSO_DISABLED_CONFIG_KEY) !== undefined;
}

/** Whether any account other than an owner holds an IdP link (D1 `nonOwnerLinked`). */
export function nonOwnerLinkExistsOn(db: Database): boolean {
  return db.prepare(`SELECT 1 FROM user_identities ui JOIN users u ON u.id = ui.user_id
    WHERE u.role <> 'owner' LIMIT 1`).get() !== undefined;
}

/** Writes the disabled record; `reason` is a fixed code, never user text. */
export function writeDisabledRecordOn(db: Database, reason: string, nowMs: number): void {
  db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(SSO_DISABLED_CONFIG_KEY, JSON.stringify({ reason, at: nowMs }));
}

/** Deletes the disabled record; true when one existed. */
export function deleteDisabledRecordOn(db: Database): boolean {
  return db.prepare('DELETE FROM app_config WHERE key = ?').run(SSO_DISABLED_CONFIG_KEY).changes === 1;
}

/** Sets `enabled` on the active row and bumps its version; true when a row changed. */
export function setActiveEnabledOn(db: Database, enabled: 0 | 1, actorUserId: number | null, nowMs: number): boolean {
  return db.prepare(`UPDATE sso_oidc_config SET enabled = ?, version = version + 1,
    updated_at = ?, updated_by = ? WHERE slot = 'active'`)
    .run(enabled, nowMs, actorUserId).changes === 1;
}

/**
 * Advances the password stamp of every linked non-owner (ends their JWTs and
 * refresh grace) and returns their ids so the caller can drop caches and live
 * runs after commit. Owners are never touched.
 */
export function stampLinkedNonOwnerSessionsRevokedOn(db: Database, nowMs: number): number[] {
  const ids = (db.prepare(`SELECT DISTINCT u.id AS id FROM users u
    JOIN user_identities ui ON ui.user_id = u.id WHERE u.role <> 'owner' ORDER BY u.id`)
    .all() as Array<{ id: number }>).map((row) => row.id);
  const stamp = db.prepare("UPDATE users SET password_changed_at = ? WHERE id = ? AND role <> 'owner'");
  for (const id of ids) stamp.run(nowMs, id);
  return ids;
}

/** The draft-writable columns of a stored row (D3), e.g. to rewrite pins or copy to active. */
export function draftFieldsOf(row: SsoOidcConfigRow): SsoDraftFields {
  return Object.fromEntries(SSO_DRAFT_COLUMNS.map((column) => [column, row[column]])) as SsoDraftFields;
}

/** Inserts or replaces the draft and bumps `draft_version` (every draft write does, D2). */
export function upsertDraftOn(db: Database, fields: SsoDraftFields, actorUserId: number | null, nowMs: number): void {
  db.prepare(UPSERT_DRAFT_SQL).run({ ...fields, updated_at: nowMs, updated_by: actorUserId });
}
