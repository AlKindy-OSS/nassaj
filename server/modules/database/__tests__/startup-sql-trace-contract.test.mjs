import assert from 'node:assert/strict';
import test from 'node:test';
import {assertStartupSqlTrace} from './startup-sql-trace-contract.mjs';
const baseline = [
  {
    "phase": "security_startup_authorized",
    "method": "exec",
    "sql": "CREATE TABLE IF NOT EXISTS scheduled_messages (\n    id TEXT PRIMARY KEY NOT NULL,\n    user_id INTEGER NOT NULL,\n    session_id TEXT NOT NULL,\n    content TEXT NOT NULL,\n    options_json TEXT NOT NULL DEFAULT '{}',\n    scheduled_for TEXT NOT NULL,\n    available_at TEXT NOT NULL,\n    status TEXT NOT NULL DEFAULT 'pending'\n      CHECK (status IN ('pending', 'running', 'sent', 'failed', 'cancelled')),\n    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),\n    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),\n    lease_token TEXT,\n    lease_expires_at TEXT,\n    last_error_code TEXT,\n    sent_at TEXT,\n    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,\n    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE\n)",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "all",
    "sql": "PRAGMA table_info(scheduled_messages)",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "exec",
    "sql": "CREATE INDEX IF NOT EXISTS idx_scheduled_messages_user_status\n      ON scheduled_messages(user_id, status, scheduled_for DESC)",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "exec",
    "sql": "CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due\n      ON scheduled_messages(status, available_at, lease_expires_at)",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "exec",
    "sql": "CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_messages_lease_token\n      ON scheduled_messages(lease_token) WHERE lease_token IS NOT NULL",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "exec",
    "sql": "CREATE TABLE IF NOT EXISTS device_sessions (\n      id TEXT PRIMARY KEY,\n      secret_hash TEXT NOT NULL UNIQUE,\n      expires_at INTEGER NOT NULL,\n      revoked_at INTEGER,\n      active_slot_id TEXT,\n      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),\n      created_at INTEGER NOT NULL,\n      FOREIGN KEY (active_slot_id) REFERENCES device_account_slots(id)\n    );\n    CREATE TABLE IF NOT EXISTS device_account_slots (\n      id TEXT PRIMARY KEY,\n      device_session_id TEXT NOT NULL,\n      user_id INTEGER NOT NULL,\n      created_at INTEGER NOT NULL,\n      last_used_at INTEGER NOT NULL,\n      password_stamp INTEGER NOT NULL,\n      revoked_at INTEGER,\n      FOREIGN KEY (device_session_id) REFERENCES device_sessions(id) ON DELETE CASCADE,\n      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,\n      UNIQUE(device_session_id, user_id)\n    );\n    CREATE INDEX IF NOT EXISTS idx_device_slots_session ON device_account_slots(device_session_id, revoked_at);\n    CREATE TRIGGER IF NOT EXISTS device_session_active_slot_valid_insert\n    BEFORE INSERT ON device_sessions WHEN NEW.active_slot_id IS NOT NULL AND NOT EXISTS (\n      SELECT 1 FROM device_account_slots WHERE id=NEW.active_slot_id AND device_session_id=NEW.id AND revoked_at IS NULL\n    ) BEGIN SELECT RAISE(ABORT, 'device_active_slot_invalid'); END;\n    CREATE TRIGGER IF NOT EXISTS device_session_active_slot_valid_update\n    BEFORE UPDATE OF active_slot_id ON device_sessions WHEN NEW.active_slot_id IS NOT NULL AND NOT EXISTS (\n      SELECT 1 FROM device_account_slots WHERE id=NEW.active_slot_id AND device_session_id=NEW.id AND revoked_at IS NULL\n    ) BEGIN SELECT RAISE(ABORT, 'device_active_slot_invalid'); END;\n    CREATE TRIGGER IF NOT EXISTS device_slot_cannot_revoke_active\n    BEFORE UPDATE OF revoked_at ON device_account_slots WHEN NEW.revoked_at IS NOT NULL AND EXISTS (\n      SELECT 1 FROM device_sessions WHERE active_slot_id=OLD.id AND revoked_at IS NULL\n    ) BEGIN SELECT RAISE(ABORT, 'device_active_slot_revocation'); END;",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "all",
    "sql": "PRAGMA table_info(device_sessions)",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "all",
    "sql": "PRAGMA table_info(device_account_slots)",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "exec",
    "sql": "CREATE TABLE IF NOT EXISTS document_shares (\n    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, relative_path TEXT NOT NULL,\n    audience TEXT NOT NULL CHECK(audience IN ('members','client')), token_hash TEXT,\n    root_dev TEXT NOT NULL, root_ino TEXT NOT NULL, created_by INTEGER NOT NULL,\n    created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, source_missing_at TEXT,\n    FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE\n  )",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "exec",
    "sql": "CREATE INDEX IF NOT EXISTS document_shares_project ON document_shares(project_id)",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "run",
    "sql": "UPDATE connector_runtime_anchor SET\n    maximum_fencing_token = ?, maximum_writer_epoch = ?, clock_high_water_ms = ?, authority_mac = ?\n    WHERE singleton = 1 AND authority_mac = ?",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "run",
    "sql": "UPDATE connector_runtime_control SET\n    last_fencing_token = ?, last_clock_ms = ?, authority_mac = ?\n    WHERE singleton = 1 AND authority_mac = ?",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "run",
    "sql": "INSERT INTO connector_runtime_writer_lease (\n    singleton, owner_token, acquisition_nonce, lease_generation, fencing_token,\n    writer_epoch, expires_at_ms, authority_mac\n  ) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET\n    owner_token = excluded.owner_token, acquisition_nonce = excluded.acquisition_nonce,\n    lease_generation = excluded.lease_generation, fencing_token = excluded.fencing_token,\n    writer_epoch = excluded.writer_epoch, expires_at_ms = excluded.expires_at_ms,\n    authority_mac = excluded.authority_mac",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "run",
    "sql": "INSERT OR IGNORE INTO turn_supervisor_recovery (run_id)\n       SELECT run_id FROM turn_supervisor_runs WHERE state != 'terminal'",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "run",
    "sql": "INSERT OR IGNORE INTO turn_supervisor_recovery (run_id)\n       SELECT run_id FROM turn_supervisor_runs WHERE state != 'terminal'",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "run",
    "sql": "UPDATE turn_resource_leases SET heartbeat_at_ms = ? WHERE owner_id = ? AND status = 'active'",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "run",
    "sql": "UPDATE turn_resource_leases SET heartbeat_at_ms = ? WHERE owner_id = ? AND status = 'active'",
    "shadow": null
  }
];
const copy=()=>structuredClone(baseline);
test('reviewed startup effects and explicit connection-local/read PRAGMAs pass',()=>{
  const rows=copy();
  rows.unshift({phase:'claimed',method:'pragma',sql:'foreign_keys = ON',shadow:null},
    {phase:'claimed',method:'pragma',sql:'journal_mode',shadow:null},
    {phase:'claimed',method:'all',sql:'SELECT name FROM sqlite_schema',shadow:null});
  assert.equal(assertStartupSqlTrace(rows).length,7);
});
for(const [name,modify] of [
  ['extra statement appended to the reviewed multi-statement exec',rows=>{
    const row=rows.find(item=>item.sql.startsWith('CREATE TABLE IF NOT EXISTS device_sessions'));
    row.sql+='; DROP TABLE users;';}],
  ['reviewed multi-statement text through a non-exec method',rows=>{
    rows.find(item=>item.sql.startsWith('CREATE TABLE IF NOT EXISTS device_sessions')).method='run';}],
  ['broad UPDATE same table',rows=>{rows.find(row=>row.method==='run').sql='UPDATE connector_runtime_anchor SET authority_mac = ?';}],
  ['extra reviewed DML',rows=>rows.push({...rows.find(row=>row.method==='run')})],
  ['WITH write',rows=>rows.push({...rows[0],sql:'WITH x AS (SELECT 1) DELETE FROM connector_runtime_anchor'})],
  ['unreviewed WITH read',rows=>rows.push({...rows[0],method:'all',sql:'WITH x AS (SELECT 1) SELECT * FROM x'})],
  ['mutating PRAGMA method',rows=>rows.push({...rows[0],method:'pragma',sql:'journal_mode = DELETE'})],
  ['mutating PRAGMA SQL',rows=>rows.push({...rows[0],method:'get',sql:'PRAGMA user_version = 99'})],
  ['checkpoint PRAGMA',rows=>rows.push({...rows[0],method:'pragma',sql:'wal_checkpoint(TRUNCATE)'})],
  ['claimed phase write',rows=>{rows[0].phase='claimed';}],
  ['wrong serving phase',rows=>{rows[0].phase='serving';}],
  ['unknown phase',rows=>{rows[0].phase='unknown';}],
  ['missing DML',rows=>rows.pop()],
  ['wrong execution method',rows=>{rows.find(row=>row.method==='run').method='exec';}],
  ['missing scheduled column probe',rows=>rows.splice(1,1)],
  ['duplicate scheduled column probe',rows=>rows.splice(1,0,{...rows[1]})],
  ['scheduled column probe before table creation',rows=>rows.unshift(rows.splice(1,1)[0])],
  ['scheduled column probe before admission',rows=>{rows[1].phase='claimed';}],
  ['wrong scheduled column probe method',rows=>{rows[1].method='get';}],
  ['second SELECT statement write',rows=>rows.push({...rows[0],method:'all',sql:'SELECT 1; DELETE FROM connector_runtime_anchor'})],
  ['env reload',rows=>{rows[0].shadow='1';}],
]) test(`reject ${name}`,()=>{const rows=copy();modify(rows);assert.throws(()=>assertStartupSqlTrace(rows));});
