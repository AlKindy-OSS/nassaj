/**
 * ADR-194 / T-1962 S4 blocker: nodes updated through the update button boot on
 * the admitted path (initializeAdmittedDatabase), which never runs
 * runMigrations. A pre-T-1962 database must still gain every SSO table there,
 * and the state model must then answer from real tables: a non-owner link
 * without any row is enforced and unavailable (or paused with legacy env),
 * never a crash and never "off".
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { stopReconcileScheduler } = await import('@/modules/database/project-reconcile.service.js');
const { runConnectorPolicyV2GuardedBootstrap } = // eslint-disable-next-line boundaries/dependencies -- admission exercises the real substrate bootstrap.
  await import('@/modules/connectors/connector-substrate-only.production.js');
const { resetSsoConfigCacheForTests, ssoLoginAvailable, ssoPolicyEnforced, ssoState } =
  await import('@/services/sso-config.service.js');

const SSO_OBJECTS = ['idx_sso_apply_proofs_binding', 'sso_apply_proofs', 'sso_oidc_config', 'sso_test_results'];

/** A database as a pre-T-1962 build left it: no SSO tables, an owner and a linked member. */
async function withPreSsoDatabase(run: (database: Database) => Promise<void>): Promise<void> {
  admitted = false;
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp('/var/tmp/nassaj-sso-admitted-');
  const databasePath = path.join(directory, 'auth.db');
  process.env.DATABASE_PATH = databasePath;
  closeConnection();
  await writeFile(databasePath, '');
  await initializeDatabase();
  stopReconcileScheduler();
  const database = getConnection();
  database.prepare("INSERT INTO users (username, password_hash, role) VALUES ('pre-owner', 'x', 'owner')").run();
  const memberId = Number(database.prepare("INSERT INTO users (username, password_hash, role) VALUES ('pre-member', 'x', 'user')")
    .run().lastInsertRowid);
  database.prepare('INSERT INTO user_identities (user_id, issuer, subject) VALUES (?, ?, ?)')
    .run(memberId, 'https://idp.example', 'sub-member');
  database.prepare("INSERT INTO app_config (key, value) VALUES ('jwt_secret', ?)").run('a'.repeat(32));
  database.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)').run('public', 'private');
  runConnectorPolicyV2GuardedBootstrap(database, `${databasePath}.connector-runtime-authority.json`, () => {
    database.prepare(`INSERT INTO connector_m5_installation_origin (installation_id, canonical_origin, updated_at_ms)
      SELECT installation_id, 'https://existing.example', 0 FROM connector_installations WHERE singleton = 1`).run();
  });
  database.exec('DROP TABLE sso_oidc_config; DROP TABLE sso_test_results; DROP TABLE sso_apply_proofs;');
  try {
    await run(database);
  } finally {
    admitted = false;
    delete process.env.OIDC_ENABLED;
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

const ssoObjects = (database: Database) => (database.prepare(`SELECT name FROM sqlite_schema
  WHERE name IN (${SSO_OBJECTS.map(() => '?').join(',')}) ORDER BY name`).all(...SSO_OBJECTS) as Array<{ name: string }>)
  .map((row) => row.name);

test('admitted boot of a pre-T-1962 database creates every SSO table and the state is enforced, not a crash', async () => {
  await withPreSsoDatabase(async (database) => {
    assert.deepEqual(ssoObjects(database), [], 'fixture is pre-T-1962');
    admitted = true;
    await initializeDatabase();
    assert.deepEqual(ssoObjects(database), SSO_OBJECTS);
    resetSsoConfigCacheForTests();
    assert.equal(ssoState(), 'unavailable', 'a non-owner link without a row is enforced and unavailable');
    assert.equal(ssoPolicyEnforced(), true);
    assert.equal(ssoLoginAvailable(), false);
    process.env.OIDC_ENABLED = 'true';
    assert.equal(ssoState(), 'paused', 'legacy env on a readable, empty table is paused');
    await assert.doesNotReject(initializeDatabase(), 'idempotent on the next admitted boot');
    assert.deepEqual(ssoObjects(database), SSO_OBJECTS);
  });
});

test('the guarded bootstrap also recreates the SSO tables', async () => {
  await withPreSsoDatabase(async (database) => {
    await initializeDatabase();
    stopReconcileScheduler();
    assert.deepEqual(ssoObjects(database), SSO_OBJECTS);
  });
});
