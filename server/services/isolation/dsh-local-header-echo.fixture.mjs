/**
 * Header-echo harness of the DSH local-engine proof (ADR-227 "DSH local corrector",
 * T-2108). Runs under tsx INSIDE a loopback-only network namespace (every
 * destination routes to `lo`, a recorder logs each connect and DNS attempt).
 *
 * Reads a JSON spec from argv[2]:
 *   { dshBin, cwd, home, work, echoPort, serverKey: string|null, model, dummies: string[] }
 * Starts "my local model server" (an Anthropic Messages echo on 127.0.0.1:echoPort
 * that streams llama.cpp's shape: tool_use block starts WITHOUT `input`), then runs
 * the production sequence of a local DSH turn: the verified shipped layer and policy
 * plugin, openDshLocalTurn (corrector, generated layer, exact env with the token,
 * the DSH_PATH semantic dump-config check against the real dsh), the real dsh `acp`
 * profile with the real policy plugin on fd 3 and the real parity broker. The model
 * writes hello.txt ("مرحبا") with one tool call, reads it back with another, then
 * answers. Prints one JSON line: every request classified (never a header value),
 * the corrector port, the handshake, and the file read back.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { readVerifiedNassajDshLayer, verifyNassajDshPolicyPlugin } from '../../modules/providers/list/dsh/dsh-launch.js';
import { openDshLocalTurn } from '../../modules/providers/list/dsh/dsh-local-turn.js';
import { createClaudeParityEngine } from '../permission-parity/claude-parity-engine.js';
import { createParityBroker } from '../permission-parity/dsh-parity-broker.js';

const TURN_TIMEOUT_MS = 90_000;
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const markers = (text) => ({
  dummy: spec.dummies.some((dummy) => String(text).includes(dummy)),
  token: Boolean(globalThis.turnToken) && String(text).includes(globalThis.turnToken),
});

/** Classifies the Authorization value without exposing it. */
function classify(value) {
  if (value === undefined) return 'none';
  if (spec.serverKey && value === `Bearer ${spec.serverKey}`) return 'engine';
  return markers(value).dummy ? 'dummy' : 'other';
}

