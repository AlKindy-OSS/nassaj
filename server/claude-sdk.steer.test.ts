/**
 * claude-sdk.steer.test.ts — T-1903 end to end through the real Claude runner
 * (SDK mocked, database real): a steerable run arms the taint hook and
 * announces its turn; an injection is yielded by the SAME prompt generator
 * with our uuid; a `result` does not close the input while an injection is
 * queued; a second `result` settles it and the usage of both is aggregated;
 * abort drains the queue; after release nothing is accepted; the taint hook
 * asks only the starter even in bypassPermissions; the no-hook retry path and
 * consent-off runs cannot be steered.
 *
 * Runner: node:test with --experimental-test-module-mocks (SDK mock registered
 * before the dynamic import of the module under test).
 */
// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, mock } from 'node:test';

type SdkMessage = Record<string, unknown>;

let scripted: SdkMessage[] = [];
let phases: SdkMessage[][] = [];
let gates: Array<() => void> = [];
let gatePromises: Promise<void>[] = [];
let lastOptions: Record<string, any> | null = null;
let promptIterator: AsyncIterator<any> | null = null;
let queryStarted: Promise<void> = Promise.resolve();
let resolveQueryStarted = () => {};
let scriptedDone: Promise<void> = Promise.resolve();
let resolveScriptedDone = () => {};
let releaseStream = () => {};
let streamHeld: Promise<void> = Promise.resolve();
let throwWhenHooks = false;

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: { prompt: AsyncIterable<unknown>; options: Record<string, any> }) => {
      if (throwWhenHooks && arg.options.hooks) throw new Error('hooks unsupported');
      lastOptions = arg.options;
      promptIterator = arg.prompt[Symbol.asyncIterator]();
      void promptIterator.next();
      resolveQueryStarted();
      const [messages, later, waits] = [scripted, phases, gatePromises];
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
          resolveScriptedDone();
          for (const [i, phase] of later.entries()) { await waits[i]; for (const m of phase) yield m; }
          await streamHeld;
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

const { initializeDatabase } = await import('./modules/database/init-db.js');
const { closeConnection, getConnection } = await import('./modules/database/connection.js');
const steer = await import('./modules/session-steer/index.js');
const sdk = (await import('./claude-sdk.js')) as unknown as Record<string, any>;
const { __resetSteerRateLimitForTests } = await import('./modules/session-steer/steer-service.js');

const SID = 'steer-run-session-0001';
const init: SdkMessage = { type: 'system', subtype: 'init', session_id: SID };
const text = (t: string): SdkMessage => ({ type: 'assistant', session_id: SID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const result = (cost: number, input: number): SdkMessage => ({ type: 'result', session_id: SID, subtype: 'success',
  is_error: false, result: 'ok', total_cost_usd: cost, usage: { input_tokens: input, output_tokens: 1 } });

let sent: Array<Record<string, any>> = [];
let rawSent: Array<Record<string, any>> = [];
let logs: string[] = [];
const originalLog = console.log;
let tmp = '';

function makeWs(userId = 1) {
  const raw = { readyState: 1, send: (s: string) => { rawSent.push(JSON.parse(s)); }, once: () => {}, off: () => {} };
  return { userId, ws: raw, send: (p: Record<string, any>) => { sent.push(p); },
    isPrimarySocketAlive: () => raw.readyState === 1 };
}

function prepare(phaseList: SdkMessage[][]) {
  phases = phaseList;
  gates = []; gatePromises = phaseList.map(() => new Promise<void>(r => { gates.push(r); }));
}

async function startRun(options: Record<string, unknown> = {}, userId = 1) {
  const ws = makeWs(userId);
  const run = sdk.queryClaudeSDK('start the work', { cwd: tmp, sessionId: SID, permissionMode: 'bypassPermissions', ...options }, ws);
  await queryStarted;
  await scriptedDone;
  return { run, ws };
}

const steerCtx = (senderUserId: number) => ({
  senderUserId, isWritable: () => true, getSessionProvider: () => 'claude', getDisplayName: () => 'bob',
});
const turnState = () => sent.find(p => p.type === 'steer-turn-state');
const closeReason = () => /reason=(\S+)/u.exec(logs.find(l => l.startsWith('[CONTROL-STREAM-CLOSE]')) ?? '')?.[1] ?? null;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP || os.tmpdir(), 'steer-run-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '40';
  process.env.CLAUDE_STEER_APPROVAL_TIMEOUT_MS = '80';
  process.env.CLAUDE_SDK_BACKGROUND_HOLD_IDLE_MAX_MS = '5000';
  closeConnection();
  process.env.DATABASE_PATH = path.join(tmp, 'auth.db');
  await initializeDatabase();
  const db = getConnection();
  for (const [id, name] of [[1, 'alice'], [2, 'bob']] as const) {
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'h', 'user')").run(id, name);
  }
  steer.setSteerConsent(1, { allowSteerOnMyRuns: true });
  __resetSteerRateLimitForTests();
  scripted = [init, text('working')]; prepare([]);
  sent = []; rawSent = []; logs = []; throwWhenHooks = false; lastOptions = null;
  queryStarted = new Promise<void>(r => { resolveQueryStarted = r; });
  scriptedDone = new Promise<void>(r => { resolveScriptedDone = r; });
  streamHeld = new Promise<void>(r => { releaseStream = r; });
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
});

