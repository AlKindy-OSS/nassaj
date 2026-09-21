/**
 * B-29: orphan-session exclusion from the conversations list.
 *
 * A transcript dropped into a project folder by an out-of-band `claude -p`
 * run (agent/CLI in the project cwd) is indexed by the session synchronizer
 * but was never started through this server, so it has neither a
 * session_participants row (recordSpawn) nor a message_authors row
 * (recordUserMessage). Such "orphan" sessions must NOT appear in the
 * conversations list, while "native" sessions started through the server must
 * still be listed.
 *
 * Contract under test:
 * 1. A session with a participant row IS listed and counted.
 * 2. A session with a message_author row (but no participant) IS listed.
 * 3. An orphan session (neither marker) is EXCLUDED from both the page query
 *    and the count.
 * 4. The exclusion is a pure visibility filter: getSessionsByProjectPath and
 *    getSessionsByProjectPathIncludingArchived (ownership/deletion paths) still
 *    see the orphan row.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  messageAuthorsDb,
  participantsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

const PROJECT_PATH = '/workspace/demo-project';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-native-'));
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
function makeUser(): number {
  seq += 1;
  return userDb.createUser(`u_${seq}_${Date.now()}`, 'hash', 'user').id;
}

test('orphan sessions are excluded from the conversations list; native ones remain', async () => {
  await withIsolatedDatabase(() => {
    const userId = makeUser();

    // Native via participant row (UI/server spawn).
    sessionsDb.createSession('sess-participant', 'claude', PROJECT_PATH, 'Participant Session');
    participantsDb.recordSpawn('sess-participant', userId);

    // Native via message-author row only (sender attribution, no participant).
    sessionsDb.createSession('sess-author', 'claude', PROJECT_PATH, 'Author Session');
    messageAuthorsDb.recordUserMessage('sess-author', userId, 'hello from the UI');

    // Orphan: indexed by the synchronizer, never spawned through the server.
    sessionsDb.createSession('sess-orphan', 'claude', PROJECT_PATH, 'Orphan Session');

    const page = sessionsDb.getSessionsByProjectPathPage(PROJECT_PATH, 50, 0);
    const listedIds = page.map((row) => row.session_id).sort();

    assert.deepEqual(listedIds, ['sess-author', 'sess-participant'], 'orphan must be excluded from the page');
    assert.equal(sessionsDb.countSessionsByProjectPath(PROJECT_PATH), 2, 'count must exclude the orphan');
  });
});

test('the orphan filter is visibility-only: ownership/deletion paths still see the orphan', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('sess-orphan', 'claude', PROJECT_PATH, 'Orphan Session');

    const ownershipView = sessionsDb.getSessionsByProjectPath(PROJECT_PATH);
    const deletionView = sessionsDb.getSessionsByProjectPathIncludingArchived(PROJECT_PATH);

    assert.deepEqual(
      ownershipView.map((row) => row.session_id),
      ['sess-orphan'],
      'getSessionsByProjectPath must still return the orphan row',
    );
    assert.deepEqual(
      deletionView.map((row) => row.session_id),
      ['sess-orphan'],
      'deletion path must still see the orphan row',
    );
  });
});

test('a session that gains a participant row later becomes listed', async () => {
  await withIsolatedDatabase(() => {
    const userId = makeUser();
    sessionsDb.createSession('sess-late', 'claude', PROJECT_PATH, 'Late Session');

    assert.equal(sessionsDb.countSessionsByProjectPath(PROJECT_PATH), 0, 'starts excluded as an orphan');

    participantsDb.recordSpawn('sess-late', userId);

    assert.equal(sessionsDb.countSessionsByProjectPath(PROJECT_PATH), 1, 'listed once a spawn is recorded');
    assert.deepEqual(
      sessionsDb.getSessionsByProjectPathPage(PROJECT_PATH, 50, 0).map((row) => row.session_id),
      ['sess-late'],
    );
  });
});
