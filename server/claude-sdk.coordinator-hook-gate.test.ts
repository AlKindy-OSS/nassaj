/**
 * B-503 — the coordinator-injection hooks must be GATED AT REGISTRATION.
 *
 * The failure this locks down: the CLI cancels a tool whose PreToolUse SDK-callback
 * it cannot reach over a closed control stream, and it does so at tool ENTRY —
 * before the hook body runs. So the `if (!isCoordinatorInjectionEnabled(...))` guard
 * that used to sit INSIDE the body could never fire in the failing case. Registering
 * the hook unconditionally bought the failure mode without ever buying the feature:
 * measured over the transcripts, 41 cancelled `Agent` delegations between 2026-07-24
 * and 2026-08-05 against 0 in the 437 that preceded these hooks — while the flag was
 * never once live on a running server.
 *
 * What is asserted is therefore the SHAPE of `sdkOptions.hooks`, not the behaviour of
 * the builders (those have their own tests): with the flag down the CLI must be handed
 * NO SDK-callback hook on Agent/Task at all, so a dead control stream has nothing to
 * cancel. And with the flag up the pair must come back byte-identical, so this gate
 * cannot silently disable the feature for whoever does run the coordinator.
 *
 * A test that drove the real cancellation would need a live CLI and a real control
 * stream — the cancellation happens inside the CLI, not in our code — so it cannot be
 * written here honestly. This asserts the one invariant nassaj actually owns.
 *
 * Runner: node:test with --experimental-test-module-mocks. The SDK mock MUST be
 * registered before importing the module-under-test, hence the dynamic import.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test, { mock, beforeEach, afterEach } from 'node:test';

type SdkMessage = Record<string, unknown>;
type HookEntry = { matcher?: string; hooks: unknown[] };
type HookMap = Record<string, HookEntry[] | undefined>;
type QueryHarness = {
  arg: { prompt?: unknown; options?: Record<string, unknown> };
  releaseMessageStream: () => void;
};

let scriptedMessages: SdkMessage[] = [];
let queryStarted: Promise<QueryHarness> = Promise.resolve(null as unknown as QueryHarness);
let resolveQueryStarted: (harness: QueryHarness) => void = () => {};
let activeHarness: QueryHarness | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: { prompt?: unknown; options?: Record<string, unknown> }) => {
      const messages = scriptedMessages;
      let releaseMessageStream = () => {};
      const messageStreamHeld = new Promise<void>(resolve => { releaseMessageStream = resolve; });
      const harness = { arg, releaseMessageStream };
      activeHarness = harness;
      resolveQueryStarted(harness);
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
          await messageStreamHeld;
        },
        interrupt: async () => {},
        supportedCommands: async () => [],
        supportedModels: async () => [],
      };
    },
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

const sdk = (await import('./claude-sdk.js')) as unknown as {
  queryClaudeSDK: (command: string, options: Record<string, unknown>, ws: unknown) => Promise<unknown>;
};

const SID = 'coordinator-gate-session-0001';

const resultMsg: SdkMessage = {
  type: 'result', session_id: SID, subtype: 'success', is_error: false, result: 'ok',
};

function makeWs() {
  return { send: () => {}, userId: null, ws: { readyState: 1 } };
}

/** Runs one turn and returns the hooks map the SDK was handed. */
async function hooksForThisRun(): Promise<HookMap> {
  scriptedMessages = [resultMsg];
  const run = sdk.queryClaudeSDK('delegate this please', { cwd: process.cwd() }, makeWs());
  const harness = await queryStarted;
  assert.ok(harness.arg.options, 'query() must have been called with options');
  const hooks = (harness.arg.options.hooks ?? {}) as HookMap;
  harness.releaseMessageStream();
  await run;
  return hooks;
}

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'NASSAJ_COORDINATOR'] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmpConfigDir = '';

beforeEach(() => {
  scriptedMessages = [];
  queryStarted = new Promise<QueryHarness>(resolve => { resolveQueryStarted = resolve; });
  activeHarness = null;
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b503-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
});

afterEach(() => {
  activeHarness?.releaseMessageStream();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  try { fs.rmSync(tmpConfigDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('flag DOWN: no SDK-callback hook is registered on Agent/Task — nothing for a dead control stream to cancel', async () => {
  delete process.env.NASSAJ_COORDINATOR;
  const hooks = await hooksForThisRun();

  assert.equal(hooks.PreToolUse, undefined,
    'a PreToolUse callback on Agent|Task is exactly what gets cancelled at tool entry');
  assert.equal(hooks.SessionStart, undefined,
    'SessionStart is harmless on cancel but still pays a control round-trip for nothing');
});

test('flag DOWN: unrelated hooks are untouched — the gate must not disable anything else', async () => {
  delete process.env.NASSAJ_COORDINATOR;
  const hooks = await hooksForThisRun();

  assert.ok(Array.isArray(hooks.Notification) && hooks.Notification.length > 0,
    'Notification carries user-facing alerts and is not part of the coordinator feature');
});

test('flag UP: both hooks come back, and PreToolUse still matches Agent|Task', async () => {
  process.env.NASSAJ_COORDINATOR = '1';
  const hooks = await hooksForThisRun();

  assert.ok(Array.isArray(hooks.PreToolUse) && hooks.PreToolUse.length === 1,
    'the gate must not disable the feature for whoever does run the coordinator');
  assert.equal(hooks.PreToolUse![0].matcher, 'Agent|Task',
    'the matcher is load-bearing: it is what scopes injection to delegations');
  assert.ok(Array.isArray(hooks.SessionStart) && hooks.SessionStart.length === 1);
  assert.ok(Array.isArray(hooks.Notification) && hooks.Notification.length > 0);
});

test('only the exact value "1" opens the gate — a truthy-looking flag must not', async () => {
  process.env.NASSAJ_COORDINATOR = 'true';
  const hooks = await hooksForThisRun();

  assert.equal(hooks.PreToolUse, undefined,
    'isCoordinatorInjectionEnabled accepts "1" only; the gate must inherit that exactly');
});
