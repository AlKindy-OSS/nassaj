/**
 * T-1939 6B (round 3 veto): the auth_method rebuild of
 * connector_owner_auth_sessions on a database that already carries the REAL
 * ADR-132 M2 runtime fence (real triggers, real authority root, real write
 * gate). Nothing is mocked: every scenario starts from the canonical schema,
 * narrowed back to the pre-6B CHECK, seeded, then fenced.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';

/* eslint-disable boundaries/dependencies -- integration test composes the real connector fence. */
import { openOrCreateConnectorRuntimeAuthorityRoot } from '../connectors/connector-runtime-authority-root.js';
import {
  CONNECTOR_POLICY_SCHEMA_VERSION,
  CONNECTOR_RUNTIME_FLOOR,
  ConnectorRuntimeWriteGate,
  preflightConnectorRuntime,
  reinstallConnectorRuntimeFence,
  type ConnectorRuntimeAuthority,
} from '../connectors/connector-runtime-fence.js';
import { runConnectorPolicyV2GuardedBootstrap } from '../connectors/connector-substrate-only.production.js';
/* eslint-enable boundaries/dependencies */

import { migrateConnectorAuthSchema } from './connector-auth.migration.js';
import { createConnectorAuthDb } from './repositories/connector-auth.db.js';
import { INIT_SCHEMA_SQL } from './schema.js';

const BUILD = Object.freeze({ runtimeVersion: CONNECTOR_RUNTIME_FLOOR,
  maximumPolicySchemaVersion: CONNECTOR_POLICY_SCHEMA_VERSION, supportsWriterFencing: true });
const SESSIONS = 'connector_owner_auth_sessions';
const NONCES = 'connector_owner_operation_nonces';
const hash = () => randomBytes(32).toString('hex');

let directory = '';
before(async () => { directory = await mkdtemp(path.join(tmpdir(), 'connector-auth-fence-')); });
after(async () => { await rm(directory, { recursive: true, force: true }); });

type Fixture = Readonly<{
  database: Database.Database; authority: ConnectorRuntimeAuthority; rootPath: string;
  installationId: string; userId: number;
}>;

const tableSql = (database: Database.Database, table: string): string => (database.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
).get(table) as { sql: string }).sql;

const fenceTriggers = (database: Database.Database, table: string): Array<{ name: string; sql: string }> =>
  database.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?
    AND name LIKE 'connector_runtime_fence_%' ORDER BY name`).all(table) as Array<{ name: string; sql: string }>;

const indexes = (database: Database.Database, table: string): string[] => (database.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
).all(table) as Array<{ name: string }>).map(row => row.name);

const rowCount = (database: Database.Database, table: string): number =>
  (database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Rewrites the two owner tables (still empty, not yet fenced) with the pre-6B auth_method CHECK. */
const narrowToLegacyCheck = (database: Database.Database): void => {
  const objects = database.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name IN (?, ?) AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,
    CASE tbl_name WHEN ? THEN 0 ELSE 1 END`).all(SESSIONS, NONCES, SESSIONS) as Array<{ sql: string }>;
  database.exec(`DROP TABLE ${NONCES}; DROP TABLE ${SESSIONS};`);
  for (const { sql } of objects) {
    database.exec(sql.replace("('password', 'webauthn', 'oidc')", "('password', 'webauthn')"));
  }
  assert.ok(!tableSql(database, SESSIONS).includes("'oidc'"), 'fixture carries the legacy CHECK');
};

/** A fenced pre-6B database: canonical schema, legacy CHECK, seeded rows, real fence installed. */
const legacyFencedDatabase = (name: string, options: Readonly<{ withNonce: boolean }>): Fixture => {
  const database = new Database(path.join(directory, `${name}.sqlite`));
  database.pragma('foreign_keys = ON');
  database.exec(INIT_SCHEMA_SQL);
  migrateConnectorAuthSchema(database);
  narrowToLegacyCheck(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  const userId = Number(database.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'user')",
  ).run(`member-${name}`).lastInsertRowid);
  const nowMs = Date.now();
  const sessionId = randomUUID();
  repository.recordOwnerAuthSession({ sessionId, installationId, sessionTokenHash: hash(),
    csrfTokenHash: hash(), userId, authMethod: 'password', authTimeMs: nowMs, expiresAtMs: nowMs + 600_000 });
  if (options.withNonce) {
    assert.ok(repository.issueOwnerOperation({ sessionId, requestId: randomUUID(), nonceHash: hash(),
      installationId, userId, operation: 'upsert_personal_api_key', nowMs, ttlMs: 60_000 }));
  }
  const rootPath = path.join(directory, `${name}.authority.json`);
  const { authority } = openOrCreateConnectorRuntimeAuthorityRoot(rootPath);
  reinstallConnectorRuntimeFence(database, authority);
  return { database, authority, rootPath, installationId, userId };
};

const assertFenceIntact = (fixture: Fixture, label: string): void => {
  const health = preflightConnectorRuntime(fixture.database, BUILD, fixture.authority);
  assert.equal(health.reason, 'ready', `${label}: fence inventory valid`);
  assert.equal(fenceTriggers(fixture.database, SESSIONS).length, 3, `${label}: session triggers`);
  assert.equal(fenceTriggers(fixture.database, NONCES).length, 3, `${label}: nonce triggers`);
};

