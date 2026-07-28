/**
 * B-138 — projectsDb.isProjectWritableByUser(projectId, userId).
 *
 * The WRITE-authorization sibling of the READ predicate isProjectVisibleToUser.
 * The whole point of B-138 is the DIVERGENCE from visibility: a `public` project
 * is READABLE by any authenticated user but must NOT be WRITABLE by a non-member,
 * otherwise a stranger could replace/plant/delete files in another user's public
 * project. These tests pin that divergence plus the three membership routes
 * (creator / explicit member / active session participant) and the fail-closed
 * edges, against a real migrated database using the shared isolated-db harness.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-db-writable-'));
  const databasePath = path.join(tempDirectory, 'db.sqlite');

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

/** Narrows a nullable repo row to a definite value (strict-null safe). */
function requireRow<T>(row: T | null | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

/** Grants an explicit project_members row (mirrors the membership route). */
function addMember(projectId: string, userId: number, role = 'member', addedBy: number | null = null): void {
  getConnection()
    .prepare('INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, ?, ?)')
    .run(projectId, userId, role, addedBy);
}

/**
 * Records `userId` as a participant of a session living in `projectPath`.
 * session_participants.session_id has a FK to sessions(session_id), so the
 * session row must exist first; createSession also upserts the projects row.
 */
function addParticipant(sessionId: string, projectPath: string, userId: number, role: 'owner' | 'participant' = 'participant'): void {
  sessionsDb.createSession(sessionId, 'claude', projectPath);
  getConnection()
    .prepare('INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, ?)')
    .run(sessionId, userId, role);
}

test('B-138 crux: a PUBLIC project is VISIBLE to a non-member but NOT WRITABLE by them', async () => {
  await withIsolatedDatabase(() => {
    const creator = userDb.createUser('creator', 'hash', 'user');
    const stranger = userDb.createUser('stranger', 'hash', 'user');

    const created = projectsDb.createProjectPath('/workspace/public-proj', 'Public', creator.id);
    const projectId = requireRow(created.project, 'created project row').project_id;
    assert.equal(projectsDb.getProjectVisibility(projectId), 'public', 'project is public by default');

    // The read gate lets any authenticated user SEE a public project ...
    assert.equal(projectsDb.isProjectVisibleToUser(projectId, stranger.id), true, 'public ⇒ visible to stranger');
    // ... but the write gate must REFUSE a non-member. This is B-138.
    assert.equal(projectsDb.isProjectWritableByUser(projectId, stranger.id), false, 'public ⇏ writable by non-member');
  });
});

test('B-138: the creator is writable, and an explicit project_members row grants write', async () => {
  await withIsolatedDatabase(() => {
    const creator = userDb.createUser('creator', 'hash', 'user');
    const member = userDb.createUser('member', 'hash', 'user');

    const created = projectsDb.createProjectPath('/workspace/team-proj', 'Team', creator.id);
    const projectId = requireRow(created.project, 'created project row').project_id;

    assert.equal(projectsDb.isProjectWritableByUser(projectId, creator.id), true, 'creator writable');

    // Before membership the member is a stranger: not writable.
    assert.equal(projectsDb.isProjectWritableByUser(projectId, member.id), false, 'pre-membership: not writable');
    addMember(projectId, member.id, 'member', creator.id);
    assert.equal(projectsDb.isProjectWritableByUser(projectId, member.id), true, 'explicit member writable');
  });
});

test('B-138: an active session participant is writable; a non-participant is not', async () => {
  await withIsolatedDatabase(() => {
    const participant = userDb.createUser('participant', 'hash', 'user');
    const stranger = userDb.createUser('stranger', 'hash', 'user');

    // A project created purely via a session upsert has NO creator and NO
    // membership, so participation is the ONLY route to write here.
    const created = projectsDb.createProjectPath('/workspace/participant-proj');
    const project = requireRow(created.project, 'created project row');
    const projectId = project.project_id;
    assert.equal(project.created_by, null, 'no creator on a session-upserted project');

    addParticipant('sess-1', project.project_path, participant.id, 'participant');

    assert.equal(projectsDb.isProjectWritableByUser(projectId, participant.id), true, 'participant writable');
    assert.equal(projectsDb.isProjectWritableByUser(projectId, stranger.id), false, 'non-participant not writable');
  });
});

test('B-138 fail-closed: anonymous / non-integer userId and unknown projectId are never writable', async () => {
  await withIsolatedDatabase(() => {
    const creator = userDb.createUser('creator', 'hash', 'user');
    const created = projectsDb.createProjectPath('/workspace/fc-proj', 'FailClosed', creator.id);
    const projectId = requireRow(created.project, 'created project row').project_id;

    // An unresolved caller is refused even on a public project (no public bypass).
    assert.equal(projectsDb.isProjectWritableByUser(projectId, null), false, 'null userId not writable');
    assert.equal(projectsDb.isProjectWritableByUser(projectId, Number.NaN), false, 'NaN userId not writable');
    assert.equal(projectsDb.isProjectWritableByUser(projectId, 1.5), false, 'non-integer userId not writable');

    // Unknown project: false, never throws — existence is never disclosed.
    assert.equal(projectsDb.isProjectWritableByUser('does-not-exist', creator.id), false, 'unknown project not writable');
  });
});

test('B-138 parity: on a PRIVATE project the creator writes, a non-member neither writes nor sees it', async () => {
  await withIsolatedDatabase(() => {
    const creator = userDb.createUser('creator', 'hash', 'user');
    const stranger = userDb.createUser('stranger', 'hash', 'user');

    const created = projectsDb.createProjectPath('/workspace/private-proj', 'Private', creator.id);
    const projectId = requireRow(created.project, 'created project row').project_id;
    projectsDb.setProjectVisibility(projectId, 'private');

    assert.equal(projectsDb.isProjectWritableByUser(projectId, creator.id), true, 'creator writable on private');
    assert.equal(projectsDb.isProjectWritableByUser(projectId, stranger.id), false, 'non-member not writable on private');
    // And the read gate hides it entirely, so a 404 on the write path discloses nothing.
    assert.equal(projectsDb.isProjectVisibleToUser(projectId, stranger.id), false, 'private is invisible to a non-member');
  });
});
