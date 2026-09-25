import type { Database } from 'better-sqlite3';

const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/;
const OBJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Require the existing child-owned transaction without opening a nested transaction. */
export function assertReleaseSchemaComponentTransaction(db: Database): void {
  if (!db.inTransaction) throw new Error('release_schema_component_transaction_required');
}

/** Require every component-owned SQLite object to be absent before additive DDL runs. */
export function assertReleaseSchemaObjectsAbsent(
  db: Database,
  componentId: string,
  ownedObjectNames: readonly string[],
): void {
  if (componentId.length > 128 || !COMPONENT_ID.test(componentId)
    || ownedObjectNames.length === 0 || ownedObjectNames.length > 256) {
    throw new Error('release_schema_component_definition_invalid');
  }
  const uniqueNames = new Set(ownedObjectNames);
  if (uniqueNames.size !== ownedObjectNames.length
    || ownedObjectNames.some((name) => !OBJECT_NAME.test(name))) {
    throw new Error('release_schema_component_definition_invalid');
  }
  const placeholders = ownedObjectNames.map(() => '?').join(',');
  const present = db.prepare(
    `SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`,
  ).all(...ownedObjectNames) as Array<{ name: string }>;
  if (present.length !== 0) {
    throw new Error(`release_schema_component_source_invalid:${componentId}`);
  }
}
