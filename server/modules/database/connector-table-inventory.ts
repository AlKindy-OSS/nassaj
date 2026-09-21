/** Canonical connector table inventory derived from the schema sources themselves. */

import { CONNECTOR_AUTH_SCHEMA_SQL } from './connector-auth.migration.js';
import { CONNECTOR_POLICY_V2_SUBSTRATE_SCHEMA_SQL } from './connector-policy-v2.migration.js';
import {
  CONNECTORS_TABLE_SCHEMA_SQL,
  CONNECTOR_OAUTH_PENDING_TABLE_SCHEMA_SQL,
  CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL,
} from './schema.js';

const CONNECTOR_SCHEMA_FRAGMENTS = Object.freeze([
  CONNECTORS_TABLE_SCHEMA_SQL, CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL,
  CONNECTOR_OAUTH_PENDING_TABLE_SCHEMA_SQL, CONNECTOR_AUTH_SCHEMA_SQL,
  CONNECTOR_POLICY_V2_SUBSTRATE_SCHEMA_SQL,
]);

const tableNamesFromSchema = (sql: string): string[] => Array.from(sql.matchAll(
  /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["`]?(connector[a-z0-9_]*)["`]?\s*\(/giu,
), match => match[1]);

const names = CONNECTOR_SCHEMA_FRAGMENTS.flatMap(tableNamesFromSchema);
if (new Set(names).size !== names.length) throw new Error('connector_schema_table_inventory_duplicate');

export const CONNECTOR_SCHEMA_TABLE_INVENTORY: readonly string[] = Object.freeze([...names].sort());
