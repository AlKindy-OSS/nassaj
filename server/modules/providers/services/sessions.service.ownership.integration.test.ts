/**
 * sessions.service.ownership.integration.test.ts — B-105 REST IDOR fix.
 *
 * Proves the fail-closed ownership gate on sessionsService.fetchHistory: the
 * endpoint GET /sessions/:id/messages used to derive the session from the URL
 * alone and never check who was asking, so any authenticated user could read
 * another user's conversation by sessionId. The gate added to the service now
 * refuses unless the caller is an owner/participant of — or a recorded message
 * author in — the session, and refuses with the SAME 404 contract used for a
 * missing session so the existence of someone else's session is not disclosed.
 *
 * The fixtures are realistic, not synthetic: real users are created in the DB,
 * the owner is recorded through the exact production run-path call
 * (participantsDb.recordSpawn), and a real vendor transcript .jsonl is written
 * to disk and resolved through the live provider. The provider choice (kimi)
 * is incidental — the gate sits in the service ahead of provider resolution.
 *
 * node:test does not isolate state, so each scenario gets its own DB + temp
 * home (the vendor provider resolves transcripts under os.homedir()).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  messageAuthorsDb,
  participantsDb,
  projectMembersDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { vendorProjectHash } from '@/modules/providers/shared/vendor/vendor-transcript.js';

const PROJECT_PATH = '/work/secret-proj';
const SESSION_ID = 'owned-by-alice-001';

type Fixture = {
  ownerId: number;
  outsiderId: number;
};

/**
 * Builds an isolated DB + temp home, writes a real kimi vendor transcript for
 * SESSION_ID, registers the session row, and records `ownerUsername` as the
 * session owner through the production spawn path. Returns the created user ids.
 */
async function withOwnedSession(
  runTest: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const originalHome = os.homedir;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'b105-ownership-'));
  const databasePath = path.join(tempRoot, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  // The vendor provider reads transcripts relative to the home directory.
  (os as unknown as { homedir: () => string }).homedir = () => tempRoot;

  try {
    const ownerId = userDb.createUser('alice', 'hash-a', 'user').id;
    const outsiderId = userDb.createUser('bob', 'hash-b', 'user').id;

    // Real transcript on disk, resolved through the live kimi provider path.
    const dir = path.join(tempRoot, '.nassaj-vendor-sessions', 'kimi', vendorProjectHash(PROJECT_PATH));
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'meta', projectPath: PROJECT_PATH, sessionName: 'secret' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'my private prompt' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'private answer' } }),
    ];
    await fs.writeFile(path.join(dir, `${SESSION_ID}.jsonl`), `${lines.join('\n')}\n`);

    sessionsDb.createSession(SESSION_ID, 'kimi', PROJECT_PATH);
    // Production run-path ownership stamp: alice is the first (owner) participant.
    participantsDb.recordSpawn(SESSION_ID, ownerId);

    await runTest({ ownerId, outsiderId });
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHome;
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('B-105: owner reads their own session history', async () => {
  await withOwnedSession(async ({ ownerId }) => {
    const result = await sessionsService.fetchHistory(SESSION_ID, ownerId, { limit: 10, offset: 0 });
    assert.equal(result.total, 2, 'owner sees the full transcript');
    assert.equal(result.messages[0]?.content, 'my private prompt');
    assert.equal(result.messages[1]?.content, 'private answer');
  });
});

test("B-105: a different authenticated user is refused (404, no content leak)", async () => {
  await withOwnedSession(async ({ ownerId, outsiderId }) => {
    // The IDOR boundary lives on PRIVATE content: a session whose project is
    // private and whose caller is neither participant nor project member must
    // never disclose another user's conversation. (createSession auto-registers
    // the project as PUBLIC, which would legitimately admit any authenticated
    // caller — not the boundary under test here — so flip it private first. The
    // upsert on the same path returns the existing auto-created row.)
    const { project } = projectsDb.createProjectPath(PROJECT_PATH, 'Secret Proj', ownerId);
    assert.ok(project, 'project row exists for the session path');
    projectsDb.setProjectVisibility(project.project_id, 'private');

    await assert.rejects(
      () => sessionsService.fetchHistory(SESSION_ID, outsiderId, { limit: 10, offset: 0 }),
      (err: unknown) => {
        const e = err as { statusCode?: number; code?: string };
        assert.equal(e.statusCode, 404, 'outsider gets 404, not the messages');
        assert.equal(e.code, 'SESSION_NOT_FOUND', 'same contract as a missing session (no existence disclosure)');
        return true;
      },
      'an authenticated non-participant of a private project must NOT receive another user\'s conversation',
    );
  });
});

test('B-105: an unauthenticated/unresolved caller (null) is refused', async () => {
  await withOwnedSession(async () => {
    await assert.rejects(
      () => sessionsService.fetchHistory(SESSION_ID, null, { limit: 10, offset: 0 }),
      (err: unknown) => {
        const e = err as { statusCode?: number; code?: string };
        assert.equal(e.statusCode, 404);
        assert.equal(e.code, 'SESSION_NOT_FOUND');
        return true;
      },
    );
  });
});

test('B-105: a message author (no participant row) is allowed — second half of the access model', async () => {
  await withOwnedSession(async () => {
    // A user who never spawned (no session_participants row) but authored a
    // message in the session is part of the access model and must pass.
    const authorId = userDb.createUser('carol', 'hash-c', 'user').id;
    messageAuthorsDb.recordUserMessage(SESSION_ID, authorId, 'my private prompt');

    const result = await sessionsService.fetchHistory(SESSION_ID, authorId, { limit: 10, offset: 0 });
    assert.equal(result.total, 2, 'recorded author reads the session');
  });
});

