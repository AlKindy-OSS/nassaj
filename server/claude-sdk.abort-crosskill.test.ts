/**
 * claude-sdk.abort-crosskill.test.ts — B-ABORT-CROSSKILL: STOP must never abort a
 * session other than the one the user named.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * A browser tab holds ONE websocket for every session it opens, and every claude
 * run started from that tab is indexed under that single socket. When the abort's
 * `sessionId` did not resolve — the ordinary case of a SECOND press on a run that
 * already stopped — `abortClaudeSDKSession` fell back to "the newest active run on
 * this socket" and killed it. That is a live, unrelated conversation, one per
 * press, walking down the socket's list until it reached the session in view.
 *
 * Measured on this install in ~/.pm2/logs/nassaj-dev-out.log (not reconstructed):
 *   2026-08-05 08:51:35  sdk-abort session=49039b4b… status=active     ← correct
 *   2026-08-05 08:51:47  sdk-abort fallback: requested=49039b4b…
 *                                 resolved-by-connection=f738cd26…     ← bystander
 *   2026-08-05 06:18:17  same shape: requested=bc5256e1… → d40debf5…
 *
 * WHY THESE ARE NOT SYNTHETIC FIXTURES
 * ------------------------------------
 * Sessions are registered through the EXPORTED production seam `addSession`, which
 * is what builds the per-socket index the fallback reads, and the abort runs
 * through the real exported `abortClaudeSDKSession`. Ids are real uuid v4s taken
 * from the log lines above. Only the Agent SDK query handle is a stand-in, because
 * `interrupt()` on a real child adds nothing to WHICH session gets interrupted.
 *
 * Runner: node:test with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: () => ({
      async *[Symbol.asyncIterator]() {
        // no messages
      },
      interrupt: async () => {},
      supportedCommands: async () => [],
      supportedModels: async () => [],
    }),
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

type AbortResult = { aborted: boolean; reason: string; sessionId: string | null };

const sdk = (await import('./claude-sdk.js')) as unknown as {
  addSession: (
    sessionId: string,
    queryInstance: unknown,
    tempImagePaths?: string[],
    tempDir?: string | null,
    writer?: unknown,
    runTag?: string | null,
    projectPath?: string | null,
    runToken?: string | null,
    releaseInput?: (() => void) | null,
    forceStop?: (() => void) | null
  ) => void;
  removeSession: (sessionId: string, expectedRunToken?: string | null) => void;
  getSession: (sessionId: string) => { status: string; startTime: number } | undefined;
  abortClaudeSDKSession: (sessionId: string, rawWs?: unknown) => Promise<AbortResult>;
};

// The two ids from the 08:51 log lines: the session the user was looking at, and
// the bystander the fallback killed.
const VIEWED_SID = '00000001-0000-4000-8000-000000000001';
const BYSTANDER_SID = '00000002-0000-4000-8000-000000000002';

/** One tab = one raw socket; every run below is indexed under it, as in production. */
const rawSocket = { readyState: 1, send() {} };
/** WebSocketWriter shape addSession reads the raw socket out of. */
const writer = { ws: rawSocket, isWebSocketWriter: true, send() {} };

const interrupted: string[] = [];
/** Stand-in for the SDK query handle; records that THIS session was the one hit. */
function handleFor(sessionId: string) {
  return { interrupt: async () => { interrupted.push(sessionId); } };
}

afterEach(() => {
  interrupted.length = 0;
  sdk.removeSession(VIEWED_SID);
  sdk.removeSession(BYSTANDER_SID);
});

test('named id that no longer resolves does NOT fall back onto a bystander run', async () => {
  // The bystander is the NEWEST run on the socket — exactly the log's shape.
  sdk.addSession(VIEWED_SID, handleFor(VIEWED_SID), [], null, writer);
  sdk.addSession(BYSTANDER_SID, handleFor(BYSTANDER_SID), [], null, writer);

  // First press stops the viewed session for real.
  const first = await sdk.abortClaudeSDKSession(VIEWED_SID, rawSocket);
  assert.strictEqual(first.aborted, true);
  assert.deepStrictEqual(interrupted, [VIEWED_SID]);

  // Second press on the now-finished session: must be a no-op, not a kill.
  const second = await sdk.abortClaudeSDKSession(VIEWED_SID, rawSocket);
  assert.strictEqual(second.aborted, false, 'nothing to abort');
  assert.strictEqual(second.sessionId, null, 'no session resolved');
  assert.deepStrictEqual(
    interrupted,
    [VIEWED_SID],
    'the bystander was NOT interrupted by the second press'
  );
  assert.strictEqual(
    sdk.getSession(BYSTANDER_SID)?.status,
    'active',
    'the bystander is still live'
  );
});

