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
    onData(cb) { pty.dataListener = cb; },
    onExit() {},
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

const { handleShellConnection } = await import('./shell-websocket.service.js');

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
