import { createHash } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3';

import { canonicalDatabaseSchemaDigest } from './canonical-schema-digest.js';

export const COMPATIBLE_FORWARD_OBSERVATION_POLICY = 'permission-receipt-metadata/v1';
const MARKERS = Object.freeze([
  'migration.session_workspace_modes.snapshot.v1',
  'source_update_v1_migration_completed_at',
  'participants_backfill_completed_at',
  'participants_ownership_repaired_at',
]);
const metadataDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Observe schema and marker presence only; this does not attest security readiness or user data. */
export function observeCompatibleForwardDatabase(db: BetterSqlite3.Database) {
  const objects = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all() as Array<{type:string; name:string}>;
  const tables = objects.filter(row => row.type === 'table').map(row => ({
    name: row.name,
    columns: db.prepare('SELECT * FROM pragma_table_xinfo(?)').all(row.name),
    foreignKeys: db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(row.name),
  }));
  const indexes = objects.filter(row => row.type === 'index').map(row => ({
    name: row.name, columns: db.prepare('SELECT * FROM pragma_index_xinfo(?)').all(row.name),
  }));
  const markers = MARKERS.map(key => ({key, present: objects.some(row => row.name === 'app_config' && row.type === 'table')
    && !!db.prepare('SELECT 1 FROM app_config WHERE key = ?').get(key)}));
  const columnMetadata = (table: string, name: string) => {
    const column = (tables.find(row => row.name === table)?.columns as Array<Record<string, unknown>> | undefined)
      ?.find(row => row.name === name);
    return { table, name, metadata: column ?? null };
  };
  const delta = [columnMetadata('pending_server_actions', 'execution_attempt_nonce'),
    ...['effect_footprint', 'effect_child_pid', 'effect_child_boot_id', 'effect_child_start_ticks']
      .map(name => columnMetadata('permission_admission_leases', name)),
    columnMetadata('message_coordination_ingress', 'accepted_at')];
  const fences = tables.find(row => row.name === 'permission_effect_fences') ?? null;
  return Object.freeze({schemaDigest:canonicalDatabaseSchemaDigest(db),
    compatibilityShapeDigest:metadataDigest({schema:'nassaj-compatible-forward-shape/v1',objects,tables,indexes}),
    migrationStateDigest:metadataDigest({schema:'nassaj-compatible-forward-permission-receipt-state/v1',
      migrationId:'permission-receipt-forward/v1',markers,delta,fences})});
}

