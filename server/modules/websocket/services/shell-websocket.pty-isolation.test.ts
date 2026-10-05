/**
 * shell-websocket.pty-isolation.test.ts — PHASE-MU م1, B-MU-PTY-TEST.
 *
 * Proves the two PTY vulnerabilities sealed by B-MU-PTY-ENV and B-MU-PTY-KEY are
 * actually closed by driving the real `handleShellConnection` dispatcher:
 *
 *   1. B-MU-PTY-ENV — the spawned terminal inherits the per-user isolated env
 *      built by the central seam `resolveProviderEnv(userId, provider, ...)`
 *      (same resolver as claude-sdk.js:784), NOT the operator's raw process.env.
 *      We mock the resolver to stamp a per-user marker and assert pty.spawn
 *      received it, and assert the JWT userId + the init payload's provider were
 *      passed through verbatim.
 *
 *   2. B-MU-PTY-KEY — the session key is namespaced per authenticated user, so
 *      user B initialising the SAME projectPath + sessionId as user A spawns a
 *      FRESH pty instead of reattaching to (hijacking) user A's live process.
 *
 * node-pty (native) and resolveProviderEnv (real fs/DB) are module-mocked so the
 * test stays a pure dispatch unit test inside the websocket module boundary.
 * Runner: Node built-in test runner with --experimental-test-module-mocks (see
 * the project `test` script). No Jest/Vitest.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

// Cross-module import (websocket → database) MUST go through the database
// barrel, per the `boundaries/dependencies` rule in eslint.config.js. Deep
// imports of connection.js / init-db.js are only legal for tests that live
// inside server/modules/database/ itself.
import { closeConnection, getConnection, initializeDatabase, projectsDb, userDb } from '@/modules/database/index.js';
import { installFakeHarnessOverrides } from '@/shared/__tests__/harness-binary-fixtures.js';
import { acceptFixtureRuntimeCompat, createCodexMachineFixture } from '@/shared/tests/codex-release-fixture.js';

import { RETIRED_PROVIDER_IDS } from '../../../../shared/retiredProviders.js';

// T-1873: PTY command lines are built from the harness registry; stub every
// non-codex harness through its server override so no case depends on host installs.
const harnessStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-harness-stubs-'));
const restoreHarnessOverrides = installFakeHarnessOverrides(harnessStubDir);
test.after(() => {
  restoreHarnessOverrides();
  fs.rmSync(harnessStubDir, { recursive: true, force: true });
});

// T-1872: codex PTYs run the machine release; a fixture stands in for it.
const codexMachineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-codex-machine-'));
const codexMachine = createCodexMachineFixture(codexMachineRoot);
await acceptFixtureRuntimeCompat();
process.env.CODEX_PATH = codexMachine.launcher;
process.on('exit', () => fs.rmSync(codexMachineRoot, { recursive: true, force: true }));
const codexExecutable = () => path.join(fs.realpathSync(codexMachine.release), 'bin', 'codex');
/** The file a (possibly bwrap-caged) PTY launch finally executes via `bash -c`. */
const unwrapPtyCommand = (call: { shell: string; args: string[] }): string[] => (
  path.basename(call.shell) === 'bwrap' ? call.args.slice(call.args.indexOf('--') + 1) : [call.shell, ...call.args]
);

// The PTY itself is mocked; point the managed launcher preflight at a real,
// inert executable so this suite is hermetic on CI hosts without Claude.
process.env.CLAUDE_CLI_PATH = process.execPath;

// --- Module mocks (must be registered before importing the service) ----------

// Capture every pty.spawn call: the env it was handed and a controllable fake
// child so the handler can register onData/onExit without a real terminal.
type CapturedSpawnOptions = {
  shell: string;
  args: string[];
  env: Record<string, string | undefined>;
  encoding?: string;
};
const spawnCalls: CapturedSpawnOptions[] = [];
function makeFakePty() {
  return {
    onData(_cb: (c: string) => void) {},
    onExit(_cb: (e: { exitCode: number; signal?: number }) => void) {},
    write(_d: string) {},
    resize(_c: number, _r: number) {},
    kill() {},
  };
}

// NB: this @types/node only types the (runtime-deprecated) defaultExport/
// namedExports option keys; the newer `exports` form is accepted at runtime but
// not yet in the type defs, so we use the typed keys to keep tsc clean.
mock.module('node-pty', {
  defaultExport: {
    spawn: (shell: string, args: string[], opts: Omit<CapturedSpawnOptions, 'shell' | 'args'>) => {
      spawnCalls.push({ shell, args, ...opts });
      return makeFakePty();
    },
  },
});

// Stub the isolation seam: echo back the userId + provider so the test can prove
// the handler forwarded the JWT userId and payload provider, and that the
// resolver's output (not raw process.env) reached pty.spawn.
//
// `isolatedHomeByUser` lets the PATH-priority tests (B-90) make the seam scope a
// per-user HOME, mirroring how an isolated provider (e.g. agy) places HOME inside
// the user's tree. The default resolver behavior leaves HOME untouched, so the
// pre-existing B-MU-PTY-ENV/KEY tests are unaffected.
const resolveCalls: { userId: unknown; provider: string; mode: unknown }[] = [];
const isolatedHomeByUser = new Map<string, string>();
mock.module('@/services/isolation/resolve-provider-env.js', {
  namedExports: {
    resolveProviderEnv: (
      userId: unknown,
      provider: string,
      baseEnv: Record<string, string>,
      mode?: string,
    ) => {
      resolveCalls.push({ userId, provider, mode });
      const isolatedHome = isolatedHomeByUser.get(String(userId));
      // Mirror the shape of the real seam per provider: claude → CLAUDE_CONFIG_DIR,
      // opencode → XDG_DATA_HOME (B5), kimi → KIMI_CODE_HOME but ONLY in agent
      // mode (SL-5/ADR-062 — the real resolver gates that knob on mode==='agent').
      // This lets the isolation tests prove the handler forwarded the RIGHT
      // provider AND the right mode, so the correct knob is applied.
      const providerKnob = provider === 'opencode'
        ? { XDG_DATA_HOME: `/isolated/${String(userId)}/.local/share` }
        : provider === 'kimi'
          ? (mode === 'agent' ? { KIMI_CODE_HOME: `/isolated/${String(userId)}/.kimi` } : {})
          : { CLAUDE_CONFIG_DIR: `/isolated/${String(userId)}/.claude` };
      return {
        ...baseEnv,
        ...(isolatedHome ? { HOME: isolatedHome } : {}),
        ...providerKnob,
        __ISOLATED_FOR__: String(userId),
        __ISOLATION_PROVIDER__: provider,
      };
    },
  },
});

