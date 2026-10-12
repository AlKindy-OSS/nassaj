/**
 * ADR-200 S2 acceptance (C1, D7) — header-echo across the full 7-channel
 * matrix plus ANTHROPIC_CUSTOM_HEADERS, against the REAL Claude CLI.
 *
 * Every credential is a dummy. The CLI and a local echo endpoint run together
 * inside a private network namespace (`unshare -rn`), so no request can leave
 * the host. The echo endpoint is admitted the only way a test may: as the
 * engine host handed to the guard (`engineHosts`), never via the operator list.
 *
 * Per channel, two runs:
 *   - baseline: the dummy planted, the CLI pointed at the echo endpoint with no
 *     protection. Proves the channel really reaches the wire on this CLI build.
 *   - protected: the production sequence of resolveClaudeRunProfileOrThrow for
 *     a pinned spawn (derived config dir, then the B-1541 guard). Either the
 *     guard refuses (no request at all) or the request carries ONLY the engine
 *     bearer: no x-api-key, no dummy in any header.
 *
 * The managed-policy tier lives in /etc and cannot be planted without root, so
 * its row is checked through the guard's test seam only (no live baseline).
 * Skipped when the CLI or an unprivileged network namespace is unavailable.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertClaudeSpawnEnvAllowed } from './claude-spawn-env-guard.js';
import { ENGINE_ANTHROPIC_CREDENTIAL_CODE } from './engine-anthropic-credential-guard.js';
import { prepareEnginePinConfigDir } from './engine-pin-config-dir.js';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'engine-pin-header-echo.fixture.mjs');
const ENGINE_TOKEN = 'ENGINE-DUMMY-TOKEN-S2';
const ECHO_HOSTS = new Set(['127.0.0.1']);
const dummy = (label: string) => `sk-ant-api03-DUMMY-S2-${label}`;
const ALL_DUMMIES = ['SPAWN', 'SPAWNHDR', 'MANAGED', 'USER', 'PROJECT', 'LOCAL', 'HELPER', 'PRIMARY', 'USERHDR', 'OAUTH']
  .map(dummy);

/** Absolute path of the installed `claude` binary, or null. */
function findClaude(): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'claude');
    if (dir && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}

/** True when an unprivileged loopback-only network namespace can be created. */
function netnsAvailable(): boolean {
  const probe = spawnSync('unshare', ['-rn', 'sh', '-c', 'ip link set lo up'], { timeout: 10_000 });
  return probe.status === 0;
}

const CLAUDE_BIN = findClaude();
const SKIP = !CLAUDE_BIN ? 'claude CLI not installed' : (!netnsAvailable() ? 'unshare -rn unavailable' : false);

type Sandbox = { root: string; home: string; source: string; cwd: string; managedDir: string };
type Channel = {
  name: string;
  live: boolean;
  /** Expected protected outcome. */
  expect: 'refused' | 'engine-only';
  /** Whether the baseline must show the leak (false when the CLI ignores it by precedence). */
  baselineLeaks: boolean;
  plant: (sb: Sandbox, env: NodeJS.ProcessEnv) => void;
};
type RequestSummary = { path: string; authorization: string; xApiKey: string; leakedHeaders: string[] };

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Merges `patch` into a JSON file (created when absent). */
function mergeJson(file: string, patch: Record<string, unknown>): void {
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  writeJson(file, { ...current, ...patch });
}

const userSettingsEnv = (key: string, value: string) => (sb: Sandbox) =>
  mergeJson(path.join(sb.source, 'settings.json'), { env: { [key]: value } });

const CHANNELS: Channel[] = [
  { name: '1 spawn env ANTHROPIC_API_KEY', live: true, expect: 'refused', baselineLeaks: true,
    plant: (_sb, env) => { env.ANTHROPIC_API_KEY = dummy('SPAWN'); } },
  { name: '1b spawn env ANTHROPIC_CUSTOM_HEADERS', live: true, expect: 'refused', baselineLeaks: true,
    plant: (_sb, env) => { env.ANTHROPIC_CUSTOM_HEADERS = `x-nassaj-leak: ${dummy('SPAWNHDR')}`; } },
  { name: '2 managed settings env (guard seam only)', live: false, expect: 'refused', baselineLeaks: false,
    plant: (sb) => writeJson(path.join(sb.managedDir, 'managed-settings.json'),
      { env: { ANTHROPIC_API_KEY: dummy('MANAGED') } }) },
  { name: '3 user settings env ANTHROPIC_API_KEY', live: true, expect: 'engine-only', baselineLeaks: true,
    plant: userSettingsEnv('ANTHROPIC_API_KEY', dummy('USER')) },
  { name: '4 project settings env', live: true, expect: 'refused', baselineLeaks: true,
    plant: (sb) => writeJson(path.join(sb.cwd, '.claude', 'settings.json'),
      { env: { ANTHROPIC_API_KEY: dummy('PROJECT') } }) },
  { name: '5 local settings env', live: true, expect: 'refused', baselineLeaks: true,
    plant: (sb) => writeJson(path.join(sb.cwd, '.claude', 'settings.local.json'),
      { env: { ANTHROPIC_API_KEY: dummy('LOCAL') } }) },
  { name: '6 apiKeyHelper (user settings)', live: true, expect: 'engine-only', baselineLeaks: true,
    plant: (sb) => mergeJson(path.join(sb.source, 'settings.json'), { apiKeyHelper: `echo ${dummy('HELPER')}` }) },
  { name: '7 primaryApiKey (.claude.json)', live: true, expect: 'engine-only', baselineLeaks: true,
    plant: (sb) => mergeJson(path.join(sb.source, '.claude.json'), { primaryApiKey: dummy('PRIMARY') }) },
  { name: '8 user settings ANTHROPIC_CUSTOM_HEADERS', live: true, expect: 'engine-only', baselineLeaks: true,
    plant: userSettingsEnv('ANTHROPIC_CUSTOM_HEADERS', `x-nassaj-leak: ${dummy('USERHDR')}`) },
  { name: '9 user settings CLAUDE_CODE_OAUTH_TOKEN', live: true, expect: 'engine-only', baselineLeaks: false,
    plant: userSettingsEnv('CLAUDE_CODE_OAUTH_TOKEN', dummy('OAUTH')) },
];

