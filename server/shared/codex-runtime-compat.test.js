import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquireCodexLaunchIdentity, codexFileDigest, resolveCodexSdkSourceEntry } from './codex-executable.js';
import {
  assertCodexRuntimeCompatible,
  clearCodexRuntimeCompatCache,
  CODEX_MIN_VERSION,
  CODEX_NASSAJ_CONFIG_TOML,
  CODEX_RUNTIME_INCOMPATIBLE,
  CODEX_SDK_EXEC_FLAGS,
  CODEX_SDK_RESUME_FLAGS,
  codexFlagProbeArgv,
  codexRuntimeCacheKey,
  codexRuntimeIncompatibleMessage,
  codexWorkspaceWriteReachable,
  compareCodexVersions,
  evaluateCodexRuntime,
  getCodexRuntimeVerdict,
  isCodexRuntimeIncompatible,
  peekCodexRuntimeVerdict,
  prewarmCodexRuntimeCompat,
  runCodexProbe,
  setCodexRuntimeEvaluatorForTests,
} from './codex-runtime-compat.js';

const PROBE_ROOT = '/var/tmp';
const identity = Object.freeze({
  executablePath: '/machine/bin/codex', version: '0.156.0', pathDirs: Object.freeze([]),
  treeDigest: 'sha256:tree', resolverDigest: 'sha256:resolver',
});
const ok = (stdout = '') => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false, error: null });
const fail = stderr => ({ code: 1, signal: null, stdout: '', stderr, timedOut: false, error: null });

afterEach(() => { setCodexRuntimeEvaluatorForTests(null); });

/** Simulates `codex sandbox` running the probe script: honours or ignores the wall. */
async function simulateSandbox(args, { writeOutside = false, network = false } = {}) {
  const [workspace, root, port] = args.slice(-3);
  fs.writeFileSync(path.join(workspace, 'inside'), 'in');
  if (writeOutside) fs.writeFileSync(path.join(root, 'outside'), 'out');
  if (network) {
    await new Promise(resolve => { net.connect(Number(port), '127.0.0.1').once('connect', function done() {
      this.destroy(); setTimeout(resolve, 20);
    }); });
  }
  return ok();
}

/** A fake CLI answering every probe like a compatible release, with per-probe overrides. */
function fakeRun(overrides = {}) {
  const calls = [];
  const run = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args[0] === 'exec') {
      if (overrides.exec) return overrides.exec(args);
      return ok(args.includes('resume') ? 'Usage: codex exec resume [OPTIONS]' : 'Usage: codex exec [OPTIONS]');
    }
    if (args[0] === 'sandbox') return simulateSandbox(args, overrides.sandbox);
    if (args[1] === 'generate-json-schema') return overrides.schema ? overrides.schema(args) : writeSchema(args);
    if (overrides.config) return overrides.config(args, options);
    const canary = args.some(arg => arg.startsWith('nassaj_compat_canary_unknown_key'))
      || fs.readFileSync(path.join(options.env.CODEX_HOME, 'config.toml'), 'utf8').includes('canary');
    return canary ? fail('Error: unknown configuration field `nassaj_compat_canary_unknown_key`') : ok();
  };
  return { run, calls };
}

function writeSchema(args, methods = ['initialize', 'thread/fork', 'turn/start', 'turn/interrupt']) {
  const out = args.at(-1);
  fs.mkdirSync(out, { recursive: true });
  const enumOf = list => ({ oneOf: list.map(item => ({ properties: { method: { enum: [item] } } })) });
  fs.writeFileSync(path.join(out, 'ClientRequest.json'), JSON.stringify(enumOf(methods)));
  fs.writeFileSync(path.join(out, 'ClientNotification.json'), JSON.stringify(enumOf(['initialized'])));
  return ok();
}

const leftoverFixtures = () => fs.readdirSync(PROBE_ROOT).filter(name => name.startsWith('nassaj-codex-compat-'));