afterEach(async () => {
  console.log = originalLog;
  releaseStream();
  for (const g of gates) g();
  await sleep(20);
  closeConnection();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('armed run: hook registered, turn announced, injection yielded by the same generator with our uuid', async () => {
  prepare([[result(0.1, 10)], [text('adjusted'), result(0.3, 7)]]);
  const { run } = await startRun();
  const hookEntry = lastOptions!.hooks.PreToolUse.at(-1);
  assert.equal(hookEntry.matcher, steer.STEER_TAINT_MATCHER);
  const state = turnState();
  assert.deepEqual([state?.sessionId, state?.starterUserId, state?.steerable, state?.starterSteerable], [SID, 1, true, true]);
  const verdict = steer.handleSessionSteer({ sessionId: SID, turnId: state!.turnId, clientMsgId: 'm-1', text: 'use tabs' }, steerCtx(2));
  assert.deepEqual([verdict.ok, verdict.status], [true, 202]);
  assert.ok(sent.some(p => p.type === 'steer-queued' && p.sender.userId === 2 && p.text === 'use tabs'));

  gates[0]();
  await sleep(60);
  assert.equal(closeReason(), null, 'a result must not close the input while an injection is queued');

  const next = await promptIterator!.next();
  const row = getConnection().prepare('SELECT claude_user_uuid AS uuid FROM message_coordination_ingress WHERE client_msg_id = ?').get('m-1') as { uuid: string };
  assert.equal(next.value.uuid, row.uuid);
  assert.equal(next.value.message.content, '<nassaj-steer from="bob" role="member">\nuse tabs\n</nassaj-steer>');

  gates[1]();
  await sleep(120);
  assert.equal(closeReason(), 'grace-expired', 'settled by the 2nd result, then the normal grace applies');
  releaseStream();
  await run;
  const complete = sent.find(p => p.kind === 'complete');
  assert.equal(complete.runUsage.results, 2);
  assert.equal(complete.runUsage.totalCostUsd, 0.3);
  assert.equal(complete.runUsage.usage.input_tokens, 17);
});

test('M1: the taint hook carries a CLI timeout longer than the approval wait; matcher covers every tool', async () => {
  const { run } = await startRun();
  const entry = lastOptions!.hooks.PreToolUse.at(-1);
  assert.equal(entry.matcher, '.*');
  assert.ok(Number.isFinite(entry.timeout) && entry.timeout * 1000 > 80, `hook timeout ${entry.timeout}s`);
  process.env.CLAUDE_STEER_APPROVAL_TIMEOUT_MS = '600000';
  assert.ok(steer.steerHookTimeoutSeconds(600000) * 1000 > 600000);
  process.env.CLAUDE_STEER_APPROVAL_TIMEOUT_MS = '80';
  releaseStream();
  await run;
});

test('M2: a steer arriving while the close timer is armed swaps it for the steer hold', async () => {
  process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS = '150';
  prepare([[result(0.1, 1)], [text('ok'), result(0.2, 1)]]);
  const { run } = await startRun();
  const turnId = turnState()!.turnId;
  steer.handleSessionSteer({ sessionId: SID, turnId, clientMsgId: 'r-1', text: 'first' }, steerCtx(2));
  gates[0]();
  await promptIterator!.next();
  gates[1]();
  await sleep(30);
  assert.equal(closeReason(), null, 'grace armed, not yet expired');
  steer.handleSessionSteer({ sessionId: SID, turnId, clientMsgId: 'r-2', text: 'second' }, steerCtx(2));
  await sleep(300);
  assert.equal(closeReason(), null, 'the armed grace was replaced by the steer hold');
  const next = await promptIterator!.next();
  assert.match(next.value.message.content, /second/u, 'the late steer is still delivered');
  releaseStream();
  await run;
});

test('after input release every injection is refused (409 turn_not_active)', async () => {
  prepare([[result(0.1, 1)]]);
  const { run } = await startRun();
  const turnId = turnState()!.turnId;
  gates[0]();
  await sleep(60);
  assert.equal(closeReason(), 'result-immediate');
  const verdict = steer.handleSessionSteer({ sessionId: SID, turnId, clientMsgId: 'late-1', text: 'too late' }, steerCtx(2));
  assert.deepEqual([verdict.code, verdict.status], ['turn_not_active', 409]);
  releaseStream();
  await run;
});

test('abort drains the queue: queued senders get steer-rejected turn_aborted', async () => {
  const { run } = await startRun();
  const turnId = turnState()!.turnId;
  steer.handleSessionSteer({ sessionId: SID, turnId, clientMsgId: 'a-1', text: 'one' }, steerCtx(2));
  await sdk.abortClaudeSDKSession(SID);
  const rejected = sent.find(p => p.type === 'steer-rejected');
  assert.deepEqual([rejected?.clientMsgId, rejected?.reason], ['a-1', 'turn_aborted']);
  const status = getConnection().prepare('SELECT delivery_status FROM message_coordination_ingress WHERE client_msg_id = ?').get('a-1');
  assert.deepEqual(status, { delivery_status: 'rejected' });
  releaseStream();
  await run;
});

test('taint gate in bypassPermissions: only the starter can approve; others, timeout and offline deny', async () => {
  const { run, ws } = await startRun();
  const hook = lastOptions!.hooks.PreToolUse.at(-1).hooks[0];
  assert.deepEqual(await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }), {}, 'inert before any steer');
  steer.handleSessionSteer({ sessionId: SID, turnId: turnState()!.turnId, clientMsgId: 't-1', text: 'rm it' }, steerCtx(2));

  const approved = hook({ tool_name: 'Bash', tool_input: { command: 'python -c "import os"' } });
  await sleep(5);
  const prompt = rawSent.find(p => p.kind === 'permission_request');
  assert.equal(prompt?.steerTainted, true);
  assert.equal(sent.some(p => p.kind === 'permission_request'), false, 'never fanned out through the writer');
  assert.equal(sdk.getPendingApprovalsForSession(SID).length, 0, 'never re-listed to mirrors');
  assert.equal(sdk.resolveToolApproval(prompt.requestId, { allow: true, requesterUserId: 2 }).resolved, false,
    'the steering member cannot approve');
  assert.equal(sdk.resolveToolApproval(prompt.requestId, { allow: true, requesterUserId: 1 }).resolved, true);
  assert.deepEqual(await approved, {});

  const timedOut = await hook({ tool_name: 'Write', tool_input: {} });
  assert.equal(timedOut.hookSpecificOutput.permissionDecision, 'deny');
  const agent = await hook({ tool_name: 'Agent', tool_input: {} });
  assert.equal(agent.hookSpecificOutput.permissionDecision, 'deny');
  ws.ws.readyState = 3;
  const offline = await hook({ tool_name: 'Edit', tool_input: {} });
  assert.equal(offline.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await hook({ tool_name: 'Read', tool_input: {} }), {});
  releaseStream();
  await run;
});

