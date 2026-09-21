/**
 * openai-codex.coordinator.test.ts — T-886 (redirected 2026-07-15): proves the PERMANENT,
 * always-on coordinator governance LAYER at the single Codex launch chokepoint. Coordination
 * is no longer an opt-in sandbox MODE — like Claude Code's zero-rule it is applied to EVERY
 * Codex launch across all three real modes (default/acceptEdits/bypassPermissions).
 * @openai/codex-sdk is mocked at the module boundary (no real codex binary, no network, NO
 * ChatGPT quota — R2 live verification is separate). queryCodex is driven end-to-end and the
 * ACTUAL launch surface is asserted:
 *   - LAYER (all 3 modes): config disables native multi-agent + project_doc_max_bytes=0, the
 *               ROOT turn input is prepended with the delegate-only contract, and a delegate
 *               TOML is materialized into $CODEX_HOME/agents for EVERY present agent card
 *               (dynamic roster; here the seeded architect + qa-critic).
 *   - SANDBOX follows the ACTUAL mode (no 'coordinator' branch): default ⇒ workspace-write/
 *               untrusted; acceptEdits ⇒ workspace-write/never; bypassPermissions ⇒ capped to
 *               workspace-write/never (no flag). 'coordinator' as a mode string is inert now.
 *   - FAIL-OPEN: an unusable roster (e.g. no readable cards) no longer REFUSES — the launch
 *               STILL proceeds (one thread starts), a loud warning is logged, and NO
 *               coordinator_agents_missing error frame is emitted. The root contract is still
 *               injected (constant string). The delegate roster is DYNAMIC (all agent cards).
 *   - ROOT-ONLY: the root contract is NOT written into any delegate TOML, so it never leaks
 *               into a child's context (children take their persona from their own TOML).
 *
 * REAL filesystem for HOME / CODEX_HOME / cards (no fs mocks — synthetic-fixtures lesson).
 * Runner: node:test + node:assert/strict via
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import { after, describe, it, mock } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Bootstrap — before importing any project module (mirrors the ceiling test): the DB
// singleton resolves DATABASE_PATH on first use, and the governance gate + the delegate
// generator read os.homedir()/.claude/{AGENTS.md,agents/*.md}.
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-coord-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_FULL_ACCESS = process.env.CODEX_ALLOW_FULL_ACCESS;

const sandboxHome = path.join(sandbox, 'home');
const sandboxCwd = path.join(sandbox, 'project'); // a real cwd so checkCwdExists passes
const CARDS_DIR = path.join(sandboxHome, '.claude', 'agents');
fs.mkdirSync(CARDS_DIR, { recursive: true });
fs.mkdirSync(sandboxCwd, { recursive: true });

// Neutral governance so the fail-closed Codex governance gate passes and the spawn
// proceeds to the coordinator materialization + thread build.
fs.writeFileSync(
  path.join(sandboxHome, '.claude', 'AGENTS.md'),
  '# AGENTS.md — neutral nassaj governance\nplatform-agnostic instructions.\n',
);

const card = (name: string, nameAr: string): string => `---
name: ${name}
model: claude-opus-4-8
name_ar: ${nameAr}
description: ${name} role.
role: ${name} role boundary
scope: engineering
---

## الدور
بوابة الرفض: خارج التخصص → أعد للمنسّق.
`;
function seedCards(): void {
  fs.writeFileSync(path.join(CARDS_DIR, 'architect.md'), card('architect', 'المِعمار'));
  fs.writeFileSync(path.join(CARDS_DIR, 'qa-critic.md'), card('qa-critic', 'الناقد'));
}
seedCards();

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
// Known-clean escape-hatch state: bypassPermissions must cap to workspace-write.
delete process.env.CODEX_ALLOW_FULL_ACCESS;
assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Neutralize openai-codex.js's module-level session-cleanup setInterval so the runner is
// not held alive after assertions complete.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function patchedSetInterval(this: unknown, ...callArgs: unknown[]) {
  const timer = (realSetInterval as unknown as (...a: unknown[]) => NodeJS.Timeout)(...callArgs);
  timer.unref();
  return timer;
} as unknown as typeof globalThis.setInterval;

// --- Mock the Codex SDK: capture the constructor options (config → native delegation denial),
// the startThread/resumeThread options (sandbox floor) and the runStreamed input (the
// contract prepend). The event stream is empty so queryCodex runs to completion. ---
type ThreadOptions = { sandboxMode?: string; approvalPolicy?: string; model?: string; [k: string]: unknown };
type CodexConstruct = { config?: Record<string, unknown>; [k: string]: unknown };

const threadStarts: { method: 'start' | 'resume'; options: ThreadOptions | undefined }[] = [];
const codexConstructions: CodexConstruct[] = [];
const runInputs: unknown[] = [];

class FakeThread {
  async runStreamed(input: unknown): Promise<{ events: AsyncGenerator<unknown, void, unknown> }> {
    runInputs.push(input);
    async function* noEvents(): AsyncGenerator<unknown, void, unknown> {
      // intentionally empty — the assertion targets are the captured launch options.
    }
    return { events: noEvents() };
  }
}

class FakeCodex {
  constructor(options?: CodexConstruct) {
    codexConstructions.push(options ?? {});
  }

  startThread(options?: ThreadOptions): FakeThread {
    threadStarts.push({ method: 'start', options });
    return new FakeThread();
  }

  resumeThread(_id: string, options?: ThreadOptions): FakeThread {
    threadStarts.push({ method: 'resume', options });
    return new FakeThread();
  }
}

mock.module('@openai/codex-sdk', { namedExports: { Codex: FakeCodex } });

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
// eslint-disable-next-line boundaries/no-unknown
const codexModule = await import('@/openai-codex.js');
const { queryCodex, mapPermissionModeToCodexOptions } = codexModule as unknown as {
  queryCodex: (command: string, options: unknown, ws: unknown) => Promise<void>;
  mapPermissionModeToCodexOptions: (
    mode: string | undefined,
    env?: Record<string, string | undefined>,
  ) => { sandboxMode: string; approvalPolicy: string };
};
const { COORDINATOR_ROOT_CONTRACT } = await import('@/services/isolation/codex-coordinator-agents.js');

// Restore the real setInterval now that the import graph's timers are unref'd.
globalThis.setInterval = realSetInterval;

await initializeDatabase();

after(() => {
  globalThis.setInterval = realSetInterval;
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_FULL_ACCESS === undefined) delete process.env.CODEX_ALLOW_FULL_ACCESS;
  else process.env.CODEX_ALLOW_FULL_ACCESS = ORIGINAL_FULL_ACCESS;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

type SentMsg = Record<string, unknown>;
function makeWs(userId: number | null): { userId: number | null; send: (m: unknown) => void; sent: SentMsg[] } {
  const sent: SentMsg[] = [];
  return { userId, send: (m: unknown) => { sent.push(m as SentMsg); }, sent };
}

/** Drives queryCodex once (anonymous) and returns the ws stub + how many threads started. */
async function spawn(
  options: Record<string, unknown>,
): Promise<{ ws: ReturnType<typeof makeWs>; threadsStarted: number }> {
  const ws = makeWs(null);
  const before = threadStarts.length;
  await queryCodex('ping', { cwd: sandboxCwd, model: 'gpt-5-codex', ...options }, ws);
  return { ws, threadsStarted: threadStarts.length - before };
}

