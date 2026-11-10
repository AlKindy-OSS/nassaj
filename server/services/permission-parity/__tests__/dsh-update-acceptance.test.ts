/**
 * dsh-update-acceptance.test — T-2091 S1 (owner 2026-11-08: "updating DeepSeek must not break
 * the Nassaj integration"). Acceptance first (TDD): written BEFORE the guard-based policy
 * plugin, the tool map data file and the update pipeline exist; red until S2+.
 *
 * The S1 gate (NASSAJ_TEST_DSH_UPDATE_ACCEPTANCE) was removed in S4: the suite runs in
 * `npm run test:server`. The real-binary counterparts: dsh-policy-live.test.ts and
 * harness-update/npm-lock/dsh-pipeline.real.test.ts (NASSAJ_TEST_DSH_LIVE_BIN).
 *
 * Ground truth: fixtures/t2091-stage0/stage0-evidence.json (real dsh 0.2.2-rc.1): the public
 * ctx.tools.guard runs after pre-execute, also when a listener ahead allowed without next(),
 * and covers subagents; ctx.tools.execute is the boot probe path; restrict needs an agent ctx;
 * unknown layer ids are ignored silently; engines.dsh is enforced on a --patch plugin row.
 * dsh-tools-host.mjs emulates that API and simulates other dsh versions (script options).
 *
 * Contracts fixed for S2+ (variable specifiers: absent today):
 *   server/governance/dsh-policy-plugin/index.mjs (+ package.json, engines.dsh) — the rebuilt plugin;
 *     hello `{ type: 'hello', protocol: 2, probes: { P1, P2, P3 }, tools: [{ name, schema }] }`.
 *   @/services/permission-parity/dsh-parity-broker.js — createParityBroker as today; codes
 *     dsh_cap_tools_api, dsh_cap_gate, dsh_cap_channel (refuse launch), dsh_cap_restrict (non-fatal),
 *     dsh_gate_bypassed (incident + turn ends).
 *   @/services/permission-parity/dsh-tool-map.js — loadDshToolMap() (server/services/permission-parity/
 *     dsh-tool-map.json), compareToolSchemas(map, declared) → { newTools, changed, lost }.
 *   @/services/permission-parity/dsh-contract-suite.js — checkSecurityRows(dumpConfig) → missing ids;
 *     buildDshTestLayer(productionText, origin) → { text, changedRows }.
 *   @/modules/providers/harness-update/npm-lock/dsh-update-pipeline.js — createDshUpdatePipeline({ root, install,
 *     contractSuite, freeBytes, estimatedTreeBytes }) → { run({ version }), active(), held(), status(),
 *     async verifyActive(), async reportLaunchCapabilityFailure({ version, code }) }.
 *
 * Runner: TMPDIR=/var/tmp bash scripts/run-without-core.sh \
 *   node scripts/run-isolated-node-tests.mjs server server/services/permission-parity/__tests__/dsh-update-acceptance.test.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..', '..', '..');
const PLUGIN = path.join(appRoot, 'server', 'governance', 'dsh-policy-plugin', 'index.mjs');
const HOST = path.join(here, 'dsh-tools-host.mjs');
const MODULES = {
  broker: '@/services/permission-parity/dsh-parity-broker.js',
  engine: '@/services/permission-parity/claude-parity-engine.js',
  toolMap: '@/services/permission-parity/dsh-tool-map.js',
  contract: '@/services/permission-parity/dsh-contract-suite.js',
  pipeline: '@/modules/providers/harness-update/npm-lock/dsh-update-pipeline.js',
  launch: '@/modules/providers/list/dsh/dsh-launch.js',
};
type Row = Record<string, any>;
const mods: Record<string, Row> = {};
const loadErrors: Record<string, string> = {};
function need(key: keyof typeof MODULES, name: string): any {
  const value = mods[key]?.[name];
  if (value === undefined) assert.fail(`${MODULES[key]} must export ${name}${loadErrors[key] ? ` (${loadErrors[key]})` : ''}`);
  return value;
}

let sandbox = '';
let managed = '';
const recorded = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'dsh-policy-tools.json'), 'utf8'));
const bash = (command: string) => ({ command, description: 'acceptance' });
const step = (callId: string, name: string, args: unknown, more: Row = {}) => ({ callId, name, args, ...more });

/** The rebuilt plugin under the harness (a simulated dsh), wired to a real broker + engine. */
async function runPlugin(script: Row) {
  assert.ok(fs.existsSync(PLUGIN), `${path.relative(appRoot, PLUGIN)} does not exist`);
  const createBroker = need('broker', 'createParityBroker');
  const engine = need('engine', 'createClaudeParityEngine')({ userId: 1, cwd: sandbox, home: sandbox, sessionId: 's',
    transcriptPath: path.join(sandbox, 't.jsonl'), permissionMode: 'bypassPermissions', managedSettingsDir: managed,
    claudeEnv: () => ({ HOME: sandbox, PATH: '/usr/bin:/bin' }) });
  const dir = fs.mkdtempSync(path.join(sandbox, 'host-'));
  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
  const child = spawn(process.execPath, [HOST, PLUGIN, path.join(dir, 'script.json'), dir], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  const incidents: Row[] = [];
  const broker = createBroker({ engine, kill: () => child.kill('SIGKILL'), onIncident: (i: Row) => incidents.push(i),
    askMember: async () => 'reject' });
  broker.attach(child.stdio[3]);
  let stdout = '';
  child.stdout!.on('data', (chunk) => { stdout += chunk; });
  const signal = await new Promise<string | null>((resolve) => child.once('exit', (_c, sig) => resolve(sig)));
  const log = path.join(dir, 'executions.log');
  return { signal, incidents, broker, rows: stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    witness: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [] };
}

/** A fake installer: writes a version tree with a manifest; `tamper` edits a file after. */
function fakeInstall(root: string) {
  const calls: string[] = [];
  return { calls, install: async ({ version, dir }: Row) => {
    calls.push(version);
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), `// dsh ${version}\n`);
    return { treeBytes: 1000 };
  }, root };
}

