import assert from 'node:assert/strict';

// Reviewed executed security effects: order, multiplicity, method and phase are contractual.
// The device-wallet schema (15098dccc) is the one reviewed multi-statement exec: its
// triggers need `;` inside BEGIN/END, so it is admitted only by exact reviewed text.
// ADR-194 (T-1962): the four additive SSO DDL statements (one per exec) and the
// two TTL sweeps of expired test evidence at boot are reviewed effects too.
const reviewedEffects = [
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
    "method": "exec",
    "sql": "CREATE TABLE IF NOT EXISTS sso_oidc_config (\n  slot TEXT PRIMARY KEY CHECK (slot IN ('active','draft')),\n  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),\n  issuer TEXT NOT NULL,\n  client_id TEXT NOT NULL,\n  client_auth TEXT NOT NULL\n    CHECK (client_auth IN ('none','client_secret_basic','client_secret_post')),\n  client_secret_enc TEXT,\n  secret_version INTEGER NOT NULL DEFAULT 0,\n  extra_scopes TEXT NOT NULL DEFAULT '',\n  redirect_uri TEXT,\n  role_claim_path TEXT NOT NULL,\n  role_rules_json TEXT NOT NULL,\n  tenant_mode TEXT NOT NULL CHECK (tenant_mode IN ('none','claim','role_grant_scope')),\n  tenant_claim_path TEXT,\n  tenant_values_json TEXT NOT NULL DEFAULT '[]',\n  jit_enabled INTEGER NOT NULL DEFAULT 0 CHECK (jit_enabled IN (0,1)),\n  attestation_max_age_hours INTEGER NOT NULL DEFAULT 12\n    CHECK (attestation_max_age_hours BETWEEN 1 AND 24),\n  allow_private_network INTEGER NOT NULL DEFAULT 0 CHECK (allow_private_network IN (0,1)),\n  issuer_port INTEGER CHECK (issuer_port IS NULL OR issuer_port BETWEEN 1 AND 65535),\n  pinned_endpoints_json TEXT,\n  discovery_flags_json TEXT,\n  runtime_fault TEXT,\n  config_hash TEXT NOT NULL,\n  draft_version INTEGER NOT NULL DEFAULT 0,\n  version INTEGER NOT NULL DEFAULT 0,\n  updated_at INTEGER,\n  updated_by INTEGER\n)",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "exec",
    "sql": "CREATE TABLE IF NOT EXISTS sso_test_results (\n  id TEXT PRIMARY KEY CHECK (length(id) = 43),\n  owner_user_id INTEGER NOT NULL,\n  config_hash TEXT NOT NULL,\n  result_json TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  consumed_at INTEGER\n)",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "exec",
    "sql": "CREATE TABLE IF NOT EXISTS sso_apply_proofs (\n  id INTEGER PRIMARY KEY,\n  owner_user_id INTEGER NOT NULL,\n  config_hash TEXT NOT NULL,\n  draft_version INTEGER NOT NULL,\n  kind TEXT NOT NULL CHECK (kind IN ('discovery','sign_in')),\n  passed INTEGER NOT NULL CHECK (passed IN (0,1)),\n  shape_flags TEXT,\n  created_at INTEGER NOT NULL\n)",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "exec",
    "sql": "CREATE INDEX IF NOT EXISTS idx_sso_apply_proofs_binding\n  ON sso_apply_proofs (owner_user_id, config_hash, draft_version, kind)",
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
    "sql": "DELETE FROM sso_test_results WHERE created_at <= ?",
    "shadow": null
  },
  {
    "phase": "security_startup_authorized",
    "method": "run",
    "sql": "DELETE FROM sso_apply_proofs WHERE created_at <= ?",
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
const normalize = sql => sql.replace(/\s+/g, ' ').trim();
const expected = reviewedEffects.map(row => ({...row, sql:normalize(row.sql)}));
const phases = new Set(['claimed','security_startup_authorized','serving']);
const withoutLiterals = sql => sql.replace(/'(?:''|[^'])*'/g, "''");
const reviewedMultiStatement = new Set(expected
  .filter(row => row.method === 'exec' && withoutLiterals(row.sql).includes(';'))
  .map(row => row.sql));

/** Assert the finite pre-serving SQL contract, including connection-local PRAGMA effects. */
export function assertStartupSqlTrace(rows) {
  assert.ok(Array.isArray(rows) && rows.length > 0, 'missing SQL trace');
  const effects=[];
  let serving=false;
  for(const row of rows) {
    assert.ok(phases.has(row.phase), 'unknown SQL phase');
    assert.equal(row.shadow,null,'application reloaded changed .env');
    if(row.phase==='serving') {serving=true;continue;}
    assert.equal(serving,false,'SQL phase regressed');
    const sql=normalize(row.sql);
    // Values inside SQL literals are removed before checking for extra statements.
    const tokens=withoutLiterals(sql);
    const reviewedExec=row.method==='exec' && reviewedMultiStatement.has(sql);
    assert.equal(tokens.includes(';') && !reviewedExec,false,'multiple/unreviewed SQL statements');
    if(/^SELECT\b/i.test(sql)) {
      assert.ok(['get','all','iterate'].includes(row.method),'unreviewed SELECT execution method');
      assert.equal(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|DETACH|VACUUM|PRAGMA)\b/i.test(tokens),false,'unreviewed SELECT effects');
      continue;
    }
    // journal_mode without assignment is a read; foreign_keys=ON is a reviewed
    // connection-local setting, not a license for journal/checkpoint/schema changes.
    if(row.method==='pragma' && ['journal_mode','foreign_keys = ON'].includes(sql)) continue;
    if(row.phase==='security_startup_authorized' && row.method==='all'
      && ['PRAGMA table_info(turn_supervisor_hosted_results)','PRAGMA table_info(turn_supervisor_hosted_context)'].includes(sql)) continue;
    assert.equal(row.phase,'security_startup_authorized','SQL effect before security admission');
    effects.push({...row,sql});
  }
  assert.deepEqual(effects,expected,'unreviewed startup SQL effects, order, count or phase');
  return rows.filter(row => row.phase==='security_startup_authorized' && row.method==='run');
}
