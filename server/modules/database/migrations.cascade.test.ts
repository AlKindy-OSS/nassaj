/**
 * Tests for the session_agents FK CASCADE migration (B-38).
 *
 * Verifies:
 *  1. Existing rows in session_agents_cache / session_agents_meta are
 *     preserved after the migration runs.
 *  2. After migration the FK carries ON DELETE CASCADE: deleting the parent
 *     sessions row cascades into both child tables.
 *  3. The migration is idempotent: a second runMigrations() call on an already-
 *     migrated database is a no-op and data is still intact.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'cascade-migration-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  // Prevent the reconcile timer from leaking into other tests.
  stopReconcileScheduler();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('CASCADE migration: existing session_agents_cache rows survive the migration', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();

    // Insert prerequisite data.
    db.prepare(
      `INSERT INTO projects (project_id, project_path) VALUES ('proj-1', '/workspace/proj-1')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (session_id, provider, project_path)
       VALUES ('sess-1', 'claude', '/workspace/proj-1')`
    ).run();
    db.prepare(
      `INSERT INTO session_agents_cache (session_id, agent_name, agent_kind, invocation_count)
       VALUES ('sess-1', 'claude-3-5-sonnet', 'model', 3)`
    ).run();
    db.prepare(
      `INSERT INTO session_agents_meta (session_id, transcript_mtime)
       VALUES ('sess-1', 1718000000000)`
    ).run();

    // Verify the rows exist.
    const cacheRow = db
      .prepare(`SELECT * FROM session_agents_cache WHERE session_id = 'sess-1'`)
      .get() as { agent_name: string; invocation_count: number } | undefined;
    const metaRow = db
      .prepare(`SELECT * FROM session_agents_meta WHERE session_id = 'sess-1'`)
      .get() as { transcript_mtime: number } | undefined;

    assert.ok(cacheRow, 'session_agents_cache row should exist');
    assert.equal(cacheRow.agent_name, 'claude-3-5-sonnet');
    assert.equal(cacheRow.invocation_count, 3);
    assert.ok(metaRow, 'session_agents_meta row should exist');
    assert.equal(metaRow.transcript_mtime, 1718000000000);
  });
});

test('CASCADE migration: deleting a session cascades to session_agents_cache and session_agents_meta', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();

    // Insert prerequisite data.
    db.prepare(
      `INSERT INTO projects (project_id, project_path) VALUES ('proj-2', '/workspace/proj-2')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (session_id, provider, project_path)
       VALUES ('sess-cascade', 'claude', '/workspace/proj-2')`
    ).run();
    db.prepare(
      `INSERT INTO session_agents_cache (session_id, agent_name, agent_kind, invocation_count)
       VALUES ('sess-cascade', 'claude-3-7-sonnet', 'model', 1)`
    ).run();
    db.prepare(
      `INSERT INTO session_agents_meta (session_id, transcript_mtime)
       VALUES ('sess-cascade', 1718000001000)`
    ).run();

    // Enable FK enforcement for this test statement (WAL mode keeps FKs on by
    // default from the connection pragma set in connection.ts).
    db.pragma('foreign_keys = ON');

    // Delete the parent session — should cascade.
    db.prepare(`DELETE FROM sessions WHERE session_id = 'sess-cascade'`).run();

    const cacheRow = db
      .prepare(`SELECT * FROM session_agents_cache WHERE session_id = 'sess-cascade'`)
      .get();
    const metaRow = db
      .prepare(`SELECT * FROM session_agents_meta WHERE session_id = 'sess-cascade'`)
      .get();

    assert.equal(cacheRow, undefined, 'session_agents_cache row should be cascade-deleted');
    assert.equal(metaRow, undefined, 'session_agents_meta row should be cascade-deleted');
  });
});

test('CASCADE migration: re-running migrations on an already-migrated DB is idempotent', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();

    // Insert data before re-running migrations.
    db.prepare(
      `INSERT INTO projects (project_id, project_path) VALUES ('proj-3', '/workspace/proj-3')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (session_id, provider, project_path)
       VALUES ('sess-idempotent', 'claude', '/workspace/proj-3')`
    ).run();
    db.prepare(
      `INSERT INTO session_agents_cache (session_id, agent_name, agent_kind, invocation_count)
       VALUES ('sess-idempotent', 'agent-x', 'subagent', 5)`
    ).run();

    // Re-run initializeDatabase (which calls runMigrations internally).
    closeConnection();
    await initializeDatabase();
    stopReconcileScheduler();

    const dbAfter = getConnection();
    const cacheRow = dbAfter
      .prepare(`SELECT * FROM session_agents_cache WHERE session_id = 'sess-idempotent'`)
      .get() as { agent_name: string; invocation_count: number } | undefined;

    assert.ok(cacheRow, 'session_agents_cache row must survive idempotent re-migration');
    assert.equal(cacheRow.agent_name, 'agent-x');
    assert.equal(cacheRow.invocation_count, 5);
  });
});

test('CASCADE migration: FK constraint on session_agents_cache uses CASCADE action', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();

    type FkRow = { table: string; on_delete: string };
    const cacheFks = db
      .prepare('PRAGMA foreign_key_list(session_agents_cache)')
      .all() as FkRow[];
    const metaFks = db
      .prepare('PRAGMA foreign_key_list(session_agents_meta)')
      .all() as FkRow[];

    const cacheFkToSessions = cacheFks.find((row) => row.table === 'sessions');
    const metaFkToSessions = metaFks.find((row) => row.table === 'sessions');

    assert.ok(cacheFkToSessions, 'session_agents_cache should have FK to sessions');
    assert.equal(
      cacheFkToSessions.on_delete,
      'CASCADE',
      'session_agents_cache FK must be ON DELETE CASCADE'
    );

    assert.ok(metaFkToSessions, 'session_agents_meta should have FK to sessions');
    assert.equal(
      metaFkToSessions.on_delete,
      'CASCADE',
      'session_agents_meta FK must be ON DELETE CASCADE'
    );
  });
});
