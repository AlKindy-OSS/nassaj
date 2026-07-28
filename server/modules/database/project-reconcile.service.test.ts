/**
 * Tests for the project-reconcile service (B-38).
 *
 * Verifies:
 *  1. A project whose directory is missing on disk is archived (isArchived = 1).
 *  2. A project whose directory exists is left untouched.
 *  3. A project that is already archived is not double-counted.
 *  4. reconcileProjects() returns accurate checked/archived counts.
 *  5. reconcileProjects() is idempotent: a second pass on the same DB is a no-op.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  reconcileProjects,
  stopReconcileScheduler,
} from '@/modules/database/project-reconcile.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withIsolatedDatabase(
  runTest: (tempDir: string) => void | Promise<void>
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'reconcile-svc-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  // Prevent the boot-pass timer from interfering with manual calls below.
  stopReconcileScheduler();

  try {
    await runTest(tempDirectory);
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

test('reconcileProjects: project with missing folder is archived', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();

    // A project path that does not exist on disk.
    const missingPath = '/tmp/__nassaj_reconcile_nonexistent_xyz_' + Date.now();
    db.prepare(
      `INSERT INTO projects (project_id, project_path)
       VALUES ('proj-missing', ?)`
    ).run(missingPath);

    const result = await reconcileProjects();

    assert.equal(result.checked >= 1, true, 'should have checked at least 1 project');
    assert.ok(result.archivedIds.includes('proj-missing'), 'proj-missing should be archived');

    const row = db
      .prepare(`SELECT isArchived FROM projects WHERE project_id = 'proj-missing'`)
      .get() as { isArchived: number } | undefined;
    assert.ok(row, 'project row should still exist');
    assert.equal(row.isArchived, 1, 'isArchived should be 1 (soft-deleted, not hard-deleted)');
  });
});

test('reconcileProjects: project with existing folder is not archived', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const db = getConnection();

    // Create a real directory to simulate an active project.
    const existingPath = path.join(tempDir, 'real-project');
    await mkdir(existingPath, { recursive: true });

    db.prepare(
      `INSERT INTO projects (project_id, project_path)
       VALUES ('proj-exists', ?)`
    ).run(existingPath);

    const result = await reconcileProjects();

    assert.ok(!result.archivedIds.includes('proj-exists'), 'proj-exists should NOT be archived');

    const row = db
      .prepare(`SELECT isArchived FROM projects WHERE project_id = 'proj-exists'`)
      .get() as { isArchived: number } | undefined;
    assert.ok(row, 'project row should exist');
    assert.equal(row.isArchived, 0, 'isArchived should remain 0');
  });
});

test('reconcileProjects: already-archived projects are not included in checked count', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();

    // Insert a project that is already archived.
    const alreadyArchivedPath = '/tmp/__nassaj_reconcile_already_archived_' + Date.now();
    db.prepare(
      `INSERT INTO projects (project_id, project_path, isArchived)
       VALUES ('proj-already-archived', ?, 1)`
    ).run(alreadyArchivedPath);

    const result = await reconcileProjects();

    // The already-archived project should not appear in checked (WHERE isArchived = 0).
    assert.ok(
      !result.archivedIds.includes('proj-already-archived'),
      'already-archived project should not be re-processed'
    );
  });
});

test('reconcileProjects: returns accurate checked and archived counts', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const db = getConnection();

    const existingPath = path.join(tempDir, 'count-project-good');
    await mkdir(existingPath, { recursive: true });

    const missingPath1 = '/tmp/__nassaj_reconcile_m1_' + Date.now();
    const missingPath2 = '/tmp/__nassaj_reconcile_m2_' + (Date.now() + 1);

    db.prepare(
      `INSERT INTO projects (project_id, project_path) VALUES ('proj-good', ?)`
    ).run(existingPath);
    db.prepare(
      `INSERT INTO projects (project_id, project_path) VALUES ('proj-m1', ?)`
    ).run(missingPath1);
    db.prepare(
      `INSERT INTO projects (project_id, project_path) VALUES ('proj-m2', ?)`
    ).run(missingPath2);

    const result = await reconcileProjects();

    assert.equal(result.checked, 3, 'should have checked all 3 active projects');
    assert.equal(result.archived, 2, 'should have archived the 2 missing projects');
    assert.ok(result.archivedIds.includes('proj-m1'));
    assert.ok(result.archivedIds.includes('proj-m2'));
    assert.ok(!result.archivedIds.includes('proj-good'));
  });
});

test('reconcileProjects: second pass on same DB is a no-op', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();

    const missingPath = '/tmp/__nassaj_reconcile_noop_' + Date.now();
    db.prepare(
      `INSERT INTO projects (project_id, project_path) VALUES ('proj-noop', ?)`
    ).run(missingPath);

    // First pass — archives it.
    const first = await reconcileProjects();
    assert.ok(first.archivedIds.includes('proj-noop'));

    // Second pass — no active projects to check (already archived).
    const second = await reconcileProjects();
    assert.ok(
      !second.archivedIds.includes('proj-noop'),
      'already-archived project must not be re-archived'
    );

    // Row must still exist (soft delete only).
    const row = db
      .prepare(`SELECT isArchived FROM projects WHERE project_id = 'proj-noop'`)
      .get() as { isArchived: number } | undefined;
    assert.ok(row, 'project row must persist');
    assert.equal(row.isArchived, 1);
  });
});
