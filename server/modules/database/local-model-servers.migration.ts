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
  // ADR-227 / T-2098: the IP literal where the owner's last connection test passed;
  // NULL = never tested (or reset by a base URL edit). Additive and idempotent.
  const columns = db.prepare('PRAGMA table_info(local_model_servers)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'verified_address')) {
    db.exec('ALTER TABLE local_model_servers ADD COLUMN verified_address TEXT');
  }
}

/** Explicit rollback; never invoked automatically or against live data. */
export function rollbackLocalModelServers(db: Database): void {
  db.exec('DROP TABLE IF EXISTS local_model_servers');
}