test('the runtime flag list equals what the installed SDK source emits (cannot drift)', () => {
  const source = fs.readFileSync(resolveCodexSdkSourceEntry(), 'utf8');
  const body = source.slice(source.indexOf('async *run(args)'), source.indexOf('const env = {};'));
  assert.ok(body.length > 0, 'CodexExec.run located in the SDK dist');
  const flagsIn = text => [...new Set([...text.matchAll(/"(--[a-z][a-z-]*)"/gu)].map(match => match[1]))];
  const resumeAt = body.indexOf('commandArgs.push("resume"');
  assert.ok(resumeAt > 0);
  assert.deepEqual(new Set(flagsIn(body)), new Set(CODEX_SDK_EXEC_FLAGS));
  assert.deepEqual(flagsIn(body.slice(resumeAt)), [...CODEX_SDK_RESUME_FLAGS]);
  const [start, resume] = codexFlagProbeArgv({ workspace: '/w', schemaFile: '/s' });
  for (const flag of CODEX_SDK_EXEC_FLAGS) assert.ok(start.args.includes(flag), `start probe carries ${flag}`);
  const afterResume = resume.args.slice(resume.args.indexOf('resume'));
  for (const flag of CODEX_SDK_RESUME_FLAGS) assert.ok(afterResume.includes(flag), `resume probe carries ${flag}`);
});

test('workspace-write reachability mirrors mapPermissionModeToCodexOptions', async () => {
  const { mapPermissionModeToCodexOptions } = await import('../openai-codex.js');
  for (const flag of [undefined, 'true', 'false', '1']) {
    const env = flag === undefined ? {} : { CODEX_ALLOW_FULL_ACCESS: flag };
    const modes = ['default', 'acceptEdits', 'bypassPermissions']
      .map(mode => mapPermissionModeToCodexOptions(mode, env).sandboxMode);
    assert.equal(modes.includes('workspace-write'), codexWorkspaceWriteReachable(env), `flag=${flag}`);
  }
});

test('version comparison and the version floor', async () => {
  assert.ok(compareCodexVersions('0.153.2', CODEX_MIN_VERSION) === 0);
  assert.ok(compareCodexVersions('0.153.10', '0.153.2') > 0);
  assert.ok(compareCodexVersions('0.99.9', '0.153.2') < 0);
  assert.ok(compareCodexVersions('1.0', '0.999.999') > 0);
  const { run, calls } = fakeRun();
  const verdict = await evaluateCodexRuntime({ ...identity, version: '0.153.1' }, { run, probeRoot: PROBE_ROOT });
  assert.equal(verdict.compatible, false);
  assert.match(verdict.reason, /below 0\.153\.2/u);
  assert.equal(calls.length, 0, 'a too-old release is refused without spawning it');
});

test('a compatible release: every probe runs and the fixture is removed', async () => {
  const before = leftoverFixtures();
  const { run, calls } = fakeRun();
  const verdict = await evaluateCodexRuntime(identity, { run, workspaceWrite: true, probeRoot: PROBE_ROOT });
  assert.equal(verdict.compatible, true, verdict.reason);
  assert.deepEqual(verdict.checks, {
    version: 'verified', flags: 'verified', config: 'verified',
    enforcement: 'residual: primitive enforced, exec mapping unproven', approvalPolicy: 'residual',
    forkSchema: 'verified',
  });
  const env = calls[0].options.env;
  assert.equal(env.TMPDIR, undefined, 'the /var/tmp fixture must not become a writable root');
  assert.equal(env.HOME, env.CODEX_HOME);
  assert.ok(calls.every(call => call.executable === identity.executablePath));
  assert.deepEqual(leftoverFixtures(), before);
});

