/**
 * shell-websocket.reconnect.test.ts — T-1895.
 *
 * When a second socket reattaches to a live PTY session (page reload, second
 * tab), the late `close` of the first socket used to null `session.ws` and arm
 * the 30-minute kill timer, orphaning the new owner. These tests drive the real
 * `handleShellConnection` dispatcher with a mocked node-pty and prove:
 *   - a stale socket's close neither detaches the owner nor schedules a kill;
 *   - the current owner's close keeps the original detach + kill-timer behavior;
 *   - a stale close after forceRestart leaves the new session alone;
 *   - input/resize from a stale socket never reach the PTY.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

process.env.CLAUDE_CLI_PATH = process.execPath;

type FakePty = {
  writes: string[];
  resizes: [number, number][];
  kills: number;
  dataListener: ((chunk: string) => void) | null;
  exitListener: ((e: { exitCode: number; signal?: number }) => void) | null;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: unknown): void;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(): void;
};
const spawnedPtys: FakePty[] = [];

function makeFakePty(): FakePty {
  const pty: FakePty = {
    writes: [],
    resizes: [],
    kills: 0,
    dataListener: null,
    exitListener: null,
    onData(cb) { pty.dataListener = cb; },
    onExit(cb) { pty.exitListener = cb as FakePty['exitListener']; },
    write(d) { pty.writes.push(d); },
    resize(c, r) { pty.resizes.push([c, r]); },
    kill() { pty.kills += 1; },
  };
  return pty;
}

mock.module('node-pty', {
  defaultExport: {
    spawn: () => {
      const pty = makeFakePty();
      spawnedPtys.push(pty);
      return pty;
    },
  },
});

mock.module('@/services/isolation/resolve-provider-env.js', {
  namedExports: {
    resolveProviderEnv: (_userId: unknown, _provider: string, baseEnv: Record<string, string>) => ({ ...baseEnv }),
  },
});

const { handleShellConnection, terminateAllShellSessionsForUpdate } = await import('./shell-websocket.service.js');
// Same leaf seam the PTY service reserves launches through (it opts out of the barrel rule too).
// eslint-disable-next-line boundaries/dependencies
const { hasLiveHarnessLaunch, _resetHarnessLaunches } = await import('@/modules/providers/harness-update/spawn-admission.js');

const PTY_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const WS_OPEN_STATE = 1;
const PROJECT_PATH = process.cwd();

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'pty-reconnect-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function makeFakeWs() {
  const sent: { type?: string; data?: string }[] = [];
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  return {
    readyState: WS_OPEN_STATE,
    sent,
    send(data: string) { sent.push(JSON.parse(data)); },
    close() {},
    on(event: string, cb: (arg?: unknown) => void) { (listeners[event] ||= []).push(cb); },
    emit(event: string, arg?: unknown) { (listeners[event] || []).forEach((cb) => cb(arg)); },
  };
}
type FakeWs = ReturnType<typeof makeFakeWs>;

const deps = {
  acquireWriterLease: () => ({ release() {} }),
  getSessionById: () => null,
  stripAnsiSequences: (s: string) => s,
  normalizeDetectedUrl: () => null,
  extractUrlsFromText: () => [],
  shouldAutoOpenUrlFromOutput: () => false,
} as unknown as Parameters<typeof handleShellConnection>[2];

function initMessage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'init', projectPath: PROJECT_PATH, provider: 'claude', sessionId: null,
    hasSession: false, initialCommand: null, isPlainShell: false, cols: 80, rows: 24, ...overrides,
  });
}

/** Opens a socket for `userId` and sends init; returns the socket. */
function connect(userId: number, overrides: Record<string, unknown> = {}): FakeWs {
  const ws = makeFakeWs();
  handleShellConnection(ws as never, { user: { id: userId, role: 'user' } } as never, deps);
  ws.emit('message', initMessage(overrides));
  return ws;
}

/** Emits PTY output and reports which sockets received it. */
function outputReaches(pty: FakePty, ...sockets: FakeWs[]): boolean[] {
  const marker = `marker-${Math.random()}`;
  pty.dataListener?.(marker);
  return sockets.map((ws) => ws.sent.some((frame) => frame.data?.includes(marker)));
}

