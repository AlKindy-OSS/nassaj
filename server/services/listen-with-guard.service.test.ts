import assert from 'node:assert/strict';
import test from 'node:test';

import net from 'node:net';
import http from 'node:http';

// `net` is used by reserveEphemeralPort to grab a free OS port.

import {
  listenWithGuard,
  resolveBindWindowMs,
  HEALTH_SERVICE_MARKER,
  type ListenWithGuardDeps,
  type HealthProbeResult,
} from './listen-with-guard.service.js';

type Call = { name: string; args: unknown[] };

/**
 * Builds a fake http.Server whose listen() outcome is scripted per attempt.
 * `outcomes[i]` controls attempt i: 'ok' -> calls the listening callback;
 * 'inuse' -> emits an EADDRINUSE error; 'fatal' -> emits a generic error.
 */
function buildHarness(
  outcomes: Array<'ok' | 'inuse' | 'fatal'>,
  overrides: Partial<ListenWithGuardDeps> = {},
) {
  const calls: Call[] = [];
  let attemptIndex = 0;
  let errorListener: ((err: NodeJS.ErrnoException) => void) | null = null;

  const server: ListenWithGuardDeps['server'] = {
    once: (_event, listener) => {
      errorListener = listener;
      return server;
    },
    removeListener: () => {
      errorListener = null;
      calls.push({ name: 'removeListener', args: [] });
      return server;
    },
    listen: (port, host, callback) => {
      const outcome = outcomes[Math.min(attemptIndex, outcomes.length - 1)];
      attemptIndex += 1;
      calls.push({ name: 'listen', args: [port, host] });
      // Resolve asynchronously, mirroring net.Server semantics.
      queueMicrotask(() => {
        if (outcome === 'ok') {
          callback();
        } else if (outcome === 'inuse') {
          const err = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
          err.code = 'EADDRINUSE';
          errorListener?.(err);
        } else {
          const err = new Error('EACCES') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          errorListener?.(err);
        }
      });
      return server;
    },
  };

  let clock = 0;
  const deps: ListenWithGuardDeps = {
    server,
    port: 3004,
    host: '0.0.0.0',
    onListening: () => calls.push({ name: 'onListening', args: [] }),
    exit: (code: number) => calls.push({ name: 'exit', args: [code] }),
    bindWindowMs: 2000,
    retryDelayMs: 500,
    // Default: the holder is our own predecessor, so a held port exits cleanly.
    // Individual tests override this to exercise the foreign/inconclusive paths.
    probeHealth: async (): Promise<HealthProbeResult> => {
      calls.push({ name: 'probeHealth', args: [] });
      return 'ours';
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    sleep: async (ms: number) => { clock += ms; calls.push({ name: 'sleep', args: [ms] }); },
    now: () => clock,
    ...overrides,
  };

  return { deps, calls, names: () => calls.map((c) => c.name) };
}

test('resolveBindWindowMs: honours non-negative integers, falls back otherwise', () => {
  assert.equal(resolveBindWindowMs('12000'), 12000);
  assert.equal(resolveBindWindowMs('0'), 0);
  assert.equal(resolveBindWindowMs('-1'), 8000);
  assert.equal(resolveBindWindowMs('abc'), 8000);
  assert.equal(resolveBindWindowMs(undefined), 8000);
  assert.equal(resolveBindWindowMs('', 5000), 5000);
});

test('binds on first attempt: calls onListening, never exits, drops the transient error listener', async () => {
  const { deps, calls, names } = buildHarness(['ok']);

  await listenWithGuard(deps);

  assert.ok(names().includes('onListening'), 'onListening must fire');
  assert.ok(names().includes('removeListener'), 'transient error listener removed after bind');
  assert.ok(!names().includes('exit'), 'a clean first bind must not exit');
  assert.equal(calls.filter((c) => c.name === 'listen').length, 1);
});

test('tolerates a brief EADDRINUSE overlap then binds (healthy drain handoff)', async () => {
  // Two in-use attempts (predecessor still draining) then success.
  const { deps, calls, names } = buildHarness(['inuse', 'inuse', 'ok']);

  await listenWithGuard(deps);

  assert.equal(calls.filter((c) => c.name === 'listen').length, 3, 'retried until bound');
  assert.equal(calls.filter((c) => c.name === 'sleep').length, 2, 'backed off between retries');
  assert.ok(names().includes('onListening'));
  assert.ok(!names().includes('exit'), 'a successful late bind must not exit');
});

test('wedged OWN predecessor: probes /health, sees ours, exits cleanly with 0 (no crash-loop)', async () => {
  // Always in use; window 2000ms / retry 500ms -> ~4 retries then give up.
  // Default harness probe reports 'ours', i.e. a draining nassaj predecessor.
  const { deps, calls } = buildHarness(['inuse'], { bindWindowMs: 2000, retryDelayMs: 500 });

  await listenWithGuard(deps);

  assert.ok(calls.some((c) => c.name === 'probeHealth'), 'must probe the holder before giving up');
  // The decisive B-41 guarantee: a port held by US yields a CLEAN exit, never 1.
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
  assert.ok(
    !calls.some((c) => c.name === 'exit' && c.args[0] === 1),
    'a held port owned by our predecessor must never produce a crash exit (code 1)',
  );
});

test('wedged FOREIGN holder: probe reports foreign, exits 1 (errored, no silent death)', async () => {
  const { deps, calls } = buildHarness(['inuse'], {
    bindWindowMs: 2000,
    retryDelayMs: 500,
    probeHealth: async (): Promise<HealthProbeResult> => {
      calls.push({ name: 'probeHealth', args: [] });
      return 'foreign';
    },
  });

  await listenWithGuard(deps);

  assert.ok(calls.some((c) => c.name === 'probeHealth'), 'must probe the holder');
  // A stranger on our port must surface as errored, not a silent exit(0).
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [1] });
});

