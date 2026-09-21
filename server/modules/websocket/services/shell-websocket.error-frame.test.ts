/**
 * shell-websocket.error-frame.test.ts — the terminal pane's error contract.
 *
 * Two opposite regressions are pinned here, because fixing either one alone is
 * how this surface has broken twice:
 *
 *   1. A KNOWN diagnostic must reach the pane. The only launch failure this
 *      fleet has produced since June is the missing `claude` binary, and node
 *      owners do not read `pm2 logs`; a pane that says only "the request could
 *      not be completed" sends them nowhere.
 *   2. An UNKNOWN exception must not. `error.message` is an unbounded source and
 *      routinely carries absolute paths; the pane is copied into screenshots and
 *      bug reports.
 *
 * Test 1 drives the real `handleShellConnection` with a real
 * `resolveRealClaudeBinary` failure (no fabricated message: PATH and
 * CLAUDE_CLI_PATH are pointed at a directory with no claude in it), so what is
 * asserted is the message the server genuinely throws in the field.
 *
 * Runner: Node built-in test runner with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

// --- Module mocks (registered before importing the service) ------------------

function makeFakePty() {
  return {
    onData(_cb: (c: string) => void) {},
    onExit(_cb: (e: { exitCode: number; signal?: number }) => void) {},
    write(_d: string) {},
    resize(_c: number, _r: number) {},
    kill() {},
  };
}

let spawnCount = 0;
mock.module('node-pty', {
  defaultExport: {
    spawn: () => {
      spawnCount += 1;
      return makeFakePty();
    },
  },
});

/**
 * The isolation seam, stubbed to hand the handler an env whose PATH and HOME are
 * a scratch directory with no `claude` in it. The managed-launcher preflight then
 * fails for real, exactly as it does on a node without the CLI installed.
 */
let isolatedEnv: Record<string, string> = {};
mock.module('@/services/isolation/resolve-provider-env.js', {
  namedExports: {
    resolveProviderEnv: () => ({ ...isolatedEnv }),
  },
});

const { handleShellConnection } = await import('./shell-websocket.service.js');
const { buildShellErrorFrame, sanitizeTerminalText, SHELL_ERROR_UNCLASSIFIED } = await import(
  './shell-error-frame.js'
);

// --- Harness -----------------------------------------------------------------

const WS_OPEN_STATE = 1;

function makeFakeWs() {
  const sent: { type?: string; data?: string; message?: string }[] = [];
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  return {
    readyState: WS_OPEN_STATE,
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close() {},
    on(event: string, cb: (arg: unknown) => void) {
      (listeners[event] ||= []).push(cb);
    },
    emit(event: string, arg: unknown) {
      (listeners[event] || []).forEach((cb) => cb(arg));
    },
  };
}

const deps = {
  acquireWriterLease: () => ({ release() {} }),
  getSessionById: () => null,
  stripAnsiSequences: (s: string) => s,
  normalizeDetectedUrl: () => null,
  extractUrlsFromText: () => [],
  shouldAutoOpenUrlFromOutput: () => false,
} as unknown as Parameters<typeof handleShellConnection>[2];

function initMessage(projectPath: string) {
  return JSON.stringify({
    type: 'init',
    projectPath,
    provider: 'claude',
    sessionId: null,
    hasSession: false,
    initialCommand: null,
    isPlainShell: false,
    cols: 80,
    rows: 24,
  });
}

/** Same isolation idiom as shell-websocket.pty-isolation.test.ts. */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'shell-error-frame-db-'));
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

// --- 1. The known diagnostic reaches the pane --------------------------------

