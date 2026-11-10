/**
 * fake-dsh-acp-agent — test-only stand-in for `dsh … acp` (T-2086, ADR-224).
 *
 * Speaks ACP (protocolVersion 1, ndjson over stdio) with the message shapes
 * recorded from real @deepseek-ai/dsh@0.2.2-rc.1 (fixtures/dsh-acp-recording.json):
 * initialize, session/new, session/resume, session/set_config_option,
 * session/prompt (agent_message_chunk streaming, tool_call, request_permission
 * allow-once / reject-once, tool_call_update), session/cancel and session/close.
 * Like real dsh it has NO session/load and persists sessions under
 * <DSH_HOME>/sessions, so a resume in a new process sees earlier turns.
 *
 * Instead of calling an LLM it writes what dsh WOULD send (the outbound
 * /v1/messages request: model, messages, upload fields, origin, key) to the
 * launch directory, composing patch layers like real dsh (dsh-patch-layer.mjs).
 *
 * Launched through a generated shim (see dsh-acceptance.test.ts) that sets
 * `globalThis.__DSH_FAKE__ = { launchDir }` — never via an environment variable,
 * because the spawn environment is itself under test.
 *
 * The Nassaj policy plugin is emulated on fd 3 (T-2089 S5) with the REAL plugin's
 * canonical hash: a hello carrying the live inventory and tool set recorded under the
 * Nassaj layer (permission-parity fixtures/dsh-policy-tools.json, or a hostile one from
 * <launchDir>/hello-override.json), then one `pre` per tool call; only an allow runs it.
 *
 * Prompt directives (test vocabulary, not dsh's):
 *   `[escalate] <abs path>` — the model calls `write` outside the workspace; Nassaj decides
 *     (in Claude's default mode that is a member card).
 *   `[slow]` — the reply is held ~800 ms (busy / disconnect races).
 *   `[grandchild]` — leaves a `sleep 60` in dsh's process group (cleanup test).
 *   `[malformed-args]` — fails the turn as real dsh does when the model streams invalid
 *     tool JSON (-32603, recorded T-2089 S0).
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { composeDshLayers, readPatchLayer } from './dsh-patch-layer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const recording = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'dsh-acp-recording.json'), 'utf8'));
const firstRun = recording.runs[0].traffic.map((row) => row.msg);
const INIT_RESULT = firstRun.find((m) => m.id === 1 && m.result).result;
const CONFIG_OPTIONS = firstRun.find((m) => m.id === 2 && m.result).result.configOptions;
const REJECTED_TEXT = firstRun.find((m) => m.params?.update?.status === 'failed')
  .params.update.content[0].content.text;

const { launchDir } = globalThis.__DSH_FAKE__ ?? {};
/** A test may plant a hostile hello (handshake refusal) in <launchDir>/hello-override.json. */
const helloOverride = (() => { try { return JSON.parse(fs.readFileSync(path.join(launchDir, 'hello-override.json'), 'utf8')); } catch { return null; } })();
if (!launchDir) throw new Error('fake dsh: launched without the test shim');
fs.mkdirSync(launchDir, { recursive: true });
const launchId = `${process.pid}-${Date.now()}`;
const record = (kind, value) => fs.appendFileSync(path.join(launchDir, `${kind}.jsonl`),
  `${JSON.stringify({ launchId, ...value })}\n`);

// `--dump-config` (T-2091 DSH_PATH semantic check): the composed rows of the --patch layers.
if (process.argv.includes('--dump-config')) {
  const patchFiles = process.argv.slice(2).flatMap((arg, k, all) => (arg === '--patch' ? [all[k + 1]] : []));
  // Inserted rows are dedented to the top level, as dsh composes them.
  const rows = patchFiles.map((file) => {
    let inserting = false;
    return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      if (/^- insert:/.test(line)) { inserting = true; return []; }
      if (/^\S/.test(line)) inserting = false;
      return [inserting && line.startsWith('    ') ? line.slice(4) : line];
    }).join('\n');
  });
  record('dump-config', { patches: patchFiles });
  process.stdout.write(`# == fake dsh --dump-config\n${rows.join('\n')}\n`);
  process.exit(0);
}
// ---- launch facts -------------------------------------------------------------
const argv = process.argv.slice(2);
const resolvable = (command) => (process.env.PATH ?? '').split(':').filter(Boolean)
  .some((dir) => { try { fs.accessSync(path.join(dir, command), fs.constants.X_OK); return true; } catch { return false; } });
record('launches', {
  argv, cwd: process.cwd(), env: { ...process.env },
  resolvable: Object.fromEntries(['claude', 'codex'].map((c) => [c, resolvable(c)])),
});

