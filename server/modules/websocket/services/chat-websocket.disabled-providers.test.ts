/**
 * chat-websocket.disabled-providers.test.ts — T-864.
 *
 * Unit-tests the globally-disabled-provider guard inside
 * `dispatchProviderCommand` (defence in depth behind the UI filtering, single
 * source of truth: shared/disabledProviders.ts):
 *
 *   - a new run for a disabled provider (deepseek/glm — kimi re-enabled per
 *     ADR-062; glm folded into the OpenCode carrier 2026-07-26) is refused with a normalized error `complete`
 *     message and NO spawn call;
 *   - the guard runs on the RESOLVED provider, so resuming a historical
 *     session persisted under a disabled provider is refused too — even when
 *     the client sends it under an enabled message type;
 *   - a resumed session persisted under an ENABLED provider still dispatches,
 *     even when the (stale) client message type names a disabled provider;
 *   - enabled providers (claude/hermes/…) dispatch exactly as before.
 *
 * The database repository is module-mocked, keeping this a pure unit test.
 * Runner: Node built-in test runner with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { DISABLED_PROVIDERS } from '../../../../shared/disabledProviders.js';
import { PROVIDER_REMOVED_CODE, RETIRED_PROVIDER_IDS } from '../../../../shared/retiredProviders.js';
import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';


// --- Module mock (must be registered before importing the service) -----------

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: () => ({ project_id: 'test-project' }),
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: () => true,
    },
    sessionsDb: {
      getSessionById: (sessionId: string) => ({
        session_id: sessionId,
        provider: sessionId.includes('qwen') ? 'qwen'
          : sessionId.includes('deepseek') ? 'deepseek' : 'claude',
        project_path: process.cwd(),
      }),
    },
    participantsDb: { isParticipant: () => true },
    sessionWorkspaceModesDb: {
      readLegacyEligibility: () => ({ eligible: true }),
      markOverlay: () => undefined,
    },
    sessionOutcomesDb: {
      getOutcomeForBroadcast: () => null,
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

// --- Harness ------------------------------------------------------------------

// createNormalizedMessage returns a flat envelope: kind/provider/success/error
// live directly on the payload (plus id/sessionId/timestamp fill-ins).
type SentPayload = {
  kind?: string;
  success?: boolean;
  error?: string;
  provider?: string;
};

function makeWriter() {
  const sent: SentPayload[] = [];
  const writer = {
    send: (payload: unknown) => {
      sent.push(payload as SentPayload);
    },
  } as unknown as WebSocketWriter;
  return { writer, sent };
}

function makeDependencies(sessionProviderById: Record<string, string> = {}) {
  const calls: string[] = [];
  const spawn = (name: string) => async () => {
    calls.push(name);
  };
  const dependencies = {
    queryClaudeSDK: spawn('claude'),
    spawnCursor: spawn('cursor'),
    queryCodex: spawn('codex'),
    spawnAntigravity: spawn('antigravity'),
    spawnOpenCode: spawn('opencode'),
    spawnHermes: spawn('hermes'),
    spawnKimi: spawn('kimi'),
    spawnDeepSeek: spawn('deepseek'),
    spawnGlm: spawn('glm'),
    spawnQwen: spawn('qwen'),
    getSessionProvider: (sessionId: string) => sessionProviderById[sessionId] ?? null,
  } as unknown as Parameters<typeof dispatchProviderCommand>[3];
  return { dependencies, calls };
}

/** The normalized error payload produced for a refused dispatch. */
function readError(sent: SentPayload[]): SentPayload {
  assert.equal(sent.length, 1, 'exactly one normalized message is sent');
  const payload = sent[0] ?? {};
  assert.equal(payload.kind, 'complete');
  assert.equal(payload.success, false);
  return payload;
}

// --- Tests ----------------------------------------------------------------------

test('every disabled provider command is refused with a clear error and no spawn', async () => {
  // Retired ids (runtime deleted) get their own typed refusal, asserted below.
  for (const provider of DISABLED_PROVIDERS.filter((id) => !RETIRED_PROVIDER_IDS.has(id))) {
    const { writer, sent } = makeWriter();
    const { dependencies, calls } = makeDependencies();

    await dispatchProviderCommand(`${provider}-command`, { command: 'hi' }, writer, dependencies);

    assert.deepEqual(calls, [], `${provider}: no handler is spawned`);
    const data = readError(sent);
    assert.equal(data.provider, provider);
    assert.match(data.error ?? '', /disabled/i);
    assert.match(data.error ?? '', new RegExp(`"${provider}"`));
  }
});