test('a missing claude binary tells the pane WHAT is wrong and HOW to fix it', async () => {
  const emptyBin = await mkdtemp(path.join(os.tmpdir(), 'shell-error-frame-bin-'));
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'shell-error-frame-home-'));
  isolatedEnv = { PATH: emptyBin, HOME: fakeHome, CLAUDE_CLI_PATH: 'claude' };
  spawnCount = 0;

  try {
    await withIsolatedDatabase(() => {
      const ws = makeFakeWs();
      handleShellConnection(ws as never, { user: { id: 7, role: 'user' } } as never, deps);
      ws.emit('message', initMessage(process.cwd()));

      assert.equal(spawnCount, 0, 'the preflight failed before any PTY was spawned');
      const frames = ws.sent.filter((f) => f.type === 'output');
      assert.equal(frames.length, 1, 'exactly one error frame reached the pane');
      const pane = frames[0].data ?? '';

      // The user-facing half of the contract.
      assert.match(pane, /Claude executable not found/, 'the pane names the actual cause');
      assert.match(pane, /CLAUDE_CLI_PATH/, 'the pane names the remedy');
      assert.match(pane, /\[shell_claude_binary_missing\]/, 'the pane carries the reason code');

      // The leak half: the thrown message interpolates the probed candidate and
      // HOME. Neither may be published.
      assert.ok(!pane.includes(fakeHome), 'the internal HOME path is not published');
      assert.ok(!pane.includes(emptyBin), 'the probed PATH entry is not published');
      assert.ok(
        !pane.includes('well-known install dirs'),
        'the raw thrown tail is not echoed verbatim'
      );
    });
  } finally {
    await rm(emptyBin, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

// --- 2. An unlisted exception publishes nothing ------------------------------

test('an unlisted exception carrying an internal path never reaches the pane as-is', () => {
  const secret = '/home/operator/.local/share/nassaj-dev/db.sqlite';
  const frame = buildShellErrorFrame(`EACCES: permission denied, open '${secret}'`);

  assert.equal(frame.code, SHELL_ERROR_UNCLASSIFIED);
  assert.ok(!frame.data.includes(secret), 'the path is not published');
  assert.ok(!frame.data.includes('EACCES'), 'the raw message is not published');
  assert.match(frame.data, /Terminal error: the request could not be completed\./);
});

test('a diagnostic is matched by prefix, so its interpolated tail is dropped', () => {
  const frame = buildShellErrorFrame(
    'Claude executable not found before installing the managed terminal launcher '
    + '(looked up "claude" on PATH and in the well-known install dirs under HOME=/home/owner; '
    + 'set CLAUDE_CLI_PATH to the absolute path of the claude binary)'
  );
  assert.equal(frame.code, 'shell_claude_binary_missing');
  assert.ok(!frame.data.includes('/home/owner'), 'the interpolated HOME is dropped');
  assert.match(frame.data, /Claude executable not found/);
});

// --- 3. ANSI/OSC sanitising --------------------------------------------------

test('control bytes are stripped, so a crafted message cannot drive the terminal', () => {
  // OSC 0 (window title), CSI 2J (clear screen), a bare BEL and a C1 CSI.
  const hostile = '\u001b]0;pwned\u0007\u001b[2Jgone\u009b31m\u007f';
  assert.equal(sanitizeTerminalText(hostile), ']0;pwned[2Jgone31m');
  assert.equal(sanitizeTerminalText('keeps\ttabs\r\nand newlines'), 'keeps\ttabs\r\nand newlines');
});

test('the only escapes in an error frame are the two the builder wrote', () => {
  const frame = buildShellErrorFrame('\u001b]0;pwned\u0007boom');
  const escapes = frame.data.match(/\u001b/g) ?? [];
  assert.equal(escapes.length, 2, 'open colour + reset, nothing else');
  assert.ok(frame.data.startsWith('\r\n\u001b[31m'));
  assert.ok(frame.data.endsWith('\u001b[0m\r\n'));
});

// --- 4. The same rule on the success path ------------------------------------

test('a crafted project path cannot smuggle an OSC title sequence into the pane', async () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  // A directory whose NAME is an OSC title sequence. Legal on Linux, and it used
  // to be interpolated into the welcome frame verbatim.
  const hostileRoot = await mkdtemp(
    path.join(os.tmpdir(), `shell-error-frame-${ESC}]0;pwned${BEL}-`)
  );
  isolatedEnv = { PATH: path.dirname(process.execPath), HOME: hostileRoot, CLAUDE_CLI_PATH: process.execPath };
  spawnCount = 0;

  try {
    await withIsolatedDatabase(() => {
      const ws = makeFakeWs();
      handleShellConnection(ws as never, { user: { id: 7, role: 'user' } } as never, deps);
      ws.emit('message', initMessage(hostileRoot));

      assert.equal(spawnCount, 1, 'the PTY spawned, so this is the success path');
      const welcome = ws.sent.filter((f) => f.type === 'output').map((f) => f.data ?? '').join('');
      assert.ok(welcome.includes('pwned'), 'the path is still shown to the user');
      assert.ok(!welcome.includes(BEL), 'the BEL terminator is stripped');
      assert.equal(
        (welcome.match(new RegExp(ESC, 'g')) ?? []).length,
        2,
        'only the cyan open/reset the server wrote itself'
      );
    });
  } finally {
    await rm(hostileRoot, { recursive: true, force: true });
  }
});