test('no-hook retry path: others cannot steer (409 steer_unavailable); the starter still can', async () => {
  throwWhenHooks = true;
  const { run } = await startRun();
  assert.equal(lastOptions!.hooks, undefined);
  const state = turnState();
  assert.deepEqual([state?.steerable, state?.starterSteerable], [false, true]);
  const verdict = steer.handleSessionSteer({ sessionId: SID, turnId: state!.turnId, clientMsgId: 'n-1', text: 'x' }, steerCtx(2));
  assert.deepEqual([verdict.code, verdict.status], ['steer_unavailable', 409]);
  assert.equal(steer.handleSessionSteer({ sessionId: SID, turnId: state!.turnId, clientMsgId: 'n-2', text: 'x' }, steerCtx(1)).ok,
    true);
  releaseStream();
  await run;
});

test('consent off at start: NO taint hook, yet the starter self-steers and it is delivered', async () => {
  steer.setSteerConsent(1, { allowSteerOnMyRuns: false });
  prepare([[result(0.1, 1)], [text('ok'), result(0.2, 1)]]);
  const { run } = await startRun();
  const matchers = (lastOptions!.hooks.PreToolUse ?? []).map((h: { matcher: string }) => h.matcher);
  assert.ok(!matchers.includes(steer.STEER_TAINT_MATCHER), 'no .* callback hook without consent (B-503)');
  const state = turnState();
  assert.deepEqual([state?.starterUserId, state?.steerable, state?.starterSteerable], [1, false, true],
    'the broadcast never offers others a steer the starter did not consent to');
  const other = steer.handleSessionSteer({ sessionId: SID, turnId: state!.turnId, clientMsgId: 'c-1', text: 'x' }, steerCtx(2));
  assert.deepEqual([other.code, other.status], ['steer_not_consented', 403]);
  steer.setSteerConsent(1, { allowSteerOnMyRuns: true });
  const late = steer.handleSessionSteer({ sessionId: SID, turnId: state!.turnId, clientMsgId: 'c-3', text: 'x' }, steerCtx(2));
  assert.deepEqual([late.code, late.status], ['steer_unavailable', 409], 'consent after start: still no gate, refused');
  const own = steer.handleSessionSteer({ sessionId: SID, turnId: state!.turnId, clientMsgId: 'c-2', text: 'use tabs' }, steerCtx(1));
  assert.deepEqual([own.ok, own.status], [true, 202]);
  gates[0]();
  const next = await promptIterator!.next();
  assert.equal(next.value.message.content, '<nassaj-steer from="bob" role="owner">\nuse tabs\n</nassaj-steer>');
  const row = getConnection().prepare('SELECT claude_user_uuid AS uuid FROM message_coordination_ingress WHERE client_msg_id = ?').get('c-2') as { uuid: string };
  assert.equal(next.value.uuid, row.uuid, 'delivered to the CLI by the same generator with our uuid');
  gates[1]();
  assert.equal(rawSent.some(p => p.kind === 'permission_request'), false, 'the starter was never asked');
  releaseStream();
  await run;
});

