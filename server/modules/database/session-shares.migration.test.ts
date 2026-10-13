/**
 * ADR-205 (T-2013) stage 1: the additive `mode` / `ref_key` columns on
 * session_shares. Covers fresh, upgraded (T-1970 rows) and second boot on a
 * traced connection, the CHECK constraint, revoke clearing `ref_key` (L2), the
 * deletion manifest pin, and both init-db boot paths.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { mock } from 'node:test';

import Database from 'better-sqlite3';

// eslint-disable-next-line boundaries/no-unknown -- Preserve the real builtins-only bootstrap exports in admission tests.
import * as startupContext from '../../bootstrap-startup-context.js';

import * as schema from './schema.js';
import { DELETION_PREPARATION_SQL } from './deletion-schema.js';
import { assertDeletionDependencies } from './deletion-dependency-manifest.js';
import { deleteSessionSidecars } from './deletion-sidecars.js';
import {
  SESSION_SHARES_MODE_COLUMN_SQL, SESSION_SHARES_REF_KEY_COLUMN_SQL, createSessionSharesStore,
  migrateSessionShares, revokeSharesBySession,
} from './session-shares.js';

let admitted = false;
mock.module(new URL('../../bootstrap-startup-context.js', import.meta.url).href, {
  exports: { ...startupContext, requireStartupAdmission: () => admitted },
});

const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { stopReconcileScheduler } = await import('@/modules/database/project-reconcile.service.js');
const { runConnectorPolicyV2GuardedBootstrap } = // eslint-disable-next-line boundaries/dependencies -- admission exercises the real substrate bootstrap.
  await import('@/modules/connectors/connector-substrate-only.production.js');

type Trace = Array<{ method: string; sql: string }>;
const PROBE = 'PRAGMA table_info(session_shares)';
const LEGACY_STATEMENT_COUNT = 4;

/** Records exec and prepared all/run/get calls on one connection, in order. */
function traceConnection(db: Database.Database): Trace {
  const trace: Trace = [];
  const exec = db.exec.bind(db);
  const prepare = db.prepare.bind(db);
  db.exec = ((sql: string) => { trace.push({ method: 'exec', sql }); return exec(sql); }) as typeof db.exec;
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    for (const method of ['all', 'run', 'get'] as const) {
      const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        trace.push({ method, sql });
        return original(...args);
      };
    }
    return statement;
  }) as typeof db.prepare;
  return trace;
}

/** The four T-1970 statements (table and indexes), recorded from the real migration. */
function legacyStatements(): string[] {
  const scratch = new Database(':memory:');
  const recorder = traceConnection(scratch);
  scratch.exec(schema.PROJECTS_TABLE_SCHEMA_SQL);
  migrateSessionShares(scratch);
  scratch.close();
  const statements = recorder.filter((row) => row.method === 'exec' && !row.sql.startsWith('ALTER')
    && row.sql.includes('session_shares')).map((row) => row.sql);
  assert.equal(statements.length, LEGACY_STATEMENT_COUNT);
  return statements;
}

/** Creates the T-1970 shape on `db` and seeds one project and one snapshot share. */
function seedLegacyShares(db: Database.Database): void {
  for (const sql of legacyStatements()) db.exec(sql);
  db.prepare("INSERT INTO projects (project_id, project_path) VALUES ('p1','/srv/p1')").run();
  insertSnapshotRow(db, 's-legacy');
}

/** An in-memory database carrying the T-1970 shape only, with one share row. */
function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(schema.PROJECTS_TABLE_SCHEMA_SQL);
  db.exec(DELETION_PREPARATION_SQL);
  seedLegacyShares(db);
  return db;
}