/** Closes `ws` under fake timers and advances past the PTY idle timeout. */
function closeAndWaitPastTimeout(ws: FakeWs): void {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    ws.emit('close');
    mock.timers.tick(PTY_SESSION_TIMEOUT_MS + 1);
  } finally {
    mock.timers.reset();
  }
}

test('stale socket close after reattach leaves the new owner attached and alive', async () => {
  await withIsolatedDatabase(() => {
    spawnedPtys.length = 0;
    const a = connect(1801);
    const b = connect(1801);
    assert.equal(spawnedPtys.length, 1, 'B reattached instead of spawning');
    const pty = spawnedPtys[0]!;

    closeAndWaitPastTimeout(a);

    assert.equal(pty.kills, 0, 'no kill timer fired for the stale close');
    assert.deepEqual(outputReaches(pty, a, b), [false, true], 'session.ws is still B');
  });
});

test('current owner close keeps the detach + kill-timer behavior', async () => {
  await withIsolatedDatabase(() => {
    spawnedPtys.length = 0;
    const a = connect(1802);
    const pty = spawnedPtys[0]!;

    closeAndWaitPastTimeout(a);

    assert.equal(pty.kills, 1, 'idle timeout killed the orphaned PTY');
    assert.deepEqual(outputReaches(pty, a), [false], 'session.ws was detached');
  });
});

test('stale close after forceRestart from another socket leaves the new session alone', async () => {
  await withIsolatedDatabase(() => {
    spawnedPtys.length = 0;
    const a = connect(1803);
    const b = connect(1803, { forceRestart: true });
    assert.equal(spawnedPtys.length, 2, 'forceRestart spawned a fresh PTY');
    const [oldPty, newPty] = spawnedPtys as [FakePty, FakePty];
    assert.equal(oldPty.kills, 1, 'forceRestart killed the old PTY');

    closeAndWaitPastTimeout(a);

    assert.equal(newPty.kills, 0, 'the new session was not scheduled for kill');
    assert.deepEqual(outputReaches(newPty, a, b), [false, true]);
  });
});

test('input and resize from a stale socket are ignored; the owner is still served', async () => {
  await withIsolatedDatabase(() => {
    spawnedPtys.length = 0;
    const a = connect(1804);
    const b = connect(1804);
    const pty = spawnedPtys[0]!;

    a.emit('message', JSON.stringify({ type: 'input', data: 'stale' }));
    a.emit('message', JSON.stringify({ type: 'resize', cols: 10, rows: 5 }));
    b.emit('message', JSON.stringify({ type: 'input', data: 'owner' }));
    b.emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

    assert.deepEqual(pty.writes, ['owner']);
    assert.deepEqual(pty.resizes, [[120, 40]]);
  });
});

test('B-1448: the PTY lease names its holder and marks the detached tail until reattach', async () => {
  await withIsolatedDatabase(() => {
    spawnedPtys.length = 0;
    const holders: unknown[] = [];
    const annotations: unknown[] = [];
    const leaseDeps = {
      ...deps,
      acquireWriterLease: (_kind: string, holder: unknown) => {
        holders.push(holder);
        return { release() {}, annotate(patch: unknown) { annotations.push(patch); } };
      },
    } as unknown as Parameters<typeof handleShellConnection>[2];
    const a = makeFakeWs();
    handleShellConnection(a as never, { user: { id: 1805, role: 'user', username: 'sara' } } as never, leaseDeps);
    a.emit('message', initMessage());
    assert.deepEqual(holders, [{ username: 'sara' }]);

    const before = Date.now();
    mock.timers.enable({ apis: ['setTimeout'] });
    try { a.emit('close'); } finally { mock.timers.reset(); }
    const detached = annotations.at(-1) as { detachedUntil: number };
    assert.ok(detached.detachedUntil >= before + PTY_SESSION_TIMEOUT_MS, 'the 30-minute tail is recorded');

    const b = makeFakeWs();
    handleShellConnection(b as never, { user: { id: 1805, role: 'user', username: 'sara' } } as never, leaseDeps);
    b.emit('message', initMessage());
    assert.equal(spawnedPtys.length, 1, 'B reattached');
    assert.deepEqual(annotations.at(-1), { detachedUntil: null }, 'reattached: attached again');
  });
});

