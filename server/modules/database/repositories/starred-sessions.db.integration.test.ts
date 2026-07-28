import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { starredSessionsDb } from '@/modules/database/repositories/starred-sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'starred-sessions-db-'));
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

test('star/unstar is per-user and idempotent', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;
    const bob = userDb.createUser('bob', 'hash', 'user').id;

    assert.equal(starredSessionsDb.isStarred(alice, 'session-1'), false);

    assert.equal(starredSessionsDb.setStarred(alice, 'session-1', true, '-home-demo'), true);
    assert.equal(starredSessionsDb.isStarred(alice, 'session-1'), true);
    // Bob's view is unaffected — star is per user.
    assert.equal(starredSessionsDb.isStarred(bob, 'session-1'), false);

    // Re-starring is idempotent and may refresh the project name.
    assert.equal(starredSessionsDb.setStarred(alice, 'session-1', true, '-home-demo-renamed'), true);
    const aliceList = starredSessionsDb.listStarredSessions(alice);
    assert.equal(aliceList.length, 1);
    assert.equal(aliceList[0].sessionId, 'session-1');
    assert.equal(aliceList[0].projectName, '-home-demo-renamed');

    // Unstar is idempotent.
    assert.equal(starredSessionsDb.setStarred(alice, 'session-1', false, null), false);
    assert.equal(starredSessionsDb.setStarred(alice, 'session-1', false, null), false);
    assert.equal(starredSessionsDb.isStarred(alice, 'session-1'), false);
    assert.deepEqual(starredSessionsDb.listStarredSessions(alice), []);
  });
});

test('getStarredSessionIds resolves a page of sessions in one batch', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;

    starredSessionsDb.star(alice, 'session-a', '-home-p');
    starredSessionsDb.star(alice, 'session-c', '-home-p');

    const result = starredSessionsDb.getStarredSessionIds(alice, [
      'session-a',
      'session-b',
      'session-c',
    ]);

    assert.equal(result.has('session-a'), true);
    assert.equal(result.has('session-b'), false);
    assert.equal(result.has('session-c'), true);

    // Empty input never touches the DB and returns an empty set.
    assert.equal(starredSessionsDb.getStarredSessionIds(alice, []).size, 0);
  });
});

test('deleting a user cascades and clears their stars', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;
    starredSessionsDb.star(alice, 'session-1', '-home-p');
    assert.equal(starredSessionsDb.isStarred(alice, 'session-1'), true);

    getConnection().prepare('DELETE FROM users WHERE id = ?').run(alice);
    assert.deepEqual(starredSessionsDb.listStarredSessions(alice), []);
  });
});
