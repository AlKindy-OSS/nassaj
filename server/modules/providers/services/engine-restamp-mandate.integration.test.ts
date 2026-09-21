/**
 * ADR-099/T-1237 — the 'restamp' mandate (qa-critic حرج 3).
 *
 * Re-stamping a session's engine is NOT a bigger 'write'; it is a different act.
 * A project writer may legitimately change how a conversation runs, but moving
 * WHERE ITS TEXT GOES — replaying another member's history to a different
 * company, on a different account — is consent that belongs to the people in the
 * conversation. These tests pin the divergence between the two mandates on the
 * exact shape that would otherwise permit it: a project member who is not a
 * participant of the session.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Cross-module imports go through the barrel (eslint boundaries/dependencies).
import { closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { isSessionAccessibleByUser } from '@/modules/providers/index.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'engine-restamp-mandate-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
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

test('a project member who is NOT a participant may write, but may NOT restamp', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('owner', 'hash', 'user');
    const colleague = userDb.createUser('colleague', 'hash', 'user');

    const projectPath = '/workspace/shared';
    const created = projectsDb.createProjectPath(projectPath, 'Shared', owner.id);
    const projectId = created.project?.project_id;
    assert.ok(projectId, 'project row created');

    // The colleague is a full member of the project — they can write in it.
    getConnection()
      .prepare('INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, ?, ?)')
      .run(projectId, colleague.id, 'member', owner.id);

    // The session belongs to the owner alone.
    sessionsDb.createSession('sess-1', 'claude', projectPath);
    getConnection()
      .prepare("INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, 'owner')")
      .run('sess-1', owner.id);

    // Baseline: the existing 'write' mandate admits the colleague (unchanged).
    assert.equal(
      isSessionAccessibleByUser('sess-1', projectPath, colleague.id, 'write'),
      true,
      "'write' still admits a project member — this behaviour must not change",
    );

    // The point of the whole mandate: restamp refuses them.
    assert.equal(
      isSessionAccessibleByUser('sess-1', projectPath, colleague.id, 'restamp'),
      false,
      "'restamp' must refuse a non-participant, however privileged in the project",
    );

    // And the owner, being a participant, keeps it.
    assert.equal(
      isSessionAccessibleByUser('sess-1', projectPath, owner.id, 'restamp'),
      true,
      'the session participant may restamp',
    );
  });
});

test('an anonymous or unresolved caller is refused a restamp', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('owner2', 'hash', 'user');
    const projectPath = '/workspace/anon';
    projectsDb.createProjectPath(projectPath, 'Anon', owner.id);
    sessionsDb.createSession('sess-2', 'claude', projectPath);

    assert.equal(isSessionAccessibleByUser('sess-2', projectPath, null, 'restamp'), false);
    assert.equal(
      isSessionAccessibleByUser('sess-2', projectPath, Number.NaN, 'restamp'),
      false,
    );
  });
});

test('a participant of ANOTHER session in the same project cannot restamp this one', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('owner3', 'hash', 'user');
    const other = userDb.createUser('other3', 'hash', 'user');
    const projectPath = '/workspace/two-sessions';
    projectsDb.createProjectPath(projectPath, 'Two', owner.id);

    sessionsDb.createSession('sess-a', 'claude', projectPath);
    sessionsDb.createSession('sess-b', 'claude', projectPath);
    getConnection()
      .prepare("INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, 'owner')")
      .run('sess-b', other.id);

    assert.equal(isSessionAccessibleByUser('sess-a', projectPath, other.id, 'restamp'), false);
    assert.equal(isSessionAccessibleByUser('sess-b', projectPath, other.id, 'restamp'), true);
  });
});
