/**
 * dsh-contract-run — the OFFLINE contract suite a dsh update candidate must pass before the
 * pipeline switches to it (T-2091, ADR-225). Nothing leaves the machine: the candidate runs
 * with a fake key, under a TEST layer built from the pinned production layer by replacing only
 * the LLM row (asserted: exactly one row differs; prepareDshLaunch refuses that file by pin),
 * against an in-process fake Anthropic-Messages LLM, with the pinned policy plugin, the real
 * broker and the real parity engine. Checks, each failing with its own code:
 *   - security rows: the candidate's --dump-config under the PRODUCTION layer (dsh_cap_security_rows);
 *   - P4 handshake (dsh_cap_channel), P1 (dsh_cap_tools_api), P2 (dsh_cap_gate);
 *   - the tool map: a mapped tool lost (dsh_tool_lost) or with a changed field (dsh_tool_schema_changed);
 *   - conformance turn: UserPromptSubmit context reaches the model; every mapped tool, an unknown
 *     tool and a subagent call reach Nassaj's decision; the bash body runs once; no kill
 *     (dsh_contract_conformance_failed).
 * Returns { ok, code?, report }.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { createClaudeParityEngine } from '../../../../services/permission-parity/claude-parity-engine.js';
import { buildDshTestLayer, checkSecurityRowsSemantic, parseDumpConfig } from '../../../../services/permission-parity/dsh-contract-suite.js';
import { createParityBroker } from '../../../../services/permission-parity/dsh-parity-broker.js';
import { loadDshToolMap } from '../../../../services/permission-parity/dsh-tool-map.js';
import { nassajDshLayerPath, nassajDshPolicyPluginPath } from '../../list/dsh/dsh-launch.js';

const ENTRY = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const TURN_TIMEOUT_MS = 120000;
const SUBAGENT_TIMEOUT_MS = 30000;

/** Minimal arguments that make every mapped tool reach the policy decision. */
export const CONFORMANCE_CALLS = Object.freeze({
  bash: { command: 'touch contract-witness', description: 'contract' },
  read: { file_path: 'contract-file.txt' }, read_image: { file_path: 'contract-file.txt' },
  glob: { pattern: '*.txt' }, grep: { pattern: 'contract' },
  write: { file_path: 'contract-written.txt', content: 'x' },
  edit: { file_path: 'contract-file.txt', old_string: 'contract', new_string: 'checked' },
  web_fetch: { url: 'https://example.invalid/' }, web_search: { queries: ['nassaj contract'] },
  skill: { name: 'nassaj-contract-none' }, todo_write: { todos: [] },
  job_list: {}, job_output: { job_id: 'none' }, job_kill: { job_id: 'none' },
  subagent: { description: 'contract', prompt: 'CONTRACT_SUB' }, subagent_fork: { description: 'contract', prompt: 'CONTRACT_SUB' },
});

