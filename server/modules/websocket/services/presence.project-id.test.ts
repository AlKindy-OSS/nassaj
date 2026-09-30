/**
 * presence.project-id.test.ts (B-1431)
 *
 * Indicator payloads carry the DB `projectId` (never a path) so a client can
 * light a project's indicator without that project's session page loaded.
 * Verifies, per recipient:
 *   - a run in an invisible project yields no entry at all (so no id either);
 *   - a run with no resolved project path carries projectId null;
 *   - a run in a visible project carries that project's id;
 *   - the path -> id map is read ONCE per broadcast, not per run or recipient;
 *   - the `session_outcome` delta carries projectId and reaches visible
 *     recipients only.
 *
 * The database module is mocked, keeping this a pure unit test.
 * Runner: Node built-in test runner with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const SHARED_PROJECT = '/workspace/shared';
const PRIVATE_PROJECT = '/workspace/private';
const SHARED_ID = 'proj-shared-id';
const PRIVATE_ID = 'proj-private-id';

let idMapReads = 0;
let outcomeProjectPath: string | null = SHARED_PROJECT;
let outcomeProjectId: string | null = SHARED_ID;

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      // Recipient 9 sees both projects; everyone else only the shared one.
      getVisibleProjectPaths: (userId: number | null) =>
        (userId === 9 ? [SHARED_PROJECT, PRIVATE_PROJECT] : [SHARED_PROJECT]),
    },
    indicatorLookupsDb: {
      getActiveProjectIdsByPath: () => {
        idMapReads += 1;
        return new Map([
          [SHARED_PROJECT, SHARED_ID],
          [PRIVATE_PROJECT, PRIVATE_ID],
        ]);
      },
    },
    sessionOutcomesDb: {
      getOutcomeForBroadcast: () => ({
        projectPath: outcomeProjectPath,
        projectId: outcomeProjectId,
        outcome: 'done',
        outcomeAt: '2026-09-30 10:00:00.000',
        outcomeState: 'visible',
      }),
    },
    userDb: {
      getUserById: () => null,
    },
  },
});

const { connectedClients, WS_OPEN_STATE } = await import('./websocket-state.service.js');
const presence = await import('./presence.service.js');

type Entry = { sessionId: string; state: string; projectId: string | null };
type Message = { type: string; runningSessions?: Entry[]; projectId?: string | null };

/** A fake open socket that records every payload it was sent. */
function fakeClient(userId: number | null) {
  return {
    readyState: WS_OPEN_STATE,
    userId,
    messages: [] as Message[],
    send(raw: string) {
      this.messages.push(JSON.parse(raw) as Message);
    },
    lastOf(type: string): Message | undefined {
      return [...this.messages].reverse().find((message) => message.type === type);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160));
}

function entriesOf(client: ReturnType<typeof fakeClient>): Entry[] {
  return [...(client.lastOf('presence')?.runningSessions ?? [])].sort((a, b) =>
    a.sessionId.localeCompare(b.sessionId));
}

test('runningSessions carries projectId only for projects the recipient can see', async () => {
  connectedClients.clear();
  const restricted = fakeClient(7);
  const member = fakeClient(9);
  connectedClients.add(restricted as never);
  connectedClients.add(member as never);

  presence.presenceRunStarted({ userId: 1, sessionId: 's-shared', projectPath: SHARED_PROJECT });
  presence.presenceRunStarted({ userId: 2, sessionId: 's-private', projectPath: PRIVATE_PROJECT });
  presence.presenceRunStarted({ userId: 3, sessionId: 's-nopath', projectPath: null });
  idMapReads = 0;
  await flush();

  assert.deepEqual(entriesOf(restricted), [
    { sessionId: 's-nopath', state: 'running', projectId: null },
    { sessionId: 's-shared', state: 'running', projectId: SHARED_ID },
  ], 'invisible run is absent (no entry, no id); null path => projectId null');
  assert.ok(
    !JSON.stringify(restricted.messages).includes(PRIVATE_ID),
    'the private project id never reaches a recipient that cannot see it',
  );
  assert.deepEqual(entriesOf(member), [
    { sessionId: 's-nopath', state: 'running', projectId: null },
    { sessionId: 's-private', state: 'running', projectId: PRIVATE_ID },
    { sessionId: 's-shared', state: 'running', projectId: SHARED_ID },
  ]);
  assert.equal(idMapReads, 1, 'path -> id map resolved once per broadcast');

  presence.presenceRunStopped({ userId: 1, sessionId: 's-shared' });
  presence.presenceRunStopped({ userId: 2, sessionId: 's-private' });
  presence.presenceRunStopped({ userId: 3, sessionId: 's-nopath' });
  await flush();
  connectedClients.clear();
});

test('session_outcome delta carries projectId to visible recipients only', () => {
  connectedClients.clear();
  const restricted = fakeClient(7);
  const member = fakeClient(9);
  connectedClients.add(restricted as never);
  connectedClients.add(member as never);

  outcomeProjectPath = PRIVATE_PROJECT;
  outcomeProjectId = PRIVATE_ID;
  presence.broadcastSessionOutcome('s-private');
  assert.equal(member.lastOf('session_outcome')?.projectId, PRIVATE_ID);
  assert.equal(restricted.lastOf('session_outcome'), undefined, 'invisible recipient gets nothing');

  outcomeProjectPath = SHARED_PROJECT;
  outcomeProjectId = SHARED_ID;
  presence.broadcastSessionOutcome('s-shared');
  assert.equal(restricted.lastOf('session_outcome')?.projectId, SHARED_ID);
  assert.equal(member.lastOf('session_outcome')?.projectId, SHARED_ID);
  connectedClients.clear();
});
