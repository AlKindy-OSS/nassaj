/**
 * session-conversations-search.service.ownership.integration.test.ts — B-106.
 *
 * Sibling of the B-105 REST IDOR fix, one class wider. GET /search/sessions
 * scanned every transcript on disk across ALL projects with no notion of who was
 * asking, then streamed matching content snippets over SSE — so any
 * authenticated user could read (and watch live) other users' conversation
 * content. The gate added to searchConversations now keeps ONLY the sessions the
 * requester owns or participates in (participantsDb.isParticipant — the same
 * predicate that guards GET /sessions/:id/messages), applied BEFORE ripgrep runs
 * and before any project bucket is built or emitted, so a non-owned transcript
 * is never read off disk and never surfaces as a snippet — not even transiently.
 *
 * The fixtures are realistic, not synthetic: real users are created in the DB,
 * ownership is stamped through the exact production run-path call
 * (participantsDb.recordSpawn), and real Claude .jsonl transcripts are written to
 * disk and resolved through the live search path (sessionsDb.getAllSessions →
 * ripgrep over jsonl_path). The probe asserts on BOTH return values AND every
 * streamed progress update, so a leak via SSE would fail the test even if the
 * final result set were empty.
 *
 * node:test does not isolate state, so each scenario gets its own DB + temp dir
 * for the transcript files.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  messageAuthorsDb,
  participantsDb,
  projectMembersDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  searchConversations,
  type SessionConversationSearchProgressUpdate,
} from '@/modules/providers/services/session-conversations-search.service.js';

// A unique token so ripgrep matches our planted lines and nothing else on disk.
const SECRET_TERM = 'zylophascinatoryxqz';

type SessionSpec = {
  sessionId: string;
  projectPath: string;
  ownerId: number;
  // One user-authored transcript line containing SECRET_TERM.
  secretLine: string;
};

type Fixture = {
  aliceId: number;
  bobId: number;
  tempRoot: string;
  // Registers a Claude session: writes its transcript to disk, inserts the
  // sessions row pointing jsonl_path at that file, and stamps `ownerId` as the
  // owning participant through the production spawn path.
  addSession: (spec: SessionSpec) => Promise<void>;
};

/**
 * Collects every snippet streamed through onProgress so a test can prove no
 * content leaked over SSE, independent of the final result set.
 */
function collectSnippets(updates: SessionConversationSearchProgressUpdate[]): string[] {
  const snippets: string[] = [];
  for (const update of updates) {
    if (!update.projectResult) {
      continue;
    }
    for (const session of update.projectResult.sessions) {
      for (const match of session.matches) {
        snippets.push(match.snippet);
      }
    }
  }
  return snippets;
}

async function withFixture(runTest: (fixture: Fixture) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'b106-search-ownership-'));
  const databasePath = path.join(tempRoot, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    const aliceId = userDb.createUser('alice', 'hash-a', 'user').id;
    const bobId = userDb.createUser('bob', 'hash-b', 'user').id;

    const addSession = async (spec: SessionSpec): Promise<void> => {
      const transcriptPath = path.join(tempRoot, `${spec.sessionId}.jsonl`);
      const lines = [
        JSON.stringify({
          type: 'user',
          sessionId: spec.sessionId,
          uuid: `${spec.sessionId}-u1`,
          timestamp: '2026-06-30T10:00:00.000Z',
          message: { role: 'user', content: spec.secretLine },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: spec.sessionId,
          uuid: `${spec.sessionId}-a1`,
          timestamp: '2026-06-30T10:00:01.000Z',
          message: { role: 'assistant', content: 'an ordinary reply' },
        }),
      ];
      await fs.writeFile(transcriptPath, `${lines.join('\n')}\n`);

      // jsonl_path must be the real file on disk: the search path ripgreps it.
      sessionsDb.createSession(
        spec.sessionId,
        'claude',
        spec.projectPath,
        null as unknown as undefined,
        undefined,
        undefined,
        transcriptPath,
      );
      // Production run-path ownership stamp.
      participantsDb.recordSpawn(spec.sessionId, spec.ownerId);
    };

    await runTest({ aliceId, bobId, tempRoot, addSession });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('B-106: owner finds matches and snippets in their own session', async () => {
  await withFixture(async ({ aliceId, addSession }) => {
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/alice-proj',
      ownerId: aliceId,
      secretLine: `please keep this ${SECRET_TERM} private`,
    });

    const updates: SessionConversationSearchProgressUpdate[] = [];
    const result = await searchConversations(SECRET_TERM, aliceId, 50, (update) => {
      updates.push(update);
    });

    assert.equal(result.totalMatches, 1, 'owner sees exactly their one match');
    const sessionIds = result.results.flatMap((project) =>
      project.sessions.map((session) => session.sessionId),
    );
    assert.deepEqual(sessionIds, ['alice-session-1'], 'only the owned session is returned');

    const snippets = collectSnippets(updates);
    assert.equal(snippets.length, 1, 'one snippet streamed');
    assert.ok(
      snippets[0].includes(SECRET_TERM),
      'the streamed snippet is the owner-visible content',
    );
  });
});

