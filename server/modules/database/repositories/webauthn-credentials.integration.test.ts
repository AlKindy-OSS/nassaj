import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { webauthnCredentialsDb } from '@/modules/database/repositories/webauthn-credentials.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'webauthn-db-'));
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

test('schema: webauthn_credentials table and user index exist after migrations', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(tables.includes('webauthn_credentials'));

    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='webauthn_credentials'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(indexes.includes('idx_webauthn_credentials_user_id'));
  });
});

test('webauthnCredentialsDb: create + getById round-trips public key bytes and transports', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUser('alice', 'hash', 'user');
    const publicKey = Buffer.from([1, 2, 3, 4, 5]);

    webauthnCredentialsDb.create({
      id: 'cred-abc',
      userId: user.id,
      publicKey,
      counter: 7,
      transports: ['internal', 'hybrid'],
      deviceType: 'multiDevice',
      backedUp: true,
      aaguid: 'aaguid-1',
      name: 'iPhone',
    });

    const row = webauthnCredentialsDb.getById('cred-abc');
    assert.ok(row);
    assert.equal(row!.user_id, user.id);
    assert.ok(Buffer.isBuffer(row!.public_key));
    assert.deepEqual(Buffer.from(row!.public_key), publicKey);
    assert.equal(row!.counter, 7);
    assert.deepEqual(JSON.parse(row!.transports!), ['internal', 'hybrid']);
    assert.equal(row!.device_type, 'multiDevice');
    assert.equal(row!.backed_up, 1);
    assert.equal(row!.aaguid, 'aaguid-1');
    assert.equal(row!.name, 'iPhone');
    assert.equal(row!.last_used_at, null);
  });
});

test('webauthnCredentialsDb: listByUserId never exposes public_key and scopes by user', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user');
    const bob = userDb.createUser('bob', 'hash', 'user');
    webauthnCredentialsDb.create({ id: 'a1', userId: alice.id, publicKey: Buffer.from([1]) });
    webauthnCredentialsDb.create({ id: 'b1', userId: bob.id, publicKey: Buffer.from([2]) });

    const list = webauthnCredentialsDb.listByUserId(alice.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'a1');
    assert.ok(!('public_key' in list[0]));
  });
});

test('webauthnCredentialsDb: updateCounterAndLastUsed advances counter and stamps usage', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUser('alice', 'hash', 'user');
    webauthnCredentialsDb.create({ id: 'c1', userId: user.id, publicKey: Buffer.from([1]) });

    webauthnCredentialsDb.updateCounterAndLastUsed('c1', 42);

    const row = webauthnCredentialsDb.getById('c1');
    assert.equal(row!.counter, 42);
    assert.ok(row!.last_used_at, 'last_used_at stamped');
  });
});

test('webauthnCredentialsDb: rename and delete enforce ownership', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user');
    const bob = userDb.createUser('bob', 'hash', 'user');
    webauthnCredentialsDb.create({ id: 'c1', userId: alice.id, publicKey: Buffer.from([1]) });

    assert.equal(webauthnCredentialsDb.rename('c1', bob.id, 'stolen'), false, 'non-owner rename rejected');
    assert.equal(webauthnCredentialsDb.rename('c1', alice.id, 'My key'), true);
    assert.equal(webauthnCredentialsDb.getById('c1')!.name, 'My key');

    assert.equal(webauthnCredentialsDb.deleteByIdForUser('c1', bob.id), false, 'non-owner delete rejected');
    assert.equal(webauthnCredentialsDb.deleteByIdForUser('c1', alice.id), true);
    assert.equal(webauthnCredentialsDb.getById('c1'), undefined);
  });
});

test('webauthnCredentialsDb: deleting a user cascades to their credentials', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const user = userDb.createUser('alice', 'hash', 'user');
    webauthnCredentialsDb.create({ id: 'c1', userId: user.id, publicKey: Buffer.from([1]) });

    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    assert.equal(webauthnCredentialsDb.getById('c1'), undefined);
  });
});
