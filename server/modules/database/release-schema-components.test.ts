import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  applyDeviceAccountSessionsComponent,
  DEVICE_ACCOUNT_SESSIONS_OWNED_OBJECTS,
  DEVICE_ACCOUNT_SESSIONS_SCHEMA_SQL,
  migrateDeviceAccountSessions,
} from './device-account-sessions.migration.js';
import {
  applyUsageStatisticsV3Component,
  createUsageStatisticsV3Fresh,
  USAGE_STATISTICS_V3_OWNED_OBJECTS,
  USAGE_STATISTICS_V3_TABLES_SCHEMA_SQL,
} from './usage-statistics-v3.migration.js';
import { assertReleaseSchemaObjectsAbsent } from './release-schema-component-state.js';

const OWNED = new Set([...USAGE_STATISTICS_V3_OWNED_OBJECTS, ...DEVICE_ACCOUNT_SESSIONS_OWNED_OBJECTS]);

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };

function schemaObjects(db: Database.Database): SchemaObject[] {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all() as SchemaObject[];
}

function ownedObjects(db: Database.Database, names: readonly string[]): SchemaObject[] {
  const wanted = new Set(names);
  return schemaObjects(db).filter((entry) => wanted.has(entry.name));
}

function fingerprint(objects: SchemaObject[]): string {
  return createHash('sha256').update(JSON.stringify(objects)).digest('hex');
}

