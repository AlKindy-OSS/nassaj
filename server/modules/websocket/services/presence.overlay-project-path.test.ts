/**
 * presence.overlay-project-path.test.ts (B-861)
 *
 * The owner saw "4 active" beside ONLINE NOW while not a single sidebar row
 * carried an indicator. Cause: a session launched into a session overlay runs
 * with cwd `<repo>/.git/nassaj-session-overlays/instances/<id>/workspace`, and
 * every provider registers THAT path with presence. It is not a project path,
 * so the run was counted in `activeConversations.total`, pushed into
 * `hiddenCount` instead of `byProject`, and — the visible symptom — dropped
 * from `runningSessions`, so no client ever learned the session id and no row
 * could light up. Meanwhile the row itself was perfectly visible, filed under
 * the repository project.
 *
 * Presence now judges a run by `sessions.project_path` — the very column the
 * sidebar groups rows by — so the count and the row indicators agree by
 * construction. This verifies that, plus the untouched fallbacks: an unknown
 * session keeps its reported path, and a genuinely private run stays hidden.
 *
 * Runner: Node built-in test runner with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const REPO_PROJECT = '/workspace/repo';
const PRIVATE_PROJECT = '/workspace/private';
const OVERLAY_CWD = `${REPO_PROJECT}/.git/nassaj-session-overlays/instances/abc/workspace`;

/** Session rows exactly as the sidebar reads them. */
const sessionRows = new Map<string, { project_path: string }>([
  ['s-overlay', { project_path: REPO_PROJECT }],
  ['s-overlay-private', { project_path: PRIVATE_PROJECT }],
]);

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getVisibleProjectPaths: (userId: number | null) =>
        (userId === 9 ? [REPO_PROJECT, PRIVATE_PROJECT] : [REPO_PROJECT]),
    },
    sessionsDb: {
      getSessionById: (sessionId: string) => sessionRows.get(sessionId) ?? null,
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
  runningSessions: Array<{ sessionId: string; state: string }>;
  activeConversations: {
    total: number;
    hiddenCount: number;
    byProject: Array<{ projectPath: string; count: number }>;
  };
  users: Array<{ userId: string; activeProjectPath: string | null }>;
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

/** Drops every run this file registers, so one failure cannot poison the next. */
function resetRuns(): void {
  for (const sessionId of ['s-overlay', 's-overlay-private', 's-brand-new']) {
    presence.presenceRunStopped({ userId: 1, sessionId });
  }
  connectedClients.clear();
}

test('an overlay run is surfaced under the project its sidebar row lives in', async () => {
  resetRuns();
  const recipient = fakeClient(7);
  connectedClients.add(recipient as never);
  // The runner's own socket, so the snapshot carries a user row to inspect.
  presence.presenceConnect(recipient as never, { username: 'runner' } as never, 1);

  presence.presenceRunStarted({
    userId: 1,
    sessionId: 's-overlay',
    projectPath: OVERLAY_CWD,
  });
  await flush();

  assert.deepEqual(
    recipient.last?.runningSessions,
    [{ sessionId: 's-overlay', state: 'running' }],
    'the session id must reach the client, or its row can never light up',
  );
  assert.equal(recipient.last?.activeConversations.total, 1);
  assert.equal(
    recipient.last?.activeConversations.hiddenCount,
    0,
    'a run whose row the user can see is not "elsewhere"',
  );
  assert.deepEqual(recipient.last?.activeConversations.byProject, [
    { projectPath: REPO_PROJECT, count: 1 },
  ]);
  assert.equal(
    recipient.last?.users[0]?.activeProjectPath,
    REPO_PROJECT,
    'the presence panel names the project, not the overlay directory',
  );

  resetRuns();
});

test('an overlay run in a project the recipient cannot see stays hidden', async () => {
  resetRuns();
  const outsider = fakeClient(7);
  const member = fakeClient(9);
  connectedClients.add(outsider as never);
  connectedClients.add(member as never);

  presence.presenceRunStarted({
    userId: 1,
    sessionId: 's-overlay-private',
    projectPath: OVERLAY_CWD,
  });
  await flush();

  assert.deepEqual(
    outsider.last?.runningSessions,
    [],
    'resolving through the row must not widen visibility',
  );
  assert.equal(outsider.last?.activeConversations.total, 1);
  assert.equal(
    outsider.last?.activeConversations.hiddenCount,
    1,
    'the count stays honest: it is explained as "elsewhere"',
  );
  assert.deepEqual(member.last?.runningSessions, [
    { sessionId: 's-overlay-private', state: 'running' },
  ]);

  resetRuns();
});

test('a run with no session row yet keeps its reported path', async () => {
  resetRuns();
  const recipient = fakeClient(7);
  connectedClients.add(recipient as never);

  presence.presenceRunStarted({
    userId: 1,
    sessionId: 's-brand-new',
    projectPath: REPO_PROJECT,
  });
  await flush();

  assert.deepEqual(recipient.last?.runningSessions, [
    { sessionId: 's-brand-new', state: 'running' },
  ]);
  assert.deepEqual(recipient.last?.activeConversations.byProject, [
    { projectPath: REPO_PROJECT, count: 1 },
  ]);

  // The row appears a moment later; the next snapshot must pick it up rather
  // than stay stuck on the launch-time guess.
  sessionRows.set('s-brand-new', { project_path: PRIVATE_PROJECT });
  presence.presenceRunState({ userId: 1, sessionId: 's-brand-new', processState: 'frozen' });
  await flush();

  assert.deepEqual(
    recipient.last?.runningSessions,
    [],
    'once the row exists it is the authority on visibility',
  );

  sessionRows.delete('s-brand-new');
  resetRuns();
});
