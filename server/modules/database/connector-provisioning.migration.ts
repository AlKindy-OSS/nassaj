/** Additive, empty persistence for ADR-162 provisioning attempts. */

import type { Database } from 'better-sqlite3';

/* eslint-disable boundaries/dependencies -- canonical additive migration owns this inert schema. */
import { CONNECTOR_PROVISIONING_SCHEMA_SQL } from '../connectors/connector-provisioning.service.js';
/* eslint-enable boundaries/dependencies */

/** Creates resumable state only. Eligibility is written solely in the fresh-install creation transaction. */
export const migrateConnectorProvisioning = (database: Database, input: Readonly<{
  newInstallationId?: string; nowMs?: number;
}> = {}): void => {
  database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL);
  if (input.newInstallationId) {
    database.prepare(`INSERT INTO connector_provisioning_installation_eligibility
      (installation_id,eligible,created_at_ms) VALUES (?,1,?) ON CONFLICT(installation_id) DO NOTHING`)
      .run(input.newInstallationId, input.nowMs ?? Date.now());
  }
};
