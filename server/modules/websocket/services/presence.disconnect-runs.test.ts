/**
 * presence.disconnect-runs.test.ts (B-289)
 *
 * The sidebar showed "0 active" in the presence badge while a conversation row
 * carried a green "Running" badge at the same moment.
 *
 * Root cause: `presenceDisconnect` deleted the whole user row when the LAST
 * socket closed — runs included. But a run outlives its browser socket (page
 * refresh, closed tab, network blip): the provider child keeps working and the
 * process monitor keeps polling it, so `process_state` still painted the badge
 * on the reopened conversation while presence had forgotten the run and
 * reported `total: 0` / `runningSessions: []`.
 *
 * This verifies both halves of the fix:
 *   - a socket-less row that still owns runs SURVIVES, keeping the run counted
 *     and listed, and is reclaimed by the user's next connect;
 *   - such a row does NOT appear in the `users` snapshot (the avatar stack) —
 *     the user is genuinely offline, only their work is still live;
 *   - a socket-less row with no runs is still dropped (old behaviour intact).
 *
 * The database repository is module-mocked, keeping this a pure unit test.
 * Runner: Node built-in test runner with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const SHARED_PROJECT = '/workspace/shared';

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getVisibleProjectPaths: () => [SHARED_PROJECT],
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});

const { connectedClients, WS_OPEN_STATE } = await import('./websocket-state.service.js');
const presence = await import('./presence.service.js');

type Captured = {
  type: string;
  users: Array<{ userId: string }>;
  runningSessions: Array<{ sessionId: string; state: string }>;
  activeConversations: { total: number };
};

function fakeClient(userId: number | null) {
  return {
    readyState: WS_OPEN_STATE,
    userId,
    last: null as Captured | null,
    send(raw: string) {
      this.last = JSON.parse(raw) as Captured;
    },
  };
}

/** Waits past the ~100ms broadcast debounce. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160));
}

test('a live run survives its owner disconnecting, without faking presence', async () => {
  connectedClients.clear();

  // The runner (user 1) and an observer (user 7) that stays connected so we keep
  // receiving snapshots after user 1 goes away.
  const runnerSocket = fakeClient(1);
  const observer = fakeClient(7);
  connectedClients.add(runnerSocket as never);
  connectedClients.add(observer as never);

  presence.presenceConnect(runnerSocket as never, { username: 'runner' } as never, 1);
  presence.presenceRunStarted({
    userId: 1,
    sessionId: 's-live',
    projectPath: SHARED_PROJECT,
  });
  await flush();

  assert.equal(observer.last?.activeConversations.total, 1, 'the run is counted while connected');
  assert.deepEqual(
    observer.last?.runningSessions.map((entry) => entry.sessionId),
    ['s-live'],
  );
  assert.ok(
    observer.last?.users.some((entry) => entry.userId === '1'),
    'the runner is online in the avatar stack',
  );

  // --- the browser goes away mid-run (refresh / closed tab / network blip) ----
  presence.presenceDisconnect(runnerSocket as never);
  connectedClients.delete(runnerSocket as never);
  await flush();

  assert.equal(
    observer.last?.activeConversations.total,
    1,
    'the run keeps counting after its socket closes — the child is still working',
  );
  assert.deepEqual(
    observer.last?.runningSessions.map((entry) => entry.sessionId),
    ['s-live'],
    'the Running badge stays fed by presence, matching the badge count',
  );
  assert.ok(
    !observer.last?.users.some((entry) => entry.userId === '1'),
    'a socket-less runner is NOT shown as online',
  );

  // --- reconnect reclaims the surviving row ----------------------------------
  const reopened = fakeClient(1);
  connectedClients.add(reopened as never);
  presence.presenceConnect(reopened as never, { username: 'runner' } as never, 1);
  await flush();

  assert.equal(observer.last?.activeConversations.total, 1, 'no double counting on reconnect');
  assert.ok(
    observer.last?.users.some((entry) => entry.userId === '1'),
    'the runner is online again',
  );

  // --- the run ends: row and count clear -------------------------------------
  presence.presenceRunStopped({ userId: 1, sessionId: 's-live' });
  await flush();
  assert.equal(observer.last?.activeConversations.total, 0);
  assert.deepEqual(observer.last?.runningSessions, []);

  connectedClients.clear();
});

test('a disconnecting user with no runs is dropped as before', async () => {
  connectedClients.clear();

  const idleSocket = fakeClient(2);
  const observer = fakeClient(7);
  connectedClients.add(idleSocket as never);
  connectedClients.add(observer as never);

  presence.presenceConnect(idleSocket as never, { username: 'idle' } as never, 2);
  await flush();
  assert.ok(observer.last?.users.some((entry) => entry.userId === '2'));

  presence.presenceDisconnect(idleSocket as never);
  connectedClients.delete(idleSocket as never);
  await flush();

  assert.ok(
    !observer.last?.users.some((entry) => entry.userId === '2'),
    'an idle user leaves presence entirely on disconnect',
  );
  assert.equal(observer.last?.activeConversations.total, 0);

  connectedClients.clear();
});