test('full-access nodes label enforcement not-applicable and skip the sandbox probe', async () => {
  const { run, calls } = fakeRun();
  const verdict = await evaluateCodexRuntime(identity, { run, workspaceWrite: false, probeRoot: PROBE_ROOT });
  assert.equal(verdict.compatible, true);
  assert.equal(verdict.checks.enforcement, 'not-applicable');
  assert.ok(!calls.some(call => call.args[0] === 'sandbox'));
});

test('a missing SDK flag is incompatible and names the flag', async () => {
  const { run } = fakeRun({ exec: args => (args.includes('--thread-source')
    ? fail("error: unexpected argument '--thread-source' found") : ok('Usage: codex exec')) });
  const verdict = await evaluateCodexRuntime(identity, { run, probeRoot: PROBE_ROOT });
  assert.equal(verdict.compatible, false);
  assert.equal(verdict.checks.flags, 'failed');
  assert.equal(verdict.reason, '`exec` does not accept --thread-source');
});

test('an invalid sandbox value or missing usage output is incompatible', async () => {
  const invalid = fakeRun({ exec: args => (args.includes('read-only')
    ? fail("error: invalid value 'read-only' for '--sandbox <SANDBOX_MODE>'") : ok('Usage: codex exec resume')) });
  const verdict = await evaluateCodexRuntime(identity, { run: invalid.run, probeRoot: PROBE_ROOT });
  assert.match(verdict.reason, /exec \(supervisor\)` rejected Nassaj's arguments \(invalid value 'read-only'/u);
  const silent = await evaluateCodexRuntime(identity, { run: fakeRun({ exec: () => ok('') }).run, probeRoot: PROBE_ROOT });
  assert.match(silent.reason, /no usage output/u);
});

test('a rejected config key is incompatible without leaking the fixture path', async () => {
  const { run } = fakeRun({ config: (args, options) => {
    if (args.some(arg => arg.includes('canary'))) return fail('Error: unknown configuration field `canary`');
    const file = fs.readFileSync(path.join(options.env.CODEX_HOME, 'config.toml'), 'utf8');
    if (file.includes('canary')) return fail('Error: unknown configuration field `canary`');
    return fail(`Error: ${options.env.CODEX_HOME}/config.toml:3:1: unknown configuration field \`web_search\``);
  } });
  const verdict = await evaluateCodexRuntime(identity, { run, probeRoot: PROBE_ROOT });
  assert.equal(verdict.compatible, false);
  assert.equal(verdict.checks.config, 'failed');
  assert.equal(verdict.reason, 'config rejected: unknown configuration field `web_search`');
});

test('a rejected enum value in a -c variant is incompatible', async () => {
  const { run } = fakeRun({ config: (args, options) => {
    const file = fs.readFileSync(path.join(options.env.CODEX_HOME, 'config.toml'), 'utf8');
    if (args.some(arg => arg.includes('canary')) || file.includes('canary')) return fail('Error: unknown field');
    return args.includes('model_reasoning_effort="xhigh"')
      ? fail('Error: unknown variant `xhigh`, expected one of `low`') : ok();
  } });
  const verdict = await evaluateCodexRuntime(identity, { run, probeRoot: PROBE_ROOT });
  assert.match(verdict.reason, /config rejected: unknown variant `xhigh`/u);
});

test('strict-config that ignores unknown keys leaves config residual, not verified', async () => {
  const cli = fakeRun({ config: () => ok() });
  const verdict = await evaluateCodexRuntime(identity, { run: cli.run, probeRoot: PROBE_ROOT });
  assert.equal(verdict.compatible, true);
  assert.equal(verdict.checks.config, 'residual: --strict-config accepted an unknown -c key');
  const fileOnly = fakeRun({ config: args => (args.some(arg => arg.includes('canary')) ? fail('Error: x') : ok()) });
  const second = await evaluateCodexRuntime(identity, { run: fileOnly.run, probeRoot: PROBE_ROOT });
  assert.equal(second.checks.config, 'residual: --strict-config accepted an unknown config.toml key');
});