const dshHome = process.env.DSH_HOME || path.join(process.env.HOME ?? '/nonexistent', '.dsh');
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const profile = flag('--profile') ?? (argv[0] && !argv[0].startsWith('-') ? argv[0] : 'acp');
const profileDir = path.join(dshHome, 'profiles', profile);
if (flag('--from-default-profile')) {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n');
}
const patches = argv.flatMap((arg, i) => (arg === '--patch' ? [argv[i + 1]] : []));
const composed = composeDshLayers(
  [readPatchLayer(path.join(profileDir, 'cordis.patch.yml')), ...patches.map(readPatchLayer)],
  process.env,
);

// ---- policy plugin emulation (fd 3) -------------------------------------------
const policyTools = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', '..', '..', 'services', 'permission-parity',
  '__tests__', 'fixtures', 'dsh-policy-tools.json'), 'utf8'));
const plugin = await import(pathToFileURL(path.join(here, '..', '..', '..', '..', '..', 'governance', 'dsh-policy-plugin', 'index.mjs')).href);
let policy = null;
try {
  const socket = new net.Socket({ fd: 3, readable: true, writable: true });
  const pendingPolicy = new Map();
  let policyBuffer = '';
  let policyId = 0;
  socket.on('data', (chunk) => {
    policyBuffer += chunk;
    for (let at = policyBuffer.indexOf('\n'); at >= 0; at = policyBuffer.indexOf('\n')) {
      const reply = JSON.parse(policyBuffer.slice(0, at));
      policyBuffer = policyBuffer.slice(at + 1);
      pendingPolicy.get(reply.id)?.(reply);
      pendingPolicy.delete(reply.id);
    }
  });
  socket.on('error', () => {});
  socket.unref();
  policy = (frame) => new Promise((resolve) => {
    const id = (policyId += 1);
    pendingPolicy.set(id, resolve);
    socket.write(`${JSON.stringify({ ...frame, id })}\n`);
  });
  void policy(helloOverride ?? { type: 'hello', protocol: 2, probes: { P1: { ok: true }, P2: { ok: true }, P3: { ok: true } },
    tools: policyTools.tools.map((tool) => ({ name: tool.name, schema: tool.input_schema, schemaIssues: [] })) });
} catch {
  policy = null; // no fd 3: Nassaj never decided anything, so no tool may run
}

/** Asks Nassaj about one call, as the plugin's pre-execute does; true only on allow. */
async function decided(s, toolCallId, name, args) {
  if (!policy) return false;
  const hash = plugin.argumentHash(plugin.canonicalJson(args));
  const reply = await policy({ type: 'pre', callId: toolCallId, tool: name, args, hash, agent: { id: s.id, type: null } });
  record('permissions', { sessionId: s.id, toolCallId, target: args.file_path ?? null, decision: reply?.decision ?? null });
  return reply?.decision === 'allow';
}

// ---- session store (persisted, like dsh-session-persistence-jsonl) ------------
const sessionsDir = path.join(dshHome, 'sessions');
const sessionFile = (id) => path.join(sessionsDir, `${id.replace(/[^0-9a-f-]/g, '')}.json`);
const save = (s) => { fs.mkdirSync(sessionsDir, { recursive: true }); fs.writeFileSync(sessionFile(s.id), JSON.stringify(s)); };
const load = (id) => { try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); } catch { return null; } };
const live = new Map();
const configOptions = (s) => CONFIG_OPTIONS.map((o) => (o.id === 'model'
  ? { ...o, currentValue: JSON.stringify(['deepseek-official', s.model]) } : o));

// ---- wire --------------------------------------------------------------------
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (sessionId, update) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
const fail = (code, message) => { const e = new Error(message); e.rpc = { code, message }; throw e; };
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function sendLlmRequest(s) {
  const bodyKeys = ['model', 'stream', 'messages', 'max_tokens', 'thinking', 'output_config', 'system', 'tools'];
  if (composed.sessionLog) bodyKeys.push('dsh_session_log');
  if (composed.pluginPackages) bodyKeys.push('dsh_plugin_packages');
  record('llm-requests', {
    sessionId: s.id, origin: composed.baseURL, telemetryExport: composed.telemetry, reasoningEffort: s.reasoningEffort ?? null,
    headers: { 'x-api-key': process.env.DEEPSEEK_API_KEY ?? null }, model: s.model, bodyKeys,
    messages: structuredClone(s.messages),
  });
}

