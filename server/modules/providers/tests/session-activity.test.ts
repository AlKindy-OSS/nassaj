/**
 * session-activity.test.ts — ج1 step 2: the read-only liveness carrier behind
 * `GET /api/providers/sessions/:sessionId/activity`.
 *
 * WHAT IS PROVEN
 * --------------
 *   1. an ACTIVE session answers `{ isProcessing: true }`;
 *   2. an IDLE session answers `{ isProcessing: false }` — an explicit boolean
 *      that survives JSON.stringify (the whole point of ج1), never `undefined`
 *      and never a missing key;
 *   3. an UNKNOWN session id answers exactly `{ isProcessing: false }`;
 *   4. a session the caller may NOT see (private project, non-member) answers
 *      BYTE-IDENTICALLY to the unknown one — asserted by comparing the serialized
 *      bodies, not by eyeballing two literals — even while that session is
 *      genuinely running, so the endpoint cannot be used to probe for another
 *      user's session;
 *   5. an unresolvable caller (null user id) on a private project is refused
 *      (fail-closed), and the probe is NEVER invoked for any refused caller —
 *      asserted by a call-recording probe, so the refusal cannot be a
 *      post-hoc filter of an answer that was already computed. Note this is a
 *      "no hidden state is read" property, NOT a constant-time one: the UNKNOWN
 *      id passes the gate (it fail-opens on a session with no project_path) and
 *      does reach the probe, so the two refused cases run different amounts of
 *      work while returning the same bytes;
 *   6. the route is a pure read: the probes are call-recorders and no other
 *      collaborator exists to write to.
 *
 * FIXTURE PROVENANCE (no synthetic shapes)
 * ----------------------------------------
 * Every id, path and provider below is copied from the fixture database of this
 * install (~/.local/share/nassaj-dev/db.sqlite, `sessions` and `projects`):
 *   - 00000001-0000-4000-8000-000000000001  claude    /home/dev/workspace/nassaj
 *   - ses_synthetic_06214044dffemD26QTiayDywHC        opencode  /home/dev/workspace/nassaj
 *   - 00000002-0000-4000-8000-000000000002  codex     /home/dev/Project/SampleOne
 *   - 00000003-0000-4000-8000-000000000003  claude    /home/dev/Project/SampleOne
 *   - project rows 00000004-0000-4000-8000-000000000004 (nassaj-dev) and
 *     00000005-0000-4000-8000-000000000005 (SampleOne)
 * so the id alphabet actually exercised is the real one (uuid v4, codex's uuid
 * v7, opencode's `ses_…` base62 — the last two would have been missed by a
 * hand-invented "session-1" fixture, and the route's id pattern must accept all
 * three).
 * THE ONE SYNTHESIZED BIT, declared: this install currently has NO private
 * project (`select visibility, count(*) from projects` → public only), so the
 * SampleOne project row is marked private in the fixture to exercise the refusal
 * branch. Its shape and values are otherwise the live ones.
 *
 * The visibility gate is NOT stubbed: the REAL `isSessionVisibleToUser` runs,
 * reading the mocked database module exactly as it does in production (the same
 * mocking discipline as chat-websocket.session-visibility.test.ts).
 *
 * Runner: node:test with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

// --- Live-derived fixtures ---------------------------------------------------

const NASSAJ_DEV_PATH = '/home/dev/workspace/nassaj';
const SAMPLE_ONE_PATH = '/home/dev/Project/SampleOne';

const NASSAJ_DEV_PROJECT_ID = '00000004-0000-4000-8000-000000000004';
const SAMPLE_ONE_PROJECT_ID = '00000005-0000-4000-8000-000000000005';

/** Real member of both projects. */
const MEMBER_USER_ID = 1;
/** Authenticated, but not a member of the (fixture-private) SampleOne project. */
const OUTSIDER_USER_ID = 2;

const CLAUDE_SID = '00000001-0000-4000-8000-000000000001'; // public project
const OPENCODE_SID = 'ses_synthetic_06214044dffemD26QTiayDywHC'; // public project
const CODEX_SID = '00000002-0000-4000-8000-000000000002'; // private project (fixture)
const PRIVATE_CLAUDE_SID = '00000003-0000-4000-8000-000000000003'; // private project (fixture)
const UNKNOWN_SID = '00000006-0000-4000-8000-000000000006'; // in no table
const NO_PROVIDER_SID = '00000007-0000-4000-8000-000000000007'; // public project, provider unset

