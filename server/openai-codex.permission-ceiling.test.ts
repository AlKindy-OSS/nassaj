/**
 * openai-codex.permission-ceiling.test.ts — T-884 (committee decision 2026-07-14):
 * proves the Codex sandbox CEILING at the one place both live spawn paths funnel
 * through (server/openai-codex.js: mapPermissionModeToCodexOptions), plus a
 * behavioural regression driving queryCodex end-to-end with @openai/codex-sdk mocked
 * at the module boundary — no real `codex` binary, no network — asserting the actual
 * threadOptions handed to the SDK.
 *
 * The danger it locks down: the interactive WS path forwards CLIENT-supplied options
 * straight into queryCodex, so before this fix a client could pick
 * permissionMode:'bypassPermissions' and get sandboxMode:'danger-full-access' — full
 * disk + network on a shared uid. After the fix, danger-full-access is reachable ONLY
 * behind the operator env flag CODEX_ALLOW_FULL_ACCESS==='true'.
 *
 * T-895/B-169 extends the same lockdown to the network channel: the WS-forwarded
 * client options `networkAccess` / `networkAccessEnabled` used to enable outbound
 * network under workspace-write, which on a shared uid (reads still open until T-893)
 * let any authenticated user exfiltrate another user's auth.json in one turn. The
 * client opt-in is now IGNORED; network is enabled EXCLUSIVELY by the server flag
 * CODEX_WORKSPACE_NETWORK==='true'. Web search is additionally pinned OFF at launch.
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
// Bootstrap — MUST run before importing any project module (mirrors
// codex-spawn-isolation.test.ts): the DB singleton resolves DATABASE_PATH on first
// use, and the governance gate reads os.homedir()/.claude/AGENTS.md.
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-ceiling-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_FULL_ACCESS = process.env.CODEX_ALLOW_FULL_ACCESS;
const ORIGINAL_WS_NETWORK = process.env.CODEX_WORKSPACE_NETWORK;

const sandboxHome = path.join(sandbox, 'home');
const sandboxCwd = path.join(sandbox, 'project'); // a real cwd so checkCwdExists passes
fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
fs.mkdirSync(sandboxCwd, { recursive: true });
// Seed neutral governance so the fail-closed Codex governance gate (ADR-057 §5)
// passes and the spawn proceeds to build threadOptions — this test is about the
// sandbox ceiling, not the gate.
fs.writeFileSync(
  path.join(sandboxHome, '.claude', 'AGENTS.md'),
  '# AGENTS.md — neutral nassaj governance\nplatform-agnostic instructions.\n',
);
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
// Start from a known-clean flag state; individual cases opt in explicitly.
delete process.env.CODEX_ALLOW_FULL_ACCESS;
delete process.env.CODEX_WORKSPACE_NETWORK;

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Neutralize module-level setInterval (openai-codex.js's session-cleanup timer) so
// the runner is not held alive after assertions complete.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function patchedSetInterval(this: unknown, ...callArgs: unknown[]) {
  const timer = (realSetInterval as unknown as (...a: unknown[]) => NodeJS.Timeout)(...callArgs);
  timer.unref();
  return timer;
} as unknown as typeof globalThis.setInterval;

// --- Mock the Codex SDK: capture the options handed to startThread/resumeThread
// (the ceiling under test) and return a thread whose event stream is empty so
// queryCodex runs cleanly to completion without a real subprocess. ---
type ThreadOptions = {
  sandboxMode?: string;
  approvalPolicy?: string;
  networkAccessEnabled?: boolean;
  webSearchEnabled?: boolean;
  webSearchMode?: string;
  modelReasoningEffort?: string;
  [k: string]: unknown;
};
type ThreadStart = { method: 'start' | 'resume'; options: ThreadOptions | undefined };
const threadStarts: ThreadStart[] = [];

class FakeThread {
  async runStreamed(): Promise<{ events: AsyncGenerator<unknown, void, unknown> }> {
    async function* noEvents(): AsyncGenerator<unknown, void, unknown> {
      // intentionally empty — the assertion target is the captured threadOptions
    }
    return { events: noEvents() };
  }
}

class FakeCodex {
  constructor(_options?: unknown) {}

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

// Now safe to import the modules under test (they pick up the tmp DB + HOME + mock).
const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
// eslint-disable-next-line boundaries/no-unknown
const codexModule = await import('@/openai-codex.js');
const { queryCodex, mapPermissionModeToCodexOptions, resolveCodexNetworkAccess, resolveCodexReasoningEffort } =
  codexModule as unknown as {
    queryCodex: (command: string, options: unknown, ws: unknown) => Promise<void>;
    mapPermissionModeToCodexOptions: (
      mode: string | undefined,
      env?: Record<string, string | undefined>,
    ) => { sandboxMode: string; approvalPolicy: string };
    resolveCodexNetworkAccess: (
      options?: Record<string, unknown>,
      env?: Record<string, string | undefined>,
    ) => true | undefined;
    resolveCodexReasoningEffort: (reasoningEffort: unknown) => string | undefined;
  };

// Restore the real setInterval now that the import graph's timers are unref'd.
globalThis.setInterval = realSetInterval;

await initializeDatabase();

after(() => {
  globalThis.setInterval = realSetInterval;
  closeConnection();
  const restore = (key: string, original: string | undefined): void => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  };
  restore('HOME', ORIGINAL_HOME);
  restore('DATABASE_PATH', ORIGINAL_DB);
  restore('CODEX_ALLOW_FULL_ACCESS', ORIGINAL_FULL_ACCESS);
  restore('CODEX_WORKSPACE_NETWORK', ORIGINAL_WS_NETWORK);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Minimal ws stub carrying the spawner's userId. */