test('B-105: isParticipant predicate is fail-closed for a non-member and rejects non-integer ids', async () => {
  await withOwnedSession(async ({ ownerId, outsiderId }) => {
    assert.equal(participantsDb.isParticipant(SESSION_ID, ownerId), true, 'owner is a participant');
    assert.equal(participantsDb.isParticipant(SESSION_ID, outsiderId), false, 'outsider is not');
    assert.equal(participantsDb.isParticipant(SESSION_ID, Number.NaN), false, 'NaN matches nothing');
    assert.equal(participantsDb.isParticipant('no-such-session', ownerId), false, 'unknown session matches nothing');
  });
});

// ---------------------------------------------------------------------------
// B-111: align the content gate with the sidebar list gate. The B-105 fix gated
// reads on session participation ALONE, which over-blocked: a session whose
// project is public or shared with the caller is listed in the sidebar (the list
// layer uses project visibility) yet its content returned 404. fetchHistory now
// also admits a caller who can SEE the session's project, using the same
// predicate the list layer uses. These scenarios register a real project row for
// PROJECT_PATH (the fixture only creates the session + owner participant) so
// project visibility is exercised end to end.
// ---------------------------------------------------------------------------

test('B-111: a project MEMBER who never participated reads a session in a PRIVATE project', async () => {
  await withOwnedSession(async ({ ownerId, outsiderId }) => {
    // Owner's session lives in a private project; `outsiderId` is NOT a session
    // participant but IS added as an explicit project member (read access).
    const { project } = projectsDb.createProjectPath(PROJECT_PATH, 'Secret Proj', ownerId);
    assert.ok(project, 'project row created for the session path');
    projectsDb.setProjectVisibility(project.project_id, 'private');
    projectMembersDb.add(project.project_id, outsiderId, 'member', ownerId);

    // Pre-condition: the member is genuinely not a session participant, so the
    // old participant-only gate would have refused (404).
    assert.equal(
      participantsDb.isParticipant(SESSION_ID, outsiderId),
      false,
      'member is not a session participant — proves the new branch (not participation) grants access',
    );

    const result = await sessionsService.fetchHistory(SESSION_ID, outsiderId, { limit: 10, offset: 0 });
    assert.equal(result.total, 2, 'project member now reads the session content');
    assert.equal(result.messages[0]?.content, 'my private prompt');
  });
});

test('B-111: any authenticated user reads a session in a PUBLIC project', async () => {
  await withOwnedSession(async ({ ownerId, outsiderId }) => {
    const { project } = projectsDb.createProjectPath(PROJECT_PATH, 'Open Proj', ownerId);
    assert.ok(project);
    projectsDb.setProjectVisibility(project.project_id, 'public');

    // Outsider is neither a participant nor a member — only project visibility
    // (public) grants the read.
    assert.equal(participantsDb.isParticipant(SESSION_ID, outsiderId), false);

    const result = await sessionsService.fetchHistory(SESSION_ID, outsiderId, { limit: 10, offset: 0 });
    assert.equal(result.total, 2, 'public-project session is readable by any authenticated user');
  });
});

test('B-111: a non-member is still refused (404) for a session in a PRIVATE project — IDOR stays closed', async () => {
  await withOwnedSession(async ({ ownerId, outsiderId }) => {
    // Private project, outsider is NOT a member and NOT a participant: the
    // B-105 IDOR fix must still hold — widening to project visibility must not
    // reopen cross-user reads of private content.
    const { project } = projectsDb.createProjectPath(PROJECT_PATH, 'Secret Proj', ownerId);
    assert.ok(project);
    projectsDb.setProjectVisibility(project.project_id, 'private');

    assert.equal(
      projectsDb.isProjectPathVisibleToUser(PROJECT_PATH, outsiderId),
      false,
      'private project is NOT visible to the non-member — the gate primitive itself refuses',
    );

    await assert.rejects(
      () => sessionsService.fetchHistory(SESSION_ID, outsiderId, { limit: 10, offset: 0 }),
      (err: unknown) => {
        const e = err as { statusCode?: number; code?: string };
        assert.equal(e.statusCode, 404, 'non-member of a private project still gets 404');
        assert.equal(e.code, 'SESSION_NOT_FOUND', 'same contract — no existence disclosure');
        return true;
      },
      'widening to project visibility must NOT reopen the B-105 IDOR for private projects',
    );
  });
});

test('B-111: an unauthenticated (null) caller is refused even when the project is PUBLIC', async () => {
  await withOwnedSession(async ({ ownerId }) => {
    const { project } = projectsDb.createProjectPath(PROJECT_PATH, 'Open Proj', ownerId);
    assert.ok(project);
    projectsDb.setProjectVisibility(project.project_id, 'public');

    // Even a public project must not be readable by an unidentified caller via
    // this endpoint: the null short-circuit runs before any visibility check.
    await assert.rejects(
      () => sessionsService.fetchHistory(SESSION_ID, null, { limit: 10, offset: 0 }),
      (err: unknown) => {
        const e = err as { statusCode?: number; code?: string };
        assert.equal(e.statusCode, 404);
        assert.equal(e.code, 'SESSION_NOT_FOUND');
        return true;
      },
    );
  });
});
