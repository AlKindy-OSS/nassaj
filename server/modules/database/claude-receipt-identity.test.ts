import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from './connection.js';
import { initializeDatabase } from './init-db.js';
import { migrateMessageCoordination } from './migrations.js';
import { messageCoordinationDb } from './repositories/message-coordination.db.js';

const uuid = '21111111-2222-4333-8444-555555555555';
const digest = 'a'.repeat(64);

test('Claude UUID CAS is scoped, immutable across conflict/retry/reopen, and unique across owners', async () => {
  const directory = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'claude-receipt-'));
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await writeFile(process.env.DATABASE_PATH, ''); closeConnection();
  await initializeDatabase();
  try {
    const db = getConnection();
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'hash', 'admin')").run(1, 'owner');
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'hash', 'admin')").run(2, 'other');
    const base = { userId: 1, clientMsgId: 'c1', provider: 'claude', sessionId: null, canonicalContent: 'hello', coordinationLevel: 'direct' as const };
    const binding = { ...base, uuid, payloadSha256: digest };
    assert.equal(messageCoordinationDb.claim(base).action, 'dispatch');
    for (const patch of [{ userId: 2 }, { provider: 'codex' }, { sessionId: 'wrong' }, { clientMsgId: 'bad' }, { uuid: 'bad' }, { payloadSha256: 'bad' }]) {
      assert.equal(messageCoordinationDb.bindClaudeIdentity({ ...binding, ...patch }), false);
    }
    assert.equal(messageCoordinationDb.bindClaudeIdentity(binding), true);
    assert.equal(messageCoordinationDb.bindClaudeIdentity(binding), false, 'new invocation may not reuse bound dispatch');
    assert.equal(messageCoordinationDb.bindClaudeIdentity({ ...binding, payloadSha256: 'b'.repeat(64) }), false);
    messageCoordinationDb.claim({ ...base, userId: 2, clientMsgId: 'c2' });
    assert.equal(messageCoordinationDb.bindClaudeIdentity({ ...binding, userId: 2, clientMsgId: 'c2' }), false);
    assert.equal(messageCoordinationDb.bindSession('c1', 1, 'session', 'claude'), true);
    assert.equal(messageCoordinationDb.bindSession('c1', 1, 'fork', 'claude'), false);
    assert.equal(messageCoordinationDb.readClaudeIdentities(2, 'session').length, 0);
    assert.equal(messageCoordinationDb.readClaudeIdentities(1, 'fork').length, 0);
    assert.equal(messageCoordinationDb.readClaudeIdentities(1, 'session')[0].acceptedAt, null);
    assert.equal(messageCoordinationDb.markStarted({ ...base, sessionId: 'session' }), true);
    closeConnection(); await initializeDatabase();
    assert.equal(messageCoordinationDb.readClaudeIdentities(1, 'session')[0].uuid, uuid);
    assert.ok(messageCoordinationDb.readClaudeIdentities(1, 'session')[0].acceptedAt);
    assert.equal(messageCoordinationDb.bindClaudeIdentity({ ...binding, sessionId: 'session' }), false);
    const plan = getConnection().prepare("EXPLAIN QUERY PLAN SELECT claude_user_uuid FROM message_coordination_ingress INDEXED BY idx_coordination_claude_owner_session WHERE user_id=? AND provider='claude' AND session_id=? AND claude_user_uuid IS NOT NULL ORDER BY id LIMIT 1001").all(1, 'session');
    assert.match(JSON.stringify(plan), /idx_coordination_claude_owner_session/);

  } finally { closeConnection(); await rm(directory, { recursive: true, force: true }); }
});

test('additive migration leaves legacy evidence null and survives database reopen without backfill', async () => {
  const directory = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'claude-migration-'));
  const file = path.join(directory, 'db.sqlite'); let db = new Database(file);
  try {
    db.exec(`CREATE TABLE message_coordination_ingress (id INTEGER PRIMARY KEY, session_id TEXT,
      client_msg_id TEXT NOT NULL UNIQUE, user_id INTEGER, provider TEXT, canonical_content TEXT,
      content_hash TEXT, request_fingerprint TEXT, coordination_level TEXT, lifecycle_status TEXT,
      verdict_json TEXT, accepted_at TEXT, created_at TEXT)`);
    db.prepare('INSERT INTO message_coordination_ingress (id,client_msg_id,user_id,provider,lifecycle_status) VALUES (1,?,?,?,?)').run('old', 1, 'claude', 'terminal');
    migrateMessageCoordination(db);
    assert.deepEqual(db.prepare('SELECT claude_user_uuid,claude_payload_sha256,accepted_at FROM message_coordination_ingress').get(), { claude_user_uuid: null, claude_payload_sha256: null, accepted_at: null });
    db.close(); db = new Database(file); migrateMessageCoordination(db);
    assert.equal((db.prepare('SELECT count(*) AS count FROM message_coordination_ingress').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT claude_user_uuid FROM message_coordination_ingress').get() as { claude_user_uuid: null }).claude_user_uuid, null);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
