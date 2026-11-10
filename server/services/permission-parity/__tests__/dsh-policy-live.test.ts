/**
 * dsh-policy-live.test — T-2089 S4 (ADR-225) on the REAL dsh binary. Rerun on every dsh
 * bump. Skipped unless NASSAJ_TEST_DSH_LIVE_BIN names a dsh lib/bin.js installed in a fresh
 * /var/tmp dir (fake key; the LLM is the local fake of fixtures/stage0, so the shipped
 * layer is copied with only its LLM origin pointed at it).
 *
 * Proves, through the Nassaj layer + policy plugin + broker + engine:
 *  - the handshake inventory of real dsh is accepted before the prompt;
 *  - bash children hold only fds 0–2 (fd 3 = policy channel and fd 7 are not inherited);
 *  - a Claude deny rule stops the body; schema-invalid arguments are refused by the plugin;
 *  - a subagent's call goes through the same decision (agent id logged) and runs once;
 *  - no result reaches ACP without a recorded decision (no kill);
 *  - (S5) a PostToolUse additionalContext reaches the model; nothing prompts the model after
 *    the turn ends (no self-prompt source);
 *  - (T-2091) the capability probes P1/P2 pass on the real binary; tools dsh registers outside
 *    dsh-tool-map.json are hidden (from the agent's next step) and denied when called.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createClaudeParityEngine } from '@/services/permission-parity/claude-parity-engine.js';
import { createParityBroker } from '@/services/permission-parity/dsh-parity-broker.js';

const BIN = process.env.NASSAJ_TEST_DSH_LIVE_BIN ?? '';
const SKIP = BIN ? false : 'set NASSAJ_TEST_DSH_LIVE_BIN to a real dsh lib/bin.js (fresh /var/tmp install)';
const here = path.dirname(fileURLToPath(import.meta.url));
const governance = path.resolve(here, '..', '..', '..', 'governance');
type Row = Record<string, any>;

interface LiveOptions { settings: Row; steps: (sub: string) => Row[] }
interface LiveRun { root: string; ws: string; updates: Row[]; decisions: Row[]; incidents: Row[]; killed: number;
  promptReply: Row | null; shellFds: string; llmAfterEnd: number; llmAtEnd: number; llm: () => Row[]; hello: Row | null }

/** One real dsh turn under the Nassaj layer(s), the policy plugin, broker and engine. */
async function liveRun({ settings, steps }: LiveOptions): Promise<LiveRun> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-dsh-live-')));
  const ws = path.join(root, 'ws');
  const home = path.join(root, 'home');
  for (const dir of [ws, path.join(home, '.dsh'), path.join(home, '.agents'), path.join(home, '.tmp'), path.join(root, 'layer'),
    path.join(root, 'managed'), path.join(root, 'claude-home')]) fs.mkdirSync(dir, { recursive: true });
  const port = 47000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(root, 'layer', 'dsh-nassaj-layer.yml'), fs.readFileSync(path.join(governance, 'dsh-nassaj-layer.yml'), 'utf8')
    .replace('https://api.deepseek.com/anthropic', `http://127.0.0.1:${port}/anthropic`));
  fs.cpSync(path.join(governance, 'dsh-policy-plugin'), path.join(root, 'layer', 'dsh-policy-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'managed', 'managed-settings.json'), JSON.stringify(settings));
  const llmLog = path.join(root, 'llm.jsonl');
  const llmChild = spawn(process.execPath, [path.join(here, 'fixtures', 'stage0', 'fake-llm-steps.mjs'), String(port), llmLog], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const llm = () => (fs.existsSync(llmLog) ? fs.readFileSync(llmLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((row: Row) => row.method === 'POST');
  const engine = createClaudeParityEngine({ userId: 1, cwd: ws, home, sessionId: 's', transcriptPath: path.join(root, 't.jsonl'),
    permissionMode: 'bypassPermissions', managedSettingsDir: path.join(root, 'managed'),
    claudeEnv: () => ({ HOME: path.join(root, 'claude-home'), PATH: '/usr/bin:/bin' }) });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: path.join(home, '.tmp'),
    DSH_HOME: path.join(home, '.dsh'), DSH_AGENTS_HOME: path.join(home, '.agents'), DEEPSEEK_API_KEY: 'sk-fake-live', DSH_TELEMETRY_DISABLED: '1' };
  const patches = ['--patch', path.join(root, 'layer', 'dsh-nassaj-layer.yml')];
  const dsh = spawn(process.execPath, [BIN, 'nassaj-acp', '--from-default-profile', 'acp', ...patches],
    { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'pipe'] });
  const run: LiveRun = { root, ws, updates: [], decisions: [], incidents: [], killed: 0, promptReply: null, shellFds: '',
    llmAfterEnd: 0, llmAtEnd: 0, llm, hello: null };
  const broker = createParityBroker({ engine, kill: () => { run.killed += 1; dsh.kill('SIGKILL'); },
    onIncident: (incident: Row) => run.incidents.push(incident), askMember: async () => 'approve',
    log: (entry: Row) => run.decisions.push(entry) });
  const original = broker.receive;
  const tap = { ...broker, receive: async (frame: Row) => { if (frame?.type === 'hello') run.hello = frame; return original(frame); } };
  attachTapped(tap, dsh.stdio[3] as never);
  try {
    await driveAcp(run, dsh, broker, steps);
    run.llmAtEnd = llm().length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    run.llmAfterEnd = llm().length;
  } finally {
    dsh.kill('SIGKILL');
    llmChild.kill('SIGKILL');
  }
  return run;
}

/** broker.attach with a receive tap (records the hello frame). */
function attachTapped(broker: Row, stream: NodeJS.ReadWriteStream) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const frame = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      broker.receive(frame).then((out: Row | null) => { if (out) stream.write(`${JSON.stringify(out)}\n`); });
    }
  });
}

