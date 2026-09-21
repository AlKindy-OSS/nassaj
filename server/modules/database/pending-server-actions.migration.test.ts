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
      'expected_server_build_id',
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

test('attempt nonce migration upgrades existing rows as null and is repeatable', async () => {
  await withDb((db) => {
    db.prepare("INSERT INTO pending_server_actions (id, action_type, status) VALUES (?, ?, ?)").run('legacy-attempt', 'safe-restart', 'executing');
    db.exec('ALTER TABLE pending_server_actions DROP COLUMN execution_attempt_nonce');
    runMigrations(db);
    runMigrations(db);
    const row = db.prepare('SELECT execution_attempt_nonce FROM pending_server_actions WHERE id = ?').get('legacy-attempt') as { execution_attempt_nonce: string | null };
    assert.equal(row.execution_attempt_nonce, null);
  });
});

// ── T-1684 settled_at backfill (qa-critic follow-up) ─────────────────────────
//
// The retention clock counts from settled_at. Backfilling a legacy row from its
// own executed_at/requested_at dates it hours or days in the past, so the first
// janitor pass after the upgrade wipes the owner's entire history within a
// minute of boot. The migration stamps its own clock instead: one hour of grace
// from the deploy, then normal retention.
test('T-1684 settled_at backfill gives legacy terminal rows an hour of grace, not instant deletion', async () => {
  await withDb((db) => {
    const seed = (id: string, status: string) => db.prepare(
      `INSERT INTO pending_server_actions (id, action_type, status, requested_at, executed_at)
       VALUES (?, 'custom-test', ?, datetime('now', '-3 days'), datetime('now', '-3 days'))`
    ).run(id, status);
    seed('legacy-succeeded', 'succeeded');
    seed('legacy-failed', 'failed');
    seed('legacy-superseded', 'superseded');
    seed('legacy-pending', 'pending');
    db.exec('ALTER TABLE pending_server_actions DROP COLUMN settled_at');

    runMigrations(db);
    runMigrations(db); // repeatable: the second pass finds nothing left to fill

    const survivors = db.prepare(
      `SELECT id FROM pending_server_actions
       WHERE status IN ('succeeded', 'failed', 'superseded')
         AND datetime(settled_at) > datetime('now', '-60 seconds')
       ORDER BY id`
    ).all() as { id: string }[];
    assert.deepEqual(survivors.map(({ id }) => id),
      ['legacy-failed', 'legacy-succeeded', 'legacy-superseded'],
      'every legacy terminal row is dated from the migration, not from its old timestamps');

    // The exact failure this replaces: a one-hour prune must NOT reach them.
    const wouldPrune = (db.prepare(
      `SELECT COUNT(*) AS n FROM pending_server_actions
       WHERE status IN ('succeeded', 'failed', 'superseded')
         AND datetime(COALESCE(settled_at, executed_at, requested_at))
             <= datetime('now', '-3600 seconds')`
    ).get() as { n: number }).n;
    assert.equal(wouldPrune, 0, 'the first janitor pass after the upgrade deletes nothing');

    const pending = db.prepare('SELECT settled_at FROM pending_server_actions WHERE id = ?')
      .get('legacy-pending') as { settled_at: string | null };
    assert.equal(pending.settled_at, null, 'a queued row is not settled and is never stamped');
  });
});
