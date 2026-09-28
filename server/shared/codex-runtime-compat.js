import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import {
  assertCodexIdentityUnchanged,
  codexFileDigest,
  codexLaunchOptions,
  resolveCodexSdkSourceEntry,
} from './codex-executable.js';

/*
 * T-1872 part 2: the machine Codex release is updated independently of Nassaj
 * (the harness update button), so every launch identity is judged against the
 * contract Nassaj actually speaks before any session may use it:
 *   a. version floor;
 *   b. every flag the installed @openai/codex-sdk emits parses on this binary;
 *   c. every config key/value Nassaj passes loads under --strict-config;
 *   d. the workspace-write sandbox refuses outside writes and network, but only
 *      when this node can actually produce workspace-write.
 * Verdicts are cached by what they depend on (release bytes + SDK bytes +
 * resolver bytes + probe plan), so the hot path costs one map lookup.
 */

export const CODEX_RUNTIME_INCOMPATIBLE = 'CODEX_RUNTIME_INCOMPATIBLE';
export const CODEX_MIN_VERSION = '0.153.2';
/** Flags the SDK's CodexExec.run emits before `resume` (proved equal to the SDK source by test). */
export const CODEX_SDK_EXEC_FLAGS = Object.freeze(['--experimental-json', '--config', '--model',
  '--thread-source', '--sandbox', '--cd', '--add-dir', '--skip-git-repo-check', '--output-schema', '--image']);
/** Flags the SDK emits after `resume <id>`, parsed by `codex exec resume`. */
export const CODEX_SDK_RESUME_FLAGS = Object.freeze(['--image']);
/** Sandbox values Nassaj can hand the CLI (SDK turns and the read-only supervisor adapter). */
export const CODEX_SANDBOX_VALUES = Object.freeze(['workspace-write', 'danger-full-access', 'read-only']);

const PROBE_ROOT = '/var/tmp';
const PROBE_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 64 * 1024;
const CANARY_KEY = 'nassaj_compat_canary_unknown_key';

/**
 * Every config key Nassaj passes (openai-codex.js thread/config options, the
 * SDK's own --config lines, the supervisor adapter) with one representative value.
 */
export const CODEX_NASSAJ_CONFIG_TOML = [
  'approval_policy = "on-request"',
  'sandbox_mode = "workspace-write"',
  'web_search = "disabled"',
  'model_reasoning_effort = "medium"',
  'developer_instructions = "nassaj compatibility probe"',
  'project_doc_max_bytes = 0',
  'mcp_servers = {}',
  '',
  '[features]',
  'multi_agent = false',
  '',
  '[sandbox_workspace_write]',
  'network_access = false',
  'writable_roots = []',
  '',
].join('\n');

/** The remaining enum values Nassaj can send, applied as -c overrides (strict covers -c too). */
export const CODEX_CONFIG_VALUE_VARIANTS = Object.freeze([
  ['approval_policy="never"', 'sandbox_mode="danger-full-access"', 'model_reasoning_effort="minimal"',
    'features.multi_agent=false', 'mcp_servers={}', 'sandbox_workspace_write.network_access=true'],
  ['sandbox_mode="read-only"', 'model_reasoning_effort="low"'],
  ['model_reasoning_effort="high"', 'web_search="disabled"'],
  ['model_reasoning_effort="xhigh"', 'sandbox_workspace_write.writable_roots=[]'],
]);

/** Bilingual user message for an incompatible machine Codex. */
export const codexRuntimeIncompatibleMessage = (version, reason) => (
  `نسخة Codex على الجهاز (${version}) غير متوافقة مع نسّاج: ${reason}.`
  + ' أعد Codex لنسخة متوافقة أو انتظر تحديث نسّاج'
  + ` / The machine Codex (${version}) is incompatible with Nassaj: ${reason}.`
  + ' Restore a compatible Codex or wait for a Nassaj update'
);

