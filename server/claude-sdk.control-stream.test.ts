/**
 * claude-sdk.control-stream.test.ts — B-117: the control channel must outlive the
 * first `result` whenever the run can still continue.
 *
 * The failure this locks (measured on the live incident, SampleTwo session
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
 * B-1120 (session c71ec322, 2026-09-11): the grace alone is not enough — a
 * background agent still running at `result` finished 10 minutes later, its
 * notification re-entered the same CLI process, and the next Agent call died
 * with the refusal text above. The channel is now held while CLI tasks are
 * pending (system task_started → task_notification | terminal task_updated),
 * idle-capped. The task fixtures below mirror a capture of CLI 2.1.269.
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
// B-1120: later batches of messages, each emitted only when the test releases it.
let laterPhases: SdkMessage[][] = [];
let phaseGates: Promise<void>[] = [];
let phaseReleases: Array<() => void> = [];
let lastQueryArg: { prompt?: unknown; options?: Record<string, unknown> } | null = null;
let promptIterator: AsyncIterator<unknown> | null = null;
let firstPrompt: Promise<IteratorResult<unknown>> | null = null;
let resolveQueryStarted: () => void = () => {};
let queryStarted: Promise<void> = Promise.resolve();
let releaseScriptedMessages: () => void = () => {};
let scriptedMessagesHeld: Promise<void> = Promise.resolve();
let resolveScriptedMessagesConsumed: () => void = () => {};
let scriptedMessagesConsumed: Promise<void> = Promise.resolve();
let releaseMessageStream: () => void = () => {};
let messageStreamHeld: Promise<void> = Promise.resolve();
let promptClosure: Promise<boolean> | null = null;

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
      firstPrompt = promptIterator?.next() ?? null;
      resolveQueryStarted();
      const messages = scriptedMessages;
      const phases = laterPhases;
      const gates = phaseGates;
      return {
        async *[Symbol.asyncIterator]() {
          await scriptedMessagesHeld;
          for (const m of messages) yield m;
          resolveScriptedMessagesConsumed();
          for (const [i, phase] of phases.entries()) {
            await gates[i];
            for (const m of phase) yield m;
          }
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

// Resume-profile enforcement has its own focused suite; these tests isolate
// control-stream lifetime and abort semantics.
mock.module('./services/isolation/resolve-claude-run-profile.js', {
  namedExports: {
    resolveClaudeRunProfileOrThrow: async ({ baseEnv = process.env } = {}) => ({
      env: { ...baseEnv }, effectiveEngine: null, engineHosts: null, pin: {},
    }),
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
  promptClosure ??= (async () => {
    while (true) {
      const item = await promptIterator!.next();
      if (item.done) return true;
    }
  })();
  const timeout = new Promise<boolean>(resolve => {
    const t = setTimeout(() => resolve(false), ms);
    if (typeof t.unref === 'function') t.unref();
  });
  return Promise.race([promptClosure, timeout]);
}

/** B-1120: queue message batches that follow the scripted ones, one gate each. */
function preparePhases(phases: SdkMessage[][]) {
  laterPhases = phases;
  phaseGates = phases.map(() => new Promise<void>(resolve => { phaseReleases.push(resolve); }));
}

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/**
 * Starts a run, consumes its turn and lets the scripted (first-phase) messages flow.
 * The run promise is wrapped: returned bare from an async function it would be
 * adopted, and awaiting startRun() would then wait for the whole run to end.
 */
async function startRun(options: Record<string, unknown> = {}) {
  const run = sdk.queryClaudeSDK(PROMPT, { cwd: process.cwd(), ...options }, makeWs());
  await queryStarted;
  assert.ok(firstPrompt, 'the prompt read must start with query construction');
  await firstPrompt;
  releaseScriptedMessages();
  await scriptedMessagesConsumed;
  return { run };
}

