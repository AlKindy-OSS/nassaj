import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createShutdownDrain,
  resolveDrainTimeoutMs,
  WS_CLOSE_GOING_AWAY,
  type ShutdownDrainDeps,
} from './shutdown-drain.service.js';

// ---- test harness ---------------------------------------------------------

type Call = { name: string; args: unknown[] };

function buildHarness(overrides: Partial<ShutdownDrainDeps> & {
  /** Sequence of per-provider counts returned on successive polls. */
  countsSequence?: Record<string, number>[];
} = {}) {
  const calls: Call[] = [];
  const wsClients = [
    { close: (code?: number, reason?: string) => calls.push({ name: 'ws.close', args: [code, reason] }) },
    { close: (code?: number, reason?: string) => calls.push({ name: 'ws.close', args: [code, reason] }) },
  ];

  const countsSequence = overrides.countsSequence ?? [{ claude: 0 }];
  let pollIndex = 0;
  const countActiveSessionsByProvider = () => {
    const counts = countsSequence[Math.min(pollIndex, countsSequence.length - 1)];
    pollIndex += 1;
    return counts;
  };

  let clock = 0;
  const deps: ShutdownDrainDeps = {
    server: {
      close: () => calls.push({ name: 'server.close', args: [] }),
      closeIdleConnections: () => calls.push({ name: 'server.closeIdleConnections', args: [] }),
    },
    wss: { clients: wsClients },
    countActiveSessionsByProvider,
    stopAllPlugins: async () => { calls.push({ name: 'stopAllPlugins', args: [] }); },
    exit: (code: number) => calls.push({ name: 'exit', args: [code] }),
    pollMs: 10,
    logger: { log: () => {}, warn: () => {} },
    sleep: async (ms: number) => { clock += ms; calls.push({ name: 'sleep', args: [ms] }); },
    now: () => clock,
    ...overrides,
  };
  return { deps, calls, names: () => calls.map((c) => c.name) };
}

// ---- resolveDrainTimeoutMs -------------------------------------------------

test('resolveDrainTimeoutMs: positive integers pass through, everything else means no deadline (B-N-DRAIN owner default)', () => {
  // An explicit positive integer opts into a bounded drain.
  assert.equal(resolveDrainTimeoutMs('300000'), 300000);
  // Everything else — unset, blank, non-numeric, zero, negative — is the
  // owner-mandated unbounded drain (0 = no deadline). The EADDRINUSE crash-loop
  // is broken by the listen guard, not by capping the drain (see B-41 / T-95).
  assert.equal(resolveDrainTimeoutMs('0'), 0);
  assert.equal(resolveDrainTimeoutMs('-5'), 0);
  assert.equal(resolveDrainTimeoutMs('abc'), 0);
  assert.equal(resolveDrainTimeoutMs(undefined), 0);
  assert.equal(resolveDrainTimeoutMs(''), 0);
});

// ---- port release (B-23) ---------------------------------------------------

test('first signal releases the listener BEFORE any waiting: server.close, ws clients closed with 1001, idle connections dropped', async () => {
  const { deps, calls, names } = buildHarness({ countsSequence: [{ claude: 0 }] });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');

  // Release steps come first, in order, then shutdown.
  assert.deepEqual(names(), [
    'server.close',
    'ws.close',
    'ws.close',
    'server.closeIdleConnections',
    'stopAllPlugins',
    'exit',
  ]);
  const wsCloses = calls.filter((c) => c.name === 'ws.close');
  for (const c of wsCloses) {
    assert.equal(c.args[0], WS_CLOSE_GOING_AWAY);
  }
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
});

test('port is released immediately even when sessions are still active (the drain waits AFTER closing the listener)', async () => {
  const { deps, names } = buildHarness({
    countsSequence: [{ claude: 2 }, { claude: 1 }, { claude: 0 }],
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGTERM');

  const order = names();
  assert.equal(order[0], 'server.close', 'listener must be closed before any drain wait');
  assert.ok(order.indexOf('server.close') < order.indexOf('sleep'));
  assert.deepEqual(order.at(-1), 'exit');
});

test('server.close throwing does not prevent the drain from completing', async () => {
  const { deps, names } = buildHarness({
    server: {
      close: () => { throw new Error('already closed'); },
    },
    countsSequence: [{ claude: 0 }],
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');

  assert.ok(names().includes('exit'));
});

// ---- drain semantics (unchanged from B-N-DRAIN) ----------------------------

test('waits until all sessions finish, then stops plugins and exits 0', async () => {
  const { deps, calls } = buildHarness({
    countsSequence: [
      { claude: 2, codex: 1 },
      { claude: 1, codex: 0 },
      { claude: 0, codex: 0 },
    ],
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');

  const sleeps = calls.filter((c) => c.name === 'sleep').length;
  assert.equal(sleeps, 2, 'one poll per non-zero count after the initial check');
  assert.deepEqual(calls.at(-2), { name: 'stopAllPlugins', args: [] });
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
});

test('with a deadline, exits anyway when sessions never finish', async () => {
  const { deps, calls } = buildHarness({
    countsSequence: [{ claude: 1 }],
    drainTimeoutMs: 25,
    pollMs: 10,
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGTERM');

  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
  const sleeps = calls.filter((c) => c.name === 'sleep').length;
  assert.ok(sleeps >= 2 && sleeps <= 3, `expected ~3 polls within the deadline, got ${sleeps}`);
});

test('second signal forces an immediate exit without re-running the drain', async () => {
  const { deps, calls } = buildHarness({
    countsSequence: [{ claude: 1 }, { claude: 0 }],
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');
  const callsAfterFirst = calls.length;

  await drain('SIGINT');

  const extra = calls.slice(callsAfterFirst);
  assert.deepEqual(extra, [{ name: 'exit', args: [0] }], 'second signal must only exit');
});

// ---- pending approvals are cancelled BEFORE the sockets close --------------
//
// A restart mid-turn used to surface to the user as "The user doesn't want to
// proceed with this tool use" for a tool they never refused: the approval was
// still waiting on a websocket the drain had just shut. Measured 2026-07-27 —
// the refusals land in the same SECOND as `[DRAIN] SIGINT: listener closed`.
// Ordering is the whole point: cancelling AFTER the sockets close would be too
// late, so the test asserts the sequence, not merely that the hook ran.

test('drain cancels pending approvals before closing any socket', async () => {
  const { deps, calls } = buildHarness({
    cancelPendingApprovals: () => {
      calls.push({ name: 'cancelPendingApprovals', args: [] });
      return 2;
    },
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');

  const cancelAt = calls.findIndex((c) => c.name === 'cancelPendingApprovals');
  const serverCloseAt = calls.findIndex((c) => c.name === 'server.close');
  const firstWsCloseAt = calls.findIndex((c) => c.name === 'ws.close');
  assert.ok(cancelAt >= 0, 'the hook must run');
  assert.ok(cancelAt < serverCloseAt, 'must cancel before the listener closes');
  assert.ok(cancelAt < firstWsCloseAt, 'must cancel before any client socket closes');
});

test('a throwing cancel hook can never stop the drain', async () => {
  const { deps, calls } = buildHarness({
    cancelPendingApprovals: () => { throw new Error('registry exploded'); },
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');

  assert.ok(calls.some((c) => c.name === 'server.close'), 'the port must still be released');
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] }, 'the process must still exit');
});

test('omitting the hook preserves the previous behaviour exactly', async () => {
  const { deps, calls } = buildHarness();
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');

  assert.ok(!calls.some((c) => c.name === 'cancelPendingApprovals'));
  assert.ok(calls.some((c) => c.name === 'server.close'));
});