async function escalate(s, target) {
  const toolCallId = `toolu_fake_${crypto.randomUUID().slice(0, 8)}`;
  const rawInput = { file_path: target, content: 'written by fake dsh' };
  s.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: toolCallId, name: 'write', input: rawInput }] });
  notify(s.id, { sessionUpdate: 'tool_call', toolCallId, title: 'write', kind: 'other', status: 'in_progress', rawInput });
  const allowed = await decided(s, toolCallId, 'write', rawInput);
  if (allowed) fs.writeFileSync(target, 'written by fake dsh');
  if (policy) await policy({ type: 'post', callId: toolCallId, tool: 'write', hash: plugin.argumentHash(plugin.canonicalJson(rawInput)),
    isError: !allowed, bodyRan: allowed, agent: { id: s.id, type: null }, output: '' });
  const text = allowed ? `<path>${target}</path>\n<type>file</type>\n<content>\nCreated file\n</content>` : REJECTED_TEXT;
  notify(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed',
    content: [{ type: 'content', content: { type: 'text', text } }] });
  s.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCallId, content: text }] });
  sendLlmRequest(s);
  return 'Tool step finished.';
}

async function prompt(params) {
  const s = live.get(params.sessionId) ?? fail(-32602, `unknown session: ${params.sessionId}`);
  if (s.inFlight) fail(-32603, 'a prompt is already running for this session');
  const controller = new AbortController();
  s.inFlight = controller;
  try {
    const text = (params.prompt ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    s.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    sendLlmRequest(s);
    if (text.includes('[slow]')) await sleep(800, controller.signal);
    if (controller.signal.aborted) return { stopReason: 'cancelled' };
    if (text.includes('[malformed-args]')) fail(-32603, 'Internal error: turn failed: DeepSeek Messages stream: tool input is invalid JSON');
    if (text.includes('[grandchild]')) {
      // A process left in dsh's group after the turn (a backgrounded bash job).
      const orphan = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
      orphan.unref();
      record('grandchildren', { pid: orphan.pid });
    }
    const target = /\[escalate\]\s+(\S+)/.exec(text)?.[1];
    const reply = target ? await escalate(s, target) : `Hello from fake DeepSeek: ${text.slice(0, 40)}`;
    const messageId = crypto.randomUUID();
    const half = Math.ceil(reply.length / 2);
    for (const part of [reply.slice(0, half), reply.slice(half)]) {
      notify(s.id, { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: part } });
    }
    s.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
    notify(s.id, { sessionUpdate: 'usage_update', used: 5612, size: 1048576 });
    return { stopReason: 'end_turn' };
  } finally {
    s.inFlight = null;
    save({ id: s.id, cwd: s.cwd, model: s.model, messages: s.messages });
  }
}

const handlers = {
  initialize: () => INIT_RESULT,
  'session/new': (p) => {
    const s = { id: crypto.randomUUID(), cwd: p.cwd, model: 'deepseek-v4-flash', messages: [] };
    live.set(s.id, s);
    save(s);
    return { sessionId: s.id, configOptions: configOptions(s) };
  },
  'session/resume': (p) => {
    if (live.has(p.sessionId)) fail(-32602, `session is already active: ${p.sessionId}`);
    const s = load(p.sessionId) ?? fail(-32602, `session is not resumable: ${p.sessionId}`);
    if (s.cwd !== p.cwd) fail(-32602, `session cwd does not match: ${p.cwd}`);
    live.set(s.id, s);
    return { configOptions: configOptions(s) };
  },
  'session/set_config_option': (p) => {
    const s = live.get(p.sessionId) ?? fail(-32602, `unknown session: ${p.sessionId}`);
    const option = CONFIG_OPTIONS.find((o) => o.id === p.configId) ?? fail(-32602, `unknown config option: ${p.configId}`);
    const offered = (option.options ?? []).flatMap((o) => (o.options ? o.options : [o])).map((o) => o.value);
    if (!offered.includes(p.value)) fail(-32602, `value not offered for ${p.configId}: ${p.value}`);
    if (p.configId === 'model') s.model = JSON.parse(p.value)[1];
    else s.reasoningEffort = p.value;
    save(s);
    return { configOptions: configOptions(s) };
  },
  'session/prompt': prompt,
  'session/close': (p) => { live.delete(p.sessionId); return {}; },
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  record('traffic', { msg });
  if (msg.method === undefined) return;
  if (msg.method === 'session/cancel') { live.get(msg.params?.sessionId)?.inFlight?.abort(); return; }
  const handler = handlers[msg.method];
  if (!handler) {
    if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    return;
  }
  try {
    write({ jsonrpc: '2.0', id: msg.id, result: await handler(msg.params ?? {}) });
  } catch (error) {
    write({ jsonrpc: '2.0', id: msg.id, error: error.rpc ?? { code: -32603, message: String(error?.message ?? error) } });
  }
}).on('close', () => {
  // No self-answer for a pending permission: only Nassaj's reply counts (scenario 2).
  setTimeout(() => process.exit(0), 50);
});
