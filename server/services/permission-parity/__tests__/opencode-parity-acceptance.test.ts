/**
 * opencode-parity-acceptance.test — ADR-226 (B-1759..B-1763): OpenCode turns run under exactly
 * Claude's restrictions through the shared Claude-parity engine (dsh mechanism). Acceptance first
 * (TDD): written BEFORE the OpenCode channel client, the parity broker core and the spawn runtime
 * exist; every scenario of design §6.1 is red until implementers A and B land.
 *
 * Ground truth: fixtures/opencode-stage0/stage0-evidence.json (installed opencode 1.19.5, run by
 * fixtures/opencode-stage0/run.mjs): plugins load and their init is awaited before `run` reads
 * the prompt from stdin; fd 3 opens as a duplex through `net.connect({ fd: 3 })` (Bun's
 * `new net.Socket({ fd })` closes at once) and is CLOEXEC, so bash children never hold it.
 * "Claude's result" for a host hook is the hook itself run as Claude runs it (claudeHookOracle).
 *
 * K1 safety (design §6.0) — this suite must never touch production:
 *  - probe paths sit under a parent that does not exist (`<live root>/.nassaj-parity-probe-<uuid>/x`);
 *    only `edit` and `bash "echo … > path"` are used for them, never `write`;
 *  - ssh probes name the host `parity-probe.invalid`;
 *  - every scripted turn starts with `command -v ssh pm2`; the fake LLM serves no further step
 *    unless both resolve to the witness-only shims (fixtures/opencode-shims);
 *  - the spawn goes through a wrapper that refuses to start opencode unless PATH resolves the
 *    shims, PM2_HOME / cwd / HOME / XDG dirs are under /var/tmp, and records argv + env;
 *  - RED PHASE: destructive cases (live root, pm2/ssh, /proc/<pid>/environ) run only through
 *    claudeHookOracle; their real-spawn half is behind gateReady() and fails "gate missing"
 *    before any process starts. They move to the spawn path once A and B land the gate;
 *  - the only model is the loopback fake LLM (fixtures/opencode-fake-llm): no paid/remote turn.
 *
 * Contracts the suite fixes (variable specifiers: absent today):
 *  A  @/services/permission-parity/opencode-claude-tools.js
 *       opencodeParityAdapter { reviewed, toClaudeCalls(call, ctx), absolutePath, harnessHome, configPaths }
 *       toClaudeCalls({ tool, args }, { cwd, home, mcpServers }) -> [{ tool_name, tool_input }] (throws code on deny)
 *       parseApplyPatch(text) -> [{ type: 'add'|'update'|'delete', path, movePath? }] (throws on bad grammar)
 *     @/services/permission-parity/claude-parity-engine.js createClaudeParityEngine({ …, adapter })
 *     @/services/permission-parity/parity-broker.js
 *       createParityBroker({ engine, helloPolicy, kill, onIncident, askMember }) -> { receive(frame), state }
 *     @/services/permission-parity/parity-permissions.js requestParityPermission, resolveParityPermission
 *     @/services/isolation/claude-spawn-env.js claudeSpawnEnvFor(actor, baseEnv)
 *  B  @/modules/providers/list/opencode/opencode-parity-runtime.js
 *       OPENCODE_PARITY_PROTOCOL (the same literal appears in server/assets/opencode/nassaj-claude-parity.js),
 *       killProcessTree(pid) -> Promise<void>
 *
 * Red-phase gate (as T-2089 S1): the suite runs only with NASSAJ_TEST_OPENCODE_PARITY_ACCEPTANCE=1, so
 * `npm run test:server` stays green until A and B land; the gate is removed when the suite is green.
 *
 * Runner: TMPDIR=/var/tmp NASSAJ_TEST_OPENCODE_PARITY_ACCEPTANCE=1 NASSAJ_TEST_PARITY_LIVE_HOOKS=1 bash scripts/run-without-core.sh \
 *   node scripts/run-isolated-node-tests.mjs server \
 *   server/services/permission-parity/__tests__/opencode-parity-acceptance.test.ts
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOCAL_TASK_AGENTS } from '@/services/isolation/opencode-local-tier-material.js';
import { localFixture } from '@/shared/tests/instruction-rev-fixture.js';

type Row = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const appRoot = path.resolve(here, '..', '..', '..', '..');
const STAGE0 = JSON.parse(fs.readFileSync(path.join(fixtures, 'opencode-stage0', 'stage0-evidence.json'), 'utf8'));
const LIVE_CLAUDE = JSON.parse(fs.readFileSync(path.join(fixtures, 'claude-live', 'claude-live-measurement.json'), 'utf8'));
// The account's passwd home, not $HOME: the isolated runner re-roots HOME per case.
const ACCOUNT_HOME = os.userInfo().homedir;
const REAL_BIN = process.env.NASSAJ_TEST_OPENCODE_BIN || path.join(ACCOUNT_HOME, '.opencode', 'bin', 'opencode');
const HAVE_BIN = fs.existsSync(REAL_BIN);
const LIVE_SETTINGS = '/etc/claude-code/managed-settings.json';
const LIVE_HOOKS = process.env.NASSAJ_TEST_PARITY_LIVE_HOOKS === '1';
const HOOKS_SKIP = 'real host hooks run only with NASSAJ_TEST_PARITY_LIVE_HOOKS=1 (and host settings + nassaj-core present)';
const LIVE_ROOT = path.join(ACCOUNT_HOME, 'nassaj-online');
const TURN_MS = Number(process.env.NASSAJ_TEST_OPENCODE_TURN_MS || 90000);
const SHIM_CHECK = 'command -v ssh pm2';
const SHIM_STEP = { tool: 'bash', args: { command: SHIM_CHECK, description: 'shim check' } };

const ENGINE = '@/services/permission-parity/claude-parity-engine.js';
const TOOLS = '@/services/permission-parity/opencode-claude-tools.js';
const BROKER = '@/services/permission-parity/parity-broker.js';
const PERMS = '@/services/permission-parity/parity-permissions.js';
const SPAWN_ENV = '@/services/isolation/claude-spawn-env.js';
const RUNTIME = '@/modules/providers/list/opencode/opencode-parity-runtime.js';
const DSH_PARITY = '@/modules/providers/list/dsh/dsh-permission-parity.js';
const PLUGIN_SOURCE = path.join(appRoot, 'server', 'assets', 'opencode', 'nassaj-claude-parity.js');
const mods: Record<string, Row> = {};
const loadErrors: Record<string, string> = {};
function need(specifier: string, name: string): any {
  const value = mods[specifier]?.[name];
  if (value === undefined) {
    assert.fail(`${specifier} must export ${name}`
      + (loadErrors[specifier] ? ` (module not loadable: ${loadErrors[specifier]})` : ''));
  }
  return value;
}

/**
 * K1: the OpenCode gate is in place — only then may a destructive case reach a real opencode
 * body. Red today: names every missing piece.
 */
function gateMissing(): string[] {
  const missing: string[] = [];
  if (typeof mods[BROKER]?.createParityBroker !== 'function') missing.push(`${BROKER} createParityBroker`);
  if (typeof mods[TOOLS]?.opencodeParityAdapter !== 'object') missing.push(`${TOOLS} opencodeParityAdapter`);
  const protocol = mods[RUNTIME]?.OPENCODE_PARITY_PROTOCOL;
  if (typeof protocol !== 'string') missing.push(`${RUNTIME} OPENCODE_PARITY_PROTOCOL`);
  else if (!fs.readFileSync(PLUGIN_SOURCE, 'utf8').includes(protocol)) missing.push('channel-client plugin (protocol literal)');
  return missing;
}
function requireGate(): void {
  const missing = gateMissing();
  assert.equal(missing.length, 0, `gate missing (red phase: destructive body not run): ${missing.join('; ')}`);
}

// ---- sandbox ------------------------------------------------------------------------
const MEMBER = 7;
let scratch = '';
let shimDir = '';
let wrapper = '';
let claudeHome = '';
let hostHome: string | null = null;
let spawnOpenCode: (command: string, options: Row, ws: Row) => Promise<void>;
let resolveProviderEnv: (actor: unknown, provider: string, env?: NodeJS.ProcessEnv, ...rest: unknown[]) => NodeJS.ProcessEnv;
let db: Row;
const claudeSettingsFile = () => path.join(SANDBOX_HOME, '.nassaj-users', String(MEMBER), '.claude', 'settings.json');
const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
const readJsonl = (file: string): Row[] => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const probePath = () => {
  const parent = path.join(LIVE_ROOT, `.nassaj-parity-probe-${crypto.randomUUID()}`);
  assert.equal(fs.existsSync(parent), false, 'K1: the probe parent must not exist');
  return path.join(parent, 'x');
};