test('wedged INCONCLUSIVE probe: benefit of the doubt → clean exit 0', async () => {
  const { deps, calls } = buildHarness(['inuse'], {
    bindWindowMs: 2000,
    retryDelayMs: 500,
    probeHealth: async (): Promise<HealthProbeResult> => 'inconclusive',
  });

  await listenWithGuard(deps);

  // A flaky probe must not crash-loop the box: treat as our predecessor.
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
});

test('a non-EADDRINUSE bind error is fatal: exits 1', async () => {
  const { deps, calls } = buildHarness(['fatal']);

  await listenWithGuard(deps);

  assert.deepEqual(calls.at(-1), { name: 'exit', args: [1] });
  assert.ok(!calls.some((c) => c.name === 'onListening'));
});

test('bindWindowMs=0 gives exactly one attempt before a clean give-up', async () => {
  const { deps, calls } = buildHarness(['inuse'], { bindWindowMs: 0 });

  await listenWithGuard(deps);

  assert.equal(calls.filter((c) => c.name === 'listen').length, 1, 'single bounded attempt');
  assert.equal(calls.filter((c) => c.name === 'sleep').length, 0, 'no backoff sleep when window is 0');
  assert.deepEqual(calls.at(-1), { name: 'exit', args: [0] });
});

// ---- real-port smoke tests (item 4: no fakes — actual sockets) -------------
//
// These drive a REAL http.Server through listenWithGuard against a REAL,
// genuinely-occupied OS port, proving the guard's behaviour end-to-end rather
// than against a scripted fake. They replace the unverified smoke-test claim in
// the ecafb22 commit message.

/** Grabs an ephemeral port by binding then releasing a throwaway listener. */
function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

test('real port FREE: binds on the first try and never exits', async () => {
  const port = await reserveEphemeralPort();
  const server = http.createServer();
  let bound = false;
  let exitCode: number | null = null;

  try {
    await listenWithGuard({
      server,
      port,
      host: '127.0.0.1',
      onListening: () => { bound = true; },
      exit: (code) => { exitCode = code; },
      bindWindowMs: 2000,
      retryDelayMs: 100,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    assert.equal(bound, true, 'a free port must bind');
    assert.equal(exitCode, null, 'a clean bind must not exit');
    assert.equal(server.listening, true, 'the http.Server must actually be listening');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('real port HELD by a FOREIGN HTTP server: probe sees no nassaj marker → exit 1', async () => {
  // A real HTTP server that answers /health but is NOT us (different service
  // identity) stands in for a stranger squatting on our port.
  const stranger = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'some-other-app' }));
  });
  const port = await new Promise<number>((resolve) => {
    stranger.listen(0, '127.0.0.1', () => {
      const addr = stranger.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  const server = http.createServer();
  let exitCode: number | null = null;
  let bound = false;

  try {
    await listenWithGuard({
      server,
      port,
      host: '127.0.0.1',
      onListening: () => { bound = true; },
      exit: (code) => { exitCode = code; },
      // Tight window so the test is fast: one quick retry then probe.
      bindWindowMs: 150,
      retryDelayMs: 50,
      probeTimeoutMs: 1000,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    assert.equal(bound, false, 'must not bind a held port');
    // A stranger answering /health without our marker must surface as errored,
    // never a silent exit(0).
    assert.equal(exitCode, 1, 'a foreign holder on our port must exit 1 (errored)');
  } finally {
    await new Promise<void>((r) => stranger.close(() => r()));
  }
});

test('real port HELD by one of OURS (a /health-reporting server): probe sees marker → clean exit 0', async () => {
  // Stand up a real HTTP server that answers /health exactly like nassaj does,
  // then prove listenWithGuard treats it as our own predecessor.
  const ours = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: HEALTH_SERVICE_MARKER }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const port = await new Promise<number>((resolve) => {
    ours.listen(0, '127.0.0.1', () => {
      const addr = ours.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  const server = http.createServer();
  let exitCode: number | null = null;
  let bound = false;

  try {
    await listenWithGuard({
      server,
      port,
      host: '127.0.0.1',
      onListening: () => { bound = true; },
      exit: (code) => { exitCode = code; },
      bindWindowMs: 150,
      retryDelayMs: 50,
      probeTimeoutMs: 1000,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    assert.equal(bound, false, 'must not bind the held port');
    assert.equal(exitCode, 0, 'a port held by one of OURS must yield a clean exit (0), never 1');
  } finally {
    await new Promise<void>((r) => ours.close(() => r()));
  }
});
