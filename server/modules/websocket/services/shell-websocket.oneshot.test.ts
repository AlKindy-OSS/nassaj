/**
 * shell-websocket.oneshot.test.ts — T-2037 composer shell one-shots, driven
 * through the real `handleShellConnection` dispatcher with a mocked node-pty.
 *
 * Proves the qa acceptance list: refusal per gate condition with no spawn; no
 * unrequested re-execution of a consumed runId (also with forceRestart and with
 * an `auth login`-looking command); server-side shape normalization that never
 * touches the provider `_default` key; one strict start audit before spawn and
 * none on reattach; audit failure → no spawn and the slot released; the per-user
 * caps; brakes re-checked after the lease wait; the lifetime cap; and the
 * owner-only, unconditionally masked capture.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import {
  auditLogDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  shellOneShotRunsDb,
  userDb,
} from '@/modules/database/index.js';

process.env.CLAUDE_CLI_PATH = process.execPath;

type FakePty = {
  file: string;
  args: string[];
  kills: number;
  auditRowsAtSpawn: number;
  dataListener: ((chunk: string) => void) | null;
  exitListener: ((e: { exitCode: number; signal?: number }) => void) | null;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: unknown): void;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(): void;
};
const spawned: FakePty[] = [];
let failNextSpawn = false;

/** Start rows (`shell_exec_start`) currently in audit_log. */
function startAuditRows(): Array<Record<string, unknown>> {
  try {
    return auditLogDb.recent(1000)
      .filter((row) => row.action === 'command_board_raw_exec')
      .map((row) => JSON.parse(String(row.metadata)) as Record<string, unknown>)
      .filter((metadata) => metadata.result === 'shell_exec_start');
  } catch {
    return [];
  }
}

mock.module('node-pty', {
  defaultExport: {
    spawn: (file: string, args: string[]) => {
      if (failNextSpawn) {
        failNextSpawn = false;
        throw new Error('spawn failed');
      }
      const pty: FakePty = {
        file,
        args,
        kills: 0,
        auditRowsAtSpawn: startAuditRows().length,
        dataListener: null,
        exitListener: null,
        onData(cb) { pty.dataListener = cb; },
        onExit(cb) { pty.exitListener = cb as FakePty['exitListener']; },
        write() {},
        resize() {},
        kill() { pty.kills += 1; },
      };
      spawned.push(pty);
      return pty;
    },
  },
});

mock.module('@/services/isolation/resolve-provider-env.js', {
  namedExports: {
    resolveProviderEnv: (_userId: unknown, _provider: string, baseEnv: Record<string, string>) => ({ ...baseEnv }),
  },
});

const service = await import('./shell-websocket.service.js');
const {
  handleShellConnection, sweepOneShotBrakes, terminateShellSessionsForUser, __resetOneShotStateForTests,
  __simulateRestartForTests,
} = service;
// eslint-disable-next-line boundaries/no-unknown -- arms raw exec exactly as the settings route does.
const { setCommandBoardConfig } = await import('@/services/command-board-config.js');
// eslint-disable-next-line boundaries/no-unknown -- turns the display-masking flag off for the capture test.
const { configureDisplayMaskForTests } = await import('@/services/display-secret-mask.js');

const WS_OPEN = 1;
const PROJECT_PATH = process.cwd();

type Frame = { type?: string; code?: string; runId?: string; exitCode?: number | null; text?: string;
  truncated?: boolean; data?: string };

