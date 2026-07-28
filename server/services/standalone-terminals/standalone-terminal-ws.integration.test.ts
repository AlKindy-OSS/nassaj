/**
 * standalone-terminal-ws.integration.test.ts — T-938 (ADR-063): drives the REAL
 * `handleTerminalConnection` dispatcher (terminal-websocket.service.ts) wired
 * to the REAL registry — the exact binding server/index.js composes — so the
 * WS acceptance criteria are proven end-to-end, not against synthetic deps:
 *
 *   - init with an unknown/foreign id ⇒ error frame (code not_found) then
 *     close 4404; init with no authenticated user ⇒ 4401 with ZERO registry
 *     access (fail-closed, mirrors REQUIRE_PTY_USER).
 *   - attach frame order: attached → full ordered replay → live stream; an
 *     exited terminal's replay is sealed with an `exited` frame.
 *   - socket close does NOT kill the PTY; a later init replays everything.
 *   - a second attach displaces the first with 4409; the second keeps working.
 *   - input on an exited terminal re-sends `exited` (never a throw).
 *
 * This file lives beside the registry (server/services) rather than beside the
 * WS service: the websocket module may not import server/services internals
 * (eslint-plugin-boundaries) — the production wiring crosses that seam in the
 * composition root, and this test mirrors that wiring exactly.
 *
 * Runner: node:test via tsx with --experimental-test-module-mocks. node-pty,
 * the isolation seams and the database barrel are module-mocked exactly like
 * shell-websocket.pty-isolation.test.ts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

// --- Module mocks (before importing registry + service) ----------------------

type FakePty = {
  onDataCb: ((chunk: string) => void) | null;
  onExitCb: ((e: { exitCode: number; signal?: number }) => void) | null;
  writes: string[];
  resizes: { cols: number; rows: number }[];
  killed: number;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  emitData(chunk: string): void;
  emitExit(e: { exitCode: number; signal?: number }): void;
};

function makeFakePty(): FakePty {
  return {
    onDataCb: null,
    onExitCb: null,
    writes: [],
    resizes: [],
    killed: 0,
    onData(cb) {
      this.onDataCb = cb;
    },
    onExit(cb) {
      this.onExitCb = cb;
    },
    write(data) {
      this.writes.push(data);
    },
    resize(cols, rows) {
      this.resizes.push({ cols, rows });
    },
    kill() {
      this.killed += 1;
    },
    emitData(chunk) {
      this.onDataCb?.(chunk);
    },
    emitExit(e) {
      this.onExitCb?.(e);
    },
  };
}

const spawnCalls: { fake: FakePty }[] = [];

mock.module('node-pty', {
  defaultExport: {
    spawn: () => {
      const fake = makeFakePty();
      spawnCalls.push({ fake });
      return fake;
    },
  },
});

mock.module('@/services/isolation/resolve-provider-env.js', {
  namedExports: {
    resolveProviderEnv: (userId: unknown, provider: string, baseEnv: Record<string, string>) => ({
      ...baseEnv,
      __ISOLATED_FOR__: String(userId),
      __ISOLATION_PROVIDER__: provider,
    }),
  },
});

mock.module('@/services/isolation/provider-cage-wiring.js', {
  namedExports: {
    resolveCagedLaunch: (spec: { cmd: string; args?: string[] }) => ({
      cmd: spec.cmd,
      args: spec.args ?? [],
    }),
  },
});

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getProjectPath: () => null,
      isProjectVisibleToUser: () => true,
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});

const registry = await import('./standalone-terminal-registry.js');
const { handleTerminalConnection } = await import(
  '@/modules/websocket/services/terminal-websocket.service.js'
);

// --- Wiring under test: EXACTLY the binding server/index.js composes ----------

let attachCalls = 0;
const dependencies = {
  attachSocket: (
    ...args: Parameters<typeof registry.attachStandaloneTerminalSocket>
  ) => {
    attachCalls += 1;
    return registry.attachStandaloneTerminalSocket(...args);
  },
  writeInput: registry.writeStandaloneTerminalInput,
  resizeTerminal: registry.resizeStandaloneTerminal,
  detachSocket: registry.detachStandaloneTerminalSocket,
} as unknown as Parameters<typeof handleTerminalConnection>[2];

// --- Test doubles --------------------------------------------------------------

const WS_OPEN_STATE = 1;

function makeFakeWs() {
  const sent: Record<string, unknown>[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  return {
    readyState: WS_OPEN_STATE,
    sent,
    closes,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
    },
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ||= []).push(cb);
    },
    emit(event: string, arg?: unknown) {
      (listeners[event] || []).forEach((cb) => cb(arg));
    },
  };
}

function initMessage(terminalId: string, cols = 100, rows = 40): string {
  return JSON.stringify({ type: 'init', terminalId, cols, rows });
}

function makeTempCwd(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createTerminal(userId: number, cwd: string): { id: string; fake: FakePty } {
  const created = registry.createStandaloneTerminal({ userId, cwd });
  assert.equal(created.ok, true, 'test terminal creates fine');
  return {
    id: (created as { terminal: { id: string } }).terminal.id,
    fake: spawnCalls[spawnCalls.length - 1].fake,
  };
}

function resetAll(): void {
  registry.resetStandaloneTerminalsForTest();
  spawnCalls.length = 0;
  attachCalls = 0;
}

// --- 8: fail-closed init guards --------------------------------------------------

test('init with no authenticated user: error frame + 4401, ZERO registry access', () => {
  resetAll();
  const ws = makeFakeWs();
  handleTerminalConnection(ws as never, {} as never, dependencies);
  ws.emit('message', initMessage('term_whatever'));

  assert.equal(attachCalls, 0, 'the registry was never consulted');
  assert.equal(spawnCalls.length, 0, 'nothing was spawned');
  assert.deepEqual(ws.sent, [
    {
      type: 'error',
      message: 'Authentication required for terminal session',
      code: 'auth_required',
    },
  ]);
  assert.deepEqual(ws.closes, [{ code: 4401, reason: 'Authentication required' }]);
});

test('init as a non-privileged user (role "user"): forbidden frame + 4403, ZERO registry access', () => {
  resetAll();
  const cwd = makeTempCwd('term-ws-role-');
  try {
    // A real, owned terminal exists — proving the refusal is by ROLE, not by
    // ownership/existence: a regular member is blocked before any lookup.
    const { id } = createTerminal(30, cwd);
    const before = attachCalls;

    const ws = makeFakeWs();
    handleTerminalConnection(ws as never, { user: { id: 30, role: 'user' } } as never, dependencies);
    ws.emit('message', initMessage(id));

    assert.equal(attachCalls, before, 'the registry was never consulted for a non-admin');
    assert.deepEqual(ws.sent, [
      {
        type: 'error',
        message: 'Terminal access is restricted to administrators',
        code: 'forbidden',
      },
    ]);
    assert.deepEqual(ws.closes, [{ code: 4403, reason: 'Forbidden' }]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init with an unknown id: not_found error frame THEN close 4404', () => {
  resetAll();
  const ws = makeFakeWs();
  handleTerminalConnection(ws as never, { user: { id: 21, role: 'admin' } } as never, dependencies);
  ws.emit('message', initMessage('term_does-not-exist'));

  assert.deepEqual(ws.sent, [
    { type: 'error', message: 'Terminal not found', code: 'not_found' },
  ]);
  assert.deepEqual(ws.closes, [{ code: 4404, reason: 'Terminal not found' }]);
});

test("init on ANOTHER user's terminal answers exactly like a nonexistent one (4404)", () => {
  resetAll();
  const cwd = makeTempCwd('term-ws-foreign-');
  try {
    const { id } = createTerminal(22, cwd);

    const wsForeign = makeFakeWs();
    handleTerminalConnection(wsForeign as never, { user: { id: 23, role: 'admin' } } as never, dependencies);
    wsForeign.emit('message', initMessage(id));

    const wsMissing = makeFakeWs();
    handleTerminalConnection(wsMissing as never, { user: { id: 23, role: 'admin' } } as never, dependencies);
    wsMissing.emit('message', initMessage('term_none'));

    assert.deepEqual(wsForeign.sent, wsMissing.sent, 'identical error frames');
    assert.deepEqual(wsForeign.closes, wsMissing.closes, 'identical close codes');
    assert.equal(wsForeign.closes[0].code, 4404);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- 4: attach → replay → live; disconnect survives -------------------------------

test('attach order attached→replay→live; close does not kill; re-init replays all', () => {
  resetAll();
  const cwd = makeTempCwd('term-ws-attach-');
  try {
    const { id, fake } = createTerminal(24, cwd);
    fake.emitData('one'); // output BEFORE any attach accumulates

    const ws1 = makeFakeWs();
    handleTerminalConnection(ws1 as never, { user: { id: 24, role: 'admin' } } as never, dependencies);
    ws1.emit('message', initMessage(id));

    // Frame order: attached first, then the buffered replay.
    assert.equal(ws1.sent[0].type, 'attached');
    const attachedFrame = ws1.sent[0] as {
      terminal: Record<string, unknown>;
      truncated: boolean;
    };
    assert.equal(attachedFrame.terminal.id, id);
    assert.equal(attachedFrame.terminal.status, 'running');
    assert.equal(attachedFrame.truncated, false);
    assert.ok(!('userId' in attachedFrame.terminal), 'wire terminal has no userId');
    assert.deepEqual(ws1.sent[1], { type: 'output', data: 'one' });

    // The client dims were applied to the PTY on attach.
    assert.deepEqual(fake.resizes, [{ cols: 100, rows: 40 }]);

    // Live stream after replay.
    fake.emitData('two');
    assert.deepEqual(ws1.sent.at(-1), { type: 'output', data: 'two' });

    // Refresh: socket closes, PTY survives, output keeps buffering.
    ws1.emit('close');
    assert.equal(fake.killed, 0, 'disconnect never kills the PTY');
    fake.emitData('three');

    // Re-init from a new socket: attached, then the FULL ordered replay.
    const ws2 = makeFakeWs();
    handleTerminalConnection(ws2 as never, { user: { id: 24, role: 'admin' } } as never, dependencies);
    ws2.emit('message', initMessage(id));
    assert.equal(ws2.sent[0].type, 'attached');
    assert.deepEqual(
      ws2.sent.slice(1).map((f) => (f as { data: string }).data),
      ['one', 'two', 'three'],
      'ordered replay of everything, including output produced while detached'
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- 5: newest attach wins ----------------------------------------------------------

test('a second attach closes the first with 4409 and the second keeps working', () => {
  resetAll();
  const cwd = makeTempCwd('term-ws-4409-');
  try {
    const { id, fake } = createTerminal(25, cwd);

    const ws1 = makeFakeWs();
    handleTerminalConnection(ws1 as never, { user: { id: 25, role: 'admin' } } as never, dependencies);
    ws1.emit('message', initMessage(id));

    const ws2 = makeFakeWs();
    handleTerminalConnection(ws2 as never, { user: { id: 25, role: 'admin' } } as never, dependencies);
    ws2.emit('message', initMessage(id));

    assert.deepEqual(
      ws1.closes,
      [{ code: 4409, reason: 'Terminal attached elsewhere' }],
      'the displaced socket is closed with the policy code'
    );
    assert.deepEqual(ws2.closes, [], 'the new socket stays open');

    // The second socket owns the stream — input and output flow through it.
    const ws1Frames = ws1.sent.length;
    ws2.emit('message', JSON.stringify({ type: 'input', data: 'echo hi\r' }));
    assert.deepEqual(fake.writes, ['echo hi\r']);
    fake.emitData('hi');
    assert.deepEqual(ws2.sent.at(-1), { type: 'output', data: 'hi' });
    assert.equal(ws1.sent.length, ws1Frames, 'the displaced socket receives nothing');

    // The displaced socket's LATE close event must not detach its successor.
    ws1.emit('close');
    fake.emitData('still');
    assert.deepEqual(ws2.sent.at(-1), { type: 'output', data: 'still' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- 6: exit over WS -----------------------------------------------------------------

test('exit: frame pushed live; record survives; input re-sends exited; replay sealed', () => {
  resetAll();
  const cwd = makeTempCwd('term-ws-exit-');
  try {
    const { id, fake } = createTerminal(26, cwd);

    const ws = makeFakeWs();
    handleTerminalConnection(ws as never, { user: { id: 26, role: 'admin' } } as never, dependencies);
    ws.emit('message', initMessage(id));

    fake.emitData('done\r\n');
    fake.emitExit({ exitCode: 0, signal: undefined });
    assert.deepEqual(ws.sent.at(-1), { type: 'exited', exitCode: 0, signal: null });

    // The record stays; input is discarded and answered with exited again.
    ws.emit('message', JSON.stringify({ type: 'input', data: 'ls\r' }));
    assert.deepEqual(ws.sent.at(-1), { type: 'exited', exitCode: 0, signal: null });
    assert.deepEqual(fake.writes, [], 'no input reached the dead PTY');
    assert.equal(registry.listStandaloneTerminals(26)[0].status, 'exited');

    // A fresh attach replays the buffer and seals it with the exited frame.
    const ws2 = makeFakeWs();
    handleTerminalConnection(ws2 as never, { user: { id: 26, role: 'admin' } } as never, dependencies);
    ws2.emit('message', initMessage(id));
    assert.equal(ws2.sent[0].type, 'attached');
    assert.equal((ws2.sent[0] as { terminal: { status: string } }).terminal.status, 'exited');
    assert.deepEqual(ws2.sent[1], { type: 'output', data: 'done\r\n' });
    assert.deepEqual(ws2.sent[2], { type: 'exited', exitCode: 0, signal: null });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- protocol hygiene -----------------------------------------------------------------

test('malformed payloads answer a generic error frame and keep the socket open', () => {
  resetAll();
  const ws = makeFakeWs();
  handleTerminalConnection(ws as never, { user: { id: 27, role: 'admin' } } as never, dependencies);
  ws.emit('message', 'not-json');
  ws.emit('message', JSON.stringify({ noType: true }));

  assert.equal(ws.sent.length, 2);
  for (const frame of ws.sent) {
    assert.deepEqual(frame, {
      type: 'error',
      message: 'Invalid terminal message',
      code: 'invalid_message',
    });
  }
  assert.deepEqual(ws.closes, [], 'the socket stays open after a bad frame');
});

test('input/resize before init are ignored (no registry access, no crash)', () => {
  resetAll();
  const ws = makeFakeWs();
  handleTerminalConnection(ws as never, { user: { id: 28, role: 'admin' } } as never, dependencies);
  ws.emit('message', JSON.stringify({ type: 'input', data: 'x' }));
  ws.emit('message', JSON.stringify({ type: 'resize', cols: 10, rows: 10 }));
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(ws.closes, []);
});