const { handleShellConnection } = await import('./shell-websocket.service.js');
const { isProjectPathWritableByUser } = await import('./chat-websocket.service.js');
const { createStandaloneTerminal, resetStandaloneTerminalsForTest } = await import(
  '@/services/standalone-terminals/standalone-terminal-registry.js'
);

// --- Database isolation ------------------------------------------------------

/**
 * Runs `runTest` against a throwaway SQLite file in os.tmpdir().
 *
 * WHY this file needs it: `handleShellConnection` gates every init on
 * `projectsDb.isProjectPathVisibleToUser(...)`, which SELECTs from `projects`.
 * Without an initialised database the connection singleton falls back to
 * `resolveLegacyDatabasePath()` (`<repo>/database/auth.db`, connection.ts) — a
 * stale file that only carries `app_config`, so every spawn path died with
 * `no such table: projects` (5 of the 7 tests here). Worse, when the shell
 * happened to export DATABASE_PATH the suite silently ran against the LIVE
 * production database.
 *
 * Same shape as `projects.db.integration.test.ts` / `migrations.cascade.test.ts`
 * so there is one isolation idiom across the backend suite.
 */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'pty-isolation-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// --- Test doubles ------------------------------------------------------------

const WS_OPEN_STATE = 1;

function makeFakeWs() {
  const sent: unknown[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
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

/**
 * The init payload the project Shell tab ACTUALLY sends
 * (src/components/shell/hooks/useShellConnection.ts:234-255): no initialCommand,
 * not a plain shell — the PTY then follows the provider template (`claude`).
 *
 * SEC-SHELL-ROLE (shell-websocket.service.ts:549-570) closes the socket with
 * 4403 on a FREE-FORM initialCommand from a non-admin, so the synthetic `true`
 * this helper used to send no longer reaches the spawn path at all. These
 * isolation tests are about the env/session-key of an ORDINARY member's
 * terminal, so they model the real client payload instead of weakening the gate.
 * `overrides` lets a test model the provider-login modals — the only client flow
 * that carries an initialCommand.
 */
function initMessage(projectPath: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  });
}

/**
 * The authenticated request shape verifyWebSocketClient stamps: id AND role.
 * `role` is populated on every real connection (auth.js:329 returns
 * `role: user.role`, and `role` is in PUBLIC_COLUMNS, users.ts:58), so omitting
 * it here would model a state the server never produces. 'user' is the ordinary
 * member role — the one these isolation guarantees exist to protect.
 */
function asRequest(id: unknown, role: string | undefined = 'user') {
  return { user: { id, role } } as never;
}

// Use the real cwd as projectPath: the handler statSyncs it and requires a dir.
const PROJECT_PATH = process.cwd();

/** Emits one init frame and asserts the typed refusal with no env resolution and no PTY. */
function assertRetiredShellRefusal(overrides: Record<string, unknown>, label: string) {
  spawnCalls.length = 0;
  resolveCalls.length = 0;
  const ws = makeFakeWs();
  handleShellConnection(ws as never, asRequest(7), deps);
  ws.emit('message', initMessage(PROJECT_PATH, overrides));
  assert.equal(resolveCalls.length, 0, `${label}: no env is resolved`);
  assert.equal(spawnCalls.length, 0, `${label}: no PTY is spawned`);
  const error = ws.sent.find((frame) => (frame as { code?: string })?.code === 'provider_removed');
  assert.ok(error, `${label}: a stable provider_removed frame is emitted`);
}

for (const retired of RETIRED_PROVIDER_IDS) {
  test(`${retired}: a retired provider PTY is refused before env resolution or spawn`, async () => {
    await withIsolatedDatabase(() => {
      assertRetiredShellRefusal({ provider: retired }, `${retired} PTY`);
      assertRetiredShellRefusal(
        { provider: retired, sessionId: 'resume-1', hasSession: true }, `${retired} resume`,
      );
    });
  });
}

// T-1953: the fixed login commands the UI issued for the retired bodies. Each is
// refused under its own provider. The third column is the refusal a MEMBER gets
// when the command is paired with a live provider instead: a command still in
// PROVIDER_CANONICAL_LOGIN_COMMANDS fails the command-provider binding, while
// the hermes login left that map with its body and is now an arbitrary shell
// command, which the role gate forbids to members.
const RETIRED_LOGIN_COMMANDS: ReadonlyArray<[string, string, string]> = [
  ['cursor', 'cursor-agent login', 'provider_mismatch'],
  ['hermes', 'hermes setup --portal', 'forbidden'],
  ['kimi', 'kimi login', 'provider_mismatch'],
];

for (const [provider, initialCommand, smuggledRefusal] of RETIRED_LOGIN_COMMANDS) {
  test(`${provider}: the login command "${initialCommand}" is refused as provider_removed`, async () => {
    await withIsolatedDatabase(() => {
      assert.equal(RETIRED_PROVIDER_IDS.has(provider), true);
      assertRetiredShellRefusal({ provider, initialCommand, isPlainShell: true }, `${provider} login`);
    });
  });

  test(`${provider}: its login command cannot be smuggled under a live provider`, async () => {
    await withIsolatedDatabase(() => {
      spawnCalls.length = 0;
      const ws = makeFakeWs();
      handleShellConnection(ws as never, asRequest(7), deps);
      ws.emit('message', initMessage(PROJECT_PATH, { provider: 'claude', initialCommand, isPlainShell: true }));
      assert.equal(spawnCalls.length, 0, 'no PTY is spawned');
      const error = ws.sent.find((frame) => (frame as { code?: string })?.code === smuggledRefusal);
      assert.ok(error, `the pair is refused with ${smuggledRefusal}`);
    });
  });
}

test('B-MU-PTY-ENV: PTY env comes from resolveProviderEnv(userId, provider) — not raw process.env', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;

    const ws = makeFakeWs();
    handleShellConnection(ws as never, asRequest(7), deps);
    ws.emit('message', initMessage(PROJECT_PATH));

    assert.equal(resolveCalls.length, 1, 'resolver consulted exactly once');
    assert.equal(resolveCalls[0].userId, 7, 'JWT userId forwarded to the seam');
    assert.equal(resolveCalls[0].provider, 'claude', 'payload provider forwarded to the seam');

    assert.equal(spawnCalls.length, 1, 'one pty spawned');
    const env = spawnCalls[0].env;
    assert.equal(
      env.__ISOLATED_FOR__,
      '7',
      'spawn env carries the per-user isolated marker (resolver output reached pty.spawn)'
    );
    assert.equal(
      env.CLAUDE_CONFIG_DIR,
      '/isolated/7/.claude',
      'spawn env carries the per-user CLAUDE_CONFIG_DIR'
    );
    // Terminal vars still layered on top of the isolated env.
    assert.equal(env.TERM, 'xterm-256color');
    assert.equal(env.COLORTERM, 'truecolor');
  });
});

