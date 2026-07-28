/**
 * session-process-monitor.reap.test.js (B-269)
 *
 * The monitor used to skip a run whose /proc entry had vanished, trusting
 * `unregisterSessionProcess` to arrive via removeSession. That holds for a run
 * whose SDK generator settles — but not for one that never does (the
 * `[WS-DIAG] stream-orphaned` case: the socket dies mid-stream while the
 * generator keeps its entry alive). Such a run stayed registered in presence,
 * inflating "N active conversations" until the server was restarted — the count
 * looked frozen rather than live.
 *
 * The poll now reaps a resolved-but-gone pid after
 * DEAD_PID_MISSES_BEFORE_UNREGISTER consecutive misses, emitting the same
 * terminal 'idle' + presence stop as the normal path. Verified here against a
 * real (spawned, then killed) pid so the /proc read is genuine — a fabricated
 * pid would prove nothing about how /proc actually behaves.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test, { mock } from 'node:test';

const presenceStops = [];
const presenceStarts = [];

mock.module('../modules/websocket/services/presence.service.js', {
  namedExports: {
    presenceRunStarted: (details) => presenceStarts.push(details),
    presenceRunState: () => {},
    presenceRunStopped: (details) => presenceStops.push(details),
  },
});

const openSessionStops = [];
mock.module('../modules/websocket/services/open-sessions.service.js', {
  namedExports: {
    openSessionStarted: () => {},
    openSessionStopped: (sessionId) => openSessionStops.push(sessionId),
  },
});

mock.module('./workflow-liveness.js', {
  namedExports: { registerWorkflowPid: () => {} },
});

const monitor = await import('./session-process-monitor.js');

/** Captures everything the run's writer was asked to send. */
function fakeWriter() {
  return {
    userId: 42,
    sent: [],
    send(payload) {
      this.sent.push(payload);
    },
  };
}

/** Spawns a trivial sleeper and resolves once it is actually dead and reaped. */
async function spawnThenKill() {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const { pid } = child;
  child.kill('SIGKILL');
  await once(child, 'exit');
  return pid;
}

/** Poll interval the monitor arms internally. */
const POLL_INTERVAL_MS = 5000;

test('a resolved pid that vanishes is reaped after two consecutive misses', async (t) => {
  presenceStops.length = 0;
  openSessionStops.length = 0;

  const sessionId = 'orphaned-run';
  const writer = fakeWriter();
  // Kill a REAL child before faking timers, so the /proc read under test is a
  // genuine miss on a genuinely reaped pid rather than an invented number.
  const pid = await spawnThenKill();

  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => t.mock.timers.reset());

  monitor.registerSessionProcess(sessionId, { provider: 'claude', writer, pid });
  assert.equal(writer.sent.at(-1)?.processState, 'running', 'registers as running');

  // First miss: still held — a single unreadable /proc read is not proof.
  t.mock.timers.tick(POLL_INTERVAL_MS);
  assert.deepEqual(presenceStops, [], 'one miss does not tear the run down');

  // Second miss: conclusive.
  t.mock.timers.tick(POLL_INTERVAL_MS);
  assert.deepEqual(
    presenceStops,
    [{ userId: 42, sessionId }],
    'the presence run is stopped, so the active-conversations count drops',
  );
  assert.deepEqual(openSessionStops, [sessionId], 'the open-sessions counter is released');
  assert.equal(
    writer.sent.at(-1)?.processState,
    'idle',
    'viewers receive the same terminal idle as the normal path',
  );

  // Reaping is terminal: further polls must not re-emit anything.
  t.mock.timers.tick(POLL_INTERVAL_MS * 3);
  assert.equal(presenceStops.length, 1, 'a reaped run is not stopped twice');
});

test('a live pid is never reaped', (t) => {
  presenceStops.length = 0;

  const sessionId = 'live-run';
  const writer = fakeWriter();

  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => {
    monitor.unregisterSessionProcess(sessionId);
    t.mock.timers.reset();
  });

  // This very test process is guaranteed to be readable in /proc.
  monitor.registerSessionProcess(sessionId, {
    provider: 'claude',
    writer,
    pid: process.pid,
  });

  t.mock.timers.tick(POLL_INTERVAL_MS * 3);

  assert.deepEqual(presenceStops, [], 'a live process is never reaped');
  assert.equal(writer.sent.at(-1)?.processState, 'running');
});