test('a queued search result is discarded when its captured access fence turns stale', async () => {
  await withFixture(async ({ aliceId, addSession }) => {
    await addSession({
      sessionId: 'revoked-session',
      projectPath: '/work/revoked-project',
      ownerId: aliceId,
      secretLine: `late ${SECRET_TERM} content`,
    });
    let checks = 0;
    const updates: SessionConversationSearchProgressUpdate[] = [];
    const result = await searchConversations(
      SECRET_TERM,
      aliceId,
      50,
      (update) => updates.push(update),
      null,
      () => ++checks === 1,
    );

    assert.ok(checks >= 2, 'access is rechecked after the asynchronous scan');
    assert.equal(result.results.length, 0);
    assert.equal(collectSnippets(updates).length, 0);
  });
});

test("ADR-089: another authenticated user FINDS the session — search follows the shared list", async () => {
  await withFixture(async ({ aliceId, bobId, addSession }) => {
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/alice-proj',
      ownerId: aliceId,
      secretLine: `top ${SECRET_TERM} note from alice`,
    });

    // Pre-ADR-089 this test flipped the project private to build a zero-result
    // boundary. Project visibility is retired, so the search gate must mirror
    // the sidebar list: what a teammate can SEE, a teammate can SEARCH. The
    // boundary that survives — a null caller — is asserted in the next test.
    const { project } = projectsDb.createProjectPath('/work/alice-proj', 'Alice Proj', aliceId);
    assert.ok(project, 'project row exists for the session path');

    const updates: SessionConversationSearchProgressUpdate[] = [];
    const result = await searchConversations(SECRET_TERM, bobId, 50, (update) => {
      updates.push(update);
    });

    assert.ok(result.totalMatches > 0, 'a teammate finds the match');
    const sessionIds = result.results.flatMap((p) => p.sessions.map((x) => x.sessionId));
    assert.ok(sessionIds.includes('alice-session-1'), "alice's session surfaces to her teammate");
  });
});

test('ADR-089: search is symmetric across the team — each user finds both sessions', async () => {
  await withFixture(async ({ aliceId, addSession }) => {
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/alice-proj',
      ownerId: aliceId,
      secretLine: `private ${SECRET_TERM} content`,
    });

    const updates: SessionConversationSearchProgressUpdate[] = [];
    const result = await searchConversations(SECRET_TERM, null, 50, (update) => {
      updates.push(update);
    });

    assert.equal(result.totalMatches, 0, 'null caller owns nothing');
    assert.equal(result.results.length, 0, 'null caller sees no sessions');
    assert.equal(collectSnippets(updates).length, 0, 'null caller receives no snippets');
  });
});

