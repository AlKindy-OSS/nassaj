import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateMessageCoordination } from './migrations.js';

const LEGACY_MESSAGE_COORDINATION_SQL = `
CREATE TABLE message_coordination_ingress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    client_msg_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    canonical_content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    coordination_level TEXT NOT NULL,
    created_at TEXT NOT NULL
);
`;

const insertLegacyRow = (db: Database.Database, clientMsgId: string): void => {
  db.prepare(
    `INSERT INTO message_coordination_ingress
       (session_id, client_msg_id, user_id, provider, canonical_content, content_hash,
        request_fingerprint, coordination_level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'session-legacy', clientMsgId, 1, 'codex', 'historical prompt',
    'content-hash', 'request-fingerprint', 'direct', '2026-08-18T00:00:00.000Z',
  );
};

const columns = (db: Database.Database): string[] => (
  db.prepare('PRAGMA table_info(message_coordination_ingress)').all() as Array<{ name: string }>
).map((column) => column.name);

test('legacy message coordination rows upgrade without being claimed as live', () => {
  const db = new Database(':memory:');
  try {
    db.exec(LEGACY_MESSAGE_COORDINATION_SQL);
    insertLegacyRow(db, 'legacy-client-message');

    migrateMessageCoordination(db);

    assert.equal(columns(db).includes('lifecycle_status'), true);
    assert.equal(columns(db).includes('verdict_json'), true);
    assert.equal(columns(db).includes('accepted_at'), true);
    assert.equal((db.prepare('SELECT accepted_at FROM message_coordination_ingress').get() as { accepted_at: null }).accepted_at, null);
    assert.deepEqual(
      db.prepare(
        `SELECT client_msg_id AS clientMsgId, lifecycle_status AS lifecycleStatus,
                verdict_json AS verdictJson
         FROM message_coordination_ingress`,
      ).get(),
      {
        clientMsgId: 'legacy-client-message',
        lifecycleStatus: 'terminal',
        verdictJson: null,
      },
    );
  } finally {
    db.close();
  }
});

test('fresh message coordination tables retain claimed as the new-ingress default', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO users (id) VALUES (?)').run(1);
    migrateMessageCoordination(db);
    insertLegacyRow(db, 'new-client-message');
    assert.equal((db.prepare('SELECT accepted_at FROM message_coordination_ingress').get() as { accepted_at: null }).accepted_at, null);

    assert.deepEqual(
      db.prepare(
        `SELECT lifecycle_status AS lifecycleStatus, verdict_json AS verdictJson
         FROM message_coordination_ingress WHERE client_msg_id = ?`,
      ).get('new-client-message'),
      { lifecycleStatus: 'claimed', verdictJson: null },
    );
  } finally {
    db.close();
  }
});

test('message coordination migration is idempotent and never reclassifies current rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec(LEGACY_MESSAGE_COORDINATION_SQL);
    insertLegacyRow(db, 'historical-client-message');
    migrateMessageCoordination(db);

    insertLegacyRow(db, 'current-client-message');
    db.prepare('UPDATE message_coordination_ingress SET accepted_at = ? WHERE client_msg_id = ?').run('2026-09-06T00:00:00.000Z', 'current-client-message');
    migrateMessageCoordination(db);
    assert.deepEqual(db.prepare('SELECT accepted_at FROM message_coordination_ingress ORDER BY id').all(), [{ accepted_at: null }, { accepted_at: '2026-09-06T00:00:00.000Z' }]);

    assert.deepEqual(
      db.prepare(
        `SELECT client_msg_id AS clientMsgId, lifecycle_status AS lifecycleStatus
         FROM message_coordination_ingress ORDER BY id`,
      ).all(),
      [
        { clientMsgId: 'historical-client-message', lifecycleStatus: 'terminal' },
        { clientMsgId: 'current-client-message', lifecycleStatus: 'claimed' },
      ],
    );
    const indexes = db.prepare('PRAGMA index_list(message_coordination_ingress)').all() as Array<{ name: string }>;
    assert.equal(indexes.some((index) => index.name === 'idx_message_coordination_session'), true);
  } finally {
    db.close();
  }
});
