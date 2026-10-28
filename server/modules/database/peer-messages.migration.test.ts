/**
 * ADR-219 S1 — the relay migration is additive, idempotent and reversible, and
 * every statement is a single statement (the admitted boot path's contract).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migratePeerMessages, PEER_MESSAGES_MIGRATION_SQL, rollbackPeerMessages } from './peer-messages.migration.js';

const tables = (db: Database.Database): string[] => (db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'peer_%' ORDER BY name").all() as Array<{ name: string }>)
  .map((row) => row.name);

test('creates the four tables and four indexes, twice without error, and rolls back cleanly', () => {
  const db = new Database(':memory:');
  migratePeerMessages(db);
  migratePeerMessages(db);
  assert.deepEqual(tables(db), ['peer_agent_origin_hops', 'peer_messages', 'peer_session_cost_totals']);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_permission_modes'").get());
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_peer_%'").all() as unknown[]).length;
  assert.equal(indexes, 4);
  assert.throws(() => db.prepare(`INSERT INTO peer_messages (id, ref_token, chain_id, from_user_id, from_session_id,
    from_mode, to_session_id, body, body_sha256, body_bytes, hop, state, created_at, updated_at)
    VALUES ('a', 'r', 'c', 1, 's', 'bypass', 't', 'b', 'h', 1, 0, 'queued', 1, 1)`).run(), /CHECK/u, 'hop ≥ 1');
  rollbackPeerMessages(db);
  assert.deepEqual(tables(db), []);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_permission_modes'").get(), undefined);
  db.close();
});

test('every statement is one statement (no `;`), as the reviewed startup trace requires', () => {
  for (const sql of PEER_MESSAGES_MIGRATION_SQL) assert.equal(sql.includes(';'), false, sql.slice(0, 60));
});
