/** Reviewed 349-object predecessor delta; no connection, application imports or backfill. */
import type BetterSqlite3 from 'better-sqlite3';

export const PERMISSION_RECEIPT_FORWARD_MIGRATION_ID = 'permission-receipt-forward/v1';

// Exact DDL independently checked against immutable candidate 10caa51f, not the ordinary runner.
const STEPS = [
  'ALTER TABLE pending_server_actions ADD COLUMN execution_attempt_nonce TEXT',
  `ALTER TABLE permission_admission_leases ADD COLUMN effect_footprint TEXT NOT NULL
        DEFAULT 'external' CHECK (effect_footprint IN ('local', 'external'))`,
  'ALTER TABLE permission_admission_leases ADD COLUMN effect_child_pid INTEGER',
  'ALTER TABLE permission_admission_leases ADD COLUMN effect_child_boot_id TEXT',
  'ALTER TABLE permission_admission_leases ADD COLUMN effect_child_start_ticks TEXT',
  'ALTER TABLE message_coordination_ingress ADD COLUMN accepted_at TEXT',
  `CREATE TABLE IF NOT EXISTS permission_effect_fences (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'user_provider_purpose')),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 512),
  protocol_generation INTEGER NOT NULL CHECK (protocol_generation > 0),
  decision_id TEXT,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_key),
  FOREIGN KEY (decision_id) REFERENCES permission_launch_decisions(decision_id)
    ON DELETE RESTRICT
)`,
];

/** Execute only within the governed child's existing transaction and verified source state. */
export function migrateCompatibleForwardPermissionReceipt(db: BetterSqlite3.Database): void {
  if (!db.inTransaction) throw new Error('compatible_forward_transaction_required');
  // Source/target digest admission belongs to the child; SQLite rejects partial prior DDL.
  // The child rolls back the entire BEGIN IMMEDIATE transaction on any failure.
  for (const sql of STEPS) db.exec(sql);
}
