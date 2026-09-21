import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { participantsDb } from '@/modules/database/repositories/participants.db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
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

test('B-963: new and reindexed sessions preserve project archival and identity across providers', async () => {
  await withIsolatedDatabase(() => {
    const ownerId = userDb.createUser('project-archive-owner', 'hash', 'user').id;
    const projectPath = '/workspace/discovery-archived';
    const initial = projectsDb.createProjectPath(projectPath, 'Owner chosen name', ownerId).project!;
    for (const provider of ['claude', 'codex', 'opencode']) {
      sessionsDb.createSession(`existing-${provider}`, provider, projectPath);
      sessionsDb.updateSessionIsArchived(`existing-${provider}`, true);
    }
    projectsDb.updateProjectIsArchivedById(initial.project_id, true);
    const archived = projectsDb.getProjectById(initial.project_id);

    for (const provider of ['claude', 'codex', 'opencode']) {
      sessionsDb.createSession(`existing-${provider}`, provider, projectPath);
      sessionsDb.createSession(`new-${provider}`, provider, projectPath);
      assert.deepEqual(projectsDb.getProjectById(initial.project_id), archived);
      assert.equal(sessionsDb.getSessionById(`existing-${provider}`)?.isArchived, 1);
      assert.equal(sessionsDb.getSessionById(`new-${provider}`)?.project_path, projectPath);
    }
    assert.equal(projectsDb.getProjectPaths().length, 0);
    const restored = projectsDb.createProjectPath(projectPath);
    assert.equal(restored.outcome, 'reactivated_archived');
    assert.deepEqual(restored.project, { ...archived, isArchived: 0 });
  });
});

test('B-963: discovery creates missing projects and preserves active project metadata', async () => {
  await withIsolatedDatabase(() => {
    const projectPath = '/workspace/discovered';
    sessionsDb.createSession('first-discovery', 'opencode', projectPath);
    const discovered = projectsDb.getProjectPath(projectPath)!;
    assert.equal(discovered.isArchived, 0);
    assert.equal(discovered.detected_name, 'discovered');
    assert.equal(discovered.created_by, null);
    assert.equal(discovered.custom_project_name, null);
    projectsDb.updateCustomProjectNameById(discovered.project_id, 'Custom name');
    const beforeRescan = projectsDb.getProjectById(discovered.project_id);
    sessionsDb.createSession('first-discovery', 'opencode', projectPath);
    sessionsDb.createSession('second-discovery', 'claude', projectPath);
    assert.deepEqual(projectsDb.getProjectById(discovered.project_id), beforeRescan);
    assert.equal(projectsDb.createProjectPath(projectPath).outcome, 'active_conflict');
  });
});

test('B-963: failed session insertion rolls back its discovered project', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const projectPath = '/workspace/failed-discovery';
    db.exec(`CREATE TEMP TRIGGER reject_test_session BEFORE INSERT ON sessions
      BEGIN SELECT RAISE(ABORT, 'injected session failure'); END`);
    try {
      assert.throws(
        () => sessionsDb.createSession('failed-discovery', 'opencode', projectPath),
        /injected session failure/,
      );
      assert.equal(projectsDb.getProjectPath(projectPath), null);
      assert.equal(sessionsDb.getSessionById('failed-discovery'), null);
    } finally {
      db.exec('DROP TRIGGER reject_test_session');
    }
    sessionsDb.createSession('successful-retry', 'opencode', projectPath);
    assert.ok(projectsDb.getProjectPath(projectPath));
    assert.equal(sessionsDb.getSessionById('successful-retry')?.project_path, projectPath);
  });
});

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
