/**
 * ADR-053 / T-53-B2 — participantsDb.getSessionIdsForUser(userId).
 *
 * Per-user, set-based INVERSE of isParticipant (B-105 access model): the session
 * ids a user has access to as a participant/owner OR as a message author. This
 * is the ownership filter for the app-level workflow status endpoint, so its
 * fail-closed and no-cross-user-leak guarantees are load-bearing for isolation.
 *
 * Runs against a real migrated database (the query joins two real tables), using
 * the same isolated-db harness as the other repository tests.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { participantsDb } from '@/modules/database/repositories/participants.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'participants-sessionids-db-'));
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

// session_participants.session_id has a FK to sessions(session_id), so the
// parent session row must exist first. createSession also upserts the projects
// row (project_path FK), satisfying both constraints through the real repo.
function ensureSession(sessionId: string): void {
  sessionsDb.createSession(sessionId, 'claude', `/tmp/proj-${sessionId}`);
}

function insertParticipant(sessionId: string, userId: number, role: 'owner' | 'participant' = 'participant'): void {
  ensureSession(sessionId);
  getConnection()
    .prepare('INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, ?)')
    .run(sessionId, userId, role);
}

// message_authors has NO FK on session_id (by design — the session row may not
// exist yet), so an author can be recorded without a parent sessions row.
function insertAuthor(sessionId: string, userId: number): void {
  getConnection()
    .prepare('INSERT INTO message_authors (session_id, user_id, content_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, userId, `h-${sessionId}-${userId}`, new Date().toISOString());
}

test('fail-closed: a non-integer / unresolved userId matches nothing', async () => {
  await withIsolatedDatabase(() => {
    const u = userDb.createUser('u1', 'hash', 'user');
    insertParticipant('s-A', u.id, 'owner');

    // Non-integer inputs return [] without touching a real user's rows.
    assert.deepEqual(participantsDb.getSessionIdsForUser(NaN as unknown as number), []);
    assert.deepEqual(participantsDb.getSessionIdsForUser(1.5 as unknown as number), []);
    assert.deepEqual(participantsDb.getSessionIdsForUser('1' as unknown as number), []);
    assert.deepEqual(participantsDb.getSessionIdsForUser(null as unknown as number), []);
    assert.deepEqual(participantsDb.getSessionIdsForUser(undefined as unknown as number), []);
  });
});

test('returns the participant/owner AND message-author sessions (union of the access model)', async () => {
  await withIsolatedDatabase(() => {
    const u = userDb.createUser('u1', 'hash', 'user');
    insertParticipant('s-owner', u.id, 'owner');
    insertParticipant('s-part', u.id, 'participant');
    insertAuthor('s-authored', u.id); // author-only, no participant row

    const ids = participantsDb.getSessionIdsForUser(u.id).sort();
    assert.deepEqual(ids, ['s-authored', 's-owner', 's-part'], 'both branches contribute their sessions');
  });
});

test('de-duplicates a session the user both participates in AND authored', async () => {
  await withIsolatedDatabase(() => {
    const u = userDb.createUser('u1', 'hash', 'user');
    insertParticipant('s-both', u.id, 'owner');
    insertAuthor('s-both', u.id); // same session id in both tables

    const ids = participantsDb.getSessionIdsForUser(u.id);
    assert.deepEqual(ids, ['s-both'], 'the UNION collapses the duplicate to a single id');
  });
});

test('isolation: a different user never sees another user\'s sessions', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user');
    const bob = userDb.createUser('bob', 'hash', 'user');

    insertParticipant('s-alice-1', alice.id, 'owner');
    insertAuthor('s-alice-2', alice.id);
    insertParticipant('s-bob-1', bob.id, 'owner');

    const aliceIds = participantsDb.getSessionIdsForUser(alice.id).sort();
    const bobIds = participantsDb.getSessionIdsForUser(bob.id).sort();

    assert.deepEqual(aliceIds, ['s-alice-1', 's-alice-2'], 'alice sees only her own');
    assert.deepEqual(bobIds, ['s-bob-1'], 'bob sees only his own');
    assert.equal(bobIds.includes('s-alice-1'), false, 'no cross-user leakage into bob');
    assert.equal(bobIds.includes('s-alice-2'), false, 'no cross-user leakage into bob');
  });
});

test('a user with no sessions gets an empty list (not an error)', async () => {
  await withIsolatedDatabase(() => {
    const loner = userDb.createUser('loner', 'hash', 'user');
    assert.deepEqual(participantsDb.getSessionIdsForUser(loner.id), []);
  });
});
