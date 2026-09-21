import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import {
  CONNECTOR_RUNTIME_CANONICAL_TABLE_INVENTORY,
  CONNECTOR_RUNTIME_THREAT_MODEL,
  ConnectorRuntimeAuthority,
  ConnectorRuntimeWriteGate,
  migrateConnectorRuntimeFence,
  preflightConnectorRuntime,
  reinstallConnectorRuntimeFence,
  verifyExistingConnectorRuntimeFence,
} from './connector-runtime-fence.js';

const AUTHORITY_KEY = Buffer.alloc(32, 7);
const authority = (): ConnectorRuntimeAuthority => ConnectorRuntimeAuthority.create(AUTHORITY_KEY);
const compatibleBuild = { runtimeVersion: 1, maximumPolicySchemaVersion: 2,
  supportsWriterFencing: true } as const;

test('existing fence verification is read-only and never repairs absent or corrupt state', () => {
  const database = new Database(':memory:');
  try {
    assert.throws(() => verifyExistingConnectorRuntimeFence(database, compatibleBuild, authority()), /control_plane_absent/);
    createTable(database, 'connector_credential_bundle_revisions');
    reinstallConnectorRuntimeFence(database, authority());
    const before = database.serialize(); database.pragma('query_only = ON');
    assert.equal(verifyExistingConnectorRuntimeFence(database, compatibleBuild, authority()).subsystemReady, true);
    assert.deepEqual(database.serialize(), before);
    database.pragma('query_only = OFF');
    database.exec('DROP TRIGGER connector_runtime_fence_connector_credential_bundle_revisions_insert');
    database.pragma('query_only = ON');
    assert.throws(() => verifyExistingConnectorRuntimeFence(database, compatibleBuild, authority()), /trigger_inventory_invalid/);
    database.pragma('query_only = OFF');
    database.prepare('UPDATE connector_runtime_control SET authority_mac = ?').run('corrupt');
    database.pragma('query_only = ON');
    assert.throws(() => verifyExistingConnectorRuntimeFence(database, compatibleBuild, authority()), /authority_tampered/);
  } finally { database.close(); }
});

