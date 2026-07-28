/**
 * standalone-terminal-registry.test.ts — T-938 (ADR-063) acceptance tests for
 * the standalone-terminal registry.
 *
 * Proves, against the REAL registry module (node-pty, the isolation seams and
 * the database barrel module-mocked, exactly like
 * shell-websocket.pty-isolation.test.ts):
 *
 *   1. Per-user ownership: a foreign user never sees, renames or deletes
 *      another user's terminal (miss ⇒ 404 shape), and the wire object NEVER
 *      carries userId.
 *   2. MAX_RUNNING_PER_USER: the 6th running terminal is refused (409) and
 *      deleting one reopens the slot; exited terminals do not count.
 *   3. Spawn env passes through the three seams: resolveProviderEnv(userId,
 *      'claude', ...) → prioritizeUserNpmGlobalBin(isolatedEnv, cwd) (REAL
 *      implementation) → resolveCagedLaunch (cmd/args pass-through proven).
 *   4. Buffer/replay: ordered replay on attach; >2MiB ⇒ head-dropped chunks +
 *      truncated:true; detach NEVER kills the PTY (no timer, still running).
 *   5. Newest-attach-wins: the second socket displaces the first and receives
 *      the live stream.
 *   6. Exit: the record (and buffer) survives, an attached viewer gets the
 *      exited frame, input on an exited terminal reports (never throws), and
 *      exited records are trimmed oldest-first beyond MAX_EXITED_PER_USER.
 *   7. cwd fail-indistinguishability: a nonexistent path and a KNOWN private
 *      project invisible to the caller return the IDENTICAL failure object.
 *
 * Runner: node:test via tsx with --experimental-test-module-mocks (project
 * `test` script). No Jest/Vitest.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

// --- Module mocks (must be registered before importing the registry) ---------

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

const spawnCalls: {
  cmd: string;
  args: string[];
  opts: { env: Record<string, string | undefined>; cwd: string; cols: number; rows: number };
  fake: FakePty;
}[] = [];

mock.module('node-pty', {
  defaultExport: {
    spawn: (
      cmd: string,
      args: string[],
      opts: { env: Record<string, string | undefined>; cwd: string; cols: number; rows: number }
    ) => {
      const fake = makeFakePty();
      spawnCalls.push({ cmd, args, opts, fake });
      return fake;
    },
  },
});

// Isolation seam: stamp per-user markers; optional per-user isolated HOME so
// the REAL prioritizeUserNpmGlobalBin resolves candidates from the isolated
// env (mirrors the B-90 tests in shell-websocket.pty-isolation.test.ts).
const resolveCalls: { userId: unknown; provider: string }[] = [];
const isolatedHomeByUser = new Map<string, string>();
mock.module('@/services/isolation/resolve-provider-env.js', {
  namedExports: {
    resolveProviderEnv: (userId: unknown, provider: string, baseEnv: Record<string, string>) => {
      resolveCalls.push({ userId, provider });
      const isolatedHome = isolatedHomeByUser.get(String(userId));
      return {
        ...baseEnv,
        ...(isolatedHome ? { HOME: isolatedHome } : {}),
        __ISOLATED_FOR__: String(userId),
        __ISOLATION_PROVIDER__: provider,
      };
    },
  },
});

// Cage seam: record the spec and WRAP cmd/args so the test can prove the
// spawn used resolveCagedLaunch's output (pass-through), not the raw command.
const cageCalls: { userId: unknown; provider: string; cmd: string; args: string[]; cwd?: string | null }[] = [];
mock.module('@/services/isolation/provider-cage-wiring.js', {
  namedExports: {
    resolveCagedLaunch: (spec: {
      userId: unknown;
      provider: string;
      cmd: string;
      args?: string[];
      cwd?: string | null;
    }) => {
      cageCalls.push({
        userId: spec.userId,
        provider: spec.provider,
        cmd: spec.cmd,
        args: spec.args ?? [],
        cwd: spec.cwd,
      });
      return { cmd: `/cage/${spec.cmd}`, args: ['--cage', ...(spec.args ?? [])] };
    },
  },
});

// Database barrel: controls the cwd visibility gate. presence.service.ts (in
// the import graph via shell-websocket → chat-websocket) named-imports userDb,
// so it must be stubbed too (same set as chat-websocket.visibility.test.ts).
const registeredProjects = new Map<string, { project_id: string }>();
const visibleCalls: { projectId: string; userId: number | null }[] = [];
let visibleResult = true;
mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getProjectPath: (projectPath: string) => registeredProjects.get(projectPath) ?? null,
      isProjectVisibleToUser: (projectId: string, userId: number | null) => {
        visibleCalls.push({ projectId, userId });
        return visibleResult;
      },
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});

const registry = await import('./standalone-terminal-registry.js');

// --- Test doubles -------------------------------------------------------------

const WS_OPEN_STATE = 1;

function makeFakeWs() {
  const sent: Record<string, unknown>[] = [];
  const closes: { code?: number; reason?: string }[] = [];
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
  };
}

/** A real temp dir usable as a valid cwd. */
function makeTempCwd(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function resetAll(): void {
  registry.resetStandaloneTerminalsForTest();
  spawnCalls.length = 0;
  resolveCalls.length = 0;
  cageCalls.length = 0;
  visibleCalls.length = 0;
  registeredProjects.clear();
  visibleResult = true;
}

const WIRE_KEYS = [
  'attached',
  'createdAt',
  'cwd',
  'exitCode',
  'hasInitialCommand',
  'id',
  'lastActivityAt',
  'signal',
  'status',
  'title',
].sort();

// --- 1 + wire shape: ownership and serialization ------------------------------

test('ownership: foreign user cannot list/rename/delete; wire carries NO userId', () => {
  resetAll();
  const cwd = makeTempCwd('term-own-');
  try {
    const created = registry.createStandaloneTerminal({ userId: 1, cwd });
    assert.equal(created.ok, true);
    const terminal = (created as { ok: true; terminal: Record<string, unknown> }).terminal;
    assert.deepEqual(Object.keys(terminal).sort(), WIRE_KEYS, 'wire shape is exact — no userId');
    assert.equal(terminal.status, 'running');

    // POST then GET for the same user shows the running record.
    const mine = registry.listStandaloneTerminals(1);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].id, terminal.id);

    // Another user's GET does not show it.
    assert.deepEqual(registry.listStandaloneTerminals(2), [], 'foreign list is empty');

    // Foreign rename/delete answer the 404 shape / false — same as nonexistent.
    const foreignRename = registry.renameStandaloneTerminal(2, terminal.id as string, 'x');
    assert.equal(foreignRename.ok, false);
    assert.equal((foreignRename as { status: number }).status, 404);
    assert.equal((foreignRename as { code: string }).code, 'not_found');
    const missingRename = registry.renameStandaloneTerminal(2, 'term_none', 'x');
    assert.deepEqual(foreignRename, missingRename, 'foreign and nonexistent are identical');
    assert.equal(registry.deleteStandaloneTerminal(2, terminal.id as string), false);
    assert.equal(registry.listStandaloneTerminals(1).length, 1, 'record untouched by foreigner');

    // Owner rename + delete work; delete kills the live PTY.
    const renamed = registry.renameStandaloneTerminal(1, terminal.id as string, '  New name  ');
    assert.equal(renamed.ok, true);
    assert.equal((renamed as { terminal: { title: string } }).terminal.title, 'New name');
    assert.equal(registry.deleteStandaloneTerminal(1, terminal.id as string), true);
    assert.equal(spawnCalls[0].fake.killed, 1, 'delete killed the live PTY');
    assert.deepEqual(registry.listStandaloneTerminals(1), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- 2: running limit ----------------------------------------------------------

test('limit: 6th running terminal is 409; deleting one reopens; exited do not count', () => {
  resetAll();
  const cwd = makeTempCwd('term-limit-');
  try {
    const ids: string[] = [];
    for (let i = 0; i < registry.MAX_RUNNING_PER_USER; i += 1) {
      const created = registry.createStandaloneTerminal({ userId: 3, cwd });
      assert.equal(created.ok, true, `terminal ${i + 1} creates fine`);
      ids.push((created as { terminal: { id: string } }).terminal.id);
    }

    const sixth = registry.createStandaloneTerminal({ userId: 3, cwd });
    assert.equal(sixth.ok, false);
    assert.equal((sixth as { status: number }).status, 409);
    assert.equal((sixth as { code: string }).code, 'terminal_limit_reached');

    // Another user is unaffected by this user's cap.
    const other = registry.createStandaloneTerminal({ userId: 4, cwd });
    assert.equal(other.ok, true, 'the cap is per-user');

    // Deleting one reopens the slot.
    assert.equal(registry.deleteStandaloneTerminal(3, ids[0]), true);
    assert.equal(registry.createStandaloneTerminal({ userId: 3, cwd }).ok, true);

    // An exited terminal frees its running slot too.
    const lastUser3Spawn = spawnCalls[spawnCalls.length - 1];
    lastUser3Spawn.fake.emitExit({ exitCode: 0 });
    assert.equal(registry.createStandaloneTerminal({ userId: 3, cwd }).ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- 3: the three env seams -----------------------------------------------------

test('spawn env passes resolveProviderEnv → prioritizeUserNpmGlobalBin → resolveCagedLaunch', () => {
  resetAll();
  const root = makeTempCwd('term-seams-');
  const cwd = path.join(root, 'project');
  const isolatedHome = path.join(root, 'home');
  const npmGlobalBin = path.join(isolatedHome, '.npm-global', 'bin');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(npmGlobalBin, { recursive: true });
  isolatedHomeByUser.set('7', isolatedHome);
  try {
    const created = registry.createStandaloneTerminal({ userId: 7, cwd });
    assert.equal(created.ok, true);

    // Seam 1 — resolveProviderEnv consulted with the JWT userId + 'claude'.
    assert.equal(resolveCalls.length, 1);
    assert.equal(resolveCalls[0].userId, 7);
    assert.equal(resolveCalls[0].provider, 'claude');

    assert.equal(spawnCalls.length, 1);
    const { cmd, args, opts } = spawnCalls[0];

    // Seam 3 — resolveCagedLaunch output (not the raw command) reached spawn.
    assert.equal(cageCalls.length, 1);
    assert.equal(cageCalls[0].userId, 7);
    assert.equal(cageCalls[0].provider, 'claude');
    assert.equal(cageCalls[0].cwd, cwd);
    assert.equal(cmd, '/cage/bash', 'spawn cmd is the caged launch cmd');
    assert.deepEqual(args, ['--cage', '-l'], 'default spawn is an interactive login shell, caged');

    // Seam 1 output reached the spawn env, with terminal vars layered on top.
    assert.equal(opts.env.__ISOLATED_FOR__, '7');
    assert.equal(opts.env.__ISOLATION_PROVIDER__, 'claude');
    assert.equal(opts.env.TERM, 'xterm-256color');
    assert.equal(opts.env.COLORTERM, 'truecolor');
    assert.equal(opts.env.FORCE_COLOR, '3');
    assert.equal(opts.cwd, cwd);

    // Seam 2 — the REAL prioritizeUserNpmGlobalBin ran on the ISOLATED env:
    // the isolated HOME's npm-global bin leads the PTY PATH.
    const pathEntries = String(opts.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    assert.equal(pathEntries[0], npmGlobalBin, 'isolated npm-global bin leads PATH');

    // initialCommand variant: bash -c '<cmd>' (argv array), caged the same way.
    const withCmd = registry.createStandaloneTerminal({
      userId: 7,
      cwd,
      initialCommand: 'echo hi',
    });
    assert.equal(withCmd.ok, true);
    assert.equal(
      (withCmd as { terminal: { hasInitialCommand: boolean } }).terminal.hasInitialCommand,
      true
    );
    assert.deepEqual(spawnCalls[1].args, ['--cage', '-c', 'echo hi']);
  } finally {
    isolatedHomeByUser.delete('7');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- validation ----------------------------------------------------------------

test('validation: title and initialCommand bounds; server title fallback', () => {
  resetAll();
  const cwd = makeTempCwd('term-val-');
  try {
    for (const badTitle of ['', '   ', 'x'.repeat(65), 42, {}]) {
      const result = registry.createStandaloneTerminal({ userId: 5, cwd, title: badTitle });
      assert.equal(result.ok, false, `title ${JSON.stringify(badTitle)} rejected`);
      assert.equal((result as { code: string }).code, 'invalid_title');
      assert.equal((result as { status: number }).status, 400);
    }

    for (const badCmd of ['x'.repeat(4097), 42, []]) {
      const result = registry.createStandaloneTerminal({ userId: 5, cwd, initialCommand: badCmd });
      assert.equal(result.ok, false, 'oversized/non-string initialCommand rejected');
      assert.equal((result as { code: string }).code, 'invalid_initial_command');
    }

    // Boundary values pass; empty command collapses to a plain shell.
    assert.equal(
      registry.createStandaloneTerminal({ userId: 5, cwd, title: 'x'.repeat(64) }).ok,
      true
    );
    const emptyCmd = registry.createStandaloneTerminal({ userId: 5, cwd, initialCommand: '   ' });
    assert.equal(emptyCmd.ok, true);
    assert.equal(
      (emptyCmd as { terminal: { hasInitialCommand: boolean } }).terminal.hasInitialCommand,
      false
    );

    // No title ⇒ English server fallback (client sends localized titles).
    const fallback = registry.createStandaloneTerminal({ userId: 6, cwd });
    assert.equal((fallback as { terminal: { title: string } }).terminal.title, 'Terminal 1');

    // No spawn happened for any rejected create.
    assert.equal(spawnCalls.length, 3, 'only the three successful creates spawned');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- 7: cwd gate + indistinguishability ------------------------------------------

test('cwd: nonexistent path and invisible private project return the IDENTICAL failure', () => {
  resetAll();
  const privateDir = makeTempCwd('term-priv-');
  try {
    // Relative / non-string / file cwd all refuse with invalid_cwd.
    for (const badCwd of ['relative/dir', 42, '']) {
      const result = registry.createStandaloneTerminal({ userId: 9, cwd: badCwd });
      assert.equal(result.ok, false);
      assert.equal((result as { code: string }).code, 'invalid_cwd');
    }

    // Case A: absolute path that does not exist.
    const missing = registry.createStandaloneTerminal({
      userId: 9,
      cwd: '/nonexistent-standalone-terminal-test-dir',
    });
    assert.equal(missing.ok, false);

    // Case B: EXISTING dir registered as a project the caller cannot see.
    registeredProjects.set(privateDir, { project_id: 'proj-private' });
    visibleResult = false;
    const invisible = registry.createStandaloneTerminal({ userId: 9, cwd: privateDir });
    assert.equal(invisible.ok, false);
    assert.equal(visibleCalls.length, 1, 'the visibility gate was consulted');
    assert.deepEqual(visibleCalls[0], { projectId: 'proj-private', userId: 9 });

    // The two failures are the SAME frozen object — bytes cannot differ.
    assert.strictEqual(missing, invisible, 'identical failure object (no oracle)');
    assert.deepEqual(missing, {
      ok: false,
      status: 400,
      code: 'invalid_cwd',
      error: 'Invalid working directory',
    });
    assert.equal(spawnCalls.length, 0, 'nothing spawned on any refusal');

    // Same dir VISIBLE ⇒ create succeeds (the gate, not the path, refused).
    visibleResult = true;
    assert.equal(registry.createStandaloneTerminal({ userId: 9, cwd: privateDir }).ok, true);
  } finally {
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
});

// --- 4: buffer, replay, truncation, detach-no-kill --------------------------------

test('buffer: ordered replay; >2MiB head-drop sets truncated; detach never kills', () => {
  resetAll();
  const cwd = makeTempCwd('term-buf-');
  try {
    const created = registry.createStandaloneTerminal({ userId: 11, cwd });
    const id = (created as { terminal: { id: string } }).terminal.id;
    const fake = spawnCalls[0].fake;

    fake.emitData('one');
    fake.emitData('two');
    fake.emitData('three');

    const ws1 = makeFakeWs();
    const attach1 = registry.attachStandaloneTerminalSocket(11, id, ws1 as never);
    assert.ok(attach1);
    assert.equal(attach1.truncated, false);
    assert.deepEqual(attach1.replay, ['one', 'two', 'three'], 'full ordered replay');
    assert.equal(attach1.displaced, null);
    assert.equal(attach1.terminal.attached, true);

    // Live stream flows to the attached socket.
    fake.emitData('four');
    assert.deepEqual(ws1.sent.at(-1), { type: 'output', data: 'four' });

    // Detach: binding released, PTY NOT killed, no kill timer exists at all.
    registry.detachStandaloneTerminalSocket(11, id, ws1 as never);
    assert.equal(fake.killed, 0, 'disconnect never kills the PTY');
    assert.equal(registry.listStandaloneTerminals(11)[0].status, 'running');
    assert.equal(registry.listStandaloneTerminals(11)[0].attached, false);

    // Output keeps accumulating while detached and replays on the next attach.
    fake.emitData('five');
    const ws2 = makeFakeWs();
    const attach2 = registry.attachStandaloneTerminalSocket(11, id, ws2 as never);
    assert.deepEqual(attach2?.replay, ['one', 'two', 'three', 'four', 'five']);

    // Truncation: push past 2MiB — head chunks drop, newest retained.
    registry.detachStandaloneTerminalSocket(11, id, ws2 as never);
    const chunk = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 9; i += 1) {
      fake.emitData(`${i}`.padEnd(chunk.length, 'x')); // distinct heads, 256KiB each
    }
    const ws3 = makeFakeWs();
    const attach3 = registry.attachStandaloneTerminalSocket(11, id, ws3 as never);
    assert.ok(attach3);
    assert.equal(attach3.truncated, true, 'exceeding 2MiB latches truncated');
    const replayBytes = attach3.replay.reduce((sum, c) => sum + Buffer.byteLength(c), 0);
    assert.ok(replayBytes <= registry.BUFFER_MAX_BYTES, 'buffer stays within the byte cap');
    assert.ok(
      attach3.replay.at(-1)?.startsWith('8'),
      'the newest chunk is always retained'
    );
    assert.ok(!attach3.replay.some((c) => c === 'one'), 'oldest chunks were head-dropped');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- 5: newest attach wins ---------------------------------------------------------

test('second attach displaces the first and takes over the live stream', () => {
  resetAll();
  const cwd = makeTempCwd('term-swap-');
  try {
    const created = registry.createStandaloneTerminal({ userId: 12, cwd });
    const id = (created as { terminal: { id: string } }).terminal.id;
    const fake = spawnCalls[0].fake;

    const ws1 = makeFakeWs();
    const ws2 = makeFakeWs();
    registry.attachStandaloneTerminalSocket(12, id, ws1 as never);
    const attach2 = registry.attachStandaloneTerminalSocket(12, id, ws2 as never);
    assert.equal(attach2?.displaced, ws1, 'the previous socket is reported for the 4409 close');

    const ws1FramesBefore = ws1.sent.length;
    fake.emitData('live');
    assert.deepEqual(ws2.sent.at(-1), { type: 'output', data: 'live' }, 'newest socket streams');
    assert.equal(ws1.sent.length, ws1FramesBefore, 'displaced socket receives nothing');

    // A LATE close of the displaced socket must not detach its successor.
    registry.detachStandaloneTerminalSocket(12, id, ws1 as never);
    fake.emitData('still-live');
    assert.deepEqual(ws2.sent.at(-1), { type: 'output', data: 'still-live' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- 6: exit semantics ---------------------------------------------------------------

test('exit: frame to viewer, record+buffer survive, input reports instead of throwing', () => {
  resetAll();
  const cwd = makeTempCwd('term-exit-');
  try {
    const created = registry.createStandaloneTerminal({ userId: 13, cwd });
    const id = (created as { terminal: { id: string } }).terminal.id;
    const fake = spawnCalls[0].fake;

    fake.emitData('bye');
    const ws = makeFakeWs();
    registry.attachStandaloneTerminalSocket(13, id, ws as never);
    fake.emitExit({ exitCode: 7 });

    assert.deepEqual(ws.sent.at(-1), { type: 'exited', exitCode: 7, signal: null });

    // The record stays listed with its exit state and buffer.
    const listed = registry.listStandaloneTerminals(13);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'exited');
    assert.equal(listed[0].exitCode, 7);
    assert.equal(listed[0].signal, null);

    // Input is discarded and reported — never a throw, never a write.
    const input = registry.writeStandaloneTerminalInput(13, id, 'ls\r');
    assert.deepEqual(input, { outcome: 'exited', exitCode: 7, signal: null });
    assert.deepEqual(fake.writes, [], 'no write reached the dead PTY');

    // Resize on an exited terminal is a silent no-op.
    registry.resizeStandaloneTerminal(13, id, 120, 40);
    assert.deepEqual(fake.resizes, []);

    // Replay is preserved after exit.
    const ws2 = makeFakeWs();
    const attach = registry.attachStandaloneTerminalSocket(13, id, ws2 as never);
    assert.deepEqual(attach?.replay, ['bye']);
    assert.equal(attach?.terminal.status, 'exited');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('exited records are trimmed oldest-first beyond MAX_EXITED_PER_USER', () => {
  resetAll();
  const cwd = makeTempCwd('term-trim-');
  try {
    const ids: string[] = [];
    // 12 exited terminals, created (and exited) in batches under the running cap.
    for (let batch = 0; batch < 3; batch += 1) {
      const batchStart = spawnCalls.length;
      for (let i = 0; i < 4; i += 1) {
        const created = registry.createStandaloneTerminal({ userId: 14, cwd });
        assert.equal(created.ok, true);
        ids.push((created as { terminal: { id: string } }).terminal.id);
      }
      for (let i = 0; i < 4; i += 1) {
        spawnCalls[batchStart + i].fake.emitExit({ exitCode: 0 });
      }
    }

    const listed = registry.listStandaloneTerminals(14);
    assert.equal(listed.length, registry.MAX_EXITED_PER_USER, 'capped at 10 exited');
    // The two OLDEST exited records were trimmed; order (createdAt asc) holds.
    assert.deepEqual(
      listed.map((t) => t.id),
      ids.slice(2),
      'oldest-first trim, ascending order preserved'
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- input/resize on a live terminal ---------------------------------------------

test('input and resize reach a running PTY; foreign input reports gone', () => {
  resetAll();
  const cwd = makeTempCwd('term-io-');
  try {
    const created = registry.createStandaloneTerminal({ userId: 15, cwd });
    const id = (created as { terminal: { id: string } }).terminal.id;
    const fake = spawnCalls[0].fake;

    assert.deepEqual(registry.writeStandaloneTerminalInput(15, id, 'echo\r'), {
      outcome: 'written',
    });
    assert.deepEqual(fake.writes, ['echo\r']);

    registry.resizeStandaloneTerminal(15, id, 132, 43);
    assert.deepEqual(fake.resizes, [{ cols: 132, rows: 43 }]);
    // Nonsense dimensions are clamped/defaulted, never thrown.
    registry.resizeStandaloneTerminal(15, id, Number.NaN, -5);
    assert.deepEqual(fake.resizes.at(-1), { cols: 80, rows: 1 });

    // A foreign user's input is 'gone' — indistinguishable from nonexistent.
    assert.deepEqual(registry.writeStandaloneTerminalInput(16, id, 'x'), { outcome: 'gone' });
    assert.deepEqual(fake.writes, ['echo\r'], 'foreign input never reached the PTY');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
