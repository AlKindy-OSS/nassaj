// ADR-226 stage 0 runner (recording only): the installed opencode + the scripted fake LLM
// (../opencode-fake-llm/server.mjs) + probe-plugin.mjs, one fresh scratch tree per turn.
//
// Usage: OPENCODE_BIN=~/.opencode/bin/opencode node run.mjs <evidence.json> [scenario …]
//
// K1 safety (ADR-226 §6.0): every scratch dir (cwd, HOME, all four XDG dirs, TMPDIR, PM2_HOME)
// lives under /var/tmp and is removed at the end; PATH starts with witness-only ssh/pm2 shims
// and the fake LLM serves no step after the first unless `command -v ssh pm2` resolved to them;
// no write leaves the scratch tree; the only model is the loopback fake (no paid/remote turn).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.dirname(here);
const ACCOUNT_HOME = os.userInfo().homedir;
const BIN = process.env.OPENCODE_BIN || path.join(ACCOUNT_HOME, '.opencode', 'bin', 'opencode');
const [outFile, ...only] = process.argv.slice(2);
const BASE = fs.mkdtempSync('/var/tmp/adr226-stage0-');
const SHIM = { tool: 'bash', args: { command: 'command -v ssh pm2', description: 'shim check' } };
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const MCP_SERVER = `
const fs = require('node:fs'); const [server, witness] = process.argv.slice(2); let buf = '';
const tools = server === 'probe' ? ['echo', 'a_b'] : ['b'];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.id === undefined) continue; const r = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') r({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: server, version: '1' } });
  else if (m.method === 'tools/list') r({ tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } })) });
  else if (m.method === 'tools/call') { fs.appendFileSync(witness, server + ':' + m.params.name + '\\n'); r({ content: [{ type: 'text', text: 'mcp:' + server + ':' + m.params.name }] }); }
  else if (m.method === 'resources/list') r({ resources: [{ uri: 'probe://' + server + '/r1', name: 'r1', mimeType: 'text/plain' }] });
  else if (m.method === 'resources/templates/list') r({ resourceTemplates: [] });
  else if (m.method === 'resources/read') { fs.appendFileSync(witness, server + ':read\\n'); r({ contents: [{ uri: m.params.uri, mimeType: 'text/plain', text: 'resource-body' }] }); }
  else if (m.method === 'ping') r({});
  else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } }); } });
`;

const MUTATOR = `
import fs from 'node:fs';
const log = (row) => fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify({ t: Date.now(), ...row }) + '\\n');
export const NassajStage0Mutator = async () => ({ 'tool.execute.before': async (input, output) => {
  log({ ev: 'mutator-before', callID: input.callID, tool: input.tool, frozen: Object.isFrozen(output.args) });
  if (!JSON.stringify(output.args ?? {}).includes('PROBE_FREEZE')) return;
  const r = {};
  try { if ('command' in output.args) output.args.command = 'echo MUTATED'; else output.args.filePath = 'MUTATED.txt'; r.prop = 'no-throw'; } catch (e) { r.prop = String(e).slice(0, 120); }
  try { output.args = { ...output.args, command: 'echo REPLACED' }; r.replace = 'no-throw'; } catch (e) { r.replace = String(e).slice(0, 120); }
  log({ ev: 'mutator-result', callID: input.callID, ...r });
} });
`;

const THROWER = 'export const NassajStage0Thrower = async () => { throw new Error("stage-0 plugin throws at load"); };\n';

/** Kills opencode's whole tree: descendants from /proc first (leaves first), then its group. */
function killTree(pid) {
  const kids = (p) => { try { return fs.readdirSync(`/proc/${p}/task`).flatMap((t) => fs.readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)); } catch { return []; } };
  const walk = (p) => kids(p).flatMap((k) => [...walk(k), k]);
  for (const k of walk(pid)) { try { process.kill(Number(k), 'SIGKILL'); } catch { /* gone */ } }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
}

/**
 * One opencode turn. The prompt goes over stdin, and only after the plugin's hello was
 * accepted (o.accept=false: never), so stage 0 can see whether plugins load before `run`
 * reads stdin. Returns the hello timing, stdout events, probe log, fake-LLM log and witnesses.
 */
