import type { Database } from 'better-sqlite3';

import {
  assertReleaseSchemaComponentTransaction,
  assertReleaseSchemaObjectsAbsent,
} from './release-schema-component-state.js';

/** ADR-169 v3: immutable, validated Codex-statistics runs. */
export const USAGE_STATISTICS_V3_TABLES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_root_authority_v3 (
    root_session_id TEXT PRIMARY KEY NOT NULL CHECK (length(root_session_id) BETWEEN 1 AND 512),
    authority_token INTEGER NOT NULL DEFAULT 0 CHECK (authority_token >= 0),
    active_run_id TEXT CHECK (active_run_id IS NULL OR length(active_run_id) BETWEEN 1 AND 512),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS usage_statistics_runs (
    run_id TEXT PRIMARY KEY NOT NULL CHECK (length(run_id) BETWEEN 1 AND 512),
    session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
    root_session_id TEXT NOT NULL CHECK (length(root_session_id) BETWEEN 1 AND 512),
    provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'superseded', 'incomplete', 'quarantined', 'failed')),
    manifest_fingerprint TEXT NOT NULL CHECK (length(manifest_fingerprint) BETWEEN 1 AND 512),
    scope_fingerprint TEXT NOT NULL CHECK (length(scope_fingerprint) BETWEEN 1 AND 512),
    attribution_fingerprint TEXT NOT NULL CHECK (length(attribution_fingerprint) BETWEEN 1 AND 512),
    metrics_fingerprint TEXT NOT NULL CHECK (length(metrics_fingerprint) BETWEEN 1 AND 512),
    pricing_version TEXT NOT NULL CHECK (length(pricing_version) BETWEEN 1 AND 256),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    authority_token INTEGER NOT NULL DEFAULT 0 CHECK (authority_token >= 0),
    parent_run_id TEXT CHECK (parent_run_id IS NULL OR length(parent_run_id) BETWEEN 1 AND 512),
    lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 512),
    lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
    fenced_by_generation INTEGER NOT NULL DEFAULT 0 CHECK (fenced_by_generation >= 0),
    evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (length(CAST(evidence_json AS BLOB)) <= 4096),
    fact_bytes INTEGER NOT NULL DEFAULT 0 CHECK (fact_bytes >= 0 AND fact_bytes <= 268435456),
    source_bytes INTEGER NOT NULL DEFAULT 0 CHECK (source_bytes >= 0 AND source_bytes <= 268435456),
    fact_count INTEGER NOT NULL DEFAULT 0 CHECK (fact_count >= 0 AND fact_count <= 500000),
    source_count INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0 AND source_count <= 256),
    lineage_count INTEGER NOT NULL DEFAULT 0 CHECK (lineage_count >= 0 AND lineage_count <= 4096),
    work_duration_ms INTEGER CHECK (work_duration_ms IS NULL OR (work_duration_ms >= 0 AND work_duration_ms <= 9007199254740991)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
    accounted_io_bytes INTEGER NOT NULL DEFAULT 0 CHECK (accounted_io_bytes BETWEEN 0 AND 268435456),
    io_budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK (io_budget_reserved IN (0, 1)),
    CHECK (fact_bytes + source_bytes <= 268435456),
    FOREIGN KEY(parent_run_id) REFERENCES usage_statistics_runs(run_id)
);
CREATE TABLE IF NOT EXISTS usage_statistics_facts (
    run_id TEXT NOT NULL,
    event_key TEXT NOT NULL CHECK (length(event_key) = 64),
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 1 AND 64),
    model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 512),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0 AND input_tokens <= 9007199254740991),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0 AND output_tokens <= 9007199254740991),
    cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0 AND cached_input_tokens <= 9007199254740991),
    request_count INTEGER NOT NULL CHECK (request_count >= 0 AND request_count <= 1000000),
    is_subagent INTEGER NOT NULL CHECK (is_subagent IN (0, 1)),
    evidence_json TEXT NOT NULL CHECK (length(CAST(evidence_json AS BLOB)) <= 4096),
    PRIMARY KEY (run_id, event_key),
    FOREIGN KEY(run_id) REFERENCES usage_statistics_runs(run_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS usage_statistics_lineage (
    run_id TEXT NOT NULL,
    root_session_id TEXT NOT NULL CHECK (length(root_session_id) BETWEEN 1 AND 512),
    parent_thread_id TEXT NOT NULL CHECK (length(parent_thread_id) BETWEEN 1 AND 512),
    spawn_call_id TEXT NOT NULL CHECK (length(spawn_call_id) BETWEEN 1 AND 512),
    agent_thread_id TEXT NOT NULL CHECK (length(agent_thread_id) BETWEEN 1 AND 512),
    child_generation INTEGER NOT NULL CHECK (child_generation >= 0),
    source_key TEXT NOT NULL CHECK (length(source_key) = 64),
    PRIMARY KEY (run_id, root_session_id, parent_thread_id, spawn_call_id, agent_thread_id, child_generation),
    FOREIGN KEY(run_id) REFERENCES usage_statistics_runs(run_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS usage_source_snapshots_v3 (
    run_id TEXT NOT NULL,
    source_identity_hash TEXT NOT NULL CHECK (length(source_identity_hash) = 64),
    source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 268435456),
    fact_count INTEGER NOT NULL CHECK (fact_count >= 0 AND fact_count <= 100000),
    terminal_vector_sha256 TEXT NOT NULL CHECK (length(terminal_vector_sha256) = 64),
    manifest_fingerprint TEXT NOT NULL CHECK (length(manifest_fingerprint) BETWEEN 1 AND 512),
    PRIMARY KEY (run_id, source_identity_hash, source_generation),
    FOREIGN KEY(run_id) REFERENCES usage_statistics_runs(run_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS usage_run_events_v3 (
    run_id TEXT NOT NULL,
    event_key_hash TEXT NOT NULL CHECK (length(event_key_hash) = 64),
    source_identity_hash TEXT NOT NULL CHECK (length(source_identity_hash) = 64),
    source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
    byte_start INTEGER NOT NULL CHECK (byte_start >= 0 AND byte_start <= 268435456),
    fact_payload_sha256 TEXT NOT NULL CHECK (length(fact_payload_sha256) = 64),
    PRIMARY KEY (run_id, event_key_hash),
    FOREIGN KEY(run_id) REFERENCES usage_statistics_runs(run_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_statistics_one_ready_root
  ON usage_statistics_runs(root_session_id, scope_fingerprint, attribution_fingerprint)
  WHERE status = 'ready' AND parent_run_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_statistics_one_ready_per_root_v3
  ON usage_statistics_runs(root_session_id) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_usage_statistics_runs_lease
  ON usage_statistics_runs(status, lease_expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_usage_statistics_facts_occurred
  ON usage_statistics_facts(run_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_source_snapshots_v3_run
  ON usage_source_snapshots_v3(run_id, source_identity_hash);
CREATE TRIGGER IF NOT EXISTS trg_usage_v3_run_fact_count_bound_insert
  BEFORE INSERT ON usage_statistics_runs WHEN NEW.fact_count > 500000
  BEGIN SELECT RAISE(ABORT, 'usage_v3_fact_count_limit'); END;
CREATE TRIGGER IF NOT EXISTS trg_usage_v3_run_fact_count_bound_update
  BEFORE UPDATE OF fact_count ON usage_statistics_runs WHEN NEW.fact_count > 500000
  BEGIN SELECT RAISE(ABORT, 'usage_v3_fact_count_limit'); END;
CREATE TRIGGER IF NOT EXISTS trg_usage_v3_run_source_count_bound_insert
  BEFORE INSERT ON usage_statistics_runs WHEN NEW.source_count > 256
  BEGIN SELECT RAISE(ABORT, 'usage_v3_source_count_limit'); END;
CREATE TRIGGER IF NOT EXISTS trg_usage_v3_run_source_count_bound_update
  BEFORE UPDATE OF source_count ON usage_statistics_runs WHEN NEW.source_count > 256
  BEGIN SELECT RAISE(ABORT, 'usage_v3_source_count_limit'); END;
CREATE TRIGGER IF NOT EXISTS trg_usage_v3_fact_rows_bound
  BEFORE INSERT ON usage_statistics_facts
  WHEN (SELECT COUNT(*) FROM usage_statistics_facts WHERE run_id = NEW.run_id) >= 500000
  BEGIN SELECT RAISE(ABORT, 'usage_v3_fact_count_limit'); END;
CREATE TRIGGER IF NOT EXISTS trg_usage_v3_source_rows_bound
  BEFORE INSERT ON usage_source_snapshots_v3
  WHEN (SELECT COUNT(*) FROM usage_source_snapshots_v3 WHERE run_id = NEW.run_id) >= 256
  BEGIN SELECT RAISE(ABORT, 'usage_v3_source_count_limit'); END;
CREATE TRIGGER IF NOT EXISTS trg_usage_v3_source_fact_count_bound
  BEFORE INSERT ON usage_source_snapshots_v3 WHEN NEW.fact_count > 100000
  BEGIN SELECT RAISE(ABORT, 'usage_v3_source_fact_count_limit'); END;
CREATE TABLE IF NOT EXISTS usage_retention_v3 (
    retention_id TEXT PRIMARY KEY NOT NULL CHECK (length(retention_id) BETWEEN 1 AND 512),
    run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 512),
    manifest_fingerprint TEXT NOT NULL CHECK (length(manifest_fingerprint) BETWEEN 1 AND 512),
    retain_until_ms INTEGER NOT NULL CHECK (retain_until_ms >= 0),
    reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) <= 4096),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(run_id, manifest_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_usage_retention_v3_expiry ON usage_retention_v3(retain_until_ms);

-- ADR-169 fenced-preflight evidence.  These tables intentionally have no
-- cascading FK: deleting a session must never erase audit evidence.
CREATE TABLE IF NOT EXISTS usage_v3_process_identities (
    process_identity_id TEXT PRIMARY KEY NOT NULL CHECK (length(process_identity_id) BETWEEN 1 AND 128),
    host_boot_id TEXT NOT NULL CHECK (length(host_boot_id) BETWEEN 1 AND 128),
    pid INTEGER NOT NULL CHECK (pid > 0),
    proc_start_ticks TEXT NOT NULL CHECK (length(proc_start_ticks) BETWEEN 1 AND 64),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(host_boot_id, pid, proc_start_ticks)
);
CREATE TABLE IF NOT EXISTS usage_v3_preflight_authorities (
    authority_id TEXT PRIMARY KEY NOT NULL CHECK (length(authority_id) BETWEEN 1 AND 128),
    owner_user_id INTEGER NOT NULL,
    provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
    root_session_id TEXT NOT NULL CHECK (length(root_session_id) BETWEEN 1 AND 512),
    scope_fingerprint TEXT NOT NULL CHECK (length(scope_fingerprint) BETWEEN 1 AND 128),
    attribution_fingerprint TEXT NOT NULL CHECK (length(attribution_fingerprint) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK (status IN ('idle', 'preflighting', 'preflight_passed', 'running', 'ready', 'superseded')),
    active_preflight_id TEXT,
    active_run_id TEXT,
    token INTEGER NOT NULL DEFAULT 0 CHECK (token >= 0),
    owner_process_identity_id TEXT,
    lease_deadline_monotonic_ns TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(owner_user_id, provider, root_session_id, scope_fingerprint, attribution_fingerprint),
    FOREIGN KEY(owner_process_identity_id) REFERENCES usage_v3_process_identities(process_identity_id)
);
CREATE TABLE IF NOT EXISTS usage_v3_preflight_receipts (
    receipt_id TEXT PRIMARY KEY NOT NULL CHECK (length(receipt_id) BETWEEN 1 AND 128),
    authority_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
    parent_receipt_id TEXT,
    owner_user_id INTEGER NOT NULL,
    root_session_id TEXT NOT NULL CHECK (length(root_session_id) BETWEEN 1 AND 512),
    status TEXT NOT NULL CHECK (status IN ('building', 'passed', 'quarantined', 'failed', 'superseded')),
    source_root_hex TEXT,
    topology_root_hex TEXT,
    root_source_identity_hash TEXT,
    envelope_json TEXT NOT NULL DEFAULT '{}' CHECK (length(CAST(envelope_json AS BLOB)) <= 4096),
    retain_until_ms INTEGER,
    created_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (created_at_ms >= 0),
    failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
    terminal_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(authority_id, attempt_no),
    FOREIGN KEY(authority_id) REFERENCES usage_v3_preflight_authorities(authority_id),
    FOREIGN KEY(parent_receipt_id) REFERENCES usage_v3_preflight_receipts(receipt_id)
);
CREATE TABLE IF NOT EXISTS usage_v3_preflight_sources (
    receipt_id TEXT NOT NULL,
    source_identity_hash TEXT NOT NULL CHECK (length(source_identity_hash) = 64),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    descriptor_json TEXT NOT NULL CHECK (length(CAST(descriptor_json AS BLOB)) <= 4096),
    parent_source_identity_hash TEXT,
    edge_type TEXT CHECK (edge_type IS NULL OR edge_type = 'spawn'),
    PRIMARY KEY(receipt_id, source_identity_hash),
    FOREIGN KEY(receipt_id) REFERENCES usage_v3_preflight_receipts(receipt_id)
);
CREATE TABLE IF NOT EXISTS usage_v3_canonical_runs (
    run_id TEXT PRIMARY KEY NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
    authority_id TEXT NOT NULL,
    preflight_receipt_id TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL,
    root_session_id TEXT NOT NULL CHECK (length(root_session_id) BETWEEN 1 AND 512),
    status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed', 'quarantined', 'superseded')),
    retain_until_ms INTEGER NOT NULL CHECK (retain_until_ms >= 0),
    failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
    metrics_fingerprint TEXT NOT NULL DEFAULT '' CHECK (length(metrics_fingerprint) <= 512),
    pricing_version TEXT NOT NULL DEFAULT '' CHECK (length(pricing_version) <= 256),
    envelope_json TEXT NOT NULL DEFAULT '{}' CHECK (length(CAST(envelope_json AS BLOB)) <= 4096),
    work_duration_ms INTEGER CHECK (work_duration_ms IS NULL OR (work_duration_ms >= 0 AND work_duration_ms <= 9007199254740991)),
    fact_count INTEGER NOT NULL DEFAULT 0 CHECK (fact_count BETWEEN 0 AND 500000),
    fact_bytes INTEGER NOT NULL DEFAULT 0 CHECK (fact_bytes BETWEEN 0 AND 268435456),
    lineage_count INTEGER NOT NULL DEFAULT 0 CHECK (lineage_count BETWEEN 0 AND 512),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    FOREIGN KEY(authority_id) REFERENCES usage_v3_preflight_authorities(authority_id),
    FOREIGN KEY(preflight_receipt_id) REFERENCES usage_v3_preflight_receipts(receipt_id)
);
CREATE TABLE IF NOT EXISTS usage_v3_canonical_facts (
    run_id TEXT NOT NULL,
    event_key TEXT NOT NULL CHECK (length(event_key) = 64),
    source_identity_hash TEXT NOT NULL CHECK (length(source_identity_hash) = 64),
    source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
    byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 1 AND 64),
    model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 512),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
    request_count INTEGER NOT NULL CHECK (request_count >= 0),
    is_subagent INTEGER NOT NULL CHECK (is_subagent IN (0, 1)),
    evidence_json TEXT NOT NULL CHECK (length(CAST(evidence_json AS BLOB)) <= 4096),
    PRIMARY KEY(run_id, event_key),
    FOREIGN KEY(run_id) REFERENCES usage_v3_canonical_runs(run_id)
);
CREATE TABLE IF NOT EXISTS usage_v3_canonical_lineage (
    run_id TEXT NOT NULL,
    parent_source_identity_hash TEXT NOT NULL CHECK (length(parent_source_identity_hash) = 64),
    child_source_identity_hash TEXT NOT NULL CHECK (length(child_source_identity_hash) = 64),
    edge_type TEXT NOT NULL CHECK (edge_type = 'spawn'),
    PRIMARY KEY(run_id, parent_source_identity_hash, child_source_identity_hash),
    FOREIGN KEY(run_id) REFERENCES usage_v3_canonical_runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_v3_canonical_facts_time ON usage_v3_canonical_facts(run_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_v3_receipts_cleanup
  ON usage_v3_preflight_receipts(retain_until_ms, status);
CREATE INDEX IF NOT EXISTS idx_usage_v3_runs_receipt
  ON usage_v3_canonical_runs(preflight_receipt_id, status);
`;


export const USAGE_STATISTICS_V3_OWNED_OBJECTS = Object.freeze([
  'idx_usage_retention_v3_expiry',
  'idx_usage_source_snapshots_v3_run',
  'idx_usage_statistics_facts_occurred',
  'idx_usage_statistics_one_ready_per_root_v3',
  'idx_usage_statistics_one_ready_root',
  'idx_usage_statistics_runs_lease',
  'idx_usage_v3_canonical_facts_time',
  'idx_usage_v3_receipts_cleanup',
  'idx_usage_v3_runs_receipt',
  'trg_usage_v3_fact_rows_bound',
  'trg_usage_v3_run_fact_count_bound_insert',
  'trg_usage_v3_run_fact_count_bound_update',
  'trg_usage_v3_run_source_count_bound_insert',
  'trg_usage_v3_run_source_count_bound_update',
  'trg_usage_v3_source_fact_count_bound',
  'trg_usage_v3_source_rows_bound',
  'usage_retention_v3',
  'usage_root_authority_v3',
  'usage_run_events_v3',
  'usage_source_snapshots_v3',
  'usage_statistics_facts',
  'usage_statistics_lineage',
  'usage_statistics_runs',
  'usage_v3_canonical_facts',
  'usage_v3_canonical_lineage',
  'usage_v3_canonical_runs',
  'usage_v3_preflight_authorities',
  'usage_v3_preflight_receipts',
  'usage_v3_preflight_sources',
  'usage_v3_process_identities',
]);

/** Execute the canonical additive usage-v3 DDL against an explicitly supplied database. */
export function createUsageStatisticsV3Fresh(db: Database): void {
  db.exec(USAGE_STATISTICS_V3_TABLES_SCHEMA_SQL);
}

/** Apply usage-v3 only from its reviewed all-absent source state. */
export function applyUsageStatisticsV3Component(db: Database): void {
  assertReleaseSchemaComponentTransaction(db);
  assertReleaseSchemaObjectsAbsent(db, 'usage-statistics-v3', USAGE_STATISTICS_V3_OWNED_OBJECTS);
  createUsageStatisticsV3Fresh(db);
}