const assistantToolUse = (name: string, input: Record<string, unknown>): SdkMessage => ({
  type: 'assistant',
  session_id: SID,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name, input }] },
});

const assistantText = (text: string): SdkMessage => ({
  type: 'assistant', session_id: SID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

const resultMsg: SdkMessage = {
  type: 'result', session_id: SID, subtype: 'success', is_error: false, result: 'ok',
};

// B-1120 fixtures — field shapes as emitted by CLI 2.1.269 (captured 2026-09-12).
const taskStarted = (taskId: string, isBackgrounded = true, taskType = 'local_agent'): SdkMessage => ({
  type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: 'tu_1',
  description: 'say ok', is_backgrounded: isBackgrounded, task_type: taskType, session_id: SID,
});
const taskUpdated = (taskId: string, status: string): SdkMessage => ({
  type: 'system', subtype: 'task_updated', task_id: taskId,
  patch: { status, end_time: 1789161207478 }, session_id: SID,
});
const taskNotification = (taskId: string, status = 'completed'): SdkMessage => ({
  type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: 'tu_1',
  status, output_file: '/var/tmp/x.output', summary: 'OK', session_id: SID,
});
const launchedToolResult: SdkMessage = {
  type: 'user', session_id: SID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1',
    content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
};
const systemInit: SdkMessage = { type: 'system', subtype: 'init', session_id: SID };

const backgroundTasksChanged: SdkMessage = {
  type: 'system', subtype: 'background_tasks_changed', session_id: SID,
};

/**
 * Redacted raw streams captured from CLI 2.1.269 (haiku, cwd under /var/tmp): ids,
 * paths, texts and tool results replaced, message shapes and order kept verbatim.
 */
const capture = JSON.parse(fs.readFileSync(
  new URL('./claude-sdk.control-stream.fixture.json', import.meta.url), 'utf8',
)) as { scenarios: Record<string, SdkMessage[]> };

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR', 'CLAUDE_SDK_INPUT_CLOSE_GRACE_MS', 'CLAUDE_SDK_BACKGROUND_HOLD_IDLE_MAX_MS',
  'CLAUDE_SDK_CONTINUATION_WAIT_MS',
] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmpConfigDir = '';
let logLines: string[] = [];
const originalLog = console.log;

/** The reason of this run's [CONTROL-STREAM-CLOSE] line, or null. */
const closeReason = () => {
  const line = logLines.find(l => l.startsWith('[CONTROL-STREAM-CLOSE]'));
  return line ? /reason=(\S+)/.exec(line)?.[1] ?? null : null;
};

beforeEach(() => {
  scriptedMessages = [];
  laterPhases = [];
  phaseGates = [];
  phaseReleases = [];
  lastQueryArg = null;
  promptIterator = null;
  firstPrompt = null;
  promptClosure = null;
  queryStarted = new Promise<void>(resolve => { resolveQueryStarted = resolve; });
  scriptedMessagesHeld = new Promise<void>(resolve => { releaseScriptedMessages = resolve; });
  scriptedMessagesConsumed = new Promise<void>(resolve => { resolveScriptedMessagesConsumed = resolve; });
  messageStreamHeld = new Promise<void>(resolve => { releaseMessageStream = resolve; });
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b117-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
  logLines = [];
  console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
});

afterEach(() => {
  console.log = originalLog;
  releaseScriptedMessages();
  for (const release of phaseReleases) release();
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
  await queryStarted;

  assert.notEqual(typeof lastQueryArg?.prompt, 'string', 'a string prompt re-arms isSingleUserTurn');
  assert.ok(promptIterator, 'the prompt must be an async iterable');
  assert.ok(firstPrompt, 'the prompt read must start with query construction');

  const first = await firstPrompt;
  assert.equal(first.done, false, 'the stream must carry the turn');
  const turn = first.value as { type: string; message: { role: string; content: unknown } };
  assert.equal(turn.type, 'user');
  assert.equal(turn.message.role, 'user');
  assert.equal(turn.message.content, PROMPT, 'the model must receive the same text as before');

  releaseScriptedMessages();
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
  await queryStarted;
  assert.ok(firstPrompt, 'the prompt read must start with query construction');
  await firstPrompt;                                 // consume the turn
  releaseScriptedMessages();

  assert.equal(await promptClosedWithin(500), true, 'input must close as soon as the run has nothing pending');
  releaseMessageStream();
  await run;
});

test('ADR-134 handle brackets the Claude SDK effect exactly once', async () => {
  scriptedMessages = [resultMsg];
  const trace: string[] = [];
  const run = sdk.queryClaudeSDK(PROMPT, {
    cwd: process.cwd(),
    permissionExecution: {
      consume: () => { trace.push('consume'); },
      markStarted: () => { trace.push('started'); },
      settle: (outcome: string) => { trace.push(`settle:${outcome}`); },
      notStarted: () => { trace.push('not-started'); },
    },
  }, makeWs());
  await queryStarted;
  releaseScriptedMessages();
  releaseMessageStream();
  await run;
  assert.deepEqual(trace, ['consume', 'started', 'settle:succeeded']);
});

test('a background agent keeps the channel open past the result, then closes on the grace', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '400';
  scriptedMessages = [
    assistantToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'x' }),  // background by default
    resultMsg,
  ];
  const run = sdk.queryClaudeSDK(PROMPT, { cwd: process.cwd() }, makeWs());
  await queryStarted;
  assert.ok(firstPrompt, 'the prompt read must start with query construction');
  await firstPrompt;
  releaseScriptedMessages();

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
  await queryStarted;
  assert.ok(firstPrompt, 'the prompt read must start with query construction');
  await firstPrompt;
  releaseScriptedMessages();

  assert.equal(await promptClosedWithin(150), false, 'a queued notification means a continuation is coming');
  assert.equal(await promptClosedWithin(1500), true, 'and the channel still closes afterwards');
  releaseMessageStream();
  await run;
});