async function turn(name, o = {}) {
  const R = o.root ?? fs.mkdtempSync(path.join(BASE, `${name}-`));
  for (const d of ['home', 'cfg', 'data', 'cache', 'state', 'ws/sub', 'tmp', 'pm2', 'bin', 'outside']) fs.mkdirSync(path.join(R, d), { recursive: true });
  for (const s of ['ssh', 'pm2']) fs.copyFileSync(path.join(FIX, 'opencode-shims', s), path.join(R, 'bin', s));
  for (const s of ['ssh', 'pm2']) fs.chmodSync(path.join(R, 'bin', s), 0o755);
  fs.writeFileSync(path.join(R, 'ws', 'rel.txt'), 'one\n');
  fs.writeFileSync(path.join(R, 'ws', 'PROBE_FREEZE.txt'), 'freeze one\n');
  fs.writeFileSync(path.join(R, 'home', 'tilde.txt'), 'alpha\n');
  fs.writeFileSync(path.join(R, 'outside', 'o.txt'), 'outside\n');
  for (const [rel, text] of Object.entries(o.files ?? {})) { fs.mkdirSync(path.dirname(path.join(R, rel)), { recursive: true }); fs.writeFileSync(path.join(R, rel), text.replaceAll('@R@', R)); }
  const llmLog = path.join(R, `llm-${name}.jsonl`);
  const llm = spawn(process.execPath, [path.join(FIX, 'opencode-fake-llm', 'server.mjs'), '0', llmLog, path.join(R, 'bin')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => llm.stdout.once('data', (d) => r(String(d).split(' ')[1].trim())));
  fs.writeFileSync(path.join(R, 'mcp.cjs'), MCP_SERVER);
  fs.writeFileSync(path.join(R, 'mutator.mjs'), MUTATOR);
  fs.writeFileSync(path.join(R, 'thrower.mjs'), THROWER);
  const plugin = (p) => ({ probe: pathToFileURL(path.join(here, 'probe-plugin.mjs')).href, mutator: pathToFileURL(path.join(R, 'mutator.mjs')).href,
    thrower: pathToFileURL(path.join(R, 'thrower.mjs')).href }[p]);
  const model = o.model ?? 'probe';
  const cfg = { provider: { probe: { npm: '@ai-sdk/openai-compatible', name: 'probe', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-fake' },
    models: { [model]: { name: model, tool_call: true } } } }, model: `probe/${model}`, small_model: `probe/${model}`, autoupdate: false, share: 'disabled',
  plugin: (o.plugins ?? ['probe']).map(plugin), ...(o.config ?? {}) };
  if (o.mcp) cfg.mcp = { probe: { type: 'local', command: [process.execPath, path.join(R, 'mcp.cjs'), 'probe', path.join(R, 'mcp-witness')] },
    probe_a: { type: 'local', command: [process.execPath, path.join(R, 'mcp.cjs'), 'probe_a', path.join(R, 'mcp-witness')] } };
  const env = { PATH: `${R}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: `${R}/home`, SHELL: '/bin/bash', LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: `${R}/tmp`,
    XDG_CONFIG_HOME: `${R}/cfg`, XDG_DATA_HOME: `${R}/data`, XDG_CACHE_HOME: `${R}/cache`, XDG_STATE_HOME: `${R}/state`, PM2_HOME: `${R}/pm2`,
    PARITY_SHIM_WITNESS: `${R}/shim-witness`, PROBE_LOG: `${R}/probe.jsonl`, PROBE_NONCE: `nonce-${name}`,
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg), ...(o.env ?? {}) };
  const steps = o.steps ?? [SHIM, { text: 'done' }];
  const prompt = (o.promptPrefix ?? '') + `NASSAJ_STEPS ${JSON.stringify(steps).replaceAll('@R@', R).replaceAll('@PORT@', port)
    .replaceAll('SUB_STEPS', 'SUB\\u005fSTEPS')} END_STEPS`;
  const t0 = Date.now();
  const oc = spawn(BIN, o.argv ?? ['run', '--format', 'json', ...(o.args ?? [])], { cwd: `${R}/ws`, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true });
  const res = { name, root: R, hello: null, acceptedAt: null, promptWrittenAt: null, fd3Frames: [], stdout: [], stderr: '', exit: null, killed: null };
  oc.stdout.on('data', (d) => { res.stdoutRaw = (res.stdoutRaw ?? '') + d; });
  oc.stderr.on('data', (d) => { res.stderr += d; });
  oc.stdio[3].on('error', () => {});
  let fbuf = '';
  const writePrompt = () => { if (o.writePrompt === false) return; oc.stdin.end(prompt); res.promptWrittenAt = Date.now() - t0; };
  oc.stdio[3].on('data', (d) => {
    fbuf += d; let i;
    while ((i = fbuf.indexOf('\n')) >= 0) {
      const m = JSON.parse(fbuf.slice(0, i)); fbuf = fbuf.slice(i + 1);
      res.fd3Frames.push({ t: Date.now() - t0, ...m });
      if (m.type !== 'hello' || res.hello) continue;
      let flags = null;
      try { flags = /flags:\s*(\d+)/.exec(fs.readFileSync(`/proc/${oc.pid}/fdinfo/3`, 'utf8'))?.[1]; } catch { /* gone */ }
      res.hello = { t: Date.now() - t0, nonce: m.nonce, llmRequestsAtHello: readJsonl(llmLog).length, fd3FlagsOctal: flags,
        fd3Cloexec: flags ? Boolean(parseInt(flags, 8) & 0o2000000) : null };
      setTimeout(() => {
        res.llmRequestsBeforeAccept = readJsonl(llmLog).length;
        if (o.accept === false) return;
        oc.stdio[3].write(`${JSON.stringify({ type: 'accept', nonce: m.nonce })}\n`);
        res.acceptedAt = Date.now() - t0;
        writePrompt();
      }, o.hold ?? 2000);
    }
  });
  if (o.promptWithoutHello) setTimeout(writePrompt, 50);
  const killAfter = o.killAfterMs ?? 90000;
  const timer = setTimeout(() => { res.killed = Date.now() - t0; killTree(oc.pid); }, killAfter);
  res.exit = await new Promise((r) => oc.on('exit', (code, signal) => r({ code, signal })));
  clearTimeout(timer);
  res.durationMs = Date.now() - t0;
  llm.kill();
  const llmRows = readJsonl(llmLog);
  res.llm = llmRows.filter((x) => x.url).map((x) => ({ t: x.t - t0, url: x.url, tools: x.body?.tools?.map((y) => y.function?.name),
    lastUser: [...(x.body?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content }));
  res.llmAborts = llmRows.filter((x) => x.abort);
  res.toolSchemas = Object.fromEntries((llmRows.find((x) => x.body?.tools)?.body.tools ?? []).map((t) => [t.function.name, t.function.parameters]));
  res.stdout = (res.stdoutRaw ?? '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  delete res.stdoutRaw;
  res.toolParts = res.stdout.filter((e) => e.type === 'tool_use').map((e) => ({ sessionID: e.sessionID, tool: e.part.tool, callID: e.part.callID,
    status: e.part.state.status, input: e.part.state.input, output: String(e.part.state.output ?? e.part.state.error ?? '').slice(0, 600) }));
  res.probe = readJsonl(path.join(R, 'probe.jsonl'));
  for (const w of ['shim-witness', 'mcp-witness', 'fmt-witness', 'lsp-witness', 'ws/throw-witness', 'ws/bang-witness', 'ws/slash-witness']) {
    const f = path.join(R, w); res[`witness:${w}`] = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  }
  res.wsFiles = fs.readdirSync(path.join(R, 'ws'));
  res.files = Object.fromEntries(['ws/rel.txt', 'home/tilde.txt', 'ws/PROBE_FREEZE.txt', 'ws/added.txt', 'ws/f.txt'].map((f) => [f, fs.existsSync(path.join(R, f)) ? fs.readFileSync(path.join(R, f), 'utf8') : null]));
  res.stderr = res.stderr.slice(-1500);
  return res;
}

const sub = (steps) => `SUB_STEPS ${JSON.stringify(steps)} END_SUB`;
const SCENARIOS = {
  order: () => turn('order', { hold: 3000, steps: [SHIM,
    { tool: 'bash', args: { command: 'readlink /proc/$$/fd/3 || echo NOFD3-SHELL; ls /proc/$$/fd | tr "\\n" " "', description: 'fd3 in shell' } },
    { tool: 'bash', args: { command: 'ps -o pid,pgid,sid,args -p $$ -p $PPID; echo "argv0=$0 opts=$-"', description: 'shell shape' } }, { text: 'done' }] }),
  noAccept: () => turn('noAccept', { accept: false, killAfterMs: 15000 }),
  noPlugin: () => turn('noPlugin', { plugins: [], killAfterMs: 15000 }),
  pure: () => turn('pure', { env: { OPENCODE_PURE: '1' }, killAfterMs: 15000 }),
  pureFlag: () => turn('pureFlag', { args: ['--pure'], killAfterMs: 15000 }),
  throwerThenProbe: () => turn('throwerThenProbe', { plugins: ['thrower', 'probe'], killAfterMs: 30000 }),
  throwerOnly: () => turn('throwerOnly', { plugins: ['thrower'], killAfterMs: 15000 }),
  tools: () => turn('tools', { env: { PROBE_APPEND: '1', PROBE_SCRUB: 'delete', NASSAJ_PROBE_SECRET: 's3cr3t' }, steps: [SHIM,
    { tool: 'bash', args: { command: 'echo mutate-check', description: 'PROBE_MUTATE' } },
    { tool: 'bash', args: { command: 'echo body-ran > throw-witness', description: 'PROBE_THROW' } },
    { tool: 'read', args: { filePath: 'rel.txt' } },
    { tool: 'edit', args: { filePath: '~/tilde.txt', oldString: 'alpha', newString: 'beta' } },
    { tool: 'edit', args: { filePath: 'rel.txt', oldString: 'one', newString: 'two' } },
    { tool: 'glob', args: { pattern: '*.txt' } },
    { tool: 'grep', args: { pattern: 'two', include: '*.txt' } },
    { tool: 'todowrite', args: { todos: [{ content: 'x', status: 'pending', priority: 'low' }] } },
    { tool: 'webfetch', args: { url: 'http://127.0.0.1:@PORT@/v1/models', format: 'text' } },
    { tool: 'skill', args: { name: 'no-such-skill' } },
    { tool: 'no_such_tool', args: { x: 1 } },
    { tool: 'bash', raw: '{"command": "echo malformed' },
    { tool: 'bash', args: { command: 'echo "S=${NASSAJ_PROBE_SECRET-unset} E=${PROBE_SHELL_ENV-unset}"', description: 'env scrub' } },
    { tool: 'bash', args: { command: 'pwd', workdir: '@R@/ws/sub', description: 'workdir' } },
    { tool: 'task', args: { description: 'sub', subagent_type: 'general', prompt: sub([SHIM, { tool: 'bash', args: { command: 'echo sub-bash', description: 'sub' } },
      { tool: 'read', args: { filePath: '@R@/ws/rel.txt' } }, { text: 'sub done' }]) } },
    { text: 'done' }] }),
  scrubUndefined: () => turn('scrubUndefined', { env: { PROBE_SCRUB: 'undefined', NASSAJ_PROBE_SECRET: 's3cr3t' }, steps: [SHIM,
    { tool: 'bash', args: { command: 'echo "S=${NASSAJ_PROBE_SECRET-unset}"', description: 'env scrub' } }, { text: 'done' }] }),
  freeze: () => turn('freeze', { plugins: ['probe', 'mutator'], steps: freezeSteps() }),
  freezeMutatorFirst: () => turn('freezeMutatorFirst', { plugins: ['mutator', 'probe'], steps: freezeSteps() }),
  mcp: () => turn('mcp', { mcp: true, steps: [SHIM,
    { tool: 'probe_echo', args: { text: 'hi' } }, { tool: 'probe_a_b', args: { text: 'hi' } },
    { tool: 'list_mcp_resources', args: {} }, { tool: 'read_mcp_resource', args: { server: 'probe', uri: 'probe://probe/r1' } }, { text: 'done' }] }),
  callidA: async () => {
    const root = fs.mkdtempSync(path.join(BASE, 'callid-'));
    const steps = [SHIM, { tool: 'bash', id: 'call_fixed', args: { command: 'echo one', description: 'one' } },
      { tool: 'bash', id: 'call_fixed', args: { command: 'echo two', description: 'two' } }, { text: 'done' }];
    const a = await turn('callidA', { root, steps });
    const b = await turn('callidB', { root, steps });
    return { a, b };
  },
  permAllow: () => turn('permAllow', { env: { OPENCODE_PERMISSION: '{"*":"allow"}' }, steps: permSteps() }),
  permNone: () => turn('permNone', { steps: permSteps() }),
  permAgentDeny: () => turn('permAgentDeny', { env: { OPENCODE_PERMISSION: '{"*":"allow"}' }, config: { agent: { build: { permission: { bash: 'deny' } } } },
    steps: [SHIM, { tool: 'bash', args: { command: 'echo agent-level', description: 'x' } }, { text: 'done' }] }),
  permConfigDeny: () => turn('permConfigDeny', { env: { OPENCODE_PERMISSION: '{"*":"allow"}' }, config: { permission: { bash: { 'echo cfg*': 'deny' } } },
    steps: [SHIM, { tool: 'bash', args: { command: 'echo cfg-level', description: 'x' } }, { text: 'done' }] }),
  fmtProject: () => turn('fmtProject', { files: { 'ws/opencode.json': projectFmtLsp() }, steps: fmtSteps() }),
  fmtInlineOff: () => turn('fmtInlineOff', { files: { 'ws/opencode.json': projectFmtLsp() }, config: { lsp: false, formatter: false }, steps: fmtSteps() }),
  bang: () => turn('bang', { promptPrefix: '!echo bang > bang-witness\n' }),
  slash: () => turn('slash', { promptPrefix: '/init ' }),
  plan: () => turn('plan', { args: ['--agent', 'plan'], steps: [SHIM, { tool: 'edit', args: { filePath: 'rel.txt', oldString: 'one', newString: 'plan' } }, { text: 'done' }] }),
  applyPatch: () => turn('applyPatch', { model: 'gpt-5-probe', steps: [SHIM,
    { tool: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Add File: added.txt\n+hi\n*** Update File: rel.txt\n@@\n-one\n+uno\n*** End Patch' } }, { text: 'done' }] }),
  debugAgent: () => turn('debugAgent', { argv: ['debug', 'agent', 'build'], writePrompt: false, killAfterMs: 30000, hold: 500 }),
  pathRealRc: () => turn('pathRealRc', { files: { 'home/.bashrc': fs.readFileSync(path.join(ACCOUNT_HOME, '.bashrc'), 'utf8'), 'home/.profile': fs.readFileSync(path.join(ACCOUNT_HOME, '.profile'), 'utf8') },
    steps: [SHIM, { tool: 'bash', args: { command: 'echo "argv0=$0 opts=$- PATH=$PATH"; shopt -q login_shell && echo LOGIN || echo NOLOGIN', description: 'rc' } }, { text: 'done' }] }),
  slow: () => turn('slow', { env: { PROBE_SLOW_MS: '65000' }, killAfterMs: 150000,
    steps: [SHIM, { tool: 'bash', args: { command: 'echo slow-ok', description: 'PROBE_SLOW' } }, { text: 'done' }] }),
};
function freezeSteps() {
  return [SHIM, { tool: 'bash', args: { command: 'echo ORIGINAL', description: 'PROBE_FREEZE' } },
    { tool: 'read', args: { filePath: 'PROBE_FREEZE.txt' } },
    { tool: 'edit', args: { filePath: 'PROBE_FREEZE.txt', oldString: 'one', newString: 'two' } },
    { tool: 'glob', args: { pattern: 'PROBE_FREEZE*' } }, { tool: 'grep', args: { pattern: 'PROBE_FREEZE|freeze', include: '*.txt' } },
    { tool: 'todowrite', args: { todos: [{ content: 'PROBE_FREEZE', status: 'pending', priority: 'low' }] } },
    { tool: 'bash', args: { command: 'echo wd-PROBE_FREEZE', workdir: '@R@/ws/sub', description: 'PROBE_FREEZE workdir' } },
    { tool: 'task', args: { description: 'PROBE_FREEZE', subagent_type: 'general', prompt: sub([SHIM, { text: 'sub done' }]) } }, { text: 'done' }];
}
function permSteps() {
  const loop = { tool: 'bash', args: { command: 'echo loop', description: 'loop' } };
  return [SHIM, { tool: 'read', args: { filePath: '@R@/outside/o.txt' } }, loop, loop, loop, loop, { text: 'done' }];
}
function projectFmtLsp() {
  return JSON.stringify({ formatter: { probefmt: { command: ['sh', '-c', 'echo "FMT $1" >> @R@/fmt-witness', 'sh', '$FILE'], extensions: ['.txt'] } },
    lsp: { probelsp: { command: ['sh', '-c', 'echo LSP >> @R@/lsp-witness; sleep 5'], extensions: ['.txt'] } } });
}
function fmtSteps() {
  return [SHIM, { tool: 'read', args: { filePath: 'rel.txt' } }, { tool: 'edit', args: { filePath: 'rel.txt', oldString: 'one', newString: 'fmt' } }, { text: 'done' }];
}

const evidence = { binary: BIN, scenarios: {} };
for (const [name, fn] of Object.entries(SCENARIOS)) {
  if (only.length && !only.includes(name)) continue;
  process.stderr.write(`stage0: ${name}\n`);
  try { evidence.scenarios[name] = await fn(); } catch (error) { evidence.scenarios[name] = { error: String(error?.stack ?? error) }; }
}
fs.writeFileSync(outFile, JSON.stringify(evidence, null, 1));
if (process.env.KEEP_SCRATCH !== '1') fs.rmSync(BASE, { recursive: true, force: true });
process.stderr.write(`stage0: wrote ${outFile}\n`);
