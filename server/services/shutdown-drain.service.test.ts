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
    finalCleanup: async () => { calls.push({ name: 'finalCleanup', args: [] }); },
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

// ---- port release at EXIT TIME (B-319 / ADR-084, supersedes B-23) ----------
//
// B-23 released the port on the FIRST signal, assuming a PM2 successor was
// about to bind it. PM2 fork mode starts the successor only after the old
// process exits, and a stray signal (pkill) has no successor at all — so the
// early release opened a listener-less window for the whole drain (B-129,
// the 2026-07-29 fleet-node pkill incident). The drain must keep serving and
// release only in the instant before exit.

test('with no sessions, exit is immediate: release steps run in order, then plugins, then exit', async () => {
  const { deps, calls, names } = buildHarness({ countsSequence: [{ claude: 0 }] });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');

  assert.deepEqual(names(), [
    'server.close',
    'ws.close',
    'ws.close',
    'server.closeIdleConnections',
    'finalCleanup',
    'exit',
  ]);
  const wsCloses = calls.filter((c) => c.name === 'ws.close');
  for (const c of wsCloses) {
    assert.equal(c.args[0], WS_CLOSE_GOING_AWAY);
  }
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
});

test('B-319 core guarantee: server.close is NEVER called while sessions are still active — the drain keeps serving', async () => {
  const { deps, names } = buildHarness({
    countsSequence: [{ claude: 2 }, { claude: 1 }, { claude: 0 }],
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGTERM');

  const order = names();
  const lastSleep = order.lastIndexOf('sleep');
  const serverClose = order.indexOf('server.close');
  const firstWsClose = order.indexOf('ws.close');
  assert.ok(lastSleep >= 0, 'the drain must actually have waited');
  assert.ok(
    serverClose > lastSleep,
    `listener must stay bound until all sessions finish (server.close at ${serverClose}, last wait at ${lastSleep})`,
  );
  assert.ok(
    firstWsClose > lastSleep,
    'websocket clients must stay connected for the whole drain',
  );
  assert.deepEqual(order.at(-1), 'exit');
});

test('a bounded drain that times out still releases the port on its way out', async () => {
  const { deps, names } = buildHarness({
    countsSequence: [{ claude: 1 }],
    drainTimeoutMs: 25,
    pollMs: 10,
  });
  const drain = createShutdownDrain(deps);

  await drain('SIGTERM');

  const order = names();
  assert.ok(order.indexOf('server.close') > order.lastIndexOf('sleep'));
  assert.ok(order.includes('exit'));
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
  assert.deepEqual(calls.at(-2), { name: 'finalCleanup', args: [] });
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

// B-337: a second signal is only meaningful while the drain is STILL WAITING —
// that is the operator escape hatch. It must tear down (the first signal no
// longer does, post-B-319) without ever entering the poll loop, and it must not
// then be torn down a second time when the loop unwinds.
test('second signal during an unfinished drain releases and exits, exactly once', async () => {
  const { deps, calls, names } = buildHarness({
    countsSequence: [{ claude: 1 }], // never reaches zero on its own
  });
  const drain = createShutdownDrain(deps);

  const first = drain('SIGINT');
  await Promise.resolve(); // let the first call reach its wait
  const duringDrain = names().filter((n) => n !== 'sleep');
  assert.deepEqual(duringDrain, [], 'the first signal must tear nothing down — it keeps serving');

  await drain('SIGINT');
  await first;

  const teardown = names().filter((n) => n !== 'sleep');
  assert.deepEqual(
    teardown,
    ['server.close', 'ws.close', 'ws.close', 'server.closeIdleConnections', 'exit'],
    'exactly one teardown, owned by the escape hatch',
  );
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
});

test('a second signal AFTER the drain already finished is a no-op', async () => {
  const { deps, calls } = buildHarness({ countsSequence: [{ claude: 0 }] });
  const drain = createShutdownDrain(deps);

  await drain('SIGINT');
  const after = calls.length;
  await drain('SIGINT');

  assert.equal(calls.length, after, 'nothing to tear down twice');
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
