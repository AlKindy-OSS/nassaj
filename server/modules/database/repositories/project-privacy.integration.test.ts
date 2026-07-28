import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getConnection } from '@/modules/database/connection.js';
import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { projectMembersDb } from '@/modules/database/repositories/project-members.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

/**
 * Isolated DB harness shared by the privacy suite. Mirrors the established
 * pattern (projects.db.integration.test.ts): point DATABASE_PATH at a temp file,
 * run the real migrations via initializeDatabase, and restore afterwards.
 */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-privacy-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

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

let userSeq = 0;
function createUser(role: 'owner' | 'admin' | 'user' = 'user'): number {
  userSeq += 1;
  return userDb.createUser(`user_${userSeq}_${Date.now()}`, 'hash', role).id;
}

test('migration adds visibility/created_by columns and project_members table', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const projectCols = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.ok(projectCols.includes('visibility'), 'projects.visibility column missing');
    assert.ok(projectCols.includes('created_by'), 'projects.created_by column missing');

    const membersTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_members'")
      .get();
    assert.ok(membersTable, 'project_members table missing');

    // Fresh project defaults to public visibility.
    const created = projectsDb.createProjectPath('/workspace/p-default');
    assert.equal(created.project?.visibility, 'public');
    assert.equal(created.project?.created_by, null);
  });
});

test('createProjectPath persists created_by when a userId is supplied', async () => {
  await withIsolatedDatabase(() => {
    const creator = createUser('owner');
    const result = projectsDb.createProjectPath('/workspace/p-owned', null, creator);
    assert.equal(result.project?.created_by, creator);
    assert.equal(projectsDb.getProjectVisibility(result.project!.project_id), 'public');
  });
});

test('setProjectVisibility toggles a project between public and private', async () => {
  await withIsolatedDatabase(() => {
    const creator = createUser();
    const result = projectsDb.createProjectPath('/workspace/p-toggle', null, creator);
    const projectId = result.project!.project_id;

    projectsDb.setProjectVisibility(projectId, 'private');
    assert.equal(projectsDb.getProjectVisibility(projectId), 'private');

    projectsDb.setProjectVisibility(projectId, 'public');
    assert.equal(projectsDb.getProjectVisibility(projectId), 'public');
  });
});

test('project_members add/list/remove/setRole round-trips', async () => {
  await withIsolatedDatabase(() => {
    const creator = createUser();
    const member = createUser();
    const result = projectsDb.createProjectPath('/workspace/p-members', null, creator);
    const projectId = result.project!.project_id;

    projectMembersDb.add(projectId, creator, 'owner', creator);
    projectMembersDb.add(projectId, member, 'member', creator);

    const list = projectMembersDb.listByProject(projectId);
    assert.equal(list.length, 2);

    assert.deepEqual(projectMembersDb.listUserProjectIds(member).sort(), [projectId]);

    projectMembersDb.setRole(projectId, member, 'owner');
    const promoted = projectMembersDb.listByProject(projectId).find((r) => r.user_id === member);
    assert.equal(promoted?.role, 'owner');

    projectMembersDb.remove(projectId, member);
    assert.equal(projectMembersDb.listByProject(projectId).length, 1);
    assert.deepEqual(projectMembersDb.listUserProjectIds(member), []);
  });
});
