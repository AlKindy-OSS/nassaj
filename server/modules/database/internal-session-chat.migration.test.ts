/** ADR-187 migration contract: additive, idempotent, last, and never blocking account deletion. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  isInternalSessionChatSchemaBlocked, setInternalSessionChatSchemaBlocked,
} from '@/modules/database/internal-session-chat-flag.js';
import { migrateInternalSessionChat } from '@/modules/database/migrations.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { INTERNAL_SESSION_CHAT_SCHEMA_SQL } from '@/modules/database/schema.js';
import { isInternalChatReady } from '@/modules/internal-session-chat/index.js';

const snapshot = (db: Database.Database) => db.prepare(`SELECT type, name, sql FROM sqlite_master
  WHERE name LIKE 'session_internal%' OR name LIKE 'idx_internal%' ORDER BY name`).all();

const EXPECTED = [
  'index:idx_internal_members_user_session',
  'index:idx_internal_mentions_user_message',
  'index:idx_internal_messages_session_sequence',
  'table:session_internal_message_mentions',
  'table:session_internal_messages',
  'table:session_internal_room_members',
  'table:session_internal_rooms',
];
const ON = { NASSAJ_INTERNAL_SESSION_CHAT_ENABLED: '1' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

async function withStartupDatabase(flag: string | undefined, run: (db: Database.Database) => void) {
  const previous = { path: process.env.DATABASE_PATH, flag: process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED };
  const directory = await mkdtemp(path.join(tmpdir(), 'internal-chat-migration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  if (flag === undefined) delete process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED;
  else process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED = flag;
  try {
    await initializeDatabase();
    stopReconcileScheduler();
    run(getConnection());
  } finally {
    closeConnection();
    if (previous.path === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous.path;
    if (previous.flag === undefined) delete process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED;
    else process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED = previous.flag;
    await rm(directory, { recursive: true, force: true });
  }
}

/** Minimal parents plus the ORIGINAL ADR-170 draft shape (NOT NULL + RESTRICT actor FKs). */
const legacyDatabase = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
    ${INTERNAL_SESSION_CHAT_SCHEMA_SQL
    .replaceAll('INTEGER REFERENCES users(id) ON DELETE SET NULL', 'INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT')}`);
  return db;
};

test('flag off at startup: no chat table is created, so an older binary can still delete', async () => {
  await withStartupDatabase(undefined, (db) => {
    assert.deepEqual(snapshot(db), []);
    migrateInternalSessionChat(db, { NASSAJ_INTERNAL_SESSION_CHAT_ENABLED: 'true' } as NodeJS.ProcessEnv);
    assert.deepEqual(snapshot(db), [], "only the exact value '1' enables it");
    sessionsDb.createSession('moved', 'claude', '/tmp/project-a');
    assert.doesNotThrow(() => sessionsDb.createSession('moved', 'claude', '/tmp/project-b'),
      'a project transfer must not touch the absent room table');
  });
});

test('flag on at startup: four tables and three indexes, and reruns are a no-op', async () => {
  await withStartupDatabase('1', (db) => {
    const before = snapshot(db);
    assert.deepEqual(before.map((row: any) => `${row.type}:${row.name}`), EXPECTED);
    migrateInternalSessionChat(db, ON);
    migrateInternalSessionChat(db, ON);
    migrateInternalSessionChat(db, OFF);
    assert.deepEqual(snapshot(db), before);
  });
});

test('a blocked schema keeps the feature unavailable even with the flag on and tables present', async () => {
  await withStartupDatabase('1', () => {
    assert.equal(isInternalChatReady(), true);
    setInternalSessionChatSchemaBlocked(true);
    try {
      assert.equal(isInternalChatReady(), false);
    } finally { setInternalSessionChatSchemaBlocked(false); }
  });
});

test('an EMPTY legacy-shaped schema is replaced by the SET NULL shape', () => {
  const db = legacyDatabase();
  try {
    migrateInternalSessionChat(db, ON);
    const fk = db.prepare(`SELECT on_delete AS onDelete FROM pragma_foreign_key_list('session_internal_messages')
      WHERE "from" = 'author_user_id'`).get();
    assert.deepEqual(fk, { onDelete: 'SET NULL' });
    assert.deepEqual(snapshot(db).map((row: any) => `${row.type}:${row.name}`), EXPECTED);
  } finally { db.close(); }
});

test('a populated legacy-shaped schema never crashes boot: logged, untouched, feature blocked', () => {
  const db = legacyDatabase();
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    db.exec(`INSERT INTO users(id) VALUES (1); INSERT INTO sessions(session_id) VALUES ('s');
      INSERT INTO session_internal_rooms(session_id, created_by) VALUES ('s', 1);`);
    const before = snapshot(db);
    assert.doesNotThrow(() => migrateInternalSessionChat(db, ON));
    assert.equal(isInternalSessionChatSchemaBlocked(), true);
    assert.match(String(errors[0]?.[0]), /INTERNAL_CHAT_LEGACY_SCHEMA_NOT_EMPTY/);
    assert.deepEqual(errors[0]?.[1], { tables: ['session_internal_rooms'] });
    assert.deepEqual(snapshot(db), before);
    assert.equal((db.prepare('SELECT count(*) n FROM session_internal_rooms').get() as { n: number }).n, 1);
    db.exec('DELETE FROM session_internal_rooms');
    migrateInternalSessionChat(db, ON);
    assert.equal(isInternalSessionChatSchemaBlocked(), false, 'a clean rerun lifts the block');
  } finally {
    console.error = originalError;
    setInternalSessionChatSchemaBlocked(false);
    db.close();
  }
});

test('the DDL is additive only and every user reference releases on account deletion', () => {
  // Every statement is a CREATE ... IF NOT EXISTS; no statement drops, alters or writes rows.
  const statements = INTERNAL_SESSION_CHAT_SCHEMA_SQL.split(';').map(sql => sql.trim()).filter(Boolean);
  assert.equal(statements.length, 7);
  for (const sql of statements) assert.match(sql, /^CREATE (TABLE|INDEX) IF NOT EXISTS /);
  assert.doesNotMatch(INTERNAL_SESSION_CHAT_SCHEMA_SQL, /REFERENCES users\(id\) ON DELETE RESTRICT/);
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY);`);
    db.exec(INTERNAL_SESSION_CHAT_SCHEMA_SQL);
    db.exec(`INSERT INTO users(id) VALUES (1),(2);
      INSERT INTO sessions(session_id) VALUES ('s');
      INSERT INTO session_internal_rooms(session_id, created_by) VALUES ('s', 1);
      INSERT INTO session_internal_room_members(session_id, user_id, role, added_by)
        VALUES ('s', 1, 'owner', 1), ('s', 2, 'member', 1);
      INSERT INTO session_internal_messages(id, session_id, sequence, author_user_id, body,
        client_message_id, request_fingerprint) VALUES ('m', 's', 1, 1, 'hi', 'c', 'f');
      INSERT INTO session_internal_message_mentions(message_id, mentioned_user_id) VALUES ('m', 2);`);
    db.exec('DELETE FROM users WHERE id = 1');
    assert.deepEqual(db.prepare('SELECT created_by FROM session_internal_rooms').get(), { created_by: null });
    assert.deepEqual(db.prepare('SELECT author_user_id FROM session_internal_messages').get(), { author_user_id: null });
    assert.deepEqual(db.prepare('SELECT user_id, added_by FROM session_internal_room_members').all(),
      [{ user_id: 2, added_by: null }]);
  } finally {
    db.close();
  }
});
