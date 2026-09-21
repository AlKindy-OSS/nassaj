/**
 * openai-codex.board-writable-root.test.ts — B-405.
 *
 * THE BUG THIS LOCKS DOWN. nassaj's board rule is mandatory: no work starts before
 * `node scripts/board.mjs add …` records it. But `docs/project-state.json` is a
 * SYMLINK into the shared nassaj-core product tree, and Codex's workspace-write
 * sandbox resolves REALPATHS before checking writability — so the board's lock file
 * landed outside every writable root (cwd + /tmp) and the write died with
 * `EROFS: read-only file system` on `.project-state.lock`.
 *
 * The consequence was not a missing board entry, it was total paralysis: measured on
 * 2026-08-03, a Codex coordinator AND all three of its delegates (architect,
 * backend_dev, devops) each stopped at that gate before touching a single file. The
 * governance rule made the work unstartable rather than merely unrecorded.
 *
 * So the assertions below are about OBEDIENCE being POSSIBLE, and they deliberately
 * assert on the config handed to the SDK constructor — the real spawn boundary —
 * not merely on the resolver's return value.
 *
 * Runner: node:test + node:assert/strict via
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import { after, describe, it, mock } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveCodexRuntime } from './shared/codex-executable.js';

// ---------------------------------------------------------------------------
// Bootstrap — MUST run before importing any project module (mirrors
// openai-codex.permission-ceiling.test.ts): the DB singleton resolves DATABASE_PATH
// on first use, and the governance gate reads os.homedir()/.claude/AGENTS.md.
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-board-root-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;

const sandboxHome = path.join(sandbox, 'home');
// Two projects: one whose docs/ escapes via symlink (the nassaj layout), and one
// whose docs/ is an ordinary in-repo directory (every other repo).
const symlinkedCwd = path.join(sandbox, 'project-symlinked');
const plainCwd = path.join(sandbox, 'project-plain');
// The "nassaj-core" side the docs symlink points at — deliberately OUTSIDE both cwds.
const coreDocs = path.join(sandbox, 'core', 'products', 'demo', 'docs');

fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
fs.mkdirSync(symlinkedCwd, { recursive: true });
fs.mkdirSync(plainCwd, { recursive: true });
fs.mkdirSync(coreDocs, { recursive: true });
fs.mkdirSync(path.join(plainCwd, 'docs'), { recursive: true });
fs.symlinkSync(coreDocs, path.join(symlinkedCwd, 'docs'), 'dir');

// Seed neutral governance so the fail-closed Codex governance gate (ADR-057 §5)
// passes and the spawn proceeds to build the SDK config — this test is about the
// board writable root, not the gate.
fs.writeFileSync(
  path.join(sandboxHome, '.claude', 'AGENTS.md'),
  '# AGENTS.md — neutral nassaj governance\nplatform-agnostic instructions.\n',
);
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
// Start from a known-clean flag state so the ceiling stays workspace-write.
delete process.env.CODEX_ALLOW_FULL_ACCESS;
delete process.env.CODEX_WORKSPACE_NETWORK;

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// macOS/tmp is itself a symlink (/tmp → /private/tmp), so compare against the
// RESOLVED core docs path — otherwise the assertion fails for the wrong reason.
const realCoreDocs = fs.realpathSync(coreDocs);

// Neutralize module-level setInterval (openai-codex.js's session-cleanup timer) so
// the runner is not held alive after assertions complete.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function patchedSetInterval(this: unknown, ...callArgs: unknown[]) {
  const timer = (realSetInterval as unknown as (...a: unknown[]) => NodeJS.Timeout)(...callArgs);
  timer.unref();
  return timer;
} as unknown as typeof globalThis.setInterval;

// --- Mock the Codex SDK. Unlike the ceiling test, the capture target here is the
// CONSTRUCTOR options (where `config` lives), since sandbox writable roots travel as
// a `--config` override rather than a thread option. ---
type CodexConfig = Record<string, unknown>;
type CodexCtorOptions = { config?: CodexConfig; [k: string]: unknown };
const ctorCalls: CodexCtorOptions[] = [];
const runInputs: unknown[] = [];

class FakeThread {
  async runStreamed(input: unknown): Promise<{ events: AsyncGenerator<unknown, void, unknown> }> {
    runInputs.push(input);
    async function* noEvents(): AsyncGenerator<unknown, void, unknown> {
      // intentionally empty — the assertion target is the captured constructor config
    }
    return { events: noEvents() };
  }
}

class FakeCodex {
  constructor(options?: CodexCtorOptions) {
    ctorCalls.push(options ?? {});
  }

  startThread(): FakeThread {
    return new FakeThread();
  }

  resumeThread(): FakeThread {
    return new FakeThread();
  }
}

mock.module('@openai/codex-sdk', { namedExports: { Codex: FakeCodex } });

// Now safe to import the modules under test (they pick up the tmp DB + HOME + mock).
const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const codexModule = await import('@/openai-codex.js');
const { queryCodex, resolveCodexDocsWritableRoots } = codexModule as unknown as {
  queryCodex: (command: string, options: unknown, ws: unknown) => Promise<void>;
  resolveCodexDocsWritableRoots: (workingDirectory: string | undefined | null) => string[];
};

await initializeDatabase();

const WRITABLE_ROOTS_KEY = 'sandbox_workspace_write.writable_roots';

function makeWs(userId: number | null): { userId: number | null; send: (m: unknown) => void } {
  return { userId, send: () => {} };
}

/** Drives queryCodex once (anonymous) and returns the captured constructor config. */
async function spawnAndCaptureConfig(cwd: string): Promise<CodexConfig> {
  const before = ctorCalls.length;
  await queryCodex('ping', { cwd, model: 'gpt-5-codex' }, makeWs(null));
  assert.equal(ctorCalls.length, before + 1, 'queryCodex must construct exactly one Codex client');
  return (ctorCalls[ctorCalls.length - 1].config ?? {}) as CodexConfig;
}

