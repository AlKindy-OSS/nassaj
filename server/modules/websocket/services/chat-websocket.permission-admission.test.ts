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
/** Same shape as the repository's PermissionStateConflictError (the barrel is mocked here). */
const conflict = (code: string, fence?: Readonly<{ scopeKind: string; reasonCode: string }>) =>
  Object.assign(new Error(code), { code, ...(fence ? { fence } : {}) });

function baseDependencies(launches: string[]): Record<string, unknown> {
  return {
    getSessionProvider: () => null,
    getActiveClaudeSDKSessions: () => [],
    queryClaudeSDK: async () => { launches.push('claude'); },
  };
}

async function dispatch(admission: 'missing' | 'throw' | 'deny' | (() => never)) {
  const launches: string[] = [];
  const frames: Record<string, unknown>[] = [];
  const dependencies = baseDependencies(launches);
  if (typeof admission === 'function') {
    dependencies.authorizeProviderExecution = admission;
  } else if (admission === 'throw') {
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

test('B-1076: a fenced scope reports a permanent, non-retryable refusal with its scope kind', async () => {
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    const result = await dispatch(() => {
      throw conflict('EFFECT_SCOPE_FENCED', {
        scopeKind: 'user_provider_purpose', reasonCode: 'RECONCILED_EFFECT_UNKNOWN',
      });
    });
    assert.deepEqual(result.launches, []);
    const frame = result.frames.at(-1) ?? {};
    assert.equal(frame.kind, 'complete');
    assert.equal(frame.code, 'effect_scope_fenced');
    assert.equal(frame.notStarted, true);
    assert.equal(frame.retryable, false);
    assert.equal(frame.error, 'Permission admission failed closed.');
    assert.deepEqual(frame.fence, {
      scopeKind: 'user_provider_purpose', reasonCode: 'RECONCILED_EFFECT_UNKNOWN',
    });
    const logged = warn.mock.calls.map(call => String(call.arguments[0]))
      .filter(line => line.includes('permission_admission_failed'));
    assert.equal(logged.length, 1);
    const entry = JSON.parse(logged[0]);
    assert.equal(entry.entrypoint, 'ws.chat');
    assert.equal(entry.userId, PRINCIPAL.id);
    assert.equal(entry.fenceScopeKind, 'user_provider_purpose');
    assert.doesNotMatch(logged[0], /must-not-launch/);
  } finally {
    warn.mock.restore();
  }
});

test('B-1076: a transitioning generation stays retryable and an arbitrary code is hidden', async () => {
  const transitioning = await dispatch(() => {
    throw conflict('GENERATION_TRANSITIONING');
  });
  assert.equal(transitioning.frames.at(-1)?.code, 'generation_transitioning');
  assert.equal(transitioning.frames.at(-1)?.retryable, true);
  assert.equal(transitioning.frames.at(-1)?.fence, undefined);
  const busy = await dispatch(() => {
    throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  });
  assert.equal(busy.frames.at(-1)?.code, 'permission_admission_unavailable');
  assert.equal(busy.frames.at(-1)?.retryable, true);
});