/** A throwaway HOME / config dir / project dir with no credential at all. */
function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2-echo-'));
  roots.push(root);
  const sb = {
    root,
    home: path.join(root, 'home'),
    source: path.join(root, 'home', '.claude'),
    cwd: path.join(root, 'project'),
    managedDir: path.join(root, 'managed'),
  };
  for (const dir of [sb.source, sb.cwd, sb.managedDir]) fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(sb.source, '.claude.json'), { hasCompletedOnboarding: true });
  return sb;
}

/** The engine-pinned spawn env, as apply-claude-engine-provider-env leaves it. */
function engineEnv(sb: Sandbox): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: sb.home,
    CLAUDE_CONFIG_DIR: sb.source,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    ANTHROPIC_AUTH_TOKEN: ENGINE_TOKEN,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
}

/** Runs the real CLI against the echo endpoint inside a loopback-only netns. */
function runEcho(sb: Sandbox, env: NodeJS.ProcessEnv, tag: string): RequestSummary[] {
  const specPath = path.join(sb.root, `spec-${tag}.json`);
  const markers = { engine: ENGINE_TOKEN, dummies: ALL_DUMMIES };
  writeJson(specPath, { claudeBin: CLAUDE_BIN, env, cwd: sb.cwd, markers });
  const result = spawnSync('unshare', [
    '-rn', 'sh', '-c', 'ip link set lo up && exec "$0" "$1" "$2"', process.execPath, HARNESS, specPath,
  ], { encoding: 'utf8', timeout: 90_000 });
  fs.rmSync(specPath, { force: true });
  assert.equal(result.status, 0, `harness failed: ${result.stderr?.slice(0, 300)}`);
  return JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}').requests ?? [];
}

/** True when any request carried a planted dummy anywhere. */
const leaked = (requests: RequestSummary[]) => requests.some((r) =>
  r.authorization === 'dummy' || r.xApiKey === 'dummy' || r.leakedHeaders.length > 0);

/** The production pinned-spawn sequence: derived dir, then the B-1541 guard. */
async function protectedRun(channel: Channel): Promise<{ outcome: string; requests: RequestSummary[] }> {
  const sb = makeSandbox();
  const env = engineEnv(sb);
  channel.plant(sb, env);
  env.CLAUDE_CONFIG_DIR = await prepareEnginePinConfigDir(env, { operatorHome: sb.home });
  try {
    await assertClaudeSpawnEnvAllowed(env, { engineHosts: ECHO_HOSTS, cwd: sb.cwd, managedSettingsDir: sb.managedDir });
  } catch (error) {
    assert.equal((error as { code?: string }).code, ENGINE_ANTHROPIC_CREDENTIAL_CODE);
    return { outcome: 'refused', requests: [] };
  }
  if (!channel.live) return { outcome: 'allowed (not run live)', requests: [] };
  return { outcome: 'ran', requests: runEcho(sb, env, 'protected') };
}

const matrix: Array<Record<string, string>> = [];
after(() => { if (matrix.length > 0) console.log(`S2 header-echo matrix\n${JSON.stringify(matrix, null, 1)}`); });

for (const channel of CHANNELS) {
  test(`header-echo: ${channel.name}`, { skip: SKIP }, async () => {
    let baseline = 'not measured (no live tier)';
    if (channel.live) {
      const sb = makeSandbox();
      const env = engineEnv(sb);
      channel.plant(sb, env);
      const requests = runEcho(sb, env, 'baseline');
      assert.ok(requests.length > 0, 'baseline CLI reached the echo endpoint');
      baseline = leaked(requests) ? 'LEAK' : 'no leak';
      if (channel.baselineLeaks) assert.equal(baseline, 'LEAK', 'the channel really reaches the wire');
    }
    const run = await protectedRun(channel);
    const row = { channel: channel.name, baseline, protected: run.outcome, wire: '-' };
    if (run.outcome === 'ran') {
      assert.ok(run.requests.length > 0, 'protected CLI reached the echo endpoint');
      for (const request of run.requests) {
        assert.equal(request.authorization, 'engine', 'only the engine bearer');
        assert.equal(request.xApiKey, 'none', 'no x-api-key');
        assert.deepEqual(request.leakedHeaders, [], 'no dummy in any header');
      }
      row.wire = 'engine bearer only';
    }
    assert.equal(channel.expect === 'refused' ? 'refused' : 'ran', run.outcome);
    matrix.push(row);
  });
}