async function spawnCoordinationAndCapture(cwd: string, coordinationLevel: string) {
  const beforeInputs = runInputs.length;
  await queryCodex('exact raw prompt', { cwd, model: 'gpt-5-codex', coordinationLevel }, makeWs(null));
  assert.equal(runInputs.length, beforeInputs + 1);
  return {
    config: (ctorCalls[ctorCalls.length - 1].config ?? {}) as CodexConfig,
    input: runInputs[runInputs.length - 1],
  };
}

// ===========================================================================
// Part 1 — the resolver in isolation.
// ===========================================================================
describe('resolveCodexDocsWritableRoots — the board gate (B-405)', () => {
  it('grants the RESOLVED docs path when docs/ symlinks outside the workspace', () => {
    assert.deepEqual(resolveCodexDocsWritableRoots(symlinkedCwd), [realCoreDocs]);
  });

  it('grants NOTHING when docs/ is an ordinary in-repo directory', () => {
    // cwd already covers it; widening the sandbox here would be a pure regression.
    assert.deepEqual(resolveCodexDocsWritableRoots(plainCwd), []);
  });

  it('grants nothing when docs/ is absent, and does not throw', () => {
    const noDocs = path.join(sandbox, 'project-no-docs');
    fs.mkdirSync(noDocs, { recursive: true });
    assert.deepEqual(resolveCodexDocsWritableRoots(noDocs), []);
  });

  it('grants nothing on a BROKEN symlink rather than widening the sandbox', () => {
    const brokenCwd = path.join(sandbox, 'project-broken');
    fs.mkdirSync(brokenCwd, { recursive: true });
    fs.symlinkSync(path.join(sandbox, 'does-not-exist'), path.join(brokenCwd, 'docs'), 'dir');
    assert.deepEqual(resolveCodexDocsWritableRoots(brokenCwd), []);
  });

  it('tolerates a missing working directory', () => {
    assert.deepEqual(resolveCodexDocsWritableRoots(undefined), []);
    assert.deepEqual(resolveCodexDocsWritableRoots(''), []);
  });
});

// ===========================================================================
// Part 2 — the real spawn boundary: does the grant actually reach the SDK?
// A resolver that returns the right string but never reaches `new Codex()` would
// leave the board gate just as broken (cf. the cleanSpawnEnv dead-code incident).
// ===========================================================================
describe('queryCodex — writable root reaches the SDK config (B-405)', () => {
  it('uses private developer instructions and keeps Codex user input byte-identical', async () => {
    const captured = await spawnCoordinationAndCapture(plainCwd, 'delegate');
    assert.match(String(captured.config.developer_instructions), /Coordination level for this turn: delegated/);
    assert.equal(captured.input, 'exact raw prompt');

    const direct = await spawnCoordinationAndCapture(plainCwd, 'direct');
    assert.match(String(direct.config.developer_instructions), /<nassaj_document_sharing>/);
    assert.doesNotMatch(String(direct.config.developer_instructions), /Coordination level for this turn/);
    assert.equal(direct.input, 'exact raw prompt');
  });
  it('passes the escaped docs root to the SDK under workspace-write', async () => {
    const config = await spawnAndCaptureConfig(symlinkedCwd);
    const runtime = resolveCodexRuntime();
    const options = ctorCalls.at(-1)!;
    assert.equal(options.codexPathOverride, runtime.executablePath);
    if (runtime.pathDirs.length) assert.ok(String((options.env as Record<string, string>).PATH).startsWith(runtime.pathDirs.join(path.delimiter)));
    assert.deepEqual(
      config[WRITABLE_ROOTS_KEY],
      [realCoreDocs],
      'the board target must be handed to the SDK, or board.mjs still dies with EROFS',
    );
  });

  it('omits the key entirely for a repo whose docs/ does not escape', async () => {
    const config = await spawnAndCaptureConfig(plainCwd);
    assert.ok(
      !(WRITABLE_ROOTS_KEY in config),
      'no escape means no grant — the sandbox must stay at its default roots',
    );
  });

  it('keeps the pre-existing governance config keys intact', async () => {
    // Regression guard: the writable-roots spread must not displace the
    // AGENTS.md-bypass block (ADR-057 §5) or the ADR-134 delegation block.
    const config = await spawnAndCaptureConfig(symlinkedCwd);
    assert.equal(config.project_doc_max_bytes, 0, 'project AGENTS.md bypass must survive');
    assert.equal(config['features.multi_agent'], false, 'native delegation denial must survive');
  });
});

after(async () => {
  await closeConnection();
  globalThis.setInterval = realSetInterval;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});
