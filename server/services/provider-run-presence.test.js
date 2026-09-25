/**
 * provider-run-presence.test.js (B-395)
 *
 * The "Running" badge was a Claude-only feature because `registerSessionProcess`
 * had exactly one caller. Every other provider now goes through the handle under
 * test here, and the three failure modes that would each strand a badge on
 * screen forever are the three things asserted:
 *
 *   1. a run whose real session id arrives late must MOVE its registration, not
 *      add a second one (else the temporary key keeps a badge on a row that no
 *      longer exists);
 *   2. `end()` must be idempotent, because provider runs reach a terminal state
 *      through several paths at once (close + error + a notify helper);
 *   3. a run with no session id yet must stay silent until it has one, and must
 *      then register with whatever pid was learned in between.
 *
 * The monitor is mocked: this file is about the handle's bookkeeping, not about
 * /proc (that is covered by session-process-monitor.reap.test.js against a real
 * pid).
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const registrations = [];
const unregistrations = [];

mock.module('./session-process-monitor.js', {
  namedExports: {
    PROCESS_TAG_ENV_VAR: 'CCUI_PROCESS_TAG',
    registerSessionProcess: (sessionId, details) => registrations.push({ sessionId, ...details }),
    unregisterSessionProcess: (sessionId) => unregistrations.push(sessionId),
  },
});

const { beginProviderRun } = await import('./provider-run-presence.js');

const writer = { userId: 7, send() {} };

function reset() {
  registrations.length = 0;
  unregistrations.length = 0;
}

test('registers immediately when the session id is known at spawn', () => {
  reset();
  beginProviderRun({
    provider: 'cursor',
    writer,
    sessionId: 'sess-1',
    projectPath: '/w',
    pid: 4242,
  });

  assert.equal(registrations.length, 1);
  assert.partialDeepStrictEqual(registrations[0], {
    sessionId: 'sess-1',
    provider: 'cursor',
    pid: 4242,
    projectPath: '/w',
  });
});

test('rekey moves the registration instead of adding a second one', () => {
  reset();
  const run = beginProviderRun({ provider: 'opencode', writer, sessionId: 'tmp-key', pid: 11 });
  run.rekey('real-id');

  assert.deepEqual(
    unregistrations,
    ['tmp-key'],
    'the temporary key is released — otherwise its badge outlives the run',
  );
  assert.deepEqual(registrations.map((r) => r.sessionId), ['tmp-key', 'real-id']);
  assert.equal(registrations.at(-1).pid, 11, 'the known pid carries over to the new key');
});

test('rekey to the same id is a no-op, so it is safe on every stream event', () => {
  reset();
  const run = beginProviderRun({ provider: 'codex', writer, sessionId: 'same' });
  run.rekey('same');
  run.rekey(null);
  run.rekey(undefined);

  assert.equal(registrations.length, 1);
  assert.deepEqual(unregistrations, []);
});

test('a run with no id yet stays silent until rekey, and keeps the pid learned meanwhile', () => {
  reset();
  const run = beginProviderRun({ provider: 'opencode', writer, sessionId: null });
  assert.deepEqual(registrations, [], 'nothing to register a badge against yet');

  run.setPid(999);
  assert.deepEqual(registrations, [], 'a pid alone is not a session');

  run.rekey('discovered');
  assert.equal(registrations.length, 1);
  assert.partialDeepStrictEqual(registrations[0], { sessionId: 'discovered', pid: 999 });
});

test('end is idempotent — several terminal paths may all call it', () => {
  reset();
  const run = beginProviderRun({ provider: 'kimi', writer, sessionId: 'sess-2' });
  run.end();
  run.end();
  run.end();

  assert.deepEqual(unregistrations, ['sess-2'], 'exactly one unregister');
});

test('rekey and setPid after end do nothing — a finished run never re-registers', () => {
  reset();
  const run = beginProviderRun({ provider: 'kimi', writer, sessionId: 'sess-3' });
  run.end();
  run.rekey('late-id');
  run.setPid(5);

  assert.equal(registrations.length, 1, 'only the initial registration');
  assert.deepEqual(unregistrations, ['sess-3']);
});

test('a writer-less run never registers (nothing to broadcast through)', () => {
  reset();
  const run = beginProviderRun({ provider: 'glm', writer: null, sessionId: 'sess-4' });
  run.rekey('other');
  run.end();

  assert.deepEqual(registrations, []);
  assert.deepEqual(unregistrations, []);
});

test('a runTag is forwarded so the monitor can resolve a hidden pid from /proc', () => {
  reset();
  beginProviderRun({ provider: 'codex', writer, sessionId: 'sess-5', runTag: 'codex-tag' });

  assert.equal(registrations[0].runTag, 'codex-tag');
  assert.equal(registrations[0].pid, null, 'no pid known yet — the tag is what resolves it');
});
