import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  migrateUserIdentities,
  rollbackUserIdentitiesAttestation,
  rollbackUserIdentitiesUserIdIndex,
  rollbackUserIdentitiesUserIssuerIndex,
} from './user-identities.migration.js';

const LEGACY_SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY);
CREATE TABLE user_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(issuer, subject)
);
INSERT INTO users (id) VALUES (1);
INSERT INTO user_identities (user_id, issuer, subject, created_at)
  VALUES (1, 'https://issuer.example', 'sub-1', '2026-01-01 00:00:00');`;

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: unknown };
const column = (db: Database.Database) => (db.prepare('PRAGMA table_info(user_identities)').all() as ColumnInfo[])
  .find((entry) => entry.name === 'last_attested_at');

test('T-1939: a legacy table gains a nullable INTEGER last_attested_at, rows preserved', () => {
  const db = new Database(':memory:');
  try {
    db.exec(LEGACY_SCHEMA);
    migrateUserIdentities(db);
    assert.deepEqual(
      { ...column(db) },
      { cid: 5, name: 'last_attested_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    );
    assert.deepEqual(db.prepare('SELECT user_id, subject, last_attested_at FROM user_identities').all(), [
      { user_id: 1, subject: 'sub-1', last_attested_at: null },
    ]);
    migrateUserIdentities(db);
    assert.equal((db.prepare('PRAGMA table_info(user_identities)').all()).length, 6, 'idempotent');
  } finally { db.close(); }
});

test('T-1939: a fresh database creates the table with the column in one step', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    migrateUserIdentities(db);
    assert.equal(column(db)?.type, 'INTEGER');
  } finally { db.close(); }
});

test('T-1939: the explicit rollback drops only the column and keeps the links', () => {
  const db = new Database(':memory:');
  try {
    db.exec(LEGACY_SCHEMA);
    migrateUserIdentities(db);
    db.prepare('UPDATE user_identities SET last_attested_at = ?').run(1_700_000_000_000);
    rollbackUserIdentitiesAttestation(db);
    assert.equal(column(db), undefined);
    assert.deepEqual(db.prepare('SELECT user_id, subject FROM user_identities').all(), [
      { user_id: 1, subject: 'sub-1' },
    ]);
    rollbackUserIdentitiesAttestation(db);
    migrateUserIdentities(db);
    assert.equal(column(db)?.type, 'INTEGER', 'rollback then migrate round-trips');
  } finally { db.close(); }
});

const userIdIndex = (db: Database.Database) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_identities_user_id'",
).get();

test('T-1939: the migration adds an idempotent user_id index the attestation lookup uses', () => {
  const db = new Database(':memory:');
  try {
    db.exec(LEGACY_SCHEMA);
    migrateUserIdentities(db);
    migrateUserIdentities(db);
    assert.ok(userIdIndex(db));
    assert.deepEqual(
      (db.prepare('PRAGMA index_info(idx_user_identities_user_id)').all() as Array<{ name: string }>)
        .map((entry) => entry.name),
      ['user_id'],
    );
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT last_attested_at FROM user_identities WHERE user_id = ?')
      .all(1) as Array<{ detail: string }>;
    assert.ok(plan.some((step) => step.detail.includes('idx_user_identities_user_id')), JSON.stringify(plan));
  } finally { db.close(); }
});

test('T-1939: the explicit index rollback drops only the index and round-trips', () => {
  const db = new Database(':memory:');
  try {
    db.exec(LEGACY_SCHEMA);
    migrateUserIdentities(db);
    rollbackUserIdentitiesUserIdIndex(db);
    assert.equal(userIdIndex(db), undefined);
    assert.equal(column(db)?.type, 'INTEGER');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM user_identities').get() as { n: number }).n, 1);
    rollbackUserIdentitiesUserIdIndex(db);
    migrateUserIdentities(db);
    assert.ok(userIdIndex(db), 'rollback then migrate round-trips');
  } finally { db.close(); }
});

const userIssuerIndex = (db: Database.Database) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_identities_user_issuer'",
).get();

function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test('T-1939 slice 5: a clean table gains UNIQUE(user_id, issuer) and refuses a second link', () => {
  const db = new Database(':memory:');
  try {
    db.exec(LEGACY_SCHEMA);
    assert.equal(migrateUserIdentities(db), 0);
    assert.equal(migrateUserIdentities(db), 0, 'idempotent');
    assert.ok(userIssuerIndex(db));
    const insert = db.prepare('INSERT INTO user_identities (user_id, issuer, subject) VALUES (?, ?, ?)');
    assert.throws(() => insert.run(1, 'https://issuer.example', 'sub-2'), /UNIQUE/);
    insert.run(1, 'https://other-issuer.example', 'sub-2');
  } finally { db.close(); }
});

test('T-1939 slice 5: legacy duplicates are kept, the index is skipped and a count-only warning logged', () => {
  const db = new Database(':memory:');
  try {
    db.exec(LEGACY_SCHEMA);
    db.exec(`INSERT INTO users (id) VALUES (2);
      INSERT INTO user_identities (user_id, issuer, subject) VALUES (1, 'https://issuer.example', 'sub-dup');`);
    let duplicates = -1;
    const log = captureStderr(() => { duplicates = migrateUserIdentities(db); });
    assert.equal(duplicates, 1);
    assert.equal(userIssuerIndex(db), undefined, 'nothing is created');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM user_identities').get() as { n: number }).n, 2);
    assert.deepEqual(JSON.parse(log.trim()), {
      level: 'warn', scope: 'oidc', code: 'user_issuer_unique_index_skipped', duplicateUsers: 1,
    });
    assert.doesNotMatch(log, /sub-dup|issuer\.example/);
    assert.equal(column(db)?.type, 'INTEGER', 'the rest of the migration still ran');

    db.exec("DELETE FROM user_identities WHERE subject = 'sub-dup'");
    assert.equal(migrateUserIdentities(db), 0);
    assert.ok(userIssuerIndex(db), 'created on the next run once the owner resolved it');
  } finally { db.close(); }
});

test('T-1939 slice 5: the explicit unique-index rollback drops only that index and round-trips', () => {
  const db = new Database(':memory:');
  try {
    db.exec(LEGACY_SCHEMA);
    migrateUserIdentities(db);
    rollbackUserIdentitiesUserIssuerIndex(db);
    assert.equal(userIssuerIndex(db), undefined);
    assert.ok(userIdIndex(db));
    rollbackUserIdentitiesUserIssuerIndex(db);
    migrateUserIdentities(db);
    assert.ok(userIssuerIndex(db));
  } finally { db.close(); }
});