/** In-process fake Anthropic-Messages LLM: step i answers a history holding i assistant turns. */
function fakeLlm(steps, subSteps) {
  const requests = [];
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  };
  const reply = (step, n) => {
    const start = { type: 'message_start', message: { id: `m${n}`, type: 'message', role: 'assistant', model: 'deepseek-v4-flash',
      content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } };
    const end = (reason) => [{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: reason },
      usage: { output_tokens: 1 } }, { type: 'message_stop' }];
    if (!step.name) {
      return [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'contract done' } }, ...end('end_turn')];
    }
    return [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_contract_${n}`, name: step.name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.args) } }, ...end('tool_use')];
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [] })); return; }
      let body = {};
      try { body = JSON.parse(raw); } catch { body = {}; }
      requests.push(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const text = JSON.stringify(messages.filter((m) => m.role === 'user'));
      const script = text.includes('CONTRACT_SUB') && !text.includes('CONTRACT_MAIN') ? subSteps : steps;
      const done = messages.filter((m) => m.role === 'assistant').length;
      sse(res, reply(script[done] ?? {}, requests.length));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

/** The candidate's composed profile under the PRODUCTION layer must keep every security row. */
function securityRows(node, entry, env, layer) {
  const run = spawnSync(node, [entry, 'nassaj-acp', '--from-default-profile', 'acp', '--patch', layer, '--dump-config'],
    { env, cwd: env.HOME, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, shell: false });
  return run.status === 0 ? checkSecurityRowsSemantic(parseDumpConfig(run.stdout)) : [`dump-config exit ${run.status}`];
}

/** Lays out the sandbox: member home, workspace, test layer + plugin copy, managed settings. */
function sandboxFor(work, port) {
  const home = path.join(work, 'home');
  const ws = path.join(work, 'ws');
  for (const dir of [path.join(home, '.dsh'), path.join(home, '.agents'), path.join(home, '.tmp'), ws, path.join(work, 'layer'),
    path.join(work, 'managed'), path.join(work, 'claude-home')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ws, 'contract-file.txt'), 'contract\n');
  const production = fs.readFileSync(nassajDshLayerPath(), 'utf8');
  const { text, changedRows } = buildDshTestLayer(production, `http://127.0.0.1:${port}/anthropic`);
  fs.writeFileSync(path.join(work, 'layer', 'dsh-nassaj-layer.yml'), text);
  fs.cpSync(nassajDshPolicyPluginPath(), path.join(work, 'layer', 'dsh-policy-plugin'), { recursive: true });
  fs.writeFileSync(path.join(work, 'managed', 'managed-settings.json'), JSON.stringify({
    permissions: { deny: ['WebFetch', 'WebSearch'] },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo NASSAJ_CONTRACT_CONTEXT' }] }] } }));
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: path.join(home, '.tmp'),
    DSH_HOME: path.join(home, '.dsh'), DSH_AGENTS_HOME: path.join(home, '.agents'), DEEPSEEK_API_KEY: 'sk-nassaj-contract-fake',
    DSH_TELEMETRY_DISABLED: '1' };
  return { home, ws, env, changedRows, layer: path.join(work, 'layer', 'dsh-nassaj-layer.yml') };
}

/** Drives one ACP turn; resolves with the prompt reply (or null on timeout/exit). */
function driveTurn(child, broker, ws, promptText) {
  return new Promise((resolve) => {
    const pending = new Map();
    let buffer = '';
    let id = 0;
    const timer = setTimeout(() => resolve(null), TURN_TIMEOUT_MS);
    child.once('exit', () => { clearTimeout(timer); resolve(null); });
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
    (async () => {
      await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'nassaj-contract', version: '0' } });
      if (!(await broker.handshake)) { clearTimeout(timer); resolve(null); return; }
      const session = await request('session/new', { cwd: ws, mcpServers: [] });
      const reply = await request('session/prompt', { sessionId: session.result?.sessionId,
        prompt: [{ type: 'text', text: promptText.main }, ...promptText.context.map((text) => ({ type: 'text', text }))] });
      clearTimeout(timer);
      resolve(reply);
    })();
  });
}

/** The verdict of a finished run. */
function verdict({ broker, decisions, kills, reply, llm, ws, mapped }) {
  if (!broker.state.hello) return { ok: false, code: broker.state.refusal ?? 'dsh_cap_channel' };
  const comparison = broker.state.tools?.comparison ?? { lost: [], changed: [] };
  if (comparison.lost.length) return { ok: false, code: 'dsh_tool_lost', detail: comparison.lost };
  if (comparison.changed.length) return { ok: false, code: 'dsh_tool_schema_changed', detail: comparison.changed };
  const decided = new Set(decisions.map((d) => d.tool));
  const missing = [...mapped, 'subagent'].filter((name) => !decided.has(name));
  if (!decisions.some((d) => d.agent && d.agent !== decisions[0]?.agent)) missing.push('the subagent\'s own call');
  const contextSeen = llm.requests.some((body) => JSON.stringify(body.messages ?? []).includes('NASSAJ_CONTRACT_CONTEXT'));
  const problems = [
    ...(kills.length ? ['killed'] : []), ...(reply?.result?.stopReason === 'end_turn' ? [] : ['turn did not end']),
    ...missing.map((name) => `no decision for ${name}`), ...(contextSeen ? [] : ['UserPromptSubmit context missing']),
    ...(fs.existsSync(path.join(ws, 'contract-witness')) ? [] : ['bash body did not run']),
  ];
  return problems.length ? { ok: false, code: 'dsh_contract_conformance_failed', detail: problems } : { ok: true };
}

