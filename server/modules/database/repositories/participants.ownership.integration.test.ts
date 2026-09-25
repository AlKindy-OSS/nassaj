/**
 * Session ownership & attribution contract (ADR-104, B-476/B-477, T-1265).
 *
 * There was no test for ownership attribution at all before this file, on a
 * table that gates `restamp`, project file writes and cost — which is why a
 * boot-time backfill could hand the platform owner authority over 93 members'
 * sessions for 120 restarts without a single red build.
 *
 * The five proofs demanded as a merge condition by the review of this plan:
 *
 *   1. RACE      — a provenance write landing FIRST does not cost the real
 *                  spawner the owner badge (the opencode ordering, B-477).
 *   2. BACKFILL  — running the migration twice never mints a second owner, and
 *                  never touches a session that already has a human (B-476).
 *   3. TUI       — an externally-created session with no spawn keeps its
 *                  inferred owner and stays visible (protects T-857).
 *   4. NO GRANT  — an inferred row grants NOTHING: not participation, not
 *                  restamp, not project write, not session scope.
 *   5. NO HIDE   — an inferred row is still COUNTED where absence would erase
 *                  data: list visibility and the cost owner.
 *
 * 4 and 5 are the pair that matters. Either one alone is satisfiable by a wrong
 * implementation: filter everything and 87 conversations vanish from the UI with
 * their bill; filter nothing and the authority leak survives untouched.
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
  participantsDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { isSessionAccessibleByUser } from '@/modules/providers/index.js';

const PROJECT_PATH = '/workspace/ownership';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'participants-own-'));
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
function makeUser(role: 'owner' | 'admin' | 'user' = 'user'): number {
  seq += 1;
  return userDb.createUser(`u_${seq}_${Date.now()}`, 'hash', role).id;
}

function makeSession(sessionId: string, provider = 'opencode'): void {
  sessionsDb.createSession(sessionId, provider, PROJECT_PATH);
}

/** The row as stored, so a test can assert on role AND attribution together. */
function readRow(sessionId: string, userId: number) {
  return getConnection()
    .prepare(
      `SELECT role, attribution, message_count AS messageCount
       FROM session_participants WHERE session_id = ? AND user_id = ?`
    )
    .get(sessionId, userId) as
    | { role: string; attribution: string; messageCount: number }
    | undefined;
}

/** True when the session is listed by the native-session (visibility) predicate. */
function isListed(sessionId: string): boolean {
  const row = getConnection()
    .prepare(
      `SELECT 1 AS ok FROM sessions
       WHERE session_id = ?
         AND (
           EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id = sessions.session_id)
           OR EXISTS (SELECT 1 FROM message_authors ma WHERE ma.session_id = sessions.session_id)
         )`
    )
    .get(sessionId) as { ok: number } | undefined;
  return row !== undefined;
}

test('strict spawn-owner resolution has no provenance or missing-owner fallback', async () => {
  await withIsolatedDatabase(() => {
    const spawnOwner = makeUser();
    const inferredOwner = makeUser();
    makeSession('strict-spawn');
    makeSession('strict-provenance');
    makeSession('strict-empty');
    participantsDb.recordSpawn('strict-spawn', spawnOwner, { provider: 'opencode', projectPath: PROJECT_PATH });
    participantsDb.recordSpawn('strict-provenance', inferredOwner, {
      provider: 'opencode', projectPath: PROJECT_PATH, attribution: 'provenance',
    });

    assert.equal(participantsDb.resolveStrictSpawnOwnerUserId('strict-spawn'), spawnOwner);
    assert.equal(participantsDb.resolveStrictSpawnOwnerUserId('strict-provenance'), null);
    assert.equal(participantsDb.resolveStrictSpawnOwnerUserId('strict-empty'), null);
    assert.equal(participantsDb.resolveStrictSpawnOwnerUserId(''), null);
  });
});