function makeWs(userId: number | null): { userId: number | null; send: (m: unknown) => void } {
  return { userId, send: () => {} };
}

/** Runs a fn with temporary process.env overrides, restoring them after. */
async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Drives queryCodex once (anonymous) and returns the captured threadOptions. */
async function spawnAndCapture(options: Record<string, unknown>): Promise<ThreadOptions | undefined> {
  const before = threadStarts.length;
  await queryCodex('ping', { cwd: sandboxCwd, model: 'gpt-5-codex', ...options }, makeWs(null));
  assert.equal(
    threadStarts.length,
    before + 1,
    'queryCodex must start/resume exactly one thread per spawn',
  );
  return threadStarts[threadStarts.length - 1].options;
}

// ===========================================================================
// Part 1 — Pure unit tests of the parser + network resolver (env injected).
// ===========================================================================
describe('mapPermissionModeToCodexOptions — sandbox ceiling (T-884)', () => {
  it('caps bypassPermissions to workspace-write by DEFAULT (no flag)', () => {
    assert.deepEqual(mapPermissionModeToCodexOptions('bypassPermissions', {}), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it('caps bypassPermissions even when the flag is present-but-not-"true"', () => {
    for (const bad of ['1', 'yes', 'TRUE', 'on', '']) {
      assert.equal(
        mapPermissionModeToCodexOptions('bypassPermissions', { CODEX_ALLOW_FULL_ACCESS: bad })
          .sandboxMode,
        'workspace-write',
        `flag value ${JSON.stringify(bad)} must NOT unlock danger-full-access`,
      );
    }
  });

  it('unlocks danger-full-access ONLY with CODEX_ALLOW_FULL_ACCESS==="true"', () => {
    assert.deepEqual(
      mapPermissionModeToCodexOptions('bypassPermissions', { CODEX_ALLOW_FULL_ACCESS: 'true' }),
      { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
    );
  });

  it('acceptEdits is always workspace-write/never (flag irrelevant)', () => {
    assert.deepEqual(mapPermissionModeToCodexOptions('acceptEdits', { CODEX_ALLOW_FULL_ACCESS: 'true' }), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it('default (and unknown) is workspace-write/untrusted, never danger', () => {
    for (const mode of ['default', undefined, 'nonsense'] as (string | undefined)[]) {
      const r = mapPermissionModeToCodexOptions(mode, { CODEX_ALLOW_FULL_ACCESS: 'true' });
      assert.equal(r.sandboxMode, 'workspace-write');
      assert.equal(r.approvalPolicy, 'untrusted');
    }
  });
});

describe('resolveCodexNetworkAccess — server-flag-ONLY, client opt-in removed (T-895/B-169)', () => {
  it('returns undefined (OFF) with no flag and no client fields', () => {
    assert.equal(resolveCodexNetworkAccess({}, {}), undefined);
  });

  it('IGNORES a client per-session networkAccess:true (the B-169 hole)', () => {
    assert.equal(
      resolveCodexNetworkAccess({ networkAccess: true }, {}),
      undefined,
      'client-supplied networkAccess must NOT enable the network',
    );
  });

  it('IGNORES the client alias networkAccessEnabled:true', () => {
    assert.equal(
      resolveCodexNetworkAccess({ networkAccessEnabled: true }, {}),
      undefined,
      'client-supplied networkAccessEnabled must NOT enable the network',
    );
  });

  it('IGNORES client opt-in even when both network keys are set', () => {
    assert.equal(
      resolveCodexNetworkAccess({ networkAccess: true, networkAccessEnabled: true }, {}),
      undefined,
    );
  });

  it('enables ONLY via the operator flag CODEX_WORKSPACE_NETWORK==="true"', () => {
    assert.equal(resolveCodexNetworkAccess({}, { CODEX_WORKSPACE_NETWORK: 'true' }), true);
  });

  it('operator flag owns the switch regardless of client fields', () => {
    assert.equal(
      resolveCodexNetworkAccess({ networkAccess: false }, { CODEX_WORKSPACE_NETWORK: 'true' }),
      true,
    );
  });

  it('ignores a falsey/non-"true" flag (and client opt-in cannot substitute)', () => {
    assert.equal(resolveCodexNetworkAccess({}, { CODEX_WORKSPACE_NETWORK: '1' }), undefined);
    assert.equal(resolveCodexNetworkAccess({}, { CODEX_WORKSPACE_NETWORK: 'TRUE' }), undefined);
    assert.equal(
      resolveCodexNetworkAccess({ networkAccess: true }, { CODEX_WORKSPACE_NETWORK: '' }),
      undefined,
    );
  });
});

describe('resolveCodexReasoningEffort — SDK-enum validation + clamp (T-905)', () => {
  it('passes through the SDK-native values unchanged', () => {
    for (const value of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
      assert.equal(resolveCodexReasoningEffort(value), value);
    }
  });

  it('is case-insensitive', () => {
    assert.equal(resolveCodexReasoningEffort('HIGH'), 'high');
    assert.equal(resolveCodexReasoningEffort('Medium'), 'medium');
  });

  it('clamps the Claude-only tiers (no ModelReasoningEffort equivalent) to xhigh', () => {
    assert.equal(resolveCodexReasoningEffort('max'), 'xhigh');
    assert.equal(resolveCodexReasoningEffort('ultracode'), 'xhigh');
  });

  it('omits the field (undefined) for "none", empty, missing, or unknown values', () => {
    for (const bad of ['none', '', undefined, null, 'nonsense', 123, {}]) {
      assert.equal(
        resolveCodexReasoningEffort(bad as unknown as string),
        undefined,
        `${JSON.stringify(bad)} must NOT be forwarded raw to the SDK`,
      );
    }
  });
});

// ===========================================================================
// Part 2 — Behavioural regression: NO live path reaches danger-full-access
// without the explicit flag (qa-critic veto requirement). Drives queryCodex and
// asserts the actual threadOptions the SDK would receive.
// ===========================================================================
describe('queryCodex live spawn — sandbox ceiling regression (T-884)', () => {
  it('WS default (no permissionMode) → workspace-write, network OFF', async () => {
    const opts = await spawnAndCapture({});
    assert.equal(opts?.sandboxMode, 'workspace-write');
    assert.equal(opts?.approvalPolicy, 'untrusted');
    assert.equal(opts?.networkAccessEnabled, undefined, 'network field must be omitted (OFF)');
  });

  it('WS client sending bypassPermissions → CAPPED to workspace-write (no flag)', async () => {
    const opts = await spawnAndCapture({ permissionMode: 'bypassPermissions' });
    assert.equal(
      opts?.sandboxMode,
      'workspace-write',
      'a client-chosen bypassPermissions must NOT reach danger-full-access',
    );
    assert.equal(opts?.approvalPolicy, 'never');
  });

  it('acceptEdits (what /api/agent now pins) → workspace-write', async () => {
    const opts = await spawnAndCapture({ permissionMode: 'acceptEdits' });
    assert.equal(opts?.sandboxMode, 'workspace-write');
    assert.equal(opts?.approvalPolicy, 'never');
  });

  it('resume path is capped identically (bypassPermissions, no flag)', async () => {
    const opts = await spawnAndCapture({ sessionId: 'fake-thread-id', permissionMode: 'bypassPermissions' });
    assert.equal(threadStarts[threadStarts.length - 1].method, 'resume');
    assert.equal(opts?.sandboxMode, 'workspace-write');
  });

  it('danger-full-access reachable ONLY behind CODEX_ALLOW_FULL_ACCESS (escape hatch works)', async () => {
    await withEnv({ CODEX_ALLOW_FULL_ACCESS: 'true' }, async () => {
      const opts = await spawnAndCapture({ permissionMode: 'bypassPermissions' });
      assert.equal(opts?.sandboxMode, 'danger-full-access');
    });
    // ...and the moment the flag is gone, the very same request is capped again.
    const opts = await spawnAndCapture({ permissionMode: 'bypassPermissions' });
    assert.equal(opts?.sandboxMode, 'workspace-write');
  });

  // spawnAndCapture forwards its argument straight into queryCodex as the run
  // options — exactly what the interactive WS path does with client-supplied
  // data.options (chat-websocket.service.ts → queryCodex(command, data.options, …)).
  // So passing networkAccess/networkAccessEnabled here models a hostile client at
  // the WS boundary.
  it('network enabled ONLY by the operator flag; CLIENT opt-in is IGNORED (T-895/B-169)', async () => {
    const off = await spawnAndCapture({ permissionMode: 'bypassPermissions' });
    assert.equal(off?.networkAccessEnabled, undefined, 'default: no network field');

    // The B-169 exploit: a client forwards networkAccess:true through the WS path.
    // It must NOT enable the network any more.
    const clientSession = await spawnAndCapture({ permissionMode: 'bypassPermissions', networkAccess: true });
    assert.equal(
      clientSession?.networkAccessEnabled,
      undefined,
      'client-supplied networkAccess must NOT enable network (B-169 closed)',
    );
    const clientAlias = await spawnAndCapture({ permissionMode: 'acceptEdits', networkAccessEnabled: true });
    assert.equal(
      clientAlias?.networkAccessEnabled,
      undefined,
      'client-supplied networkAccessEnabled alias must NOT enable network',
    );

    // ONLY the operator flag turns it on...
    await withEnv({ CODEX_WORKSPACE_NETWORK: 'true' }, async () => {
      const onFlag = await spawnAndCapture({ permissionMode: 'acceptEdits' });
      assert.equal(onFlag?.networkAccessEnabled, true, 'operator flag enables network');
      // ...and the server owns the switch even against a client trying to disable it.
      const onFlagClientOff = await spawnAndCapture({ permissionMode: 'acceptEdits', networkAccess: false });
      assert.equal(onFlagClientOff?.networkAccessEnabled, true);
    });

    // Under danger-full-access the workspace-write network field is NOT emitted
    // (network is already implied by full access; the config key would be inert).
    await withEnv({ CODEX_ALLOW_FULL_ACCESS: 'true' }, async () => {
      const danger = await spawnAndCapture({ permissionMode: 'bypassPermissions' });
      assert.equal(danger?.sandboxMode, 'danger-full-access');
      assert.equal(danger?.networkAccessEnabled, undefined);
    });
  });

  it('web search is pinned OFF at launch on every spawn (defense in depth, T-895)', async () => {
    const base = await spawnAndCapture({ permissionMode: 'default' });
    assert.equal(base?.webSearchEnabled, false, 'webSearchEnabled must be pinned false');
    assert.equal(base?.webSearchMode, 'disabled', "webSearchMode must be pinned 'disabled'");

    // Stays disabled even where the operator has enabled outbound network.
    await withEnv({ CODEX_WORKSPACE_NETWORK: 'true' }, async () => {
      const withNet = await spawnAndCapture({ permissionMode: 'acceptEdits' });
      assert.equal(withNet?.networkAccessEnabled, true, 'sanity: operator flag on');
      assert.equal(withNet?.webSearchEnabled, false, 'web search stays off under operator network');
      assert.equal(withNet?.webSearchMode, 'disabled');
    });

    // A client cannot re-open web search either.
    const hostile = await spawnAndCapture({
      permissionMode: 'bypassPermissions',
      webSearchEnabled: true,
      webSearchMode: 'live',
    });
    assert.equal(hostile?.webSearchEnabled, false, 'client webSearchEnabled:true must NOT stick');
    assert.equal(hostile?.webSearchMode, 'disabled', 'client webSearchMode:live must NOT stick');
  });
});

describe('queryCodex live spawn — modelReasoningEffort forwarding (T-905)', () => {
  it('omits modelReasoningEffort entirely when no reasoningEffort is sent', async () => {
    const opts = await spawnAndCapture({});
    assert.equal(opts?.modelReasoningEffort, undefined);
  });

  it('forwards a valid reasoningEffort as modelReasoningEffort', async () => {
    const opts = await spawnAndCapture({ reasoningEffort: 'high' });
    assert.equal(opts?.modelReasoningEffort, 'high');
  });

  it('clamps a hostile/stale max|ultracode client value to xhigh', async () => {
    const maxOpts = await spawnAndCapture({ reasoningEffort: 'max' });
    assert.equal(maxOpts?.modelReasoningEffort, 'xhigh');
    const ucOpts = await spawnAndCapture({ reasoningEffort: 'ultracode' });
    assert.equal(ucOpts?.modelReasoningEffort, 'xhigh');
  });

  it('omits the field for "none" or any unrecognized value — never forwarded raw', async () => {
    const noneOpts = await spawnAndCapture({ reasoningEffort: 'none' });
    assert.equal(noneOpts?.modelReasoningEffort, undefined);
    const junkOpts = await spawnAndCapture({ reasoningEffort: 'not-a-real-effort' });
    assert.equal(junkOpts?.modelReasoningEffort, undefined);
  });

  it('is forwarded identically on the resume path', async () => {
    const opts = await spawnAndCapture({ sessionId: 'fake-thread-id', reasoningEffort: 'xhigh' });
    assert.equal(threadStarts[threadStarts.length - 1].method, 'resume');
    assert.equal(opts?.modelReasoningEffort, 'xhigh');
  });
});

// ===========================================================================
// Part 3 — /api/agent no longer forces bypassPermissions for Codex (structural).
// Importing the Express handler would drag in auth/DB/GitHub; instead assert the
// codex dispatch block's source directly — the committee's explicit requirement.
// ===========================================================================
describe('/api/agent codex dispatch — no pinned bypass (T-884)', () => {
  it('the codex branch pins acceptEdits, not bypassPermissions', () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, 'routes', 'agent.js'),
      'utf8',
    );
    const start = src.indexOf("provider === 'codex'");
    const end = src.indexOf("provider === 'gemini'");
    assert.ok(start !== -1 && end !== -1 && end > start, 'could not locate the codex dispatch block');
    const codexBlock = src.slice(start, end);
    assert.ok(codexBlock.includes('queryCodex('), 'codex block must call queryCodex');
    assert.ok(
      !codexBlock.includes("permissionMode: 'bypassPermissions'"),
      '/api/agent must NOT pin permissionMode:bypassPermissions for codex',
    );
    assert.ok(
      codexBlock.includes("permissionMode: 'acceptEdits'"),
      '/api/agent codex path must pin the safe acceptEdits mode',
    );
  });
});
