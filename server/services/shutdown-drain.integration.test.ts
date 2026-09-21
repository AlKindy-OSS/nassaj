/**
 * Integration test for the drain — B-319 / ADR-084.
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT TEST. The unit test asserts a CALL ORDER
 * against mocks (`server.close` must not fire while sessions are active). That
 * is necessary but not sufficient: the whole incident was about whether a real
 * TCP port keeps answering, and a mock can never fail that way. This test binds
 * a real http.Server + WebSocketServer and probes the port over real sockets
 * while the drain is running.
 *
 * Negative control (run manually on 2026-07-30 against the pre-fix code,
 * e398c30e^): the "served during drain" assertion below yields 0/4 with
 * ECONNREFUSED on every probe — i.e. it reproduces the fleet-node outage in
 * miniature — and 4/4 after the fix. A test that passes on both versions would
 * prove nothing (see the synthetic-fixtures lesson).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { createShutdownDrain } from './shutdown-drain.service.js';

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/** Fresh connection per probe — a pooled keep-alive socket would report a
 *  misleading ECONNRESET after the listener closes instead of ECONNREFUSED. */
function probe(port: number): Promise<{ status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: 2000, agent: false },
      (res) => { res.resume(); resolve({ status: res.statusCode }); },
    );
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
  });
}

function rawConnect(port: number): Promise<{ accepted?: true; error?: string }> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(2000);
    s.once('connect', () => { s.destroy(); resolve({ accepted: true }); });
    s.once('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code }));
    s.once('timeout', () => { s.destroy(); resolve({ error: 'TIMEOUT' }); });
  });
}

async function boot() {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('alive'); });
  const wss = new WebSocketServer({ server });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
  const port = (server.address() as net.AddressInfo).port;
  return { server, wss, port };
}

/**
 * In production `exit` is process.exit, which stops everything. Here it is an
 * injected spy, so the poll loop would spin forever on a never-ending session
 * count; zeroing the count once exit fired simulates the process dying.
 */
function countsAfterExit(seq: Record<string, number>[], exited: () => boolean) {
  let i = 0;
  return () => (exited() ? { claude: 0 } : seq[Math.min(i++, seq.length - 1)]);
}

test('B-319: the port KEEPS SERVING for the whole drain, and is released only at exit', async () => {
  const { server, wss, port } = await boot();
  try {
    assert.equal((await probe(port)).status, 200, 'sanity: serving before the signal');

    let exited: number | null = null;
    const drain = createShutdownDrain({
      server,
      wss,
      countActiveSessionsByProvider: countsAfterExit(
        [{ claude: 2 }, { claude: 2 }, { claude: 1 }, { claude: 1 }, { claude: 0 }],
        () => exited !== null,
      ),
      finalCleanup: async () => {},
      exit: (code: number) => { exited = code; },
      pollMs: 120,
      logger: { log: () => {}, warn: () => {} },
    });

    const probes: Array<{ status?: number; error?: string }> = [];
    const poller = (async () => {
      for (let n = 0; n < 4; n++) { await sleep(90); probes.push(await probe(port)); }
    })();

    await drain('SIGINT');
    await poller;

    const served = probes.filter((p) => p.status === 200).length;
    assert.ok(
      served >= 3,
      `the drain must keep serving (pre-fix this was 0/4, all ECONNREFUSED): ${JSON.stringify(probes)}`,
    );
    assert.equal(exited, 0);

    const after = await rawConnect(port);
    assert.equal(after.error, 'ECONNREFUSED', 'the port must be genuinely released once we exit');
  } finally {
    wss.close();
    server.close();
  }
});

test('B-319: a drain whose sessions never finish still serves — and the second signal is the escape hatch', async () => {
  const { server, wss, port } = await boot();
  try {
    let exited: number | null = null;
    const drain = createShutdownDrain({
      server,
      wss,
      countActiveSessionsByProvider: () => (exited !== null ? { claude: 0 } : { claude: 5 }),
      finalCleanup: async () => {},
      exit: (code: number) => { exited = code; },
      pollMs: 120,
      logger: { log: () => {}, warn: () => {} },
    });

    const run = drain('SIGINT');
    await sleep(260);
    assert.equal(
      (await probe(port)).status,
      200,
      'sessions that never end must not mean an outage — this is the 28-minute incident',
    );

    await drain('SIGINT'); // operator escape hatch
    await run;
    assert.equal(exited, 0);
  } finally {
    wss.close();
    server.close();
  }
});

test('B-337: the second signal still cancels pending approvals and closes sockets', async () => {
  const { server, wss, port } = await boot();
  try {
    const events: string[] = [];
    let exited: number | null = null;
    const drain = createShutdownDrain({
      server,
      wss,
      countActiveSessionsByProvider: () => (exited !== null ? { claude: 0 } : { claude: 5 }),
      finalCleanup: async () => {},
      cancelPendingApprovals: () => { events.push('cancel'); return 2; },
      exit: (code: number) => { events.push('exit'); exited = code; },
      pollMs: 120,
      logger: { log: () => {}, warn: () => {} },
    });

    const run = drain('SIGINT');
    await sleep(200);
    assert.deepEqual(events, [], 'the first signal must not tear anything down — it keeps serving');

    await drain('SIGINT'); // escape hatch
    await run;

    // A bare exit here would leave every waiting approval to die on a vanishing
    // socket, which the user reads as a refusal they never gave.
    assert.deepEqual(events, ['cancel', 'exit'], 'approvals must be cancelled BEFORE the exit');
    const after = await rawConnect(port);
    assert.equal(after.error, 'ECONNREFUSED', 'the escape hatch must still release the port');
  } finally {
    wss.close();
    server.close();
  }
});

test('B-337: a throwing session counter cannot wedge the drain forever', async () => {
  const { server, wss, port } = await boot();
  try {
    let exited: number | null = null;
    const drain = createShutdownDrain({
      server,
      wss,
      countActiveSessionsByProvider: () => { throw new Error('registry exploded'); },
      finalCleanup: async () => {},
      exit: (code: number) => { exited = code; },
      pollMs: 120,
      logger: { log: () => {}, warn: () => {} },
    });

    // Unguarded, this rejects inside a signal handler nobody awaits: no exit,
    // no release, no log — a wedged process until SIGKILL 24h later.
    await drain('SIGINT');
    assert.equal(exited, 0, 'an unreadable registry must fail toward exiting');
    const after = await rawConnect(port);
    assert.equal(after.error, 'ECONNREFUSED');
  } finally {
    wss.close();
    server.close();
  }
});

test('B-319: an already-established socket is not cut mid-drain', async () => {
  const { server, wss, port } = await boot();
  const sock = net.connect(port, '127.0.0.1');
  await new Promise<void>((r) => { sock.once('connect', () => r()); });
  let closedEarly = false;
  sock.on('close', () => { closedEarly = true; });

  try {
    let exited: number | null = null;
    const drain = createShutdownDrain({
      server,
      wss,
      countActiveSessionsByProvider: countsAfterExit(
        [{ claude: 1 }, { claude: 1 }, { claude: 0 }],
        () => exited !== null,
      ),
      finalCleanup: async () => {},
      exit: (code: number) => { exited = code; },
      pollMs: 120,
      logger: { log: () => {}, warn: () => {} },
    });

    const run = drain('SIGTERM');
    await sleep(160);
    assert.equal(closedEarly, false, 'established sockets must survive the drain');
    await run;
    assert.equal(exited, 0);
  } finally {
    sock.destroy();
    wss.close();
    server.close();
  }
});
