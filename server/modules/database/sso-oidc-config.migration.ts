import type { Database } from 'better-sqlite3';

import { migrateSsoTestEvidence } from './sso-test-evidence.migration.js';

/**
 * Provider-neutral SSO configuration (ADR-194 D3, T-1962 S1). One row per slot:
 * `draft` is what the owner edits and tests, `active` is what sign-in uses.
 * Additive and idempotent; no backfill (an absent active row is the legacy or
 * fresh-install state, D1). Flags are constrained to 0/1 so a hand-written row
 * cannot smuggle a truthy non-boolean past the state model.
 */
export const SSO_OIDC_CONFIG_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sso_oidc_config (
  slot TEXT PRIMARY KEY CHECK (slot IN ('active','draft')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_auth TEXT NOT NULL
    CHECK (client_auth IN ('none','client_secret_basic','client_secret_post')),
  client_secret_enc TEXT,
  secret_version INTEGER NOT NULL DEFAULT 0,
  extra_scopes TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT,
  role_claim_path TEXT NOT NULL,
  role_rules_json TEXT NOT NULL,
  tenant_mode TEXT NOT NULL CHECK (tenant_mode IN ('none','claim','role_grant_scope')),
  tenant_claim_path TEXT,
  tenant_values_json TEXT NOT NULL DEFAULT '[]',
  jit_enabled INTEGER NOT NULL DEFAULT 0 CHECK (jit_enabled IN (0,1)),
  attestation_max_age_hours INTEGER NOT NULL DEFAULT 12
    CHECK (attestation_max_age_hours BETWEEN 1 AND 24),
  allow_private_network INTEGER NOT NULL DEFAULT 0 CHECK (allow_private_network IN (0,1)),
  issuer_port INTEGER CHECK (issuer_port IS NULL OR issuer_port BETWEEN 1 AND 65535),
  pinned_endpoints_json TEXT,
  discovery_flags_json TEXT,
  runtime_fault TEXT,
  config_hash TEXT NOT NULL,
  draft_version INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  updated_by INTEGER
)`;

/** Creates the SSO configuration table; called only by the startup migration path. */
export function migrateSsoOidcConfig(db: Database): void {
  db.exec(SSO_OIDC_CONFIG_TABLE_SCHEMA_SQL);
}

/**
 * Every T-1962 table and index (ADR-194 D3/D8): the configuration slots, the
 * test display results and the apply proofs. Additive and idempotent, with no
 * nested transaction, so it is safe on BOTH boot paths: the guarded bootstrap
 * (inside runMigrations) and the admitted path (initializeAdmittedDatabase),
 * which never runs runMigrations. Without it an admitted node would read a
 * missing table, enforce SSO and leave it unavailable (every linked member
 * locked out). The new audit actions and app_config keys need no schema
 * change: neither table constrains its key or action column.
 */
export function migrateSsoOidc(db: Database): void {
  migrateSsoOidcConfig(db);
  migrateSsoTestEvidence(db);
}

/**
 * Explicit rollback; never invoked automatically or against live data. A
 * pre-T-1962 build reads only OIDC_* env, so keep that env in place before
 * rolling back (ADR-194 D1 rollback warning).
 */
export function rollbackSsoOidcConfig(db: Database): void {
  db.exec('DROP TABLE IF EXISTS sso_oidc_config');
  db.prepare("DELETE FROM app_config WHERE key = 'sso.disabled'").run();
}
