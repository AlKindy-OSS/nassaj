/**
 * T-1950 — the link_url migration on a legacy DB: adds the column to an
 * existing database and leaves rows intact, idempotently.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  stopReconcileScheduler,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

test('migration adds projects.link_url to a legacy DB without it and keeps rows', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-link-migration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  try {
    await initializeDatabase();
    stopReconcileScheduler();
    const db = getConnection();
    const columns = () =>
      (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name);

    const created = projectsDb.createProjectPath('/srv/legacy-link-project', 'Legacy');
    const projectId = created.project?.project_id ?? '';
    assert.notEqual(projectId, '');
    // Simulate a pre-T-1950 database.
    db.exec('ALTER TABLE projects DROP COLUMN link_url');
    assert.equal(columns().includes('link_url'), false);

    runMigrations(db);
    runMigrations(db); // idempotent

    assert.equal(columns().includes('link_url'), true);
    const row = projectsDb.getProjectById(projectId);
    assert.equal(row?.custom_project_name, 'Legacy');
    assert.equal(row?.link_url ?? null, null);

    projectsDb.setProjectLinkUrl(projectId, 'https://example.com/');
    assert.equal(projectsDb.getProjectById(projectId)?.link_url, 'https://example.com/');
    projectsDb.setProjectLinkUrl(projectId, null);
    assert.equal(projectsDb.getProjectById(projectId)?.link_url, null);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
