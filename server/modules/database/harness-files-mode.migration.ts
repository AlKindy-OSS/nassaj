import type { Database } from 'better-sqlite3';

/**
 * user_harness_files_mode — each user's choice between the shared skill set and
 * their private copy (ADR-203, T-2003 C1). One row per user; a MISSING row means
 * `shared`, so a fresh or emptied table leaves everyone on the shared baseline.
 *
 * ON DELETE CASCADE: deleting the user drops the choice. The private store on
 * disk is deliberately NOT removed here (ADR-203 "Data model"); `users.id` is
 * AUTOINCREMENT, so a later account never inherits an old store.
 *
 * One statement, no index (the primary key is the only lookup). It is executed
 * on the admitted boot path too, where the exact text is a reviewed startup
 * effect (`__tests__/startup-sql-trace-contract.mjs`): change both together.
 */
export const USER_HARNESS_FILES_MODE_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS user_harness_files_mode (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('shared','private')),
  updated_at INTEGER NOT NULL
)`;

/**
 * Creates `user_harness_files_mode` (additive, idempotent, no backfill: the
 * absence of rows IS the shared default). Must run after `users` exists.
 */
export function migrateUserHarnessFilesMode(db: Database): void {
  db.exec(USER_HARNESS_FILES_MODE_TABLE_SCHEMA_SQL);
}
