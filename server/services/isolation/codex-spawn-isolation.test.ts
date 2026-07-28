/**
 * codex-spawn-isolation.test.ts — B-136: proves the Codex SPAWN path applies
 * per-user credential isolation at the real call site (server/openai-codex.js).
 *
 * The bug: queryCodex constructed `new Codex()` with no options, so codex-sdk
 * inherited the shared process.env and every user ran against the operator's
 * ~/.codex — sharing the owner's OpenAI auth.json (ToS violation) and exposing
 * other users' session transcripts via resumeThread. The fix routes the child env
 * through resolveProviderEnv(userId, 'codex', process.env), which sets CODEX_HOME
 * to ~/.nassaj-users/<userId>/.codex when codex is isolated and leaves the env
 * unchanged for anonymous/shared spawns.
 *
 * Unlike isolation.e2e.test.ts (which exercises resolveProviderEnv in isolation),
 * this drives queryCodex end-to-end with @openai/codex-sdk mocked at the module
 * boundary — no real `codex` binary, no network — and asserts the env object
 * actually handed to the Codex constructor.
 *
 * Runner: node:test + node:assert/strict via
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import { after, describe, it, mock } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Bootstrap — MUST run before importing any project module: the DB connection
// singleton resolves DATABASE_PATH on first use, and provisionUserDirs/
// userConfigDir read os.homedir() (which honors $HOME on this platform).
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-spawn-iso-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;

const sandboxHome = path.join(sandbox, 'home');
const sandboxCwd = path.join(sandbox, 'project'); // a real cwd so checkCwdExists passes
fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
fs.mkdirSync(sandboxCwd, { recursive: true });
// Seed the neutral governance source (~/.claude/AGENTS.md) so the fail-closed Codex
// governance gate (ADR-057 §5) passes and the spawn actually proceeds — this test is
// about credential isolation on a GOVERNED spawn, not about the gate itself.
fs.writeFileSync(
  path.join(sandboxHome, '.claude', 'AGENTS.md'),
  '# AGENTS.md — neutral nassaj governance\nplatform-agnostic instructions.\n',
);
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Neutralize any module-level ref'd setInterval created during import (notably
// openai-codex.js's 5-minute session-cleanup timer) so the test runner is not held
// alive and does not hang after the assertions complete. unref() does not stop the
// timer from firing while the process lives; it only lets the event loop drain.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function patchedSetInterval(this: unknown, ...callArgs: unknown[]) {
  const timer = (realSetInterval as unknown as (...a: unknown[]) => NodeJS.Timeout)(...callArgs);
  timer.unref();
  return timer;
} as unknown as typeof globalThis.setInterval;

// --- Mock the Codex SDK: capture the constructor options (the env under test) and
// return a thread whose event stream is empty so queryCodex runs cleanly to the
// completion branch without spawning a real subprocess. The env capture happens in
// the constructor, well before the (empty) stream, so nothing downstream matters. ---
type CodexCtorOptions = { env?: Record<string, string | undefined> } | undefined;
const codexConstructions: CodexCtorOptions[] = [];

class FakeThread {
  async runStreamed(): Promise<{ events: AsyncGenerator<unknown, void, unknown> }> {
    async function* noEvents(): AsyncGenerator<unknown, void, unknown> {
      // intentionally empty — the assertion target is the constructor env
    }
    return { events: noEvents() };
  }
}

class FakeCodex {
  constructor(options?: { env?: Record<string, string | undefined> }) {
    codexConstructions.push(options);
  }

  startThread(): FakeThread {
    return new FakeThread();
  }

  resumeThread(): FakeThread {
    return new FakeThread();
  }
}

// Use namedExports (not the newer `exports`): the installed @types/node (22.x)
// MockModuleOptions only declares defaultExport/namedExports, so `exports` would
// fail the strict tsc build (noEmitOnError) even though the Node 24 runtime accepts
// it. The runtime deprecation notice is benign and matches codex-auth.test.ts.
mock.module('@openai/codex-sdk', { namedExports: { Codex: FakeCodex } });

// Now safe to import the modules under test (they pick up the tmp DB + HOME + mock).
const { initializeDatabase, closeConnection, getConnection } = await import(
  '@/modules/database/index.js'
);
const { setProviderSharingConfig, _resetProviderSharingCache } = await import(
  '@/services/provider-sharing.js'
);
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
// eslint-disable-next-line boundaries/no-unknown
const { queryCodex } = await import('@/openai-codex.js');

// The import graph's module-level timers are now created & unref'd; restore the
// real setInterval so the rest of the run behaves normally.
globalThis.setInterval = realSetInterval;

await initializeDatabase();

// Seed the users whose spawns provision a per-user tree. provisionUserDirs records
// a 'user_dirs_provisioned' audit row whose user_id is a FK to users(id); seeding
// makes that a real successful insert instead of a swallowed FK failure.
const TEST_USER_A = 7001;
const TEST_USER_B = 7002;
{
  const db = getConnection();
  const insertUser = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, 'x')",
  );
  insertUser.run(TEST_USER_A, 'codex-iso-a');
  insertUser.run(TEST_USER_B, 'codex-iso-b');
}

after(() => {
  globalThis.setInterval = realSetInterval;
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Forces the codex sharing policy deterministically for a case. */
function setCodexPolicy(state: 'isolated' | 'shared'): void {
  _resetProviderSharingCache();
  setProviderSharingConfig({
    claude: 'isolated',
    gemini: 'isolated',
    codex: state,
    agy: 'shared',
    cursor: 'shared',
  });
}

