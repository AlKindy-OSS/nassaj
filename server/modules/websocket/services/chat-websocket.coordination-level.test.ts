import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: { getProjectPath: () => ({ project_id: 'test-project' }), isProjectVisibleToUser: () => true },
    sessionsDb: { getSessionById: () => null },
    sessionWorkspaceModesDb: { markOverlay: () => undefined },
    sessionOutcomesDb: {},
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

const writer = { send: () => undefined } as unknown as WebSocketWriter;

test('Claude coordination input is narrowed by the websocket boundary', async () => {
  const received: unknown[] = [];
  const dependencies = {
    queryClaudeSDK: async (_command: string, options: unknown) => { received.push(options); },
    spawnCursor: async () => {},
    queryCodex: async () => {},
    spawnAntigravity: async () => {},
    spawnHermes: async () => {},
    spawnKimi: async () => {},
    spawnDeepSeek: async () => {},
    spawnGlm: async () => {},
    spawnOpenCode: async () => {},
    getSessionProvider: () => null,
    getActiveClaudeSDKSessions: () => [],
  } as never;

  for (const coordinationLevel of ['direct', 'delegate', 'delegate_review', 'surprise', undefined]) {
    await dispatchProviderCommand(
      'claude-command',
      { type: 'claude-command', command: 'x', options: { coordinationLevel } } as never,
      writer,
      dependencies,
    );
  }

  assert.deepEqual(
    received.map((options) => (options as { coordinationLevel: string }).coordinationLevel),
    ['direct', 'delegate', 'delegate_review', 'direct', 'delegate'],
  );
  assert.ok(received.every(Object.isFrozen), 'launcher receives an immutable per-turn snapshot');
});
