/**
 * Tests for B-150: transient-failure tolerance + auto-recovery in the
 * project-reconcile service.
 *
 * Before B-150 the reconcile pass archived a project on ANY fs error, so a
 * transient hiccup (EACCES / EIO / a mount flapping) made live projects vanish
 * with no way back. These tests pin the fix:
 *  1. a confirmed-missing path (ENOENT) is archived AND remembered,
 *  2. a transient/inconclusive probe never archives,
 *  3. a project WE archived is auto-unarchived when its folder reappears,
 *  4. a project the USER archived by hand is never auto-recovered.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  reconcileProjects,
  stopReconcileScheduler,
} from '@/modules/database/project-reconcile.service.js';

async function withIsolatedDatabase(
  runTest: (tempDir: string) => void | Promise<void>
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'reconcile-b150-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  // Pre-create the file so the legacy-DB copy in connection.ts is skipped and we
  // start from a truly empty, isolated database.
  await writeFile(databasePath, '');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  // The boot pass timer would race the manual calls below.
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

function isArchived(db: ReturnType<typeof getConnection>, projectId: string): number | undefined {
  const row = db
    .prepare('SELECT isArchived FROM projects WHERE project_id = ?')
    .get(projectId) as { isArchived: number } | undefined;
  return row?.isArchived;
}

function isTracked(db: ReturnType<typeof getConnection>, projectId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM reconcile_archived_projects WHERE project_id = ?')
    .get(projectId);
  return row !== undefined;
}

test('B-150: confirmed-missing (ENOENT) path is archived and remembered', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    const missingPath = path.join(tmpdir(), '__nassaj_b150_missing_' + Date.now());
    db.prepare(`INSERT INTO projects (project_id, project_path) VALUES ('p-missing', ?)`).run(
      missingPath
    );

    const result = await reconcileProjects();

    assert.ok(result.archivedIds.includes('p-missing'), 'missing project should be archived');
    assert.equal(result.skipped, 0, 'nothing should be skipped');
    assert.equal(isArchived(db, 'p-missing'), 1);
    assert.equal(isTracked(db, 'p-missing'), true, 'archived-by-reconcile must be tracked');
  });
});

test('B-150: a transient/inconclusive probe never archives', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    db.prepare(`INSERT INTO projects (project_id, project_path) VALUES ('p-flaky', '/mnt/flaky')`).run();

    // Inject a probe that reports the path as inconclusive (e.g. EACCES/EIO).
    const result = await reconcileProjects({ probe: async () => 'transient' });

    assert.ok(!result.archivedIds.includes('p-flaky'), 'transient project must NOT be archived');
    assert.ok(result.skippedIds.includes('p-flaky'), 'transient project should be reported skipped');
    assert.equal(isArchived(db, 'p-flaky'), 0, 'row must stay active');
    assert.equal(isTracked(db, 'p-flaky'), false, 'a skipped project must not be tracked');
  });
});

test('B-150: a reconcile-archived project is auto-recovered when its folder reappears', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const db = getConnection();
    const reappearingPath = path.join(tempDir, 'comes-back');
    db.prepare(`INSERT INTO projects (project_id, project_path) VALUES ('p-return', ?)`).run(
      reappearingPath
    );

    // Pass 1: folder is absent → archived + tracked.
    const first = await reconcileProjects();
    assert.ok(first.archivedIds.includes('p-return'));
    assert.equal(isArchived(db, 'p-return'), 1);
    assert.equal(isTracked(db, 'p-return'), true);

    // The folder reappears (e.g. a remounted volume).
    await mkdir(reappearingPath, { recursive: true });

    // Pass 2: recovery pass sees it again and unarchives it.
    const second = await reconcileProjects();
    assert.ok(second.recoveredIds.includes('p-return'), 'project should be auto-recovered');
    assert.equal(isArchived(db, 'p-return'), 0, 'project should be active again');
    assert.equal(isTracked(db, 'p-return'), false, 'tracking row should be cleared after recovery');
  });
});

test('B-150: a user-archived project (not ours) is never auto-recovered', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const db = getConnection();
    // Existing folder, but archived by the user — NOT recorded in the tracking table.
    const existingPath = path.join(tempDir, 'user-archived');
    await mkdir(existingPath, { recursive: true });
    db.prepare(
      `INSERT INTO projects (project_id, project_path, isArchived) VALUES ('p-user', ?, 1)`
    ).run(existingPath);

    const result = await reconcileProjects();

    assert.ok(
      !result.recoveredIds.includes('p-user'),
      'a user-archived project must not be resurrected'
    );
    assert.equal(isArchived(db, 'p-user'), 1, 'user intent (archived) must be preserved');
  });
});