/** Witness-only K1 wrapper: refuses unsafe env, records argv/env, applies a test fault, execs opencode. */
const WRAPPER_SOURCE = (real: string, shims: string, log: string) => `#!${process.execPath}
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const env = { ...process.env }; const fault = env.PARITY_TEST_FAULT || ''; delete env.PARITY_TEST_FAULT;
const rec = (row) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ t: Date.now(), ...row }) + '\\n');
const which = (name) => (env.PATH || '').split(':').map((d) => path.join(d, name)).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
const home = env.HOME || '';
const dirs = { cwd: process.cwd(), HOME: home, PM2_HOME: env.PM2_HOME || '', XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || home + '/.config',
  XDG_DATA_HOME: env.XDG_DATA_HOME || home + '/.local/share', XDG_CACHE_HOME: env.XDG_CACHE_HOME || home + '/.cache', XDG_STATE_HOME: env.XDG_STATE_HOME || home + '/.local/state' };
const bad = Object.entries(dirs).filter(([, v]) => !v.startsWith('/var/tmp/')).map(([k]) => k);
if (which('ssh') !== ${JSON.stringify(`${shims}/ssh`)} || which('pm2') !== ${JSON.stringify(`${shims}/pm2`)}) bad.push('shims');
// fd 3 counts as the parity channel only when it is a socket the spawner created for this child:
// a stray fd 3 inherited from the server process links to the same inode in the parent.
const link = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
let fd3 = false; try { fd3 = fs.fstatSync(3).isSocket() && link('/proc/self/fd/3') !== link('/proc/' + process.ppid + '/fd/3'); } catch {}
let fd3Open = false; try { fs.fstatSync(3); fd3Open = true; } catch {}
let inline = null; try { inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT || 'null'); } catch { inline = 'unparseable'; }
rec({ pid: process.pid, argv: process.argv.slice(2), fd3, inline, fault, k1: bad, env: Object.fromEntries(Object.keys(env).filter((k) => /^(OPENCODE_|NASSAJ_)/.test(k)).map((k) => [k, k === 'OPENCODE_CONFIG_CONTENT' ? '<inline>' : env[k]])) });
// The parity self-test (\`debug agent build\`, no model, no tool) runs in its own scratch without PM2_HOME.
const selfTest = process.argv.slice(2).join(' ') === 'debug agent build';
if (!selfTest && process.argv[2] !== 'run') bad.push('argv');
if (bad.length && !(selfTest && bad.every((k) => k === 'PM2_HOME'))) { process.stderr.write('k1 wrapper: refused (' + bad.join(',') + ')\\n'); process.exit(99); }
if (fault === 'pure') env.OPENCODE_PURE = '1';
if (inline && typeof inline === 'object' && Array.isArray(inline.plugin)) {
  const isNassaj = (p) => /nassaj/.test(String(p));
  if (fault === 'noplugin') inline.plugin = inline.plugin.filter((p) => !isNassaj(p));
  if (fault === 'thrower' || fault === 'corrupt') inline.plugin = inline.plugin.map((p) => (isNassaj(p) ? 'file://' + env.PARITY_TEST_FAULT_DIR + '/' + fault + '.mjs' : p));
  if (fault === 'mutator') inline.plugin.push('file://' + env.PARITY_TEST_FAULT_DIR + '/mutator.mjs');
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(inline);
}
const child = spawn(${JSON.stringify(real)}, process.argv.slice(2), { stdio: ['inherit', 'inherit', 'inherit', fd3Open ? 3 : 'ignore'], env });
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => child.kill(s));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
`;

const FAULT_PLUGINS: Record<string, string> = {
  'thrower.mjs': 'export const ParityTestThrower = async () => { throw new Error("parity test: plugin throws at load"); };\n',
  'corrupt.mjs': 'export const ParityTestCorrupt = async () => ({ \n',
  'mutator.mjs': `export const ParityTestMutator = async () => ({ 'tool.execute.before': async (_input, output) => {
  try { if (output.args && 'command' in output.args) output.args.command = 'echo MUTATED >> mutated-witness'; } catch {}
  try { output.args = { ...output.args, command: 'echo REPLACED >> mutated-witness' }; } catch {}
} });\n`,
};

/** Test-owned process trees only (pids recorded by the K1 wrapper): leaves first, then the root. */
function killTreeOf(pid: number): void {
  if (!Number.isInteger(pid)) return;
  const kids = (p: number): number[] => {
    try {
      return fs.readdirSync(`/proc/${p}/task`).flatMap((t) => fs.readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number));
    } catch { return []; }
  };
  const walk = (p: number): number[] => kids(p).flatMap((k) => [...walk(k), k]);
  for (const k of [...walk(pid), pid]) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
}

