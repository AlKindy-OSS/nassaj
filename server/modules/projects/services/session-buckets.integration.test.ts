/**
 * Every provider's sessions reach the payload (B-598).
 *
 * The bug this pins: a session could be spawned through nassaj, get its
 * `session_participants` row, satisfy the B-29 native filter — and still be
 * invisible, because the payload builder grouped rows into a six-key literal
 * that stopped at `opencode` and dropped everything else on the floor. Three
 * providers shipped through that hole in a row (hermes, kimi, glm), each one
 * looking complete because it could spawn and stream.
 *
 * So the assertion here is deliberately not "hermes works": it is that EVERY
 * provider in `shared/sessionBuckets.ts` survives the round trip. A provider
 * added later without a bucket fails this test instead of failing silently in
 * the sidebar, which is the only difference that mattered.
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
  projectsDb,
  sessionsDb,
  starredSessionsDb,
  stopReconcileScheduler,
  userDb,
} from '@/modules/database/index.js';
import { getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

import { SESSION_BUCKET_PROVIDERS, sessionBucketKey } from '../../../../shared/sessionBuckets.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-buckets-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

const PROJECT_PATH = '/workspace/session-buckets';

/** One spawned session per provider, exactly as a run path records it. */
function seedOneSessionPerProvider(userId: number): Map<string, string> {
  const sessionIdByProvider = new Map<string, string>();

  for (const provider of SESSION_BUCKET_PROVIDERS) {
    const sessionId = `session-${provider}`;
    sessionsDb.createSession(sessionId, provider, PROJECT_PATH);
    // The participant row is what the B-29 native filter looks for; without it
    // the session is correctly hidden and this test would pass for the wrong
    // reason.
    participantsDb.recordSpawn(sessionId, userId, { role: 'owner' });
    sessionIdByProvider.set(provider, sessionId);
  }

  return sessionIdByProvider;
}

test('B-598: every provider owns a bucket in the project list payload', async () => {
  await withIsolatedDatabase(async () => {
    const userId = userDb.createUser(`buckets_${Date.now()}`, 'hash', 'user').id;
    projectsDb.createProjectPath(PROJECT_PATH, null, userId);
    const sessionIdByProvider = seedOneSessionPerProvider(userId);

    const projects = await getProjectsWithSessions({
      skipSynchronization: true,
      currentUserId: userId,
      sessionsLimit: 200,
    });
    const project = projects.find((candidate) => candidate.fullPath === PROJECT_PATH);
    assert.ok(project, 'the seeded project must be listed');

    for (const provider of SESSION_BUCKET_PROVIDERS) {
      const key = sessionBucketKey(provider);
      const bucket = (project as unknown as Record<string, Array<{ id: string }>>)[key];
      assert.ok(Array.isArray(bucket), `payload is missing the "${key}" bucket`);
      assert.deepEqual(
        bucket.map((session) => session.id),
        [sessionIdByProvider.get(provider)],
        `a ${provider} session was dropped instead of landing in "${key}"`,
      );
    }

    assert.equal(
      project.sessionMeta.total,
      SESSION_BUCKET_PROVIDERS.length,
      'the count and the buckets must agree — a row counted but not bucketed is the B-598 shape',
    );
  });
});

test('DB-first project list returns persisted directory metadata without probing the path', async () => {
  await withIsolatedDatabase(async () => {
    stopReconcileScheduler();
    const userId = userDb.createUser(`db_first_${Date.now()}`, 'hash', 'user').id;
    const definitelyMissingPath = `/not-mounted/db-first-${Date.now()}`;
    projectsDb.createProjectPath(definitelyMissingPath, null, userId);

    const [project] = await getProjectsWithSessions({
      skipSynchronization: true,
      currentUserId: userId,
    });
    assert.ok(project);
    assert.equal(project.dirExists, null, 'an unprobed path is unknown, not falsely missing');
    assert.equal(project.metadataCheckedAt, null);

    projectsDb.updateProjectDirectoryState(project.projectId, false);
    const [refreshed] = await getProjectsWithSessions({
      skipSynchronization: true,
      currentUserId: userId,
    });
    assert.equal(refreshed.dirExists, false);
    assert.match(refreshed.metadataCheckedAt ?? '', /^\d{4}-\d{2}-\d{2}/);
  });
});

test('B-598: the paginated sessions endpoint carries the same buckets', async () => {
  await withIsolatedDatabase(async () => {
    const userId = userDb.createUser(`buckets_page_${Date.now()}`, 'hash', 'user').id;
    projectsDb.createProjectPath(PROJECT_PATH, null, userId);
    const projectId = projectsDb.getProjectPath(PROJECT_PATH)!.project_id;
    const sessionIdByProvider = seedOneSessionPerProvider(userId);

    const page = await getProjectSessionsPage(projectId, { currentUserId: userId, limit: 200 });

    for (const provider of SESSION_BUCKET_PROVIDERS) {
      const key = sessionBucketKey(provider);
      const bucket = (page as unknown as Record<string, Array<{ id: string }>>)[key];
      assert.deepEqual(
        bucket?.map((session) => session.id),
        [sessionIdByProvider.get(provider)],
        `"load more" dropped the ${provider} bucket`,
      );
    }
  });
});

test('a first project session page prepends this user\'s old starred session and paginates only unstarred rows', async () => {
  await withIsolatedDatabase(async () => {
    const userId = userDb.createUser(`starred_page_${Date.now()}`, 'hash', 'user').id;
    const otherUserId = userDb.createUser(`starred_other_${Date.now()}`, 'hash', 'user').id;
    projectsDb.createProjectPath(PROJECT_PATH, null, userId);
    const projectId = projectsDb.getProjectPath(PROJECT_PATH)!.project_id;

    const ids = ['newest', 'newer', 'middle', 'older', 'old-starred'];
    for (const [index, id] of ids.entries()) {
      sessionsDb.createSession(id, 'claude', PROJECT_PATH);
      participantsDb.recordSpawn(id, userId, { role: 'owner' });
      getConnection()
        .prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE session_id = ?')
        .run(`2026-01-0${ids.length - index}T00:00:00.000Z`, `2026-01-0${ids.length - index}T00:00:00.000Z`, id);
    }
    starredSessionsDb.star(userId, 'old-starred', PROJECT_PATH);
    starredSessionsDb.star(otherUserId, 'older', PROJECT_PATH);

    const firstPage = await getProjectSessionsPage(projectId, {
      currentUserId: userId,
      limit: 2,
      offset: 0,
    });
    assert.deepEqual(
      firstPage.sessions.map((session) => session.id),
      ['old-starred', 'newest', 'newer'],
      'an old favourite is present from the first page and another user\'s star does not leak',
    );
    assert.equal(firstPage.sessionMeta.total, 5);
    assert.equal(firstPage.sessionMeta.hasMore, true);

    const secondPage = await getProjectSessionsPage(projectId, {
      currentUserId: userId,
      limit: 2,
      // The client offsets by all rendered rows, including the starred prefix.
      offset: 3,
    });
    assert.deepEqual(secondPage.sessions.map((session) => session.id), ['middle', 'older']);
    assert.equal(secondPage.sessionMeta.hasMore, false);
    assert.ok(
      !secondPage.sessions.some((session) => session.id === 'old-starred'),
      'the starred prefix is not repeated on later pages',
    );
  });
});
