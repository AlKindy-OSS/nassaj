/**
 * claude-sdk.control-stream.test.ts — B-117: the control channel must outlive the
 * first `result` whenever the run can still continue.
 *
 * The failure this locks (measured on the live incident, AlNuman session
 * e3c36199, 2026-07-26T23:29:09.568Z): the owner's every delegation came back as
 *
 *   "The user doesn't want to take this action right now. STOP what you are
 *    doing and wait for the user to tell you how to proceed."
 *
 * although nobody pressed anything. It is not a denial. Handing the SDK a STRING
 * prompt sets isSingleUserTurn, and the SDK then closes stdin at the FIRST
 * `result` ("First result received for single-turn query, closing stdin",
 * sdk.mjs). stdin also carries every control_response the SDK owes the CLI, so
 * once a run produced one result — and kept working, because a background-task
 * notification or a queued message re-enters the loop — the CLI could no longer
 * reach us. Its own log for the failing tool calls reads
 * "PreToolUse SDK callback hook cancelled (control stream closed)", and a tool
 * whose PreToolUse hook cannot run is cancelled with the text above
 * (toolDenialKind "cancelled" — indistinguishable from a human refusal).
 *
 * Only Agent/Task showed it: they are the only tools matched by an SDK CALLBACK
 * hook. Bash/Edit/Read match COMMAND hooks, which the CLI runs itself.
 *
 * What is locked here:
 *   1. the prompt handed to query() is a STREAM (async iterable), not a string,
 *      carrying the same single user turn — so stdin is not auto-closed;
 *   2. an ordinary turn still closes input the instant the result lands, so it
 *      ends exactly as fast as it did before (asserted with an absurdly long
 *      grace: only an immediate close can pass);
 *   3. a run that launched a BACKGROUND agent holds the channel open past the
 *      result and closes only after the grace;
 *   4. the same holds for a `<task-notification>` that arrives from a previous
 *      process — the exact shape of the live incident;
 *   5. aborting releases the input at once, so a stopped run never sits out the
 *      grace.
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

let scriptedMessages: SdkMessage[] = [];
let lastQueryArg: { prompt?: unknown; options?: Record<string, unknown> } | null = null;
let promptIterator: AsyncIterator<unknown> | null = null;
let releaseMessageStream: () => void = () => {};
let messageStreamHeld: Promise<void> = Promise.resolve();

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: { prompt?: unknown; options?: Record<string, unknown> }) => {
      lastQueryArg = arg;
      // Drive the prompt exactly like the real SDK does: pull the first turn,
      // then leave the generator parked so the test can observe when nassaj
      // closes it.
      const promptAsAny = arg.prompt as AsyncIterable<unknown> | string;
      promptIterator = typeof promptAsAny === 'string'
        ? null
        : promptAsAny[Symbol.asyncIterator]();
      const messages = scriptedMessages;
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
          // Stay open after the scripted messages so the close under test is the
          // one the loop decided on — not the unconditional release in `finally`.
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
  abortClaudeSDKSession: (sessionId: string, rawWs?: unknown) => Promise<{ aborted: boolean }>;
};

const SID = 'control-stream-session-0001';
const PROMPT = 'delegate this please';

function makeWs() {
  return { send: () => {}, userId: null, ws: { readyState: 1 } };
}

/** Resolves to true if the prompt stream has been closed within `ms`. */
async function promptClosedWithin(ms: number): Promise<boolean> {
  assert.ok(promptIterator, 'prompt must be a stream');
  const closed = promptIterator!.next().then(r => !!r.done);
  const timeout = new Promise<boolean>(resolve => {
    const t = setTimeout(() => resolve(false), ms);
    if (typeof t.unref === 'function') t.unref();
  });
  return Promise.race([closed, timeout]);
}

const assistantToolUse = (name: string, input: Record<string, unknown>): SdkMessage => ({
  type: 'assistant',
  session_id: SID,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name, input }] },
});