test('self-steer with consent on: no taint; a later steer by another member taints as before', async () => {
  const { run } = await startRun();
  const hook = lastOptions!.hooks.PreToolUse.at(-1).hooks[0];
  const turnId = turnState()!.turnId;
  assert.equal(turnState()!.starterSteerable, true);
  assert.equal(steer.handleSessionSteer({ sessionId: SID, turnId, clientMsgId: 'x-1', text: 'a' }, steerCtx(1)).ok, true);
  assert.deepEqual(await hook({ tool_name: 'Write', tool_input: {} }), {}, 'self-steer: gate stays inert');
  assert.equal(steer.handleSessionSteer({ sessionId: SID, turnId, clientMsgId: 'x-2', text: 'b' }, steerCtx(2)).ok, true);
  const gated = hook({ tool_name: 'Write', tool_input: {} });
  await sleep(5);
  assert.equal(rawSent.filter(p => p.kind === 'permission_request').length, 1, 'the starter is asked now');
  assert.equal((await gated).hookSpecificOutput.permissionDecision, 'deny', 'unanswered → timeout deny');
  releaseStream();
  await run;
});

test('policy off: no arming at all; the starter himself cannot steer', async () => {
  steer.setSteerPolicy({ mode: 'off' }, 1);
  const { run } = await startRun();
  const matchers = (lastOptions!.hooks.PreToolUse ?? []).map((h: { matcher: string }) => h.matcher);
  assert.ok(!matchers.includes(steer.STEER_TAINT_MATCHER));
  assert.equal(turnState(), undefined);
  const verdict = steer.handleSessionSteer({ sessionId: SID, turnId: '71111111-2222-4333-8444-555555555555',
    clientMsgId: 'p-1', text: 'x' }, steerCtx(1));
  assert.equal(verdict.code, 'steer_unavailable');
  releaseStream();
  await run;
});