test('the base config file carries every Nassaj key', () => {
  for (const key of ['approval_policy', 'sandbox_mode', 'web_search', 'model_reasoning_effort',
    'developer_instructions', 'project_doc_max_bytes', 'mcp_servers', 'multi_agent', 'network_access',
    'writable_roots']) assert.match(CODEX_NASSAJ_CONFIG_TOML, new RegExp(`^${key} = `, 'mu'));
});

test('a sandbox that permits an outside write or network is incompatible', async () => {
  const write = fakeRun({ sandbox: { writeOutside: true } });
  const wrote = await evaluateCodexRuntime(identity, { run: write.run, workspaceWrite: true, probeRoot: PROBE_ROOT });
  assert.equal(wrote.compatible, false);
  assert.equal(wrote.checks.enforcement, 'failed');
  assert.equal(wrote.reason, 'workspace-write sandbox allowed a write outside');
  const open = fakeRun({ sandbox: { network: true } });
  const networked = await evaluateCodexRuntime(identity, { run: open.run, workspaceWrite: true, probeRoot: PROBE_ROOT });
  assert.equal(networked.reason, 'workspace-write sandbox allowed network access');
});

test('a sandbox that refuses the workspace itself, or fails to run, is incompatible', async () => {
  const refuseInside = async (executable, args, options) => (args[0] === 'sandbox' ? ok() : fakeRun().run(executable, args, options));
  const verdict = await evaluateCodexRuntime(identity, { run: refuseInside, workspaceWrite: true, probeRoot: PROBE_ROOT });
  assert.equal(verdict.reason, 'workspace-write sandbox refused a write inside the workspace');
  const broken = async (executable, args, options) => (args[0] === 'sandbox'
    ? fail('Error: bwrap missing') : fakeRun().run(executable, args, options));
  const failed = await evaluateCodexRuntime(identity, { run: broken, workspaceWrite: true, probeRoot: PROBE_ROOT });
  assert.equal(failed.reason, 'sandbox probe failed (bwrap missing)');
});

test('fork schema sanity is informational and names missing methods', async () => {
  const missing = fakeRun({ schema: args => writeSchema(args, ['initialize', 'turn/start']) });
  const verdict = await evaluateCodexRuntime(identity, { run: missing.run, probeRoot: PROBE_ROOT });
  assert.equal(verdict.compatible, true);
  assert.equal(verdict.checks.forkSchema, 'failed: schema lacks thread/fork, turn/interrupt');
  const broken = fakeRun({ schema: () => fail('Error: nope') });
  const failed = await evaluateCodexRuntime(identity, { run: broken.run, probeRoot: PROBE_ROOT });
  assert.equal(failed.checks.forkSchema, 'failed: schema generation failed (nope)');
  const unreadable = fakeRun({ schema: () => ok() });
  const empty = await evaluateCodexRuntime(identity, { run: unreadable.run, probeRoot: PROBE_ROOT });
  assert.equal(empty.checks.forkSchema, 'failed: schema output unreadable');
});

test('cache key = tree + SDK source + resolver + probe plan', async () => {
  const base = codexRuntimeCacheKey(identity, { sdkSourceDigest: 'sdk', workspaceWrite: true });
  assert.equal(base, codexRuntimeCacheKey({ ...identity }, { sdkSourceDigest: 'sdk', workspaceWrite: true }));
  assert.notEqual(base, codexRuntimeCacheKey({ ...identity, treeDigest: 'x' }, { sdkSourceDigest: 'sdk', workspaceWrite: true }));
  assert.notEqual(base, codexRuntimeCacheKey({ ...identity, resolverDigest: 'x' }, { sdkSourceDigest: 'sdk', workspaceWrite: true }));
  assert.notEqual(base, codexRuntimeCacheKey(identity, { sdkSourceDigest: 'other', workspaceWrite: true }));
  assert.notEqual(base, codexRuntimeCacheKey(identity, { sdkSourceDigest: 'sdk', workspaceWrite: false }));
  assert.equal(base, codexRuntimeCacheKey({ ...identity, executablePath: '/elsewhere', version: '9.9.9' },
    { sdkSourceDigest: 'sdk', workspaceWrite: true }), 'inode/path stamps are not part of the key');
});

