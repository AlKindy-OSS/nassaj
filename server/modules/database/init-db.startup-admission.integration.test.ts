import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { Database } from 'better-sqlite3';

// eslint-disable-next-line boundaries/no-unknown -- Preserve the real builtins-only bootstrap exports in admission tests.
import * as startupContext from '../../bootstrap-startup-context.js';

let admitted = false;
mock.module(new URL('../../bootstrap-startup-context.js', import.meta.url).href, {
  exports: { ...startupContext, requireStartupAdmission: () => admitted },
});

const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase, migrateAdmittedScheduledMessages } = await import('@/modules/database/init-db.js');
const { stopReconcileScheduler } = await import('@/modules/database/project-reconcile.service.js');
const {
  inspectExistingConnectorPolicyV2Substrate,
  runConnectorPolicyV2GuardedBootstrap,
} = // eslint-disable-next-line boundaries/dependencies -- startup admission exercises the real connector substrate bootstrap.
  await import('@/modules/connectors/connector-substrate-only.production.js');

async function withAdmittedFixture(run: (input: {
  database: Database;
  authorityRootPath: string;
}) => void | Promise<void>): Promise<void> {
  admitted = false;
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp('/var/tmp/nassaj-admitted-db-');
  const databasePath = path.join(directory, 'auth.db');
  process.env.DATABASE_PATH = databasePath;
  closeConnection();
  // Keep this fixture independent of connection.ts's one-time legacy copy.
  // An absent target would import `database/auth.db` from the project root.
  await writeFile(databasePath, '');
  await initializeDatabase();
  stopReconcileScheduler();
  const database = getConnection();
  database.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'owner')")
    .run('admitted-owner', 'x');
  database.prepare("INSERT INTO app_config (key, value) VALUES ('jwt_secret', ?)")
    .run('a'.repeat(32));
  database.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)')
    .run('public', 'private');
  const authorityRootPath = `${databasePath}.connector-runtime-authority.json`;
  runConnectorPolicyV2GuardedBootstrap(database, authorityRootPath, () => {
    database.prepare(`INSERT INTO connector_m5_installation_origin
      (installation_id, canonical_origin, updated_at_ms)
      SELECT installation_id, 'https://existing.example', 0 FROM connector_installations WHERE singleton = 1`)
      .run();
  });
  database.exec('DROP TABLE scheduled_messages');

  try {
    await run({ database, authorityRootPath });
  } finally {
    admitted = false;
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

function hasScheduledMessagesTable(database: Database): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get('scheduled_messages'));
}

function connectorFenceSnapshot(database: Database): unknown {
  return database.prepare(`SELECT
    (SELECT json_group_array(json_object('name', name, 'sql', sql))
      FROM (SELECT name, sql FROM sqlite_schema
        WHERE type = 'trigger' AND name LIKE 'connector_runtime_fence_%' ORDER BY name)) AS triggers,
    (SELECT json_object('token', maximum_fencing_token, 'epoch', maximum_writer_epoch,
      'clock', clock_high_water_ms) FROM connector_runtime_anchor WHERE singleton = 1) AS anchor,
    (SELECT json_object('token', last_fencing_token, 'epoch', writer_epoch,
      'clock', last_clock_ms) FROM connector_runtime_control WHERE singleton = 1) AS control,
    (SELECT json_object('token', fencing_token, 'epoch', writer_epoch, 'owner', owner_token)
      FROM connector_runtime_writer_lease WHERE singleton = 1) AS lease`).get();
}

function writerEpoch(database: Database): number {
  return (database.prepare('SELECT writer_epoch AS writerEpoch FROM connector_runtime_control WHERE singleton = 1')
    .get() as { writerEpoch: number }).writerEpoch;
}

test('real startup-admission boot adds the scheduled-message schema and is idempotent', async () => {
  await withAdmittedFixture(async ({ database, authorityRootPath }) => {
    const readiness = inspectExistingConnectorPolicyV2Substrate(database, authorityRootPath);
    assert.equal(readiness.origin.canonicalOrigin, 'https://existing.example');
    const epochBefore = writerEpoch(database);
    admitted = true;
    await initializeDatabase();
    assert.equal(hasScheduledMessagesTable(database), true);
    const walletTables = database.prepare(`SELECT name FROM sqlite_schema
      WHERE type='table' AND name IN ('device_sessions', 'device_account_slots') ORDER BY name`).all();
    assert.deepEqual(walletTables, [{ name: 'device_account_slots' }, { name: 'device_sessions' }]);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM device_sessions').get() as { count: number }).count, 0);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM device_account_slots').get() as { count: number }).count, 0,
      'admitted migration must not convert existing users into device sessions');
    assert.equal(writerEpoch(database), epochBefore, 'admitted queue migration must not advance connector writer epoch');
    const columns = database.prepare('PRAGMA table_info(scheduled_messages)').all() as Array<{ name: string }>;
    assert.ok(columns.some(column => column.name === 'available_at'));
    await assert.doesNotReject(initializeDatabase());
    admitted = false;
  });
});

test('admitted boot does not mutate a pre-scheduled database when connector authority is missing', async () => {
  await withAdmittedFixture(async ({ database, authorityRootPath }) => {
    const walletSchemaBefore = database.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE name IN ('device_sessions', 'device_account_slots') ORDER BY name`).all();
    await unlink(authorityRootPath);
    admitted = true;
    await assert.rejects(initializeDatabase());
    assert.equal(hasScheduledMessagesTable(database), false);
    assert.deepEqual(database.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE name IN ('device_sessions', 'device_account_slots') ORDER BY name`).all(), walletSchemaBefore,
    'rejected admitted boot must not mutate the existing wallet schema');
    admitted = false;
  });
});

test('admitted queue migration neither reinstalls nor acquires the connector runtime fence', async () => {
  await withAdmittedFixture(({ database }) => {
    const before = connectorFenceSnapshot(database);
    migrateAdmittedScheduledMessages(database);
    assert.equal(hasScheduledMessagesTable(database), true);
    assert.deepEqual(connectorFenceSnapshot(database), before);
  });
});

test('document shares survive ordinary and admitted startup without advancing the connector writer epoch', async () => {
  await withAdmittedFixture(async ({ database }) => {
    const exists = () => Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE name='document_shares'").get());
    assert.equal(exists(), true, 'ordinary startup creates the additive schema');
    database.exec('DROP TABLE document_shares');
    const before = writerEpoch(database);
    admitted = true;
    await initializeDatabase();
    assert.equal(exists(), true, 'admitted startup must not skip shares');
    assert.equal(writerEpoch(database), before);
    database.prepare('INSERT INTO projects (project_id,project_path) VALUES (?,?)').run('shares-fixture', '/fixture');
    database.prepare(`INSERT INTO document_shares
      (id,project_id,relative_path,audience,root_dev,root_ino,created_by,created_at)
      VALUES ('stable','shares-fixture','docs/a.txt','members','1','2',1,'2026-09-13')`).run();
    await initializeDatabase();
    assert.equal((database.prepare("SELECT id FROM document_shares WHERE id='stable'").get() as { id: string })?.id, 'stable');
    assert.equal(writerEpoch(database), before);
  });
});
