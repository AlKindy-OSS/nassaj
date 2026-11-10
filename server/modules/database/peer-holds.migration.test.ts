/**
 * ADR-219 P2a-min §3 (ح-1, م-8): holds are additive only. A new `peer_holds`
 * table, and `peer_messages.hold_id` by ADD COLUMN only when PRAGMA table_info
 * lacks it. `peer_messages` and its state CHECK are never rebuilt; every
 * statement is one statement and appears verbatim in the startup SQL contract.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migratePeerMessages, PEER_MESSAGES_TABLE_SQL } from './peer-messages.migration.js';
import {
  migratePeerHolds, PEER_HOLDS_MIGRATION_SQL, PEER_MESSAGES_HOLD_ID_COLUMN_SQL, PEER_MESSAGES_TABLE_INFO_SQL,
  rollbackPeerHoldsForTests,
} from './peer-holds.migration.js';

const columns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

function fresh(): Database.Database {
  const db = new Database(':memory:');
  migratePeerMessages(db);
  return db;
}

const HOLD = `INSERT INTO peer_holds (id, chain_id, from_user_id, from_session_id, from_mode, to_user_id,
  to_session_id, body, body_sha256, body_bytes, hop, hold_causes, state, expires_at, created_at, updated_at)
  VALUES (@id, 'c', 1, 's1', 'prompting', 2, 's2', 'b', 'h', 1, 1, @causes, @state, 9, 1, 1)`;

test('creates peer_holds, four indexes and hold_id; idempotent', () => {
  const db = fresh();
  migratePeerHolds(db);
  migratePeerHolds(db);
  assert.ok(columns(db, 'peer_holds').includes('hold_version'));
  assert.equal(columns(db, 'peer_messages').filter((c) => c === 'hold_id').length, 1);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_peer_holds_%'").all();
  assert.equal(indexes.length, 4);
  db.close();
});

test('peer_messages is never rebuilt: its CREATE text is unchanged and its rows survive', () => {
  const db = fresh();
  db.prepare(`INSERT INTO peer_messages (id, ref_token, chain_id, from_user_id, from_session_id, from_mode,
    to_session_id, body, body_sha256, body_bytes, hop, state, created_at, updated_at)
    VALUES ('pm1', 'r', 'c', 1, 's', 'bypass', 't', 'b', 'h', 1, 1, 'queued', 1, 1)`).run();
  migratePeerHolds(db);
  assert.equal((db.prepare("SELECT hold_id FROM peer_messages WHERE id = 'pm1'").get() as { hold_id: unknown }).hold_id, null);
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'peer_messages'").get() as { sql: string }).sql;
  assert.ok(sql.startsWith(PEER_MESSAGES_TABLE_SQL.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE').slice(0, 40)));
  assert.ok(sql.includes("CHECK (state IN ('queued', 'delivering', 'delivered', 'refused', 'deferred_quota', 'failed'))"));
  db.close();
});

test('the CHECKs admit every P2 cause and state now, and nothing else', () => {
  const db = fresh();
  migratePeerHolds(db);
  const insert = db.prepare(HOLD);
  let n = 0;
  for (const causes of ['cross_member', 'mode_mismatch', 'cross_member+mode_mismatch']) {
    for (const state of ['held', 'promoted', 'rejected', 'expired', 'cancelled']) insert.run({ id: `h${n++}`, causes, state });
  }
  assert.throws(() => insert.run({ id: 'bad1', causes: 'trust', state: 'held' }), /CHECK/u);
  assert.throws(() => insert.run({ id: 'bad2', causes: 'cross_member', state: 'approved' }), /CHECK/u);
  db.close();
});

test('every statement is one statement and the column probe is a read', () => {
  for (const sql of PEER_HOLDS_MIGRATION_SQL) assert.equal(sql.includes(';'), false, sql.slice(0, 60));
  assert.equal(PEER_MESSAGES_TABLE_INFO_SQL, 'PRAGMA table_info(peer_messages)');
  assert.equal(PEER_MESSAGES_HOLD_ID_COLUMN_SQL, 'ALTER TABLE peer_messages ADD COLUMN hold_id TEXT');
  for (const sql of PEER_HOLDS_MIGRATION_SQL) assert.doesNotMatch(sql, /user_version|DROP|RENAME/iu);
});

test('every statement is in the reviewed startup SQL contract, after the S1 relay tables', () => {
  const contract = readFileSync(path.join(import.meta.dirname, '__tests__/startup-sql-trace-contract.mjs'), 'utf8');
  const normalize = (s: string) => s.replace(/\s+/gu, ' ').trim();
  const reviewed = normalize(contract.replace(/\\n/gu, '\n'));
  const anchor = reviewed.indexOf('CREATE TABLE IF NOT EXISTS session_permission_modes');
  assert.ok(anchor > 0);
  let at = anchor;
  for (const sql of [...PEER_HOLDS_MIGRATION_SQL, PEER_MESSAGES_TABLE_INFO_SQL, PEER_MESSAGES_HOLD_ID_COLUMN_SQL]) {
    const found = reviewed.indexOf(normalize(sql), at);
    assert.ok(found > at, `missing or out of order in the contract: ${sql.slice(0, 60)}`);
    at = found;
  }
});

test('rollback for test DBs drops the table and the column', () => {
  const db = fresh();
  migratePeerHolds(db);
  rollbackPeerHoldsForTests(db);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'peer_holds'").get(), undefined);
  assert.equal(columns(db, 'peer_messages').includes('hold_id'), false);
  db.close();
});