test('B-ARABIC-PTY: project/chat PTY forces a UTF-8 locale and node-pty decoding', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;

    const previousLang = process.env.LANG;
    const previousLcAll = process.env.LC_ALL;
    const previousLcCtype = process.env.LC_CTYPE;
    process.env.LANG = 'C';
    process.env.LC_ALL = 'C';
    process.env.LC_CTYPE = 'C';

    try {
      const ws = makeFakeWs();
      handleShellConnection(ws as never, asRequest(901), deps);
      ws.emit('message', initMessage(PROJECT_PATH));

      assert.equal(spawnCalls.length, 1, 'one pty spawned');
      const options = spawnCalls[0]!;
      assert.equal(options.encoding, 'utf8', 'node-pty decodes PTY output as UTF-8');
      assert.equal(options.env.LANG, 'C.UTF-8');
      assert.equal(options.env.LC_ALL, 'C.UTF-8');
      assert.equal(options.env.LC_CTYPE, 'C.UTF-8');
    } finally {
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
      if (previousLcAll === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLcAll;
      if (previousLcCtype === undefined) delete process.env.LC_CTYPE;
      else process.env.LC_CTYPE = previousLcCtype;
    }
  });
});

test('general Claude shell omits a stale sessionId when hasSession is false', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    const ws = makeFakeWs();
    handleShellConnection(ws as never, asRequest(7), deps);
    ws.emit('message', initMessage(PROJECT_PATH, { hasSession: false, sessionId: 'stale-session' }));

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0]!.env.NASSAJ_MANAGED_CLAUDE_MODE, 'general');
    assert.equal(spawnCalls[0]!.env.NASSAJ_MANAGED_CLAUDE_SESSION_ID, undefined);
  });
});

test('Codex conversation terminal resumes the SDK thread directly, never opens a fresh Codex TUI', async () => {
  await withIsolatedDatabase(async () => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;
    const sessionId = '11111111-2222-7333-8444-555555555555';

    const ws = makeFakeWs();
    handleShellConnection(ws as never, asRequest(902), deps);
    ws.emit('message', initMessage(PROJECT_PATH, {
      provider: 'codex',
      hasSession: true,
      sessionId,
    }));
    // T-1872 part 2: the runtime-compat verdict is awaited before the PTY spawns.
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(spawnCalls.length, 1, 'one Codex conversation PTY spawned');
    assert.equal(resolveCalls[0]?.provider, 'codex', 'Codex credentials are resolved per user');
    assert.equal(
      unwrapPtyCommand(spawnCalls[0]!).at(-1),
      `'${codexExecutable()}' 'resume' '--include-non-interactive' '${sessionId}'`,
      'SDK-created (non-interactive) thread is resumed by its exact id on the machine release'
    );
    assert.ok(String(spawnCalls[0]?.env.PATH).startsWith(
      path.join(fs.realpathSync(codexMachine.release), 'codex-path')));
    assert.ok(
      !spawnCalls[0]?.args.at(-1)?.includes('|| codex'),
      'a failed resume must not silently open an unrelated fresh/sign-in TUI'
    );
    assert.equal(
      spawnCalls[0]?.env.__ISOLATED_FOR__,
      '902',
      'resume uses only the authenticated user credential environment'
    );
  });
});

test('T-1872: a missing machine Codex refuses the PTY with the install hint', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    const saved = process.env.CODEX_PATH;
    process.env.CODEX_PATH = path.join(codexMachineRoot, 'absent', 'codex');
    try {
      const ws = makeFakeWs();
      handleShellConnection(ws as never, asRequest(904), deps);
      ws.emit('message', initMessage(PROJECT_PATH, { provider: 'codex' }));
      assert.equal(spawnCalls.length, 0, 'no PTY without the machine release');
      const frame = ws.sent.find((item) => (item as { code?: string }).code === 'codex_not_installed') as
        { message?: string } | undefined;
      assert.match(String(frame?.message), /Codex غير مثبّت على الجهاز/u);
    } finally { process.env.CODEX_PATH = saved; }
  });
});

test('T-1872: codex login PTY runs the machine release by quoted realpath, never PATH codex', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    const ws = makeFakeWs();
    handleShellConnection(ws as never, asRequest(903), deps);
    ws.emit('message', initMessage(PROJECT_PATH, {
      provider: 'codex',
      initialCommand: 'codex login --device-auth',
    }));
    assert.equal(spawnCalls.length, 1, 'one login PTY spawned');
    const argv = unwrapPtyCommand(spawnCalls[0]!);
    assert.equal(argv.at(-1), `'${codexExecutable()}' 'login' '--device-auth'`);
    assert.ok(!/(^|\s)codex\s/u.test(argv.at(-1)!), 'no PATH-resolved codex word');
  });
});

test('B-MU-PTY-KEY: same projectPath+sessionId across two users spawns separate PTYs (no hijack)', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;

    // Use a temporary directory that is NOT registered in the project DB.
    // isProjectPathVisibleToUser has a fail-closed guard that rejects non-integer
    // userIds ('alice', 'bob') for any registered project — even public ones.
    // A temp path is not registered, so the guard returns true unconditionally
    // (creation/first-run flow), letting the spawn proceed regardless of userId type.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-key-test-'));
    try {
      // User A connects and spawns.
      const wsA = makeFakeWs();
      handleShellConnection(wsA as never, asRequest('alice'), deps);
      wsA.emit('message', initMessage(tempDir));
      assert.equal(spawnCalls.length, 1, 'user A spawned a pty');

      // User B connects with the IDENTICAL init (same projectPath, default session).
      const wsB = makeFakeWs();
      handleShellConnection(wsB as never, asRequest('bob'), deps);
      wsB.emit('message', initMessage(tempDir));

      // If the key were NOT user-namespaced, B would reattach to A's session and no
      // second spawn would occur. A fresh spawn proves the keys are disjoint.
      assert.equal(spawnCalls.length, 2, 'user B got its OWN pty, never reattached to user A');
      assert.equal(resolveCalls[1].userId, 'bob', 'user B env resolved under bob, not alice');

      // And B must not have received the "Reconnected to existing session" banner.
      const reconnected = wsB.sent.some(
        (m) => typeof m === 'object' && m !== null && 'data' in m
          && typeof (m as { data: unknown }).data === 'string'
          && (m as { data: string }).data.includes('Reconnected')
      );
      assert.equal(reconnected, false, 'user B was not reconnected into another session');
    } finally {
      fs.rmdirSync(tempDir);
    }
  });
});

