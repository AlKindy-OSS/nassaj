/**
 * ADR-200 S7 (D3, D9) — the interactive-only guard on qwen-plan turns is gone.
 * Every authenticated principal kind, and auto-continue / auto-resume turns,
 * reach the OpenCode launcher with a `qwen-plan/*` model; the dispatcher adds
 * no interactive marker of its own.
 */
// Must stay first: sets WORKSPACES_ROOT before @/shared/utils.js loads (B-1421), so the
// fixture is valid under a sanitized HOME too.
// eslint-disable-next-line import-x/order
import { TEST_GIT_PROJECT } from './chat-websocket.test-git-project.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test, { after, mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { authorizeTestProviderExecution } from './chat-websocket.permission-test-helper.js';

const PROJECT_ID = 'qwen-plan-automation-fixture';
const PRINCIPAL_ID = 7;
const projectPath = TEST_GIT_PROJECT;
after(() => fs.rmSync(projectPath, { recursive: true, force: true }));

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: (candidate: string) => candidate === projectPath
        ? { project_id: PROJECT_ID, project_path: projectPath }
        : null,
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: (projectId: string, userId: number | null) =>
        projectId === PROJECT_ID && userId === PRINCIPAL_ID,
    },
    participantsDb: { isParticipant: () => false },
    sessionsDb: { getSessionById: () => null },
    sessionWorkspaceModesDb: { markOverlay: () => undefined },
    sessionOutcomesDb: {},
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});

const { dispatchProviderCommand } = await import('./chat-websocket.service.js');
const writer = { send: () => undefined } as unknown as WebSocketWriter;

async function dispatchOpenCode(authenticationKind: string, options: Record<string, unknown> = {}) {
  const received: Array<Record<string, unknown>> = [];
  await dispatchProviderCommand(
    'opencode-command',
    {
      type: 'opencode-command',
      command: 'x',
      options: {
        provider: 'opencode', cwd: projectPath, model: 'qwen-plan/qwen3.7-plus',
        clientMsgId: `qwen-plan-${randomUUID()}`, ...options,
      },
    } as never,
    writer,
    {
      authorizeProviderExecution: authorizeTestProviderExecution,
      getSessionProvider: () => null,
      getActiveClaudeSDKSessions: () => [],
      spawnOpenCode: async (_command: string, launchOptions: Record<string, unknown>) => {
        received.push(launchOptions);
      },
    } as never,
    PRINCIPAL_ID,
    Object.freeze({ id: PRINCIPAL_ID, role: 'user', authenticationKind, authorizationGeneration: 1 }),
  );
  assert.equal(received.length, 1, 'the opencode launcher was reached');
  return received[0];
}

// The removed marker's option name, built so the source grep stays clean.
const REMOVED_MARKER = ['qwen', 'Interactive', 'Verified'].join('');
const KINDS = ['session', 'device_session', 'platform_unverified', 'password_change', 'api_key',
  'internal_service', 'ck', 'verified_proxy'];

for (const kind of KINDS) {
  test(`${kind} principal → a qwen-plan turn reaches the launcher, no marker added`, async () => {
    const options = await dispatchOpenCode(kind);
    assert.equal(options.model, 'qwen-plan/qwen3.7-plus');
    assert.equal(Object.prototype.hasOwnProperty.call(options, REMOVED_MARKER), false);
  });
}

for (const flag of ['autoContinue', 'autoResume']) {
  test(`${flag} automation turns are no longer refused`, async () => {
    const options = await dispatchOpenCode('internal_service', { [flag]: true });
    assert.equal(options.model, 'qwen-plan/qwen3.7-plus');
    assert.equal(options[flag], true);
    assert.equal(Object.prototype.hasOwnProperty.call(options, REMOVED_MARKER), false);
  });
}
