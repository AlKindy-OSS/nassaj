/**
 * B-IDOR-SESSION / B-IDOR-ARCHIVED — the session MUTATION and ARCHIVE-LISTING
 * gates.
 *
 * Two defects, one root cause: `fetchHistory` was hardened in B-105/B-111 but its
 * siblings were not.
 *
 *  (2) `deleteOrArchiveSessionById`, `restoreSessionById` and `renameSessionById`
 *      took a sessionId and NOTHING else — no identity, no check. The delete path
 *      unlinks `jsonl_path` from disk and drops the row, so any authenticated
 *      account could destroy any conversation on the server by id.
 *
 *  (3) `listArchivedSessions` ran an unfiltered `WHERE isArchived = 1` query and
 *      returned sessionId + project_path + custom_name for EVERY user, private
 *      projects included — which also handed out the very sessionIds that the
 *      rest of the session API treats as unguessable.
 *
 * The crux pinned below is that a WRITE gate must not be the READ gate: every
 * project on the live install is `visibility = 'public'`, and public is READABLE
 * by any authenticated user by design (B-PRIV). So the fix cannot be "reuse
 * fetchHistory's predicate" — a public project must keep granting read while
 * refusing destruction.
 *
 * Fixtures are real: real users, a real project row, a real session row and a real
 * transcript file on disk, with ownership recorded through the production
 * run-path call (`participantsDb.recordSpawn`).
 *
 * Framework: node:test + node:assert/strict via tsx.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  participantsDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { isSessionAccessibleByUser, sessionsService } from './sessions.service.js';

let dbDir = '';
let workspaceRoot = '';
let ownerId = 0;
let strangerId = 0;

let publicProjectPath = '';
let privateProjectPath = '';
let publicTranscript = '';

const PUBLIC_SESSION = 'idor-public-session-001';
const PRIVATE_SESSION = 'idor-private-session-002';

/** Rebuilds both projects, both sessions and the transcript on disk. */
function seed(): void {
  publicProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'public-'));
  privateProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'private-'));
  publicTranscript = path.join(publicProjectPath, `${PUBLIC_SESSION}.jsonl`);
  fs.writeFileSync(publicTranscript, '{"type":"message"}\n', 'utf8');

  projectsDb.createProjectPath(publicProjectPath, 'Public Project', ownerId);
  const privateProject = projectsDb.createProjectPath(privateProjectPath, 'Private Project', ownerId);
  projectsDb.setProjectVisibility(privateProject.project?.project_id as string, 'private');

  sessionsDb.createSession(PUBLIC_SESSION, 'claude', publicProjectPath, 'Public session', undefined, undefined, publicTranscript);
  sessionsDb.createSession(PRIVATE_SESSION, 'claude', privateProjectPath, 'Private session');
  // Production ownership stamp: the spawner becomes the session's owner participant.
  participantsDb.recordSpawn(PUBLIC_SESSION, ownerId);
  participantsDb.recordSpawn(PRIVATE_SESSION, ownerId);
}

/** Asserts an AppError with the non-disclosing 404 contract. */
function assertNotFound(error: unknown): void {
  assert.ok(error instanceof AppError, 'refusal is an AppError');
  assert.equal((error as AppError).statusCode, 404, '404, never 403 — existence is not disclosed');
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-sess-idor-db-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-sess-idor-ws-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  ownerId = userDb.createUser('sess_owner', 'hash', 'user').id;
  strangerId = userDb.createUser('sess_stranger', 'hash', 'user').id;
});

beforeEach(() => {
  seed();
});