function insertSnapshotRow(db: Database.Database, id: string): void {
  db.prepare(`INSERT INTO session_shares (id,session_id,project_id,owner_user_id,token_hash,created_by,
    created_at,expires_at,snapshot,snapshot_sha256,up_to_message_id,message_count,redaction_counts)
    VALUES (?,'sess-1','p1',1,'h',1,'2026-10-04T00:00:00Z','2099-01-01T00:00:00Z',x'00','x','m1',1,'{}')`).run(id);
}

function insertLiveRow(db: Database.Database, id: string): void {
  db.prepare(`INSERT INTO session_shares (id,session_id,project_id,owner_user_id,token_hash,created_by,
    created_at,expires_at,snapshot,snapshot_sha256,up_to_message_id,message_count,redaction_counts,mode,ref_key)
    VALUES (?,'sess-1','p1',1,'h',1,'2026-10-04T00:00:00Z','2099-01-01T00:00:00Z',NULL,'','',0,'{}','live',?)`)
    .run(id, Buffer.alloc(32, 7));
}

const ALTERS = [SESSION_SHARES_MODE_COLUMN_SQL, SESSION_SHARES_REF_KEY_COLUMN_SQL];
const tail = (trace: Trace) => trace.filter((row) => row.sql === PROBE || row.sql.startsWith('ALTER TABLE session_shares'));

test('fresh database: the four DDL statements, then the probe and both ALTERs, in order', () => {
  const db = new Database(':memory:');
  try {
    db.exec(schema.PROJECTS_TABLE_SCHEMA_SQL);
    const trace = traceConnection(db);
    migrateSessionShares(db);
    const shares = trace.filter((row) => row.sql.includes('session_shares'));
    assert.equal(shares.length, LEGACY_STATEMENT_COUNT + 3);
    assert.match(shares[3].sql, /session_shares_liveness/);
    assert.deepEqual(shares.slice(4), [
      { method: 'all', sql: PROBE }, { method: 'exec', sql: ALTERS[0] }, { method: 'exec', sql: ALTERS[1] },
    ]);
  } finally { db.close(); }
});

test('upgraded database holding T-1970 rows gains both columns; old rows read snapshot', () => {
  const db = legacyDatabase();
  try {
    const trace = traceConnection(db);
    migrateSessionShares(db);
    assert.deepEqual(tail(trace).map((row) => row.method), ['all', 'exec', 'exec']);
    const row = db.prepare("SELECT mode, ref_key FROM session_shares WHERE id='s-legacy'").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { mode: 'snapshot', ref_key: null });
  } finally { db.close(); }
});

test('second boot runs the probe only, with no ALTER', () => {
  const db = legacyDatabase();
  try {
    migrateSessionShares(db);
    const trace = traceConnection(db);
    migrateSessionShares(db);
    assert.deepEqual(tail(trace), [{ method: 'all', sql: PROBE }]);
  } finally { db.close(); }
});

test('the mode CHECK rejects any value other than snapshot or live', () => {
  const db = legacyDatabase();
  try {
    migrateSessionShares(db);
    assert.doesNotThrow(() => insertLiveRow(db, 's-live'));
    assert.throws(() => db.prepare("UPDATE session_shares SET mode='other' WHERE id='s-live'").run(), /CHECK/);
  } finally { db.close(); }
});

test('revoke nulls ref_key, and a revoked live row whose key survived is cleaned on the next pass', () => {
  const db = legacyDatabase();
  try {
    migrateSessionShares(db);
    insertLiveRow(db, 's-live');
    const store = createSessionSharesStore(db);
    assert.equal(store.revoke('s-live', 'revoked'), 1);
    assert.equal((db.prepare("SELECT ref_key FROM session_shares WHERE id='s-live'").get() as { ref_key: unknown }).ref_key, null);
    // Simulate a key that survived an older revoke statement (L2).
    db.prepare("UPDATE session_shares SET ref_key=x'01' WHERE id='s-live'").run();
    assert.ok(store.listSweepable().some((row: { id: string }) => row.id === 's-live'));
    assert.equal(revokeSharesBySession(db, 'sess-1', 'session_deleted'), 2);
    const left = db.prepare('SELECT COUNT(*) AS n FROM session_shares WHERE ref_key IS NOT NULL OR snapshot IS NOT NULL').get() as { n: number };
    assert.equal(left.n, 0);
  } finally { db.close(); }
});

