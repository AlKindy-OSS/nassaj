import type { Database } from 'better-sqlite3';

/**
 * T-2035 (ADR-212): sign-out revocation and the login throttle.
 *
 * `users.token_epoch` is the per-user bearer epoch carried in every JWT as
 * `tok_ep`; logout bumps it, so every JWT the user holds dies on every device.
 * It is deliberately NOT part of `trg_users_authorization_generation`: that
 * generation feeds permit and launch fences, and a logout must not stop running
 * agent turns (B-1327).
 *
 * `login_throttle` keys failures by an HMAC of the normalized identifier (never
 * the identifier itself). Pruned on write; the index serves that prune.
 *
 * One statement per exec: the admitted boot path runs this too, where the exact
 * text is a reviewed startup effect (`__tests__/startup-sql-trace-contract.mjs`).
 */
export const LOGIN_THROTTLE_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS login_throttle (
  key_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  first_failure_at INTEGER NOT NULL,
  locked_until INTEGER,
  lock_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`;

export const LOGIN_THROTTLE_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_login_throttle_updated_at ON login_throttle(updated_at)';

/**
 * T-2035 round 3 (owner decision 2026-10-16): a normal sign-out ends only the
 * current device's session. Each JWT carries a random `sid`; signing out
 * records it here until the token could no longer be renewed (exp + grace),
 * after which the row is pruned on write.
 */
export const REVOKED_TOKEN_SIDS_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS revoked_token_sids (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

export const REVOKED_TOKEN_SIDS_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_revoked_token_sids_expires_at ON revoked_token_sids(expires_at)';

export const USERS_TOKEN_EPOCH_COLUMN_SQL =
  'ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0 CHECK (token_epoch >= 0)';

/**
 * Adds `users.token_epoch` and creates `login_throttle` and
 * `revoked_token_sids` (additive, idempotent,
 * no backfill: epoch 0 matches every token minted before this release, so the
 * deploy signs nobody out). The column probe and the ALTER share one immediate
 * transaction so two admitted processes cannot both add the column.
 * Must run after `users` exists.
 */
export function migrateAuthTokenEpoch(db: Database): void {
  db.exec(LOGIN_THROTTLE_TABLE_SCHEMA_SQL);
  db.exec(LOGIN_THROTTLE_INDEX_SQL);
  db.exec(REVOKED_TOKEN_SIDS_TABLE_SCHEMA_SQL);
  db.exec(REVOKED_TOKEN_SIDS_INDEX_SQL);
  db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'token_epoch')) db.exec(USERS_TOKEN_EPOCH_COLUMN_SQL);
  }).immediate();
}
