/**
 * presence.active-conversations.test.ts
 *
 * Verifies the active-conversations detail broadcast alongside the presence
 * snapshot (server-derived, privacy-filtered per recipient):
 *
 *   - `total` is GLOBAL — every run of every user, regardless of visibility;
 *   - `byProject` lists ONLY projects visible to the recipient (B-PRIV);
 *   - a private project the recipient cannot see is counted in `hiddenCount`
 *     and its path NEVER appears in `byProject`;
 *   - runs with a null projectPath are also absorbed into `hiddenCount`;
 *   - the invariant `total === sum(byProject[*].count) + hiddenCount` holds;
 *   - `byProject` is ordered by count desc, then path asc.
 *
 * The database repository is module-mocked, keeping this a pure unit test.
 * Runner: Node built-in test runner with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// --- Module mock (must be registered before importing the service) -----------

const PUBLIC_PROJECT = '/workspace/public';
const SHARED_PROJECT = '/workspace/shared';
const PRIVATE_PROJECT = '/workspace/private';

// Recipient 7 sees the public + shared projects; recipient 9 also sees private.
// The anonymous (null) recipient sees only the public project.
function visiblePathsFor(userId: number | null): string[] {
  if (userId === 9) {
    return [PUBLIC_PROJECT, SHARED_PROJECT, PRIVATE_PROJECT];
  }
  if (userId === 7) {
    return [PUBLIC_PROJECT, SHARED_PROJECT];
  }
  return [PUBLIC_PROJECT];
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

const { connectedClients, WS_OPEN_STATE } = await import(
  './websocket-state.service.js'
);
const presence = await import('./presence.service.js');

type Captured = { type: string; activeConversations: ActiveConv; users: unknown[] };
type ActiveConv = {
  total: number;
  byProject: Array<{ projectPath: string; count: number }>;
  hiddenCount: number;
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

/** Forces the debounced broadcast to flush and yields the captured payloads. */
async function flush(): Promise<void> {
  // The broadcast is debounced ~100ms; wait past it deterministically.
  await new Promise((resolve) => setTimeout(resolve, 160));
}

test('byProject is recipient-filtered; hidden runs land in hiddenCount; total is global', async () => {
  connectedClients.clear();

  // Seed runs across three users in four distinct buckets:
  //  - two runs in the SHARED project (visible to 7 and 9)
  //  - one run in the PRIVATE project (visible to 9 only)
  //  - one run with NO project path (always hidden)
  presence.presenceRunStarted({
    userId: 1,
    sessionId: 's-shared-a',
    projectPath: SHARED_PROJECT,
  });
  presence.presenceRunStarted({
    userId: 2,
    sessionId: 's-shared-b',
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

  const recipient7 = fakeClient(7); // cannot see PRIVATE
  const recipient9 = fakeClient(9); // can see PRIVATE
  const anon = fakeClient(null); // sees only PUBLIC
  connectedClients.add(recipient7 as never);
  connectedClients.add(recipient9 as never);
  connectedClients.add(anon as never);

  // Trigger one more change so a broadcast is scheduled, then flush.
  presence.presenceRunStarted({
    userId: 1,
    sessionId: 's-shared-a',
    projectPath: SHARED_PROJECT,
  });
  await flush();

  const TOTAL = 4; // global run count, independent of visibility

  // --- Recipient 7: sees SHARED only; PRIVATE + null-path are hidden ---------
  const ac7 = recipient7.last?.activeConversations as ActiveConv;
  assert.ok(ac7, 'recipient 7 received activeConversations');
  assert.equal(ac7.total, TOTAL);
  assert.deepEqual(ac7.byProject, [{ projectPath: SHARED_PROJECT, count: 2 }]);
  // PRIVATE path must NEVER leak to a recipient who cannot see it.
  assert.ok(
    !ac7.byProject.some((e) => e.projectPath === PRIVATE_PROJECT),
    'private project path must not leak to recipient 7',
  );
  // hidden = PRIVATE run (1) + null-path run (1)
  assert.equal(ac7.hiddenCount, 2);
  assert.equal(
    ac7.total,
    ac7.byProject.reduce((s, e) => s + e.count, 0) + ac7.hiddenCount,
    'invariant total === sum(byProject) + hiddenCount (recipient 7)',
  );

  // --- Recipient 9: also sees PRIVATE; only the null-path run is hidden ------
  const ac9 = recipient9.last?.activeConversations as ActiveConv;
  assert.ok(ac9, 'recipient 9 received activeConversations');
  assert.equal(ac9.total, TOTAL);
  // Ordered by count desc, then path asc: SHARED(2) before PRIVATE(1).
  assert.deepEqual(ac9.byProject, [
    { projectPath: SHARED_PROJECT, count: 2 },
    { projectPath: PRIVATE_PROJECT, count: 1 },
  ]);
  assert.equal(ac9.hiddenCount, 1); // only the null-path run
  assert.equal(
    ac9.total,
    ac9.byProject.reduce((s, e) => s + e.count, 0) + ac9.hiddenCount,
    'invariant total === sum(byProject) + hiddenCount (recipient 9)',
  );

  // --- Anonymous recipient: sees only PUBLIC (no runs there) ----------------
  const acAnon = anon.last?.activeConversations as ActiveConv;
  assert.ok(acAnon, 'anonymous recipient received activeConversations');
  assert.equal(acAnon.total, TOTAL);
  assert.deepEqual(acAnon.byProject, []);
  assert.equal(acAnon.hiddenCount, TOTAL);

  // Cleanup so other test files start from a clean registry/state.
  presence.presenceRunStopped({ userId: 1, sessionId: 's-shared-a' });
  presence.presenceRunStopped({ userId: 2, sessionId: 's-shared-b' });
  presence.presenceRunStopped({ userId: 2, sessionId: 's-private' });
  presence.presenceRunStopped({ userId: 3, sessionId: 's-nopath' });
  connectedClients.clear();
});
