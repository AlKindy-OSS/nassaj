/** ADR-187: project-member removal also ends the user's internal team-chat subscriptions. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { revokeProjectLiveAccess } from '@/modules/websocket/services/project-membership-revocation.service.js';

const baseDependencies = {
  listSessionIds: () => ['s1', 's2'],
  clients: [],
  refreshPresence: () => {},
  terminateShells: () => 0,
  listRunningSessionIds: () => [],
};

test('a removed member loses internal chat subscriptions in every project session', () => {
  const calls: Array<[number, string[]]> = [];
  revokeProjectLiveAccess({ projectId: 'p', projectPath: '/p', userId: 7, stillHasAccess: false }, {
    ...baseDependencies,
    revokeInternalChat: (userId, sessionIds) => { calls.push([userId, sessionIds]); return sessionIds.length; },
  });
  assert.deepEqual(calls, [[7, ['s1', 's2']]]);
});

test('a role change that keeps project access leaves internal chat subscriptions alone', () => {
  const calls: unknown[] = [];
  revokeProjectLiveAccess({ projectId: 'p', projectPath: '/p', userId: 7, stillHasAccess: true }, {
    ...baseDependencies,
    revokeInternalChat: (...args) => { calls.push(args); return 0; },
  });
  assert.deepEqual(calls, []);
});