function makeFakeWs() {
  const sent: Frame[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  return {
    readyState: WS_OPEN,
    sent,
    closes,
    send(data: string) { sent.push(JSON.parse(data)); },
    close(code?: number, reason?: string) { closes.push({ code, reason }); },
    on(event: string, cb: (arg?: unknown) => void) { (listeners[event] ||= []).push(cb); },
    emit(event: string, arg?: unknown) { (listeners[event] || []).forEach((cb) => cb(arg)); },
  };
}
type FakeWs = ReturnType<typeof makeFakeWs>;

type Lease = { release(): void };
let acquireLease: () => Lease | Promise<Lease> = () => ({ release() {} });
const deps = {
  acquireWriterLease: () => acquireLease(),
  getSessionById: () => null,
  stripAnsiSequences: (s: string) => s,
  normalizeDetectedUrl: () => null,
  extractUrlsFromText: () => [],
  shouldAutoOpenUrlFromOutput: () => false,
} as unknown as Parameters<typeof handleShellConnection>[2];

let runCounter = 0;
function newRunId(): string {
  runCounter += 1;
  return `00000000-0000-4000-8000-${String(runCounter).padStart(12, '0')}`;
}

function oneShotInit(runId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'init', projectPath: PROJECT_PATH, initialCommand: 'git status', isPlainShell: true,
    hasSession: false, provider: 'plain-shell', runId, origin: 'composer_shell', cols: 80, rows: 24,
    ...overrides,
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let ownerId = 0;
let adminId = 0;
let memberId = 0;

function connect(userId: number, role: string): FakeWs {
  const ws = makeFakeWs();
  handleShellConnection(ws as never, { user: { id: userId, role }, headers: {} } as never, deps);
  return ws;
}

async function send(ws: FakeWs, message: string): Promise<void> {
  ws.emit('message', message);
  await flush();
}

async function withDb(run: () => Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pty-oneshot-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  ownerId = userDb.createUser('oneshot-owner', 'hash', 'owner').id as number;
  adminId = userDb.createUser('oneshot-admin', 'hash', 'admin').id as number;
  memberId = userDb.createUser('oneshot-member', 'hash', 'user').id as number;
  spawned.length = 0;
  failNextSpawn = false;
  acquireLease = () => ({ release() {} });
  __resetOneShotStateForTests();
  try {
    await run();
  } finally {
    for (const id of [ownerId, adminId, memberId]) terminateShellSessionsForUser(id);
    __resetOneShotStateForTests();
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function armRaw(): void {
  assert.equal(setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'raw', admin: 'raw' } }).ok, true);
}

function assertRefused(ws: FakeWs, code: string, label = code): void {
  const error = ws.sent.find((frame) => frame.type === 'error');
  assert.equal(error?.code, code, `${label}: refusal code`);
  assert.equal(ws.closes.at(-1)?.code, 4403, `${label}: final close code`);
}

test('refuses each gate condition before spawn with a final 4403', async () => {
  await withDb(async () => {
    const cases: Array<[string, number, string, Record<string, unknown>, () => void]> = [
      ['raw_exec_disabled', ownerId, 'owner', {}, () => {}],
      ['forbidden', memberId, 'user', {}, armRaw],
      ['denied_command:', ownerId, 'owner', { initialCommand: 'pm2 restart nassaj-dev' }, armRaw],
      ['denied_command:', ownerId, 'owner', { initialCommand: 'pm2 kill' }, armRaw],
      ['carriage_return_forbidden', ownerId, 'owner', { initialCommand: 'ls\r\nid' }, armRaw],
      ['forbidden_control_char', ownerId, 'owner', { initialCommand: 'echo ⁧x' }, armRaw],
      ['command_too_long', ownerId, 'owner', { initialCommand: 'x'.repeat(4097) }, armRaw],
      ['too_many_lines', ownerId, 'owner', { initialCommand: Array(101).fill('true').join('\n') }, armRaw],
      ['oneshot_shape_invalid', ownerId, 'owner', { runId: 'nope' }, armRaw],
    ];
    for (const [code, userId, role, overrides, arrange] of cases) {
      arrange();
      const ws = connect(userId, role);
      await send(ws, oneShotInit(newRunId(), overrides));
      const error = ws.sent.find((frame) => frame.type === 'error');
      assert.ok(error?.code?.startsWith(code), `${code}: got ${error?.code}`);
      assert.equal(ws.closes.at(-1)?.code, 4403, `${code}: final close`);
    }
    // config_denied: raw armed but the admin row lost its raw tier.
    setCommandBoardConfig({ roleModes: { admin: 'custom' } });
    const ws = connect(adminId, 'admin');
    await send(ws, oneShotInit(newRunId()));
    assertRefused(ws, 'config_denied');
    assert.equal(spawned.length, 0, 'pty.spawn never called');
  });
});

test('provider-login allowlist still works for role user', async () => {
  await withDb(async () => {
    const logins: Array<[string, string]> = [
      ['claude', 'claude setup-token'], ['cursor', 'cursor-agent login'], ['codex', 'codex login'],
      ['codex', 'codex login --device-auth'], ['opencode', 'opencode auth login'], ['kimi', 'kimi login'],
      ['claude', 'claude auth login'], ['agy', 'agy'],
    ];
    for (const [provider, initialCommand] of logins) {
      const ws = connect(memberId, 'user');
      await send(ws, JSON.stringify({
        type: 'init', projectPath: PROJECT_PATH, provider, initialCommand, isPlainShell: true, hasSession: false,
      }));
      const refusal = ws.sent.find((frame) => frame.type === 'error' && ['forbidden', 'raw_exec_disabled',
        'oneshot_shape_invalid'].includes(String(frame.code)));
      assert.equal(refusal, undefined, `${initialCommand} is not treated as a free-form command`);
      assert.equal(ws.closes.some((close) => close.code === 4403), false, `${initialCommand} not closed 4403`);
    }
    assert.equal(startAuditRows().length, 0, 'logins are not raw-exec audited');
  });
});

test('one strict start audit before spawn, redacted, none on reattach', async () => {
  await withDb(async () => {
    armRaw();
    const runId = newRunId();
    const ws = connect(ownerId, 'owner');
    await send(ws, oneShotInit(runId, { initialCommand: 'FOO_TOKEN=abc123xyz ./build.sh' }));
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.auditRowsAtSpawn, 1, 'the start row existed before pty.spawn');
    assert.deepEqual(spawned[0]!.args, ['-c', 'FOO_TOKEN=abc123xyz ./build.sh'], 'executed verbatim');
    const [start] = startAuditRows();
    assert.equal(start?.command, 'FOO_TOKEN=«redacted» ./build.sh');
    assert.equal(start?.runId, runId);
    assert.equal(start?.origin, 'composer_shell');
    assert.match(String(start?.digest), /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(startAuditRows()).includes('abc123xyz'), false);

    const again = connect(ownerId, 'owner');
    await send(again, oneShotInit(runId, { initialCommand: 'FOO_TOKEN=abc123xyz ./build.sh', forceRestart: true }));
    assert.equal(spawned.length, 1, 'reattached, no second spawn even with forceRestart');
    assert.equal(spawned[0]!.kills, 0);
    assert.ok(again.sent.some((frame) => frame.data?.includes('Reconnected')));
    assert.equal(startAuditRows().length, 1, 'no start audit on reattach');
  });
});

