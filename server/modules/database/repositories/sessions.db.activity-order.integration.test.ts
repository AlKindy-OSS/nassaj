/**
 * B-1668 item 2: the sidebar pages order sessions by LAST ACTIVITY, with the
 * millisecond precision the client comparator uses, and the project's newest
 * creation time is read separately for project "date" order.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  participantsDb,
  sessionsDb,
  starredSessionsDb,
  userDb,
} from '@/modules/database/index.js';

const PROJECT_PATH = '/workspace/activity-order';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-activity-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

let seq = 0;
function makeUser(): number {
  seq += 1;
  return userDb.createUser(`activity_${seq}_${Date.now()}`, 'hash', 'user').id;
}

/** A native session (participant row) with explicit timestamps. */
function addSession(userId: number, id: string, createdAt: string, updatedAt: string | undefined): void {
  sessionsDb.createSession(id, 'claude', PROJECT_PATH, id, createdAt, updatedAt);
  participantsDb.recordSpawn(id, userId);
}

const ids = (rows: Array<{ session_id: string }>): string[] => rows.map((row) => row.session_id);

test('pages lead with the most recently active session, not the newest created', async () => {
  await withIsolatedDatabase(() => {
    const userId = makeUser();
    addSession(userId, 'old-but-busy', '2026-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    addSession(userId, 'new-but-idle', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');

    assert.deepEqual(ids(sessionsDb.getSessionsByProjectPathPage(PROJECT_PATH, 10, 0)), ['old-but-busy', 'new-but-idle']);
    assert.deepEqual(
      ids(sessionsDb.getUnstarredSessionsByProjectPathPageForUser(userId, PROJECT_PATH, 10, 0)),
      ['old-but-busy', 'new-but-idle'],
    );
  });
});

test('two sessions active within one second keep their millisecond order', async () => {
  await withIsolatedDatabase(() => {
    const userId = makeUser();
    // The id order is the opposite of the time order, so a whole-second sort
    // (datetime) would fall through to the id tie-break and flip them.
    addSession(userId, 'a-later', '2026-01-01T00:00:00.000Z', '2026-10-01T10:00:00.900Z');
    addSession(userId, 'z-earlier', '2026-01-01T00:00:00.000Z', '2026-10-01T10:00:00.100Z');

    assert.deepEqual(ids(sessionsDb.getSessionsByProjectPathPage(PROJECT_PATH, 10, 0)), ['a-later', 'z-earlier']);
  });
});

test('equal activity breaks by session_id descending; starred rows follow the same order', async () => {
  await withIsolatedDatabase(() => {
    const userId = makeUser();
    const stamp = '2026-10-01T10:00:00.000Z';
    for (const id of ['s1', 's3', 's2']) addSession(userId, id, stamp, stamp);
    for (const id of ['s1', 's3', 's2']) starredSessionsDb.star(userId, id, null);

    assert.deepEqual(ids(sessionsDb.getSessionsByProjectPathPage(PROJECT_PATH, 10, 0)), ['s3', 's2', 's1']);
    assert.deepEqual(ids(sessionsDb.getStarredSessionsByProjectPathForUser(userId, PROJECT_PATH)), ['s3', 's2', 's1']);
  });
});

test('newest creation time ignores activity', async () => {
  await withIsolatedDatabase(() => {
    const userId = makeUser();
    assert.equal(sessionsDb.getNewestSessionCreatedAtByProjectPath(PROJECT_PATH), null);
    addSession(userId, 'busy', '2026-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    addSession(userId, 'fresh', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');

    assert.equal(sessionsDb.getNewestSessionCreatedAtByProjectPath(PROJECT_PATH), '2026-08-01T00:00:00.000Z');
  });
});
