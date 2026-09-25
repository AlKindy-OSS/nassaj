/** Additive durable state for ADR-134 permission decisions and execution leases. */

import type { Database } from 'better-sqlite3';

export const PERMISSION_EXECUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS permission_launch_decisions (
  decision_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  principal_id TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  authentication_kind TEXT NOT NULL CHECK (
    authentication_kind IN ('session', 'ck', 'verified_proxy', 'internal_service')
  ),
  authorization_generation INTEGER NOT NULL CHECK (authorization_generation > 0),
  authentication_credential_id TEXT,
  device_session_id TEXT,
  device_slot_id TEXT,
  device_generation INTEGER CHECK (device_generation IS NULL OR device_generation > 0),
  launch_id TEXT NOT NULL CHECK (length(launch_id) BETWEEN 1 AND 256),
  session_id TEXT,
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  workspace_digest TEXT NOT NULL CHECK (length(workspace_digest) BETWEEN 16 AND 256),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 64),
  engine TEXT NOT NULL CHECK (length(engine) BETWEEN 1 AND 128),
  entrypoint TEXT NOT NULL CHECK (length(entrypoint) BETWEEN 1 AND 128),
  purpose TEXT NOT NULL CHECK (
    purpose IN ('spawn', 'sdk_thread', 'sdk_turn', 'catalog', 'quota', 'balance',
                'mcp', 'delegation', 'external_agent_dispatch')
  ),
  requested_profile TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  profile_digest TEXT NOT NULL,
  capability_digest TEXT NOT NULL,
  release_build TEXT NOT NULL,
  protocol_generation INTEGER NOT NULL CHECK (protocol_generation > 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('authorized', 'denied', 'not_started')),
  reason_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reason_codes_json)),
  state TEXT NOT NULL CHECK (
    state IN ('authorized', 'denied', 'not_started', 'effect_claimed', 'started', 'terminal')
  ),
  terminal_outcome TEXT CHECK (
    terminal_outcome IS NULL OR terminal_outcome IN
      ('succeeded', 'failed', 'cancelled', 'timed_out', 'spawn_failed', 'revoked',
       'not_started', 'reconciled_unknown')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((state = 'terminal') = (terminal_outcome IS NOT NULL)),
  CHECK (
    (device_session_id IS NULL AND device_slot_id IS NULL AND device_generation IS NULL)
    OR (device_session_id IS NOT NULL AND device_slot_id IS NOT NULL AND device_generation IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS permission_admission_leases (
  lease_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (
    purpose IN ('spawn', 'sdk_thread', 'sdk_turn', 'catalog', 'quota', 'balance',
                'mcp', 'delegation', 'external_agent_dispatch')
  ),
  protocol_generation INTEGER NOT NULL CHECK (protocol_generation > 0),
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  owner_boot_id TEXT NOT NULL,
  owner_start_ticks TEXT NOT NULL,
  effect_identity TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('issued', 'active', 'terminal', 'revoked')),
  expires_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  terminal_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES permission_launch_decisions(decision_id)
    ON DELETE RESTRICT,
  CHECK (
    (status = 'issued' AND claimed_at_ms IS NULL)
    OR (status IN ('active', 'terminal') AND claimed_at_ms IS NOT NULL)
    OR status = 'revoked'
  ),
  CHECK ((status IN ('terminal', 'revoked')) = (terminal_at_ms IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS permission_rollout_transitions (
  transition_id TEXT PRIMARY KEY,
  from_profile TEXT NOT NULL CHECK (from_profile IN ('legacy', 'shadow', 'enforce')),
  to_profile TEXT NOT NULL CHECK (to_profile IN ('legacy', 'shadow', 'enforce')),
  from_generation INTEGER NOT NULL CHECK (from_generation > 0),
  to_generation INTEGER NOT NULL CHECK (to_generation > from_generation),
  manifest_digest TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  profile_digest TEXT NOT NULL,
  capability_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'closing', 'applied', 'rolled_back', 'failed_closed')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER,
  CHECK ((state IN ('applied', 'rolled_back', 'failed_closed')) = (terminal_at_ms IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS permission_reconciliation_items (
  reconciliation_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  effect_identity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'terminal', 'blocked')),
  terminal_outcome TEXT CHECK (
    terminal_outcome IS NULL OR terminal_outcome IN
      ('succeeded', 'failed', 'cancelled', 'timed_out', 'spawn_failed', 'revoked',
       'not_started', 'reconciled_unknown')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (decision_id, effect_identity),
  FOREIGN KEY (decision_id) REFERENCES permission_launch_decisions(decision_id)
    ON DELETE RESTRICT,
  CHECK ((status = 'terminal') = (terminal_outcome IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS permission_effect_fences (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'user_provider_purpose')),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 512),
  protocol_generation INTEGER NOT NULL CHECK (protocol_generation > 0),
  decision_id TEXT,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_key),
  FOREIGN KEY (decision_id) REFERENCES permission_launch_decisions(decision_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS permission_generation_blocks (
  protocol_generation INTEGER PRIMARY KEY CHECK (protocol_generation > 0),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  decision_id TEXT,
  effect_identity TEXT,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES permission_launch_decisions(decision_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_one_open_transition
  ON permission_rollout_transitions((1))
  WHERE state IN ('prepared', 'closing');
CREATE INDEX IF NOT EXISTS idx_permission_decisions_open
  ON permission_launch_decisions(state, protocol_generation, updated_at_ms);
CREATE INDEX IF NOT EXISTS idx_permission_leases_active
  ON permission_admission_leases(status, protocol_generation, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_permission_reconciliation_open
  ON permission_reconciliation_items(status, updated_at_ms);
`;

const USER_AUTHORIZATION_GENERATION_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_users_authorization_generation
AFTER UPDATE OF password_hash, password_changed_at, role, status, is_active ON users
FOR EACH ROW
WHEN NEW.authorization_generation = OLD.authorization_generation
  AND (NEW.password_hash IS NOT OLD.password_hash
    OR NEW.password_changed_at IS NOT OLD.password_changed_at
    OR NEW.role IS NOT OLD.role
    OR NEW.status IS NOT OLD.status
    OR NEW.is_active IS NOT OLD.is_active)
BEGIN
  UPDATE users
  SET authorization_generation = OLD.authorization_generation + 1
  WHERE id = OLD.id AND authorization_generation = OLD.authorization_generation;
END;
`;

const API_KEY_AUTHORIZATION_GENERATION_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_api_keys_authorization_generation_insert
AFTER INSERT ON api_keys
FOR EACH ROW
BEGIN
  UPDATE users SET authorization_generation = authorization_generation + 1 WHERE id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_api_keys_authorization_generation_update
AFTER UPDATE OF is_active, key_digest ON api_keys
FOR EACH ROW
WHEN NEW.is_active IS NOT OLD.is_active OR NEW.key_digest IS NOT OLD.key_digest
BEGIN
  UPDATE users SET authorization_generation = authorization_generation + 1 WHERE id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_api_keys_authorization_generation_delete
AFTER DELETE ON api_keys
FOR EACH ROW
BEGIN
  UPDATE users SET authorization_generation = authorization_generation + 1 WHERE id = OLD.user_id;
END;
`;

const columnNames = (database: Database, table: string): Set<string> => new Set(
  (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    ({ name }) => name,
  ),
);

const tableExists = (database: Database, table: string): boolean => Boolean(
  database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table),
);

/**
 * Adds backward-compatible permission state. Re-running is a no-op and no row is removed.
 * The authorization-generation triggers keep credential and principal revocation atomic
 * with the mutation even when older repository methods perform the update.
 */
export const migratePermissionExecution = (database: Database): void => {
  database.transaction(() => {
    const hasUsers = tableExists(database, 'users');
    const hasApiKeys = tableExists(database, 'api_keys');
    const users = hasUsers ? columnNames(database, 'users') : new Set<string>();
    if (hasUsers && !users.has('authorization_generation')) {
      database.exec(
        'ALTER TABLE users ADD COLUMN authorization_generation INTEGER NOT NULL DEFAULT 1 CHECK (authorization_generation > 0)',
      );
    }
    database.exec(PERMISSION_EXECUTION_SCHEMA_SQL);
    const decisions = columnNames(database, 'permission_launch_decisions');
    for (const column of [
      'device_session_id TEXT',
      'device_slot_id TEXT',
      'device_generation INTEGER CHECK (device_generation IS NULL OR device_generation > 0)',
    ]) {
      if (!decisions.has(column.split(' ')[0])) {
        database.exec(`ALTER TABLE permission_launch_decisions ADD COLUMN ${column}`);
      }
    }
    // T-1593: effect footprint and exact child identity on the lease. Forward-only,
    // guarded so a re-run is a no-op; pre-existing leases read as 'external' (safe).
    const leases = columnNames(database, 'permission_admission_leases');
    if (!leases.has('effect_footprint')) {
      database.exec(`ALTER TABLE permission_admission_leases ADD COLUMN effect_footprint TEXT NOT NULL
        DEFAULT 'external' CHECK (effect_footprint IN ('local', 'external'))`);
    }
    for (const column of ['effect_child_pid INTEGER', 'effect_child_boot_id TEXT', 'effect_child_start_ticks TEXT']) {
      if (!leases.has(column.split(' ')[0])) {
        database.exec(`ALTER TABLE permission_admission_leases ADD COLUMN ${column}`);
      }
    }
    if (hasUsers) database.exec(USER_AUTHORIZATION_GENERATION_TRIGGER_SQL);
    if (hasUsers && hasApiKeys) {
      database.exec(API_KEY_AUTHORIZATION_GENERATION_TRIGGERS_SQL);
    }
  }).immediate();
};