/** initialize → (handshake) → session/new → one prompt carrying the scripted steps. */
async function driveAcp(run: LiveRun, dsh: ChildProcess, broker: Row, steps: (sub: string) => Row[]) {
  const pending = new Map<number, (msg: Row) => void>();
  let buffer = '';
  dsh.stdout!.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const msg = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      const update = msg.params?.update;
      if (update?.sessionUpdate === 'tool_call') run.updates.push({ ...update });
      if (update?.sessionUpdate === 'tool_call_update') {
        run.updates.push(update);
        const call = run.updates.find((u) => u.toolCallId === update.toolCallId && u.sessionUpdate === 'tool_call');
        broker.acpToolUpdate({ callId: update.toolCallId, status: update.status, rawInput: call?.rawInput });
        const text = update.content?.[0]?.content?.text ?? '';
        if (text.includes('SHELL_FDS')) run.shellFds = text;
      }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const request = (method: string, params: Row) => new Promise<Row>((resolve) => {
    pending.set((id += 1), resolve);
    dsh.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'nassaj', version: '0' } });
  for (let i = 0; i < 200 && !broker.state.hello && !broker.state.refusal; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(broker.state.refusal, null, 'handshake refused');
  assert.equal(broker.state.hello, true, 'no handshake before the prompt');
  const session = await request('session/new', { cwd: run.ws, mcpServers: [] });
  const subSteps = [{ name: 'bash', raw: JSON.stringify({ command: 'touch sub-witness', description: 's' }) }, { text: 'sub done' }];
  const sub = `SUB${'\\u005f'}STEPS ${JSON.stringify(subSteps)} END_SUB`;
  run.promptReply = await request('session/prompt', { sessionId: session.result.sessionId,
    prompt: [{ type: 'text', text: `NASSAJ_STEPS ${JSON.stringify(steps(sub))} END_STEPS` }] });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(run.ws, 'sub-witness')); i += 1) await new Promise((r) => setTimeout(r, 100));
}

const subagentStep = (sub: string) => ({ name: 'subagent', raw: `{"description":"sub","prompt":${JSON.stringify(sub).replace('\\\\u005f', '\\u005f')}}` });