/** Opens one project PTY for `userId` at `cwd`; returns the close code (undefined = opened). */
function openPty(userId: number, cwd: string): number | undefined {
  const ws = makeFakeWs();
  handleShellConnection(ws as never, asRequest(userId), deps);
  ws.emit('message', initMessage(cwd));
  return ws.closes[0]?.code;
}

/** Runs `body` with PROJECT_MEMBERSHIP_ENFORCE and WORKSPACES_ROOT set, then restores both. */
async function withEnforcement(root: string, body: () => void | Promise<void>): Promise<void> {
  const saved = { enforce: process.env.PROJECT_MEMBERSHIP_ENFORCE, root: process.env.WORKSPACES_ROOT };
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  process.env.WORKSPACES_ROOT = root;
  try {
    await body();
  } finally {
    for (const [key, value] of [['PROJECT_MEMBERSHIP_ENFORCE', saved.enforce], ['WORKSPACES_ROOT', saved.root]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('B-1411 (flag off): a non-member owner and a team member may start in a public project (ADR-089)', async () => {
  await withIsolatedDatabase(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-b1411-off-'));
    try {
      const creator = userDb.createUser('b1411-creator', 'hash', 'user');
      const owner = userDb.createUser('b1411-owner', 'hash', 'owner');
      const teammate = userDb.createUser('b1411-teammate', 'hash', 'user');
      projectsDb.createProjectPath(tempDir, 'B1411', creator.id);
      for (const user of [owner, teammate]) {
        spawnCalls.length = 0;
        assert.equal(isProjectPathWritableByUser(tempDir, user.id), true, `chat gate: ${user.username}`);
        assert.equal(openPty(user.id, tempDir), undefined, `PTY not refused: ${user.username}`);
        assert.equal(spawnCalls.length, 1, `PTY spawned: ${user.username}`);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('B-1411 (flag on): a non-member is refused at the root, a sub-folder, a symlink and a standalone terminal', async () => {
  await withIsolatedDatabase(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-b1411-on-')));
    const projectDir = path.join(root, 'proj');
    const subDir = path.join(projectDir, 'src');
    const linkDir = path.join(root, 'link-to-proj');
    fs.mkdirSync(subDir, { recursive: true });
    fs.symlinkSync(projectDir, linkDir);
    try {
      const creator = userDb.createUser('b1411-on-creator', 'hash', 'user');
      const reader = userDb.createUser('b1411-on-reader', 'hash', 'user');
      const created = projectsDb.createProjectPath(projectDir, 'B1411on', creator.id);
      const projectId = created.project?.project_id as string;
      await withEnforcement(root, () => {
        for (const cwd of [projectDir, subDir, linkDir]) {
          spawnCalls.length = 0;
          assert.equal(isProjectPathWritableByUser(cwd, reader.id), false, `chat gate refuses ${cwd}`);
          assert.equal(openPty(reader.id, cwd), 4404, `PTY refused at ${cwd}`);
          const standalone = createStandaloneTerminal({ userId: reader.id, cwd, writerLease: { release() {} } });
          assert.equal(standalone.ok, false, `standalone refused at ${cwd}`);
          assert.equal(spawnCalls.length, 0, `nothing spawned at ${cwd}`);
        }
        getConnection().prepare('INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, ?, ?)')
          .run(projectId, reader.id, 'member', creator.id);
        assert.equal(isProjectPathWritableByUser(subDir, reader.id), true, 'a member passes via sub-folder');
        assert.equal(createStandaloneTerminal({ userId: reader.id, cwd: linkDir, writerLease: { release() {} } }).ok, true,
          'a member passes via symlink');
      });
    } finally {
      resetStandaloneTerminalsForTest();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('B-MU-PTY-KEY (fail-closed): PTY init with no authenticated user is refused — no spawn, no shared key', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;

    // A connection that somehow reaches the handler without request.user (i.e. the
    // verifyClient invariant was bypassed by a future change). The fail-closed gate
    // must refuse it outright rather than fall back to a shared 'anon' session key.
    const ws = makeFakeWs();
    handleShellConnection(ws as never, {} as never, deps);
    ws.emit('message', initMessage(PROJECT_PATH));

    assert.equal(spawnCalls.length, 0, 'no pty spawned for a userId-less connection');
    assert.equal(resolveCalls.length, 0, 'env resolver never consulted (no spawn path entered)');

    // The client is told auth is required and the socket is closed (policy code).
    const sentError = ws.sent.some(
      (m) => typeof m === 'object' && m !== null
        && (m as { type?: unknown }).type === 'error'
    );
    assert.equal(sentError, true, 'an error frame was sent to the client');
    assert.equal(ws.closes.length, 1, 'the connection was closed');
    assert.equal(ws.closes[0].code, 4401, 'closed with the auth-required policy code');
  });
});

test('B-MU-PTY-KEY (fail-closed): two no-user connections never collide on a shared session key', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;

    // Two distinct anonymous connections with the IDENTICAL init. Under the old
    // `userId ?? 'anon'` fallback they would have shared `anon_<path>_default` and
    // the second could hijack the first. Fail-closed: both are refused, neither
    // spawns, so there is no shared key to collide on.
    const wsA = makeFakeWs();
    handleShellConnection(wsA as never, {} as never, deps);
    wsA.emit('message', initMessage(PROJECT_PATH));

    const wsB = makeFakeWs();
    handleShellConnection(wsB as never, {} as never, deps);
    wsB.emit('message', initMessage(PROJECT_PATH));

    assert.equal(spawnCalls.length, 0, 'neither anonymous connection spawned a pty');
    assert.equal(wsA.closes.length, 1, 'connection A was closed');
    assert.equal(wsB.closes.length, 1, 'connection B was closed');

    // Neither got the "Reconnected" banner — there is no live session to attach to.
    const reconnected = [...wsA.sent, ...wsB.sent].some(
      (m) => typeof m === 'object' && m !== null && 'data' in m
        && typeof (m as { data: unknown }).data === 'string'
        && (m as { data: string }).data.includes('Reconnected')
    );
    assert.equal(reconnected, false, 'no anonymous reconnection/hijack occurred');
  });
});

test('B5: an opencode PTY for a non-owner resolves the opencode (XDG) isolation, not claude', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;

    const ws = makeFakeWs();
    handleShellConnection(ws as never, asRequest(42), deps);
    ws.emit('message', initMessage(PROJECT_PATH, { provider: 'opencode' }));

    assert.equal(resolveCalls.length, 1, 'resolver consulted once');
    assert.equal(
      resolveCalls[0].provider,
      'opencode',
      'the opencode provider was forwarded verbatim (not collapsed to the claude default)'
    );

    assert.equal(spawnCalls.length, 1, 'one pty spawned');
    const env = spawnCalls[0].env;
    assert.equal(
      env.XDG_DATA_HOME,
      '/isolated/42/.local/share',
      'the PTY carries the per-user opencode XDG_DATA_HOME isolation'
    );
    assert.equal(env.__ISOLATION_PROVIDER__, 'opencode', 'opencode isolation applied, not claude');
    // The mock stamps CLAUDE_CONFIG_DIR=/isolated/<id>/.claude ONLY for the claude
    // knob. Under the pre-fix bug (opencode collapsing to the 'claude' default)
    // that path would have been applied here; it must not be.
    assert.notEqual(
      env.CLAUDE_CONFIG_DIR,
      '/isolated/42/.claude',
      'the claude CONFIG_DIR knob was NOT applied to an opencode terminal (pre-fix bug)'
    );
  });
});

// --- ADR-062 / B-KIMI-TERM: the Kimi login terminal --------------------------
//
// T-1953: the kimi body is retired, so its login terminal is refused as
// `provider_removed` before env resolution (asserted with the retired login
// commands above). The agent-mode seam assertion that lived here is gone with
// the terminal it described; what remains is that no other PTY drifted.

test('B-KIMI-TERM: every non-kimi PTY still resolves in chat mode (no behaviour drift)', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;

    const ws = makeFakeWs();
    // A userId unused elsewhere in this file: ptySessionsMap is module-level, so
    // reusing an id + path from an earlier test would REATTACH instead of spawn.
    handleShellConnection(ws as never, asRequest(77, 'user'), deps);
    ws.emit('message', initMessage(PROJECT_PATH));

    assert.equal(resolveCalls.length, 1, 'resolver consulted once');
    assert.equal(resolveCalls[0].provider, 'claude');
    assert.equal(
      resolveCalls[0].mode,
      'chat',
      'chat is the value the resolvers already defaulted to — claude/opencode/'
      + 'codex launches are byte-identical to before the kimi wiring'
    );
  });
});

// --- B-90: user npm-global binaries are surfaced in the PTY PATH --------------

/**
 * Builds a throwaway project dir + a per-user isolated HOME whose
 * `.npm-global/bin` exists on disk, and registers that HOME with the mocked
 * isolation seam. Returns the paths and a single-use cleanup.
 */
function makeIsolatedUserFixture(userId: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pty-b90-${userId}-`));
  const projectDir = path.join(root, 'project');
  const isolatedHome = path.join(root, 'home');
  const npmGlobalBin = path.join(isolatedHome, '.npm-global', 'bin');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(npmGlobalBin, { recursive: true });
  isolatedHomeByUser.set(userId, isolatedHome);
  return {
    projectDir,
    isolatedHome,
    npmGlobalBin,
    cleanup() {
      isolatedHomeByUser.delete(userId);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function pathEntriesOf(env: Record<string, string | undefined>): string[] {
  return String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

test("B-90: the user's npm-global bin stays ahead of system PATH after the managed launcher", async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;
    const fx = makeIsolatedUserFixture('npmuser');
    try {
      const ws = makeFakeWs();
      handleShellConnection(ws as never, asRequest('npmuser'), deps);
      ws.emit('message', initMessage(fx.projectDir));

      assert.equal(spawnCalls.length, 1, 'one pty spawned');
      const entries = pathEntriesOf(spawnCalls[0].env);

      assert.equal(
        entries[1],
        fx.npmGlobalBin,
        "the user's npm-global bin follows only the managed Claude launcher"
      );
      // The pre-existing system PATH (from process.env, carried through the seam)
      // is preserved AFTER the hoisted user dir — never dropped, never ahead of it.
      const systemEntry = String(process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .find((p) => p.startsWith('/usr') || p === '/bin' || p === '/sbin');
      if (systemEntry) {
        const userIdx = entries.indexOf(fx.npmGlobalBin);
        const sysIdx = entries.indexOf(systemEntry);
        assert.ok(sysIdx > userIdx, 'a system PATH dir sorts AFTER the user npm-global bin');
        assert.ok(entries.includes(systemEntry), 'existing system PATH entries are preserved');
      }
    } finally {
      fx.cleanup();
    }
  });
});

test("B-1058: the user's ~/.local/bin (native Claude installer) is hoisted right after npm-global", async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;
    const fx = makeIsolatedUserFixture('localbinuser');
    const localBin = path.join(fx.isolatedHome, '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    try {
      const ws = makeFakeWs();
      handleShellConnection(ws as never, asRequest('localbinuser'), deps);
      ws.emit('message', initMessage(fx.projectDir));

      assert.equal(spawnCalls.length, 1, 'one pty spawned');
      const entries = pathEntriesOf(spawnCalls[0].env);
      assert.equal(entries[1], fx.npmGlobalBin, 'npm-global bin follows the managed launcher');
      assert.equal(entries[2], localBin, '~/.local/bin follows the npm-global bin');
    } finally {
      fx.cleanup();
    }
  });
});

test('B-90 (isolation): user A npm-global path never leaks into user B PTY PATH', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;
    const fxA = makeIsolatedUserFixture('alice-npm');
    const fxB = makeIsolatedUserFixture('bob-npm');
    try {
      const wsA = makeFakeWs();
      handleShellConnection(wsA as never, asRequest('alice-npm'), deps);
      wsA.emit('message', initMessage(fxA.projectDir));

      const wsB = makeFakeWs();
      handleShellConnection(wsB as never, asRequest('bob-npm'), deps);
      wsB.emit('message', initMessage(fxB.projectDir));

      assert.equal(spawnCalls.length, 2, 'both users spawned a pty');
      const entriesA = pathEntriesOf(spawnCalls[0].env);
      const entriesB = pathEntriesOf(spawnCalls[1].env);

      // The managed launcher is first; each user's own npm-global bin is second.
      assert.equal(entriesA[1], fxA.npmGlobalBin, "A's npm-global bin follows the launcher");
      assert.equal(entriesB[1], fxB.npmGlobalBin, "B's npm-global bin follows the launcher");

      // And crucially, neither user's npm-global bin appears ANYWHERE in the
      // other's PATH — isolation is preserved because the candidate is derived
      // from each user's isolated HOME, not a shared/operator home.
      assert.ok(
        !entriesB.includes(fxA.npmGlobalBin),
        "A's npm-global bin must NOT appear in B's PTY PATH"
      );
      assert.ok(
        !entriesA.includes(fxB.npmGlobalBin),
        "B's npm-global bin must NOT appear in A's PTY PATH"
      );
    } finally {
      fxA.cleanup();
      fxB.cleanup();
    }
  });
});

// --- SEC-SHELL-ROLE: the free-form-command gate, driven end to end ------------
//
// The pure policy function is unit-tested elsewhere; what these two prove is
// that the gate is WIRED into the dispatcher — that it runs BEFORE pty.spawn and
// before the isolation seam, and that it does not swallow the legitimate flows
// every role still needs.

test('SEC-SHELL-ROLE: a plain member sending a FREE-FORM command is refused (4403), nothing spawns', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;

    const ws = makeFakeWs();
    handleShellConnection(ws as never, asRequest(11, 'user'), deps);
    // The bypass this gate exists to stop: an arbitrary host command smuggled in
    // as initialCommand and run as `bash -c <verbatim>` under the server account.
    ws.emit('message', initMessage(PROJECT_PATH, {
      isPlainShell: true,
      initialCommand: 'id > /tmp/pwned',
    }));

    assert.equal(spawnCalls.length, 0, 'no pty spawned for a non-admin free-form command');
    assert.equal(
      resolveCalls.length,
      0,
      'refused BEFORE the isolation seam — no env is even built for the rejected command'
    );

    const errorFrame = ws.sent.find(
      (m) => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'error'
    ) as { code?: string } | undefined;
    assert.ok(errorFrame, 'an error frame was sent to the client');
    assert.equal(errorFrame?.code, 'forbidden', 'the refusal is labelled forbidden, not auth');
    assert.equal(ws.closes.length, 1, 'the connection was closed');
    assert.equal(ws.closes[0].code, 4403, 'closed with the forbidden policy code');
  });
});

test('SEC-SHELL-ROLE: a plain member may still run the fixed provider-login command', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;

    // Exactly what ProviderLoginModal sends for opencode
    // (src/components/provider-auth/view/ProviderLoginModal.tsx) — a member must
    // keep being able to authenticate their OWN isolated provider credentials.
    const ws = makeFakeWs();
    handleShellConnection(ws as never, asRequest(12, 'user'), deps);
    ws.emit('message', initMessage(PROJECT_PATH, {
      provider: 'opencode',
      isPlainShell: true,
      initialCommand: 'opencode auth login',
    }));

    assert.equal(ws.closes.length, 0, 'the login terminal was NOT closed by the role gate');
    assert.equal(spawnCalls.length, 1, 'the provider-login pty spawned as before');
    assert.equal(
      spawnCalls[0].env.XDG_DATA_HOME,
      '/isolated/12/.local/share',
      'and it still runs under the member\'s own isolated credential dir'
    );
  });
});

test('SEC-SHELL-ROLE: the owner keeps the free-form terminal (the gate is role-based, not a global ban)', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;

    const ws = makeFakeWs();
    handleShellConnection(ws as never, asRequest(1, 'owner'), deps);
    ws.emit('message', initMessage(PROJECT_PATH, {
      isPlainShell: true,
      initialCommand: 'ls -la',
    }));

    assert.equal(ws.closes.length, 0, 'the owner terminal was not closed');
    assert.equal(spawnCalls.length, 1, 'the owner still gets a pty for a free-form command');
    assert.equal(
      spawnCalls[0].env.__ISOLATED_FOR__,
      '1',
      'and it is still built through the per-user isolation seam'
    );
  });
});


test('local update maintenance fences already-open shell and terminal frames and new upgrades', async () => {
  const { setApplicationWriterGateForTests } = await import('../../../services/update-writer-lease.js');
  const { handleTerminalConnection } = await import('./terminal-websocket.service.js');
  const { verifyWebSocketClient } = await import('./websocket-auth.service.js');
  const previousMode = process.env.NASSAJ_UPDATE_MODE, previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test'; process.env.NASSAJ_UPDATE_MODE = 'local-main';
  let closed = false, effects = 0;
  setApplicationWriterGateForTests({ async acquireWriterLease() {
    if (closed) throw new Error('update_maintenance_active');
    return { release() {} };
  } });
  try {
    const terminal = makeFakeWs();
    handleTerminalConnection(terminal as never, asRequest(1, 'owner'), {
      attachSocket: () => { effects++; return { terminal: { id: 't', status: 'running' } as never, truncated: false, replay: [], displaced: null }; },
      resizeTerminal: () => { effects++; }, writeInput: () => { effects++; return { outcome: 'written' }; }, detachSocket: () => {},
    });
    terminal.emit('message', JSON.stringify({ type: 'init', terminalId: 't' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(effects, 2);
    const shell = makeFakeWs(); handleShellConnection(shell as never, asRequest(1, 'owner'), deps);
    closed = true; const spawned = spawnCalls.length;
    for (const type of ['init', 'input', 'resize']) {
      terminal.emit('message', JSON.stringify({ type, terminalId: 't', data: 'echo forbidden', cols: 80, rows: 24 }));
      shell.emit('message', type === 'init' ? initMessage(PROJECT_PATH) : JSON.stringify({ type, data: 'echo forbidden' }));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(effects, 2); assert.equal(spawnCalls.length, spawned);
    // ONE notice per gate closure per socket (not one per frame): three frames
    // were refused on each socket, one banner was sent on each.
    assert.equal(terminal.sent.filter((frame: any) => frame.code === 'update_maintenance_active').length, 1);
    assert.equal(shell.sent.filter((frame: any) => frame.code === 'update_maintenance_active').length, 1);
    let authenticated = false;
    assert.equal(verifyWebSocketClient({ req: {} } as never, {
      isPlatform: false, canAcceptApplications: () => false, authenticateWebSocket: () => { authenticated = true; return { id: 1 }; },
      jwtSecret: 'unused', recordRejection: () => {}, clientIp: () => null,
    }), false);
    assert.equal(authenticated, false);
    assert.doesNotThrow(() => assert.equal(verifyWebSocketClient({ req: {} } as never, {
      isPlatform: false, canAcceptApplications: () => { throw new Error('maintenance_checksum_invalid'); },
      authenticateWebSocket: () => { authenticated = true; return { id: 1 }; }, jwtSecret: 'unused',
      recordRejection: () => {}, clientIp: () => null,
    }), false));
    assert.equal(authenticated, false);
  } finally {
    setApplicationWriterGateForTests(null);
    if (previousMode === undefined) delete process.env.NASSAJ_UPDATE_MODE; else process.env.NASSAJ_UPDATE_MODE = previousMode;
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  }
});

// --- B-PTY-GATE-DIAG: the update-gate PTY denial must be diagnosable ---------
//
// Field incident: a fleet node's Claude terminal opened BLACK and EMPTY. The
// PTY writer-lease acquisition was being denied by the update maintenance gate,
// but the denial was silent server-side (no log at all) and the client frame
// carried no `code`, so nothing on either end named the cause. These tests pin
// the contract of that refusal path: it logs, it labels the frame with the
// gate's reason code, it leaves the socket OPEN, and it leaks no PTY session.

/**
 * The reason codes the update gate ACTUALLY throws, parsed from its source.
 *
 * Derived from `update-maintenance-gate.js` on purpose: the first version of
 * this suite iterated the hand-written allow-list instead, so it went green
 * while the code a real concurrent update raises (`update_lock_contended`) was
 * still being mislabelled "maintenance active". The list itself is drift-guarded
 * in update-maintenance-gate.reason-codes.test.js.
 */
const GATE_THROWN_CODES: string[] = [...new Set(
  [...fs.readFileSync(
    new URL('../../../services/update-maintenance-gate.js', import.meta.url),
    'utf8'
  ).matchAll(/new Error\('(update_[a-z0-9_]+)'\)/g)].map((match) => match[1])
)].sort();

/** Runs `body` with console.error captured, restoring it afterwards. */
async function withCapturedErrorLog(
  body: (lines: string[]) => void | Promise<void>
): Promise<void> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await body(lines);
  } finally {
    console.error = original;
  }
}

/** deps whose PTY writer lease is denied with `message`, like a closed gate. */
function denyingDeps(message: string) {
  return {
    ...(deps as unknown as Record<string, unknown>),
    acquireWriterLease: (kind: string) => {
      if (kind === 'managed-pty') return Promise.reject(new Error(message));
      return { release() {} };
    },
  } as unknown as Parameters<typeof handleShellConnection>[2];
}

/** Drives one init through a denying gate and returns what the client saw. */
async function initUnderDeniedGate(message: string, lines: string[], sessionId: string) {
  const ws = makeFakeWs();
  handleShellConnection(ws as never, asRequest(1, 'owner'), denyingDeps(message));
  ws.emit('message', initMessage(PROJECT_PATH, { sessionId }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const frame = ws.sent.find(
    (m) => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'error'
  ) as { code?: string; message?: string } | undefined;
  return { ws, frame, lines };
}

test('B-PTY-GATE-DIAG: a denied PTY writer lease is logged and the frame carries the gate code', async () => {
  await withIsolatedDatabase(async () => {
    for (const code of GATE_THROWN_CODES) {
      await withCapturedErrorLog(async (lines) => {
        spawnCalls.length = 0;
        const { ws, frame } = await initUnderDeniedGate(code, lines, `gate-diag-${code}`);

        assert.equal(spawnCalls.length, 0, `no pty spawned when the gate denies (${code})`);
        assert.ok(frame, `an error frame reached the client for ${code}`);
        assert.equal(frame?.code, code, 'the frame is labelled with the gate reason code');
        assert.equal(
          frame?.message,
          'Source update maintenance is active',
          'the human message stays generic — no paths, no internals'
        );
        assert.equal(ws.closes.length, 0, 'the socket stays OPEN so the client can retry');
        assert.equal(
          lines.filter((line) => line.includes(code)).length,
          1,
          `the denial produced exactly one server log naming ${code}`
        );
        assert.ok(
          lines.every((line) => line.includes('[ERROR] Shell WebSocket rejected:')),
          'the log follows the sibling refusal wording in this handler'
        );
      });
    }
  });
});

test('B-PTY-GATE-DIAG: an UNKNOWN gate message does not break the path and never leaks its text', async () => {
  await withIsolatedDatabase(async () => {
    await withCapturedErrorLog(async (lines) => {
      spawnCalls.length = 0;
      const secret = '/home/operator/.secret/token-zz9';
      const { ws, frame } = await initUnderDeniedGate(`boom at ${secret}`, lines, 'gate-diag-unknown');

      assert.equal(spawnCalls.length, 0, 'still no pty');
      assert.ok(frame, 'the client still receives a labelled error frame');
      // B-1253 M-1 CORRECTS THIS EXPECTATION. It used to assert
      // `update_maintenance_active`, i.e. that an unrecognised rejection is
      // announced to the user as an update running. That collapse is right for
      // DISPLAY of a known gate code and wrong as an ANSWER to "was this the
      // gate?": no update was running, so the frame stated a cause that did not
      // exist. The refusal itself is unchanged — still no PTY, still an error
      // frame — only the claim it makes.
      assert.equal(
        frame?.code,
        'writer_lease_unavailable',
        'an unrecognised rejection is refused as itself, not as update maintenance'
      );
      assert.ok(
        !String(frame?.message).includes('maintenance'),
        `the user was told an update was running when none was: ${frame?.message}`
      );
      assert.equal(ws.closes.length, 0, 'the socket is still not closed');
      assert.ok(
        !JSON.stringify(frame).includes(secret),
        'the raw rejection text never reaches the client'
      );
      assert.ok(
        lines.length >= 1 && lines.every((line) => !line.includes(secret)),
        'and it is not written into the server log either'
      );
    });
  });
});

test('B-PTY-GATE-DIAG: a denied init leaves no PTY session behind (next init spawns fresh)', async () => {
  await withIsolatedDatabase(async () => {
    await withCapturedErrorLog(async (lines) => {
      spawnCalls.length = 0;
      const { ws: denied } = await initUnderDeniedGate('update_maintenance_active', lines, 'gate-diag-leak');
      assert.equal(spawnCalls.length, 0, 'the denied init spawned nothing');
      assert.equal(denied.closes.length, 0, 'and did not close the socket');

      // Same user + same projectPath + same sessionId ⇒ the SAME session key.
      // If the denial had left an entry in ptySessionsMap, this retry would
      // reattach to it ('[Reconnected to existing session]') instead of
      // spawning. Proving the leak is absent through the handler's own
      // observable behavior — the map itself is module-private.
      const retry = makeFakeWs();
      handleShellConnection(retry as never, asRequest(1, 'owner'), deps);
      retry.emit('message', initMessage(PROJECT_PATH, { sessionId: 'gate-diag-leak' }));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(spawnCalls.length, 1, 'the retry spawned a fresh pty');
      assert.ok(
        !retry.sent.some((m) => typeof m === 'object' && m !== null
          && typeof (m as { data?: unknown }).data === 'string'
          && ((m as { data: string }).data).includes('Reconnected to existing session')),
        'the retry did NOT reattach — the denied init left no session entry'
      );
    });
  });
});

test('B-PTY-GATE-DIAG: a closed gate announces ONCE per admission cycle (100 keystrokes ⇒ one banner), not once per frame', async () => {
  const { setApplicationWriterGateForTests } = await import('../../../services/update-writer-lease.js');
  const previousMode = process.env.NASSAJ_UPDATE_MODE;
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.NASSAJ_UPDATE_MODE = 'local-main';
  let gateClosed = false;
  setApplicationWriterGateForTests({
    async acquireWriterLease() {
      if (gateClosed) throw new Error('update_lock_contended');
      return { release() {} };
    },
  } as never);
  try {
    await withCapturedErrorLog(async (lines) => {
      const ws = makeFakeWs();
      handleShellConnection(ws as never, asRequest(1, 'owner'), deps);
      gateClosed = true;

      // A user holding a key down: 100 `input` frames through a closed gate.
      for (let index = 0; index < 100; index += 1) {
        ws.emit('message', JSON.stringify({ type: 'input', data: 'a' }));
      }
      await new Promise((resolve) => setImmediate(resolve));

      const banners = ws.sent.filter(
        (m) => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'error'
      ) as { code?: string }[];
      assert.equal(banners.length, 1, '100 refused frames produced exactly ONE client banner');
      assert.equal(banners[0].code, 'update_lock_contended', 'and it names the REAL gate reason');
      assert.equal(
        lines.filter((line) => line.includes('denied by update gate')).length,
        1,
        'and exactly ONE server log line'
      );

      // Re-arming, which is ALSO the limit of this throttle: one admitted frame
      // re-arms the notice, so a gate that cycles its lock (as it does during
      // `transition()`) produces one banner per cycle — the bound is per
      // admission cycle, NOT per socket lifetime.
      gateClosed = false;
      ws.emit('message', JSON.stringify({ type: 'input', data: 'b' }));
      await new Promise((resolve) => setImmediate(resolve));
      gateClosed = true;
      ws.emit('message', JSON.stringify({ type: 'input', data: 'c' }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        ws.sent.filter(
          (m) => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'error'
        ).length,
        2,
        'the NEXT cycle is announced once more (per-cycle bound, not per-socket)'
      );
    });
  } finally {
    setApplicationWriterGateForTests(null as never);
    if (previousMode === undefined) delete process.env.NASSAJ_UPDATE_MODE;
    else process.env.NASSAJ_UPDATE_MODE = previousMode;
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  }
});

/**
 * B-1253 M-1, websocket half. The frame catch wraps the WHOLE message handler,
 * so it sees ordinary handler rejections too — not only the lease refusal. It
 * called `readUpdateGateCode` unconditionally, and that reader collapses
 * anything it does not recognise, so a TypeError inside the handler was framed
 * to the user as "Update maintenance is active" and logged as "denied by update
 * gate" with no update running. The frame is refused either way; what this
 * pins is that the stated reason is true.
 */
test('B-1253: a NON-gate frame failure is refused as itself, never as update maintenance', async () => {
  const { setApplicationWriterGateForTests } = await import('../../../services/update-writer-lease.js');
  const previousMode = process.env.NASSAJ_UPDATE_MODE;
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.NASSAJ_UPDATE_MODE = 'local-main';
  // NOT a declared gate code: the gate raises `artifact_*` internally, and a
  // TypeError can escape from anywhere in the wrapped handler.
  let rejection: unknown = new TypeError('gate construction failed');
  setApplicationWriterGateForTests({
    async acquireWriterLease() { throw rejection; },
  } as never);
  try {
    await withCapturedErrorLog(async (lines) => {
      const ws = makeFakeWs();
      handleShellConnection(ws as never, asRequest(1, 'owner'), deps);
      ws.emit('message', JSON.stringify({ type: 'input', data: 'a' }));
      await new Promise((resolve) => setImmediate(resolve));

      const banners = ws.sent.filter(
        (m) => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'error'
      ) as { code?: string; message?: string }[];
      assert.equal(banners.length, 1, 'the frame is still REFUSED — fail-closed is unchanged');
      assert.equal(banners[0].code, 'writer_lease_unavailable',
        'and carries a code that does not promise a retry after maintenance');
      assert.ok(!String(banners[0].message).includes('maintenance'),
        `the user was told maintenance was running: ${banners[0].message}`);
      assert.ok(!String(banners[0].message).includes('TypeError'), 'internals never reach the client');
      assert.equal(lines.filter((line) => line.includes('denied by update gate')).length, 0,
        `an ordinary failure was logged as a gate denial: ${lines.join(' | ')}`);
      assert.equal(lines.filter((line) => line.includes('refused (not the update gate)')).length, 1,
        'and the real failure IS logged, once, named as NOT the gate');

      // A REAL denial on the same socket is unaffected: labelled, and named.
      rejection = new Error('update_lock_contended');
      ws.emit('message', JSON.stringify({ type: 'input', data: 'b' }));
      await new Promise((resolve) => setImmediate(resolve));
      const all = ws.sent.filter(
        (m) => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'error'
      ) as { code?: string }[];
      assert.equal(all.length, 2);
      assert.equal(all[1].code, 'update_lock_contended');
      assert.equal(lines.filter((line) => line.includes('denied by update gate')).length, 1);
    });
  } finally {
    setApplicationWriterGateForTests(null as never);
    if (previousMode === undefined) delete process.env.NASSAJ_UPDATE_MODE;
    else process.env.NASSAJ_UPDATE_MODE = previousMode;
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  }
});
