/**
 * chat-websocket.control-provider.test.ts — T-874(3).
 *
 * Unit-tests `resolveSessionControlProvider`, which routes a session-scoped
 * control message (abort-session) to the session's OWN persisted provider
 * instead of the client-declared one (which may be the user's current GLOBAL
 * picker selection). Mirrors dispatchProviderCommand's resume routing, with the
 * client provider as the fallback for a brand-new / unpersisted session so the
 * Claude empty-sessionId abort-race handling is preserved.
 *
 * The database repository is module-mocked (registered before the service
 * import), keeping this a pure unit test.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { LLMProvider } from '@/shared/types.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: { getProjectPath: () => null, isProjectVisibleToUser: () => true },
    sessionsDb: { getSessionById: () => null },
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});

const { resolveSessionControlProvider } = await import('./chat-websocket.service.js');

test('the session\'s persisted provider wins over the client-declared global', () => {
  const provider = resolveSessionControlProvider(
    'sess-A',
    'claude', // client sent its current global picker selection
    (id) => (id === 'sess-A' ? ('codex' as LLMProvider) : null),
  );
  assert.equal(provider, 'codex');
});

test('an empty sessionId falls back to the client provider and never looks up', () => {
  let looked = false;
  const provider = resolveSessionControlProvider('', 'claude', () => {
    looked = true;
    return 'codex' as LLMProvider;
  });
  assert.equal(provider, 'claude', 'preserves the Claude empty-id abort-race fallback');
  assert.equal(looked, false);
});

test('a whitespace sessionId is treated as empty (trim) and falls back to the client provider', () => {
  const provider = resolveSessionControlProvider('   ', 'cursor', () => 'codex' as LLMProvider);
  assert.equal(provider, 'cursor');
});

test('an unpersisted session (null lookup) falls back to the client provider', () => {
  const seen: string[] = [];
  const provider = resolveSessionControlProvider(
    ' sess-new ',
    'gemini',
    (id) => {
      seen.push(id);
      return null;
    },
  );
  assert.equal(provider, 'gemini');
  assert.deepEqual(seen, ['sess-new'], 'the trimmed id is used for the lookup');
});
