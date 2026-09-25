import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

const PROJECT_PATH = process.cwd();
const PRINCIPAL = Object.freeze({
  id: 7,
  role: 'user',
  authenticationKind: 'session',
  authorizationGeneration: 1,
});

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: (candidate: string) => candidate === PROJECT_PATH
        ? { project_id: 'permission-admission-project' }
        : null,
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: () => true,
    },
    participantsDb: { isParticipant: () => false },
    sessionsDb: { getSessionById: () => null },
    sessionWorkspaceModesDb: { markOverlay: () => undefined },
    sessionOutcomesDb: {},
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});

mock.module('@/modules/session-workspaces/index.js', {
  namedExports: {
    resolveSessionWorkspaceForLaunch: (input: { projectPath: string }) => ({
      cwd: input.projectPath,
      logicalProjectPath: input.projectPath,
      isolation: 'overlay',
      generation: 'permission-admission-test',
    }),
    bindSessionWorkspace: (input: { projectPath: string }) => ({
      cwd: input.projectPath,
      logicalProjectPath: input.projectPath,
      isolation: 'overlay',
      generation: 'permission-admission-test',
    }),
  },
});

const { dispatchProviderCommand } = await import('./chat-websocket.service.js');

function baseDependencies(launches: string[]): Record<string, unknown> {
  return {
    getSessionProvider: () => null,
    getActiveClaudeSDKSessions: () => [],
    queryClaudeSDK: async () => { launches.push('claude'); },
  };
}

async function dispatch(admission: 'missing' | 'throw' | 'deny') {
  const launches: string[] = [];
  const frames: Record<string, unknown>[] = [];
  const dependencies = baseDependencies(launches);
  if (admission === 'throw') {
    dependencies.authorizeProviderExecution = () => { throw new Error('synthetic admission outage'); };
  } else if (admission === 'deny') {
    dependencies.authorizeProviderExecution = () => ({
      kind: 'denied',
      decisionId: 'denied-test-decision',
      reasonCodes: ['REFERENCE_UNAVAILABLE'],
    });
  }

  await dispatchProviderCommand(
    'claude-command',
    {
      type: 'claude-command',
      command: 'must-not-launch',
      options: { provider: 'claude', cwd: PROJECT_PATH },
    } as never,
    { send: (frame: Record<string, unknown>) => frames.push(frame) } as unknown as WebSocketWriter,
    dependencies as never,
    PRINCIPAL.id,
    PRINCIPAL,
  );
  return { launches, frames };
}

test('missing permission admission fails closed before provider launch', async () => {
  const result = await dispatch('missing');
  assert.deepEqual(result.launches, []);
  assert.equal(result.frames.at(-1)?.code, 'permission_admission_unavailable');
  assert.equal(result.frames.at(-1)?.notStarted, true);
});

test('throwing permission admission fails closed before provider launch', async () => {
  const result = await dispatch('throw');
  assert.deepEqual(result.launches, []);
  assert.equal(result.frames.at(-1)?.code, 'permission_admission_unavailable');
  assert.equal(result.frames.at(-1)?.notStarted, true);
});

test('denied permission admission preserves reasons and never launches', async () => {
  const result = await dispatch('deny');
  assert.deepEqual(result.launches, []);
  assert.equal(result.frames.at(-1)?.code, 'permission_denied');
  assert.deepEqual(result.frames.at(-1)?.reasonCodes, ['REFERENCE_UNAVAILABLE']);
  assert.equal(result.frames.at(-1)?.notStarted, true);
});