test('plan mode is refused and never armed', async () => {
  const { run } = await startRun({ permissionMode: 'default' });
  const turnId = turnState()!.turnId;
  assert.equal(steer.handleSessionSteer({ sessionId: SID, turnId, clientMsgId: 's-1', text: 'x' }, steerCtx(1)).ok, true,
    'the starter may steer his own non-plan turn');
  releaseStream();
  await run;
  const planned = await (async () => {
    scriptedDone = new Promise<void>(r => { resolveScriptedDone = r; });
    queryStarted = new Promise<void>(r => { resolveQueryStarted = r; });
    streamHeld = new Promise<void>(r => { releaseStream = r; });
    sent = [];
    return startRun({ permissionMode: 'plan' });
  })();
  assert.equal(turnState(), undefined, 'a plan-mode run is never armed');
  releaseStream();
  await planned.run;
});

test('E2E: a steer-born approval is allow-once — remember rules and edited input are dropped', async () => {
  const { run } = await startRun();
  const hook = lastOptions!.hooks.PreToolUse.at(-1).hooks[0];
  steer.handleSessionSteer({ sessionId: SID, turnId: turnState()!.turnId, clientMsgId: 'o-1', text: 'go' }, steerCtx(2));
  const first = hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  await sleep(5);
  const prompt = rawSent.filter(p => p.kind === 'permission_request').at(-1);
  assert.equal(sdk.resolveToolApproval(prompt.requestId, { allow: true, requesterUserId: 1,
    rememberEntry: 'Bash', updatedInput: { command: 'rm -rf /' } }).resolved, true);
  assert.deepEqual(await first, {}, 'allowed once');
  assert.ok(!(lastOptions!.allowedTools ?? []).includes('Bash'), 'no permanent rule was stored');
  const second = hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  await sleep(5);
  assert.equal(rawSent.filter(p => p.kind === 'permission_request').length, 2, 'the next call asks again');
  assert.equal((await second).hookSpecificOutput.permissionDecision, 'deny', 'unanswered → timeout deny');
  releaseStream();
  await run;
});

test('a "/steer" chat message on a busy session gets a steer-specific refusal, not session_busy', async () => {
  const { run } = await startRun();
  const ws = makeWs(2);
  await sdk.queryClaudeSDK('/steer use tabs', { cwd: tmp, sessionId: SID }, ws);
  const refusal = sent.filter(p => p.kind === 'error').at(-1);
  assert.deepEqual([refusal?.code, refusal?.notStarted], ['steer_requires_session_steer', true]);
  await sdk.queryClaudeSDK('hello', { cwd: tmp, sessionId: SID }, ws);
  assert.equal(sent.filter(p => p.kind === 'error').at(-1)?.code, 'session_busy', 'ordinary text unchanged');
  releaseStream();
  await run;
});
