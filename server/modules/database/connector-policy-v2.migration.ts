/** Additive Substrate-Only persistence for ADR-132 M0-M5. */

import { createHash } from 'node:crypto';

import type { Database } from 'better-sqlite3';

/* eslint-disable boundaries/dependencies -- canonical additive migration derives SQL from inert M3-M5 owners. */
import { CONNECTOR_INSTALLATION_READINESS_V2_SCHEMA_SQL } from '../connectors/connector-installation-readiness-v2.js';
import { CONNECTOR_MIGRATION_V2_SCHEMA_SQL } from '../connectors/connector-migration-v2.js';
import { CONNECTOR_POLICY_V2_STORE_SCHEMA_SQL } from '../connectors/connector-policy-v2-store.js';
import { CONNECTOR_SETUP_STORE_SCHEMA_SQL } from '../connectors/connector-setup-store.js';
import type { ConnectorPolicyState } from '../connectors/connector-policy-v2.js';
/* eslint-enable boundaries/dependencies */

const INSTALLATION_UUID_SQL = `lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
  '4' || substr(lower(hex(randomblob(2))),2) || '-' ||
  substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' ||
  lower(hex(randomblob(6)))`;

export const CONNECTOR_POLICY_V2_SUBSTRATE_SCHEMA_SQL = `
${CONNECTOR_POLICY_V2_STORE_SCHEMA_SQL}
${CONNECTOR_MIGRATION_V2_SCHEMA_SQL}
${CONNECTOR_INSTALLATION_READINESS_V2_SCHEMA_SQL}
${CONNECTOR_SETUP_STORE_SCHEMA_SQL}
CREATE TABLE IF NOT EXISTS connector_policy_v2_substrate (
  installation_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode = 'substrate_only'),
  production_manifest_active INTEGER NOT NULL CHECK (production_manifest_active = 0),
  stored_unverified_creation_enabled INTEGER NOT NULL CHECK (stored_unverified_creation_enabled = 0),
  provider_activation_enabled INTEGER NOT NULL CHECK (provider_activation_enabled = 0),
  runtime_floor INTEGER NOT NULL CHECK (runtime_floor = 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const noManifestDigest = (): string => createHash('sha512')
  .update('NASSAJ\0CONNECTOR_POLICY_V2\0SUBSTRATE_ONLY\0NO_PRODUCTION_MANIFEST\0')
  .digest('base64url');

export const initialConnectorPolicyV2SubstrateState = (): ConnectorPolicyState => Object.freeze({
  policySchemaVersion: 2, policyEpoch: 1, registryRevision: 'substrate-only',
  certificationManifestDigest: noManifestDigest(), installationMode: 'portable_default',
  originRevision: 1, killRevision: 0, writerEpoch: 1,
  kills: Object.freeze({ global: false, providers: Object.freeze([]), serviceOperations: Object.freeze([]) }),
});

const installationId = (database: Database): string => {
  const row = database.prepare(`SELECT installation_id AS installationId
    FROM connector_installations WHERE singleton = 1`).get() as { installationId: string } | undefined;
  if (row) return row.installationId;
  database.prepare(`INSERT INTO connector_installations (installation_id,singleton)
    VALUES (${INSTALLATION_UUID_SQL},1)`).run();
  const created = database.prepare(`SELECT installation_id AS installationId
    FROM connector_installations WHERE singleton = 1`).get() as { installationId: string } | undefined;
  if (!created) throw new Error('connector_substrate_installation_missing');
  return created.installationId;
};

/** Creates only empty substrate tables and one fail-closed policy row; no legacy data is read. */
export const migrateConnectorPolicyV2Substrate = (database: Database): string => {
  const migrate = database.transaction(() => {
    database.exec(CONNECTOR_POLICY_V2_SUBSTRATE_SCHEMA_SQL);
    const id = installationId(database);
    const current = database.prepare(`SELECT 1 FROM connector_policy_v2_state
      WHERE installation_id = ?`).get(id);
    if (!current) {
      const state = initialConnectorPolicyV2SubstrateState();
      database.prepare(`INSERT INTO connector_policy_v2_state
        (installation_id,state_json,kill_revision) VALUES (?,?,0)`).run(id, JSON.stringify(state));
    }
    database.prepare(`INSERT OR IGNORE INTO connector_policy_v2_substrate
      (installation_id,mode,production_manifest_active,stored_unverified_creation_enabled,
       provider_activation_enabled,runtime_floor) VALUES (?,'substrate_only',0,0,0,1)`).run(id);
    return id;
  });
  return migrate.immediate();
};

export const CONNECTOR_POLICY_V2_SUBSTRATE_TABLES = Object.freeze(Array.from(
  CONNECTOR_POLICY_V2_SUBSTRATE_SCHEMA_SQL.matchAll(
    /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z0-9_]+)\s*\(/giu,
  ), match => match[1]).sort());
