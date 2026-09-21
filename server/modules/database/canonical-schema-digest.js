import crypto from 'node:crypto';

export const CANONICAL_SCHEMA_DIGEST_SCHEMA = 'nassaj-canonical-sqlite-schema/v1';
export const CANONICAL_SCHEMA_SQL = `
  SELECT type, name, tbl_name AS tableName, coalesce(sql, '') AS sql
  FROM sqlite_schema
  WHERE name NOT LIKE 'sqlite_%'
  ORDER BY type, name, tbl_name
`;

/** Compute the one release-contract digest from an already-open SQLite handle. */
export function canonicalDatabaseSchemaDigest(db) {
  const rows = db.prepare(CANONICAL_SCHEMA_SQL).all();
  return canonicalSchemaRowsDigest(rows);
}

/** Digest canonical query rows produced by either the native driver or sqlite3 -json. */
export function canonicalSchemaRowsDigest(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