// The operator (anonymous) CODEX_HOME under the sandboxed HOME — where a spawn
// materializes its delegates.
const CODEX_AGENTS = path.join(sandboxHome, '.codex', 'agents');

// ===========================================================================
// Part 1 — parser: coordination is NOT a sandbox mode; the three real modes map
// to their real sandbox, and a stray 'coordinator' string is inert (falls to default).
// ===========================================================================
describe('mapPermissionModeToCodexOptions — no coordinator branch (T-886 redirect)', () => {
  it('default ⇒ workspace-write / untrusted', () => {
    assert.deepEqual(mapPermissionModeToCodexOptions('default', {}), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    });
  });

  it('acceptEdits ⇒ workspace-write / never', () => {
    assert.deepEqual(mapPermissionModeToCodexOptions('acceptEdits', {}), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it('bypassPermissions ⇒ capped to workspace-write / never (no flag)', () => {
    assert.deepEqual(mapPermissionModeToCodexOptions('bypassPermissions', {}), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it("'coordinator' is inert — no read-only branch, falls through to the default", () => {
    assert.deepEqual(mapPermissionModeToCodexOptions('coordinator', {}), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    assert.deepEqual(
      mapPermissionModeToCodexOptions('coordinator', { CODEX_ALLOW_FULL_ACCESS: 'true' }),
      { sandboxMode: 'danger-full-access', approvalPolicy: 'on-request' },
    );
  });
});

// ===========================================================================
// Part 2 — live spawn: the PERMANENT layer rides EVERY mode (contract prepend +
// native multi-agent disabled + delegate material present), while the sandbox follows the actual mode.
// ===========================================================================
describe('queryCodex — always-on coordinator layer across all modes (T-886 redirect)', () => {
  const cases: { mode: string; sandboxMode: string; approvalPolicy: string }[] = [
    { mode: 'default', sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    { mode: 'acceptEdits', sandboxMode: 'workspace-write', approvalPolicy: 'never' },
    { mode: 'bypassPermissions', sandboxMode: 'workspace-write', approvalPolicy: 'never' },
  ];

  for (const { mode, sandboxMode, approvalPolicy } of cases) {
    it(`${mode} ⇒ no contract prepend + native delegation denied; sandbox=${sandboxMode}/${approvalPolicy}`, async () => {
      const beforeConstructs = codexConstructions.length;
      const beforeInputs = runInputs.length;

      const { threadsStarted } = await spawn({ permissionMode: mode });
      assert.equal(threadsStarted, 1, `${mode} spawn must start exactly one thread`);

      // Sandbox follows the ACTUAL mode (no coordinator read-only override).
      const opts = threadStarts[threadStarts.length - 1].options;
      assert.equal(opts?.sandboxMode, sandboxMode);
      assert.equal(opts?.approvalPolicy, approvalPolicy);

      // ADR-134 v1 mechanically removes the native delegation surface on every mode.
      const construct = codexConstructions[codexConstructions.length - 1];
      assert.equal(construct.config?.['features.multi_agent'], false,
        'ADR-134: native multi-agent must be disabled on every launch');
      assert.equal(construct.config?.project_doc_max_bytes, 0, 'governance byte-cap preserved');

      // T-1283: the root turn input is now the USER'S COMMAND VERBATIM. The
      // delegate-only contract moved out of the prompt and into the governance file
      // ($CODEX_HOME/AGENTS.md, sourced from the composed AGENTS.codex.md), which is
      // Codex's own sanctioned channel and is fingerprint-checked fail-closed. A
      // regression that re-prepends it would show the contract as prose at the head
      // of every message again — the exact complaint that prompted the move.
      const input = runInputs[runInputs.length - 1];
      assert.equal(typeof input, 'string', 'no images ⇒ raw string turn input');
      assert.equal(input, 'ping', 'the turn input must be the command alone — no prepend');
      assert.ok(
        !(input as string).includes(COORDINATOR_ROOT_CONTRACT),
        'the root contract must NOT ride in the prompt any more',
      );

      // Delegates materialized into $CODEX_HOME/agents (real fs), no @, and with NO
      // sandbox_mode pin so each inherits the session sandbox (E12: a write agent writes).
      for (const name of ['architect', 'qa-critic']) {
        const p = path.join(CODEX_AGENTS, `${name}.toml`);
        assert.equal(fs.existsSync(p), true, `${name}.toml must be materialized`);
        const toml = fs.readFileSync(p, 'utf8');
        assert.match(toml, new RegExp(`^name = "${name}"$`, 'm'));
        assert.equal(/^sandbox_mode/m.test(toml), false, `${name} must inherit the session sandbox`);
        assert.match(toml, /^model = "gpt-5-codex"$/m);
        assert.equal(toml.includes(`@${name}`), false, 'no @-prefixed delegate name');
      }

      assert.equal(codexConstructions.length, beforeConstructs + 1);
      assert.equal(runInputs.length, beforeInputs + 1);
    });
  }

  it('ROOT-ONLY: the root contract is NOT written into any delegate TOML (no child leak)', async () => {
    await spawn({ permissionMode: 'default' });
    for (const name of ['architect', 'qa-critic']) {
      const toml = fs.readFileSync(path.join(CODEX_AGENTS, `${name}.toml`), 'utf8');
      assert.equal(
        toml.includes(COORDINATOR_ROOT_CONTRACT),
        false,
        `${name}.toml must NOT carry the ROOT contract — children take persona from their own TOML`,
      );
    }
  });
});

// ===========================================================================
// Part 2b — SINGLE-CHOKEPOINT invariant: features.multi_agent=false covers BOTH
// live spawn paths (REST /api/agent + interactive WS) because both funnel through the
// one queryCodex → queryCodexUnlocked → `new Codex({ config })` construction. This
// source-level guard fails if a SECOND `new Codex(` spawn path is ever added without
// the recursion cap (which would silently let a delegate spawn a grandchild on that
// path). Complements the runtime assertion above (config on every mode).
// ===========================================================================
describe('delegation block — single Codex construction disables native multi-agent', () => {
  const codexSrc = fs.readFileSync(path.join(import.meta.dirname, 'openai-codex.js'), 'utf8');

  it('production openai-codex.js constructs Codex exactly once', () => {
    const constructions = codexSrc.match(/new Codex\(/g) || [];
    assert.equal(
      constructions.length,
      1,
      'exactly one `new Codex(` may exist — a second spawn path could bypass the delegation block',
    );
  });

  it('that construction pins features.multi_agent=false on every launch', () => {
    assert.match(codexSrc, /'features\.multi_agent':\s*false/,
      'the native delegation feature must be disabled in the Codex config');
  });

  it('both live callers route through queryCodex (no direct SDK spawn)', () => {
    const restSrc = fs.readFileSync(path.join(import.meta.dirname, 'routes', 'agent.js'), 'utf8');
    const wsSrc = fs.readFileSync(
      path.join(import.meta.dirname, 'modules', 'websocket', 'services', 'chat-websocket.service.ts'),
      'utf8',
    );
    assert.ok(restSrc.includes('queryCodex('), 'REST /api/agent must dispatch via queryCodex');
    assert.ok(wsSrc.includes('queryCodex('), 'WS chat path must dispatch via queryCodex');
    for (const [label, src] of [['routes/agent.js', restSrc], ['chat-websocket.service.ts', wsSrc]] as const) {
      assert.equal(src.includes('new Codex('), false, `${label} must NOT construct Codex directly`);
    }
  });
});

// ===========================================================================
// Part 3 — FAIL-OPEN: a missing delegate card degrades delegation but must NOT
// block the launch (opposite of the removed opt-in mode's fail-closed).
// ===========================================================================
describe('queryCodex — fail-open when delegates cannot be materialized (T-886 redirect)', () => {
  it('unusable roster ⇒ launch STILL proceeds, warns loudly, no error frame', async () => {
    // Empty the whole cards dir so the roster is empty (materialize ⇒ ok:false). With a
    // DYNAMIC roster, removing a single card just shrinks it; only a fully unusable roster
    // degrades delegation — and even then the launch must proceed (fail-open).
    const saved = fs.readdirSync(CARDS_DIR).map((e) => ({
      p: path.join(CARDS_DIR, e),
      body: fs.readFileSync(path.join(CARDS_DIR, e), 'utf8'),
    }));
    for (const c of saved) fs.rmSync(c.p, { force: true });

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const before = threadStarts.length;
      const beforeInputs = runInputs.length;
      const ws = makeWs(null);
      await queryCodex(
        'ping',
        { cwd: sandboxCwd, model: 'gpt-5-codex', permissionMode: 'default' },
        ws,
      );

      assert.equal(
        threadStarts.length,
        before + 1,
        'fail-open: the thread must STILL start when the roster is unusable',
      );
      assert.equal(
        ws.sent.some((m) => JSON.stringify(m).includes('coordinator_agents_missing')),
        false,
        'no coordinator_agents_missing error frame may be emitted (fail-open, not fail-closed)',
      );
      // T-1283: still exactly one turn, and still no contract in the prompt — the
      // fail-open path degrades the DELEGATES, never the input shape.
      const input = runInputs[runInputs.length - 1];
      assert.equal(runInputs.length, beforeInputs + 1, 'exactly one turn ran');
      assert.equal(input, 'ping', 'the turn input stays the bare command on the fail-open path');
      // A loud warning must record the degradation.
      assert.ok(
        warnings.some((w) => w.includes('fail-open') && w.toLowerCase().includes('coordinator')),
        'a loud fail-open warning must be logged',
      );
    } finally {
      console.warn = realWarn;
      for (const c of saved) fs.writeFileSync(c.p, c.body);
    }
  });
});