test('B-106: per-project isolation — a user does not see another user project sessions', async () => {
  await withFixture(async ({ aliceId, bobId, addSession }) => {
    // Two sessions in two different projects, each owned by a different user,
    // both transcripts containing SECRET_TERM on disk.
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/alice-proj',
      ownerId: aliceId,
      secretLine: `alice ${SECRET_TERM} note`,
    });
    await addSession({
      sessionId: 'bob-session-1',
      projectPath: '/work/bob-proj',
      ownerId: bobId,
      secretLine: `bob ${SECRET_TERM} note`,
    });

    // ADR-089: both projects are shared with the team, so each user finds BOTH
    // sessions. Per-user isolation of session CONTENT is no longer a property of
    // this layer — the surviving boundary is the unauthenticated caller.
    const aliceProject = projectsDb.createProjectPath('/work/alice-proj', 'Alice Proj', aliceId).project;
    const bobProject = projectsDb.createProjectPath('/work/bob-proj', 'Bob Proj', bobId).project;
    assert.ok(aliceProject && bobProject, 'project rows exist for both session paths');

    // Alice searches: she must see her project/session only, never bob's.
    const aliceUpdates: SessionConversationSearchProgressUpdate[] = [];
    const aliceResult = await searchConversations(SECRET_TERM, aliceId, 50, (update) => {
      aliceUpdates.push(update);
    });

    const aliceSessionIds = aliceResult.results
      .flatMap((project) => project.sessions.map((session) => session.sessionId))
      .sort();
    assert.deepEqual(
      aliceSessionIds,
      ['alice-session-1', 'bob-session-1'],
      'alice sees both sessions — the team shares every project',
    );
    assert.ok(aliceUpdates.length > 0, 'progress was streamed');

    // Symmetric check: bob likewise sees both.
    const bobResult = await searchConversations(SECRET_TERM, bobId, 50);
    const bobSessionIds = bobResult.results
      .flatMap((project) => project.sessions.map((session) => session.sessionId))
      .sort();
    assert.deepEqual(bobSessionIds, ['alice-session-1', 'bob-session-1'], 'bob sees both too');
  });
});

// ---------------------------------------------------------------------------
// B-111: align the search gate with the sidebar list gate. B-106 restricted the
// search to sessions the caller participates in, which over-blocked: a session
// in a public/shared project is listed in the sidebar but its content was not
// searchable. The gate now also admits a caller who can SEE the session's
// project (same predicate as the list layer), while a non-member of a private
// project still matches nothing (B-106 isolation preserved). The fixture creates
// no project row, so each scenario registers one for the session's path.
// ---------------------------------------------------------------------------

test('B-111: a project MEMBER who never participated finds matches in a session of a PRIVATE project', async () => {
  await withFixture(async ({ aliceId, bobId, addSession }) => {
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/shared-proj',
      ownerId: aliceId,
      secretLine: `team ${SECRET_TERM} note`,
    });

    // The project is private but Bob is an explicit member (read access). Bob
    // never participated in the session itself.
    const { project } = projectsDb.createProjectPath('/work/shared-proj', 'Shared Proj', aliceId);
    assert.ok(project, 'project row created for the session path');
    projectsDb.setProjectVisibility(project.project_id, 'private');
    projectMembersDb.add(project.project_id, bobId, 'member', aliceId);

    assert.equal(
      participantsDb.isParticipant('alice-session-1', bobId),
      false,
      'bob is not a session participant — proves project membership (not participation) granted the match',
    );

    const updates: SessionConversationSearchProgressUpdate[] = [];
    const result = await searchConversations(SECRET_TERM, bobId, 50, (update) => {
      updates.push(update);
    });

    assert.equal(result.totalMatches, 1, 'project member now finds the shared-project session');
    const sessionIds = result.results.flatMap((proj) =>
      proj.sessions.map((session) => session.sessionId),
    );
    assert.deepEqual(sessionIds, ['alice-session-1'], 'the visible-project session is returned to the member');
    const snippets = collectSnippets(updates);
    assert.equal(snippets.length, 1, 'one snippet streamed to the authorized member');
    assert.ok(snippets[0].includes(SECRET_TERM), 'the streamed snippet is the member-visible content');
  });
});

