#!/usr/bin/env node
/**
 * T-2094 test fixture: a fake Antigravity ACP agent (ndjson JSON-RPC on stdio).
 *
 * It behaves like `agy acp` where the adapter depends on it, and like the
 * worst case where it might differ: session/resume AND session/load both
 * REPLAY the whole history as session/update notifications before answering.
 * History lives in the agy brain layout under $HOME, so a killed process
 * resumes from disk exactly like a server restart.
 *
 * Prompt directives (substring of the prompt text) drive the edge cases:
 *   #crash  exit mid-turn          #hang         answer only to session/cancel
 *   #deaf   ignore session/cancel  #permission   ask a tool permission first
 *   #interaction  ask a question   #overflow     print a 17 MB line
 *   #fail   stderr Error: + JSON-RPC error
 * Env: FAKE_ACP_REQUIRE_AUTH=1 makes session calls need `authenticate` first;
 * FAKE_ACP_PROTOCOL overrides the protocolVersion; FAKE_ACP_NO_RESUME=1 makes
 * session/resume unsupported (forces the session/load fallback).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const HOME = process.env.HOME || '/nonexistent';
const BRAIN = path.join(HOME, '.gemini', 'antigravity-cli', 'brain');
const LOG = path.join(HOME, '.fake-acp.log');

if (process.argv.includes('--help')) {
  process.stdout.write('Usage: agy acp [flags]\n\nStart the Agent Client Protocol (ACP) stdio server\n');
  process.exit(0);
}

/** Appends one JSON line to the fixture log the tests read. */
function log(event) {
  fs.appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
}

log({ event: 'spawn', argv: process.argv.slice(2), home: HOME });

let authenticated = process.env.FAKE_ACP_REQUIRE_AUTH !== '1';
const pendingOut = new Map();
const cancelled = new Set();
let nextOutId = 1000;

const write = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const transcriptPath = (id) => path.join(BRAIN, id, '.system_generated', 'logs', 'transcript.jsonl');

function readSteps(id) {
  try {
    return fs.readFileSync(transcriptPath(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function appendStep(id, step) {
  const steps = readSteps(id);
  fs.appendFileSync(transcriptPath(id), `${JSON.stringify({ step_index: steps.length, ...step })}\n`);
}

function update(sessionId, upd) {
  write({ method: 'session/update', params: { sessionId, update: upd } });
}

/** The replay the adapter must hide: every past step re-sent as a notification. */
function replayHistory(sessionId) {
  for (const step of readSteps(sessionId)) {
    const kind = step.type === 'USER_INPUT' ? 'user_message_chunk' : 'agent_message_chunk';
    update(sessionId, { sessionUpdate: kind, content: { type: 'text', text: step.content } });
  }
}

function askClient(method, params) {
  const id = nextOutId++;
  write({ id, method, params });
  return new Promise((resolve) => pendingOut.set(id, resolve));
}

async function permissionText(sessionId, toolCallId) {
  const reply = await askClient('session/request_permission', {
    sessionId,
    toolCall: { toolCallId, title: 'fixture tool' },
    options: [
      { optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'opt-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const outcome = reply?.result?.outcome;
  return outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keeps "working" (a chunk every 100 ms) until cancelled — forever when `honour` is false. */
async function waitCancelled(sessionId, honour) {
  for (let i = 0; ; i += 1) {
    if (honour && cancelled.has(sessionId)) return;
    if (i % 5 === 4) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } });
    await sleep(20);
  }
}

async function prompt(id, params) {
  const { sessionId } = params;
  const text = params.prompt.map((b) => b.text).join('');
  cancelled.delete(sessionId);
  log({ event: 'prompt', sessionId, text });
  if (text.includes('#crash')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } });
    setTimeout(() => process.exit(3), 30);
    return;
  }
  if (text.includes('#overflow')) {
    process.stdout.write(`${'x'.repeat(17 * 1024 * 1024)}\n`);
    return;
  }
  if (text.includes('#fail')) {
    process.stderr.write('Error: fixture quota reached\n');
    write({ id, error: { code: -32603, message: 'fixture failure' } });
    return;
  }
  if (text.includes('#hang') || text.includes('#deaf')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
    await waitCancelled(sessionId, text.includes('#hang'));
    write({ id, result: { stopReason: 'cancelled' } });
    return;
  }
  let extra = '';
  if (text.includes('#permission')) extra = ` perm=${await permissionText(sessionId, 'tool_1')}`;
  if (text.includes('#interaction')) extra = ` ask=${await permissionText(sessionId, 'interaction_1')}`;
  const turnNo = readSteps(sessionId).filter((s) => s.type === 'USER_INPUT').length + 1;
  appendStep(sessionId, { source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: text });
  const reply = `reply ${turnNo}${extra}`;
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(0, 3) } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(3) } });
  appendStep(sessionId, { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: reply });
  write({ id, result: { stopReason: 'end_turn' } });
}

function needAuth(id) {
  if (authenticated) return false;
  write({ id, error: { code: -32000, message: 'Authentication required' } });
  return true;
}

const handlers = {
  initialize: (id) => write({ id, result: {
    protocolVersion: Number(process.env.FAKE_ACP_PROTOCOL || 1),
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, load: {}, close: {} } },
    authMethods: [{ id: 'oauth-personal' }, { id: 'gemini-api-key' }],
  } }),
  authenticate: (id, params) => { authenticated = true; log({ event: 'authenticate', methodId: params.methodId }); write({ id, result: {} }); },
  'session/new': (id, params) => {
    if (needAuth(id)) return;
    const sessionId = randomUUID();
    fs.mkdirSync(path.dirname(transcriptPath(sessionId)), { recursive: true });
    fs.writeFileSync(transcriptPath(sessionId), '');
    log({ event: 'new', sessionId, cwd: params.cwd });
    write({ id, result: { sessionId } });
  },
  'session/resume': (id, params) => {
    if (needAuth(id)) return;
    if (process.env.FAKE_ACP_NO_RESUME === '1') { write({ id, error: { code: -32601, message: 'Method not found' } }); return; }
    log({ event: 'resume', sessionId: params.sessionId });
    replayHistory(params.sessionId);
    write({ id, result: {} });
  },
  'session/load': (id, params) => {
    if (needAuth(id)) return;
    log({ event: 'load', sessionId: params.sessionId });
    replayHistory(params.sessionId);
    write({ id, result: null });
  },
  'session/set_model': (id, params) => { log({ event: 'set_model', modelId: params.modelId }); write({ id, result: {} }); },
  'session/prompt': (id, params) => { void prompt(id, params); },
  'session/cancel': (_id, params) => { log({ event: 'cancel', sessionId: params.sessionId }); cancelled.add(params.sessionId); },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === undefined && pendingOut.has(msg.id)) {
    pendingOut.get(msg.id)(msg);
    pendingOut.delete(msg.id);
    return;
  }
  const handler = handlers[msg.method];
  if (handler) handler(msg.id, msg.params || {});
  else if (msg.id !== undefined) write({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
rl.on('close', () => process.exit(0));
