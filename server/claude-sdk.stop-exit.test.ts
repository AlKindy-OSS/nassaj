/**
 * claude-sdk.stop-exit.test.ts — B-1399: a user STOP is not a failure, and a
 * finished run's terminal frames do not leak into the next turn's replay.
 *
 * Measured 2026-09-29 on the node log:
 *   (a) "Aborting SDK session" → CONTROL-STREAM-CLOSE reason=abort → "SDK query
 *       error: Claude Code process exited with code 1". interrupt() answered, so
 *       the abort controller never fired and the catch mapped the exit to
 *       `spawn_failed`, sent it, and settled the launch as `failed`.
 *   (b) A new turn 72s later reused the retained registry entry; a reload that
 *       attached with lastSeq=0 replayed the previous run's error frame into the
 *       live turn.
 *
 * Drives the production `queryClaudeSDK`, `abortClaudeSDKSession` and
 * `attachClaudeSDKSession`; only the Agent SDK query handle is a stand-in.
 *
 * Runner: node:test with --experimental-test-module-mocks (npm run test:server).
 */

// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock, beforeEach, afterEach } from 'node:test';

type Payload = Record<string, unknown>;

let scriptedFailure: Error | null = null;
let releaseMessageStream: () => void = () => {};
let messageStreamHeld: Promise<void> = Promise.resolve();

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: () => {
      const failure = scriptedFailure;
      const held = messageStreamHeld;
      return {
        async *[Symbol.asyncIterator]() {
          await held;
          if (failure) throw failure;
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

mock.module('./services/isolation/resolve-claude-run-profile.js', {
  namedExports: {
    resolveClaudeRunProfileOrThrow: async ({ baseEnv = process.env } = {}) => ({
      env: { ...baseEnv }, effectiveEngine: null, engineHosts: null, pin: {},
    }),
  },
});

const sdk = (await import('./claude-sdk.js')) as unknown as {
  queryClaudeSDK: (command: string, options: Record<string, unknown>, ws: unknown) => Promise<unknown>;
  abortClaudeSDKSession: (sessionId: string, rawWs?: unknown) => Promise<{ aborted: boolean; reason: string }>;
  attachClaudeSDKSession: (sessionId: string, lastSeq: number, send: (p: Payload) => void) => number;
  isClaudeSDKSessionActive: (sessionId: string) => boolean;
};

const PROMPT = 'continue the refactor';
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'SESSION_REGISTRY_claude', 'CLAUDE_SDK_INTERRUPT_TIMEOUT_MS'] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmpConfigDir = '';
let tmpCwd = '';
let sidCounter = 0;
const nextSid = () => `00001399-${String(++sidCounter).padStart(4, '0')}-4000-8000-000000000000`;

function makeWs() {
  const sent: Payload[] = [];
  return { sent, send: (p: Payload) => { sent.push(p); }, userId: null, ws: { readyState: 1 } };
}

function replayFromStart(sessionId: string): Payload[] {
  const out: Payload[] = [];
  sdk.attachClaudeSDKSession(sessionId, 0, (p) => { out.push(p); });
  return out;
}

function tracePermission(trace: string[]) {
  return {
    consume: () => { trace.push('consume'); },
    markStarted: () => { trace.push('started'); },
    settle: (outcome: string) => { trace.push(`settle:${outcome}`); },
    notStarted: () => { trace.push('not-started'); },
  };
}

/** Hold the next run's message stream open until the returned release is called. */
function holdStream() {
  messageStreamHeld = new Promise<void>((resolve) => { releaseMessageStream = resolve; });
}

/**
 * Wait until the run is registered as live (addSession ran), which is the
 * precondition STOP and a reload attach depend on. Counting query() calls is
 * not enough: the model-catalog probe (probeSupportedModels) calls the same
 * mocked query() earlier in the run, so under load the count can move before
 * the chat query exists and STOP races ahead of the registration.
 */
async function waitForLiveRun(sessionId: string) {
  for (let i = 0; i < 500 && !sdk.isClaudeSDKSessionActive(sessionId); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(sdk.isClaudeSDKSessionActive(sessionId), 'the run registered as live');
}

beforeEach(() => {
  scriptedFailure = null;
  messageStreamHeld = Promise.resolve();
  releaseMessageStream = () => {};
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SESSION_REGISTRY_claude = '1';
  process.env.CLAUDE_SDK_INTERRUPT_TIMEOUT_MS = '500';
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1399-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'b1399-cwd-'));
});

afterEach(() => {
  releaseMessageStream();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  for (const dir of [tmpConfigDir, tmpCwd]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('B-1399: answered interrupt then CLI exit code 1 is a stop, not spawn_failed', async () => {
  const sid = nextSid();
  const trace: string[] = [];
  holdStream();
  scriptedFailure = new Error('Claude Code process exited with code 1');
  const ws = makeWs();

  const run = sdk.queryClaudeSDK(PROMPT, {
    sessionId: sid, cwd: tmpCwd, permissionExecution: tracePermission(trace),
  }, ws);
  await waitForLiveRun(sid);

  const stop = await sdk.abortClaudeSDKSession(sid);
  assert.equal(stop.aborted, true);
  assert.equal(stop.reason, 'interrupted', 'interrupt answered: the CLI was not force-killed');

  releaseMessageStream();
  await run;

  assert.equal(ws.sent.filter((p) => p.kind === 'error').length, 0, 'no error frame on the wire');
  assert.equal(replayFromStart(sid).filter((p) => p.kind === 'error').length, 0, 'none buffered');
  assert.deepEqual(trace, ['consume', 'started', 'settle:cancelled'], 'launch settles as cancelled');
});

test('B-1399: a genuine exit code 1 without STOP still reports spawn_failed', async () => {
  const sid = nextSid();
  const trace: string[] = [];
  scriptedFailure = new Error('Claude Code process exited with code 1');
  const ws = makeWs();

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd, permissionExecution: tracePermission(trace) }, ws);

  const errors = ws.sent.filter((p) => p.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'spawn_failed');
  assert.deepEqual(trace, ['consume', 'started', 'settle:failed']);
});

test('B-1399: a new turn on a retained entry does not replay the previous error', async () => {
  const sid = nextSid();
  scriptedFailure = new Error('spawn ENOENT: the CLI died mid-run');
  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd }, makeWs());
  const oldFrames = replayFromStart(sid);
  const oldError = oldFrames.find((p) => p.kind === 'error');
  assert.ok(oldError, 'precondition: the failed run left its error in the retained buffer');
  const oldLastSeq = oldError.sequence as number;

  // Next turn inside the retention window, still running when a reload attaches.
  scriptedFailure = null;
  holdStream();
  assert.equal(sdk.isClaudeSDKSessionActive(sid), false, 'precondition: the failed run unregistered');
  const run = sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd }, makeWs());
  await waitForLiveRun(sid);

  const reloaded = replayFromStart(sid);
  assert.equal(reloaded.filter((p) => p.kind === 'error').length, 0, 'no stale error in a live turn');

  releaseMessageStream();
  await run;

  const afterRun = replayFromStart(sid);
  assert.equal(afterRun.filter((p) => p.kind === 'error').length, 0);
  const complete = afterRun.find((p) => p.kind === 'complete');
  assert.ok(complete, 'the new turn buffered its own terminal frame');
  assert.ok((complete.sequence as number) > oldLastSeq, 'seq keeps rising, so lastSeq>0 resumes still work');

  const resumed: Payload[] = [];
  sdk.attachClaudeSDKSession(sid, oldLastSeq, (p) => { resumed.push(p); });
  assert.ok(resumed.some((p) => p.kind === 'complete'), 'a client holding the old lastSeq gets the new turn');
});