test('deletion manifest and sidecars cover the new columns without a manifest change', () => {
  const db = legacyDatabase();
  try {
    migrateSessionShares(db);
    insertLiveRow(db, 's-live');
    assert.doesNotThrow(() => assertDeletionDependencies(db));
    db.prepare("INSERT INTO session_delete_batch_members (operation_id,session_id,project_id,generation) VALUES ('op1','sess-1','p1','g1')").run();
    deleteSessionSidecars(db, 'op1');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_shares').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

/** Runs `body` against a real initialized database file, then restores the connection env. */
async function withInitializedDatabase(body: (db: Database.Database) => Promise<void>): Promise<void> {
  admitted = false;
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-share-mode-'));
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  closeConnection();
  await writeFile(process.env.DATABASE_PATH, '');
  try {
    await initializeDatabase();
    stopReconcileScheduler();
    await body(getConnection());
  } finally {
    admitted = false;
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

const columnNames = (db: Database.Database) => new Set((db.prepare(PROBE).all() as Array<{ name: string }>)
  .map((column) => column.name));

/** Seeds the existing security state the admitted path requires (owner, JWT, VAPID, connector origin). */
function prepareForAdmission(db: Database.Database): void {
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('share-owner', 'x', 'owner')").run();
  db.prepare("INSERT INTO app_config (key, value) VALUES ('jwt_secret', ?)").run('a'.repeat(32));
  db.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)').run('public', 'private');
  runConnectorPolicyV2GuardedBootstrap(db, `${process.env.DATABASE_PATH}.connector-runtime-authority.json`, () => {
    db.prepare(`INSERT INTO connector_m5_installation_origin (installation_id, canonical_origin, updated_at_ms)
      SELECT installation_id, 'https://existing.example', 0 FROM connector_installations WHERE singleton = 1`).run();
  });
}

/** Rebuilds session_shares in its T-1970 shape on a live connection and seeds one row. */
function downgradeToLegacy(db: Database.Database): void {
  db.exec('DROP TABLE session_shares');
  seedLegacyShares(db);
}

for (const bootPath of ['guarded bootstrap', 'admitted'] as const) {
  test(`${bootPath} boot path upgrades a T-1970 table and is idempotent`, async () => {
    await withInitializedDatabase(async (db) => {
      assert.ok(columnNames(db).has('mode') && columnNames(db).has('ref_key'), 'fresh boot adds both columns');
      if (bootPath === 'admitted') prepareForAdmission(db);
      downgradeToLegacy(db);
      assert.equal(columnNames(db).has('mode'), false);
      admitted = bootPath === 'admitted';
      const trace = traceConnection(db);
      await initializeDatabase();
      stopReconcileScheduler();
      const upgraded = getConnection();
      assert.equal(upgraded, db, 'same connection, so the trace saw the boot');
      const shares = trace.filter((row) => row.sql.includes('session_shares') && !row.sql.startsWith('SELECT'));
      const liveness = shares.findIndex((row) => row.sql.includes('session_shares_liveness'));
      assert.deepEqual(shares.slice(liveness + 1, liveness + 4).map((row) => row.method), ['all', 'exec', 'exec']);
      assert.ok(columnNames(upgraded).has('mode') && columnNames(upgraded).has('ref_key'));
      const row = upgraded.prepare("SELECT mode FROM session_shares WHERE id='s-legacy'").get() as { mode: string };
      assert.equal(row.mode, 'snapshot');
      await assert.doesNotReject(initializeDatabase(), 'second boot is idempotent');
      stopReconcileScheduler();
    });
  });
}