describe('T-2091 updating DeepSeek must not break the Nassaj integration (acceptance)', () => {
  before(async () => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-dsh-update-')));
    managed = path.join(sandbox, 'managed');
    fs.mkdirSync(managed, { recursive: true });
    fs.writeFileSync(path.join(managed, 'managed-settings.json'), JSON.stringify({ permissions: { deny: ['Bash(pm2 restart *)'] } }));
    for (const [key, specifier] of Object.entries(MODULES)) {
      mods[key] = await import(specifier).catch((error: Error) => { loadErrors[key] = error.message.split('\n')[0]; return {}; });
    }
  });
  after(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); });

  describe('1. a newer dsh that only adds things keeps working', () => {
    it('an extra tool and an extra listener: the session works, the new tool is hidden and denied', async () => {
      const run = await runPlugin({ extraTools: [{ name: 'shiny_new_tool', input_schema: { type: 'object' } }],
        extraListeners: [{ event: 'tools/pre-execute', owner: 'new-dsh-plugin', prepend: true }],
        steps: [step('c-ls', 'bash', bash('ls')), step('c-new', 'shiny_new_tool', {})] });
      assert.equal(run.broker.state.refusal ?? null, null, 'launch refused');
      assert.deepEqual(run.witness, ['c-ls'], 'the session must work and the new tool must not run');
      assert.equal(run.rows.find((r) => r.callId === 'c-new')?.isError, true);
      assert.equal(run.signal, null);
    });
    it('a listener ahead of ours that allows without next() is still denied; incident logged; the turn ends', async () => {
      const run = await runPlugin({ hostileAllow: 'bypass-me', steps: [step('c-bypass', 'bash', bash('touch bypass-me')),
        step('c-after', 'bash', bash('ls'))] });
      assert.ok(!run.witness.includes('c-bypass'), 'the bypassed call ran');
      assert.ok(run.incidents.some((i) => i.code === 'dsh_gate_bypassed'), JSON.stringify(run.incidents));
      assert.equal(run.signal, 'SIGKILL', 'the turn must end');
      assert.ok(!run.witness.includes('c-after'));
    });
  });

  describe('1b. qa I1: the probe path and the permit key', () => {
    it('after the handshake a call named like the probe gets no permit (denied by our listener)', async () => {
      const run = await runPlugin({ steps: [step('nassaj-probe-late-permit', '__nassaj_probe__', {})] });
      assert.equal(run.rows.find((r) => r.callId === 'nassaj-probe-late-permit')?.outcome, 'deny');
    });
    it('a permit is bound to the tool name: the same callId and arguments under another tool are denied', async () => {
      const run = await runPlugin({ steps: [step('c-swap', 'bash', bash('ls'), { guardName: 'write' })] });
      assert.deepEqual(run.witness, []);
      assert.ok(run.incidents.some((i) => i.code === 'dsh_gate_bypassed'));
    });
  });

  describe('2. a breaking dsh is refused at launch (capability probes)', () => {
    for (const [label, script, code] of [
      ['guard() removed', { api: { noGuard: true } }, 'dsh_cap_tools_api'],
      ['execute() removed', { api: { noExecute: true } }, 'dsh_cap_tools_api'],
      ['tools/pre-execute renamed', { renameEvents: { 'tools/pre-execute': 'tools/before-execute' } }, 'dsh_cap_gate'],
    ] as const) {
      it(`${label} → ${code}, no call runs`, async () => {
        const run = await runPlugin({ ...script, steps: [step('c-1', 'bash', bash('ls'))] });
        assert.equal(run.broker.state.refusal, code);
        assert.deepEqual(run.witness, []);
      });
    }
  });

  describe('3. the tool map is data and is compared at boot', () => {
    it('a new tool is hidden (not held); a changed mapped field or a lost mapped tool holds the update', () => {
      const map = need('toolMap', 'loadDshToolMap')();
      const compare = need('toolMap', 'compareToolSchemas');
      const declared = recorded.tools.map((t: Row) => ({ name: t.name, schema: t.input_schema }));
      assert.deepEqual(compare(map, declared), { newTools: [], changed: [], lost: [] });
      assert.deepEqual(compare(map, [...declared, { name: 'shiny_new_tool', schema: { type: 'object' } }]).newTools, ['shiny_new_tool']);
      const renamedCommand = declared.map((t: Row) => (t.name !== 'bash' ? t : { name: 'bash', schema: { ...t.schema,
        properties: { ...Object.fromEntries(Object.entries(t.schema.properties).filter(([k]) => k !== 'command')), cmd: { type: 'string' } },
        required: ['cmd', 'description'] } }));
      // qa C1: the renamed field is changed, the new one unreviewed, and the required list differs.
      assert.deepEqual(compare(map, renamedCommand).changed.map((c: Row) => [c.name, c.field]).sort(),
        [['bash', 'cmd'], ['bash', 'command'], ['bash', 'required']]);
      assert.deepEqual(compare(map, declared.filter((t: Row) => t.name !== 'read')).lost, ['read']);
    });
    it('qa C1: an added property or a changed `required` list on a mapped tool counts as changed', () => {
      const map = need('toolMap', 'loadDshToolMap')();
      const compare = need('toolMap', 'compareToolSchemas');
      const declared = recorded.tools.map((t: Row) => ({ name: t.name, schema: t.input_schema }));
      const withFiles = declared.map((t: Row) => (t.name !== 'write' ? t : { name: 'write', schema: { ...t.schema,
        properties: { ...t.schema.properties, files: { type: 'array' } } } }));
      assert.deepEqual(compare(map, withFiles).changed.map((c: Row) => [c.name, c.field]), [['write', 'files']]);
      const optionalPath = declared.map((t: Row) => (t.name !== 'write' ? t : { name: 'write', schema: { ...t.schema,
        required: ['content'] } }));
      assert.deepEqual(compare(map, optionalPath).changed.map((c: Row) => [c.name, c.field]), [['write', 'required']]);
      for (const [name, entry] of Object.entries(map.tools) as Array<[string, Row]>) {
        assert.ok(Array.isArray(entry.ignored), `${name}: every unmapped property must be reviewed (ignored list)`);
      }
    });
  });

  describe('4. the contract suite', () => {
    it('a security row id that disappeared from --dump-config holds the update', () => {
      const check = need('contract', 'checkSecurityRows');
      const ok = { rows: ['llm-deepseek', 'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
        'plugin-manager', 'tool-plugin-manager', 'deepseek-account', 'llm-deepseek-account', 'llm-pi-ai', 'goal-round-driver',
        'tool-jobs', 'permission', 'ptc-runtime'].map((id) => ({ id })) };
      assert.deepEqual(check(ok), []);
      assert.deepEqual(check({ rows: ok.rows.filter((r) => r.id !== 'session-log-deepseek') }), ['session-log-deepseek']);
    });
    it('the test layer differs from the pinned production layer by exactly the LLM row, and launch rejects it', () => {
      const build = need('contract', 'buildDshTestLayer');
      const production = fs.readFileSync(path.join(appRoot, 'server', 'governance', 'dsh-nassaj-layer.yml'), 'utf8');
      const { text, changedRows } = build(production, 'http://127.0.0.1:9/anthropic');
      assert.deepEqual(changedRows, ['llm-deepseek']);
      const file = path.join(sandbox, 'test-layer.yml');
      fs.writeFileSync(file, text);
      assert.throws(() => need('launch', 'verifyNassajDshLayer')(file), { code: 'dsh_layer_untrusted' });
    });
  });

  describe('4b. the plugin\'s engines.dsh range (enforced by dsh: an incompatible row is disabled)', () => {
    it('a 1.0.0 candidate is held with dsh_plugin_engines_incompatible; the pinned rc and 0.2.x pass', () => {
      const check = need('contract', 'checkPluginEngines');
      assert.equal(check('1.0.0'), 'dsh_plugin_engines_incompatible');
      assert.equal(check('0.2.2-rc.1'), null);
      assert.equal(check('0.2.3'), null);
      const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'server', 'governance', 'dsh-policy-plugin', 'package.json'), 'utf8'));
      assert.equal(pkg.engines?.dsh, '>=0.2.2-rc.1 <1.0.0');
    });
  });

  describe('5. the update pipeline behind the owner\'s button', () => {
    const OLD = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    function pipeline(contract: (v: string) => Row = () => ({ ok: true }), freeBytes = 1e9, extra: Row = {}) {
      const root = extra.root ?? fs.mkdtempSync(path.join(sandbox, 'dsh-data-'));
      const fake = fakeInstall(root);
      const instance = need('pipeline', 'createDshUpdatePipeline')({ root, install: fake.install,
        contractSuite: async ({ version }: Row) => contract(version), freeBytes: () => freeBytes, estimatedTreeBytes: 1000,
        publishedAt: async () => OLD, verifySignatures: async () => ({ ok: true }), ...extra });
      return { instance, fake, root };
    }
    it('qa I2: a candidate younger than 72 h, or failing npm audit signatures, is held', async () => {
      const young = pipeline(() => ({ ok: true }), 1e9, { publishedAt: async () => new Date(Date.now() - 3600 * 1000).toISOString() });
      assert.equal((await young.instance.run({ version: '0.2.2-rc.1' })).code, 'dsh_update_too_new');
      assert.deepEqual(young.fake.calls, []);
      const unknown = pipeline(() => ({ ok: true }), 1e9, { publishedAt: async () => null });
      assert.equal((await unknown.instance.run({ version: '0.2.2-rc.1' })).code, 'dsh_update_too_new');
      const unsigned = pipeline(() => ({ ok: true }), 1e9, { verifySignatures: async () => ({ ok: false }) });
      assert.equal((await unsigned.instance.run({ version: '0.2.2-rc.1' })).code, 'dsh_update_signature_failed');
      assert.equal(unsigned.instance.active().version, null);
    });
    it('qa I3: a transient contract failure is retried (bounded); a hold is owner-clearable', async () => {
      let calls = 0;
      const flaky = pipeline(() => ((calls += 1) === 1 ? { ok: false, code: 'dsh_cap_channel' } : { ok: true }));
      assert.equal((await flaky.instance.run({ version: '0.2.2-rc.1' })).status, 'green');
      assert.equal(calls, 2);
      let gateCalls = 0;
      const broken = pipeline(() => { gateCalls += 1; return { ok: false, code: 'dsh_cap_gate' }; });
      assert.equal((await broken.instance.run({ version: '0.2.2-rc.1' })).code, 'dsh_cap_gate');
      assert.equal(gateCalls, 1, 'a definitive failure is not retried');
      assert.equal(broken.instance.status().clearable, true);
      assert.equal(broken.instance.clearHold({ version: '0.2.2-rc.1' }), true);
      assert.equal(broken.instance.held().length, 0);
      assert.equal((await broken.instance.run({ version: '0.2.2-rc.1' })).code, 'dsh_cap_gate', 'an explicit retry runs again');
      assert.equal(gateCalls, 2);
    });
    it('qa I3: one dsh_cap_channel after a switch does not roll back; a second one does', async () => {
      const { instance } = pipeline();
      await instance.run({ version: '0.2.2-rc.1' });
      await instance.run({ version: '0.3.0' });
      assert.equal(await instance.reportLaunchCapabilityFailure({ version: '0.3.0', code: 'dsh_cap_channel' }), false);
      assert.equal(instance.active().version, '0.3.0');
      assert.equal(await instance.reportLaunchCapabilityFailure({ version: '0.3.0', code: 'dsh_cap_channel' }), true);
      assert.equal(instance.active().version, '0.2.2-rc.1');
    });
    it('qa round 2 M1: a successful launch ends `switched` and resets the channel counter; promote resets it too', async () => {
      const { instance, root } = pipeline();
      await instance.run({ version: '0.2.2-rc.1' });
      await instance.run({ version: '0.3.0' });
      assert.equal(await instance.reportLaunchCapabilityFailure({ version: '0.3.0', code: 'dsh_cap_channel' }), false);
      instance.reportLaunchSuccess({ version: '0.3.0' });
      const after = JSON.parse(fs.readFileSync(path.join(root, 'update-state.json'), 'utf8'));
      assert.equal(after.channelFailures, 0);
      assert.equal(instance.status().state, 'installed');
      assert.equal(await instance.reportLaunchCapabilityFailure({ version: '0.3.0', code: 'dsh_cap_channel' }), false);
      assert.equal(await instance.reportLaunchCapabilityFailure({ version: '0.3.0', code: 'dsh_cap_channel' }), false,
        'no rollback once the switch was proven by a good launch');
      assert.equal(instance.active().version, '0.3.0');
      const state = JSON.parse(fs.readFileSync(path.join(root, 'update-state.json'), 'utf8'));
      fs.writeFileSync(path.join(root, 'update-state.json'), JSON.stringify({ ...state, channelFailures: 1 }));
      await instance.run({ version: '0.3.1' });
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'update-state.json'), 'utf8')).channelFailures, 0);
    });
    it('qa round 2 M3: a lock whose pid was reused by another process (other start time) is stale', async () => {
      const { instance, root } = pipeline();
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      try {
        fs.writeFileSync(path.join(root, 'pipeline.lock'), `${other.pid}:1`);
        assert.equal((await instance.run({ version: '0.2.2-rc.1' })).status, 'green');
      } finally { other.kill('SIGKILL'); }
    });
    it('qa I4: after a crash, staging leftovers are swept and a stale `checking` state is corrected', async () => {
      const { root } = pipeline();
      fs.mkdirSync(path.join(root, 'staging', 'crashed-run', 'tree'), { recursive: true });
      fs.writeFileSync(path.join(root, 'update-state.json'), JSON.stringify({ active: null, previous: null, held: [],
        status: { state: 'checking', code: null, candidateVersion: '0.3.0' } }));
      const { instance } = pipeline(() => ({ ok: true }), 1e9, { root });
      instance.recover();
      assert.deepEqual(fs.readdirSync(path.join(root, 'staging')), []);
      assert.equal(instance.status().state, 'installed');
      assert.equal(instance.status().code, 'dsh_update_interrupted');
    });
    it('a pipeline run in another live process holds the lock: this one is refused', async () => {
      const { instance, root } = pipeline();
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      try {
        fs.writeFileSync(path.join(root, 'pipeline.lock'), String(other.pid));
        assert.equal((await instance.run({ version: '0.2.2-rc.1' })).code, 'dsh_update_busy');
        other.kill('SIGKILL');
        await new Promise((resolve) => other.once('exit', resolve));
        assert.equal((await instance.run({ version: '0.2.2-rc.1' })).status, 'green', 'a dead holder is a stale lock');
      } finally { other.kill('SIGKILL'); }
    });
    it('the button\'s candidate is the newest exact version on the installed channel', async () => {
      const { pickDshCandidate } = await import('@/modules/providers/harness-update/npm-lock/dsh-pipeline-update.js');
      const published = ['0.2.1', '0.2.2-rc.1', '0.2.2', '0.2.3-rc.1', '0.3.0-rc.2', 'latest', '0.1.0'];
      assert.equal(pickDshCandidate('0.2.2-rc.1', published), '0.3.0-rc.2', 'rc channel: newest prerelease or release');
      assert.equal(pickDshCandidate('0.2.2', published), null, 'stable channel: no prerelease, nothing newer');
      assert.equal(pickDshCandidate('0.2.1', published), '0.2.2');
      assert.equal(pickDshCandidate('0.3.0-rc.2', published), null);
    });
    it('never @latest: only an exact version is installed', async () => {
      const { instance, fake } = pipeline();
      for (const version of ['latest', '', '^0.3.0', 'next']) {
        assert.equal((await instance.run({ version })).code, 'dsh_update_version_not_pinned', version);
      }
      assert.deepEqual(fake.calls, []);
    });
    it('green → atomic switch of the active pointer; the previous version is kept', async () => {
      const { instance } = pipeline();
      assert.equal((await instance.run({ version: '0.2.2-rc.1' })).status, 'green');
      assert.equal((await instance.run({ version: '0.2.3' })).status, 'green');
      assert.equal(instance.active().version, '0.2.3');
      assert.ok(instance.active().previous === '0.2.2-rc.1');
    });
    it('red contract → held with the failing code; the current version keeps working', async () => {
      const { instance } = pipeline((v) => (v === '0.3.0' ? { ok: false, code: 'dsh_cap_gate' } : { ok: true }));
      await instance.run({ version: '0.2.2-rc.1' });
      const result = await instance.run({ version: '0.3.0' });
      assert.deepEqual([result.status, result.code], ['held', 'dsh_cap_gate']);
      assert.equal(instance.active().version, '0.2.2-rc.1');
      assert.ok(instance.held().some((h: Row) => h.version === '0.3.0' && h.code === 'dsh_cap_gate'));
    });
    it('a candidate whose bash `command` field changed, or that lost a mapped tool, is held', async () => {
      for (const code of ['dsh_tool_schema_changed', 'dsh_tool_lost']) {
        const { instance } = pipeline((v) => (v === '0.3.0' ? { ok: false, code } : { ok: true }));
        await instance.run({ version: '0.2.2-rc.1' });
        assert.deepEqual([(await instance.run({ version: '0.3.0' })).status, instance.active().version], ['held', '0.2.2-rc.1']);
      }
    });
    it('green, then the first live launch fails P2 → automatic rollback, candidate held, no flapping', async () => {
      const { instance } = pipeline();
      await instance.run({ version: '0.2.2-rc.1' });
      await instance.run({ version: '0.3.0' });
      assert.equal(await instance.reportLaunchCapabilityFailure({ version: '0.3.0', code: 'dsh_cap_gate' }), true);
      assert.equal(instance.active().version, '0.2.2-rc.1');
      assert.ok(instance.held().some((h: Row) => h.version === '0.3.0'));
      assert.equal((await instance.run({ version: '0.3.0' })).status, 'held', 'a held candidate must not be re-activated');
      assert.equal(await instance.reportLaunchCapabilityFailure({ version: '0.2.2-rc.1', code: 'dsh_permission_rule_unsupported' }), false);
      assert.equal(instance.active().version, '0.2.2-rc.1', 'a member-specific refusal never rolls back');
    });
    it('a tree tampered after the switch is refused', async () => {
      const { instance } = pipeline();
      await instance.run({ version: '0.2.2-rc.1' });
      assert.equal(await instance.verifyActive(), null, 'the switched tree verifies');
      fs.appendFileSync(path.join(instance.active().dir, 'lib', 'bin.js'), '// planted\n');
      assert.equal(await instance.verifyActive(), 'tree_tampered');
    });
    it('free disk below 3× the tree size → held: disk', async () => {
      const { instance, fake } = pipeline(() => ({ ok: true }), 2000);
      const result = await instance.run({ version: '0.2.2-rc.1' });
      assert.deepEqual([result.status, result.code], ['held', 'dsh_update_held_disk']);
      assert.deepEqual(fake.calls, []);
    });
    it('a concurrent pipeline run is refused', async () => {
      const { instance } = pipeline();
      const [first, second] = await Promise.all([instance.run({ version: '0.2.2-rc.1' }), instance.run({ version: '0.2.3' })]);
      assert.equal(first.status, 'green');
      assert.equal(second.code, 'dsh_update_busy');
    });
  });
});
