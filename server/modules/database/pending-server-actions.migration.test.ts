/**
 * Migration idempotency tests for migratePendingServerActions (ADR-066, T-944).
 *
 * Verifies that:
 *   - The pending_server_actions table is created by runMigrations
 *   - The partial unique dedup index (idx_pending_actions_dedup) is created
 *   - The status index (idx_pending_actions_status) is created
 *   - Running runMigrations TWICE on the same DB does not throw
 *   - The expected columns are present in the table
 *
 * Each test uses a fresh isolated SQLite database (tmpdir + DATABASE_PATH swap).
 *
 * Framework: node:test + node:assert/strict via tsx (matches the server suite).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';

// ── Isolation helper ────────────────────────────────────────────────────────

async function withDb(
  runTest: (db: ReturnType<typeof getConnection>) => void | Promise<void>
): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'psa-migration-test-'));
  const dbPath = path.join(dir, 'db.sqlite');

  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await initializeDatabase(); // Runs the full migration chain once.

  try {
    await runTest(getConnection());
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function tableExists(db: ReturnType<typeof getConnection>, name: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
  );
}

function indexExists(db: ReturnType<typeof getConnection>, name: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name)
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('migration: pending_server_actions table is created by runMigrations', async () => {
  await withDb((db) => {
    assert.ok(
      tableExists(db, 'pending_server_actions'),
      'pending_server_actions table must exist after migration'
    );
  });
});

test('migration: partial unique dedup index (idx_pending_actions_dedup) is created', async () => {
  await withDb((db) => {
    assert.ok(
      indexExists(db, 'idx_pending_actions_dedup'),
      'idx_pending_actions_dedup must be created by migratePendingServerActions'
    );
  });
});

test('migration: status index (idx_pending_actions_status) is created', async () => {
  await withDb((db) => {
    assert.ok(
      indexExists(db, 'idx_pending_actions_status'),
      'idx_pending_actions_status must be created by migratePendingServerActions'
    );
  });
});

test('migration: runMigrations is idempotent — running it twice must not throw', async () => {
  await withDb((db) => {
    // First run was inside initializeDatabase; run it a second time explicitly.
    assert.doesNotThrow(
      () => runMigrations(db),
      'second runMigrations call must not throw (IF NOT EXISTS guards)'
    );
  });
});

test('migration idempotent: table and indexes survive a second runMigrations call', async () => {
  await withDb((db) => {
    runMigrations(db); // second run
    assert.ok(tableExists(db, 'pending_server_actions'), 'table must still exist after second run');
    assert.ok(indexExists(db, 'idx_pending_actions_dedup'), 'dedup index must still exist after second run');
    assert.ok(indexExists(db, 'idx_pending_actions_status'), 'status index must still exist after second run');
  });
});

test('migration: pending_server_actions table has all expected columns', async () => {
  await withDb((db) => {
    const columns = (
      db.prepare('PRAGMA table_info(pending_server_actions)').all() as { name: string }[]
    ).map((c) => c.name);

    const required = [
      'id',
      'action_type',
      'session_id',
      'reason',
      'requested_by',
      'status',
      'error',
      'requested_at',
      'executed_at',
    ];
    for (const col of required) {
      assert.ok(columns.includes(col), `column "${col}" must be present in pending_server_actions`);
    }
  });
});

test('migration: dedup index definition covers the partial unique key used by ON CONFLICT DO NOTHING', async () => {
  await withDb((db) => {
    // Confirm the index semantics by attempting a real dedup insertion.
    // Two rows with the same (action_type, NULL session_id) and status='pending'
    // must trigger ON CONFLICT and result in only one row.
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    db.prepare(
      `INSERT INTO pending_server_actions (id, action_type, session_id, status)
       VALUES (?, 'safe-restart', NULL, 'pending')`
    ).run(id1);
    db.prepare(
      `INSERT INTO pending_server_actions (id, action_type, session_id, status)
       VALUES (?, 'safe-restart', NULL, 'pending')
       ON CONFLICT DO NOTHING`
    ).run(id2);

    const count = (
      db.prepare(
        "SELECT COUNT(*) AS n FROM pending_server_actions WHERE status='pending'"
      ).get() as { n: number }
    ).n;
    assert.equal(count, 1, 'dedup index must allow only one pending row per (action_type, session_id) key');
  });
});
