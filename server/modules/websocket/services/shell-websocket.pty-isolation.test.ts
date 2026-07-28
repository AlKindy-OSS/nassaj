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
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

// --- Module mocks (must be registered before importing the service) ----------

// Capture every pty.spawn call: the env it was handed and a controllable fake
// child so the handler can register onData/onExit without a real terminal.
const spawnCalls: { env: Record<string, string | undefined> }[] = [];
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
    spawn: (_shell: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
      spawnCalls.push({ env: opts.env });
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
// Kimi was unreachable from the terminal at all: the UI listed it as a pure-API
// vendor (no login CTA, no login command) and the backend had no `kimi` case, so
// a kimi PTY collapsed onto the `claude` isolation knob. These prove the seam is
// now provider- AND mode-correct, which is what keeps the device-code token out
// of the shared operator tree.

test('B-KIMI-TERM: a kimi PTY resolves the kimi isolation in AGENT mode, not claude', async () => {
  await withIsolatedDatabase(() => {
    spawnCalls.length = 0;
    resolveCalls.length = 0;

    // Exactly what ProviderLoginModal sends for kimi.
    const ws = makeFakeWs();
    handleShellConnection(ws as never, asRequest(43, 'user'), deps);
    ws.emit('message', initMessage(PROJECT_PATH, {
      provider: 'kimi',
      isPlainShell: true,
      initialCommand: 'kimi login',
    }));

    assert.equal(ws.closes.length, 0, 'the kimi login terminal passed the role gate');
    assert.equal(resolveCalls.length, 1, 'resolver consulted once');
    assert.equal(
      resolveCalls[0].provider,
      'kimi',
      'the kimi provider was forwarded (not collapsed to the claude default)'
    );
    assert.equal(
      resolveCalls[0].mode,
      'agent',
      'a terminal runs the NATIVE CLI, so the seam is asked in agent mode (SL-5)'
    );

    assert.equal(spawnCalls.length, 1, 'one pty spawned');
    const env = spawnCalls[0].env;
    assert.equal(
      env.KIMI_CODE_HOME,
      '/isolated/43/.kimi',
      'the PTY carries the per-user KIMI_CODE_HOME, so `kimi login` writes its '
      + 'device-code token into the user tree — not the shared operator ~/.kimi-code'
    );
    assert.notEqual(
      env.CLAUDE_CONFIG_DIR,
      '/isolated/43/.claude',
      'the claude CONFIG_DIR knob was NOT applied to a kimi terminal (pre-fix bug)'
    );
  });
});

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

test("B-90: the user's npm-global bin is hoisted to the FRONT of the PTY PATH", async () => {
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
        entries[0],
        fx.npmGlobalBin,
        "the user's <isolatedHome>/.npm-global/bin is the very first PATH entry"
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

      // Each terminal leads with its OWN user's npm-global bin.
      assert.equal(entriesA[0], fxA.npmGlobalBin, "A's PATH leads with A's npm-global bin");
      assert.equal(entriesB[0], fxB.npmGlobalBin, "B's PATH leads with B's npm-global bin");

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