const resultMsg: SdkMessage = {
  type: 'result', session_id: SID, subtype: 'success', is_error: false, result: 'ok',
};

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_SDK_INPUT_CLOSE_GRACE_MS'] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmpConfigDir = '';

beforeEach(() => {
  scriptedMessages = [];
  lastQueryArg = null;
  promptIterator = null;
  messageStreamHeld = new Promise<void>(resolve => { releaseMessageStream = resolve; });
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b117-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
});

afterEach(() => {
  releaseMessageStream();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  try { fs.rmSync(tmpConfigDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('the prompt is a stream carrying the turn — never a string (that is what closed stdin)', async () => {
  scriptedMessages = [resultMsg];
  const run = sdk.queryClaudeSDK(PROMPT, { cwd: process.cwd() }, makeWs());
  // Let the query get constructed.
  await new Promise(r => setTimeout(r, 50));

  assert.notEqual(typeof lastQueryArg?.prompt, 'string', 'a string prompt re-arms isSingleUserTurn');
  assert.ok(promptIterator, 'the prompt must be an async iterable');

  const first = await promptIterator!.next();
  assert.equal(first.done, false, 'the stream must carry the turn');
  const turn = first.value as { type: string; message: { role: string; content: unknown } };
  assert.equal(turn.type, 'user');
  assert.equal(turn.message.role, 'user');
  assert.equal(turn.message.content, PROMPT, 'the model must receive the same text as before');

  releaseMessageStream();
  await run;
});

test('an ordinary turn closes input the moment the result lands (no added latency)', async () => {
  // A 10-minute grace: only an IMMEDIATE close can make this pass.
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '600000';
  scriptedMessages = [
    { type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    resultMsg,
  ];
  const run = sdk.queryClaudeSDK(PROMPT, { cwd: process.cwd() }, makeWs());
  await new Promise(r => setTimeout(r, 50));
  await promptIterator!.next();                      // consume the turn

  assert.equal(await promptClosedWithin(500), true, 'input must close as soon as the run has nothing pending');
  releaseMessageStream();
  await run;
});

test('a background agent keeps the channel open past the result, then closes on the grace', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '400';
  scriptedMessages = [
    assistantToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'x' }),  // background by default
    resultMsg,
  ];
  const run = sdk.queryClaudeSDK(PROMPT, { cwd: process.cwd() }, makeWs());
  await new Promise(r => setTimeout(r, 50));
  await promptIterator!.next();

  assert.equal(await promptClosedWithin(150), false, 'the channel must survive the first result');
  assert.equal(await promptClosedWithin(1500), true, 'and close once the run really goes quiet');
  releaseMessageStream();
  await run;
});

test('a task-notification from a previous process also holds the channel (the live incident)', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '400';
  scriptedMessages = [
    {
      type: 'user',
      session_id: SID,
      message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>abc</task-id>' }] },
    },
    resultMsg,
  ];
  const run = sdk.queryClaudeSDK(PROMPT, { cwd: process.cwd() }, makeWs());
  await new Promise(r => setTimeout(r, 50));
  await promptIterator!.next();

  assert.equal(await promptClosedWithin(150), false, 'a queued notification means a continuation is coming');
  assert.equal(await promptClosedWithin(1500), true, 'and the channel still closes afterwards');
  releaseMessageStream();
  await run;
});

test('aborting releases the input at once instead of waiting out the grace', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '600000';
  scriptedMessages = [assistantToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'x' })];
  const run = sdk.queryClaudeSDK(PROMPT, { sessionId: SID, cwd: process.cwd() }, makeWs());
  await new Promise(r => setTimeout(r, 80));
  await promptIterator!.next();

  const aborted = await sdk.abortClaudeSDKSession(SID);
  assert.equal(aborted.aborted, true, 'the session must be interruptable');
  assert.equal(await promptClosedWithin(500), true, 'stop must not wait for the grace');
  releaseMessageStream();
  await run;
});
