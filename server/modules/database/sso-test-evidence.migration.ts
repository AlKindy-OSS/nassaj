import type { Database } from 'better-sqlite3';

/**
 * SSO test sign-in evidence (ADR-194 D8, T-1962 S3). Two stores, two purposes:
 *
 *   sso_test_results — display only: one row per test sign-in outcome for the
 *     owner who started it; 5-minute TTL, deleted on read, swept on read and
 *     at boot. `id` is 32 random bytes (base64url).
 *   sso_apply_proofs — evidence for apply: bound to owner, config hash and
 *     draft version; 24-hour TTL, NOT deleted on read, swept by age.
 *
 * Additive and idempotent; no FK (rows are short-lived and owner-checked on
 * read). Flags are constrained to 0/1 like the configuration table.
 */
/**
 * One statement per entry: the admitted (startup-admission) boot path runs this
 * under the reviewed startup SQL contract, which refuses multi-statement execs.
 */
export const SSO_TEST_EVIDENCE_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS sso_test_results (
  id TEXT PRIMARY KEY CHECK (length(id) = 43),
  owner_user_id INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS sso_apply_proofs (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  draft_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('discovery','sign_in')),
  passed INTEGER NOT NULL CHECK (passed IN (0,1)),
  shape_flags TEXT,
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_sso_apply_proofs_binding
  ON sso_apply_proofs (owner_user_id, config_hash, draft_version, kind)`,
]);

/** Creates both evidence tables and the proof index, one statement at a time. */
export function migrateSsoTestEvidence(db: Database): void {
  for (const statement of SSO_TEST_EVIDENCE_SCHEMA_STATEMENTS) db.exec(statement);
}

/** Explicit rollback; never invoked automatically or against live data. */
export function rollbackSsoTestEvidence(db: Database): void {
  db.exec('DROP TABLE IF EXISTS sso_test_results; DROP TABLE IF EXISTS sso_apply_proofs;');
}
