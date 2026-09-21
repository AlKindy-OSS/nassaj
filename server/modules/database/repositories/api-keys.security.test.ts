import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { digestApiKey } from '@/modules/database/api-key-digest.js';
import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { migrateApiKeysToDigests } from '@/modules/database/migrations.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import {
  ApiKeyInputError,
  MAX_API_KEYS_PER_USER,
  apiKeysDb,
} from '@/modules/database/repositories/api-keys.js';
import { userDb } from '@/modules/database/repositories/users.js';

const RAW_KEY_A = `ck_${'a'.repeat(64)}`;
const RAW_KEY_B = `ck_${'b'.repeat(64)}`;

async function withIsolatedDatabase(run: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'api-key-security-'));
  const databasePath = path.join(directory, 'auth.db');
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  stopReconcileScheduler();
  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_config (key, value) VALUES ('external_api.enabled', '1');
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key_name TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used DATETIME,
      is_active BOOLEAN DEFAULT 1
    );
    INSERT INTO users (id, username) VALUES (1, 'synthetic-owner');
  `);
  return db;
}

test('created API key is revealed once and only its digest and prefix persist', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUser('synthetic-api-owner', 'hash', 'owner');
    const created = apiKeysDb.createApiKey(user.id, 'Automation');
    assert.match(created.apiKey, /^ck_[0-9a-f]{64}$/);

    const stored = getConnection()
      .prepare('SELECT key_digest, key_prefix FROM api_keys WHERE id = ?')
      .get(created.id) as { key_digest: string; key_prefix: string };
    assert.equal(stored.key_digest, digestApiKey(created.apiKey));
    assert.equal(stored.key_prefix, created.apiKey.slice(0, 10));
    assert.ok(!JSON.stringify(stored).includes(created.apiKey));

    const listed = apiKeysDb.getApiKeys(user.id);
    assert.equal(listed[0]?.api_key, `${stored.key_prefix}...`);
    assert.ok(!JSON.stringify(listed).includes(stored.key_digest));
    assert.equal(apiKeysDb.validateApiKey(created.apiKey)?.id, user.id);
  });
});

test('digest uniqueness and disabled-key validation fail closed', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUser('synthetic-api-user', 'hash', 'user');
    const created = apiKeysDb.createApiKey(user.id, 'Primary');
    const digest = digestApiKey(created.apiKey);
    assert.ok(digest);
    assert.throws(() => {
      getConnection()
        .prepare(
          'INSERT INTO api_keys (user_id, key_name, key_digest, key_prefix) VALUES (?, ?, ?, ?)'
        )
        .run(user.id, 'Duplicate', digest, created.apiKey.slice(0, 10));
    }, /UNIQUE/);

    assert.equal(apiKeysDb.toggleApiKey(user.id, Number(created.id), false), true);
    assert.equal(apiKeysDb.validateApiKey(created.apiKey), undefined);
    assert.equal(apiKeysDb.validateApiKey('malformed'), undefined);
  });
});

test('key-name and per-user count bounds are enforced before storage', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUser('synthetic-bounded-user', 'hash', 'user');
    assert.throws(
      () => apiKeysDb.createApiKey(user.id, 'x'.repeat(81)),
      (error: unknown) => error instanceof ApiKeyInputError && error.code === 'invalid_name'
    );
    for (let index = 0; index < MAX_API_KEYS_PER_USER; index += 1) {
      apiKeysDb.createApiKey(user.id, `Key ${index}`);
    }
    assert.throws(
      () => apiKeysDb.createApiKey(user.id, 'One too many'),
      (error: unknown) => error instanceof ApiKeyInputError && error.code === 'limit_reached'
    );
  });
});

test('legacy plaintext rows migrate atomically to tagged digests', () => {
  const db = legacyDatabase();
  try {
    db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)')
      .run(1, 'Existing', RAW_KEY_A);
    migrateApiKeysToDigests(db);
    const columns = db.pragma('table_info(api_keys)') as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'key_digest'));
    assert.ok(!columns.some((column) => column.name === 'api_key'));
    const row = db.prepare('SELECT key_digest, key_prefix FROM api_keys').get() as {
      key_digest: string;
      key_prefix: string;
    };
    assert.equal(row.key_digest, digestApiKey(RAW_KEY_A));
    assert.equal(row.key_prefix, RAW_KEY_A.slice(0, 10));
  } finally {
    db.close();
  }
});

test('database initialization upgrades a legacy plaintext API-key table', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    const user = userDb.createUser('legacy-api-owner', 'hash', 'owner');
    db.exec(`
      DROP TABLE api_keys;
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        key_name TEXT NOT NULL,
        api_key TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used DATETIME,
        is_active BOOLEAN DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)')
      .run(user.id, 'Pre-upgrade', RAW_KEY_A);

    closeConnection();
    await initializeDatabase();
    stopReconcileScheduler();

    const upgraded = getConnection();
    const columns = upgraded.pragma('table_info(api_keys)') as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'key_digest'));
    assert.ok(!columns.some((column) => column.name === 'api_key'));
    assert.deepEqual(
      upgraded.prepare('SELECT key_digest, key_prefix FROM api_keys').get(),
      {
        key_digest: digestApiKey(RAW_KEY_A),
        key_prefix: RAW_KEY_A.slice(0, 10),
      }
    );
    const digestIndex = (
      upgraded.pragma('index_list(api_keys)') as Array<{ name: string; unique: number }>
    ).find((index) => index.name === 'idx_api_keys_digest');
    assert.equal(digestIndex?.unique, 1);
    assert.deepEqual(
      (upgraded.pragma('index_info(idx_api_keys_digest)') as Array<{ name: string }>)
        .map((column) => column.name),
      ['key_digest']
    );
  });
});

