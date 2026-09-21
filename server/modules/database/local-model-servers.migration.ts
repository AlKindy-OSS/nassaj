import type { Database } from 'better-sqlite3';

/** Additive ADR-163 schema; called only by the approved startup migration path. */
export function migrateLocalModelServers(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS local_model_servers (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    runtime TEXT NOT NULL,
    models_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); CREATE INDEX IF NOT EXISTS idx_local_model_servers_owner ON local_model_servers(owner_id);`);
}

/** Explicit rollback; never invoked automatically or against live data. */
export function rollbackLocalModelServers(db: Database): void {
  db.exec('DROP TABLE IF EXISTS local_model_servers');
}
