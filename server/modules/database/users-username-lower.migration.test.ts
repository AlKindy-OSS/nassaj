/**
 * Case-insensitive username uniqueness index (T-1939 slice 4, qa follow-up):
 * created when no case-only duplicates exist, otherwise skipped with a WARN and
 * an audit row — users are never renamed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  migrateUsernameLowerUniqueIndex,
  rollbackUsernameLowerUniqueIndex,
} from './users-username-lower.migration.js';

const SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL,
  metadata TEXT, ip_address TEXT, user_agent TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`;

const hasIndex = (db: Database.Database) => db
  .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'idx_users_username_lower'")
  .get() !== undefined;

test('no case duplicates: the unique lower(username) index is created, idempotently', () => {
  const db = new Database(':memory:');
  try {
    db.exec(SCHEMA);
    db.exec("INSERT INTO users (username) VALUES ('Sara'), ('omar')");
    assert.equal(migrateUsernameLowerUniqueIndex(db), 0);
    assert.equal(migrateUsernameLowerUniqueIndex(db), 0);
    assert.equal(hasIndex(db), true);
    assert.throws(() => db.exec("INSERT INTO users (username) VALUES ('SARA')"), /UNIQUE/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, 0);
    rollbackUsernameLowerUniqueIndex(db);
    assert.equal(hasIndex(db), false);
  } finally { db.close(); }
});

test('case duplicates: the index is skipped with a WARN and an audit row; users untouched', () => {
  const db = new Database(':memory:');
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    db.exec(SCHEMA);
    db.exec("INSERT INTO users (username) VALUES ('Sara'), ('sara'), ('Omar'), ('OMAR'), ('lina')");
    const groups = migrateUsernameLowerUniqueIndex(db);
    process.stderr.write = original;
    assert.equal(groups, 2);
    assert.equal(hasIndex(db), false);
    assert.deepEqual(db.prepare('SELECT username FROM users ORDER BY id').all().map((row) => (row as
      { username: string }).username), ['Sara', 'sara', 'Omar', 'OMAR', 'lina']);
    assert.deepEqual(db.prepare('SELECT user_id, action, metadata FROM audit_log').all(), [
      { user_id: null, action: 'username_lower_unique_index_skipped', metadata: '{"duplicateGroups":2}' },
    ]);
    const warn = JSON.parse(writes.join('').trim());
    assert.deepEqual(warn, {
      level: 'warn', scope: 'auth', code: 'username_lower_unique_index_skipped', duplicateGroups: 2,
    });
    assert.ok(!writes.join('').toLowerCase().includes('sara'), 'no username in the log');
  } finally {
    process.stderr.write = original;
    db.close();
  }
});
