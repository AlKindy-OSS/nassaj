/**
 * chat-websocket.visibility.test.ts — B-36 (audit 2026-06-12).
 *
 * Unit-tests the B-PRIV spawn guard `isProjectPathVisibleToUser` (the shared
 * core of `isSpawnProjectVisible`, also enforced by the `/shell` PTY handler):
 *
 *   - empty / unregistered paths are allowed (creation/first-run flow);
 *   - a registered project defers to projectsDb.isProjectVisibleToUser;
 *   - the JWT userId is normalized to a number (or null) before the DB check,
 *     so a string id ("7") and a numeric id (7) authorize identically and a
 *     non-numeric id never leaks through as a bogus member match.
 *
 * The database repository is module-mocked, keeping this a pure unit test.
 * Runner: Node built-in test runner with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// --- Module mock (must be registered before importing the service) -----------

const REGISTERED_PATH = '/workspace/private-project';
const PROJECT_ID = 'proj-1';

const visibleCalls: { projectId: string; userId: number | null }[] = [];
let visibleResult = false;

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getProjectPath: (projectPath: string) =>
        projectPath === REGISTERED_PATH ? { project_id: PROJECT_ID } : null,
      isProjectVisibleToUser: (projectId: string, userId: number | null) => {
        visibleCalls.push({ projectId, userId });
        return visibleResult;
      },
    },
    // presence.service.ts (in the import graph of chat-websocket.service.ts)
    // also pulls userDb from the mocked module; stub what it references.
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});

const { isProjectPathVisibleToUser } = await import('./chat-websocket.service.js');

test('empty path is allowed without consulting the database', () => {
  visibleCalls.length = 0;
  assert.equal(isProjectPathVisibleToUser('', 7), true);
  assert.equal(isProjectPathVisibleToUser('   ', 7), true);
  assert.equal(visibleCalls.length, 0);
});

test('unregistered path is allowed (creation/first-run flow)', () => {
  visibleCalls.length = 0;
  assert.equal(isProjectPathVisibleToUser('/workspace/brand-new', 7), true);
  assert.equal(visibleCalls.length, 0);
});

test('registered project defers to projectsDb.isProjectVisibleToUser', () => {
  visibleCalls.length = 0;

  visibleResult = true;
  assert.equal(isProjectPathVisibleToUser(REGISTERED_PATH, 7), true);

  visibleResult = false;
  assert.equal(isProjectPathVisibleToUser(REGISTERED_PATH, 7), false);

  assert.deepEqual(visibleCalls, [
    { projectId: PROJECT_ID, userId: 7 },
    { projectId: PROJECT_ID, userId: 7 },
  ]);
});

test('string userId is normalized to a number before the DB check', () => {
  visibleCalls.length = 0;
  visibleResult = true;

  assert.equal(isProjectPathVisibleToUser(REGISTERED_PATH, '7'), true);
  assert.deepEqual(visibleCalls, [{ projectId: PROJECT_ID, userId: 7 }]);
});

test('non-numeric and missing userIds reach the DB as null (never a bogus id)', () => {
  visibleCalls.length = 0;
  visibleResult = false;

  assert.equal(isProjectPathVisibleToUser(REGISTERED_PATH, 'alice'), false);
  assert.equal(isProjectPathVisibleToUser(REGISTERED_PATH, null), false);
  assert.deepEqual(visibleCalls, [
    { projectId: PROJECT_ID, userId: null },
    { projectId: PROJECT_ID, userId: null },
  ]);
});
