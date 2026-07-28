import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { participantsDb } from '@/modules/database/repositories/participants.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
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

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    // Both sessions are "native" (spawned through the server) — give each a
    // participant row so the conversations-list count query (B-29 orphan
    // filter) counts them. The assertion under test here is archival, not the
    // orphan filter.
    const userId = userDb.createUser(`u_archive_${Date.now()}`, 'hash', 'user').id;
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    participantsDb.recordSpawn('session-active', userId);
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    participantsDb.recordSpawn('session-archived', userId);
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

test('deleteSessionsByJsonlPath removes only the rows indexed from that transcript file', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'session-ghost',
      'claude',
      '/workspace/demo-project',
      'Ghost Session',
      undefined,
      undefined,
      '/home/user/.claude/projects/demo/session-ghost.jsonl'
    );
    sessionsDb.createSession(
      'session-kept',
      'claude',
      '/workspace/demo-project',
      'Kept Session',
      undefined,
      undefined,
      '/home/user/.claude/projects/demo/session-kept.jsonl'
    );
    sessionsDb.createSession('session-no-path', 'opencode', '/workspace/demo-project', 'No Path Session');

    const removed = sessionsDb.deleteSessionsByJsonlPath('/home/user/.claude/projects/demo/session-ghost.jsonl');
    const removedForUnknownPath = sessionsDb.deleteSessionsByJsonlPath('/home/user/.claude/projects/demo/unknown.jsonl');

    assert.deepEqual(removed, ['session-ghost']);
    assert.deepEqual(removedForUnknownPath, []);
    assert.equal(sessionsDb.getSessionById('session-ghost'), null);
    assert.ok(sessionsDb.getSessionById('session-kept'));
    assert.ok(sessionsDb.getSessionById('session-no-path'));
  });
});

test('createSession upsert preserves a user-archived row instead of resurrecting it (B-161/T-857)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    // A background rescan re-upserts the same session (e.g. the synchronizer
    // re-indexing an unchanged/archived session). Metadata may refresh, but the
    // user's archival decision must NOT be overwritten to active.
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const preservedSession = sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 0, 'archived row must stay out of active lists after upsert');
    assert.equal(archivedSessions.length, 1);
    assert.equal(archivedSessions[0]?.session_id, 'session-reused');
    // Other columns still refresh on upsert — only isArchived is preserved.
    assert.equal(preservedSession?.custom_name, 'Updated Name');
    assert.equal(preservedSession?.isArchived, 1, 'the upsert must not un-archive the session');

    // Un-archiving remains possible through the explicit restore path.
    sessionsDb.updateSessionIsArchived('session-reused', false);
    assert.equal(sessionsDb.getSessionById('session-reused')?.isArchived, 0);
  });
});