test('empty id still stops the pre-id run being raced (the fallback it exists for)', async () => {
  sdk.addSession(VIEWED_SID, handleFor(VIEWED_SID), [], null, writer);

  const result = await sdk.abortClaudeSDKSession('', rawSocket);
  assert.strictEqual(result.aborted, true);
  assert.strictEqual(result.sessionId, VIEWED_SID);
  assert.deepStrictEqual(interrupted, [VIEWED_SID]);
});

test('empty id does not reach back to an OLD run — only the one being raced', async () => {
  sdk.addSession(BYSTANDER_SID, handleFor(BYSTANDER_SID), [], null, writer);
  // Age it past the race window the fallback is scoped to. Mutating startTime on
  // the entry addSession created is how the production sweep reads run age.
  const aged = sdk.getSession(BYSTANDER_SID);
  assert.ok(aged, 'production addSession seam registered the session');
  aged.startTime = Date.now() - 10 * 60 * 1000;

  const result = await sdk.abortClaudeSDKSession('', rawSocket);
  assert.strictEqual(result.aborted, false, 'an old run is not the pre-id race');
  assert.deepStrictEqual(interrupted, []);
  assert.strictEqual(sdk.getSession(BYSTANDER_SID)?.status, 'active');
});

// ── B-1136 ───────────────────────────────────────────────────────────────────
// Measured 2026-09-12: four STOP presses on session af03c024 each logged
// `sdk-abort status=active` and nothing after. interrupt() never settled because
// the run's control stream had already closed, so the run stayed active.

/** interrupt() on a run whose control stream is closed: it never settles. */
const deafHandle = () => ({ interrupt: () => new Promise<void>(() => {}) });

async function withInterruptTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.CLAUDE_SDK_INTERRUPT_TIMEOUT_MS;
  process.env.CLAUDE_SDK_INTERRUPT_TIMEOUT_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_SDK_INTERRUPT_TIMEOUT_MS;
    else process.env.CLAUDE_SDK_INTERRUPT_TIMEOUT_MS = saved;
  }
}

test('B-1136: an unanswered interrupt falls back to killing the CLI and ends the run', async () => {
  let killed = 0;
  sdk.addSession(VIEWED_SID, deafHandle(), [], null, writer, null, null, null, null, () => { killed += 1; });

  const result = await withInterruptTimeout(50, () => sdk.abortClaudeSDKSession(VIEWED_SID, rawSocket));
  assert.strictEqual(result.aborted, true);
  assert.strictEqual(result.reason, 'force-stopped');
  assert.strictEqual(killed, 1, 'the CLI was killed exactly once');
  assert.strictEqual(sdk.getSession(VIEWED_SID), undefined, 'the run no longer counts as active');
});

test('B-1136: without a force-stop handle an unanswered interrupt fails instead of hanging', async () => {
  sdk.addSession(VIEWED_SID, deafHandle(), [], null, writer);

  const result = await withInterruptTimeout(50, () => sdk.abortClaudeSDKSession(VIEWED_SID, rawSocket));
  assert.strictEqual(result.aborted, false);
  assert.match(result.reason, /did not answer interrupt/);
  assert.strictEqual(sdk.getSession(VIEWED_SID)?.status, 'active');
});

test('B-1136: an interrupt that answers keeps the ordinary path and never kills', async () => {
  let killed = 0;
  sdk.addSession(VIEWED_SID, handleFor(VIEWED_SID), [], null, writer, null, null, null, null, () => { killed += 1; });

  const result = await withInterruptTimeout(50, () => sdk.abortClaudeSDKSession(VIEWED_SID, rawSocket));
  assert.strictEqual(result.aborted, true);
  assert.strictEqual(result.reason, 'interrupted');
  assert.strictEqual(killed, 0);
  assert.deepStrictEqual(interrupted, [VIEWED_SID]);
});