test('a consumed runId never spawns again after exit (forceRestart, auth-login text)', async () => {
  await withDb(async () => {
    armRaw();
    for (const command of ['make test', 'echo auth login']) {
      const runId = newRunId();
      const before = spawned.length;
      const ws = connect(ownerId, 'owner');
      await send(ws, oneShotInit(runId, { initialCommand: command }));
      assert.equal(spawned.length, before + 1);
      spawned.at(-1)!.dataListener?.('ok\n');
      spawned.at(-1)!.exitListener?.({ exitCode: 7 });
      assert.deepEqual(ws.sent.at(-1), { type: 'oneshot_finished', runId, exitCode: 7 });

      for (const forceRestart of [false, true]) {
        const replay = connect(ownerId, 'owner');
        await send(replay, oneShotInit(runId, { initialCommand: command, forceRestart }));
        assert.equal(spawned.length, before + 1, `${command}: no re-execution (forceRestart=${forceRestart})`);
        assert.deepEqual(replay.sent, [{ type: 'oneshot_finished', runId, exitCode: 7 }]);
      }
    }
    const ends = auditLogDb.recent(100)
      .map((row) => JSON.parse(String(row.metadata)))
      .filter((metadata) => metadata.result === 'shell_exec_end');
    assert.equal(ends.length, 2, 'best-effort completion audit per run');
    assert.equal(ends[0].exitCode, 7);
  });
});

