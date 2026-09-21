import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateConnectorOAuthPending } from '@/modules/database/index.js';

test('OAuth pending migration is additive, empty, indexed, and idempotent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-oauth-migration-'));
  const db = new Database(path.join(directory, 'db.sqlite'));
  try {
    db.exec(`
      CREATE TABLE connectors (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
      INSERT INTO connectors (id, display_name) VALUES ('existing', 'Existing connector');
    `);
    const connectorSchemaBefore = db.prepare(
      "SELECT rootpage, sql FROM sqlite_master WHERE type = 'table' AND name = 'connectors'",
    ).get();
    const connectorRowBefore = db.prepare('SELECT * FROM connectors').get();

    migrateConnectorOAuthPending(db);

    assert.deepEqual(db.prepare(
      "SELECT rootpage, sql FROM sqlite_master WHERE type = 'table' AND name = 'connectors'",
    ).get(), connectorSchemaBefore);
    assert.deepEqual(db.prepare('SELECT * FROM connectors').get(), connectorRowBefore);
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS count FROM connector_oauth_pending',
    ).get() as { count: number }).count, 0, 'migration performs no backfill');

    const columns = db.prepare('PRAGMA table_info(connector_oauth_pending)').all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    assert.deepEqual(columns.map((column) => column.name), [
      'state_hash', 'key_version', 'nonce', 'ciphertext', 'tag',
      'expires_at', 'consumed_at', 'created_at',
    ]);
    assert.equal(columns.find((column) => column.name === 'state_hash')?.pk, 1);
    for (const required of ['key_version', 'nonce', 'ciphertext', 'tag', 'expires_at', 'created_at']) {
      assert.equal(columns.find((column) => column.name === required)?.notnull, 1);
    }
    assert.ok((db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_connector_oauth_pending_expiry'",
    ).get()), 'expiry sweep index must exist');

    migrateConnectorOAuthPending(db);
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS count FROM connector_oauth_pending',
    ).get() as { count: number }).count, 0, 'repeated migration stays empty and succeeds');
    assert.deepEqual(db.prepare('SELECT * FROM connectors').get(), connectorRowBefore);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
