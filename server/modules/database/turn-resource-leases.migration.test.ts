import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateTurnResourceLeases } from './migrations.js';

test('turn resource lease migration is idempotent and protects active rows', () => {
  const db = new Database(':memory:');
  try {
    migrateTurnResourceLeases(db);
    migrateTurnResourceLeases(db);
    const columns = db.prepare('PRAGMA table_info(turn_resource_leases)').all() as { name: string }[];
    assert.ok(columns.some((column) => column.name === 'exit_proof_at_ms'));
    db.prepare(
      `INSERT INTO turn_resource_leases (
         lease_id, turn_id, user_id, owner_id, owner_pid, cpu_reserved,
         memory_reserved, status, created_at_ms, heartbeat_at_ms
       ) VALUES ('l1', 't1', 1, 'owner', 99, 1, 1, 'active', 1, 1)`,
    ).run();
    assert.throws(
      () => db.prepare("DELETE FROM turn_resource_leases WHERE lease_id = 'l1'").run(),
      /requires exit proof/,
    );
    assert.throws(
      () => db.prepare("UPDATE turn_resource_leases SET status = 'released' WHERE lease_id = 'l1'").run(),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('migration widens legacy proof constraint without losing active leases', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE turn_resource_leases (
      lease_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL,
      owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, cpu_reserved REAL NOT NULL,
      memory_reserved REAL NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
      heartbeat_at_ms INTEGER NOT NULL, exit_proof_at_ms INTEGER,
      exit_proof_kind TEXT CHECK (exit_proof_kind IN ('process_exit', 'process_dead')),
      released_at_ms INTEGER,
      CHECK (status = 'active' OR (exit_proof_at_ms IS NOT NULL AND released_at_ms IS NOT NULL))
    );
    INSERT INTO turn_resource_leases VALUES
      ('legacy', 'turn', 1, 'owner', 7, 1, 1, 'active', 1, 1, NULL, NULL, NULL);`);
    migrateTurnResourceLeases(db);
    assert.equal(
      (db.prepare("SELECT status FROM turn_resource_leases WHERE lease_id = 'legacy'").get() as { status: string }).status,
      'active',
    );
    db.prepare(
      `UPDATE turn_resource_leases SET status = 'released', exit_proof_at_ms = 2,
       exit_proof_kind = 'adapter_terminal', released_at_ms = 2 WHERE lease_id = 'legacy'`,
    ).run();
  } finally {
    db.close();
  }
});