test('B-1448 slice 2: closing for an update ends attached and detached shells with a named reason', async () => {
  await withIsolatedDatabase(() => {
    terminateAllShellSessionsForUpdate(); // sessions earlier tests left in the module map
    spawnedPtys.length = 0;
    let released = 0;
    const leaseDeps = {
      ...deps,
      acquireWriterLease: () => ({ release() { released += 1; } }),
    } as unknown as Parameters<typeof handleShellConnection>[2];
    const closes: unknown[] = [];
    const attached = Object.assign(makeFakeWs(), { close(code: number, reason: string) { closes.push({ code, reason }); } });
    handleShellConnection(attached as never, { user: { id: 1901, role: 'user' } } as never, leaseDeps);
    attached.emit('message', initMessage());
    const detached = makeFakeWs();
    handleShellConnection(detached as never, { user: { id: 1902, role: 'user' } } as never, leaseDeps);
    detached.emit('message', initMessage());
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      detached.emit('close');
      assert.equal(terminateAllShellSessionsForUpdate(), 2);
    } finally { mock.timers.reset(); }
    assert.equal(released, 2);
    assert.deepEqual(spawnedPtys.map((pty) => pty.kills), [1, 1]);
    assert.equal(attached.sent.at(-1)?.type, 'error');
    assert.equal((attached.sent.at(-1) as { code?: string }).code, 'update_terminals_closed');
    assert.deepEqual(closes, [{ code: 4404, reason: 'update_terminals_closed' }]);
    assert.equal(terminateAllShellSessionsForUpdate(), 0);
  });
});

test('B-1448 T5: a socket that closed while its lease was awaited gets no orphan PTY', async () => {
  await withIsolatedDatabase(async () => {
    spawnedPtys.length = 0;
    let releaseLease: () => void = () => {};
    let released = 0;
    const pending = new Promise<{ release(): void }>((resolve) => {
      releaseLease = () => resolve({ release() { released += 1; } });
    });
    const leaseDeps = { ...deps, acquireWriterLease: () => pending } as unknown as Parameters<typeof handleShellConnection>[2];
    const ws = makeFakeWs();
    handleShellConnection(ws as never, { user: { id: 1903, role: 'user' } } as never, leaseDeps);
    ws.emit('message', initMessage());
    ws.readyState = 3; // CLOSED while the lease is still being acquired
    ws.emit('close');
    releaseLease();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawnedPtys.length, 0, 'no PTY spawned for a closed socket');
    assert.equal(released, 1, 'the acquired lease was released');
  });
});

test('B-1448 M2: a forced close releases the harness-launch reservation', async () => {
  await withIsolatedDatabase(() => {
    terminateAllShellSessionsForUpdate();
    _resetHarnessLaunches();
    spawnedPtys.length = 0;
    connect(2001);
    assert.equal(spawnedPtys.length, 1);
    assert.equal(hasLiveHarnessLaunch(['claude']), true, 'the provider PTY reserved a launch');
    assert.equal(terminateAllShellSessionsForUpdate(), 1);
    assert.equal(hasLiveHarnessLaunch(['claude']), false, 'liveLaunches back to 0');
  });
});

test('B-1448 M2: an older PTY exiting never ends the newer session under the same key', async () => {
  await withIsolatedDatabase(() => {
    terminateAllShellSessionsForUpdate();
    spawnedPtys.length = 0;
    let released = 0;
    const leaseDeps = {
      ...deps,
      acquireWriterLease: () => ({ release() { released += 1; } }),
    } as unknown as Parameters<typeof handleShellConnection>[2];
    const ws = makeFakeWs();
    handleShellConnection(ws as never, { user: { id: 2002, role: 'user' } } as never, leaseDeps);
    ws.emit('message', initMessage());
    ws.emit('message', initMessage({ forceRestart: true })); // same socket, fresh PTY
    assert.equal(spawnedPtys.length, 2);
    const [oldPty, newPty] = spawnedPtys as [FakePty, FakePty];
    assert.equal(released, 1, 'the restart released the old lease');
    oldPty.exitListener?.({ exitCode: 0 });
    assert.equal(released, 1, 'the old exit did not release the new lease');
    assert.deepEqual(outputReaches(newPty, ws), [true], 'the new session is still live');
    assert.equal(terminateAllShellSessionsForUpdate(), 1, 'and still registered');
  });
});