/** True when an error is a runtime-compatibility refusal. */
export const isCodexRuntimeIncompatible = error => error?.code === CODEX_RUNTIME_INCOMPATIBLE;

/** Compare dotted numeric versions; returns <0, 0 or >0. */
export function compareCodexVersions(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Mirror of mapPermissionModeToCodexOptions (openai-codex.js): workspace-write
 * is reachable only when the deployment is not declared unsandboxed. Parity is
 * pinned by codex-runtime-compat.test.js against the real mapper.
 */
export const codexWorkspaceWriteReachable = (env = process.env) => env?.CODEX_ALLOW_FULL_ACCESS !== 'true';

/** Cache key: release tree + SDK source + resolver chain + the probe plan. */
export function codexRuntimeCacheKey(identity, { sdkSourceDigest, workspaceWrite }) {
  return JSON.stringify([identity.treeDigest, sdkSourceDigest, identity.resolverDigest,
    workspaceWrite ? 'ws' : 'full']);
}

/** Spawn one bounded probe (no shell, fixed argv, killed at the deadline). */
export function runCodexProbe(executable, args, { env, cwd, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(executable, args, { env, cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = (acc, chunk) => (acc.length >= OUTPUT_LIMIT ? acc : acc + String(chunk)).slice(0, OUTPUT_LIMIT);
    child.stdout.on('data', chunk => { stdout = cap(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = cap(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const finish = (code, signal, error = null) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, error });
    };
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  });
}

class ProbeFailure extends Error {
  /** A probe that could not run to a verdict (timeout, spawn error): never cached. */
  constructor(reason) { super(reason); this.transient = true; }
}

/** Throw a transient failure when the probe never produced an exit code. */
function requireExit(result, what) {
  if (result.timedOut) throw new ProbeFailure(`${what} probe timed out`);
  if (result.error || result.code === null) throw new ProbeFailure(`${what} probe could not run`);
  return result;
}

/** First meaningful error line, stripped of temp paths, for a user-safe reason. */
function errorLine(text) {
  const line = String(text).split('\n').map(item => item.trim())
    .find(item => /^error/iu.test(item)) ?? String(text).split('\n').find(Boolean) ?? '';
  return line.replace(/^error:\s*/iu, '').replace(/\/\S+:\d+:\d+:\s*/u, '').slice(0, 200);
}

/** SDK argv shapes (start, resume, supervisor adapter), each terminated by --help. */
export function codexFlagProbeArgv(fixture) {
  const common = ['--config', 'features.multi_agent=false', '--model', 'probe'];
  const paths = ['--cd', fixture.workspace, '--add-dir', fixture.workspace, '--skip-git-repo-check',
    '--output-schema', fixture.schemaFile];
  return [
    { label: 'exec', usage: 'codex exec', args: ['exec', '--experimental-json', ...common, '--thread-source',
      'user', '--sandbox', 'workspace-write', ...paths, '--image', fixture.schemaFile, '--help'] },
    { label: 'exec resume', usage: 'codex exec resume', args: ['exec', '--experimental-json', ...common,
      '--sandbox', 'danger-full-access', ...paths, 'resume', '00000000-0000-4000-8000-000000000000',
      '--image', fixture.schemaFile, '--help'] },
    { label: 'exec (supervisor)', usage: 'codex exec', args: ['exec', '--ephemeral', '--json',
      '--strict-config', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox',
      'read-only', ...common, '--help'] },
  ];
}

/** b. Every emitted flag and sandbox value parses (clap rejects unknown args before --help). */
async function checkFlags(run, identity, fixture) {
  for (const shape of codexFlagProbeArgv(fixture)) {
    const result = requireExit(await run(identity.executablePath, shape.args, fixture.options), 'flag');
    if (result.code !== 0 || !result.stdout.includes(`Usage: ${shape.usage}`)) {
      const missing = result.stderr.match(/unexpected argument '([^']+)'/u)?.[1];
      return missing ? `\`${shape.label}\` does not accept ${missing}`
        : `\`${shape.label}\` rejected Nassaj's arguments (${errorLine(result.stderr) || 'no usage output'})`;
    }
  }
  return null;
}

/** c. Strict config: canaries must be rejected, then every Nassaj key/value must load. */
async function checkConfig(run, identity, fixture) {
  const serve = extra => run(identity.executablePath, ['app-server', '--strict-config', ...extra],
    fixture.options).then(result => requireExit(result, 'config'));
  const canary = await serve(['-c', `${CANARY_KEY}=1`]);
  if (canary.code === 0) return { residual: '--strict-config accepted an unknown -c key' };
  await fs.writeFile(path.join(fixture.home, 'config.toml'), `${CANARY_KEY} = 1\n`, { mode: 0o600 });
  const fileCanary = await serve([]);
  await fs.writeFile(path.join(fixture.home, 'config.toml'), CODEX_NASSAJ_CONFIG_TOML, { mode: 0o600 });
  if (fileCanary.code === 0) return { residual: '--strict-config accepted an unknown config.toml key' };
  for (const variant of [[], ...CODEX_CONFIG_VALUE_VARIANTS]) {
    const result = await serve(variant.flatMap(value => ['-c', value]));
    if (result.code !== 0) return { reason: `config rejected: ${errorLine(result.stderr)}` };
  }
  return {};
}

const SANDBOX_SCRIPT = [
  'echo in > "$1/inside" && echo INSIDE_WRITTEN',
  'echo out > "$2/outside" 2>/dev/null && echo OUTSIDE_WRITTEN',
  '(exec 3<>"/dev/tcp/127.0.0.1/$3") 2>/dev/null && echo NETWORK_OPEN',
  'exit 0',
].join('\n');

/** Accept connections on loopback; any accepted socket proves the sandbox let network through. */
function openCanaryListener() {
  return new Promise((resolve, reject) => {
    const state = { connections: 0 };
    const server = net.createServer(socket => { state.connections += 1; socket.destroy(); });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

const exists = file => fs.access(file).then(() => true, () => false);

/** d. workspace-write enforcement on a /var/tmp fixture via the release's own `codex sandbox`. */
async function checkSandbox(run, identity, fixture) {
  const listener = await openCanaryListener();
  try {
    const result = requireExit(await run(identity.executablePath, ['sandbox', '-P', ':workspace',
      '-C', fixture.workspace, '-c', 'sandbox_mode="workspace-write"',
      '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.writable_roots=[]',
      '--', '/bin/bash', '-c', SANDBOX_SCRIPT, 'probe', fixture.workspace, fixture.root,
      String(listener.port)], fixture.options), 'sandbox');
    if (result.code !== 0) return `sandbox probe failed (${errorLine(result.stderr)})`;
    if (await exists(path.join(fixture.root, 'outside'))) return 'workspace-write sandbox allowed a write outside';
    if (listener.state.connections > 0) return 'workspace-write sandbox allowed network access';
    if (!(await exists(path.join(fixture.workspace, 'inside')))) {
      return 'workspace-write sandbox refused a write inside the workspace';
    }
    return null;
  } finally {
    await new Promise(resolve => listener.server.close(resolve));
  }
}

/** App Server RPC methods the native fork path sends (codex-app-server.js spawnCodexSideQuery/fork). */
export const CODEX_FORK_RPC_METHODS = Object.freeze(['initialize', 'thread/fork', 'turn/start', 'turn/interrupt']);
export const CODEX_FORK_RPC_NOTIFICATIONS = Object.freeze(['initialized']);

/** Collect every `method` enum value in a generated protocol schema file. */
async function schemaMethods(file) {
  const methods = new Set();
  JSON.parse(await fs.readFile(file, 'utf8'), (key, value) => {
    if (key === 'method' && Array.isArray(value?.enum)) value.enum.forEach(item => methods.add(item));
    return value;
  });
  return methods;
}

/** Fork schema sanity: the release's own protocol schema still declares every method Nassaj sends. */
async function checkForkSchema(run, identity, fixture) {
  const out = path.join(fixture.root, 'schema-out');
  const result = requireExit(await run(identity.executablePath,
    ['app-server', 'generate-json-schema', '--experimental', '--out', out], fixture.options), 'schema');
  if (result.code !== 0) return `schema generation failed (${errorLine(result.stderr)})`;
  try {
    const requests = await schemaMethods(path.join(out, 'ClientRequest.json'));
    const notifications = await schemaMethods(path.join(out, 'ClientNotification.json'));
    const missing = [...CODEX_FORK_RPC_METHODS.filter(method => !requests.has(method)),
      ...CODEX_FORK_RPC_NOTIFICATIONS.filter(method => !notifications.has(method))];
    return missing.length ? `schema lacks ${missing.join(', ')}` : null;
  } catch {
    return 'schema output unreadable';
  }
}

/** Create the private /var/tmp fixture: CODEX_HOME, workspace and a schema file. */
async function createProbeFixture(identity, probeRoot) {
  const root = await fs.mkdtemp(path.join(probeRoot, 'nassaj-codex-compat-'));
  await fs.chmod(root, 0o700);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(workspace, { mode: 0o700 });
  const schemaFile = path.join(root, 'schema.json');
  await fs.writeFile(schemaFile, '{"type":"object"}\n', { mode: 0o600 });
  await fs.writeFile(path.join(home, 'config.toml'), CODEX_NASSAJ_CONFIG_TOML, { mode: 0o600 });
  // No TMPDIR: the fixture lives in /var/tmp and must not become a writable root.
  const env = codexLaunchOptions({ HOME: home, CODEX_HOME: home, PATH: '/usr/bin:/bin' }, identity).env;
  return { root, home, workspace, schemaFile, options: { env, cwd: workspace } };
}

/**
 * Evaluate one identity. Resolves to a verdict; transient probe failures reject.
 * @returns {Promise<{compatible: boolean, version: string, reason: string|null, checks: object}>}
 */
export async function evaluateCodexRuntime(identity, {
  run = runCodexProbe, workspaceWrite = codexWorkspaceWriteReachable(), probeRoot = PROBE_ROOT,
} = {}) {
  const checks = { version: 'verified', flags: 'pending', config: 'pending',
    enforcement: workspaceWrite ? 'pending' : 'not-applicable', approvalPolicy: 'residual',
    forkSchema: 'pending' };
  const verdict = reason => ({ compatible: !reason, version: identity.version, reason: reason ?? null, checks });
  if (compareCodexVersions(identity.version, CODEX_MIN_VERSION) < 0) {
    checks.version = 'failed';
    return verdict(`version is below ${CODEX_MIN_VERSION}`);
  }
  const fixture = await createProbeFixture(identity, probeRoot);
  try {
    const flagReason = await checkFlags(run, identity, fixture);
    checks.flags = flagReason ? 'failed' : 'verified';
    if (flagReason) return verdict(flagReason);
    const config = await checkConfig(run, identity, fixture);
    checks.config = config.reason ? 'failed' : config.residual ? `residual: ${config.residual}` : 'verified';
    if (config.reason) return verdict(config.reason);
    if (workspaceWrite) {
      const sandboxReason = await checkSandbox(run, identity, fixture);
      // Proves the release's workspace sandbox primitive, not that `exec --sandbox` maps to it.
      checks.enforcement = sandboxReason ? 'failed' : 'residual: primitive enforced, exec mapping unproven';
      if (sandboxReason) return verdict(sandboxReason);
    }
    // Informational: only the native fork gate reads it; sessions do not depend on it.
    const schemaReason = await checkForkSchema(run, identity, fixture);
    checks.forkSchema = schemaReason ? `failed: ${schemaReason}` : 'verified';
    return verdict(null);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

const verdictCache = new Map();
const settledVerdicts = new Map();
const VERDICT_CACHE_LIMIT = 16;

let evaluatorOverride = null;

/** Test seam: forget every cached verdict. */
export const clearCodexRuntimeCompatCache = () => { verdictCache.clear(); settledVerdicts.clear(); };

/**
 * Test seam: replace the evaluator (hand-built fixture releases cannot answer
 * real CLI probes). Pass null to restore the real one. Clears the cache.
 * @param {((identity: object, options: object) => Promise<object>) | null} evaluate
 */
export function setCodexRuntimeEvaluatorForTests(evaluate) {
  evaluatorOverride = evaluate;
  clearCodexRuntimeCompatCache();
}

const cacheKeyFor = (identity, options) => codexRuntimeCacheKey(identity, {
  sdkSourceDigest: options.sdkSourceDigest ?? codexFileDigest(resolveCodexSdkSourceEntry()),
  workspaceWrite: options.workspaceWrite ?? codexWorkspaceWriteReachable(),
});

/** Synchronous read of an already-settled verdict for this identity, or null. */
export const peekCodexRuntimeVerdict = (identity, options = {}) => (
  settledVerdicts.get(cacheKeyFor(identity, options)) ?? null);

/** Build the refusal thrown to launch sites. */
function incompatibleError(verdict) {
  return Object.assign(new Error(codexRuntimeIncompatibleMessage(verdict.version, verdict.reason)), {
    code: CODEX_RUNTIME_INCOMPATIBLE, version: verdict.version, reason: verdict.reason, checks: verdict.checks,
  });
}

/**
 * The verdict for this identity, cached by codexRuntimeCacheKey. A transient
 * probe failure or a release that changed mid-probe is not cached.
 */
export function getCodexRuntimeVerdict(identity, options = {}) {
  const workspaceWrite = options.workspaceWrite ?? codexWorkspaceWriteReachable();
  const key = cacheKeyFor(identity, { ...options, workspaceWrite });
  const cached = verdictCache.get(key);
  if (cached) return cached;
  const pending = (evaluatorOverride ?? evaluateCodexRuntime)(identity, { ...options, workspaceWrite }).then(verdict => {
    // A test evaluator stands in for the whole probe, including this post-probe seal check.
    if (!evaluatorOverride) (options.assertUnchanged ?? assertCodexIdentityUnchanged)(identity);
    if (verdictCache.get(key) === pending) settledVerdicts.set(key, verdict);
    if (settledVerdicts.size > VERDICT_CACHE_LIMIT) settledVerdicts.delete(settledVerdicts.keys().next().value);
    return verdict;
  }).catch(error => {
    verdictCache.delete(key);
    if (error?.transient) {
      return { compatible: false, version: identity.version, reason: error.message, checks: {}, transient: true };
    }
    throw error;
  });
  verdictCache.set(key, pending);
  if (verdictCache.size > VERDICT_CACHE_LIMIT) verdictCache.delete(verdictCache.keys().next().value);
  return pending;
}

/**
 * Guard every Codex launch: resolves to the identity, or rejects with
 * CODEX_RUNTIME_INCOMPATIBLE {version, reason} and the bilingual message.
 */
export async function assertCodexRuntimeCompatible(identity, options = {}) {
  const verdict = await getCodexRuntimeVerdict(identity, options);
  if (!verdict.compatible) throw incompatibleError(verdict);
  return identity;
}

/** Boot prewarm after the identity prewarm; never throws, never blocks boot. */
export function prewarmCodexRuntimeCompat(acquire, options = {}) {
  let identity;
  try { identity = acquire(); } catch { return Promise.resolve(null); }
  return getCodexRuntimeVerdict(identity, options).catch(() => null);
}