const requests = [];
const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
/** Step n of the scripted model: write, read, then answer; tool_use starts omit `input` like llama.cpp. */
function reply(step) {
  const start = { type: 'message_start', message: { id: `m${step}`, type: 'message', role: 'assistant', model: spec.model, content: [],
    stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } };
  const end = (reason) => [{ type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
  const tool = (name, args) => [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${step}`, name } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } }, ...end('tool_use')];
  if (step === 0) return tool('write', { file_path: 'hello.txt', content: 'مرحبا' });
  if (step === 1) return tool('read', { file_path: 'hello.txt' });
  return [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'مرحبا' } }, ...end('end_turn')];
}

const echo = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const headers = Object.entries(req.headers).filter(([name]) => name !== 'authorization');
    requests.push({
      method: req.method, path: req.url, authorization: classify(req.headers.authorization), xApiKey: req.headers['x-api-key'] !== undefined,
      leakedHeaders: headers.filter(([, value]) => markers(value).dummy || markers(value).token).map(([name]) => name),
      bodyHasDummy: markers(body).dummy, bodyHasToken: markers(body).token, model: (() => { try { return JSON.parse(body).model; } catch { return null; } })(),
    });
    let messages = [];
    try { messages = JSON.parse(body).messages ?? []; } catch { messages = []; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(reply(messages.filter((m) => m.role === 'assistant').length)));
  });
});

/** Drives initialize → handshake → session/new → model → prompt over ndjson stdio. */
async function driveTurn(child, broker) {
  let buffer = '';
  let id = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      let msg = null;
      try { msg = JSON.parse(buffer.slice(0, at)); } catch { msg = null; }
      buffer = buffer.slice(at + 1);
      if (msg?.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const request = (method, params) => new Promise((done) => {
    pending.set((id += 1), done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'nassaj-proof', version: '0' } });
  const handshake = await broker.handshake;
  if (!handshake) return { handshake };
  const session = await request('session/new', { cwd: spec.cwd, mcpServers: [] });
  const value = JSON.stringify(['deepseek-official', spec.model]);
  const offered = (session.result?.configOptions ?? []).find((o) => o.id === 'model')?.options
    ?.flatMap((o) => (Array.isArray(o.options) ? o.options : [o])).some((o) => o.value === value) ?? false;
  if (offered) await request('session/set_config_option', { sessionId: session.result.sessionId, configId: 'model', value });
  const reply = await request('session/prompt', { sessionId: session.result?.sessionId, prompt: [{ type: 'text', text: 'Write hello.txt.' }] });
  return { handshake, modelOffered: offered, stopReason: reply.result?.stopReason ?? null, error: reply.error?.message ?? null };
}

/** The production sequence of one local turn, against the echo server. */
async function runTurn() {
  const { text: layerText } = readVerifiedNassajDshLayer();
  const pluginEntry = path.resolve(verifyNassajDshPolicyPlugin(), 'index.mjs');
  const base = { command: process.execPath, script: spec.dshBin, home: spec.home, layerText, pluginEntry };
  const resolved = { local: { connectOrigin: `http://127.0.0.1:${spec.echoPort}`, model: spec.model, contextWindow: 32768, outputTokens: 4096 },
    secret: spec.serverKey ?? '' };
  const opened = await openDshLocalTurn({ launch: base, resolved, runId: 'proof' },
    { runsRoot: path.join(spec.work, 'runs'), serverEnv: { DSH_PATH: spec.dshBin } });
  globalThis.turnToken = opened.token;
  const engine = createClaudeParityEngine({ userId: null, cwd: spec.cwd, home: spec.home, sessionId: 'proof',
    transcriptPath: path.join(spec.work, 'transcript.jsonl'), permissionMode: 'bypassPermissions', managedSettingsDir: path.join(spec.work, 'managed'),
    claudeEnv: () => ({ HOME: path.join(spec.work, 'claude-home'), PATH: '/usr/bin:/bin' }) });
  const child = spawn(opened.launch.command, opened.launch.args, { cwd: spec.cwd, env: opened.launch.env,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false, detached: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const broker = createParityBroker({ engine, askMember: async () => 'reject', onIncident: () => {},
    kill: () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } });
  broker.attach(child.stdio[3]);
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, TURN_TIMEOUT_MS);
  const turn = await Promise.race([driveTurn(child, broker), new Promise((resolve) => child.once('exit', () => resolve({ exited: true })))]);
  clearTimeout(timer);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  const correctorPort = Number(new URL(JSON.parse(fs.readFileSync(opened.launch.layerPath, 'utf8')).find((r) => r.id === 'llm-deepseek').config.baseURL).port);
  const envHasKey = spec.serverKey ? JSON.stringify(opened.launch).includes(spec.serverKey) : false;
  await opened.close();
  const hello = fs.existsSync(path.join(spec.cwd, 'hello.txt')) ? fs.readFileSync(path.join(spec.cwd, 'hello.txt'), 'utf8') : null;
  const tokenInStderr = stderr.includes(opened.token);
  return { ...turn, correctorPort, envHasKey, hello, tokenInStderr, layerLeft: fs.existsSync(opened.launch.layerPath),
    envKeys: Object.keys(opened.launch.env).sort(), stderrTail: turn.handshake ? '' : stderr.slice(-400) };
}

echo.listen(spec.echoPort, '127.0.0.1', async () => {
  let result;
  try {
    result = await runTurn();
  } catch (error) {
    result = { failed: String(error?.code ?? error?.message ?? error) };
  }
  echo.close();
  process.stdout.write(`${JSON.stringify({ ...result, requests })}\n`);
  process.exit(0);
});