test('free-form with a provider shape is refused for every provider; `_default` untouched', async () => {
  await withDb(async () => {
    armRaw();
    const providerWs = connect(ownerId, 'owner');
    await send(providerWs, JSON.stringify({
      type: 'init', projectPath: PROJECT_PATH, provider: 'claude', hasSession: false, initialCommand: null,
      isPlainShell: false,
    }));
    assert.equal(spawned.length, 1, 'the provider default PTY');
    const providerPty = spawned[0]!;
    for (const provider of ['claude', 'opencode', 'kimi', 'agy', 'codex']) {
      for (const shape of [{ isPlainShell: false }, { hasSession: true, sessionId: 'abc' }]) {
        const ws = connect(ownerId, 'owner');
        await send(ws, oneShotInit(newRunId(), { provider, ...shape }));
        // A retired body (kimi) is refused earlier as provider_removed — also final.
        const expected = provider === 'kimi' ? 'provider_removed' : 'oneshot_shape_invalid';
        assertRefused(ws, expected, `${provider} ${JSON.stringify(shape)}`);
      }
    }
    assert.equal(spawned.length, 1, 'no spawn');
    assert.equal(providerPty.kills, 0, 'the provider `_default` PTY was not touched');

    // An admitted one-shot that declares a provider is pinned to plain-shell.
    const ws = connect(ownerId, 'owner');
    await send(ws, oneShotInit(newRunId(), { provider: 'claude', sessionId: 'abc', forceRestart: true }));
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned[1]!.args, ['-c', 'git status']);
    assert.equal(providerPty.kills, 0, 'still untouched');
  });
});

test('caps: 10 concurrent inits → 3 spawns; slots freed on every failure path', async () => {
  await withDb(async () => {
    armRaw();
    const sockets = Array.from({ length: 10 }, () => connect(ownerId, 'owner'));
    sockets.forEach((ws) => ws.emit('message', oneShotInit(newRunId())));
    await flush();
    assert.equal(spawned.length, 3);
    assert.equal(sockets.filter((ws) => ws.sent.some((frame) => frame.code === 'oneshot_limit')).length, 7);
    spawned.forEach((pty, i) => pty.exitListener?.({ exitCode: i }));

    // Lease refusal, audit failure and spawn throw each release their slot:
    // three failures followed by three successes prove nothing leaked.
    acquireLease = () => { throw new Error('lease refused'); };
    for (let i = 0; i < 3; i += 1) await send(connect(ownerId, 'owner'), oneShotInit(newRunId()));
    acquireLease = () => ({ release() {} });
    failNextSpawn = true;
    const thrown = connect(ownerId, 'owner');
    await send(thrown, oneShotInit(newRunId()));
    assert.equal(thrown.closes.at(-1)?.code, 4403, 'spawn throw closes the one-shot finally');
    const before = spawned.length;
    for (let i = 0; i < 3; i += 1) await send(connect(ownerId, 'owner'), oneShotInit(newRunId()));
    assert.equal(spawned.length, before + 3, 'all three slots were free again');
  });
});

test('audit failure → audit_unavailable, no spawn, lease and slot released', async () => {
  await withDb(async () => {
    armRaw();
    let released = 0;
    acquireLease = () => ({ release() { released += 1; } });
    getConnection().exec('DROP TABLE audit_log');
    for (let i = 0; i < 4; i += 1) {
      const ws = connect(ownerId, 'owner');
      await send(ws, oneShotInit(newRunId()));
      assertRefused(ws, 'audit_unavailable');
    }
    assert.equal(spawned.length, 0);
    assert.equal(released, 4, 'every lease released');
  });
});

test('revoking the raw tier during the lease wait → no spawn', async () => {
  await withDb(async () => {
    armRaw();
    let grant: (lease: Lease) => void = () => {};
    acquireLease = () => new Promise<Lease>((resolve) => { grant = resolve; });
    const ws = connect(ownerId, 'owner');
    ws.emit('message', oneShotInit(newRunId()));
    await flush();
    setCommandBoardConfig({ roleModes: { owner: 'custom' } });
    grant({ release() {} });
    await flush();
    assert.equal(spawned.length, 0);
    assertRefused(ws, 'config_denied');
  });
});

