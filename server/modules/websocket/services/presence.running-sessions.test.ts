/**
 * presence.running-sessions.test.ts (B-269)
 *
 * The per-session "Running" badge used to be fed ONLY by the process monitor's
 * `process_state` payload, which WebSocketWriter delivers to a session's primary
 * socket and its registered read-only mirrors — and a mirror is registered when
 * the client opens that session. A sidebar therefore showed "5 active" in the
 * global presence badge while painting a Running badge on the one conversation
 * the user had open, and project busy dots never lit for other projects.
 *
 * Presence now carries a `runningSessions` list in every snapshot. This verifies:
 *
 *   - every live run reaches every recipient allowed to see it, whether or not
 *     that recipient has the session open;
 *   - B-PRIV: a run inside a project the recipient cannot see is OMITTED — its
 *     session id never reaches that client (while still being counted in
 *     `activeConversations.hiddenCount`, which this file re-asserts);
 *   - a run with no resolved project path is surfaced (no path to leak), the
 *     same rule buildSnapshot applies to the headline activity;
 *   - `presenceRunState` flips an entry to 'frozen' and back;
 *   - a re-register (second addSession / writer refresh) does NOT reset an
 *     already-observed 'frozen' back to 'running';
 *   - a stopped run disappears from the list.
 *
 * The database repository is module-mocked, keeping this a pure unit test.
 * Runner: Node built-in test runner with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const SHARED_PROJECT = '/workspace/shared';
const PRIVATE_PROJECT = '/workspace/private';

// Recipient 9 sees both projects; recipient 7 sees only the shared one.
function visiblePathsFor(userId: number | null): string[] {
  if (userId === 9) {
    return [SHARED_PROJECT, PRIVATE_PROJECT];
  }
  return [SHARED_PROJECT];
}

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getVisibleProjectPaths: (userId: number | null) => visiblePathsFor(userId),
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});

const { connectedClients, WS_OPEN_STATE } = await import('./websocket-state.service.js');
const presence = await import('./presence.service.js');

type RunningSession = { sessionId: string; state: 'running' | 'frozen' };
type Captured = {
  type: string;
  runningSessions: RunningSession[];
  activeConversations: { total: number; hiddenCount: number };
};

/** A fake open socket that records the last payload it was sent. */
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

/** Session ids in the last payload, for order-insensitive comparison. */
function idsOf(client: ReturnType<typeof fakeClient>): string[] {
  return (client.last?.runningSessions ?? []).map((entry) => entry.sessionId).sort();
}

test('runningSessions reaches every permitted recipient and is privacy-filtered', async () => {
  connectedClients.clear();

  const recipient7 = fakeClient(7); // cannot see PRIVATE
  const recipient9 = fakeClient(9); // can see PRIVATE
  connectedClients.add(recipient7 as never);
  connectedClients.add(recipient9 as never);

  presence.presenceRunStarted({
    userId: 1,
    sessionId: 's-shared',
    projectPath: SHARED_PROJECT,
  });
  presence.presenceRunStarted({
    userId: 2,
    sessionId: 's-private',
    projectPath: PRIVATE_PROJECT,
  });
  presence.presenceRunStarted({
    userId: 3,
    sessionId: 's-nopath',
    projectPath: null,
  });
  await flush();

  // Neither recipient has ANY session open (no mirrors registered anywhere) —
  // the whole point: the list arrives regardless.
  assert.deepEqual(
    idsOf(recipient7),
    ['s-nopath', 's-shared'],
    'recipient 7 learns about every run it may see, none of them opened',
  );
  assert.deepEqual(
    idsOf(recipient9),
    ['s-nopath', 's-private', 's-shared'],
    'recipient 9 additionally sees the private-project run',
  );
  assert.ok(
    !idsOf(recipient7).includes('s-private'),
    'a hidden project run must not leak its session id',
  );
  // The badge count itself is unaffected by the omission. Note the two lists
  // answer different questions and legitimately disagree on the null-path run:
  // `hiddenCount` counts it as hidden because it maps to no visible PROJECT ROW
  // (2 = s-private + s-nopath), while `runningSessions` still surfaces it —
  // there is no path to leak, and its badge should light like any other.
  assert.equal(recipient7.last?.activeConversations.total, 3);
  assert.equal(recipient7.last?.activeConversations.hiddenCount, 2);

  // Every entry starts as 'running'.
  assert.ok(
    (recipient9.last?.runningSessions ?? []).every((entry) => entry.state === 'running'),
    'runs start in the running state',
  );

  // --- frozen transition -----------------------------------------------------
  presence.presenceRunState({ userId: 1, sessionId: 's-shared', processState: 'frozen' });
  await flush();
  assert.deepEqual(
    recipient7.last?.runningSessions.find((e) => e.sessionId === 's-shared'),
    { sessionId: 's-shared', state: 'frozen' },
    'a frozen child is reported as frozen, not dropped',
  );

  // --- a re-register must not resurrect 'running' ----------------------------
  presence.presenceRunStarted({
    userId: 1,
    sessionId: 's-shared',
    projectPath: SHARED_PROJECT,
  });
  await flush();
  assert.equal(
    recipient7.last?.runningSessions.find((e) => e.sessionId === 's-shared')?.state,
    'frozen',
    're-registering a run keeps the monitor-observed frozen flag',
  );

  // --- back to running -------------------------------------------------------
  presence.presenceRunState({ userId: 1, sessionId: 's-shared', processState: 'running' });
  await flush();
  assert.equal(
    recipient7.last?.runningSessions.find((e) => e.sessionId === 's-shared')?.state,
    'running',
    'a resumed child returns to running',
  );

  // --- stopping a run removes it --------------------------------------------
  presence.presenceRunStopped({ userId: 1, sessionId: 's-shared' });
  await flush();
  assert.deepEqual(idsOf(recipient7), ['s-nopath'], 'a stopped run leaves the list');

  presence.presenceRunStopped({ userId: 2, sessionId: 's-private' });
  presence.presenceRunStopped({ userId: 3, sessionId: 's-nopath' });
  await flush();
  assert.deepEqual(idsOf(recipient9), [], 'the list empties with the last run');

  connectedClients.clear();
});

test('presenceRunState ignores unknown runs and invalid states', async () => {
  connectedClients.clear();
  const recipient = fakeClient(7);
  connectedClients.add(recipient as never);

  presence.presenceRunStarted({
    userId: 1,
    sessionId: 's-only',
    projectPath: SHARED_PROJECT,
  });
  await flush();

  // None of these may change anything (no crash, no state corruption).
  presence.presenceRunState({ userId: 1, sessionId: 'no-such-session', processState: 'frozen' });
  presence.presenceRunState({ userId: 99, sessionId: 's-only', processState: 'frozen' });
  presence.presenceRunState({ userId: 1, sessionId: 's-only', processState: 'idle' });
  presence.presenceRunState({ userId: null, sessionId: 's-only', processState: 'frozen' });
  await flush();

  assert.deepEqual(recipient.last?.runningSessions, [
    { sessionId: 's-only', state: 'running' },
  ]);

  presence.presenceRunStopped({ userId: 1, sessionId: 's-only' });
  connectedClients.clear();
});
