/**
 * B-164 — every account must carry a `password_changed_at` stamp.
 *
 * The stamp is what makes "changing your password logs out every other device"
 * work: authenticateToken only compares a token's `pwd_iat` against it when the
 * column is non-NULL (`if (user.password_changed_at && …)`). The column was
 * filled exclusively by a ONE-SHOT migration backfill, while `createUser` left
 * it NULL — so every account created after that migration silently opted out of
 * token invalidation for its whole lifetime: a password change or an admin reset
 * did not evict its live sessions, they simply ran to the 7-day TTL.
 *
 * Two halves are verified against a REAL migrated SQLite database:
 *   1. createUser stamps at insert (and returns the stamp, so a JWT minted
 *      straight from the result matches the row);
 *   2. runMigrations heals rows already on disk with a NULL stamp — using the
 *      account's own created_at, never "now", so healing does not evict the live
 *      sessions of the very users it repairs.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'users-pwd-stamp-'));
  const databasePath = path.join(tempDirectory, 'db.sqlite');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const stampOf = (id: number): number | null =>
  (
    getConnection()
      .prepare('SELECT password_changed_at FROM users WHERE id = ?')
      .get(id) as { password_changed_at: number | null }
  ).password_changed_at;

test('B-164: createUser stamps password_changed_at on the row', async () => {
  await withIsolatedDatabase(() => {
    const before = Date.now();
    const created = userDb.createUser('fresh', 'hash', 'user');
    const after = Date.now();

    const stamp = stampOf(created.id);
    assert.notEqual(stamp, null, 'a new account with a NULL stamp never invalidates its tokens');
    assert.ok(stamp! >= before && stamp! <= after, `stamp ${stamp} must be "now"`);
  });
});

test('B-164: createUser returns the same stamp it wrote (token mint matches the row)', async () => {
  await withIsolatedDatabase(() => {
    const created = userDb.createUser('invited', 'hash', 'user');
    assert.equal(created.password_changed_at, stampOf(created.id));
    // A JWT minted from this result carries pwd_iat === the row's stamp, so the
    // authenticateToken gate (`pwd_iat < password_changed_at`) passes.
    assert.equal(created.password_changed_at < (stampOf(created.id) as number) + 1, true);
  });
});

test('B-164: the stamp survives a re-run of the migrations (no overwrite)', async () => {
  await withIsolatedDatabase(() => {
    const created = userDb.createUser('stable', 'hash', 'user');
    const original = stampOf(created.id);

    runMigrations(getConnection());

    assert.equal(stampOf(created.id), original, 'an existing stamp must never be rewritten');
  });
});

test('B-164: migrations heal a legacy NULL stamp from created_at, not from "now"', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    // A row exactly as the pre-fix createUser left it: NULL stamp, old account.
    db.prepare(
      `INSERT INTO users (username, password_hash, role, status, created_at, password_changed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`
    ).run('legacy', 'hash', 'user', 'active', '2020-01-01 00:00:00');
    const id = (
      db.prepare("SELECT id FROM users WHERE username = 'legacy'").get() as { id: number }
    ).id;
    assert.equal(stampOf(id), null);

    runMigrations(db);

    const healed = stampOf(id);
    assert.equal(healed, Date.parse('2020-01-01T00:00:00Z'));
    // The point of using created_at: any token this user currently holds was
    // minted AFTER the account was created, so healing does not evict them —
    // stamping "now" would have logged out every legacy user on deploy.
    assert.ok(healed! < Date.now());
  });
});

test('B-164: a healed row then behaves like any other (a pre-stamp token is stale)', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.prepare(
      `INSERT INTO users (username, password_hash, role, status, created_at, password_changed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`
    ).run('legacy2', 'hash', 'user', 'active', '2020-01-01 00:00:00');
    const id = (
      db.prepare("SELECT id FROM users WHERE username = 'legacy2'").get() as { id: number }
    ).id;

    runMigrations(db);
    const healed = stampOf(id) as number;

    // Simulate a password change after the heal: the gate now actually fires.
    const changedAt = Date.now();
    userDb.changePassword(id, 'newhash', changedAt);
    assert.equal(stampOf(id), changedAt);
    assert.equal(healed < changedAt, true, 'tokens minted before the change are now rejected');
  });
});
