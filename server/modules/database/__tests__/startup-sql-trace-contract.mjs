import assert from 'node:assert/strict';

// Reviewed executed security effects: order, multiplicity, method and phase are contractual.
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
const normalize = sql => sql.replace(/\s+/g, ' ').trim();
const expected = reviewedEffects.map(row => ({...row, sql:normalize(row.sql)}));
const phases = new Set(['claimed','security_startup_authorized','serving']);

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
    const tokens=sql.replace(/'(?:''|[^'])*'/g, "''");
    assert.equal(tokens.includes(';'),false,'multiple/unreviewed SQL statements');
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