const SESSION_ROWS: Record<string, { session_id: string; provider: string; project_path: string }> = {
  [CLAUDE_SID]: { session_id: CLAUDE_SID, provider: 'claude', project_path: NASSAJ_DEV_PATH },
  [OPENCODE_SID]: { session_id: OPENCODE_SID, provider: 'opencode', project_path: NASSAJ_DEV_PATH },
  [CODEX_SID]: { session_id: CODEX_SID, provider: 'codex', project_path: SAMPLE_ONE_PATH },
  [NO_PROVIDER_SID]: { session_id: NO_PROVIDER_SID, provider: '', project_path: NASSAJ_DEV_PATH },
  [PRIVATE_CLAUDE_SID]: {
    session_id: PRIVATE_CLAUDE_SID,
    provider: 'claude',
    project_path: SAMPLE_ONE_PATH,
  },
};

const PROJECT_ROWS: Record<string, { project_id: string }> = {
  [NASSAJ_DEV_PATH]: { project_id: NASSAJ_DEV_PROJECT_ID },
  [SAMPLE_ONE_PATH]: { project_id: SAMPLE_ONE_PROJECT_ID },
};

const databaseExports = await import('@/modules/database/index.js');
mock.module('@/modules/database/index.js', {
  namedExports: {
    ...databaseExports,
    sessionsDb: {
      getSessionById: (sessionId: string) => SESSION_ROWS[sessionId] ?? null,
    },
    projectsDb: {
      getProjectPath: (projectPath: string) => PROJECT_ROWS[projectPath] ?? null,
      // nassaj-dev: public (live value). SampleOne: private for this fixture, so only
      // its member passes — the branch the live install cannot exercise.
      isProjectVisibleToUser: (projectId: string, userId: number | null) =>
        projectId === NASSAJ_DEV_PROJECT_ID ||
        (projectId === SAMPLE_ONE_PROJECT_ID && userId === MEMBER_USER_ID),
      getVisibleProjectPaths: () => [],
      isProjectWritableByUser: () => false,
    },
    participantsDb: {
      isParticipant: () => false,
      getSessionIdsForUser: () => [],
    },
    // presence.service.ts sits in the websocket import graph and destructures it.
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
    // Consumed by other modules in the websocket barrel's import graph (the
    // shell handler's provider-sharing policy). Inert: no test path reaches it.
    appConfigDb: {
      getConfigValue: () => null,
      setConfigValue: () => undefined,
    },
    auditLogDb: {
      record: () => undefined,
      append: () => undefined,
    },
  },
});

const { readSessionActivity, setSessionLivenessProbes, resetSessionLivenessProbes } = await import(
  '../services/session-activity.service.js'
);

// --- Probe doubles: the ONLY liveness source, and they record every call ------
// These stand in for the production `isXSessionActive` functions that index.js
// injects. Recording the calls is what proves the refusal happens BEFORE the
// probe (no existence disclosure through work performed) and that the path is a
// pure read.

let probeCalls: Array<{ provider: string; sessionId: string }> = [];

/** Session ids the fake providers report as running. */
const RUNNING = new Set<string>([CLAUDE_SID, CODEX_SID, PRIVATE_CLAUDE_SID]);

const makeProbe = (provider: string) => (sessionId: string) => {
  probeCalls.push({ provider, sessionId });
  return RUNNING.has(sessionId);
};

beforeEach(() => {
  probeCalls = [];
  setSessionLivenessProbes({
    claude: makeProbe('claude'),
    codex: makeProbe('codex'),
    opencode: makeProbe('opencode'),
  });
});

const body = (sessionId: string, userId: string | number | null): string =>
  JSON.stringify(readSessionActivity(sessionId, userId));

test('active session in a visible project → { isProcessing: true }', () => {
  const result = readSessionActivity(CLAUDE_SID, MEMBER_USER_ID);
  assert.deepStrictEqual(result, { isProcessing: true });
  assert.strictEqual(typeof result.isProcessing, 'boolean');
  assert.deepStrictEqual(probeCalls, [{ provider: 'claude', sessionId: CLAUDE_SID }]);
});

