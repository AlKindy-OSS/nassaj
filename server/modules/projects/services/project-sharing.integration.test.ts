/**
 * Project sharing contract (ADR-089) — the INVERSE of the retired B-PRIV proofs.
 *
 * Project visibility (public/private) was retired: nassaj serves one trusted
 * internal team, so every project is shared with every member. This file is the
 * regression net for that decision, asserting what must now hold:
 *   - every authenticated user sees every project, whoever created it,
 *   - the guard still 404s an UNKNOWN project id (existence is not disclosed),
 *   - the guard still refuses an anonymous / unresolved caller,
 *   - the list layer and the id-keyed guard agree (they diverging is the exact
 *     failure mode the retired pair was built to prevent),
 *   - membership management survives visibility: project_members still records
 *     ownership for orphan recovery, and a non-manager still cannot mutate it.
 *
 * Deliberately NOT asserted here: the WRITE gate (isProjectWritableByUser).
 * Session ownership is orthogonal to project sharing and keeps its own tests.
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
} from '@/modules/projects/services/project-visibility-management.service.js';
import { getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { AppError } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'proj-sharing-db-'));
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

async function listPaths(userId: number | null, isPlatformOwner = false): Promise<Set<string>> {
  const projects = await getProjectsWithSessions({
    skipSynchronization: true,
    currentUserId: userId,
    isPlatformOwner,
  });
  return new Set(projects.map((p) => p.fullPath));
}

test("ADR-089: a user sees another user's project — creation does not scope the list", async () => {
  await withIsolatedDatabase(async () => {
    const userA = makeUser();
    const userB = makeUser();
    projectsDb.createProjectPath('/workspace/created-by-a', null, userA);
    projectsDb.createProjectPath('/workspace/created-by-b', null, userB);

    const aPaths = await listPaths(userA);
    const bPaths = await listPaths(userB);

    for (const paths of [aPaths, bPaths]) {
      assert.ok(paths.has('/workspace/created-by-a'));
      assert.ok(paths.has('/workspace/created-by-b'));
    }
  });
});

test('ADR-089: a legacy private row is still listed — stored visibility no longer gates reads', async () => {
  await withIsolatedDatabase(async () => {
    const userA = makeUser();
    const stranger = makeUser();
    // A row left over from before the retirement: the column still exists and
    // may still read 'private' on an un-migrated deployment. It must not hide.
    getConnection()
      .prepare(
        "INSERT INTO projects (project_id, project_path, custom_project_name, isArchived, visibility, created_by) VALUES (?, ?, ?, 0, 'private', ?)",
      )
      .run('legacy-private', '/workspace/legacy-private', 'legacy', userA);

    assert.ok(
      (await listPaths(stranger)).has('/workspace/legacy-private'),
      'a stale visibility=private value must not hide a project post-ADR-089',
    );
    assert.equal(assertProjectVisible('legacy-private', stranger), '/workspace/legacy-private');
  });
});

test('guard still 404s an unknown project id (existence is not disclosed)', async () => {
  await withIsolatedDatabase(() => {
    const user = makeUser();
    assert.throws(
      () => assertProjectVisible('no-such-project-id', user),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
      'an enumerated / guessed id must still get "not found"',
    );
  });
});

test('guard still refuses an anonymous / unresolved caller', async () => {
  await withIsolatedDatabase(() => {
    const userA = makeUser();
    const created = projectsDb.createProjectPath('/workspace/some-project', null, userA);
    const projectId = created.project!.project_id;

    assert.equal(projectsDb.isProjectVisibleToUser(projectId, null), false);
    assert.equal(projectsDb.isProjectPathVisibleToUser('/workspace/some-project', null), false);
    assert.throws(
      () => assertProjectVisible(projectId, null),
      (error: unknown) => error instanceof AppError,
    );
  });
});

test('list layer and both guard primitives agree on every project', async () => {
  await withIsolatedDatabase(async () => {
    const userA = makeUser();
    const reader = makeUser();
    const created = projectsDb.createProjectPath('/workspace/agreement', null, userA);
    const projectId = created.project!.project_id;
    sessionsDb.createSession('sess-agree', 'claude', '/workspace/agreement');

    assert.ok((await listPaths(reader)).has('/workspace/agreement'), 'list layer');
    assert.equal(projectsDb.isProjectVisibleToUser(projectId, reader), true, 'id-keyed guard');
    assert.equal(
      projectsDb.isProjectPathVisibleToUser('/workspace/agreement', reader),
      true,
      'path-keyed guard',
    );
  });
});

test('membership survives: explicit member and session participant are still recorded', async () => {
  await withIsolatedDatabase(() => {
    const userA = makeUser();
    const member = makeUser();
    const participant = makeUser();
    const created = projectsDb.createProjectPath('/workspace/membership', null, userA);
    const projectId = created.project!.project_id;

    addMember(projectId, member, 'member', userA);
    sessionsDb.createSession('sess-1', 'claude', '/workspace/membership');
    participantsDb.recordSpawn('sess-1', participant);

    assert.equal(projectMembersDb.getRole(projectId, member), 'member');
    assert.ok(participantsDb.getProjectPathsForUser(participant).includes('/workspace/membership'));
  });
});

test('non-member cannot add members: 404, never disclosed (ADR-172)', async () => {
  await withIsolatedDatabase(() => {
    const userA = makeUser();
    const userB = makeUser();
    const created = projectsDb.createProjectPath('/workspace/managed', null, userA);
    const projectId = created.project!.project_id;

    assert.throws(
      () => addMember(projectId, userB, 'member', userB),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
  });
});

test('platform owner recovers an orphaned project by ownership transfer; refuses non-orphans', async () => {
  await withIsolatedDatabase(() => {
    const platformOwner = makeUser('owner');
    const newOwner = makeUser();

    // Orphan: a project row with no created_by (e.g. session-derived legacy row).
    getConnection()
      .prepare(
        "INSERT INTO projects (project_id, project_path, custom_project_name, isArchived, visibility, created_by) VALUES (?, ?, ?, 0, 'public', NULL)",
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