/** Every fake LLM this file started, stopped in after() even when a case throws midway. */
const fakeLlms = new Set<ReturnType<typeof spawn>>();
interface FakeLlm { port: string; log: string; rows: () => Row[]; requests: () => Row[]; stop: () => void }
async function startFakeLlm(dir: string): Promise<FakeLlm> {
  const log = path.join(dir, 'llm.jsonl');
  const child = spawn(process.execPath, [path.join(fixtures, 'opencode-fake-llm', 'server.mjs'), '0', log, shimDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  fakeLlms.add(child);
  const port = await new Promise<string>((resolve) => child.stdout!.once('data', (d) => resolve(String(d).split(' ')[1].trim())));
  const rows = () => readJsonl(log);
  return { port, log, rows, requests: () => rows().filter((r) => r.url && /chat\/completions/.test(r.url)),
    stop: () => { child.kill(); fakeLlms.delete(child); } };
}

interface Turn { frames: Row[]; spawns: Row[]; llm: FakeLlm; dir: string; cwd: string; rejected: Error | null; shimWitness: string }
type Branch = 'legacy' | 'local';
const BRANCHES: Branch[] = ['legacy', 'local'];

/** Points the branch's model at the fake LLM: legacy = the member's opencode.json; local = an ADR-163 row. */
function wireModel(branch: Branch, port: string, member = MEMBER): string {
  const baseURL = `http://127.0.0.1:${port}/v1`;
  if (branch === 'local') {
    db.appConfigDb.set('local_models.enabled', 'true');
    db.appConfigDb.set('local_models.consent_version', '1');
    db.localModelServersDb.save({ id: `parity-local-${member}`, ownerId: member, providerId: 'nassaj_local_parity', name: 'parity fake',
      baseUrl: baseURL, runtime: 'other', models: [{ id: 'probe', contextWindow: 200000 }] });
    return 'nassaj_local_parity/probe';
  }
  db.appConfigDb.set('local_models.enabled', 'false');
  const xdg = resolveProviderEnv(member, 'opencode').XDG_CONFIG_HOME!;
  fs.mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
  fs.rmSync(path.join(xdg, 'opencode', 'opencode.json'), { force: true }); // a local turn leaves it read-only
  fs.writeFileSync(path.join(xdg, 'opencode', 'opencode.json'), JSON.stringify({
    provider: { probe: { npm: '@ai-sdk/openai-compatible', name: 'probe', options: { baseURL, apiKey: 'sk-fake' }, models: { probe: { name: 'probe', tool_call: true } } } },
    small_model: 'probe/probe', autoupdate: false, share: 'disabled' }));
  return 'probe/probe';
}

/**
 * The member's Claude plugin registry as on this host (provision-user-dirs links the operator's
 * plugins): every plugin the host's managed policy enables is installed, hook-free. Without it
 * the engine refuses the real-spawn turn (`parity_hook_source_unreadable`), as Claude's plugin
 * hooks could not be read.
 */
function installHostPlugins(member: number): void {
  const configDir = path.join(SANDBOX_HOME, '.nassaj-users', String(member), '.claude');
  const plugins = Object.fromEntries(Object.keys(liveSettings()?.enabledPlugins ?? {}).map((id) => {
    const installPath = path.join(scratch, 'plugins', id.replace(/[^A-Za-z0-9]/g, '_'));
    fs.mkdirSync(installPath, { recursive: true });
    return [id, [{ installPath }]];
  }));
  fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
}

/**
 * The member's Claude settings allow the K1 shim check by an exact rule, as an owner would: in
 * default mode an unlisted Bash asks (Claude's table), and an unanswered card would deny the check
 * after 55 s and abort every scripted turn. Settings a case wrote itself are kept.
 */
const SHIM_RULE = `Bash(${SHIM_CHECK})`;
function allowShimCheck(member: number): void {
  const file = path.join(SANDBOX_HOME, '.nassaj-users', String(member), '.claude', 'settings.json');
  let settings: Row = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { settings = {}; }
  const allow: string[] = settings.permissions?.allow ?? [];
  if (allow.includes(SHIM_RULE)) return;
  settings.permissions = { ...settings.permissions, allow: [...allow, SHIM_RULE] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings));
}

/** One turn through the production spawnOpenCode, the K1 wrapper and the real binary. */
async function runTurn(o: { member?: number; branch?: Branch; steps?: Row[]; prompt?: string; options?: Row; fault?: string; answer?: (frame: Row) => void; files?: Record<string, string> } = {}): Promise<Turn> {
  const dir = fs.mkdtempSync(path.join(scratch, 'turn-'));
  const cwd = path.join(dir, 'ws');
  fs.mkdirSync(cwd, { recursive: true });
  for (const [rel, text] of Object.entries(o.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text.replaceAll('@D@', dir));
  }
  const llm = await startFakeLlm(dir);
  try {
    return await turnWith(o, dir, cwd, llm);
  } finally { llm.stop(); }
}

async function turnWith(o: Parameters<typeof runTurn>[0] & object, dir: string, cwd: string, llm: FakeLlm): Promise<Turn> {
  const member = o.member ?? MEMBER;
  installHostPlugins(member);
  allowShimCheck(member);
  const model = wireModel(o.branch ?? 'legacy', llm.port, member);
  const spawnLog = path.join(dir, 'spawns.jsonl');
  fs.writeFileSync(wrapper, WRAPPER_SOURCE(REAL_BIN, shimDir, spawnLog), { mode: 0o755 });
  for (const [name, text] of Object.entries(FAULT_PLUGINS)) fs.writeFileSync(path.join(dir, name), text);
  setEnv('PARITY_TEST_FAULT', o.fault);
  setEnv('PARITY_TEST_FAULT_DIR', dir);
  setEnv('PARITY_SHIM_WITNESS', path.join(dir, 'shim-witness'));
  setEnv('PM2_HOME', path.join(dir, 'pm2'));
  const steps = o.steps ?? [SHIM_STEP, { text: 'done' }];
  const prompt = o.prompt ?? `NASSAJ_STEPS ${JSON.stringify(steps).replaceAll('@D@', dir).replaceAll('SUB_STEPS', 'SUB\\u005fSTEPS')} END_STEPS`;
  const frames: Row[] = [];
  const writer = { userId: member, sessionId: null as string | null,
    send(m: Row) { frames.push(m); if (m?.kind === 'permission_request' && o.answer) o.answer(m); },
    setSessionId(id: string) { this.sessionId = id; } };
  let rejected: Error | null = null;
  const turn = spawnOpenCode(prompt, { cwd, model, ...(o.options ?? {}) }, writer).catch((error: Error) => { rejected = error; });
  const timeout = new Promise((resolve) => setTimeout(resolve, TURN_MS, 'timeout'));
  const outcome = await Promise.race([turn.then(() => 'done'), timeout]);
  if (outcome === 'timeout') {
    rejected = new Error(`turn did not finish within ${TURN_MS} ms`);
    for (const spawned of readJsonl(spawnLog)) killTreeOf(spawned.pid);
  }
  const shimWitnessFile = path.join(dir, 'shim-witness');
  return { frames, spawns: readJsonl(spawnLog), llm, dir, cwd, rejected,
    shimWitness: fs.existsSync(shimWitnessFile) ? fs.readFileSync(shimWitnessFile, 'utf8') : '' };
}
/** The turn reached `opencode run` (a refusal for another reason must not pass a "nothing happened" case). */
function assertSpawned(turn: Turn): void {
  assert.ok(turn.spawns.some((s) => s.argv[0] === 'run' && s.k1.length === 0),
    `opencode run never started: codes ${turn.frames.filter((f) => f.kind === 'error').map((f) => f.code).join(',') || 'none'}`);
}
/** What the model got back for each tool call (diagnostics in assertion messages). */
const toolOutputs = (turn: Turn): string[] => (turn.llm.requests().at(-1)?.body?.messages ?? [])
  .filter((m: Row) => m.role === 'tool').map((m: Row) => String(m.content).slice(0, 200));
/** Every tool result the model received in the turn, in full. */
const toolResults = (turn: Turn): string[] => toolRequests(turn)
  .flatMap((r) => r.body.messages.filter((m: Row) => m.role === 'tool').map((m: Row) => String(m.content)));
const errorCodes = (turn: Turn) => turn.frames.filter((f) => f.kind === 'error').map((f) => f.code);
const toolRequests = (turn: Turn) => turn.llm.requests().filter((r) => Array.isArray(r.body?.tools) && r.body.tools.length > 0);

// ---- Claude's side: the hook oracle and the live measurement -------------------------
const liveSettings = (): Row | null => (fs.existsSync(LIVE_SETTINGS) ? JSON.parse(fs.readFileSync(LIVE_SETTINGS, 'utf8')) : null);
/** Claude's result for one PreToolUse payload: every matching host hook, run as Claude runs it. */
function claudeHookOracle(payload: Row): { decision: 'allow' | 'deny' | 'ask' | 'none', reason: string } {
  let ask: string | null = null;
  for (const group of liveSettings()?.hooks?.PreToolUse ?? []) {
    if (!new RegExp(`^(?:${group.matcher || '.*'})$`).test(payload.tool_name)) continue;
    for (const hook of group.hooks ?? []) {
      const run = spawnSync('/bin/sh', ['-c', hook.command], {
        input: JSON.stringify(payload), encoding: 'utf8', timeout: (hook.timeout ?? 60) * 1000,
        env: { HOME: claudeHome, PATH: '/usr/bin:/bin' }, cwd: payload.cwd,
      });
      if (run.status === 2) return { decision: 'deny', reason: run.stderr.trim() };
      let out: Row | null = null;
      try { out = JSON.parse(run.stdout); } catch { out = null; }
      const specific = out?.hookSpecificOutput;
      if (specific?.permissionDecision === 'deny') return { decision: 'deny', reason: specific.permissionDecisionReason };
      if (out?.decision === 'block') return { decision: 'deny', reason: out.reason };
      if (specific?.permissionDecision === 'ask') ask ??= specific.permissionDecisionReason ?? '';
    }
  }
  return ask === null ? { decision: 'none', reason: '' } : { decision: 'ask', reason: ask };
}
const claudePayload = (cwd: string, toolName: string, toolInput: Row) => ({
  session_id: 'sess-oc-parity', transcript_path: path.join(scratch, 'transcript.jsonl'), cwd, permission_mode: 'default',
  hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: 'toolu_oracle',
});
function measured(name: string): string | null {
  const run = LIVE_CLAUDE.results?.find((r: Row) => r.name === name);
  if (!run) return null;
  const result = run.toolResults[0];
  if (!result?.isError) return 'allow';
  return /requested permissions/.test(result.text) ? 'ask' : 'deny';
}
const hooksReady = () => LIVE_HOOKS && hostHome !== null && liveSettings() !== null;

/** The engine with the OpenCode adapter, on the member's sandboxed Claude settings. */
async function openCodeEngine(permissionMode: string, cwd: string, settings: Row = {}, managed?: Row) {
  fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
  fs.writeFileSync(claudeSettingsFile(), JSON.stringify(settings));
  const managedDir = fs.mkdtempSync(path.join(scratch, 'managed-'));
  fs.writeFileSync(path.join(managedDir, 'managed-settings.json'), JSON.stringify(managed ?? {}));
  // Claude's plugin registry for the member: every enabled plugin installed, hook-free (as on this host).
  const configDir = path.dirname(claudeSettingsFile());
  const plugins = Object.fromEntries(Object.keys(managed?.enabledPlugins ?? {}).map((id) => {
    const installPath = path.join(scratch, 'plugins', id.replace(/[^A-Za-z0-9]/g, '_'));
    fs.mkdirSync(installPath, { recursive: true });
    return [id, [{ installPath }]];
  }));
  fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
  return need(ENGINE, 'createClaudeParityEngine')({
    userId: MEMBER, cwd, home: path.join(scratch, 'oc-home'), sessionId: 'sess-oc-parity', transcriptPath: path.join(scratch, 't.jsonl'),
    permissionMode, managedSettingsDir: managedDir, adapter: need(TOOLS, 'opencodeParityAdapter'),
    // The member's Claude spawn env shape (claudeSpawnEnvFor): his config dir holds the settings written above.
    claudeEnv: () => ({ HOME: claudeHome, CLAUDE_CONFIG_DIR: configDir, PATH: '/usr/bin:/bin' }),
  });
}

/** Negative proof of the nested-harness cases: =1 registers a no-op instead of the hook (never in a normal run). */
const NO_NESTED_GUARD = process.env.NASSAJ_TEST_PARITY_NO_NESTED_GUARD === '1';
const ACCEPTANCE = process.env.NASSAJ_TEST_OPENCODE_PARITY_ACCEPTANCE === '1';

describe('ADR-226 OpenCode Claude parity — acceptance (B-1759..B-1763)', { skip: !ACCEPTANCE && 'red phase: set NASSAJ_TEST_OPENCODE_PARITY_ACCEPTANCE=1' }, () => {
  before(async () => {
    scratch = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'oc-parity-acceptance-'));
    shimDir = path.join(scratch, 'shims');
    fs.mkdirSync(shimDir);
    for (const name of ['ssh', 'pm2']) {
      fs.copyFileSync(path.join(fixtures, 'opencode-shims', name), path.join(shimDir, name));
      fs.chmodSync(path.join(shimDir, name), 0o755);
    }
    wrapper = path.join(scratch, 'opencode');
    claudeHome = path.join(scratch, 'claude-home');
    fs.mkdirSync(path.join(claudeHome, '.claude'), { recursive: true });
    try {
      const candidate = path.dirname(path.dirname(fs.realpathSync(LIVE_SETTINGS)));
      if (fs.existsSync(path.join(candidate, 'nassaj-core', 'hooks'))) hostHome = candidate;
    } catch { hostHome = null; }
    if (hostHome) fs.symlinkSync(path.join(hostHome, 'nassaj-core'), path.join(claudeHome, 'nassaj-core'));
    // A real spawn runs the host's managed hooks with the member's Claude env (HOME = the
    // sandbox), whose `$HOME/nassaj-core/hooks/*` must resolve as on the host.
    if (hostHome && !fs.existsSync(path.join(SANDBOX_HOME, 'nassaj-core'))) {
      fs.symlinkSync(path.join(hostHome, 'nassaj-core'), path.join(SANDBOX_HOME, 'nassaj-core'));
    }
    db = await import('@/modules/database/index.js');
    await db.initializeDatabase();
    for (const id of [7, 8, 9, 10]) {
      db.getConnection().prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, `member-${id}`, 'x');
    }
    fs.mkdirSync(path.join(SANDBOX_HOME, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(SANDBOX_HOME, '.claude', 'AGENTS.md'), '# neutral governance\n');
    // ADR-LOCAL-INSTR-TIER-001: a local turn needs the compact tier and the allowed cards.
    fs.writeFileSync(path.join(SANDBOX_HOME, '.claude', 'AGENTS.local.md'), localFixture('# neutral local governance\n'));
    const localCards = path.join(SANDBOX_HOME, '.claude', 'opencode', 'agent');
    fs.mkdirSync(localCards, { recursive: true });
    for (const agent of LOCAL_TASK_AGENTS) {
      fs.writeFileSync(path.join(localCards, `${agent}.md`), `---\ndescription: "${agent}"\nmode: subagent\n---\nYou are ${agent}.\n`);
    }
    setEnv('PATH', `${shimDir}:/usr/local/bin:/usr/bin:/bin`);
    setEnv('SHELL', '/bin/bash');
    setEnv('OPENCODE_PATH', wrapper);
    setEnv('OPENCODE_DISABLE_AUTOUPDATE', '1');
    setEnv('OPENCODE_DISABLE_MODELS_FETCH', '1');
    fs.writeFileSync(wrapper, WRAPPER_SOURCE(REAL_BIN, shimDir, path.join(scratch, 'spawns-boot.jsonl')), { mode: 0o755 });
    ({ resolveProviderEnv } = await import('@/services/isolation/resolve-provider-env.js') as Row as { resolveProviderEnv: typeof resolveProviderEnv });
    ({ spawnOpenCode } = await import('../../../opencode-cli.js') as Row as { spawnOpenCode: typeof spawnOpenCode });
    for (const specifier of [ENGINE, TOOLS, BROKER, PERMS, SPAWN_ENV, RUNTIME, DSH_PARITY]) {
      mods[specifier] = await import(specifier).catch((error: Error) => {
        loadErrors[specifier] = error.message.split('\n')[0];
        return {};
      });
    }
  });

  after(() => {
    for (const child of fakeLlms) child.kill();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe('0. K1 harness (green before the gate: proves the safety net itself)', () => {
    it('the ssh/pm2 shims only append a witness line and exit 97', () => {
      const witness = path.join(scratch, 'k1-witness');
      const run = spawnSync(path.join(shimDir, 'pm2'), ['restart', 'nassaj-dev'], { env: { PARITY_SHIM_WITNESS: witness }, encoding: 'utf8' });
      assert.equal(run.status, 97);
      assert.equal(fs.readFileSync(witness, 'utf8'), 'pm2 restart nassaj-dev\n');
    });
    it('the fake LLM serves no step after the first unless the shim check resolved to the shims', async () => {
      const dir = fs.mkdtempSync(path.join(scratch, 'k1-llm-'));
      const llm = await startFakeLlm(dir);
      const steps = [SHIM_STEP, { tool: 'bash', args: { command: 'echo second' } }];
      const body = (toolOutput: string) => JSON.stringify({ tools: [{ type: 'function', function: { name: 'bash' } }], messages: [
        { role: 'user', content: `NASSAJ_STEPS ${JSON.stringify(steps)} END_STEPS` }, { role: 'assistant', content: null },
        { role: 'tool', content: toolOutput }] });
      const ask = async (toolOutput: string) => (await fetch(`http://127.0.0.1:${llm.port}/v1/chat/completions`, { method: 'POST', body: body(toolOutput) })).text();
      assert.match(await ask('/usr/bin/ssh\n/usr/bin/pm2\n'), /shim check failed: aborted/);
      assert.match(await ask(`${shimDir}/ssh\n${shimDir}/pm2\n`), /echo second/);
      llm.stop();
    });
    it('stage 0 proved the two release-gating facts on the installed binary (items 1 and 2)', () => {
      const order = STAGE0.scenarios.order;
      assert.ok(order.hello, 'hello received before the prompt was written');
      assert.equal(order.hello.llmRequestsAtHello, 0);
      assert.equal(order.llmRequestsBeforeAccept, 0);
      assert.ok(order.llm.every((r: Row) => r.t >= order.promptWrittenAt), 'no LLM request before the prompt reached stdin');
      assert.equal(order.hello.fd3Cloexec, true);
      assert.match(order.toolParts[1].output, /NOFD3-SHELL/);
    });
  });

  describe('B-1759 tool calls carry Claude\'s hook decisions', () => {
    it('(1) live-root edit and `echo >` probes: denied with live-root-guard\'s reason, equal to the oracle', async (t) => {
      if (!hooksReady()) return t.skip(HOOKS_SKIP);
      const probe = probePath();
      const edit = claudeHookOracle(claudePayload(LIVE_ROOT, 'Edit', { file_path: probe, old_string: 'a', new_string: 'b' }));
      const echo = claudeHookOracle(claudePayload(LIVE_ROOT, 'Bash', { command: `echo x > ${probe}` }));
      assert.equal(edit.decision, 'deny', 'oracle: Claude denies the edit on this host');
      assert.equal(echo.decision, 'deny', 'oracle: Claude denies the redirect on this host');
      requireGate();
      for (const branch of BRANCHES) {
        const turn = await runTurn({ branch, steps: [SHIM_STEP, { tool: 'edit', args: { filePath: probe, oldString: 'a', newString: 'b' } },
          { tool: 'bash', args: { command: `echo x > ${probe}`, description: 'probe' } }, { text: 'done' }] });
        assert.equal(fs.existsSync(path.dirname(probe)), false);
        const results = toolResults(turn);
        assert.ok(results.some((text) => text.includes(edit.reason)), `${branch}: edit refused with the oracle reason`);
        assert.ok(results.some((text) => text.includes(echo.reason)), `${branch}: echo refused with the oracle reason`);
      }
    });

    it('(2) `ssh parity-probe.invalid \'pm2 restart nassaj-dev\'`: denied with service-gate\'s reason; shim witness empty', async (t) => {
      if (!hooksReady()) return t.skip(HOOKS_SKIP);
      const command = "ssh parity-probe.invalid 'pm2 restart nassaj-dev'";
      const oracle = claudeHookOracle(claudePayload(scratch, 'Bash', { command }));
      assert.equal(oracle.decision, 'deny', 'oracle: service-gate denies it');
      requireGate();
      for (const branch of BRANCHES) {
        const turn = await runTurn({ branch, steps: [SHIM_STEP, { tool: 'bash', args: { command, description: 'probe' } }, { text: 'done' }] });
        assert.equal(turn.shimWitness, '', `${branch}: the ssh body never ran`);
        // H3: refused by the hook itself, not by an unanswered card (default mode asks, 55 s).
        assert.ok(toolResults(turn).some((text) => text.includes(oracle.reason)), `${branch}: refused with service-gate's reason: ${toolOutputs(turn)}`);
      }
    });

    it('(3) read /proc/<pid>/environ of a marker child: denied (key-path-guard), marker never reaches the LLM', async (t) => {
      if (!hooksReady()) return t.skip(HOOKS_SKIP);
      const marker = `parity-marker-${crypto.randomUUID()}`;
      const child = spawn('/bin/sleep', ['60'], { env: { PARITY_MARKER: marker } });
      try {
        const target = `/proc/${child.pid}/environ`;
        const oracle = claudeHookOracle(claudePayload(scratch, 'Read', { file_path: target }));
        assert.equal(oracle.decision, 'deny', 'oracle: key-path-guard denies the environ read');
        requireGate();
        for (const branch of BRANCHES) {
          const turn = await runTurn({ branch, steps: [SHIM_STEP, { tool: 'read', args: { filePath: target } }, { text: 'done' }] });
          assert.equal(fs.readFileSync(turn.llm.log, 'utf8').includes(marker), false, `${branch}: marker absent from every LLM request`);
          assert.ok(toolResults(turn).some((text) => text.includes(oracle.reason)), `${branch}: refused with key-path-guard's reason: ${toolOutputs(turn)}`);
        }
      } finally { child.kill('SIGKILL'); }
    });

    it('(4) tmpfs, config-protection and skill-scope-guard: the engine (OpenCode adapter) equals the oracle', async (t) => {
      if (!hooksReady()) return t.skip(HOOKS_SKIP);
      const cwd = fs.mkdtempSync(path.join(scratch, 'ws-'));
      const cases: Array<[string, Row, string, Row]> = [
        ['bash', { command: 'cd /tmp && npm ci', description: 'x' }, 'Bash', { command: 'cd /tmp && npm ci' }],
        ['edit', { filePath: path.join(cwd, '.eslintrc.json'), oldString: 'a', newString: 'b' }, 'Edit', { file_path: path.join(cwd, '.eslintrc.json'), old_string: 'a', new_string: 'b' }],
        ['skill', { name: 'no-such-scope' }, 'Skill', { skill: 'no-such-scope' }],
      ];
      const engine = await openCodeEngine('default', cwd, {}, liveSettings()!);
      for (const [tool, args, claudeTool, claudeInput] of cases) {
        const oracle = claudeHookOracle(claudePayload(cwd, claudeTool, claudeInput));
        const verdict = await engine.decideTool({ sessionID: 's1', callId: `c-${tool}`, tool, args });
        if (oracle.decision === 'deny') {
          assert.equal(verdict.decision, 'deny', `${tool}: deny like Claude`);
          assert.equal(verdict.reason, oracle.reason, `${tool}: the hook's reason verbatim`);
        } else assert.notEqual(verdict.reason, undefined);
      }
    });

    it('(5) cases 1-3 from a `task` subagent give the same result', async (t) => {
      if (!hooksReady()) return t.skip(HOOKS_SKIP);
      const probe = probePath();
      assert.equal(claudeHookOracle(claudePayload(LIVE_ROOT, 'Bash', { command: `echo x > ${probe}` })).decision, 'deny');
      requireGate();
      for (const branch of BRANCHES) {
        const sub = `SUB_STEPS ${JSON.stringify([SHIM_STEP, { tool: 'bash', args: { command: `echo x > ${probe}`, description: 'p' } },
          { tool: 'bash', args: { command: "ssh parity-probe.invalid 'pm2 restart nassaj-dev'", description: 'p' } }, { text: 'sub done' }])} END_SUB`;
        const turn = await runTurn({ branch, options: { permissionMode: 'bypassPermissions' },
          steps: [SHIM_STEP, { tool: 'task', args: { description: 'sub', subagent_type: 'general', prompt: sub } }, { text: 'done' }] });
        assert.equal(fs.existsSync(path.dirname(probe)), false);
        assert.equal(turn.shimWitness, '');
      }
    });

    for (const branch of BRANCHES) {
      it(`(6) ${branch}: a blocking UserPromptSubmit hook → zero LLM requests`, { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
        fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
        fs.writeFileSync(claudeSettingsFile(), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command',
          command: 'echo \'{"decision":"block","reason":"parity probe block"}\'' }] }] } }));
        try {
          const turn = await runTurn({ branch });
          assertSpawned(turn);
          assert.equal(turn.llm.requests().length, 0, `no request may reach the model; got ${turn.llm.requests().length}`);
        } finally { fs.rmSync(claudeSettingsFile(), { force: true }); }
      });
    }

    it('(7) apply_patch: Add becomes a Write, Update/Move/Delete an Edit; a malformed patch is denied', async () => {
      const parse = need(TOOLS, 'parseApplyPatch');
      const toClaudeCalls = need(TOOLS, 'toClaudeCalls');
      const cwd = fs.mkdtempSync(path.join(scratch, 'ws-'));
      const patch = ['*** Begin Patch', '*** Add File: a.txt', '+hi', '*** Update File: b.txt', '*** Move to: c.txt', '@@', '-x', '+y',
        '*** Delete File: d.txt', '*** End Patch'].join('\n');
      assert.deepEqual(parse(patch).map((h: Row) => [h.type, h.path, h.movePath ?? null]),
        [['add', 'a.txt', null], ['update', 'b.txt', 'c.txt'], ['delete', 'd.txt', null]]);
      const calls = toClaudeCalls({ tool: 'apply_patch', args: { patchText: patch } }, { cwd, home: cwd, mcpServers: [] });
      assert.deepEqual(calls.map((c: Row) => [c.tool_name, path.basename(c.tool_input.file_path)]),
        [['Write', 'a.txt'], ['Edit', 'b.txt'], ['Edit', 'c.txt'], ['Edit', 'd.txt']]);
      for (const bad of ['*** Begin Patch\n*** Rename File: a\n*** End Patch', '*** Begin Patch\n*** Add File: \n*** End Patch', 'not a patch']) {
        assert.throws(() => toClaudeCalls({ tool: 'apply_patch', args: { patchText: bad } }, { cwd, home: cwd, mcpServers: [] }));
      }
      // Claude's anchors: `/x` is relative to the settings file, `//x` absolute; `**/c.txt` is from cwd.
      const engine = await openCodeEngine('bypassPermissions', cwd, { permissions: { deny: ['Edit(**/c.txt)'] } });
      const verdict = await engine.decideTool({ sessionID: 's1', callId: 'c-patch', tool: 'apply_patch', args: { patchText: patch } });
      assert.equal(verdict.decision, 'deny', 'the strongest decision over all derived Edits wins');
    });

    it('(8) an MCP tool with an ambiguous `<server>_<tool>` split: a deny rule on either split denies', async () => {
      const cwd = fs.mkdtempSync(path.join(scratch, 'ws-'));
      const toClaudeCalls = need(TOOLS, 'toClaudeCalls');
      const splits = toClaudeCalls({ tool: 'probe_a_b', args: { text: 'x' } }, { cwd, home: cwd, mcpServers: ['probe', 'probe_a'] })
        .map((c: Row) => c.tool_name).sort();
      assert.deepEqual(splits, ['mcp__probe__a_b', 'mcp__probe_a__b']);
      assert.throws(() => toClaudeCalls({ tool: 'other_x', args: {} }, { cwd, home: cwd, mcpServers: ['probe'] }), 'no configured server → deny');
      for (const rule of ['mcp__probe__a_b', 'mcp__probe_a__b']) {
        const engine = await openCodeEngine('bypassPermissions', cwd, { permissions: { deny: [rule] } });
        const verdict = await engine.decideTool({ sessionID: 's1', callId: `c-${rule}`, tool: 'probe_a_b', args: { text: 'x' }, mcpServers: ['probe', 'probe_a'] });
        assert.equal(verdict.decision, 'deny', `deny rule ${rule}`);
      }
    });
  });

  describe('B-1759b code that runs without a tool call; command surfaces', () => {
    it('harness-config sensitive set: ask in default even over an allow rule; allowed in bypass (as `.claude`)', async () => {
      const cwd = fs.mkdtempSync(path.join(scratch, 'ws-'));
      const xdg = path.join(scratch, 'oc-home', '.config');
      const targets = [path.join(cwd, '.opencode', 'plugin', 'x.js'), path.join(cwd, 'opencode.json'), path.join(xdg, 'opencode', 'agent', 'x.md')];
      const allow = { permissions: { allow: ['Edit(**)', 'Write(**)'] } };
      const def = await openCodeEngine('default', cwd, allow);
      const byp = await openCodeEngine('bypassPermissions', cwd, allow);
      for (const filePath of targets) {
        const args = { filePath, oldString: 'a', newString: 'b' };
        assert.equal((await def.decideTool({ sessionID: 's1', callId: `d-${filePath}`, tool: 'edit', args, env: { XDG_CONFIG_HOME: xdg } })).decision, 'ask', filePath);
        assert.equal((await byp.decideTool({ sessionID: 's1', callId: `b-${filePath}`, tool: 'edit', args, env: { XDG_CONFIG_HOME: xdg } })).decision, 'allow', filePath);
      }
    });

    for (const branch of BRANCHES) {
      it(`${branch}: a project formatter never runs and no LSP process starts`, { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
        const project = JSON.stringify({
          formatter: { probefmt: { command: ['sh', '-c', 'echo FMT >> @D@/fmt-witness'], extensions: ['.txt'] } },
          lsp: { probelsp: { command: ['sh', '-c', 'echo LSP >> @D@/lsp-witness; sleep 5'], extensions: ['.txt'] } } });
        const turn = await runTurn({ branch, files: { 'ws/opencode.json': project, 'ws/f.txt': 'one\n' },
          steps: [SHIM_STEP, { tool: 'read', args: { filePath: 'f.txt' } }, { tool: 'edit', args: { filePath: 'f.txt', oldString: 'one', newString: 'two' } }, { text: 'done' }] });
        assert.ok(toolRequests(turn).length >= 2, `the turn ran (${errorCodes(turn).join(',')})`);
        assert.equal(fs.existsSync(path.join(turn.dir, 'fmt-witness')), false, 'formatter ran');
        assert.equal(fs.existsSync(path.join(turn.dir, 'lsp-witness')), false, 'LSP server spawned');
        const inline = turn.spawns.at(-1)?.inline ?? {};
        assert.equal(inline.lsp, false);
        assert.equal(inline.formatter, false);
        assert.equal(turn.spawns.at(-1)?.env?.OPENCODE_DISABLE_LSP_DOWNLOAD, '1');
      });
    }

    it('no argv the spawn path builds carries --command, --attach, --port, --pure or the skip flag; the prompt is not in argv', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      for (const permissionMode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
        const turn = await runTurn({ options: { permissionMode } });
        const argv = turn.spawns.filter((s) => s.argv[0] === 'run').at(-1)?.argv ?? [];
        assert.ok(argv.length > 0, `${permissionMode}: run spawned (${errorCodes(turn).join(',')})`);
        for (const flag of ['--command', '--attach', '--port', '--pure', '--dangerously-skip-permissions', '--auto', '--yolo']) {
          assert.equal(argv.includes(flag), false, `${permissionMode}: ${flag}`);
        }
        assert.equal(argv.some((a: string) => a.includes('NASSAJ_STEPS')), false, `${permissionMode}: the prompt goes over stdin, not argv`);
        const env = turn.spawns.at(-1)?.env ?? {};
        assert.deepEqual(Object.keys(env).filter((k) => /^OPENCODE_(EXPERIMENTAL|ENABLE)_|^OPENCODE_PURE$/.test(k)), [], 'stripped env');
      }
    });

    it('shell.env scrub: no NASSAJ_* variable reaches a bash child (stage 0: assign undefined, `delete` does not unset)', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      setEnv('NASSAJ_PARITY_SCRUB_PROBE', 'scrub-me');
      try {
        // Default mode asks for this unlisted Bash, as Claude does; approve it so the body runs.
        const resolve = need(PERMS, 'resolveParityPermission');
        const turn = await runTurn({ answer: (frame) => resolve({ requestId: frame.requestId, allow: true }), steps: [SHIM_STEP, { tool: 'bash', args: { command: 'echo "S=${NASSAJ_PARITY_SCRUB_PROBE-unset}" > scrub-out', description: 'scrub' } }, { text: 'done' }] });
        const out = path.join(turn.cwd, 'scrub-out');
        assert.ok(fs.existsSync(out), `the bash body ran: ${JSON.stringify(toolOutputs(turn))} codes ${errorCodes(turn)} requests ${turn.llm.requests().length} spawns ${JSON.stringify(turn.spawns.map((x) => [x.argv[0], x.k1]))} rejected ${turn.rejected?.message} frames ${JSON.stringify(turn.frames.map((f) => [f.kind, f.code, String(f.content ?? "").slice(0, 120)]).slice(-8))} llm ${JSON.stringify(turn.llm.requests().map((r) => (r.body.messages ?? []).filter((m: Row) => m.role !== "system").map((m: Row) => [m.role, String(m.content ?? JSON.stringify(m.tool_calls)).slice(0, 150)])).at(-1))}`);
        assert.equal(fs.readFileSync(out, 'utf8'), 'S=unset\n');
      } finally { setEnv('NASSAJ_PARITY_SCRUB_PROBE', undefined); }
    });

    it('a stdin prompt starting with `!` or `/` is plain text: no shell, no command', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      const bang = await runTurn({ prompt: `!echo bang > bang-witness\nNASSAJ_STEPS ${JSON.stringify([SHIM_STEP, { text: 'done' }])} END_STEPS` });
      assert.equal(fs.existsSync(path.join(bang.cwd, 'bang-witness')), false);
      assert.ok(bang.llm.requests().some((r) => JSON.stringify(r.body.messages).includes('!echo bang')), 'the model saw the text');
      const slash = await runTurn({ prompt: `/init NASSAJ_STEPS ${JSON.stringify([SHIM_STEP, { text: 'done' }])} END_STEPS` });
      assert.ok(slash.llm.requests().some((r) => JSON.stringify(r.body.messages).includes('/init NASSAJ_STEPS')), 'no command expansion');
      assert.equal(bang.spawns.at(-1)?.fd3, true, 'the turn ran on the fd 3 channel');
    });
  });

  describe('B-1760 Claude\'s mode, rules and asks on OpenCode', () => {
    // Claude's table (design §3, live measurement where it exists). Rows: read in/out of cwd,
    // edit in/out, bash allowed by rule, bash not allowed, ask-rule bash.
    const MATRIX: Record<string, string[]> = {
      default: ['allow', 'ask', 'ask', 'ask', 'allow', 'ask', 'ask'],
      acceptEdits: ['allow', 'ask', 'allow', 'ask', 'allow', 'ask', 'ask'],
      plan: ['allow', 'ask', 'deny', 'deny', 'deny', 'deny', 'deny'],
      bypassPermissions: ['allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'ask'],
      dontAsk: ['allow', 'deny', 'deny', 'deny', 'allow', 'deny', 'deny'],
      auto: ['allow', 'ask', 'ask', 'ask', 'allow', 'ask', 'ask'],
    };
    for (const [mode, expected] of Object.entries(MATRIX)) {
      it(`matrix ${mode}: equals Claude's table${['dontAsk', 'auto'].includes(mode) && !measured(`${mode}-read-outside`) ? ' (assumption until the live measurement, M10)' : ''}`, async () => {
        const cwd = fs.mkdtempSync(path.join(scratch, 'ws-'));
        const outside = fs.mkdtempSync(path.join(scratch, 'out-'));
        const engine = await openCodeEngine(mode, cwd, { permissions: { allow: ['Bash(echo allowed:*)'], ask: ['Bash(echo asked:*)'] } });
        const calls: Array<[string, Row]> = [
          ['read', { filePath: path.join(cwd, 'a.txt') }], ['read', { filePath: path.join(outside, 'a.txt') }],
          ['edit', { filePath: path.join(cwd, 'a.txt'), oldString: 'a', newString: 'b' }], ['edit', { filePath: path.join(outside, 'a.txt'), oldString: 'a', newString: 'b' }],
          ['bash', { command: 'echo allowed now', description: 'x' }], ['bash', { command: 'echo plain', description: 'x' }], ['bash', { command: 'echo asked now', description: 'x' }]];
        const got: string[] = [];
        for (const [i, [tool, args]] of calls.entries()) got.push((await engine.decideTool({ sessionID: 's1', callId: `m-${mode}-${i}`, tool, args })).decision);
        assert.deepEqual(got, expected);
      });
    }

    for (const branch of BRANCHES) {
      it(`${branch}: ask → a permission_request card (provider opencode); approve → exactly one execution`, { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
        const resolve = need(PERMS, 'resolveParityPermission');
        const turn = await runTurn({ branch, options: { permissionMode: 'default' },
          answer: (frame) => resolve({ requestId: frame.requestId, allow: true }),
          steps: [SHIM_STEP, { tool: 'bash', args: { command: 'echo ran >> approve-witness', description: 'needs approval' } }, { text: 'done' }] });
        const cards = turn.frames.filter((f) => f.kind === 'permission_request');
        assert.equal(cards.length, 1);
        assert.equal(cards[0].provider, 'opencode');
        assert.equal(fs.readFileSync(path.join(turn.cwd, 'approve-witness'), 'utf8'), 'ran\n');
      });
    }

    for (const [name, answer] of [['reject', { allow: false }], ['updatedInput', { allow: true, updatedInput: { command: 'echo other' } }]] as const) {
      it(`${name} → the body never runs`, { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
        const resolve = need(PERMS, 'resolveParityPermission');
        const turn = await runTurn({ options: { permissionMode: 'default' }, answer: (frame) => resolve({ requestId: frame.requestId, ...answer }),
          steps: [SHIM_STEP, { tool: 'bash', args: { command: 'echo ran >> approve-witness', description: 'needs approval' } }, { text: 'done' }] });
        assert.equal(turn.frames.filter((f) => f.kind === 'permission_request').length, 1, 'a card was shown');
        assert.equal(fs.existsSync(path.join(turn.cwd, 'approve-witness')), false);
      });
    }

    it('dontAsk → deny, no card', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      need(PERMS, 'requestParityPermission');
      const turn = await runTurn({ options: { permissionMode: 'dontAsk' },
        steps: [SHIM_STEP, { tool: 'bash', args: { command: 'echo ran >> approve-witness', description: 'x' } }, { text: 'done' }] });
      assert.ok(toolRequests(turn).length >= 2, `the turn ran (${errorCodes(turn).join(',')})`);
      assert.equal(turn.frames.filter((f) => f.kind === 'permission_request').length, 0);
      assert.equal(fs.existsSync(path.join(turn.cwd, 'approve-witness')), false);
    });

    it('no Claude env → the engine refuses (PERMISSION_EFFECTIVE_POLICY_REQUIRED) before any spawn', () => {
      const cwd = fs.mkdtempSync(path.join(scratch, 'ws-'));
      assert.throws(() => need(ENGINE, 'createClaudeParityEngine')({ userId: MEMBER, cwd, home: cwd, sessionId: 's', transcriptPath: '/dev/null',
        permissionMode: 'default', adapter: need(TOOLS, 'opencodeParityAdapter'), claudeEnv: () => { throw new Error('no claude env'); } }),
      (error: Row) => error?.code === 'PERMISSION_EFFECTIVE_POLICY_REQUIRED');
    });

    it('grant (H3): one claudeSpawnEnvFor behind the Claude spawn, the engine and dsh (grants honoured)', () => {
      assert.equal(typeof need(SPAWN_ENV, 'claudeSpawnEnvFor'), 'function');
      const read = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
      assert.match(read('server/claude-sdk.js'), /claudeSpawnEnvFor\(/, 'the Claude spawn uses it');
      assert.match(read('server/services/permission-parity/claude-parity-engine.js'), /claudeSpawnEnvFor/, 'the engine uses it');
      assert.doesNotMatch(read('server/services/permission-parity/claude-parity-engine.js'), /honorGrants:\s*false/, 'no grant-blind default env');
    });
  });

  describe('B-1761 governance on every spawn', () => {
    it('four isolated members on a non-carrier model: every stale/tampered AGENTS.md equals the neutral source after launch', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      const source = fs.readFileSync(path.join(SANDBOX_HOME, '.claude', 'AGENTS.md'));
      const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
      for (const member of [7, 8, 9, 10]) {
        const xdg = resolveProviderEnv(member, 'opencode').XDG_CONFIG_HOME!;
        const copy = path.join(xdg, 'opencode', 'AGENTS.md');
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.rmSync(copy, { force: true }); // an earlier governed launch leaves the copy read-only
        fs.writeFileSync(copy, `# tampered for ${member}\n`);
      }
      for (const member of [7, 8, 9, 10]) await runTurn({ member });
      for (const member of [7, 8, 9, 10]) {
        const copy = path.join(resolveProviderEnv(member, 'opencode').XDG_CONFIG_HOME!, 'opencode', 'AGENTS.md');
        assert.equal(sha(fs.readFileSync(copy)), sha(source), `member ${member}: governance copy restored`);
      }
    });

    it('neutral source missing → governance_missing, no spawn', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      const source = path.join(SANDBOX_HOME, '.claude', 'AGENTS.md');
      const saved = fs.readFileSync(source);
      fs.rmSync(source);
      try {
        const turn = await runTurn();
        assert.equal(turn.spawns.filter((s) => s.argv[0] === 'run').length, 0, 'no opencode run');
        assert.ok(errorCodes(turn).includes('governance_missing'), `codes: ${errorCodes(turn).join(',')}`);
      } finally { fs.writeFileSync(source, saved); }
    });
  });

  describe('B-1762 host rules on Claude\'s exact terms', () => {
    it('public-page cage: a write into <install>/dist denied on OpenCode in default and bypass; an allow rule lets it through', async () => {
      const dist = path.join(appRoot, 'dist', `parity-probe-${crypto.randomUUID()}`, 'x.html');
      for (const mode of ['default', 'bypassPermissions']) {
        const engine = await openCodeEngine(mode, appRoot);
        const verdict = await engine.decideTool({ sessionID: 's1', callId: `pp-${mode}`, tool: 'edit', args: { filePath: dist, oldString: 'a', newString: 'b' } });
        assert.equal(verdict.decision, 'deny', mode);
        // `//` + absolute path: Claude reads a single leading `/` as relative to the settings file.
        const allowed = await openCodeEngine(mode, appRoot, { permissions: { allow: [`Edit(/${path.dirname(dist)}/**)`] } });
        assert.notEqual((await allowed.decideTool({ sessionID: 's1', callId: `pa-${mode}`, tool: 'edit', args: { filePath: dist, oldString: 'a', newString: 'b' } })).decision, 'deny');
      }
      assert.equal(fs.existsSync(path.dirname(dist)), false);
    });

    it('NASSAJ_PROVIDER_CAGE=true: the OpenCode argv is not wrapped and one opencode_provider_cage_not_applied audit entry is written', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      setEnv('NASSAJ_PROVIDER_CAGE', 'true');
      try {
        const turn = await runTurn();
        assert.ok(turn.spawns.some((s) => s.argv[0] === 'run'), `opencode itself spawned (not a cage): ${errorCodes(turn).join(',')}`);
        const audits = db.getConnection().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'opencode_provider_cage_not_applied'").get() as Row;
        assert.equal(audits.n, 1);
      } finally { setEnv('NASSAJ_PROVIDER_CAGE', undefined); }
    });

    it.todo('engine write fence (T-1209): pins owner decision D1 once answered');
  });

  describe('B-1763 subagents, plugin absence and the hello', () => {
    it('a subagent whose card says `edit: allow` editing outside cwd in default mode → card or deny', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      const outsideDir = fs.mkdtempSync(path.join(scratch, 'outside-'));
      fs.writeFileSync(path.join(outsideDir, 'o.txt'), 'one\n');
      const sub = `SUB_STEPS ${JSON.stringify([SHIM_STEP, { tool: 'edit', args: { filePath: path.join(outsideDir, 'o.txt'), oldString: 'one', newString: 'two' } }, { text: 'sub done' }])} END_SUB`;
      const turn = await runTurn({ options: { permissionMode: 'default' }, answer: () => {},
        steps: [SHIM_STEP, { tool: 'task', args: { description: 'sub', subagent_type: 'general', prompt: sub } }, { text: 'done' }] });
      assert.equal(fs.readFileSync(path.join(outsideDir, 'o.txt'), 'utf8'), 'one\n', 'the subagent edit did not run');
      assert.ok(turn.frames.some((f) => f.kind === 'permission_request') || toolRequests(turn).length > 0, 'card shown or denied');
    });

    for (const fault of ['noplugin', 'corrupt', 'thrower', 'pure']) {
      it(`plugin fault "${fault}" → zero LLM requests, zero tool runs, opencode_parity_not_loaded`, { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
        const turn = await runTurn({ fault, steps: [SHIM_STEP, { tool: 'bash', args: { command: 'echo ran >> fault-witness', description: 'x' } }, { text: 'done' }] });
        assertSpawned(turn);
        assert.equal(turn.llm.requests().length, 0, `requests reached the model: ${turn.llm.requests().length}`);
        assert.equal(fs.existsSync(path.join(turn.cwd, 'fault-witness')), false);
        assert.ok(errorCodes(turn).includes('opencode_parity_not_loaded'), `codes: ${errorCodes(turn).join(',')}`);
      });
    }

    it('a hello with a wrong nonce, a wrong digest or a second hello → refusal and kill', async () => {
      const createBroker = need(BROKER, 'createParityBroker');
      for (const frames of [[{ type: 'hello', nonce: 'wrong', pluginDigest: 'd', protocol: 'p' }],
        [{ type: 'hello', nonce: 'n', pluginDigest: 'wrong', protocol: 'p' }],
        [{ type: 'hello', nonce: 'n', pluginDigest: 'd', protocol: 'p' }, { type: 'hello', nonce: 'n', pluginDigest: 'd', protocol: 'p' }]]) {
        let killed = 0;
        const broker = createBroker({ engine: { decideTool: async () => ({ decision: 'allow' }) }, kill: () => { killed += 1; }, onIncident: () => {},
          helloPolicy: { nonce: 'n', pluginDigest: 'd', protocol: 'p' } });
        for (const frame of frames) await broker.receive(frame);
        assert.ok(killed >= 1, `killed for ${JSON.stringify(frames)}`);
        assert.ok(broker.state.refusal, 'refusal recorded');
      }
    });

    /** An outer bash that leaves a witness, then pipes a scripted prompt into a nested opencode (K1 wrapper). */
    const nestedRun = (launch: string) => {
      const prompt = `NASSAJ_STEPS ${JSON.stringify([SHIM_STEP, { tool: 'bash', args: { command: 'echo nested >> nested-witness', description: 'n' } },
        { text: 'done' }])} END_STEPS`.replaceAll("'", '');
      return `echo outer >> outer-witness && printf '%s' '${prompt}' | ${launch} run -m probe/probe --format json`;
    };

    // H3: bypassPermissions lets the outer bash run (no card to time out), so only the nested
    // child's own gate keeps the witness away.
    it('a nested `opencode run` from bash (plugin, no fd 3) → every tool denied', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      requireGate();
      const turn = await runTurn({ options: { permissionMode: 'bypassPermissions' },
        steps: [SHIM_STEP, { tool: 'bash', args: { description: 'nested', command: nestedRun(wrapper) } }, { text: 'done' }] });
      assert.ok(fs.existsSync(path.join(turn.cwd, 'outer-witness')), `the outer bash ran: ${toolOutputs(turn)}`);
      assert.ok(turn.spawns.filter((s) => s.argv[0] === 'run').length >= 2, 'the nested opencode started');
      assert.equal(fs.existsSync(path.join(turn.cwd, 'nested-witness')), false);
    });

    // H1/H3: a nested run without plugins is refused by nassaj-core's nested-harness-guard, run
    // as one of the member's Claude hooks; without the hook the plugin-less child writes the witness.
    for (const [name, launch] of [['--pure', (bin: string) => `${bin} --pure`], ['OPENCODE_PURE=1', (bin: string) => `OPENCODE_PURE=1 ${bin}`]] as const) {
      it(`a nested \`opencode ${name}\` from bash → denied by the nested-harness hook (bypass)`, { skip: !HAVE_BIN && 'opencode binary absent' }, async (t) => {
        const guard = hostHome ? path.join(hostHome, 'nassaj-core', 'hooks', 'nested-harness-guard.js') : '';
        if (!guard || !fs.existsSync(guard)) return t.skip('nassaj-core hooks/nested-harness-guard.js absent');
        requireGate();
        const file = claudeSettingsFile();
        const saved = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        const settings = saved ? JSON.parse(saved) : {};
        const command = NO_NESTED_GUARD ? 'true' : `${process.execPath} ${guard} --harness claude`;
        settings.hooks = { ...settings.hooks, PreToolUse: [...(settings.hooks?.PreToolUse ?? []), { matcher: 'Bash', hooks: [{ type: 'command', command }] }] };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(settings));
        try {
          const turn = await runTurn({ options: { permissionMode: 'bypassPermissions' },
            steps: [SHIM_STEP, { tool: 'bash', args: { description: 'nested', command: nestedRun(launch(wrapper)) } }, { text: 'done' }] });
          assert.ok(toolResults(turn).some((text) => text.includes('Nassaj nested-harness guard:')), `refused by the hook: ${toolOutputs(turn)}`);
          assert.equal(fs.existsSync(path.join(turn.cwd, 'outer-witness')), false, 'the outer bash never ran');
          assert.equal(fs.existsSync(path.join(turn.cwd, 'nested-witness')), false);
        } finally {
          if (saved === null) fs.rmSync(file, { force: true });
          else fs.writeFileSync(file, saved);
        }
      });
    }

    it('a second plugin that mutates args after our allow has no effect (frozen) or the tree is killed', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      requireGate();
      const turn = await runTurn({ fault: 'mutator', options: { permissionMode: 'bypassPermissions' },
        steps: [SHIM_STEP, { tool: 'bash', args: { command: 'echo ORIGINAL >> orig-witness', description: 'x' } }, { text: 'done' }] });
      assert.equal(fs.existsSync(path.join(turn.cwd, 'mutated-witness')), false);
      assert.ok(fs.existsSync(path.join(turn.cwd, 'orig-witness')) || errorCodes(turn).includes('parity_undecided_result'));
    });

    it('generator guard: no loaded OpenCode agent card grants edit/bash/webfetch allow', (t) => {
      const cards = hostHome ? path.join(hostHome, 'nassaj-core', 'opencode', 'agent') : null;
      if (!cards || !fs.existsSync(cards)) return t.skip('nassaj-core opencode/agent absent');
      const granting = fs.readdirSync(cards).filter((f) => f.endsWith('.md'))
        .filter((f) => /^\s*(edit|bash|webfetch)\s*:\s*allow\b/m.test(fs.readFileSync(path.join(cards, f), 'utf8')));
      assert.deepEqual(granting, []);
    });

    it('an isolated member spawn loads exactly one Nassaj plugin and holds fd 3', { skip: !HAVE_BIN && 'opencode binary absent' }, async () => {
      const turn = await runTurn();
      const last = turn.spawns.filter((s) => s.argv[0] === 'run').at(-1);
      assert.ok(last, `spawned: ${errorCodes(turn).join(',')}`);
      assert.equal((last.inline?.plugin ?? []).filter((p: string) => /nassaj/.test(p)).length, 1);
      const pluginDir = path.join(resolveProviderEnv(MEMBER, 'opencode').XDG_CONFIG_HOME!, 'opencode', 'plugin');
      assert.equal(fs.existsSync(path.join(pluginDir, 'nassaj-governance.js')), false);
      assert.equal(last.fd3, true, 'fd 3 channel present');
    });
  });

  describe('broker (M3) and tree kill (M4)', () => {
    it('two sessions reusing one callID: each decision is used once and only for its own session', async () => {
      const evidence = STAGE0.scenarios.callidA;
      assert.ok(evidence?.a && evidence?.b, 'stage-0 callID evidence present');
      const createBroker = need(BROKER, 'createParityBroker');
      const incidents: Row[] = [];
      const broker = createBroker({ engine: { decideTool: async () => ({ decision: 'allow', claude: {} }) }, kill: () => {},
        onIncident: (i: Row) => incidents.push(i), helloPolicy: { nonce: 'n', pluginDigest: 'd', protocol: 'p' } });
      await broker.receive({ type: 'hello', nonce: 'n', pluginDigest: 'd', protocol: 'p' });
      const pre = (sessionID: string) => broker.receive({ type: 'pre', id: crypto.randomUUID(), sessionID, callID: 'call_fixed', tool: 'bash', args: { command: 'echo x' } });
      assert.equal((await pre('ses_a')).decision, 'allow');
      assert.equal((await pre('ses_b')).decision, 'allow', 'another session may reuse the callID');
      assert.equal((await pre('ses_a')).decision, 'deny', 'a repeated sessionID+callID is refused');
      assert.equal(incidents.length, 1);
    });

    it('a bash call that starts a grandchild in its own process group: no descendant remains after the kill', async () => {
      const killProcessTree = need(RUNTIME, 'killProcessTree');
      const root = spawn('/bin/bash', ['-c', 'setsid sleep 300 & sleep 300'], { detached: true, stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 300));
      const descendants = (pid: number): number[] => {
        let out: number[] = [];
        try {
          for (const task of fs.readdirSync(`/proc/${pid}/task`)) {
            for (const kid of fs.readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) out = [...out, kid, ...descendants(kid)];
          }
        } catch { /* gone */ }
        return out;
      };
      const before = descendants(root.pid!);
      assert.ok(before.length >= 1);
      await killProcessTree(root.pid);
      // A process may vanish between any two reads of /proc: read status once, absent = gone.
      const alive = (pid: number): boolean => {
        try { return !/^State:\s*Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return false; }
      };
      const deadline = Date.now() + 2000;
      while (before.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      assert.deepEqual(before.filter(alive), []);
    });
  });

  describe('dsh regressions (H6, §8.1)', () => {
    it('C1: dsh refuses a turn when no Claude env can be built', () => {
      const resolve = need(DSH_PARITY, 'resolveDshPermissionParity');
      const cwd = fs.mkdtempSync(path.join(scratch, 'ws-'));
      const managedSettingsDir = fs.mkdtempSync(path.join(scratch, 'managed-'));
      fs.writeFileSync(path.join(managedSettingsDir, 'managed-settings.json'), '{}');
      assert.throws(() => resolve({ permissionMode: 'default' }, { userId: MEMBER, cwd }, { claudeEnv: () => null, managedSettingsDir }),
        (error: Row) => error?.code === 'PERMISSION_EFFECTIVE_POLICY_REQUIRED');
    });
    for (const mode of ['dontAsk', 'auto']) {
      it(`C2: dsh runs Claude's "${mode}" under the §3 rules (was refused)`, () => {
        const resolve = need(DSH_PARITY, 'resolveDshPermissionParity');
        const cwd = fs.mkdtempSync(path.join(scratch, 'ws-'));
        const managedSettingsDir = fs.mkdtempSync(path.join(scratch, 'managed-'));
        fs.writeFileSync(path.join(managedSettingsDir, 'managed-settings.json'), '{}');
        const result = resolve({ permissionMode: mode }, { userId: MEMBER, cwd }, { claudeEnv: () => ({ HOME: claudeHome, PATH: '/usr/bin:/bin' }), managedSettingsDir });
        assert.equal(result.claudeMode, mode);
      });
    }
    it('C3: dsh reads the Claude env with grants honoured (claudeSpawnEnvFor)', () => {
      assert.match(fs.readFileSync(path.join(appRoot, 'server/modules/providers/list/dsh/dsh-permission-parity.js'), 'utf8'), /claudeSpawnEnvFor/);
    });
  });
});
