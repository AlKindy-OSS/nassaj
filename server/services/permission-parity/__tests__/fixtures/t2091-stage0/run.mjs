// T-2091 S0 runner (recording only): real dsh + the stage0 fake LLM + a probe layer.
// Usage: NASSAJ_REPO=<repo> DSH_BIN=<fresh /var/tmp install>/node_modules/@deepseek-ai/dsh/lib/bin.js \
//   PROBE_LIB=<dir with t2091-probe.mjs, t2091-hostile.mjs, package.json (engines-packages/layer-scope-package.json)
//   and node_modules/t2091-eng-{high,rc}/ (engines-packages/)> node run.mjs <main|unknown> <port>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [variant = 'main', port = '47901'] = process.argv.slice(2);
const REPO = process.env.NASSAJ_REPO ?? process.cwd();
const BIN = process.env.DSH_BIN; // fresh /var/tmp install: <dir>/node_modules/@deepseek-ai/dsh/lib/bin.js
const R = fs.mkdtempSync(`/var/tmp/t2091-run-${variant}-`);
for (const d of ['home/.dsh', 'home/.agents', 'home/.tmp', 'ws']) fs.mkdirSync(path.join(R, d), { recursive: true });
fs.cpSync(process.env.PROBE_LIB, path.join(R, 'layer'), { recursive: true });
let layer = fs.readFileSync(`${REPO}/server/governance/dsh-nassaj-layer.yml`, 'utf8');
layer = layer.slice(0, layer.indexOf('- insert:\n    - id: nassaj-policy')).replace('https://api.deepseek.com/anthropic', `http://127.0.0.1:${port}/anthropic`);
layer += `- insert:\n    - id: t2091-probe\n      name: ./t2091-probe.mjs\n    - id: t2091-hostile\n      name: ./t2091-hostile.mjs\n    - id: t2091-eng-high\n      name: ./node_modules/t2091-eng-high/index.mjs\n    - id: t2091-eng-rc\n      name: ./node_modules/t2091-eng-rc/index.mjs\n`;
if (variant === 'unknown') layer += '- id: t2091-no-such-row\n  disabled: true\n- id: t2091-no-such-row-2\n  config:\n    x: 1\n';
fs.writeFileSync(path.join(R, 'layer', 'layer.yml'), layer);
const llm = spawn(process.execPath, [`${REPO}/server/services/permission-parity/__tests__/fixtures/stage0/fake-llm-steps.mjs`, port, `${R}/llm.jsonl`], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: `${R}/home`, LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: `${R}/home/.tmp`, DSH_HOME: `${R}/home/.dsh`,
  DSH_AGENTS_HOME: `${R}/home/.agents`, DEEPSEEK_API_KEY: 'sk-fake', DSH_TELEMETRY_DISABLED: '1' };
const dsh = spawn(process.execPath, [BIN, 'nassaj-acp', '--from-default-profile', 'acp', '--patch', `${R}/layer/layer.yml`], { cwd: `${R}/ws`, env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = ''; dsh.stderr.on('data', (d) => { stderr += d; });
const pending = new Map(); let buf = ''; let id = 0; const updates = [];
dsh.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  const u = m.params?.update; if (u && /tool_call/.test(u.sessionUpdate)) updates.push(u); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
const req = (method, params) => new Promise((resolve) => { pending.set((id += 1), resolve); dsh.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const timeout = setTimeout(() => { fs.writeFileSync(`${R}/result.json`, JSON.stringify({ timeout: true, stderr: stderr.slice(-2000) })); dsh.kill('SIGKILL'); llm.kill(); process.exit(0); }, 60000);
const init = await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'n', version: '0' } });
const s = await req('session/new', { cwd: `${R}/ws`, mcpServers: [] });
let prompt = null;
if (s.result) {
  const subSteps = [{ name: 'bash', raw: JSON.stringify({ command: 'touch allowed-sub', description: 's' }) }, { name: 'bash', raw: JSON.stringify({ command: 'touch nopermit-sub', description: 's' }) }, { text: 'sub done' }];
  const sub = `SUB${'\\u005f'}STEPS ${JSON.stringify(subSteps)} END_SUB`;
  const steps = [
    { name: 'bash', raw: JSON.stringify({ command: 'touch allowed-1', description: 'a' }) },
    { name: 'bash', raw: JSON.stringify({ command: 'touch plain-1', description: 'p' }) },
    { name: 'bash', raw: JSON.stringify({ command: 'touch hostile-1', description: 'h' }) },
    { name: 'subagent', raw: `{"description":"sub","prompt":${JSON.stringify(sub).replace('\\\\u005f', '\\u005f')}}` },
    { name: 'web_search', raw: JSON.stringify({ queries: ['allowed x'] }) },
    { text: 'done' }];
  prompt = await req('session/prompt', { sessionId: s.result.sessionId, prompt: [{ type: 'text', text: `NASSAJ_STEPS ${JSON.stringify(steps)} END_STEPS` }] });
  await new Promise((r) => setTimeout(r, 4000));
}
clearTimeout(timeout);
const llmReqs = fs.existsSync(`${R}/llm.jsonl`) ? fs.readFileSync(`${R}/llm.jsonl`, 'utf8').trim().split('\n').map(JSON.parse).filter((x) => x.body?.tools) : [];
fs.writeFileSync(`${R}/result.json`, JSON.stringify({ init: !!init.result, session: s.error ?? 'ok', prompt, updates, files: fs.readdirSync(`${R}/ws`),
  toolsPerRequest: llmReqs.map((x) => x.body.tools.map((t) => t.name).filter((n) => n === 'web_search' || n === 'bash')), stderr: stderr.slice(-1500) }, null, 1));
dsh.kill('SIGKILL'); llm.kill(); console.log(R); process.exit(0);
