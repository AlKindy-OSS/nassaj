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

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';
import { chatImageStoreDatabaseLinkStubs } from '../../../../tests/helpers/chat-image-store-link-stubs.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    ...chatImageStoreDatabaseLinkStubs(),
    projectsDb: { getProjectPath: () => null, isProjectVisibleToUser: () => true },
    sessionsDb: { getSessionById: () => null },
    sessionOutcomesDb: { getOutcomeForBroadcast: () => null },
    userDb: { getUserById: (id: number) => (id === 2 ? { id: 2, username: 'sara' } : null), getFirstUser: () => null },
  },
});

const { decideTurnStopRequest, refuseForeignTurnStop, resolveSessionControlProvider } =
  await import('./chat-websocket.service.js');

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
    'hermes',
    (id) => {
      seen.push(id);
      return null;
    },
  );
  assert.equal(provider, 'hermes');
  assert.deepEqual(seen, ['sess-new'], 'the trimmed id is used for the lookup');
});

test('an unknown control provider remains unknown and never falls back to Claude', () => {
  assert.equal(resolveSessionControlProvider('', null, () => 'claude'), null);
  assert.equal(resolveSessionControlProvider('missing', null, () => null), null);
});

// ADR-173 rev.3 P5: abort-session asks the Claude run for the stop right after the write gate.
type StopVerdict = { allowed: boolean; role: string | null; stuck: boolean; starterUserId: unknown };
function stopDeps(verdict: StopVerdict, provider: LLMProvider | null = 'claude') {
  const asked: Array<[string, number | null]> = [];
  return {
    asked,
    deps: {
      getSessionProvider: () => provider,
      authorizeClaudeTurnStop: (sessionId: string, userId: number | null) => {
        asked.push([sessionId, userId]);
        return verdict;
      },
    },
  };
}

test('P5: a refused stop of a Claude turn answers turn_stop_forbidden and stops nothing', () => {
  const { deps, asked } = stopDeps({ allowed: false, role: null, stuck: false, starterUserId: 1 });
  const frame = refuseForeignTurnStop(deps as never, 'sess-busy', 'claude', '2') as Record<string, unknown>;
  assert.deepEqual(asked, [['sess-busy', 2]]);
  assert.deepEqual({
    kind: frame.kind, code: frame.code, aborted: frame.aborted, success: frame.success,
    abortFailed: frame.abortFailed, notStarted: frame.notStarted, sessionId: frame.sessionId,
    provider: frame.provider, busyBy: frame.busyBy, stuck: frame.stuck, canStop: frame.canStop,
  }, {
    kind: 'complete', code: 'turn_stop_forbidden', aborted: true, success: false, abortFailed: true,
    notStarted: true, sessionId: 'sess-busy', provider: 'claude', busyBy: 1, stuck: false, canStop: false,
  });
});

test('P5: an allowed stop, another provider, an empty id or no wiring never refuse', () => {
  const allowed = stopDeps({ allowed: true, role: 'stuck_writer', stuck: true, starterUserId: 1 });
  assert.equal(refuseForeignTurnStop(allowed.deps as never, 'sess', 'claude', 2), null);
  const codex = stopDeps({ allowed: false, role: null, stuck: false, starterUserId: 1 }, 'codex');
  assert.equal(refuseForeignTurnStop(codex.deps as never, 'sess', 'claude', 2), null);
  assert.deepEqual(codex.asked, [], 'only a Claude turn is asked');
  assert.equal(refuseForeignTurnStop(codex.deps as never, '', 'claude', 2), null);
  assert.equal(refuseForeignTurnStop({ getSessionProvider: () => 'claude' } as never, 'sess', 'claude', 2), null);
});

test('P8 B4: a stop by someone other than the starter names the stopper; the starter\'s own stop does not', () => {
  const foreign = stopDeps({ allowed: true, role: 'privileged', stuck: false, starterUserId: 1 });
  assert.deepEqual(decideTurnStopRequest(foreign.deps as never, 'sess', 'claude', '2'),
    { refusal: null, stoppedBy: { userId: 2, name: 'sara' } });
  const own = stopDeps({ allowed: true, role: 'starter', stuck: false, starterUserId: 2 });
  assert.deepEqual(decideTurnStopRequest(own.deps as never, 'sess', 'claude', 2), { refusal: null, stoppedBy: null });
  const unnamed = stopDeps({ allowed: true, role: 'stuck_writer', stuck: true, starterUserId: 1 });
  assert.deepEqual(decideTurnStopRequest(unnamed.deps as never, 'sess', 'claude', 9).stoppedBy,
    { userId: 9, name: 'member 9' }, 'a neutral label when the name cannot be read');
  const refused = stopDeps({ allowed: false, role: null, stuck: false, starterUserId: 1 });
  const verdict = decideTurnStopRequest(refused.deps as never, 'sess', 'claude', 2);
  assert.equal(verdict.stoppedBy, null);
  assert.equal((verdict.refusal as Record<string, unknown>).code, 'turn_stop_forbidden');
  assert.equal(refused.asked.length, 1, 'the run decides (and audits) once');
  const noRun = stopDeps({ allowed: true, role: null, stuck: false, starterUserId: null });
  assert.deepEqual(decideTurnStopRequest(noRun.deps as never, 'sess', 'claude', 2), { refusal: null, stoppedBy: null });
});