test('verdicts are cached per key; a new tree or SDK source re-evaluates', async () => {
  let evaluations = 0;
  setCodexRuntimeEvaluatorForTests(async id => { evaluations += 1; return { compatible: true, version: id.version, reason: null, checks: {} }; });
  const options = { sdkSourceDigest: 'sdk', workspaceWrite: false };
  assert.equal(peekCodexRuntimeVerdict(identity, options), null);
  await Promise.all([getCodexRuntimeVerdict(identity, options), getCodexRuntimeVerdict(identity, options)]);
  await assertCodexRuntimeCompatible(identity, options);
  assert.equal(evaluations, 1, 'concurrent and later launches share one evaluation');
  assert.equal(peekCodexRuntimeVerdict(identity, options).compatible, true);
  await getCodexRuntimeVerdict({ ...identity, treeDigest: 'sha256:next' }, options);
  await getCodexRuntimeVerdict(identity, { ...options, sdkSourceDigest: 'sdk2' });
  assert.equal(evaluations, 3);
  clearCodexRuntimeCompatCache();
  await getCodexRuntimeVerdict(identity, options);
  assert.equal(evaluations, 4);
});

test('an incompatible verdict throws CODEX_RUNTIME_INCOMPATIBLE with the bilingual message', async () => {
  setCodexRuntimeEvaluatorForTests(async id => ({ compatible: false, version: id.version, reason: 'r', checks: {} }));
  await assert.rejects(assertCodexRuntimeCompatible(identity, { sdkSourceDigest: 's' }), error => {
    assert.ok(isCodexRuntimeIncompatible(error));
    assert.equal(error.code, CODEX_RUNTIME_INCOMPATIBLE);
    assert.equal(error.version, '0.156.0');
    assert.equal(error.reason, 'r');
    assert.equal(error.message, codexRuntimeIncompatibleMessage('0.156.0', 'r'));
    return true;
  });
  assert.equal(codexRuntimeIncompatibleMessage('X', 'Y'),
    'نسخة Codex على الجهاز (X) غير متوافقة مع نسّاج: Y. أعد Codex لنسخة متوافقة أو انتظر تحديث نسّاج'
    + ' / The machine Codex (X) is incompatible with Nassaj: Y. Restore a compatible Codex or wait for a Nassaj update');
});

test('transient probe failures and mid-probe release changes are never cached', async () => {
  let spawns = 0;
  const timeout = async () => { spawns += 1; return { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, error: null }; };
  const options = { run: timeout, sdkSourceDigest: 'sdk', workspaceWrite: false, probeRoot: PROBE_ROOT };
  await assert.rejects(assertCodexRuntimeCompatible(identity, options), /flag probe timed out/u);
  await assert.rejects(assertCodexRuntimeCompatible(identity, options), /flag probe timed out/u);
  assert.equal(spawns, 2, 'a timeout is retried by the next launch');
  const spawnError = async () => ({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: new Error('EAGAIN') });
  await assert.rejects(assertCodexRuntimeCompatible(identity, { ...options, run: spawnError }), /could not run/u);
  const changed = { ...options, run: fakeRun().run,
    assertUnchanged: () => { throw Object.assign(new Error('CODEX_RUNTIME_CHANGED'), { code: 'CODEX_RUNTIME_CHANGED' }); } };
  await assert.rejects(getCodexRuntimeVerdict(identity, changed), /CODEX_RUNTIME_CHANGED/u);
  assert.equal(peekCodexRuntimeVerdict(identity, options), null);
  const settled = await getCodexRuntimeVerdict(identity, { ...changed, assertUnchanged: () => {} });
  assert.equal(settled.compatible, true, 'the next launch re-evaluates instead of reusing the failure');
});

