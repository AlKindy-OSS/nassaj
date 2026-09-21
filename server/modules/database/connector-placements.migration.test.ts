import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { migrateConnectorPlacements } from '@/modules/database/migrations.js';
import { createConnectorPlacementsDb } from '@/modules/database/repositories/connector-placements.db.js';
import {
  CONNECTORS_TABLE_SCHEMA_SQL,
  CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL,
  INIT_SCHEMA_SQL,
} from '@/modules/database/schema.js';

/**
 * Builds the schema under test without running the production boot lifecycle.
 * `initializeDatabase()` installs the runtime writer fence, while this suite
 * deliberately exercises the additive placement migration in isolation.
 */
function initializePlacementMigrationFixture(): void {
  const db = getConnection();
  db.pragma('foreign_keys = ON');
  db.exec(INIT_SCHEMA_SQL);
  db.exec(CONNECTORS_TABLE_SCHEMA_SQL);
  db.exec(CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL);
}

test('connector placements migration is additive, empty, fenced, and non-cascading', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp('/var/tmp/connector-placements-migration-');
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await writeFile(process.env.DATABASE_PATH, '');
  closeConnection();
  initializePlacementMigrationFixture();

  try {
    const db = getConnection();
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('owner', 'hash', 'owner')").run();
    const userId = (db.prepare("SELECT id FROM users WHERE username = 'owner'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO connectors (
         id, service, display_name, credential_mode, owner_user_id, created_by
       ) VALUES (?, ?, ?, 'per_member', ?, ?)`,
    ).run('github-u1', 'github', 'GitHub', userId, userId);

    // Simulate the pre-ledger fleet shape and prove the migration does not
    // rebuild or rewrite the existing connectors registry.
    db.exec('DROP TABLE connector_placements');
    const connectorTableBefore = db.prepare(
      "SELECT rootpage, sql FROM sqlite_master WHERE type = 'table' AND name = 'connectors'",
    ).get() as { rootpage: number; sql: string };
    const connectorRowBefore = db.prepare('SELECT * FROM connectors WHERE id = ?').get('github-u1');

    migrateConnectorPlacements(db);

    assert.deepEqual(
      db.prepare("SELECT rootpage, sql FROM sqlite_master WHERE type = 'table' AND name = 'connectors'").get(),
      connectorTableBefore,
      'the additive migration must not rebuild connectors',
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM connectors WHERE id = ?').get('github-u1'),
      connectorRowBefore,
      'the migration must not backfill or mutate connector rows',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM connector_placements').get() as { count: number }).count,
      0,
      'the new ledger starts empty; no backfill is authorized',
    );

    const columns = db.prepare('PRAGMA table_info(connector_placements)').all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    for (const key of ['connector_id', 'member_user_id', 'body_provider']) {
      const column = columns.find((candidate) => candidate.name === key);
      assert.ok(column, `missing placement key ${key}`);
      assert.equal(column.notnull, 1, `${key} must be NOT NULL`);
      assert.ok(column.pk > 0, `${key} must be part of the primary key`);
    }
    for (const fenceColumn of [
      'desired_generation',
      'desired_fingerprint_version',
      'desired_source_revision',
      'desired_present',
      'lease_expires_at_ms',
      'fencing_token',
    ]) {
      assert.equal(columns.find((candidate) => candidate.name === fenceColumn)?.notnull, 1);
    }
    assert.ok(columns.some((candidate) => candidate.name === 'applied_fingerprint_version'));

    const foreignKeys = db.prepare('PRAGMA foreign_key_list(connector_placements)').all() as Array<{
      table: string;
      on_delete: string;
    }>;
    assert.deepEqual(new Set(foreignKeys.map((key) => key.table)), new Set(['connectors', 'users']));
    assert.ok(foreignKeys.every((key) => key.on_delete === 'RESTRICT' || key.on_delete === 'NO ACTION'));

    const insertPlacement = db.prepare(
      `INSERT INTO connector_placements (
         connector_id, member_user_id, body_provider, contract_version,
         desired_generation, applied_generation, state, desired_fingerprint,
         applied_fingerprint, lease_owner, lease_expires_at_ms, fencing_token,
         last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    assert.throws(
      () => insertPlacement.run(
        'github-u1', userId, 'claude', 'mcp-user-v2', 0, 0, 'pending', '', null, '', 0, 0, null,
      ),
      /CHECK constraint failed/,
      'only the proven mcp-user-v1 contract is admissible',
    );
    assert.throws(
      () => insertPlacement.run(
        'github-u1', userId, 'codex', 'mcp-user-v1', 1, 0, 'healthy', 'a'.repeat(64), null, '', 0, 0, null,
      ),
      /CHECK constraint failed/,
      'healthy cannot claim an unapplied generation/fingerprint',
    );
    assert.throws(
      () => insertPlacement.run(
        'github-u1', userId, 'codex', 'mcp-user-v1', 0, 0, 'healthy', '', null, '', 0, 0, null,
      ),
      /CHECK constraint failed/,
      'healthy defaults with generation zero and NULL applied fingerprint are forbidden',
    );
    assert.throws(
      () => insertPlacement.run(
        'github-u1', userId, 'claude', 'mcp-user-v1', 1, 0, 'applying', 'a'.repeat(64), null, '', 0, 0, null,
      ),
      /CHECK constraint failed/,
      'applying requires a coherent owner, expiry and fencing token',
    );
    assert.throws(
      () => insertPlacement.run(
        'github-u1', userId, 'claude', 'mcp-user-v1', 1, 0, 'blocked', 'a'.repeat(64), null, '', 0, 0, null,
      ),
      /CHECK constraint failed/,
      'blocked requires a stable error code',
    );
    assert.throws(
      () => insertPlacement.run(
        'github-u1', userId, 'claude', 'mcp-user-v1', 1, 0, 'blocked', 'a'.repeat(64), null, '', 0, 0, '   ',
      ),
      /CHECK constraint failed/,
      'blocked error code cannot be blank after trimming',
    );
    assert.throws(
      () => insertPlacement.run(
        'github-u1', userId, 'claude', 'mcp-user-v1', 1, 0, 'blocked', 'a'.repeat(64), null, '', 0, 0, 'x'.repeat(129),
      ),
      /CHECK constraint failed/,
      'blocked error code is bounded',
    );

    migrateConnectorPlacements(db);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM connector_placements').get() as { count: number }).count,
      0,
      'the migration is idempotent and still does no backfill',
    );
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy placement table is altered in place and version-zero rows fail closed', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp('/var/tmp/connector-placements-legacy-');
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await writeFile(process.env.DATABASE_PATH, '');
  closeConnection();
  initializePlacementMigrationFixture();

  try {
    const db = getConnection();
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('legacy', 'hash', 'member')").run();
    const userId = (db.prepare("SELECT id FROM users WHERE username = 'legacy'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO connectors (
         id, service, display_name, credential_mode, owner_user_id, created_by
       ) VALUES ('legacy-drive', 'google-drive', 'Legacy Drive', 'per_member', ?, ?)`,
    ).run(userId, userId);

    db.exec('DROP TABLE connector_placements');
    db.exec(`
      CREATE TABLE connector_placements (
        connector_id TEXT NOT NULL,
        member_user_id INTEGER NOT NULL,
        body_provider TEXT NOT NULL,
        contract_version TEXT NOT NULL,
        desired_generation INTEGER NOT NULL DEFAULT 0,
        applied_generation INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        last_error_code TEXT,
        desired_fingerprint TEXT NOT NULL DEFAULT '',
        applied_fingerprint TEXT,
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_expires_at_ms INTEGER NOT NULL DEFAULT 0,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (connector_id, member_user_id, body_provider)
      )
    `);
    db.prepare(
      `INSERT INTO connector_placements (
         connector_id, member_user_id, body_provider, contract_version,
         desired_generation, applied_generation, state, desired_fingerprint,
         applied_fingerprint
       ) VALUES ('legacy-drive', ?, 'codex', 'mcp-user-v1', 1, 1, 'healthy', ?, ?)`,
    ).run(userId, 'c'.repeat(64), 'c'.repeat(64));
    const rootpage = (db.prepare(
      "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'connector_placements'",
    ).get() as { rootpage: number }).rootpage;

    migrateConnectorPlacements(db);
    migrateConnectorPlacements(db);

    assert.equal(
      (db.prepare(
        "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'connector_placements'",
      ).get() as { rootpage: number }).rootpage,
      rootpage,
      'the additive migration must not rebuild the legacy table',
    );
    const row = db.prepare(
      `SELECT desired_fingerprint_version, applied_fingerprint_version, desired_fingerprint,
              desired_source_revision, desired_present
       FROM connector_placements WHERE connector_id = 'legacy-drive'`,
    ).get() as {
      desired_fingerprint_version: number;
      applied_fingerprint_version: number | null;
      desired_fingerprint: string;
      desired_source_revision: number;
      desired_present: number;
    };
    assert.deepEqual(row, {
      desired_fingerprint_version: 0,
      applied_fingerprint_version: null,
      desired_fingerprint: 'c'.repeat(64),
      desired_source_revision: -1,
      desired_present: 1,
    });

    const repository = createConnectorPlacementsDb(db);
    const key = {
      connectorId: 'legacy-drive',
      memberUserId: userId,
      bodyProvider: 'codex' as const,
      contractVersion: 'mcp-user-v1' as const,
    };
    assert.equal(repository.getStatus(key)?.state, 'pending');
    assert.equal(repository.acquireLease(key, {
      ownerId: '11111111-2222-7333-8444-555555555555',
      nowMs: 1_000,
      leaseMs: 100,
    }), null);

    db.prepare(
      `UPDATE connector_placements
       SET lease_owner = ?, lease_expires_at_ms = 2000, fencing_token = 1
       WHERE connector_id = 'legacy-drive'`,
    ).run('11111111-2222-7333-8444-555555555555');
    assert.equal(
      repository.getConfigWriteProof({
        ...key,
        ownerId: '11111111-2222-7333-8444-555555555555',
        desiredGeneration: 1,
        sourceRevision: -1,
        fencingToken: 1,
        expiresAtMs: 2_000,
      }, 1_500),
      null,
    );

    assert.equal(repository.stageDesiredIfConnectorCurrent(
      key,
      0,
      { version: 2, fingerprint: 'd'.repeat(64) },
      true,
    ), true);
    assert.equal(repository.getStatus(key)?.desiredGeneration, 2);
    assert.equal(repository.getStatus(key)?.state, 'pending');
    assert.ok(repository.acquireLease(key, {
      ownerId: '22222222-3333-7444-8555-666666666666',
      nowMs: 2_100,
      leaseMs: 100,
    }));
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
