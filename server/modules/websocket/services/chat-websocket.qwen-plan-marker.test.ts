/**
 * T-1906 — the qwen-plan interactive marker is computed by the dispatcher from
 * the SERVER-side authenticated principal. A client-sent marker is dropped; only
 * `session` / `device_session` principals are interactive; auto-continue and
 * auto-resume turns never are. spawnOpenCode refuses qwen-plan/* without it.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { authorizeTestProviderExecution } from './chat-websocket.permission-test-helper.js';

const PROJECT_ID = 'qwen-plan-marker-fixture';
const PRINCIPAL_ID = 7;
const projectPath = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), '.qwen-plan-marker-fixture-')));
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
        provider: 'opencode', cwd: projectPath, model: 'qwen-plan/qwen3-coder-plus',
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

for (const kind of ['session', 'device_session']) {
  test(`${kind} principal → interactive marker set server-side`, async () => {
    const options = await dispatchOpenCode(kind);
    assert.equal(options.qwenInteractiveVerified, true);
  });
}

for (const kind of ['platform_unverified', 'password_change', 'api_key', 'internal_service', 'ck', 'verified_proxy']) {
  test(`${kind} principal → never interactive, even with a forged client marker`, async () => {
    const options = await dispatchOpenCode(kind, { qwenInteractiveVerified: true });
    assert.equal(options.qwenInteractiveVerified, false);
  });
}

test('a forged marker from a session principal is replaced, not trusted', async () => {
  const options = await dispatchOpenCode('session', { qwenInteractiveVerified: 'yes' });
  assert.equal(options.qwenInteractiveVerified, true);
});

for (const flag of ['autoContinue', 'autoResume']) {
  test(`${flag} turns are not interactive (qwen-plan refuses them)`, async () => {
    const options = await dispatchOpenCode('session', { [flag]: true, qwenInteractiveVerified: true });
    assert.equal(options.qwenInteractiveVerified, false);
  });
}
