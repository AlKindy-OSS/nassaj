import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { closedSessionsDb } from '@/modules/database/repositories/closed-sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'closed-sessions-db-'));
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

test('closing is global: what one member closes, every member sees closed', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;

    assert.equal(closedSessionsDb.isClosed('session-1'), false);

    closedSessionsDb.closeSession('session-1', alice);

    // No per-user dimension exists at all — the state belongs to the conversation.
    assert.equal(closedSessionsDb.isClosed('session-1'), true);
    const marker = closedSessionsDb.getClosedSession('session-1');
    assert.equal(marker?.closedBy, alice);
    assert.ok(marker?.closedAt);
  });
});

test('closing is reversible, and both directions are idempotent', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;

    closedSessionsDb.closeSession('session-1', alice);
    closedSessionsDb.closeSession('session-1', alice);
    assert.equal(closedSessionsDb.listClosedSessions().length, 1);

    closedSessionsDb.reopenSession('session-1');
    assert.equal(closedSessionsDb.isClosed('session-1'), false);
    // Reopening an already-open conversation must not throw.
    closedSessionsDb.reopenSession('session-1');
    assert.equal(closedSessionsDb.isClosed('session-1'), false);
  });
});

test('re-closing keeps the original closer, not the latest one', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;
    const bob = userDb.createUser('bob', 'hash', 'user').id;

    closedSessionsDb.closeSession('session-1', alice);
    closedSessionsDb.closeSession('session-1', bob);

    // "Who finished this" must stay truthful; a second click cannot rewrite it.
    assert.equal(closedSessionsDb.getClosedSession('session-1')?.closedBy, alice);
  });
});

test('the sidebar flags a page of conversations in one query', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;
    closedSessionsDb.closeSession('session-1', alice);
    closedSessionsDb.closeSession('session-3', alice);

    const closed = closedSessionsDb.getClosedSessionIds(['session-1', 'session-2', 'session-3']);
    assert.deepEqual([...closed].sort(), ['session-1', 'session-3']);

    // Empty input must not hit the DB or throw.
    assert.equal(closedSessionsDb.getClosedSessionIds([]).size, 0);
  });
});

test('deleting the closer leaves the conversation closed, only unattributed', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;
    closedSessionsDb.closeSession('session-1', alice);

    getConnection().prepare('DELETE FROM users WHERE id = ?').run(alice);

    // ON DELETE SET NULL, not CASCADE: losing the person must not silently
    // reopen finished work.
    assert.equal(closedSessionsDb.isClosed('session-1'), true);
    assert.equal(closedSessionsDb.getClosedSession('session-1')?.closedBy, null);
  });
});

test('closing a conversation with no synchronized session row still works', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;
    // No FK on session_id on purpose: sessions synchronize lazily, and the
    // marker must survive a conversation the DB has not caught up with yet.
    closedSessionsDb.closeSession('not-yet-synchronized', alice);
    assert.equal(closedSessionsDb.isClosed('not-yet-synchronized'), true);
  });
});