test('1 — a provenance write landing first does not steal the owner badge (B-477)', async () => {
  await withIsolatedDatabase(() => {
    const platformOwner = makeUser('owner');
    const member = makeUser();
    makeSession('race-1');

    // The exact production ordering: opencode commits the session to its own DB,
    // the synchronizer sees it and attributes the shared data dir to the platform
    // owner — all BEFORE the CLI prints the id the spawn path is waiting for.
    participantsDb.recordSpawn('race-1', platformOwner, {
      provider: 'opencode',
      projectPath: PROJECT_PATH,
      attribution: 'provenance',
    });
    assert.equal(readRow('race-1', platformOwner)?.role, 'owner');

    // ...then the real human's spawn arrives two seconds later.
    participantsDb.recordSpawn('race-1', member, {
      provider: 'opencode',
      projectPath: PROJECT_PATH,
    });

    assert.equal(readRow('race-1', member)?.role, 'owner', 'the human who spawned it owns it');
    assert.equal(readRow('race-1', member)?.attribution, 'spawn');
    assert.equal(
      readRow('race-1', platformOwner)?.role,
      'participant',
      'the inferred row gives up the badge'
    );
    assert.equal(readRow('race-1', platformOwner)?.attribution, 'provenance');
  });
});

test('1b — attribution ratchets: a rescan cannot revoke consent already granted', async () => {
  await withIsolatedDatabase(() => {
    const member = makeUser();
    makeSession('ratchet-1');

    participantsDb.recordSpawn('ratchet-1', member, {
      provider: 'opencode',
      projectPath: PROJECT_PATH,
    });
    // A later background pass on the same row must not downgrade it.
    participantsDb.recordSpawn('ratchet-1', member, {
      provider: 'opencode',
      projectPath: PROJECT_PATH,
      attribution: 'provenance',
    });

    assert.equal(readRow('ratchet-1', member)?.attribution, 'spawn');

    // ...and the reverse direction DOES promote: the human showed up after all.
    makeSession('ratchet-2');
    participantsDb.recordSpawn('ratchet-2', member, {
      provider: 'opencode',
      projectPath: PROJECT_PATH,
      attribution: 'provenance',
    });
    participantsDb.recordSpawn('ratchet-2', member, {
      provider: 'opencode',
      projectPath: PROJECT_PATH,
    });
    assert.equal(readRow('ratchet-2', member)?.attribution, 'spawn');
  });
});

test('2 — the backfill never mints a second owner, however many times it runs (B-476)', async () => {
  await withIsolatedDatabase(async () => {
    const platformOwner = makeUser('owner');
    const member = makeUser();
    makeSession('backfill-1', 'claude');

    // A session genuinely owned by a member, exactly as the run path leaves it.
    participantsDb.recordSpawn('backfill-1', member, {
      provider: 'claude',
      projectPath: PROJECT_PATH,
    });

    // Re-run every migration twice more — the production failure was that this
    // is what a restart does, and each pass added one more owner row.
    await initializeDatabase();
    await initializeDatabase();

    const owners = getConnection()
      .prepare(
        `SELECT user_id AS userId FROM session_participants
         WHERE session_id = ? AND role = 'owner'`
      )
      .all('backfill-1') as Array<{ userId: number }>;

    assert.deepEqual(
      owners.map((o) => o.userId),
      [member],
      'the member still owns it alone'
    );
    assert.equal(
      readRow('backfill-1', platformOwner),
      undefined,
      'the platform owner was never added to a session that already had a human'
    );
  });
});

