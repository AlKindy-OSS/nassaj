/**
 * ADR-173 P4 (H1, qa-critic condition 3): the restamp mandate no longer rides
 * on participation. It is a predicate independent of attribution: the strict
 * spawn owner OR the project owner, each also holding 'write'. A shared writer,
 * a message author, a plain spawn participant and a cancelled send get nothing.
 * Permanent delete stays creator / project owner / platform admin.
 *
 * Membership enforcement is OFF here on purpose: that is where the participant
 * arm (message_authors included) used to admit every mode.
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
  messageAuthorsDb,
  participantsDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

import {
  canPermanentlyDeleteSession,
  isSessionAccessibleByUser,
  isSessionOwnProjectOwner,
  isSessionTurnStopPrivileged,
} from './session-access.js';

const PROJECT_PATH = '/workspace/adr173-restamp';
const SID = 'adr173-restamp-session';

type Cast = { projectOwner: number; creator: number; writer: number; spawnParticipant: number; outsider: number };

async function withCast(run: (cast: Cast) => void): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousEnforce = process.env.PROJECT_MEMBERSHIP_ENFORCE;
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  const dir = await mkdtemp(path.join(tmpdir(), 'adr173-restamp-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'db.sqlite');
  await initializeDatabase();
  try {
    const user = (name: string) => userDb.createUser(name, 'hash', 'user').id;
    const cast = {
      projectOwner: user('project-owner'), creator: user('creator'), writer: user('writer'),
      spawnParticipant: user('spawn-participant'), outsider: user('outsider'),
    };
    const projectId = projectsDb.createProjectPath(PROJECT_PATH, 'Shared', cast.projectOwner).project?.project_id;
    assert.ok(projectId);
    const addMember = getConnection()
      .prepare("INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, 'member', ?)");
    for (const id of [cast.creator, cast.writer, cast.spawnParticipant]) addMember.run(projectId, id, cast.projectOwner);
    sessionsDb.createSession(SID, 'claude', PROJECT_PATH);
    participantsDb.recordSpawn(SID, cast.creator);
    participantsDb.recordSpawn(SID, cast.spawnParticipant);
    participantsDb.recordSpawn(SID, cast.writer, { provider: 'claude', projectPath: PROJECT_PATH, sharedWriter: true });
    // The writer's prompt row (also what a cancelled send leaves behind).
    messageAuthorsDb.recordUserMessage(SID, cast.writer, 'a shared-writer prompt');
    run(cast);
  } finally {
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousEnforce !== undefined) process.env.PROJECT_MEMBERSHIP_ENFORCE = previousEnforce;
    await rm(dir, { recursive: true, force: true });
  }
}

const restamp = (userId: number) => isSessionAccessibleByUser(SID, PROJECT_PATH, userId, 'restamp');

test('restamp: strict spawn owner and project owner only (enforcement off)', async () => {
  await withCast((cast) => {
    assert.equal(restamp(cast.creator), true, 'strict spawn owner');
    assert.equal(restamp(cast.projectOwner), true, 'project owner');
  });
});

test('restamp: a shared writer with a message_authors row is refused (condition 3)', async () => {
  await withCast((cast) => {
    assert.equal(isSessionAccessibleByUser(SID, PROJECT_PATH, cast.writer, 'write'), true, 'the writer may write');
    assert.equal(restamp(cast.writer), false);
  });
});

test('restamp: a plain spawn participant and an outsider are refused', async () => {
  await withCast((cast) => {
    assert.equal(restamp(cast.spawnParticipant), false, 'participation is not the restamp mandate');
    assert.equal(restamp(cast.outsider), false);
    assert.equal(isSessionAccessibleByUser(SID, PROJECT_PATH, null, 'restamp'), false);
  });
});

test('restamp: a cancelled send (author row only, no participant row) grants nothing', async () => {
  await withCast((cast) => {
    messageAuthorsDb.recordUserMessage(SID, cast.outsider, 'a send that was cancelled before launch');
    assert.equal(participantsDb.isParticipant(SID, cast.outsider), true, 'the author arm admits read/write today');
    assert.equal(restamp(cast.outsider), false);
  });
});

test('permanent delete stays creator / project owner; a shared writer is refused', async () => {
  await withCast((cast) => {
    assert.equal(canPermanentlyDeleteSession(SID, PROJECT_PATH, cast.writer), false);
    assert.equal(canPermanentlyDeleteSession(SID, PROJECT_PATH, cast.spawnParticipant), false);
    assert.equal(canPermanentlyDeleteSession(SID, PROJECT_PATH, cast.creator), true);
    assert.equal(canPermanentlyDeleteSession(SID, PROJECT_PATH, cast.projectOwner), true);
  });
});

test('P5 stop rights: project owner and platform admin may stop any turn; writers and outsiders may not', async () => {
  await withCast((cast) => {
    assert.equal(isSessionTurnStopPrivileged(SID, cast.projectOwner), true, 'project owner');
    assert.equal(isSessionTurnStopPrivileged(SID, cast.writer), false, 'a shared writer only when stuck');
    assert.equal(isSessionTurnStopPrivileged(SID, cast.creator), false, 'the starter arm is the run\'s, not this');
    assert.equal(isSessionTurnStopPrivileged(SID, cast.outsider), false);
    // Enforcement off: the admin's write comes from membership like anyone's; the
    // privilege is the platform role (the writer is a plain member and is refused).
    const admin = userDb.createUser('platform-admin', 'hash', 'admin').id;
    const projectId = projectsDb.getProjectPath(PROJECT_PATH)?.project_id;
    getConnection().prepare("INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, 'member', ?)")
      .run(projectId, admin, cast.projectOwner);
    assert.equal(isSessionTurnStopPrivileged(SID, admin), true, 'platform admin');
    assert.equal(isSessionTurnStopPrivileged('no-such-session', cast.projectOwner), false);
    assert.equal(isSessionTurnStopPrivileged(SID, null), false);
  });
});

test('git submit port: the owner of the session\'s OWN project only, never of a client-named one', async () => {
  await withCast((cast) => {
    assert.equal(isSessionOwnProjectOwner(SID, cast.projectOwner), true);
    const otherOwner = userDb.createUser('other-owner', 'hash', 'user').id;
    projectsDb.createProjectPath('/workspace/adr173-other', 'Other', otherOwner);
    assert.equal(isSessionOwnProjectOwner(SID, otherOwner), false, 'owning another project grants nothing here');
    assert.equal(isSessionOwnProjectOwner('unknown-session', cast.projectOwner), false);
  });
});