test('an unknown command has no implicit Claude fallback', async () => {
  const { writer, sent } = makeWriter();
  const { dependencies, calls } = makeDependencies();

  await dispatchProviderCommand('unknown-command', { command: 'hi' }, writer, dependencies);

  assert.deepEqual(calls, []);
  const data = readError(sent);
  assert.equal(data.provider, undefined);
  assert.match(data.error ?? '', /no provider runtime handler/i);
  assert.equal((data as SentPayload & { notStarted?: boolean }).notStarted, true);
});

test('a resumed Qwen session dispatches to Qwen and never falls through to Claude', async () => {
  const { writer, sent } = makeWriter();
  const { dependencies, calls } = makeDependencies({ 's-qwen-1': 'qwen' });

  await dispatchProviderCommand(
    'claude-command',
    { command: 'hi', options: { sessionId: 's-qwen-1' } },
    writer,
    dependencies,
    1,
  );

  assert.deepEqual(calls, ['qwen']);
  assert.deepEqual(sent, []);
});

test('resume of a session persisted under a disabled provider is refused', async () => {
  // Historical deepseek session resumed under the (enabled) claude message type:
  // the DB provider wins, so the guard must still fire. (deepseek is still in
  // DISABLED_PROVIDERS; kimi was re-enabled per ADR-062.)
  const { writer, sent } = makeWriter();
  const { dependencies, calls } = makeDependencies({ 's-deepseek-1': 'deepseek' });

  await dispatchProviderCommand(
    'claude-command',
    { command: 'hi', options: { sessionId: 's-deepseek-1' } },
    writer,
    dependencies
  );

  assert.deepEqual(calls, []);
  const data = readError(sent);
  assert.equal(data.provider, 'deepseek');
  assert.match(data.error ?? '', /disabled/i);
});

test('resumed session persisted under an enabled provider dispatches despite a stale disabled type', async () => {
  // Stale client selection sends glm-command, but the session belongs to claude
  // in the DB — re-routing lands on an enabled provider and proceeds.
  const { writer, sent } = makeWriter();
  const { dependencies, calls } = makeDependencies({ 's-claude-1': 'claude' });

  await dispatchProviderCommand(
    'glm-command',
    { command: 'hi', options: { sessionId: 's-claude-1' } },
    writer,
    dependencies,
    1,
  );

  assert.deepEqual(calls, ['claude']);
  assert.deepEqual(sent, []);
});

test('enabled providers dispatch exactly as before', async () => {
  const expected: [string, string][] = [
    ['claude-command', 'claude'],
    ['cursor-command', 'cursor'],
    ['codex-command', 'codex'],
    ['antigravity-command', 'antigravity'],
    ['hermes-command', 'hermes'],
    ['qwen-command', 'qwen'],
  ];

  for (const [messageType, handler] of expected) {
    const { writer, sent } = makeWriter();
    const { dependencies, calls } = makeDependencies();

    await dispatchProviderCommand(messageType, { command: 'hi' }, writer, dependencies);

    assert.deepEqual(calls, [handler], `${messageType} → ${handler}`);
    assert.deepEqual(sent, []);
  }
});

// --- T-1853: providers whose runtime was deleted ------------------------------

const [RETIRED_PROVIDER] = [...RETIRED_PROVIDER_IDS];

test('a retired provider command type gets a typed provider_removed refusal and no spawn', async () => {
  const { writer, sent } = makeWriter();
  const { dependencies, calls } = makeDependencies();

  await dispatchProviderCommand(
    `${RETIRED_PROVIDER}-command`,
    { command: 'hi', options: {} },
    writer,
    dependencies,
    1,
  );

  assert.deepEqual(calls, []);
  const payload = readError(sent) as SentPayload & { code?: string; notStarted?: boolean };
  assert.equal(payload.code, PROVIDER_REMOVED_CODE);
  assert.equal(payload.notStarted, true);
});

test('resuming a session persisted under a retired provider is refused before any spawn', async () => {
  const { writer, sent } = makeWriter();
  const { dependencies, calls } = makeDependencies({ 's-retired-1': RETIRED_PROVIDER });

  await dispatchProviderCommand(
    'claude-command',
    { command: 'hi', options: { sessionId: 's-retired-1' } },
    writer,
    dependencies,
    1,
  );

  assert.deepEqual(calls, []);
  const payload = readError(sent) as SentPayload & { code?: string };
  assert.equal(payload.code, PROVIDER_REMOVED_CODE);
});