test('malformed legacy row rolls back every conversion and turns the master switch off', () => {
  const db = legacyDatabase();
  try {
    const insert = db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)');
    insert.run(1, 'Valid', RAW_KEY_B);
    insert.run(1, 'Malformed', 'legacy-short-secret');

    assert.throws(() => migrateApiKeysToDigests(db), /api_key_plaintext_malformed/);
    const columns = db.pragma('table_info(api_keys)') as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'api_key'));
    assert.ok(!columns.some((column) => column.name === 'key_digest'));
    assert.deepEqual(
      db.prepare('SELECT api_key FROM api_keys ORDER BY id').all(),
      [{ api_key: RAW_KEY_B }, { api_key: 'legacy-short-secret' }]
    );
    assert.equal(
      (db.prepare("SELECT value FROM app_config WHERE key = 'external_api.enabled'").get() as { value: string }).value,
      '0'
    );
  } finally {
    db.close();
  }
});

test('mixed and partial API-key schemas are rejected with the master switch off', () => {
  for (const extraColumns of [
    'key_digest TEXT, key_prefix TEXT',
    'key_digest TEXT',
    'key_prefix TEXT',
  ]) {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO app_config (key, value) VALUES ('external_api.enabled', '1');
        CREATE TABLE api_keys (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          key_name TEXT NOT NULL,
          api_key TEXT NOT NULL,
          ${extraColumns},
          created_at DATETIME,
          last_used DATETIME,
          is_active BOOLEAN DEFAULT 1
        );
      `);
      assert.throws(() => migrateApiKeysToDigests(db), /api_key_storage_schema_mixed_or_partial/);
      assert.equal(
        (db.prepare("SELECT value FROM app_config WHERE key = 'external_api.enabled'").get() as { value: string }).value,
        '0',
      );
      assert.ok((db.pragma('table_info(api_keys)') as Array<{ name: string }>).some((column) => column.name === 'api_key'));
    } finally {
      db.close();
    }
  }
});