/** Minimal ws stub: records sent frames and carries the spawner's userId. */
function makeWs(userId: number | null): {
  userId: number | null;
  sent: unknown[];
  send: (message: unknown) => void;
} {
  const sent: unknown[] = [];
  return { userId, sent, send: (message: unknown) => sent.push(message) };
}

/** Drives queryCodex once and returns the options captured by the Codex ctor. */
async function spawnAndCapture(userId: number | null): Promise<CodexCtorOptions> {
  const before = codexConstructions.length;
  await queryCodex('ping', { cwd: sandboxCwd }, makeWs(userId));
  assert.equal(
    codexConstructions.length,
    before + 1,
    'queryCodex must construct Codex exactly once per spawn',
  );
  return codexConstructions[codexConstructions.length - 1];
}

describe('Codex spawn path — per-user credential isolation (B-136)', () => {
  it('constructs Codex WITH an env carrying the per-user CODEX_HOME when isolated', async () => {
    setCodexPolicy('isolated');
    const opts = await spawnAndCapture(TEST_USER_A);

    // The load-bearing regression guard: `new Codex()` (bare) leaves opts undefined.
    assert.ok(opts && opts.env, 'Codex must be constructed with an { env } (not bare new Codex())');
    assert.equal(opts.env.CODEX_HOME, userConfigDir(TEST_USER_A, '.codex'));
    assert.ok(
      String(opts.env.CODEX_HOME).startsWith(
        path.join(sandboxHome, '.nassaj-users', String(TEST_USER_A)),
      ),
      'CODEX_HOME must live under the per-user isolated root',
    );
    // codex-sdk does NOT inherit process.env once `env` is supplied, so the resolved
    // env must be a full copy of the base env (PATH etc.), not just the override.
    assert.equal(opts.env.PATH, process.env.PATH);
    // Governance-bypass block (ADR-057 §5, 2026-07-12): every spawn disables project-
    // level AGENTS.md ingestion so a local AGENTS.md cannot override nassaj governance.
    assert.equal(
      (opts as { config?: { project_doc_max_bytes?: number } }).config?.project_doc_max_bytes,
      0,
      'spawn must pass project_doc_max_bytes=0 to block local AGENTS.md governance bypass',
    );
  });

  it('gives two different users two different CODEX_HOME values (no cross-user leak)', async () => {
    setCodexPolicy('isolated');
    const a = await spawnAndCapture(TEST_USER_A);
    const b = await spawnAndCapture(TEST_USER_B);

    assert.equal(a?.env?.CODEX_HOME, userConfigDir(TEST_USER_A, '.codex'));
    assert.equal(b?.env?.CODEX_HOME, userConfigDir(TEST_USER_B, '.codex'));
    assert.notEqual(a?.env?.CODEX_HOME, b?.env?.CODEX_HOME);
  });

  it('applies NO per-user CODEX_HOME for an anonymous (null userId) spawn', async () => {
    setCodexPolicy('isolated');
    const opts = await spawnAndCapture(null);

    // Even anonymous spawns pass an explicit env, but it must be the base env
    // unchanged: no isolation for system/anonymous/platform-mode runs.
    assert.ok(opts && opts.env, 'anonymous spawn still passes an explicit env');
    assert.equal(opts.env.CODEX_HOME, process.env.CODEX_HOME);
    assert.ok(
      opts.env.CODEX_HOME === undefined || !String(opts.env.CODEX_HOME).includes('.nassaj-users'),
      'anonymous spawn must not point CODEX_HOME into a per-user tree',
    );
  });

  it('honors the admin "shared" policy: an authenticated user gets the operator env', async () => {
    setCodexPolicy('shared');
    const opts = await spawnAndCapture(TEST_USER_A);

    assert.ok(opts && opts.env);
    assert.equal(opts.env.CODEX_HOME, process.env.CODEX_HOME);
    assert.ok(
      opts.env.CODEX_HOME === undefined || !String(opts.env.CODEX_HOME).includes('.nassaj-users'),
      'shared codex must not apply a per-user CODEX_HOME override',
    );
  });
});