test('aborting releases the input at once instead of waiting out the grace', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '600000';
  scriptedMessages = [assistantToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'x' })];
  const run = sdk.queryClaudeSDK(PROMPT, { sessionId: SID, cwd: process.cwd() }, makeWs());
  await queryStarted;
  assert.ok(firstPrompt, 'the prompt read must start with query construction');
  await firstPrompt;
  releaseScriptedMessages();
  await scriptedMessagesConsumed;

  const aborted = await sdk.abortClaudeSDKSession(SID);
  assert.equal(aborted.aborted, true, 'the session must be interruptable');
  assert.equal(await promptClosedWithin(500), true, 'stop must not wait for the grace');
  releaseMessageStream();
  await run;
});

// ── B-1120 ───────────────────────────────────────────────────────────────────

test('B-1120: a background agent that reports back long after the grace still finds the channel open', async () => {
  const GRACE = 100;
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = String(GRACE);
  scriptedMessages = [
    assistantToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'x', run_in_background: true }),
    taskStarted('t1'),
    launchedToolResult,
    assistantText('WAITING'),
    resultMsg,
  ];
  preparePhases([
    [
      taskNotification('t1'),
      { type: 'user', session_id: SID, parent_tool_use_id: null,
        message: { role: 'user', content: '<task-notification>\n<task-id>t1</task-id>' } },
      assistantToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'y', run_in_background: false }),
    ],
    [resultMsg],
  ]);
  const { run } = await startRun();

  assert.equal(await promptClosedWithin(6 * GRACE), false, 'a pending background task must hold the channel');
  assert.ok(logLines.some(l => l === `[CONTROL-STREAM-HOLD] session=${SID} pending=1`), 'the hold is logged');
  phaseReleases[0]();
  assert.equal(await promptClosedWithin(6 * GRACE), false, 'the re-entered turn is still running');
  phaseReleases[1]();
  assert.equal(await promptClosedWithin(GRACE + 400), true, 'and closes on the grace once it ends');
  assert.equal(closeReason(), 'grace-expired');
  releaseMessageStream();
  await run;
});

