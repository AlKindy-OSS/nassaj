import type { Database } from 'better-sqlite3';

/**
 * ADR-219 P2a-min (T-2074) §3 — cross-member holds, additive only (ح-1, م-8).
 *
 * `peer_holds` keeps a cross-member send until the target owner approves,
 * rejects, or it expires/is cancelled; an approved hold is promoted into
 * `peer_messages` as `queued` with `hold_id`. `peer_messages` and its state CHECK
 * are never rebuilt: `hold_id` is added by ADD COLUMN only when
 * `PRAGMA table_info(peer_messages)` lacks it. The CHECKs already list every P2
 * cause so later slices need no rebuild. N-1 code ignores the table and column.
 *
 * One statement per exec; each is a reviewed startup effect
 * (`__tests__/startup-sql-trace-contract.mjs`).
 */
export const PEER_HOLDS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS peer_holds (
  id TEXT PRIMARY KEY NOT NULL,
  chain_id TEXT NOT NULL,
  from_user_id INTEGER NOT NULL,
  from_session_id TEXT NOT NULL,
  from_agent_id TEXT,
  from_mode TEXT NOT NULL,
  to_user_id INTEGER NOT NULL,
  to_session_id TEXT NOT NULL,
  project_id TEXT,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
  summary TEXT,
  hop INTEGER NOT NULL CHECK (hop >= 1),
  parent_id TEXT,
  hold_causes TEXT NOT NULL CHECK (hold_causes IN ('cross_member', 'mode_mismatch', 'cross_member+mode_mismatch')),
  state TEXT NOT NULL CHECK (state IN ('held', 'promoted', 'rejected', 'expired', 'cancelled')),
  hold_version INTEGER NOT NULL DEFAULT 1 CHECK (hold_version >= 1),
  cause TEXT,
  target_mode_shown TEXT,
  decided_by INTEGER,
  decided_auth_kind TEXT,
  decided_at INTEGER,
  reject_reason TEXT,
  message_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export const PEER_HOLDS_TO_USER_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_peer_holds_to_user_state ON peer_holds(to_user_id, state, created_at)';

export const PEER_HOLDS_TO_SESSION_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_peer_holds_to_session_state ON peer_holds(to_session_id, state)';

export const PEER_HOLDS_PAIR_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_peer_holds_from_to_state ON peer_holds(from_user_id, to_user_id, state)';

/** The sweep's expiry scan (qa ت-7). */
export const PEER_HOLDS_STATE_EXPIRY_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_peer_holds_state_expires ON peer_holds(state, expires_at)';

/** The CREATE statements, in execution order. */
export const PEER_HOLDS_MIGRATION_SQL = [
  PEER_HOLDS_TABLE_SQL,
  PEER_HOLDS_TO_USER_INDEX_SQL,
  PEER_HOLDS_TO_SESSION_INDEX_SQL,
  PEER_HOLDS_PAIR_INDEX_SQL,
  PEER_HOLDS_STATE_EXPIRY_INDEX_SQL,
] as const;

/** The column probe (a read; allowed on the admitted boot path). */
export const PEER_MESSAGES_TABLE_INFO_SQL = 'PRAGMA table_info(peer_messages)';

export const PEER_MESSAGES_HOLD_ID_COLUMN_SQL = 'ALTER TABLE peer_messages ADD COLUMN hold_id TEXT';

/**
 * Creates `peer_holds` and adds `peer_messages.hold_id` (additive, idempotent, no
 * backfill). Must run after migratePeerMessages. The probe and the ALTER share
 * one immediate transaction so two admitted processes cannot both add the column.
 */
export function migratePeerHolds(db: Database): void {
  for (const sql of PEER_HOLDS_MIGRATION_SQL) db.exec(sql);
  db.transaction(() => {
    const columns = db.prepare(PEER_MESSAGES_TABLE_INFO_SQL).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'hold_id')) db.exec(PEER_MESSAGES_HOLD_ID_COLUMN_SQL);
  }).immediate();
}

/** Explicit rollback for TEST databases only; never invoked automatically or against live data. */
export function rollbackPeerHoldsForTests(db: Database): void {
  db.exec('DROP TABLE IF EXISTS peer_holds');
  const columns = db.prepare(PEER_MESSAGES_TABLE_INFO_SQL).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'hold_id')) db.exec('ALTER TABLE peer_messages DROP COLUMN hold_id');
}