describe('T-2089 policy plugin on real dsh', { skip: SKIP }, () => {
  let run: LiveRun;
  before(async () => {
    run = await liveRun({ settings: { permissions: { deny: ['Bash(touch denied-witness)'] } }, steps: (sub) => [
      { name: 'bash', raw: JSON.stringify({ command: 'echo SHELL_FDS; ls /proc/$$/fd | sort -n | tr "\\n" " "', description: 'fds' }) },
      { name: 'bash', raw: JSON.stringify({ command: 'touch denied-witness', description: 'denied' }) },
      { name: 'bash', raw: JSON.stringify({ command: 'touch invalid-witness' }) },
      subagentStep(sub),
      { name: 'bash', raw: JSON.stringify({ command: 'touch allowed-witness', description: 'allowed' }) },
      { text: 'done' },
    ] });
  });
  after(() => { if (run?.root) fs.rmSync(run.root, { recursive: true, force: true }); });

  it('the turn completes without a kill or incident', () => {
    assert.equal(run.promptReply?.result?.stopReason, 'end_turn', JSON.stringify(run.promptReply));
    assert.equal(run.killed, 0);
    // T-2091: tools dsh registers outside the map are reported (dsh_tool_map_drift) and hidden, never fatal.
    assert.deepEqual(run.incidents.filter((incident) => incident.code !== 'dsh_tool_map_drift'), []);
  });
  it('bash children hold only fds 0, 1, 2', () => {
    assert.match(run.shellFds, /SHELL_FDS\n0 1 2 \s*$/, run.shellFds);
  });
  it('a Claude deny rule stops the body; schema-invalid arguments are refused by the plugin', () => {
    assert.equal(fs.existsSync(path.join(run.ws, 'denied-witness')), false);
    assert.equal(fs.existsSync(path.join(run.ws, 'invalid-witness')), false);
    assert.ok(run.updates.some((u) => u.status === 'failed' && /Nassaj: invalid arguments/.test(JSON.stringify(u.content))));
  });
  it('the subagent call is decided by Nassaj and runs once; the allowed call runs', () => {
    assert.equal(fs.existsSync(path.join(run.ws, 'sub-witness')), true);
    assert.equal(fs.existsSync(path.join(run.ws, 'allowed-witness')), true);
    const sub = run.decisions.filter((d) => d.tool === 'bash' && d.agent && d.decision === 'allow');
    assert.ok(sub.some((d) => !run.updates.some((u) => u.toolCallId === d.callId)), 'no decision for a call invisible on ACP');
  });
});

describe('T-2091 probes, unmapped tools and PostToolUse context on real dsh', { skip: SKIP }, () => {
  let run: LiveRun;
  const context = '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"post-hook-context-7"}}';
  before(async () => {
    run = await liveRun({
      settings: { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `echo '${context}'` }] }] } },
      steps: () => [{ name: 'bash', raw: JSON.stringify({ command: 'touch post-witness', description: 'post' }) },
        { name: 'working_directory', raw: JSON.stringify({ cd: '/' }) }, { text: 'done' }] });
  });
  after(() => { if (run?.root) fs.rmSync(run.root, { recursive: true, force: true }); });

  it('P1 and P2 pass on the real binary; the turn completes without a kill', () => {
    assert.equal(run.promptReply?.result?.stopReason, 'end_turn', JSON.stringify(run.promptReply));
    assert.equal(run.hello?.probes?.P1?.ok, true, JSON.stringify(run.hello?.probes));
    assert.equal(run.hello?.probes?.P2?.ok, true, JSON.stringify(run.hello?.probes));
    assert.equal(run.killed, 0);
  });
  it('a tool outside the map is registered by dsh, denied by Nassaj and hidden from the next step', () => {
    const names = (run.hello?.tools ?? []).map((tool: Row) => tool.name);
    assert.ok(names.includes('working_directory'), names.join(' '));
    assert.ok(run.updates.some((u) => u.status === 'failed' && /not allowed/.test(JSON.stringify(u.content))));
    const later = run.llm().slice(1).map((request: Row) => (request.body?.tools ?? []).map((tool: Row) => tool.name));
    assert.ok(later.length > 0 && later.every((tools: string[]) => !tools.includes('working_directory')), JSON.stringify(later));
  });
  it('a PostToolUse additionalContext reaches the model with the tool result', () => {
    assert.equal(fs.existsSync(path.join(run.ws, 'post-witness')), true);
    assert.match(JSON.stringify(run.llm().at(-1)?.body?.messages ?? []), /post-hook-context-7/);
  });
  it('nothing prompts the model after the turn ends', () => {
    assert.equal(run.llmAfterEnd, run.llmAtEnd);
  });
});