const insertOidcSession = (fixture: Fixture): void => {
  const nowMs = Date.now();
  createConnectorAuthDb(fixture.database).recordOwnerAuthSession({ sessionId: randomUUID(),
    installationId: fixture.installationId, sessionTokenHash: hash(), csrfTokenHash: hash(),
    userId: fixture.userId, authMethod: 'oidc', authTimeMs: nowMs, expiresAtMs: nowMs + 600_000 });
};

test('fixture sanity: the real fence refuses a raw write to the owner tables', () => {
  const fixture = legacyFencedDatabase('sanity', { withNonce: true });
  try {
    assertFenceIntact(fixture, 'fixture');
    assert.throws(() => fixture.database.prepare(`DELETE FROM ${NONCES}`).run(),
      /no such function|connector_runtime_fence_required/u);
  } finally { fixture.database.close(); }
});

for (const withNonce of [true, false]) {
  test(`a lazy migrate outside the fence (nonces=${withNonce}) runs no DDL and keeps every trigger`, () => {
    const fixture = legacyFencedDatabase(`lazy-${withNonce}`, { withNonce });
    try {
      const before = { sql: tableSql(fixture.database, SESSIONS), triggers: fenceTriggers(fixture.database, SESSIONS) };
      // A registered but disarmed gate (the lazy runtimes' situation) and a
      // bare connection (the legacy migration CLI) are both "fence closed".
      new ConnectorRuntimeWriteGate(fixture.database, BUILD, fixture.authority);
      assert.doesNotThrow(() => migrateConnectorAuthSchema(fixture.database));
      assert.equal(tableSql(fixture.database, SESSIONS), before.sql, 'the legacy CHECK is left for a fenced boot');
      assert.deepEqual(fenceTriggers(fixture.database, SESSIONS), before.triggers);
      assertFenceIntact(fixture, 'after lazy migrate');
      assert.equal(rowCount(fixture.database, NONCES), withNonce ? 1 : 0);
    } finally { fixture.database.close(); }
  });
}

test('a fenced migrate outside boot order widens the CHECK and restores the triggers verbatim', () => {
  const fixture = legacyFencedDatabase('fenced', { withNonce: true });
  try {
    const triggersBefore = fenceTriggers(fixture.database, SESSIONS);
    const indexesBefore = indexes(fixture.database, SESSIONS);
    const gate = new ConnectorRuntimeWriteGate(fixture.database, BUILD, fixture.authority);
    assert.ok(gate.acquireForInitialization(randomUUID(), 30_000));
    assert.equal(gate.runFencedMutation(() => migrateConnectorAuthSchema(fixture.database), false), true);
    assert.ok(tableSql(fixture.database, SESSIONS).includes("'oidc'"));
    assert.deepEqual(fenceTriggers(fixture.database, SESSIONS), triggersBefore, 'same names, same SQL');
    assert.deepEqual(indexes(fixture.database, SESSIONS), indexesBefore);
    assertFenceIntact(fixture, 'after fenced migrate');
    assert.equal(rowCount(fixture.database, SESSIONS), 1, 'sessions preserved');
    assert.equal(rowCount(fixture.database, NONCES), 1, 'nonces preserved');
    assert.throws(() => insertOidcSession(fixture), /connector_runtime_fence_required/u,
      'the restored triggers still guard the rebuilt table');
    assert.equal(gate.runFencedMutation(() => insertOidcSession(fixture), false), true);
    assert.equal(rowCount(fixture.database, SESSIONS), 2, 'an oidc session is accepted under the fence');
  } finally { fixture.database.close(); }
});

test('the guarded boot migrates a fenced legacy database and leaves the preflight ready', () => {
  const fixture = legacyFencedDatabase('guarded', { withNonce: true });
  try {
    runConnectorPolicyV2GuardedBootstrap(fixture.database, fixture.rootPath,
      () => migrateConnectorAuthSchema(fixture.database));
    assert.ok(tableSql(fixture.database, SESSIONS).includes("'oidc'"));
    assertFenceIntact(fixture, 'after guarded boot');
    assert.equal(rowCount(fixture.database, NONCES), 1);
  } finally { fixture.database.close(); }
});

test('a fresh database gets the widened CHECK with no rebuild needed', () => {
  const database = new Database(path.join(directory, 'fresh.sqlite'));
  try {
    database.pragma('foreign_keys = ON');
    database.exec(INIT_SCHEMA_SQL);
    migrateConnectorAuthSchema(database);
    assert.ok(tableSql(database, SESSIONS).includes("'oidc'"));
    const rootPath = path.join(directory, 'fresh.authority.json');
    const { authority } = openOrCreateConnectorRuntimeAuthorityRoot(rootPath);
    reinstallConnectorRuntimeFence(database, authority);
    migrateConnectorAuthSchema(database);
    assert.equal(preflightConnectorRuntime(database, BUILD, authority).reason, 'ready');
    assert.equal(fenceTriggers(database, SESSIONS).length, 3);
  } finally { database.close(); }
});
