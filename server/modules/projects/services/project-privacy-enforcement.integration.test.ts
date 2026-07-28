/**
 * Private-project privacy enforcement (B-PRIV) — leak-prevention proofs.
 *
 * Exercises the real DB through initializeDatabase (the established
 * withIsolatedDatabase pattern) to assert the absolute-privacy guarantee:
 *   - User B never sees user A's private project in the projects listing,
 *     via the central guard, or via getVisibleProjectPaths.
 *   - The platform owner ALSO cannot see it unless they are a member.
 *   - A user derived from a session participant CAN see it.
 *   - Only the creator/owner/platform-owner may toggle visibility or manage
 *     members; a non-manager is refused.
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
  participantsDb,
  projectMembersDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { assertProjectVisible } from '@/modules/projects/services/project-visibility-guard.service.js';
import {
  addMember,
  recoverOrphanByTransfer,
  setVisibility,
} from '@/modules/projects/services/project-visibility-management.service.js';
import { getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { AppError } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'priv-enforce-db-'));
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

let seq = 0;
function makeUser(role: 'owner' | 'admin' | 'user' = 'user'): number {
  seq += 1;
  return userDb.createUser(`u_${seq}_${Date.now()}`, 'hash', role).id;
}

/** Creates a project owned by `creator` and switches it to private. */
function makePrivateProject(projectPath: string, creator: number): string {
  const created = projectsDb.createProjectPath(projectPath, null, creator);
  const projectId = created.project!.project_id;
  setVisibility(projectId, 'private', creator, false);
  return projectId;
}

async function listPaths(userId: number | null, isPlatformOwner = false): Promise<Set<string>> {
  const projects = await getProjectsWithSessions({
    skipSynchronization: true,
    currentUserId: userId,
    isPlatformOwner,
  });
  return new Set(projects.map((p) => p.fullPath));
}

test('B never sees A private project in the listing; A does', async () => {
  await withIsolatedDatabase(async () => {
    const userA = makeUser();
    const userB = makeUser();
    makePrivateProject('/workspace/a-private', userA);
    projectsDb.createProjectPath('/workspace/shared-public', null, userA);

    const aPaths = await listPaths(userA);
    const bPaths = await listPaths(userB);

    assert.ok(aPaths.has('/workspace/a-private'), 'creator must see own private project');
    assert.ok(bPaths.has('/workspace/shared-public'), 'public project visible to everyone');
    assert.ok(!bPaths.has('/workspace/a-private'), 'LEAK: non-member saw private project');
  });
});

test('platform owner also cannot see A private project unless a member (absolute privacy)', async () => {
  await withIsolatedDatabase(async () => {
    const userA = makeUser();
    const platformOwner = makeUser('owner');
    makePrivateProject('/workspace/a-private', userA);

    const ownerPaths = await listPaths(platformOwner, true);
    assert.ok(
      !ownerPaths.has('/workspace/a-private'),
      'LEAK: platform owner saw a private project they are not a member of',
    );
  });
});

test('explicit member and session-derived participant both see the private project', async () => {
  await withIsolatedDatabase(async () => {
    const userA = makeUser();
    const member = makeUser();
    const participant = makeUser();
    const projectId = makePrivateProject('/workspace/a-private', userA);

    // Explicit membership.
    addMember(projectId, member, 'member', userA, false);

    // Session-derived participation: a session in the project + a participant row.
    sessionsDb.createSession('sess-1', 'claude', '/workspace/a-private');
    participantsDb.recordSpawn('sess-1', participant);

    assert.ok((await listPaths(member)).has('/workspace/a-private'), 'explicit member must see it');
    assert.ok(
      (await listPaths(participant)).has('/workspace/a-private'),
      'session participant must see it',
    );
  });
});

test('assertProjectVisible throws 404 for a non-member and returns path for a member', async () => {
  await withIsolatedDatabase(() => {
    const userA = makeUser();
    const userB = makeUser();
    const projectId = makePrivateProject('/workspace/a-private', userA);

    assert.equal(assertProjectVisible(projectId, userA), '/workspace/a-private');

    assert.throws(
      () => assertProjectVisible(projectId, userB),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
      'guard must 404 (not 403) for a non-member',
    );
  });
});

test('canManageVisibility is true only for the creator', async () => {
  await withIsolatedDatabase(async () => {
    const userA = makeUser();
    const userB = makeUser();
    projectsDb.createProjectPath('/workspace/managed', null, userA);

    const aProjects = await getProjectsWithSessions({
      skipSynchronization: true,
      currentUserId: userA,
    });
    const bProjects = await getProjectsWithSessions({
      skipSynchronization: true,
      currentUserId: userB,
    });

    assert.equal(aProjects.find((p) => p.fullPath === '/workspace/managed')?.canManageVisibility, true);
    assert.equal(bProjects.find((p) => p.fullPath === '/workspace/managed')?.canManageVisibility, false);
  });
});

test('non-manager cannot toggle visibility or add members', async () => {
  await withIsolatedDatabase(() => {
    const userA = makeUser();
    const userB = makeUser();
    const projectId = makePrivateProject('/workspace/a-private', userA);

    assert.throws(
      () => setVisibility(projectId, 'public', userB, false),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
    );
    assert.throws(
      () => addMember(projectId, userB, 'member', userB, false),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
    );

    // Creator may toggle.
    const result = setVisibility(projectId, 'public', userA, false);
    assert.equal(result.visibility, 'public');
    assert.equal(projectsDb.getProjectVisibility(projectId), 'public');
  });
});

test('switching to private records the creator as an owner member', async () => {
  await withIsolatedDatabase(() => {
    const userA = makeUser();
    const projectId = makePrivateProject('/workspace/a-private', userA);
    const creatorRole = projectMembersDb.getRole(projectId, userA);
    assert.equal(creatorRole, 'owner', 'creator must become a project_members owner on private switch');
  });
});

test('platform owner recovers an orphaned project by ownership transfer; refuses non-orphans', async () => {
  await withIsolatedDatabase(() => {
    const platformOwner = makeUser('owner');
    const newOwner = makeUser();

    // Orphan: a project row with no created_by (e.g. session-derived legacy row).
    getConnection()
      .prepare(
        "INSERT INTO projects (project_id, project_path, custom_project_name, isArchived, visibility, created_by) VALUES (?, ?, ?, 0, 'private', NULL)",
      )
      .run('orphan-1', '/workspace/orphan', 'orphan');

    const result = recoverOrphanByTransfer('orphan-1', newOwner, true);
    assert.equal(result.createdBy, newOwner);
    assert.equal(projectsDb.getProjectById('orphan-1')?.created_by, newOwner);
    assert.equal(projectMembersDb.getRole('orphan-1', newOwner), 'owner');

    // Now it has a legitimate owner — a second recovery must be refused (409).
    assert.throws(
      () => recoverOrphanByTransfer('orphan-1', platformOwner, true),
      (error: unknown) => error instanceof AppError && error.statusCode === 409,
    );
  });
});
