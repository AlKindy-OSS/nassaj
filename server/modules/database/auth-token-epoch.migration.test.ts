/**
 * T-2035 (ADR-212): the token-epoch / login-throttle migration against a real
 * migrated SQLite database — idempotent, additive, and independent of the
 * authorization-generation trigger that feeds permit and launch fences.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { migrateAuthTokenEpoch } from '@/modules/database/auth-token-epoch.migration.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auth-token-epoch-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const generationOf = (id: number): number => (getConnection()
  .prepare('SELECT authorization_generation AS g FROM users WHERE id = ?').get(id) as { g: number }).g;

test('migration is idempotent and adds exactly one token_epoch column', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    migrateAuthTokenEpoch(db);
    migrateAuthTokenEpoch(db);
    const columns = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string; dflt_value: string; notnull: number }>)
      .filter((column) => column.name === 'token_epoch');
    assert.equal(columns.length, 1);
    assert.equal(columns[0].notnull, 1);
    assert.equal(columns[0].dflt_value, '0');
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='login_throttle'").get();
    assert.ok(table, 'login_throttle exists');
    const index = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_login_throttle_updated_at'").get();
    assert.ok(index, 'prune index exists');
  });
});

test('an existing account starts at epoch 0 and a negative epoch is refused', async () => {
  await withIsolatedDatabase(() => {
    const created = userDb.createUser('epoch_owner', 'hash');
    assert.equal(userDb.getTokenEpoch(created.id), 0);
    assert.equal(userDb.getUserById(created.id)?.token_epoch, 0);
    assert.throws(
      () => getConnection().prepare('UPDATE users SET token_epoch = -1 WHERE id = ?').run(created.id),
      /CHECK constraint failed/,
    );
  });
});

test('bumping the epoch leaves authorization_generation untouched', async () => {
  await withIsolatedDatabase(() => {
    const created = userDb.createUser('epoch_member', 'hash');
    const before = generationOf(created.id);
    assert.equal(userDb.bumpTokenEpoch(created.id), 1);
    assert.equal(userDb.bumpTokenEpoch(created.id), 2);
    assert.equal(generationOf(created.id), before, 'the permit/launch generation must not move');
    assert.equal(userDb.isAuthorizationPrincipalCurrent(created.id, before), true);
    assert.equal(userDb.bumpTokenEpoch(999_999), null, 'unknown user');
    const trigger = getConnection()
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_users_authorization_generation'")
      .get() as { sql: string } | undefined;
    assert.ok(trigger);
    assert.equal(trigger.sql.includes('token_epoch'), false);
  });
});