test('B-1120: a task that never reports back is released at the idle cap', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '100';
  process.env.CLAUDE_SDK_BACKGROUND_HOLD_IDLE_MAX_MS = '300';
  scriptedMessages = [
    assistantToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'x', run_in_background: true }),
    taskStarted('t1'),
    resultMsg,
  ];
  const { run } = await startRun();

  assert.equal(await promptClosedWithin(200), false, 'held past the grace');
  assert.equal(await promptClosedWithin(1000), true, 'but not past the idle cap');
  assert.equal(closeReason(), 'background-idle-cap');
  releaseMessageStream();
  await run;
});

test('B-1120: a notification for an unknown task does not extend an ordinary turn', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '600000';
  scriptedMessages = [assistantText('done'), taskNotification('ghost'), resultMsg];
  const { run } = await startRun();

  assert.equal(await promptClosedWithin(500), true, 'nothing pending → immediate close');
  assert.equal(closeReason(), 'result-immediate');
  releaseMessageStream();
  await run;
});

test('B-1120: a terminal task_updated ends a task like task_notification (non-terminal does not)', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '100';
  process.env.CLAUDE_SDK_BACKGROUND_HOLD_IDLE_MAX_MS = '600000';
  process.env.CLAUDE_SDK_CONTINUATION_WAIT_MS = '100';
  scriptedMessages = [
    assistantToolUse('Bash', { command: 'sleep 6; echo hi', run_in_background: true }),
    taskStarted('b1', true, 'local_bash'),
    resultMsg,
  ];
  preparePhases([[taskUpdated('b1', 'running')], [taskUpdated('b1', 'failed')]]);
  const { run } = await startRun();

  assert.equal(await promptClosedWithin(300), false, 'a running background Bash holds the channel');
  phaseReleases[0]();
  assert.equal(await promptClosedWithin(300), false, 'a non-terminal status does not end it');
  phaseReleases[1]();
  assert.equal(await promptClosedWithin(500), true, 'a terminal status ends it; the wait then closes');
  assert.equal(closeReason(), 'continuation-wait-expired');
  releaseMessageStream();
  await run;
});

test('B-1120: aborting with pending background tasks releases at once', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '600000';
  scriptedMessages = [
    assistantToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'x', run_in_background: true }),
    taskStarted('t1'),
    resultMsg,
  ];
  const { run } = await startRun({ sessionId: SID });

  const aborted = await sdk.abortClaudeSDKSession(SID);
  assert.equal(aborted.aborted, true, 'the session must be interruptable');
  assert.equal(await promptClosedWithin(500), true, 'stop must not wait for pending tasks');
  assert.equal(closeReason(), 'abort');
  releaseMessageStream();
  await run;
});

test('B-1120: init → assistant → result closes on the grace; a trailing system message does not hold it', async () => {
  const GRACE = 200;
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = String(GRACE);
  scriptedMessages = [
    assistantToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'x', run_in_background: true }),
    taskStarted('t1'),
    taskNotification('t1'),
    resultMsg,
  ];
  preparePhases([[systemInit, assistantText('DONE'), resultMsg, backgroundTasksChanged]]);
  const { run } = await startRun();

  await sleep(50);
  phaseReleases[0]();
  assert.equal(await promptClosedWithin(GRACE + 500), true, 'the grace is re-armed, never dropped');
  assert.equal(closeReason(), 'grace-expired');
  releaseMessageStream();
  await run;
});