test('live one-shots end when raw exec is turned off or the identity is revoked', async () => {
  await withDb(async () => {
    armRaw();
    const a = connect(ownerId, 'owner');
    await send(a, oneShotInit(newRunId()));
    assert.equal(sweepOneShotBrakes(), 0, 'nothing to end while raw exec is on');
    setCommandBoardConfig({ rawExecEnabled: false });
    assert.equal(sweepOneShotBrakes(), 1);
    assert.equal(spawned[0]!.kills, 1);
    assert.equal(a.closes.at(-1)?.code, 4403);

    armRaw();
    const runId = newRunId();
    const b = connect(ownerId, 'owner');
    await send(b, oneShotInit(runId));
    spawned[1]!.dataListener?.('output\n');
    assert.equal(terminateShellSessionsForUser(ownerId), 1);
    assert.equal(spawned[1]!.kills, 1);
    await send(b, JSON.stringify({ type: 'oneshot_capture', runId }));
    assert.equal(b.sent.at(-1)?.code, 'oneshot_capture_unavailable', 'captures dropped with the identity');
  });
});

test('lifetime cap kills the PTY and the completion audit names it', async () => {
  const prev = process.env.NASSAJ_ONESHOT_LIFETIME_MS;
  process.env.NASSAJ_ONESHOT_LIFETIME_MS = '30';
  try {
    await withDb(async () => {
      armRaw();
      const ws = connect(ownerId, 'owner');
      await send(ws, oneShotInit(newRunId(), { initialCommand: 'sleep 1000' }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(spawned[0]!.kills, 1);
      spawned[0]!.exitListener?.({ exitCode: 143 });
      const end = auditLogDb.recent(10)
        .map((row) => JSON.parse(String(row.metadata)))
        .find((metadata) => metadata.result === 'shell_exec_end');
      assert.equal(end?.reason, 'lifetime_cap');
    });
  } finally {
    if (prev === undefined) delete process.env.NASSAJ_ONESHOT_LIFETIME_MS;
    else process.env.NASSAJ_ONESHOT_LIFETIME_MS = prev;
  }
});

test('capture after exit: owner only, masked with the flag off', async () => {
  const secret = 'svc-literal-9f8e7d6c5b4a';
  configureDisplayMaskForTests({
    env: () => '0', readSetting: () => 'false', serviceLiterals: () => [secret],
    allUserIds: () => [], vendorLiterals: () => [], sharedVendorLiterals: () => [],
  });
  try {
    await withDb(async () => {
      armRaw();
      const runId = newRunId();
      const ws = connect(ownerId, 'owner');
      await send(ws, oneShotInit(runId, { initialCommand: 'env' }));
      spawned[0]!.dataListener?.(`\x1b[1mKEY=${secret}\x1b[0m\r\n50%\r100%\r\n`);
      spawned[0]!.exitListener?.({ exitCode: 0 });

      const reader = connect(ownerId, 'owner');
      await send(reader, JSON.stringify({ type: 'oneshot_capture', runId: runId.toUpperCase() }));
      const capture = reader.sent.at(-1);
      assert.equal(capture?.type, 'oneshot_capture');
      assert.equal(capture?.runId, runId);
      assert.equal(capture?.exitCode, 0);
      assert.equal(capture?.truncated, false);
      assert.equal(capture?.text?.includes(secret), false, 'masked though the display flag is off');
      assert.match(String(capture?.text), /\[masked:[a-z-]+\]\n100%\n$/);

      const other = connect(adminId, 'admin');
      await send(other, JSON.stringify({ type: 'oneshot_capture', runId }));
      assert.deepEqual(other.sent.at(-1), { type: 'error', code: 'oneshot_capture_unavailable', runId });
      assert.equal(other.closes.length, 0);
    });
  } finally {
    configureDisplayMaskForTests(null);
  }
});

test('restart: a started run is never relaunched — replay, forceRestart, attachOnly', async () => {
  await withDb(async () => {
    armRaw();
    const runId = newRunId();
    const ws = connect(ownerId, 'owner');
    await send(ws, oneShotInit(runId, { initialCommand: 'git push' }));
    assert.equal(spawned.length, 1);

    __simulateRestartForTests();
    // The client (oneShotRunsStore) re-sends the same runId + command after a restart.
    for (const overrides of [{}, { forceRestart: true }, { attachOnly: true }, { attachOnly: true, initialCommand: undefined }]) {
      const replay = connect(ownerId, 'owner');
      await send(replay, oneShotInit(runId, { initialCommand: 'git push', ...overrides }));
      assert.equal(spawned.length, 1, `no relaunch for ${JSON.stringify(overrides)}`);
      assert.deepEqual(replay.sent, [{ type: 'oneshot_finished', runId, exitCode: null, interrupted: true }]);
      assert.equal(replay.closes.length, 0);
    }
  });
});

test('restart: a finished run keeps its exit code; a refused run reports refused', async () => {
  await withDb(async () => {
    armRaw();
    const finished = newRunId();
    await send(connect(ownerId, 'owner'), oneShotInit(finished));
    spawned[0]!.exitListener?.({ exitCode: 7 });

    const refused = newRunId();
    acquireLease = () => { throw new Error('lease refused'); };
    const refusedWs = connect(ownerId, 'owner');
    await send(refusedWs, oneShotInit(refused));
    assert.equal(refusedWs.closes.at(-1)?.code, 4403);
    acquireLease = () => ({ release() {} });

    __simulateRestartForTests();
    const a = connect(ownerId, 'owner');
    await send(a, oneShotInit(finished));
    assert.deepEqual(a.sent, [{ type: 'oneshot_finished', runId: finished, exitCode: 7 }]);
    const b = connect(ownerId, 'owner');
    await send(b, oneShotInit(refused));
    assert.deepEqual(b.sent, [{ type: 'oneshot_finished', runId: refused, exitCode: null, refused: true }]);
    assert.equal(spawned.length, 1);
  });
});

test('attachOnly: unknown runId spawns nothing; a live run is reattached', async () => {
  await withDb(async () => {
    // Raw exec is OFF: attach needs no brakes, and still never spawns.
    const unknown = newRunId();
    const ws = connect(ownerId, 'owner');
    await send(ws, oneShotInit(unknown, { attachOnly: true, initialCommand: 'rm -rf build' }));
    assert.equal(spawned.length, 0);
    assert.deepEqual(ws.sent, [{ type: 'oneshot_finished', runId: unknown, exitCode: null, unknown: true }]);
    assert.equal(ws.closes.length, 0);

    armRaw();
    const runId = newRunId();
    await send(connect(ownerId, 'owner'), oneShotInit(runId));
    const attach = connect(ownerId, 'owner');
    await send(attach, oneShotInit(runId, { attachOnly: true, initialCommand: undefined }));
    assert.equal(spawned.length, 1);
    assert.ok(attach.sent.some((frame) => frame.data?.includes('Reconnected')));

    const member = connect(memberId, 'user');
    await send(member, oneShotInit(runId, { attachOnly: true, initialCommand: undefined }));
    assertRefused(member, 'forbidden');
    const badShape = connect(ownerId, 'owner');
    await send(badShape, oneShotInit(runId, { attachOnly: true, hasSession: true }));
    assertRefused(badShape, 'oneshot_shape_invalid');
  });
});

test('role is re-read from the database: demotion stops a live run and a pending start', async () => {
  await withDb(async () => {
    armRaw();
    const ws = connect(adminId, 'admin');
    await send(ws, oneShotInit(newRunId()));
    assert.equal(spawned.length, 1);
    userDb.setRole(adminId, 'user');
    assert.equal(sweepOneShotBrakes(), 1, 'the socket still says admin; the database says user');
    assert.equal(spawned[0]!.kills, 1);
    assert.equal(ws.sent.find((frame) => frame.type === 'error')?.code, 'forbidden');
    assert.equal(ws.closes.at(-1)?.code, 4403);

    userDb.setRole(adminId, 'admin');
    let grant: (lease: Lease) => void = () => {};
    acquireLease = () => new Promise<Lease>((resolve) => { grant = resolve; });
    const pending = connect(adminId, 'admin');
    pending.emit('message', oneShotInit(newRunId()));
    await flush();
    userDb.setRole(adminId, 'user');
    grant({ release() {} });
    await flush();
    assert.equal(spawned.length, 1, 'no spawn after demotion during the lease wait');
    assertRefused(pending, 'forbidden');
  });
});

/** Three fresh inits by `userId` succeed: proves no live seat is held. */
async function assertThreeSeatsFree(userId: number, role: string): Promise<void> {
  const before = spawned.length;
  for (let i = 0; i < 3; i += 1) await send(connect(userId, role), oneShotInit(newRunId()));
  assert.equal(spawned.length, before + 3, 'all three seats are free');
}

test('ledger read failure: only oneshot_ledger_unavailable, no spawn, no seat taken', async () => {
  await withDb(async () => {
    armRaw();
    const failing = mock.method(shellOneShotRunsDb, 'get', () => { throw new Error('disk I/O error'); });
    try {
      for (let i = 0; i < 4; i += 1) {
        const ws = connect(ownerId, 'owner');
        const runId = newRunId();
        await send(ws, oneShotInit(runId));
        assert.deepEqual(ws.sent.map((frame) => frame.type === 'error' ? frame.code : frame.type),
          ['oneshot_ledger_unavailable'], 'exactly one frame, the ledger refusal');
        assert.equal(ws.closes.at(-1)?.code, 4403);
      }
    } finally {
      failing.mock.restore();
    }
    assert.equal(spawned.length, 0);
    await assertThreeSeatsFree(ownerId, 'owner');
  });
});

test('ledger write failure: no spawn and the seat is released', async () => {
  await withDb(async () => {
    armRaw();
    const failing = mock.method(shellOneShotRunsDb, 'consume', () => { throw new Error('database is locked'); });
    try {
      for (let i = 0; i < 4; i += 1) {
        const ws = connect(ownerId, 'owner');
        await send(ws, oneShotInit(newRunId()));
        assert.equal(ws.sent.find((frame) => frame.type === 'error')?.code, 'oneshot_ledger_unavailable');
        assert.equal(ws.closes.at(-1)?.code, 4403);
      }
    } finally {
      failing.mock.restore();
    }
    assert.equal(spawned.length, 0);
    await assertThreeSeatsFree(ownerId, 'owner');
  });
});

test('the same runId under two users is two independent runs', async () => {
  await withDb(async () => {
    armRaw();
    const runId = newRunId();
    await send(connect(ownerId, 'owner'), oneShotInit(runId));
    await send(connect(adminId, 'admin'), oneShotInit(runId));
    assert.equal(spawned.length, 2, 'the admin run is not blocked by the owner ledger row');
    spawned[0]!.exitListener?.({ exitCode: 1 });

    const owner = connect(ownerId, 'owner');
    await send(owner, oneShotInit(runId, { attachOnly: true }));
    assert.deepEqual(owner.sent, [{ type: 'oneshot_finished', runId, exitCode: 1 }]);
    const admin = connect(adminId, 'admin');
    await send(admin, oneShotInit(runId, { attachOnly: true }));
    assert.ok(admin.sent.some((frame) => frame.data?.includes('Reconnected')), 'admin run still live');
    assert.equal(spawned[1]!.kills, 0);
  });
});

test('attachOnly ignores its command: a login command cannot force-restart a live run', async () => {
  await withDb(async () => {
    armRaw();
    const runId = newRunId();
    await send(connect(ownerId, 'owner'), oneShotInit(runId));
    const crafted = connect(ownerId, 'owner');
    await send(crafted, oneShotInit(runId, {
      attachOnly: true, initialCommand: 'codex login --device-auth', provider: 'codex', forceRestart: true,
    }));
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.kills, 0, 'the live run was not killed');
    assert.ok(crafted.sent.some((frame) => frame.data?.includes('Reconnected')));
  });
});

test('attach and capture read the role from the database, not the socket', async () => {
  await withDb(async () => {
    armRaw();
    const runId = newRunId();
    await send(connect(adminId, 'admin'), oneShotInit(runId));
    spawned[0]!.exitListener?.({ exitCode: 0 });
    userDb.setRole(adminId, 'user');

    const attach = connect(adminId, 'admin');
    await send(attach, oneShotInit(runId, { attachOnly: true }));
    assertRefused(attach, 'forbidden');
    const capture = connect(adminId, 'admin');
    await send(capture, JSON.stringify({ type: 'oneshot_capture', runId }));
    assert.equal(capture.sent.at(-1)?.code, 'oneshot_capture_unavailable');
  });
});