after(() => {
  closeConnection();
  delete process.env.DATABASE_PATH;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('CRUX: a public project stays READABLE while its session refuses destruction by a stranger', async () => {
  const session = sessionsDb.getSessionById(PUBLIC_SESSION);
  assert.ok(session, 'fixture session exists');

  // The read gate admits the stranger — that is intended (public project) and is
  // precisely why reusing it as the mutation gate authorized nothing.
  assert.equal(
    isSessionAccessibleByUser(PUBLIC_SESSION, session.project_path, strangerId, 'read'),
    true,
    'read: allowed for a public project',
  );
  assert.equal(
    isSessionAccessibleByUser(PUBLIC_SESSION, session.project_path, strangerId, 'write'),
    false,
    'write: refused — public confers read, never write',
  );

  await assert.rejects(
    () => sessionsService.deleteOrArchiveSessionById(PUBLIC_SESSION, strangerId, { force: true, deletedFromDisk: true }),
    (error: unknown) => {
      assertNotFound(error);
      return true;
    },
  );

  assert.notEqual(sessionsDb.getSessionById(PUBLIC_SESSION), null, 'session row survives');
  assert.equal(fs.existsSync(publicTranscript), true, 'transcript file survives on disk');
});

test('a stranger cannot soft-archive, restore or rename another user\'s session', async () => {
  await assert.rejects(
    () => sessionsService.deleteOrArchiveSessionById(PUBLIC_SESSION, strangerId, {}),
    (error: unknown) => {
      assertNotFound(error);
      return true;
    },
  );
  assert.equal(Boolean(sessionsDb.getSessionById(PUBLIC_SESSION)?.isArchived), false, 'still active');

  assert.throws(
    () => sessionsService.restoreSessionById(PUBLIC_SESSION, strangerId),
    (error: unknown) => {
      assertNotFound(error);
      return true;
    },
  );

  assert.throws(
    () => sessionsService.renameSessionById(PUBLIC_SESSION, strangerId, 'pwned'),
    (error: unknown) => {
      assertNotFound(error);
      return true;
    },
  );
  assert.equal(sessionsDb.getSessionById(PUBLIC_SESSION)?.custom_name, 'Public session', 'title unchanged');
});

test('an unauthenticated / unresolved caller (null) is refused outright', async () => {
  await assert.rejects(
    () => sessionsService.deleteOrArchiveSessionById(PUBLIC_SESSION, null, { force: true, deletedFromDisk: true }),
    (error: unknown) => {
      assertNotFound(error);
      return true;
    },
  );
  assert.equal(fs.existsSync(publicTranscript), true, 'transcript survives');
});

test('the owner still archives, restores, renames and force-deletes their own session', async () => {
  const archived = await sessionsService.deleteOrArchiveSessionById(PUBLIC_SESSION, ownerId, {});
  assert.equal(archived.action, 'archived');
  assert.equal(Boolean(sessionsDb.getSessionById(PUBLIC_SESSION)?.isArchived), true);

  const restored = sessionsService.restoreSessionById(PUBLIC_SESSION, ownerId);
  assert.equal(restored.isArchived, false);
  assert.equal(Boolean(sessionsDb.getSessionById(PUBLIC_SESSION)?.isArchived), false);

  const renamed = sessionsService.renameSessionById(PUBLIC_SESSION, ownerId, 'Owner title');
  assert.equal(renamed.summary, 'Owner title');
  assert.equal(sessionsDb.getSessionById(PUBLIC_SESSION)?.custom_name, 'Owner title');

  const deleted = await sessionsService.deleteOrArchiveSessionById(PUBLIC_SESSION, ownerId, {
    force: true,
    deletedFromDisk: true,
  });
  assert.equal(deleted.action, 'deleted');
  assert.equal(deleted.deletedFromDisk, true, 'the destructive path still works for the owner');
  assert.equal(sessionsDb.getSessionById(PUBLIC_SESSION), null, 'row gone');
  assert.equal(fs.existsSync(publicTranscript), false, 'transcript removed');
});

test('B-IDOR-ARCHIVED: the archived listing no longer leaks another user\'s private session', () => {
  sessionsDb.updateSessionIsArchived(PRIVATE_SESSION, true);
  sessionsDb.updateSessionIsArchived(PUBLIC_SESSION, true);

  // The repository query itself is still user-blind — proving the filter, not the
  // SQL, is what protects the route.
  const rawIds = sessionsDb.getArchivedSessions().map((row) => row.session_id);
  assert.ok(rawIds.includes(PRIVATE_SESSION), 'the raw query does return the private session');

  const strangerIds = sessionsService.listArchivedSessions(strangerId).map((item) => item.sessionId);
  assert.equal(
    strangerIds.includes(PRIVATE_SESSION),
    false,
    'a private project\'s archived session (id + path + title) is not disclosed',
  );
  assert.equal(strangerIds.includes(PUBLIC_SESSION), true, 'a public project\'s archived session stays listable');

  const ownerIds = sessionsService.listArchivedSessions(ownerId).map((item) => item.sessionId);
  assert.ok(ownerIds.includes(PRIVATE_SESSION), 'the owner still sees their own archived session');
  assert.ok(ownerIds.includes(PUBLIC_SESSION), 'and the public one');

  assert.deepEqual(sessionsService.listArchivedSessions(null), [], 'no identity ⇒ nothing at all');
});