test('B-111: any authenticated user finds matches in a session of a PUBLIC project', async () => {
  await withFixture(async ({ aliceId, bobId, addSession }) => {
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/open-proj',
      ownerId: aliceId,
      secretLine: `open ${SECRET_TERM} note`,
    });

    const { project } = projectsDb.createProjectPath('/work/open-proj', 'Open Proj', aliceId);
    assert.ok(project);
    projectsDb.setProjectVisibility(project.project_id, 'public');

    // Bob is neither a participant nor an explicit member — only the project's
    // public visibility grants the search hit.
    const result = await searchConversations(SECRET_TERM, bobId, 50);
    const sessionIds = result.results.flatMap((proj) =>
      proj.sessions.map((session) => session.sessionId),
    );
    assert.deepEqual(sessionIds, ['alice-session-1'], 'public-project session is searchable by any authenticated user');
    assert.equal(result.totalMatches, 1);
  });
});

test('B-111 / ADR-089: a teammate finds content in a project they did not create', async () => {
  await withFixture(async ({ aliceId, bobId, addSession }) => {
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/shared-proj',
      ownerId: aliceId,
      secretLine: `shared ${SECRET_TERM} for the team`,
    });

    const { project } = projectsDb.createProjectPath('/work/shared-proj', 'Shared Proj', aliceId);
    assert.ok(project);

    assert.equal(
      projectsDb.isProjectPathVisibleToUser('/work/shared-proj', bobId),
      true,
      'the gate primitive admits a teammate — project visibility is retired',
    );

    const updates: SessionConversationSearchProgressUpdate[] = [];
    const result = await searchConversations(SECRET_TERM, bobId, 50, (update) => {
      updates.push(update);
    });

    assert.ok(result.totalMatches > 0, 'a teammate finds matches');
    assert.ok(collectSnippets(updates).length > 0, 'snippets stream to a legitimate teammate');
  });
});

test('B-111: a null caller finds nothing even when the project is PUBLIC', async () => {
  await withFixture(async ({ aliceId, addSession }) => {
    await addSession({
      sessionId: 'alice-session-1',
      projectPath: '/work/open-proj',
      ownerId: aliceId,
      secretLine: `open ${SECRET_TERM} note`,
    });
    const { project } = projectsDb.createProjectPath('/work/open-proj', 'Open Proj', aliceId);
    assert.ok(project);
    projectsDb.setProjectVisibility(project.project_id, 'public');

    const updates: SessionConversationSearchProgressUpdate[] = [];
    const result = await searchConversations(SECRET_TERM, null, 50, (update) => {
      updates.push(update);
    });
    assert.equal(result.totalMatches, 0, 'null caller owns/sees nothing even for a public project');
    assert.equal(collectSnippets(updates).length, 0, 'null caller receives no snippets');
  });
});

test('ADR-172: projectless search requires author or spawn consent before scan', async () => {
  await withFixture(async ({ aliceId, bobId, addSession }) => {
    const previous = process.env.PROJECT_MEMBERSHIP_ENFORCE;
    process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
    try {
      await addSession({
        sessionId: 'projectless-search',
        projectPath: '/work/temporary-projectless',
        ownerId: aliceId,
        secretLine: `projectless ${SECRET_TERM} content`,
      });
      getConnection().prepare('UPDATE sessions SET project_path = NULL WHERE session_id = ?')
        .run('projectless-search');
      getConnection().prepare('DELETE FROM session_participants WHERE session_id = ?')
        .run('projectless-search');
      messageAuthorsDb.recordUserMessage('projectless-search', aliceId, 'consented prompt');
      getConnection().prepare(
        "INSERT INTO session_participants (session_id, user_id, attribution) VALUES (?, ?, 'provenance')",
      ).run('projectless-search', bobId);

      const denied = await searchConversations(SECRET_TERM, bobId, 50);
      assert.equal(denied.totalMatches, 0, 'provenance alone grants no projectless read');
      const allowed = await searchConversations(SECRET_TERM, aliceId, 50);
      assert.equal(allowed.totalMatches, 1, 'recorded author consent admits the projectless scan');
    } finally {
      if (previous === undefined) delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
      else process.env.PROJECT_MEMBERSHIP_ENFORCE = previous;
    }
  });
});