test('boot prewarm never throws: missing CLI or failing evaluation resolve to null', async () => {
  assert.equal(await prewarmCodexRuntimeCompat(() => { throw new Error('CODEX_MACHINE_CLI_MISSING'); }), null);
  setCodexRuntimeEvaluatorForTests(async () => { throw new Error('boom'); });
  assert.equal(await prewarmCodexRuntimeCompat(() => identity, { sdkSourceDigest: 's' }), null);
  setCodexRuntimeEvaluatorForTests(async id => ({ compatible: true, version: id.version, reason: null, checks: {} }));
  assert.equal((await prewarmCodexRuntimeCompat(() => identity, { sdkSourceDigest: 's' })).compatible, true);
});

test('runCodexProbe is shell-less, bounded and killed at its deadline', async () => {
  const echoed = await runCodexProbe('/bin/sh', ['-c', 'printf "$0"', '$(id)'], { env: {}, cwd: PROBE_ROOT });
  assert.equal(echoed.stdout, '$(id)', 'argv is never shell-expanded');
  const big = await runCodexProbe('/bin/sh', ['-c', 'head -c 200000 /dev/zero'], { env: {}, cwd: PROBE_ROOT });
  assert.equal(big.stdout.length, 64 * 1024);
  const slow = await runCodexProbe('/bin/sleep', ['5'], { env: {}, cwd: PROBE_ROOT, timeoutMs: 50 });
  assert.equal(slow.timedOut, true);
  const missing = await runCodexProbe('/nonexistent/codex', [], { env: {}, cwd: PROBE_ROOT });
  assert.equal(missing.error?.code, 'ENOENT');
});

// Real machine release, when this host has one: the probes answer for real.
let machineIdentity = null;
try { machineIdentity = acquireCodexLaunchIdentity(); } catch { /* No machine Codex on this host. */ }
const realOptions = { skip: machineIdentity ? false : 'no machine Codex release on this host' };

test('real machine Codex: --strict-config rejects unknown keys in config.toml and in -c', realOptions, async () => {
  const home = fs.mkdtempSync(path.join(PROBE_ROOT, 'nassaj-codex-strict-'));
  try {
    const env = { HOME: home, CODEX_HOME: home, PATH: '/usr/bin:/bin' };
    const cli = (...args) => runCodexProbe(machineIdentity.executablePath, ['app-server', '--strict-config', ...args], { env, cwd: home });
    const override = await cli('-c', 'nassaj_bogus_key=1');
    assert.notEqual(override.code, 0);
    assert.match(override.stderr, /unknown configuration field `nassaj_bogus_key`/u);
    fs.writeFileSync(path.join(home, 'config.toml'), 'nassaj_bogus_key = 1\n');
    const file = await cli();
    assert.notEqual(file.code, 0);
    assert.match(file.stderr, /unknown configuration field `nassaj_bogus_key`/u);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('real machine Codex: the full evaluation, including the workspace-write sandbox probe', realOptions, async () => {
  const verdict = await evaluateCodexRuntime(machineIdentity, { workspaceWrite: true, probeRoot: PROBE_ROOT });
  assert.equal(verdict.compatible, true, verdict.reason);
  assert.equal(verdict.checks.flags, 'verified');
  assert.equal(verdict.checks.config, 'verified');
  assert.equal(verdict.checks.enforcement, 'residual: primitive enforced, exec mapping unproven');
  const sdkSourceDigest = codexFileDigest(resolveCodexSdkSourceEntry());
  assert.ok(sdkSourceDigest.startsWith('sha256:'));
});

test('the compat module imports no project module beyond codex-executable', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('./codex-runtime-compat.js', import.meta.url)), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/gu)].map(match => match[1]);
  assert.deepEqual(imports.filter(name => !name.startsWith('node:')), ['./codex-executable.js']);
});
