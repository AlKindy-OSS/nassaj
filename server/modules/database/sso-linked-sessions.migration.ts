import type { Database } from 'better-sqlite3';

/**
 * ADR-H20 S6 (ADR-194 amendment A2): linked sign-in and sign-out.
 *
 * `sso_device_sessions` holds one row per Nassaj device session (the JWT
 * `refreshSid`) that started through SSO. It carries the 24 h idle clock
 * (N8), the silent re-check clock (D9-1), the login hint of the session's own
 * user (V10a) and whether it is the owner's no-click tier. `privileged_until`
 * held the owner step-up grant (N2), withdrawn 2026-10-18; the column stays
 * (always NULL). A password session has no row.
 *
 * `sso_device_session_idp_sids` maps the IdP session ids (`sid` claim) seen by
 * that device session to it, so a back-channel logout ends exactly that
 * browser's session (N5). Sign-in and re-check may each add a sid.
 *
 * `oidc_logout_jtis` records a logout token's `jti` only after it was answered
 * 200 (ADR-H20 D5, V4), so a retry after our own 503 is processed and a replay
 * after a 200 is a no-op. Persistent: it survives a restart.
 *
 * Additive only (three new tables and their indexes, no backfill): an older
 * build runs on the migrated database unchanged. One statement per exec: the
 * admitted boot path runs this too, where the exact text is a reviewed startup
 * effect (`__tests__/startup-sql-trace-contract.mjs`).
 */
export const SSO_DEVICE_SESSIONS_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sso_device_sessions (
  refresh_sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  issuer TEXT NOT NULL,
  login_hint TEXT,
  owner_tier INTEGER NOT NULL DEFAULT 0 CHECK (owner_tier IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_recheck_at INTEGER NOT NULL,
  privileged_until INTEGER,
  prune_after INTEGER NOT NULL
)`;

export const SSO_DEVICE_SESSIONS_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_sso_device_sessions_prune_after ON sso_device_sessions(prune_after)';

export const SSO_DEVICE_SESSION_IDP_SIDS_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sso_device_session_idp_sids (
  issuer TEXT NOT NULL,
  idp_sid TEXT NOT NULL,
  refresh_sid TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, idp_sid, refresh_sid)
)`;

export const SSO_DEVICE_SESSION_IDP_SIDS_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_sso_device_session_idp_sids_refresh_sid ON sso_device_session_idp_sids(refresh_sid)';

export const OIDC_LOGOUT_JTIS_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS oidc_logout_jtis (
  issuer TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, jti)
)`;

export const OIDC_LOGOUT_JTIS_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_oidc_logout_jtis_expires_at ON oidc_logout_jtis(expires_at)';

/** Creates the three ADR-H20 tables (additive, idempotent, no backfill). */
export function migrateSsoLinkedSessions(db: Database): void {
  db.exec(SSO_DEVICE_SESSIONS_TABLE_SCHEMA_SQL);
  db.exec(SSO_DEVICE_SESSIONS_INDEX_SQL);
  db.exec(SSO_DEVICE_SESSION_IDP_SIDS_TABLE_SCHEMA_SQL);
  db.exec(SSO_DEVICE_SESSION_IDP_SIDS_INDEX_SQL);
  db.exec(OIDC_LOGOUT_JTIS_TABLE_SCHEMA_SQL);
  db.exec(OIDC_LOGOUT_JTIS_INDEX_SQL);
}
