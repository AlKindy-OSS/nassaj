import type { Database } from 'better-sqlite3';

/**
 * ADR-219 S1 (T-2072): the cross-session relay's durable rows.
 *
 * `peer_messages` holds one row per relayed `SendMessage` (queued, refused or
 * delivered). Identity columns come from the sender's run entry, never from
 * text. `ref_token` is the 128-bit CSPRNG proof anchor embedded in the
 * delivered wrapper; `state = 'delivering'` + the ref is the exactly-once
 * claim (م-8); `proof_scan_offset` is the target transcript's size at claim, so the
 * proof scan reads only what the delivery turn appended (qa م-7). P2 columns (stamped_mode, approval_*) exist now so P2 stays an
 * additive change.
 *
 * `peer_session_cost_totals` keeps the last `total_cost_usd` a session's run
 * reported, the baseline the charge of a peer-woken turn is measured against.
 * `peer_agent_origin_hops` keeps the hop of the run an agent was born in
 * (ح-2 c), so a resumed agent cannot launder hops across runs or restarts.
 *
 * One statement per exec: the admitted boot path runs this too, where the exact
 * text is a reviewed startup effect (`__tests__/startup-sql-trace-contract.mjs`).
 */
export const PEER_MESSAGES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS peer_messages (
  id TEXT PRIMARY KEY NOT NULL,
  ref_token TEXT NOT NULL UNIQUE,
  chain_id TEXT NOT NULL,
  from_user_id INTEGER NOT NULL,
  from_session_id TEXT NOT NULL,
  from_agent_id TEXT,
  from_mode TEXT NOT NULL,
  stamped_mode TEXT,
  to_user_id INTEGER,
  to_session_id TEXT NOT NULL,
  project_id TEXT,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
  summary TEXT,
  hop INTEGER NOT NULL CHECK (hop >= 1),
  parent_id TEXT,
  notify_when_idle INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('queued', 'delivering', 'delivered', 'refused', 'deferred_quota', 'failed')),
  cause TEXT,
  delivery_path TEXT,
  approval_text_hash TEXT,
  approval_target_mode TEXT,
  approved_by INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  proof_scan_offset INTEGER,
  cost_usd_charged REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
)`;

export const PEER_MESSAGES_TO_USER_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_peer_messages_to_user_state ON peer_messages(to_user_id, state)';

export const PEER_MESSAGES_TO_SESSION_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_peer_messages_to_session ON peer_messages(to_session_id, state, created_at)';

export const PEER_MESSAGES_FROM_SESSION_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_peer_messages_from_session ON peer_messages(from_session_id, created_at)';

export const PEER_MESSAGES_FROM_USER_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_peer_messages_from_user ON peer_messages(from_user_id, created_at)';

export const PEER_SESSION_COST_TOTALS_SQL = `CREATE TABLE IF NOT EXISTS peer_session_cost_totals (
  session_id TEXT PRIMARY KEY NOT NULL,
  total_cost_usd REAL NOT NULL CHECK (total_cost_usd >= 0),
  updated_at INTEGER NOT NULL
)`;

export const PEER_AGENT_ORIGIN_HOPS_SQL = `CREATE TABLE IF NOT EXISTS peer_agent_origin_hops (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  origin_hop INTEGER NOT NULL CHECK (origin_hop >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, agent_id)
)`;

/**
 * The EFFECTIVE permission mode nassaj handed the CLI at each spawn (after parity,
 * settings defaultMode and the UI choice), per session and spawning member. The
 * relay's only mode source (ADR-219: from-mode from server state, never from the
 * transcript); written by nassaj, not by the agent.
 */
export const SESSION_PERMISSION_MODES_SQL = `CREATE TABLE IF NOT EXISTS session_permission_modes (
  session_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  permission_mode TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, owner_user_id)
)`;

/** Every statement, in execution order (the reviewed startup contract mirrors it). */
export const PEER_MESSAGES_MIGRATION_SQL = [
  PEER_MESSAGES_TABLE_SQL,
  PEER_MESSAGES_TO_USER_INDEX_SQL,
  PEER_MESSAGES_TO_SESSION_INDEX_SQL,
  PEER_MESSAGES_FROM_SESSION_INDEX_SQL,
  PEER_MESSAGES_FROM_USER_INDEX_SQL,
  PEER_SESSION_COST_TOTALS_SQL,
  PEER_AGENT_ORIGIN_HOPS_SQL,
  SESSION_PERMISSION_MODES_SQL,
] as const;

/** Creates the relay tables (additive, idempotent, no backfill). */
export function migratePeerMessages(db: Database): void {
  for (const sql of PEER_MESSAGES_MIGRATION_SQL) db.exec(sql);
}

/** Explicit rollback; never invoked automatically or against live data. */
export function rollbackPeerMessages(db: Database): void {
  db.exec('DROP TABLE IF EXISTS session_permission_modes');
  db.exec('DROP TABLE IF EXISTS peer_agent_origin_hops');
  db.exec('DROP TABLE IF EXISTS peer_session_cost_totals');
  db.exec('DROP TABLE IF EXISTS peer_messages');
}
