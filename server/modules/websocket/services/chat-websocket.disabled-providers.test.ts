/**
 * chat-websocket.disabled-providers.test.ts — T-864.
 *
 * Unit-tests the globally-disabled-provider guard inside
 * `dispatchProviderCommand` (defence in depth behind the UI filtering, single
 * source of truth: shared/disabledProviders.ts):
 *
 *   - a new run for a disabled provider (gemini/deepseek/glm — kimi re-enabled
 *     per ADR-062; glm folded into the OpenCode carrier 2026-07-26) is refused
 *     with a normalized error `complete` message and NO spawn call;
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

// --- Module mock (must be registered before importing the service) -----------

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getProjectPath: () => null,
      isProjectVisibleToUser: () => true,
    },
    sessionsDb: {
      getSessionById: () => null,
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});

const { dispatchProviderCommand } = await import('./chat-websocket.service.js');

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
    spawnGemini: spawn('gemini'),
    spawnAntigravity: spawn('antigravity'),
    spawnOpenCode: spawn('opencode'),
    spawnHermes: spawn('hermes'),
    spawnKimi: spawn('kimi'),
    spawnDeepSeek: spawn('deepseek'),
    spawnGlm: spawn('glm'),
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
  for (const provider of DISABLED_PROVIDERS) {
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
  // Stale client selection sends gemini-command, but the session belongs to
  // claude in the DB — re-routing lands on an enabled provider and proceeds.
  const { writer, sent } = makeWriter();
  const { dependencies, calls } = makeDependencies({ 's-claude-1': 'claude' });

  await dispatchProviderCommand(
    'gemini-command',
    { command: 'hi', options: { sessionId: 's-claude-1' } },
    writer,
    dependencies
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
  ];

  for (const [messageType, handler] of expected) {
    const { writer, sent } = makeWriter();
    const { dependencies, calls } = makeDependencies();

    await dispatchProviderCommand(messageType, { command: 'hi' }, writer, dependencies);

    assert.deepEqual(calls, [handler], `${messageType} → ${handler}`);
    assert.deepEqual(sent, []);
  }
});