function syntheticSource(projectVariant: 'alter-history' | 'canonical-create'): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, password_changed_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY NOT NULL, project_path TEXT NOT NULL UNIQUE,
      ${projectVariant === 'canonical-create' ? 'detected_name TEXT DEFAULT NULL,' : ''}
      visibility TEXT NOT NULL DEFAULT 'public'
      ${projectVariant === 'alter-history' ? ', detected_name TEXT' : ''}
    );
    CREATE TABLE project_members (
      project_id TEXT NOT NULL, user_id INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );
    CREATE INDEX idx_project_members_user ON project_members(user_id);
  `);
  return db;
}

function applyComponents(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    applyUsageStatisticsV3Component(db);
    applyDeviceAccountSessionsComponent(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

test('canonical DDL bytes remain sealed across extraction', () => {
  assert.equal(createHash('sha256').update(USAGE_STATISTICS_V3_TABLES_SCHEMA_SQL).digest('hex'),
    '5a9424d7924edce5af4deecd406411981f44b921bc9ab3d3344c38de189db27b');
  assert.equal(createHash('sha256').update(DEVICE_ACCOUNT_SESSIONS_SCHEMA_SQL).digest('hex'),
    'e8b0862f47c8e022d35b6a35cd4b4d4d76e718beb2211a4b552317b499124772');
});

test('portable synthetic sources preserve inherited differences and converge owned fingerprints', () => {
  const sources = [syntheticSource('alter-history'), syntheticSource('canonical-create')];
  try {
    const measured = sources.map((db) => {
      const before = schemaObjects(db);
      assert.equal(before.some((entry) => OWNED.has(entry.name)), false);
      applyComponents(db);
      const after = schemaObjects(db);
      assert.deepEqual(after.filter((entry) => !OWNED.has(entry.name)), before);
      return {
        usage: fingerprint(ownedObjects(db, USAGE_STATISTICS_V3_OWNED_OBJECTS)),
        wallet: fingerprint(ownedObjects(db, DEVICE_ACCOUNT_SESSIONS_OWNED_OBJECTS)),
      };
    });
    assert.deepEqual(measured[0], measured[1]);
  } finally {
    for (const db of sources) db.close();
  }
});

test('component entry guards reject exact-present, mixed and drifted states before DDL', () => {
  const exact = new Database(':memory:');
  const usageMixed = new Database(':memory:');
  const walletDrift = new Database(':memory:');
  try {
    createUsageStatisticsV3Fresh(exact);
    const exactBefore = schemaObjects(exact);
    exact.exec('BEGIN IMMEDIATE');
    assert.throws(() => applyUsageStatisticsV3Component(exact), /release_schema_component_source_invalid/);
    exact.exec('ROLLBACK');
    assert.deepEqual(schemaObjects(exact), exactBefore);

    usageMixed.exec('CREATE TABLE usage_root_authority_v3 (unexpected TEXT)');
    const mixedBefore = schemaObjects(usageMixed);
    usageMixed.exec('BEGIN IMMEDIATE');
    assert.throws(() => applyUsageStatisticsV3Component(usageMixed), /release_schema_component_source_invalid/);
    usageMixed.exec('ROLLBACK');
    assert.deepEqual(schemaObjects(usageMixed), mixedBefore);

    walletDrift.exec('CREATE TABLE device_sessions (unexpected TEXT)');
    const driftBefore = schemaObjects(walletDrift);
    walletDrift.exec('BEGIN IMMEDIATE');
    assert.throws(() => applyDeviceAccountSessionsComponent(walletDrift), /release_schema_component_source_invalid/);
    walletDrift.exec('ROLLBACK');
    assert.deepEqual(schemaObjects(walletDrift), driftBefore);
  } finally {
    exact.close(); usageMixed.close(); walletDrift.close();
  }
});

test('component entries reject a missing caller transaction before DDL', () => {
  const db = new Database(':memory:');
  try {
    assert.throws(() => applyUsageStatisticsV3Component(db), /release_schema_component_transaction_required/);
    assert.throws(() => applyDeviceAccountSessionsComponent(db), /release_schema_component_transaction_required/);
    assert.deepEqual(schemaObjects(db), []);
  } finally {
    db.close();
  }
});

test('invalid or overlong component identities reject before schema classification', () => {
  const db = new Database(':memory:');
  let prepared = false;
  const guarded = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (...args: Parameters<Database.Database['prepare']>) => {
      prepared = true;
      return target.prepare(...args);
    };
    return Reflect.get(target, key, target);
  } });
  try {
    assert.throws(() => assertReleaseSchemaObjectsAbsent(guarded, `a${'b'.repeat(128)}`, ['owned']),
      /release_schema_component_definition_invalid/);
    assert.equal(prepared, false);
    assert.deepEqual(schemaObjects(db), []);
  } finally {
    db.close();
  }
});

test('caller rollback restores an exact source schema after both additive components', () => {
  const db = syntheticSource('canonical-create');
  try {
    const before = schemaObjects(db);
    db.exec('BEGIN IMMEDIATE');
    applyUsageStatisticsV3Component(db);
    applyDeviceAccountSessionsComponent(db);
    db.exec('ROLLBACK');
    assert.deepEqual(schemaObjects(db), before);
    assert.deepEqual(db.pragma('quick_check'), [{ quick_check: 'ok' }]);
  } finally {
    db.close();
  }
});

test('legacy fresh wrappers stay idempotent and wallet compatibility paths remain unchanged', () => {
  const fresh = new Database(':memory:');
  const legacy = new Database(':memory:');
  try {
    fresh.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, password_changed_at INTEGER NOT NULL)');
    createUsageStatisticsV3Fresh(fresh);
    createUsageStatisticsV3Fresh(fresh);
    migrateDeviceAccountSessions(fresh);
    const first = schemaObjects(fresh);
    migrateDeviceAccountSessions(fresh);
    assert.deepEqual(schemaObjects(fresh), first);

    legacy.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, password_changed_at INTEGER NOT NULL);
      CREATE TABLE device_sessions (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
        revoked_at INTEGER, active_slot_id TEXT, version INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE device_account_slots (
        id TEXT PRIMARY KEY, device_session_id TEXT NOT NULL, user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, revoked_at INTEGER
      );
      INSERT INTO users VALUES (1, 73);
      INSERT INTO device_sessions VALUES ('device', 'secret', 99, NULL, NULL, 7, 1);
      INSERT INTO device_account_slots VALUES ('slot', 'device', 1, 1, 1, NULL);
    `);
    migrateDeviceAccountSessions(legacy);
    assert.deepEqual(legacy.prepare('SELECT generation FROM device_sessions').get(), { generation: 7 });
    assert.deepEqual(legacy.prepare('SELECT password_stamp FROM device_account_slots').get(), { password_stamp: 73 });
  } finally {
    fresh.close(); legacy.close();
  }
});