test('3 — an externally created session keeps its inferred owner and stays visible (T-857)', async () => {
  await withIsolatedDatabase(() => {
    const platformOwner = makeUser('owner');
    makeSession('tui-1');

    // No spawn ever happens for a TUI session; provenance is all there is.
    participantsDb.recordSpawn('tui-1', platformOwner, {
      provider: 'opencode',
      projectPath: PROJECT_PATH,
      attribution: 'provenance',
    });

    assert.equal(readRow('tui-1', platformOwner)?.role, 'owner', 'sole row keeps the badge');
    assert.equal(isListed('tui-1'), true, 'and the conversation is still listed');
    assert.deepEqual(
      participantsDb.getOwnersBySessionIds(['tui-1']).map((r) => r.userId),
      [platformOwner],
      'the owner badge still names the data dir it came from'
    );
  });
});

test('4 — an inferred row grants nothing: participation, restamp, project write, scope', async () => {
  await withIsolatedDatabase(() => {
    const platformOwner = makeUser('owner');
    const member = makeUser();
    // created_by is a THIRD user, so the write gate can only be reached through
    // session participation — the arm this test is about.
    projectsDb.createProjectPath(PROJECT_PATH, 'ownership', makeUser());
    makeSession('grant-1', 'claude');

    participantsDb.recordSpawn('grant-1', member, {
      provider: 'claude',
      projectPath: PROJECT_PATH,
    });
    // The inferred row for somebody who never joined this conversation.
    participantsDb.recordSpawn('grant-1', platformOwner, {
      provider: 'claude',
      projectPath: PROJECT_PATH,
      attribution: 'provenance',
    });

    assert.equal(
      participantsDb.isParticipant('grant-1', platformOwner),
      false,
      'not a participant'
    );
    assert.equal(
      isSessionAccessibleByUser('grant-1', PROJECT_PATH, platformOwner, 'restamp'),
      false,
      'cannot re-stamp another member’s conversation'
    );

    const project = projectsDb.getProjectPath(PROJECT_PATH);
    assert.ok(project);
    assert.equal(
      projectsDb.isProjectWritableByUser(project.project_id, platformOwner),
      false,
      'cannot write the project files through a session they never joined'
    );
    assert.equal(
      participantsDb.getSessionIdsForUser(platformOwner).includes('grant-1'),
      false,
      'the session is outside their agent/workflow/cost scope'
    );

    // ...while the real participant keeps every one of those.
    assert.equal(participantsDb.isParticipant('grant-1', member), true);
    assert.equal(isSessionAccessibleByUser('grant-1', PROJECT_PATH, member, 'restamp'), true);
    assert.equal(participantsDb.getSessionIdsForUser(member).includes('grant-1'), true);
  });
});

test('5 — an inferred row is still counted where absence would erase data', async () => {
  await withIsolatedDatabase(() => {
    const platformOwner = makeUser('owner');
    makeSession('count-1');

    participantsDb.recordSpawn('count-1', platformOwner, {
      provider: 'opencode',
      projectPath: PROJECT_PATH,
      attribution: 'provenance',
    });

    assert.equal(isListed('count-1'), true, 'still passes the native-session predicate');

    const attribution = participantsDb.getSessionAttribution('count-1');
    assert.equal(
      attribution.ownerUserId,
      platformOwner,
      'still has a cost owner — a null here makes the per-user total come out under the bill'
    );

    assert.deepEqual(
      participantsDb.listBySession('count-1').map((r) => r.userId),
      [platformOwner],
      'and still appears in the participants bar'
    );
  });
});

test('6 — the single-owner index makes a duplicate owner unrepresentable', async () => {
  await withIsolatedDatabase(() => {
    const a = makeUser();
    const b = makeUser();
    makeSession('dup-1', 'claude');

    participantsDb.recordSpawn('dup-1', a, { provider: 'claude', projectPath: PROJECT_PATH });
    participantsDb.recordSpawn('dup-1', b, { provider: 'claude', projectPath: PROJECT_PATH });

    assert.throws(
      () =>
        getConnection()
          .prepare(
            `UPDATE session_participants SET role = 'owner' WHERE session_id = ? AND user_id = ?`
          )
          .run('dup-1', b),
      /UNIQUE constraint failed/,
      'a second owner row is rejected by the database itself'
    );
  });
});