const createTable = (database: Database.Database, name: string): void => {
  database.exec(`CREATE TABLE "${name}" (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
};

const healthReady = (database: Database.Database, now = Date.now()): void => {
  assert.equal(preflightConnectorRuntime(database, compatibleBuild, authority(), now).reason, 'ready');
};

const testAuthorityMac = (domain: 'anchor' | 'control', fields: readonly unknown[]): string =>
  createHmac('sha256', AUTHORITY_KEY)
    .update(`NASSAJ\0CONNECTOR_RUNTIME_${domain.toUpperCase()}\0V1\0`)
    .update(JSON.stringify(fields)).digest('base64url');

const rotateWriterEpochForRace = (database: Database.Database, writerEpoch: number, now: number): void => {
  const control = database.prepare('SELECT * FROM connector_runtime_control').get() as {
    connector_runtime_floor: number; policy_schema_version: number; last_fencing_token: number;
  };
  const anchorFields = [1, control.last_fencing_token, writerEpoch, now];
  const controlFields = [control.connector_runtime_floor, control.policy_schema_version,
    writerEpoch, control.last_fencing_token, now];
  database.transaction(() => {
    database.prepare(`UPDATE connector_runtime_anchor SET maximum_writer_epoch = ?,
      clock_high_water_ms = ?, authority_mac = ? WHERE singleton = 1`)
      .run(writerEpoch, now, testAuthorityMac('anchor', anchorFields));
    database.prepare(`UPDATE connector_runtime_control SET writer_epoch = ?,
      last_clock_ms = ?, authority_mac = ? WHERE singleton = 1`)
      .run(writerEpoch, now, testAuthorityMac('control', controlFields));
  }).immediate();
};

test('migration is additive, idempotent, no-backfill, and keeps runtime floor at one', () => {
  const database = new Database(':memory:');
  try {
    createTable(database, 'connector_credential_bundle_revisions');
    database.prepare('INSERT INTO connector_credential_bundle_revisions VALUES (?, ?)')
      .run('legacy-row', 'untouched');
    migrateConnectorRuntimeFence(database, authority());
    migrateConnectorRuntimeFence(database, authority());
    const control = database.prepare('SELECT * FROM connector_runtime_control').get() as {
      connector_runtime_floor: number; policy_schema_version: number;
      writer_epoch: number; last_fencing_token: number;
    };
    assert.deepEqual([control.connector_runtime_floor, control.policy_schema_version,
      control.writer_epoch, control.last_fencing_token], [1, 2, 1, 0]);
    assert.equal((database.prepare('SELECT count(*) AS count FROM connector_credential_bundle_revisions')
      .get() as { count: number }).count, 1);
    healthReady(database);
  } finally { database.close(); }
});

test('atomic migration rolls back partial authority schema and triggers on final-verify failure', () => {
  const database = new Database(':memory:');
  try {
    createTable(database, 'connector_credential_bundle_revisions');
    database.exec('CREATE TABLE connector_runtime_control (singleton INTEGER PRIMARY KEY)');
    assert.throws(() => migrateConnectorRuntimeFence(database, authority()), /no (?:such )?column|authority/u);
    assert.equal(database.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE name = 'connector_runtime_writer_lease'",
    ).get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'connector_runtime_fence_%'",
    ).get<{ count: number }>()?.count, 0);
  } finally { database.close(); }
});

test('canonical inventory has no duplicates and matrix guards every existing table × I/U/D', () => {
  const names = CONNECTOR_RUNTIME_CANONICAL_TABLE_INVENTORY.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length);
  const database = new Database(':memory:');
  try {
    for (const name of names) createTable(database, name);
    migrateConnectorRuntimeFence(database, authority());
    const gate = new ConnectorRuntimeWriteGate(database, compatibleBuild, authority());
    assert.ok(gate.acquire('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    for (const name of names) {
      gate.assertAllowed('connector_write');
      assert.equal(gate.runFencedMutation(() => {
        database.prepare(`INSERT INTO "${name}" VALUES (?, ?)`).run('row', 'inserted');
        database.prepare(`UPDATE "${name}" SET payload = ? WHERE id = ?`).run('updated', 'row');
        database.prepare(`DELETE FROM "${name}" WHERE id = ?`).run('row');
      }, false), true);
    }
    const triggers = database.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'connector_runtime_fence_%'",
    ).get() as { count: number };
    assert.equal(triggers.count, names.length * 3);
  } finally { database.close(); }
});

test('preflight rejects missing or SQL-tampered trigger and reinstall restores exact inventory', () => {
  const database = new Database(':memory:');
  try {
    createTable(database, 'connectors');
    migrateConnectorRuntimeFence(database, authority());
    database.exec('DROP TRIGGER connector_runtime_fence_connectors_insert');
    assert.equal(preflightConnectorRuntime(database, compatibleBuild, authority()).reason,
      'trigger_inventory_invalid');
    reinstallConnectorRuntimeFence(database, authority());
    healthReady(database);
    database.exec(`DROP TRIGGER connector_runtime_fence_connectors_insert;
      CREATE TRIGGER connector_runtime_fence_connectors_insert BEFORE INSERT ON connectors BEGIN SELECT 1; END`);
    assert.equal(preflightConnectorRuntime(database, compatibleBuild, authority()).reason,
      'trigger_inventory_invalid');
  } finally { database.close(); }
});

test('lifecycle reinstall adds fences for connector tables created by a later rebuild', () => {
  const database = new Database(':memory:');
  try {
    createTable(database, 'connectors');
    migrateConnectorRuntimeFence(database, authority());
    createTable(database, 'connector_placements');
    assert.equal(preflightConnectorRuntime(database, compatibleBuild, authority()).reason,
      'trigger_inventory_invalid');
    reinstallConnectorRuntimeFence(database, authority());
    healthReady(database);
    assert.equal((database.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'connector_placements'",
    ).get() as { count: number }).count, 3);
  } finally { database.close(); }
});

test('realistic old writer cannot insert, update, or delete without fence functions', () => {
  const directory = mkdtempSync('/var/tmp/nassaj-runtime-old-');
  const path = join(directory, 'auth.db');
  const migrator = new Database(path);
  try {
    createTable(migrator, 'connectors');
    migrator.prepare('INSERT INTO connectors VALUES (?, ?)').run('existing', 'legacy');
    migrateConnectorRuntimeFence(migrator, authority());
    const oldWriter = new Database(path);
    try {
      for (const statement of [
        () => oldWriter.prepare('INSERT INTO connectors VALUES (?, ?)').run('old', 'blocked'),
        () => oldWriter.prepare('UPDATE connectors SET payload = ?').run('blocked'),
        () => oldWriter.prepare('DELETE FROM connectors').run(),
      ]) assert.throws(statement, /nassaj_connector_authority_valid|connector_runtime_fence_required/u);
    } finally { oldWriter.close(); }
  } finally { migrator.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('control and lease raw tampering are detected and double-delete cannot reset the anchor', () => {
  const database = new Database(':memory:');
  let now = Date.now();
  try {
    createTable(database, 'connectors');
    migrateConnectorRuntimeFence(database, authority());
    const gate = new ConnectorRuntimeWriteGate(database, compatibleBuild, authority(), () => now);
    const lease = gate.acquire('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1_000);
    assert.ok(lease);
    database.prepare('UPDATE connector_runtime_control SET writer_epoch = writer_epoch + 1').run();
    assert.equal(gate.preflight().reason, 'authority_tampered');
  } finally { database.close(); }

  const deletionDb = new Database(':memory:');
  try {
    createTable(deletionDb, 'connectors');
    migrateConnectorRuntimeFence(deletionDb, authority());
    const gate = new ConnectorRuntimeWriteGate(deletionDb, compatibleBuild, authority(), () => now);
    const lease = gate.acquire('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1_000);
    assert.ok(lease);
    deletionDb.exec(`DELETE FROM connector_runtime_writer_lease;
      DELETE FROM connector_runtime_control`);
    assert.equal(gate.preflight().reason, 'authority_tampered');
    assert.equal(gate.acquire('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1_000), null);
    assert.equal((deletionDb.prepare(
      'SELECT maximum_fencing_token FROM connector_runtime_anchor',
    ).get() as { maximum_fencing_token: number }).maximum_fencing_token, lease.fencingToken);
    assert.throws(() => reinstallConnectorRuntimeFence(deletionDb, authority()), /authority_tampered/u);
  } finally { deletionDb.close(); }
});

test('unique acquisition nonce denies a second gate with same owner and renewal CAS rotates instance', () => {
  const directory = mkdtempSync('/var/tmp/nassaj-runtime-owner-');
  const path = join(directory, 'auth.db');
  const firstDb = new Database(path);
  let secondDb: Database.Database | null = null;
  let now = Date.now();
  try {
    createTable(firstDb, 'connectors');
    migrateConnectorRuntimeFence(firstDb, authority());
    secondDb = new Database(path);
    const first = new ConnectorRuntimeWriteGate(firstDb, compatibleBuild, authority(), () => now);
    const second = new ConnectorRuntimeWriteGate(secondDb, compatibleBuild, authority(), () => now);
    const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const lease = first.acquire(owner, 1_000);
    assert.ok(lease);
    assert.equal(second.acquire(owner, 1_000), null);
    const renewed = first.renew(lease, 1_000);
    assert.ok(renewed);
    assert.equal(first.leaseIsCurrent(lease), false);
    assert.equal(first.renew(lease, 1_000), null);
    assert.equal(renewed.fencingToken, lease.fencingToken);
    now += 1_001;
    const takeover = second.acquire(owner, 1_000);
    assert.ok(takeover);
    assert.equal(takeover.fencingToken, lease.fencingToken + 1);
  } finally { secondDb?.close(); firstDb.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('acquire and renewal reject a signed writer-epoch race inside their transactions', () => {
  const acquireDb = new Database(':memory:');
  const now = Date.now();
  try {
    createTable(acquireDb, 'connectors');
    migrateConnectorRuntimeFence(acquireDb, authority());
    const gate = new ConnectorRuntimeWriteGate(acquireDb, compatibleBuild, authority(), () => now);
    rotateWriterEpochForRace(acquireDb, 2, now);
    assert.equal(gate.acquire('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1_000, 1), null,
      'stale preflight writerEpoch is rechecked under BEGIN IMMEDIATE');
  } finally { acquireDb.close(); }

  const renewalDb = new Database(':memory:');
  try {
    createTable(renewalDb, 'connectors');
    migrateConnectorRuntimeFence(renewalDb, authority());
    const gate = new ConnectorRuntimeWriteGate(renewalDb, compatibleBuild, authority(), () => now);
    const lease = gate.acquire('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1_000);
    assert.ok(lease);
    rotateWriterEpochForRace(renewalDb, 2, now);
    assert.equal(gate.renew(lease, 1_000), null,
      'renewal rechecks its exact lease writerEpoch under BEGIN IMMEDIATE');
  } finally { renewalDb.close(); }
});

const startLeaseWorker = (path: string, owner: string, barrier: SharedArrayBuffer, now: number) => {
  const worker = new Worker(new URL('./__tests__/connector-runtime-fence.worker.ts', import.meta.url), {
    workerData: {
    path, owner, barrier, now, key: AUTHORITY_KEY.toString('hex'),
    },
  });
  let readyResolve: (() => void) | undefined;
  let resultResolve: ((value: boolean) => void) | undefined;
  let resultReject: ((reason: Error) => void) | undefined;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  const result = new Promise<boolean>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
    worker.on('error', reject);
  });
  worker.on('message', (message: { ready?: boolean; won?: boolean; error?: string }) => {
    if (message.ready) readyResolve?.();
    if (message.error) resultReject?.(new Error(message.error));
    if (typeof message.won === 'boolean') resultResolve?.(message.won);
  });
  return { ready, result };
};

test('two actual worker connections contend under BEGIN IMMEDIATE and exactly one wins', async () => {
  const directory = mkdtempSync('/var/tmp/nassaj-runtime-workers-');
  const path = join(directory, 'auth.db');
  const database = new Database(path);
  try {
    createTable(database, 'connectors');
    migrateConnectorRuntimeFence(database, authority());
    const barrier = new SharedArrayBuffer(4);
    const now = Date.now();
    const workers = [
      startLeaseWorker(path, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', barrier, now),
      startLeaseWorker(path, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', barrier, now),
    ];
    await Promise.all(workers.map(worker => worker.ready));
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0, workers.length);
    const results = await Promise.all(workers.map(worker => worker.result));
    assert.deepEqual(results.sort(), [false, true]);
    healthReady(database, now);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('clock rollback and unsafe expiry fail closed', () => {
  const database = new Database(':memory:');
  let now = Date.now();
  try {
    createTable(database, 'connectors');
    migrateConnectorRuntimeFence(database, authority());
    const gate = new ConnectorRuntimeWriteGate(database, compatibleBuild, authority(), () => now);
    const lease = gate.acquire('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1_000);
    assert.ok(lease);
    now -= 1;
    assert.equal(gate.preflight().reason, 'clock_rollback_detected');
    assert.equal(gate.renew(lease, 1_000), null);
    assert.throws(() => database.prepare('INSERT INTO connectors VALUES (?, ?)')
      .run('rollback-writer', 'blocked'), /connector_runtime_fence_required/u);
  } finally { database.close(); }

  const unsafeDb = new Database(':memory:');
  try {
    createTable(unsafeDb, 'connectors');
    migrateConnectorRuntimeFence(unsafeDb, authority());
    const gate = new ConnectorRuntimeWriteGate(unsafeDb, compatibleBuild,
      authority(), () => Number.MAX_SAFE_INTEGER - 5);
    assert.throws(() => gate.acquire('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10), /input_invalid/u);
  } finally { unsafeDb.close(); }
});

test('rollback build remains readable and boot preflight is mutation-free and secret-free', () => {
  const database = new Database(':memory:');
  try {
    const changes = database.totalChanges;
    assert.deepEqual(preflightConnectorRuntime(database, compatibleBuild, authority()), {
      subsystemReady: false, reason: 'control_plane_absent', connectorRuntimeFloor: null,
      policySchemaVersion: null, writerEpoch: null, fencingToken: null,
    });
    assert.equal(database.totalChanges, changes);
    createTable(database, 'connectors');
    migrateConnectorRuntimeFence(database, authority());
    const old = preflightConnectorRuntime(database, {
      runtimeVersion: 1, maximumPolicySchemaVersion: 1, supportsWriterFencing: false,
    }, authority());
    assert.equal(old.reason, 'policy_schema_incompatible');
    assert.equal(database.prepare('SELECT count(*) AS count FROM connectors').get<{ count: number }>()?.count, 0);
    assert.equal(/owner|nonce|secret|mac/iu.test(JSON.stringify(old)), false);
  } finally { database.close(); }
});

test('hostile connection function registration is an explicit trigger bypass, not a claimed boundary', () => {
  const directory = mkdtempSync('/var/tmp/nassaj-runtime-bypass-');
  const path = join(directory, 'auth.db');
  const trusted = new Database(path);
  try {
    createTable(trusted, 'connectors');
    migrateConnectorRuntimeFence(trusted, authority());
    const gate = new ConnectorRuntimeWriteGate(trusted, compatibleBuild, authority());
    assert.ok(gate.acquire('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    const control = trusted.prepare('SELECT * FROM connector_runtime_control').get() as Record<string, number>;
    const lease = trusted.prepare('SELECT * FROM connector_runtime_writer_lease').get() as Record<string, string | number>;
    const hostile = new Database(path);
    try {
      hostile.function('nassaj_connector_authority_valid', { varargs: true }, () => 1);
      hostile.function('nassaj_connector_runtime_version', () => 1);
      hostile.function('nassaj_connector_policy_schema_version', () => 2);
      hostile.function('nassaj_connector_writer_epoch', () => control.writer_epoch);
      hostile.function('nassaj_connector_owner_token', () => String(lease.owner_token));
      hostile.function('nassaj_connector_acquisition_nonce', () => String(lease.acquisition_nonce));
      hostile.function('nassaj_connector_fencing_token', () => Number(lease.fencing_token));
      hostile.function('nassaj_connector_now_ms', () => Date.now());
      hostile.prepare('INSERT INTO connectors VALUES (?, ?)').run('hostile', 'explicit-bypass');
      assert.equal(CONNECTOR_RUNTIME_THREAT_MODEL.doesNotProtectAgainst
        .includes('hostile_process_with_arbitrary_sqlite_function_and_ddl_access'), true);
    } finally { hostile.close(); }
  } finally { trusted.close(); rmSync(directory, { recursive: true, force: true }); }
});