/**
 * @param {{ version: string, dir: string }} candidate the staged tree (holds node_modules/@deepseek-ai/dsh)
 * @param {{ node: string, workRoot: string }} deps workRoot: a fresh dir under the staging area
 */
export async function runDshContractSuite({ version, dir }, { node, workRoot }) {
  const entry = path.join(dir, ENTRY);
  const map = loadDshToolMap();
  const mapped = Object.keys(map.tools);
  const steps = [...mapped.map((name) => ({ name, args: CONFORMANCE_CALLS[name] ?? {} })), { name: 'nassaj_contract_unknown', args: {} }, {}];
  const subSteps = [{ name: 'bash', args: { command: 'true', description: 'contract sub' } }, {}];
  const llm = await fakeLlm(steps, subSteps);
  const work = fs.mkdtempSync(path.join(workRoot, 'contract-'));
  const box = sandboxFor(work, llm.port);
  const report = { version, changedRows: box.changedRows };
  let child = null;
  try {
    if (box.changedRows.length !== 1 || box.changedRows[0] !== 'llm-deepseek') return { ok: false, code: 'dsh_contract_test_layer_invalid', report };
    const security = securityRows(node, entry, box.env, nassajDshLayerPath());
    if (security.length) return { ok: false, code: 'dsh_cap_security_rows', report: { ...report, security } };
    const engine = createClaudeParityEngine({ userId: null, cwd: box.ws, home: box.home, sessionId: `contract-${version}`,
      transcriptPath: path.join(work, 'transcript.jsonl'), permissionMode: 'bypassPermissions', managedSettingsDir: path.join(work, 'managed'),
      claudeEnv: () => ({ HOME: path.join(work, 'claude-home'), PATH: '/usr/bin:/bin' }) });
    const gate = await engine.userPromptSubmit({ prompt: 'CONTRACT_MAIN' });
    child = spawn(node, [entry, 'nassaj-acp', '--from-default-profile', 'acp', '--patch', box.layer],
      { cwd: box.ws, env: box.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false, detached: true });
    const decisions = [];
    const kills = [];
    let subagentDecided;
    const subagentSeen = new Promise((resolve) => { subagentDecided = resolve; });
    // The subagent's own call carries another agent id than the root session's first call.
    const record = (entryLog) => {
      decisions.push(entryLog);
      if (decisions.length > 1 && entryLog.agent && entryLog.agent !== decisions[0].agent) subagentDecided(true);
    };
    const broker = createParityBroker({ engine, askMember: async () => 'reject', log: record,
      onIncident: () => {}, kill: () => { kills.push(1); try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } });
    broker.attach(child.stdio[3]);
    const reply = await driveTurn(child, broker, box.ws, { main: `CONTRACT_MAIN ${version}`, context: gate.additionalContext });
    // Wait for the subagent's decision itself (qa I3), bounded; a missing one fails the conformance check.
    let timer;
    await Promise.race([subagentSeen, new Promise((resolve) => { timer = setTimeout(resolve, SUBAGENT_TIMEOUT_MS); })]);
    clearTimeout(timer);
    const result = verdict({ broker, decisions, kills, reply, llm, ws: box.ws, mapped });
    return { ...result, report: { ...report, decisions: decisions.length, ...(result.detail ? { detail: result.detail } : {}) } };
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
    llm.server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

