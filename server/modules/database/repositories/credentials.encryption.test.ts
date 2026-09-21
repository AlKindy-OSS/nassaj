import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { migrateUserCredentialsEncryption } from '@/modules/database/migrations.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { credentialsDb } from '@/modules/database/repositories/credentials.js';
import { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
import { userDb } from '@/modules/database/repositories/users.js';

const TEST_KEY = '11'.repeat(32);

async function withIsolatedDatabase(run: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  const directory = await mkdtemp(path.join(tmpdir(), 'credential-encryption-'));
  const databasePath = path.join(directory, 'auth.db');
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = TEST_KEY;
  await initializeDatabase();
  stopReconcileScheduler();
  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousKey === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
    else process.env.NASSAJ_PROVIDER_SECRETS_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
}

function legacyCredentialDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE user_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      credential_name TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      credential_value TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT 1
    )
  `);
  return db;
}

test('credential plaintext never persists and GitHub decrypts only at its repository boundary', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUser('synthetic-credential-owner', 'hash', 'owner');
    const secret = 'ghp_synthetic_secret_value';
    const created = githubTokensDb.createGithubToken(user.id, 'GitHub', secret);
    const stored = getConnection()
      .prepare('SELECT credential_value FROM user_credentials WHERE id = ?')
      .get(created.id) as { credential_value: string };
    assert.match(stored.credential_value, /^dbcred:v1:/);
    assert.ok(!stored.credential_value.includes(secret));
    assert.ok(!stored.credential_value.startsWith('ghp_'), 'an old binary must not accept ciphertext as a GitHub token');
    assert.equal(credentialsDb.getActiveCredential(user.id, 'github_token'), secret);
    const github = githubTokensDb.getGithubTokenById(user.id, Number(created.id));
    assert.equal(github?.github_token, secret);
    assert.ok(!Object.prototype.hasOwnProperty.call(github, 'credential_value'));
  });
});

test('tamper and cross-user row swaps fail authentication', async () => {
  await withIsolatedDatabase(() => {
    const first = userDb.createUser('synthetic-first', 'hash', 'user');
    const second = userDb.createUser('synthetic-second', 'hash', 'user');
    const firstCredential = credentialsDb.createCredential(first.id, 'A', 'github_token', 'secret-a');
    const secondCredential = credentialsDb.createCredential(second.id, 'B', 'github_token', 'secret-b');
    const db = getConnection();
    const firstEnvelope = (db
      .prepare('SELECT credential_value FROM user_credentials WHERE id = ?')
      .get(firstCredential.id) as { credential_value: string }).credential_value;

    db.prepare('UPDATE user_credentials SET credential_value = ? WHERE id = ?')
      .run(firstEnvelope, secondCredential.id);
    assert.equal(credentialsDb.getActiveCredential(second.id, 'github_token'), null);

    const tampered = firstEnvelope.slice(0, -1) + (firstEnvelope.endsWith('A') ? 'B' : 'A');
    db.prepare('UPDATE user_credentials SET credential_value = ? WHERE id = ?')
      .run(tampered, firstCredential.id);
    assert.equal(credentialsDb.getActiveCredential(first.id, 'github_token'), null);
  });
});

test('legacy plaintext migration is atomic, idempotent, and decryptable', () => {
  const previousKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = TEST_KEY;
  const db = legacyCredentialDatabase();
  try {
    db.prepare(
      'INSERT INTO user_credentials (id, user_id, credential_name, credential_type, credential_value) VALUES (?, ?, ?, ?, ?)'
    ).run(7, 3, 'Synthetic', 'github_token', 'legacy-secret');
    migrateUserCredentialsEncryption(db);
    const once = (db.prepare('SELECT credential_value FROM user_credentials WHERE id = 7').get() as { credential_value: string }).credential_value;
    assert.match(once, /^dbcred:v1:/);
    assert.ok(!once.includes('legacy-secret'));
    migrateUserCredentialsEncryption(db);
    const twice = (db.prepare('SELECT credential_value FROM user_credentials WHERE id = 7').get() as { credential_value: string }).credential_value;
    assert.equal(twice, once);
  } finally {
    db.close();
    if (previousKey === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
    else process.env.NASSAJ_PROVIDER_SECRETS_KEY = previousKey;
  }
});

test('tampered existing envelope rolls back plaintext conversions and wrong key fails closed', () => {
  const previousKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = TEST_KEY;
  const db = legacyCredentialDatabase();
  try {
    const insert = db.prepare(
      'INSERT INTO user_credentials (id, user_id, credential_name, credential_type, credential_value) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run(1, 1, 'Plain', 'github_token', 'must-remain-plaintext-after-rollback');
    insert.run(2, 1, 'Tampered', 'github_token', 'dbcred:v1:AAAA:BBBB:CCCC');
    assert.throws(() => migrateUserCredentialsEncryption(db));
    assert.equal(
      (db.prepare('SELECT credential_value FROM user_credentials WHERE id = 1').get() as { credential_value: string }).credential_value,
      'must-remain-plaintext-after-rollback'
    );

    db.prepare('DELETE FROM user_credentials WHERE id = 2').run();
    migrateUserCredentialsEncryption(db);
    process.env.NASSAJ_PROVIDER_SECRETS_KEY = '22'.repeat(32);
    assert.throws(() => migrateUserCredentialsEncryption(db));
  } finally {
    db.close();
    if (previousKey === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
    else process.env.NASSAJ_PROVIDER_SECRETS_KEY = previousKey;
  }
});
