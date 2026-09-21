/**
 * The `projects_updated` broadcast is per-recipient, not anonymous (B-825).
 *
 * The bug this pins: the watcher flush built ONE payload with no requester, so
 * every session row in it carried `starred: false` and every project's first
 * session page was paged by date alone — losing the hoisting that puts a user's
 * favourites on page 1. The send loop then re-stamped only `isMember`/`isOwner`,
 * so the frame overwrote each client's correct pin state on every transcript
 * write anywhere on the server. Pins went hollow and re-sorted by date the
 * moment the owner switched projects.
 *
 * So the assertion is deliberately not "starred is true": it is that two
 * sockets logged in as two different users receive DIFFERENT frames, each one
 * carrying that user's own favourites — hoisted onto page 1 and flagged. A
 * shared frame cannot satisfy both halves at once, which is the only property
 * that mattered.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  participantsDb,
  projectsDb,
  sessionsDb,
  starredSessionsDb,
  stopReconcileScheduler,
  userDb,
} from '@/modules/database/index.js';
import { notifySessionMetadataChanged } from '@/modules/providers/services/sessions-watcher.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

const PROJECT_PATH = '/workspace/b825-starred-scope';
/** One more than DEFAULT_PROJECT_SESSIONS_PAGE_SIZE, so the oldest rows fall off page 1. */
const SESSION_COUNT = 25;
const OLDEST_SESSION_ID = 'b825-session-00';
const IN_PAGE_SESSION_ID = 'b825-session-05';
const BROADCAST_TIMEOUT_MS = 5_000;

type CapturedFrame = { projects: Array<Record<string, unknown>> };

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'b825-starred-scope-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase();
  stopReconcileScheduler();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * 25 conversations, oldest first. `b825-session-00` is the oldest, so it ranks
 * 25th by date and only reaches page 1 for a user who starred it.
 */
function seedProjectSessions(ownerUserId: number): void {
  projectsDb.createProjectPath(PROJECT_PATH, null, ownerUserId);

  for (let index = 0; index < SESSION_COUNT; index += 1) {
    const sessionId = `b825-session-${String(index).padStart(2, '0')}`;
    const createdAt = new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
    sessionsDb.createSession(sessionId, 'claude', PROJECT_PATH, undefined, createdAt, createdAt);
    // The participant row is what the B-29 native filter looks for; without it
    // every session is correctly hidden and this test would pass for the wrong
    // reason.
    participantsDb.recordSpawn(sessionId, ownerUserId, { role: 'owner' });
  }
}

/**
 * A fake open socket that records the `projects_updated` frames handed to it.
 * `loading_progress` frames share this channel and are deliberately ignored, so
 * a missing broadcast fails on the timeout rather than on a progress frame.
 */
function connectFakeClient(userId: number): { client: RealtimeClientConnection; frames: string[] } {
  const frames: string[] = [];
  const client: RealtimeClientConnection = {
    readyState: WS_OPEN_STATE,
    userId,
    send(data: string) {
      if ((JSON.parse(data) as { type?: string }).type === 'projects_updated') {
        frames.push(data);
      }
    },
  };
  connectedClients.add(client);
  return { client, frames };
}

/** Waits for the watcher's debounced flush to deliver one frame to every socket. */
async function waitForFrames(...frameLists: string[][]): Promise<void> {
  const deadline = Date.now() + BROADCAST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (frameLists.every((frames) => frames.length > 0)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the watcher flush never broadcast projects_updated');
}

function readSeededProject(frame: string): Record<string, unknown> {
  const payload = JSON.parse(frame) as CapturedFrame;
  const project = payload.projects.find((candidate) => candidate.fullPath === PROJECT_PATH);
  assert.ok(project, 'the seeded project must be in the broadcast frame');
  return project;
}

function readSessions(project: Record<string, unknown>): Array<{ id: string; starred?: boolean }> {
  const sessions = project.sessions as Array<{ id: string; starred?: boolean }> | undefined;
  assert.ok(Array.isArray(sessions), 'the claude bucket must be present');
  return sessions;
}

test('B-825: projects_updated carries each recipient its own starred sessions', async () => {
  await withIsolatedDatabase(async () => {
    const stamp = Date.now();
    const pinnerId = userDb.createUser(`b825_pinner_${stamp}`, 'hash', 'user').id;
    const otherId = userDb.createUser(`b825_other_${stamp}`, 'hash', 'user').id;

    seedProjectSessions(pinnerId);
    // The pinner favours the OLDEST conversation: hoisting is the only thing
    // that can put it on page 1.
    starredSessionsDb.setStarred(pinnerId, OLDEST_SESSION_ID, true, PROJECT_PATH);
    // The other user favours a conversation that is on page 1 by date anyway,
    // so the two users disagree about both rows.
    starredSessionsDb.setStarred(otherId, IN_PAGE_SESSION_ID, true, PROJECT_PATH);

    const pinner = connectFakeClient(pinnerId);
    const other = connectFakeClient(otherId);

    try {
      notifySessionMetadataChanged('claude', IN_PAGE_SESSION_ID);
      await waitForFrames(pinner.frames, other.frames);

      const pinnerProject = readSeededProject(pinner.frames[0]);
      const pinnerSessions = readSessions(pinnerProject);
      const pinnedRow = pinnerSessions.find((session) => session.id === OLDEST_SESSION_ID);
      assert.ok(pinnedRow, 'the pinned conversation must survive the broadcast page');
      assert.equal(pinnedRow.starred, true, 'the broadcast must not blank the pin');
      assert.equal(pinnerSessions[0]?.id, OLDEST_SESSION_ID, 'a favourite leads page 1');
      assert.equal(
        pinnerSessions.find((session) => session.id === IN_PAGE_SESSION_ID)?.starred,
        false,
        "another user's favourite must not leak into this frame",
      );
      assert.equal(pinnerProject.isMember, true, 'per-user membership must survive the rewrite');

      const otherProject = readSeededProject(other.frames[0]);
      const otherSessions = readSessions(otherProject);
      assert.equal(otherSessions[0]?.id, IN_PAGE_SESSION_ID, "the other user's own favourite leads");
      assert.equal(otherSessions[0]?.starred, true);
      assert.equal(
        otherSessions.find((session) => session.id === OLDEST_SESSION_ID),
        undefined,
        'a conversation nobody here pinned stays off page 1',
      );
      assert.equal(otherProject.isMember, false, 'a non-participant is still not a member');

      assert.notEqual(
        pinner.frames[0],
        other.frames[0],
        'one shared frame cannot be correct for two different users',
      );
    } finally {
      connectedClients.delete(pinner.client);
      connectedClients.delete(other.client);
    }
  });
});