test('B-1120: system/init starts the notification cycle — a model thinking past the grace keeps it open', async () => {
  const GRACE = 100;
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = String(GRACE);
  // Shorter than the wait below, so only init (not the continuation wait) can hold it.
  process.env.CLAUDE_SDK_CONTINUATION_WAIT_MS = '150';
  scriptedMessages = [
    assistantToolUse('Bash', { command: 'sleep 6; echo hi', run_in_background: true }),
    taskStarted('b1', true, 'local_bash'),
    resultMsg,
  ];
  preparePhases([
    [taskNotification('b1'), systemInit],
    [assistantToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'y', run_in_background: false }), resultMsg],
  ]);
  const { run } = await startRun();

  phaseReleases[0]();
  assert.equal(await promptClosedWithin(6 * GRACE), false, 'the cycle has started; nothing may close it yet');
  phaseReleases[1]();
  assert.equal(await promptClosedWithin(GRACE + 400), true, 'and it closes on the grace after its result');
  assert.equal(closeReason(), 'grace-expired');
  releaseMessageStream();
  await run;
});

test('B-1120: a task ending after the result waits for its cycle longer than the grace', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '100';
  process.env.CLAUDE_SDK_CONTINUATION_WAIT_MS = '400';
  scriptedMessages = [
    assistantToolUse('Bash', { command: 'sleep 6; echo hi', run_in_background: true }),
    taskStarted('b1', true, 'local_bash'),
    resultMsg,
  ];
  preparePhases([[taskUpdated('b1', 'completed'), taskNotification('b1')]]);
  const { run } = await startRun();

  phaseReleases[0]();
  assert.equal(await promptClosedWithin(250), false, 'held past the grace while the cycle is due');
  assert.equal(await promptClosedWithin(600), true, 'but not past the continuation wait');
  assert.equal(closeReason(), 'continuation-wait-expired');
  releaseMessageStream();
  await run;
});

test('B-1120: a background Bash that ends within the turn still holds the channel through the grace', async () => {
  const GRACE = 300;
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = String(GRACE);
  scriptedMessages = [
    assistantToolUse('Bash', { command: 'sleep 1; echo hi', run_in_background: true }),
    taskStarted('b1', true, 'local_bash'),
    launchedToolResult,
    taskUpdated('b1', 'completed'),
    taskNotification('b1'),
    assistantText('WAITING'),
    resultMsg,
  ];
  const { run } = await startRun();

  assert.equal(await promptClosedWithin(100), false, 'its notification may still arrive after the result');
  assert.equal(await promptClosedWithin(GRACE + 400), true, 'then the grace closes it');
  assert.equal(closeReason(), 'grace-expired');
  releaseMessageStream();
  await run;
});

for (const scenario of ['bgBash', 'bgAgent']) {
  test(`B-1120: replaying the captured CLI 2.1.269 stream (${scenario}) keeps the channel through its cycle`, async () => {
    const GRACE = 100;
    process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = String(GRACE);
    process.env.CLAUDE_SDK_CONTINUATION_WAIT_MS = '150';
    const stream = capture.scenarios[scenario];
    const firstResult = stream.findIndex(m => m.type === 'result');
    const cycleInit = stream.findIndex((m, i) => i > firstResult && m.type === 'system' && m.subtype === 'init');
    assert.ok(firstResult > 0 && cycleInit > firstResult, 'the capture must hold a notification cycle');
    assert.ok(!stream.slice(firstResult + 1, cycleInit + 1).some(m => m.type === 'user'),
      'measured: the cycle starts with system/init and no user message');
    scriptedMessages = stream.slice(0, firstResult + 1);
    preparePhases([stream.slice(firstResult + 1, cycleInit + 1), stream.slice(cycleInit + 1)]);
    const { run } = await startRun();

    phaseReleases[0]();
    assert.equal(await promptClosedWithin(6 * GRACE), false, 'open while the notification cycle runs');
    phaseReleases[1]();
    assert.equal(await promptClosedWithin(GRACE + 400), true, 'closed on the grace after its result');
    releaseMessageStream();
    await run;
  });
}