test('idle session → explicit false that survives serialization', () => {
  const result = readSessionActivity(OPENCODE_SID, MEMBER_USER_ID);
  assert.deepStrictEqual(result, { isProcessing: false });
  assert.strictEqual(result.isProcessing, false, 'false, not undefined');
  const wire = JSON.stringify(result);
  assert.strictEqual(wire, '{"isProcessing":false}');
  assert.ok(Object.prototype.hasOwnProperty.call(JSON.parse(wire), 'isProcessing'));
});

test('the session provider decides which probe answers (no claude-only assumption)', () => {
  readSessionActivity(OPENCODE_SID, MEMBER_USER_ID);
  assert.deepStrictEqual(probeCalls, [{ provider: 'opencode', sessionId: OPENCODE_SID }]);
});

test('unknown session id → { isProcessing: false }, nothing else', () => {
  const result = readSessionActivity(UNKNOWN_SID, MEMBER_USER_ID);
  assert.deepStrictEqual(result, { isProcessing: false });
  assert.deepStrictEqual(Object.keys(result), ['isProcessing']);
});

test('invisible session answers BYTE-IDENTICALLY to an unknown one, while running', () => {
  // PRIVATE_CLAUDE_SID is in RUNNING: a leak would show up as `true` here.
  const invisible = body(PRIVATE_CLAUDE_SID, OUTSIDER_USER_ID);
  const unknown = body(UNKNOWN_SID, OUTSIDER_USER_ID);
  assert.strictEqual(invisible, unknown);
  assert.strictEqual(invisible, '{"isProcessing":false}');
});

test('the same private session IS reported to its member (the gate is real, not a blanket false)', () => {
  assert.deepStrictEqual(readSessionActivity(PRIVATE_CLAUDE_SID, MEMBER_USER_ID), {
    isProcessing: true,
  });
});

test('a refused caller never reaches the liveness probe (no hidden state is read)', () => {
  readSessionActivity(CODEX_SID, OUTSIDER_USER_ID);
  assert.deepStrictEqual(probeCalls, [], 'probe must not run for an invisible session');
});

test('unresolvable caller (null user id) is refused on a private project', () => {
  assert.deepStrictEqual(readSessionActivity(PRIVATE_CLAUDE_SID, null), { isProcessing: false });
  assert.deepStrictEqual(probeCalls, []);
});

test('string user id from the JWT is coerced like the websocket gate does', () => {
  assert.deepStrictEqual(readSessionActivity(PRIVATE_CLAUDE_SID, String(MEMBER_USER_ID)), {
    isProcessing: true,
  });
  assert.deepStrictEqual(readSessionActivity(PRIVATE_CLAUDE_SID, String(OUTSIDER_USER_ID)), {
    isProcessing: false,
  });
});

test('no probes injected → fail-closed false, never a throw', () => {
  resetSessionLivenessProbes();
  assert.deepStrictEqual(readSessionActivity(CLAUDE_SID, MEMBER_USER_ID), { isProcessing: false });
});

test('a session row with no provider falls back to the claude probe', () => {
  // Mirrors the websocket dispatcher, whose `else` branch is claude. The row must
  // exist: since 5ec5556c5 an unknown id fails visibility closed and is never probed.
  setSessionLivenessProbes({ claude: makeProbe('claude') });
  readSessionActivity(UNKNOWN_SID, MEMBER_USER_ID);
  assert.deepStrictEqual(probeCalls, []);
  readSessionActivity(NO_PROVIDER_SID, MEMBER_USER_ID);
  assert.deepStrictEqual(probeCalls, [{ provider: 'claude', sessionId: NO_PROVIDER_SID }]);
});

test('a provider with no injected probe answers false instead of throwing', () => {
  setSessionLivenessProbes({ claude: makeProbe('claude') });
  probeCalls = [];
  // OPENCODE_SID resolves to provider 'opencode'; only claude is wired, so the
  // claude fallback answers (and reports it as not running).
  assert.deepStrictEqual(readSessionActivity(OPENCODE_SID, MEMBER_USER_ID), {
    isProcessing: false,
  });
});

test('a probe that leaks a non-boolean is coerced at this boundary', () => {
  setSessionLivenessProbes({
    claude: (() => undefined) as unknown as (sessionId: string) => boolean,
  });
  const result = readSessionActivity(CLAUDE_SID, MEMBER_USER_ID);
  assert.strictEqual(result.isProcessing, false);
  assert.strictEqual(JSON.stringify(result), '{"isProcessing":false}');
});
