/**
 * ADR-227 / T-2098 qa condition sh8 — header-echo against the REAL Claude CLI:
 * a Claude chat on my local model server never sends my claude.ai login there.
 *
 * Stage 2 measured the leak on claude 2.1.312: with a stored claude.ai OAuth
 * login and no ANTHROPIC_AUTH_TOKEN, the CLI sent `Bearer sk-ant-oat01-…` plus
 * the `oauth-2025-04-20` beta to a custom base URL. Here every credential is a
 * dummy, and the CLI and the echo endpoint run in a loopback-only network
 * namespace (`unshare -rn`), so nothing can leave the host.
 *
 *   - baseline: the dummy login in the config dir, the CLI pointed at the echo
 *     endpoint with no protection. Proves the leak is real on this CLI build.
 *   - protected: the production local-engine sequence of
 *     resolve-claude-run-profile.js (resolveLocalClaudeRunProfile): the local env,
 *     the per-server credential-free derived dir, then the spawn guard with the
 *     server's origin. Every request must carry ONLY the local bearer (the server
 *     key, or the fixed placeholder) and no OAuth beta.
 *
 * Skipped when the CLI or an unprivileged network namespace is unavailable,
 * except under NASSAJ_TEST_RELEASE_GATE=1, where a skip fails.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_ENGINE_ENV_KEYS,
  LOCAL_ENGINE_PRIVATE_ENTRIES,
  LOCAL_NO_KEY_PLACEHOLDER,
  applyClaudeLocalEngineEnvOrThrow,
} from './apply-claude-local-engine-env.js';
import { assertClaudeSpawnEnvAllowed } from './claude-spawn-env-guard.js';
import { localEngineDerivedDirName, prepareEnginePinConfigDir } from './engine-pin-config-dir.js';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'engine-pin-header-echo.fixture.mjs');
// Built at runtime so the source carries no token-shaped literal for the export leak scan.
const DUMMY_OAUTH = ['sk', 'ant', 'oat01', 'DUMMY', 'T2098', 'SH8', 'OAUTH'].join('-');
const DUMMY_REFRESH = ['sk', 'ant', 'ort01', 'DUMMY', 'T2098', 'SH8', 'REFRESH'].join('-');
const SERVER_KEY = 'LOCAL-SERVER-KEY-T2098-SH8';

const SERVER = {
  id: '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11',
  ownerId: 7,
  providerId: 'nassaj_local_0b9c6a3e6f1e4c419a4e2f1b9e0c7d11',
  // The echo harness re-points ANTHROPIC_BASE_URL at its own port after the guard ran.
  baseUrl: 'http://127.0.0.1:18080/v1',
  models: [{ id: 'gpt-oss-20b', contextWindow: 32768 }],
};
const MODEL = `${SERVER.providerId}/gpt-oss-20b`;

/**
 * Absolute path of the `claude` binary under test: NASSAJ_TEST_CLAUDE_BIN (set by
 * scripts/prove-claude-local-engine.mjs), else the first one on PATH, or null.
 */
function findClaude(): string | null {
  const pinned = process.env.NASSAJ_TEST_CLAUDE_BIN;
  if (pinned) return fs.existsSync(pinned) ? fs.realpathSync(pinned) : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'claude');
    if (dir && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}

/** True when an unprivileged loopback-only network namespace can be created. */
function netnsAvailable(): boolean {
  return spawnSync('unshare', ['-rn', 'sh', '-c', 'ip link set lo up'], { timeout: 10_000 }).status === 0;
}

const CLAUDE_BIN = findClaude();
const SKIP = !CLAUDE_BIN ? 'claude CLI not installed' : (!netnsAvailable() ? 'unshare -rn unavailable' : false);

// T-2098 qa item 3: in release-gate mode (the acceptance step that records a CLI
// version as proven) a skipped proof is a failed proof.
test('release gate: the header-echo proof actually ran', { skip: process.env.NASSAJ_TEST_RELEASE_GATE !== '1' }, () => {
  assert.equal(SKIP, false, `release gate: header-echo would be skipped (${SKIP})`);
});

type Sandbox = { root: string; home: string; source: string; cwd: string };
type RequestSummary = {
  path: string; host: string; authorization: string; xApiKey: string; leakedHeaders: string[]; oauthBeta: boolean;
};

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** A throwaway HOME whose config dir holds a dummy claude.ai login (never a real one). */
function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't2098-sh8-'));
  roots.push(root);
  const sb = { root, home: path.join(root, 'home'), source: path.join(root, 'home', '.claude'), cwd: path.join(root, 'project') };
  for (const dir of [sb.source, sb.cwd]) fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(sb.source, '.claude.json'), { hasCompletedOnboarding: true });
  writeJson(path.join(sb.source, '.credentials.json'), {
    claudeAiOauth: {
      accessToken: DUMMY_OAUTH,
      refreshToken: DUMMY_REFRESH,
      expiresAt: Date.now() + 8 * 3600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  });
  return sb;
}

/** The isolated per-user spawn env before any engine is applied. */
function memberEnv(sb: Sandbox): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: sb.home,
    CLAUDE_CONFIG_DIR: sb.source,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
}

type Listen = { host: string; port: number };

/**
 * Runs the real CLI against the echo endpoint inside a loopback-only netns. With
 * `listen`, the endpoint sits at the production base URL's literal address and
 * the env's ANTHROPIC_BASE_URL is used unchanged.
 */
function runEcho(sb: Sandbox, env: NodeJS.ProcessEnv, bearer: string, tag: string, listen?: Listen): RequestSummary[] {
  const specPath = path.join(sb.root, `spec-${tag}.json`);
  writeJson(specPath, {
    claudeBin: CLAUDE_BIN, env, cwd: sb.cwd, markers: { engine: bearer, dummies: [DUMMY_OAUTH, DUMMY_REFRESH] },
    ...(listen ? { listen } : {}),
  });
  const result = spawnSync('unshare', [
    '-rn', 'sh', '-c', 'ip link set lo up && exec "$0" "$1" "$2"', process.execPath, HARNESS, specPath,
  ], { encoding: 'utf8', timeout: 90_000 });
  fs.rmSync(specPath, { force: true });
  assert.equal(result.status, 0, `harness failed: ${result.stderr?.slice(0, 300)}`);
  return JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}').requests ?? [];
}

type Resolved = { address: string; family: 4 | 6 };

/** The production local-engine sequence (resolveLocalClaudeRunProfile), no DB. */
async function protectedLocalEnv(
  sb: Sandbox, key: string | null,
  server: typeof SERVER = SERVER, resolved: Resolved = { address: '127.0.0.1', family: 4 },
): Promise<NodeJS.ProcessEnv> {
  return protectedLocalEnvFrom(sb, memberEnv(sb), key, server, resolved);
}

/** Same sequence, starting from a given member env (inherited variables included). */
async function protectedLocalEnvFrom(
  sb: Sandbox, env: NodeJS.ProcessEnv, key: string | null,
  server: typeof SERVER = SERVER, resolved: Resolved = { address: '127.0.0.1', family: 4 },
): Promise<NodeJS.ProcessEnv> {
  const applied = await applyClaudeLocalEngineEnvOrThrow(env, { userId: 7, requestedModel: MODEL, storedPin: null }, {
    enabled: () => true,
    runnable: () => true,
    listServers: () => [{ ...server, verifiedAddresses: [resolved.address] }],
    getSecret: () => key,
    resolvePrivate: async () => resolved,
    cliVersionProven: () => true,
  });
  assert.ok(applied, 'a local model id takes the local path');
  env.CLAUDE_CONFIG_DIR = await prepareEnginePinConfigDir(env, {
    operatorHome: sb.home,
    derivedName: localEngineDerivedDirName(applied.local.serverId),
    stripEnvKeys: LOCAL_ENGINE_ENV_KEYS,
    privateEntries: LOCAL_ENGINE_PRIVATE_ENTRIES,
  });
  await assertClaudeSpawnEnvAllowed(env, {
    engineHosts: applied.engineHosts, engineOrigins: applied.engineOrigins, cwd: sb.cwd,
  });
  return env;
}

function assertLocalBearerOnly(requests: RequestSummary[]): void {
  assert.ok(requests.length > 0, 'the protected CLI reached the echo endpoint');
  for (const request of requests) {
    assert.equal(request.authorization, 'engine', 'only the local bearer');
    assert.equal(request.xApiKey, 'none', 'no x-api-key');
    assert.deepEqual(request.leakedHeaders, [], 'no login value in any header');
    assert.equal(request.oauthBeta, false, 'no OAuth beta flag');
  }
}

test('baseline: without the local profile the CLI sends my claude.ai login to the custom URL', { skip: SKIP }, () => {
  const sb = makeSandbox();
  const requests = runEcho(sb, { ...memberEnv(sb), ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }, 'unused', 'baseline');
  assert.ok(requests.length > 0, 'baseline CLI reached the echo endpoint');
  assert.ok(requests.some((r) => r.authorization === 'dummy'), 'the stored login really reaches the wire');
});

test('a server without a key: only the fixed placeholder bearer, never my login', { skip: SKIP }, async () => {
  const sb = makeSandbox();
  const env = await protectedLocalEnv(sb, null);
  assert.equal(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR as string, '.credentials.json')), false);
  assertLocalBearerOnly(runEcho(sb, env, LOCAL_NO_KEY_PLACEHOLDER, 'no-key'));
});

test('a server with a key: only that key as bearer, never my login', { skip: SKIP }, async () => {
  const sb = makeSandbox();
  const env = await protectedLocalEnv(sb, SERVER_KEY);
  assertLocalBearerOnly(runEcho(sb, env, SERVER_KEY, 'with-key'));
});

// ADR-227 sh3 / T-2098 qa item 1: the registered NAME never reaches the CLI. The
// echo endpoint listens on the vetted literal and the production base URL is used
// as is; the CLI's Host header proves it connected to the literal.
for (const [label, resolved, listen] of [
  ['127.0.0.1', { address: '127.0.0.1', family: 4 }, { host: '127.0.0.1', port: 18091 }],
  ['[::1]', { address: '::1', family: 6 }, { host: '::1', port: 18092 }],
] as Array<[string, Resolved, Listen]>) {
  test(`a server registered by name runs on its vetted literal ${label}, never the name`, { skip: SKIP }, async () => {
    const sb = makeSandbox();
    const server = { ...SERVER, baseUrl: `http://localhost:${listen.port}/v1` };
    const env = await protectedLocalEnv(sb, SERVER_KEY, server, resolved);
    const literal = `${label}:${listen.port}`;
    assert.equal(env.ANTHROPIC_BASE_URL, `http://${literal}`);
    assert.ok(!JSON.stringify(env).includes('localhost'), 'the name is nowhere in the child env');
    const requests = runEcho(sb, env, SERVER_KEY, `literal-${listen.port}`, listen);
    assertLocalBearerOnly(requests);
    for (const request of requests) assert.equal(request.host, literal, 'the CLI connected to the literal');
  });
}

// ── T-2098 qa item 4: every connect and DNS attempt in the sealed namespace ──────
//
// The namespace routes EVERY destination to loopback, so a DNS query or a dial to
// any vendor host becomes a packet on `lo`, where an AF_PACKET recorder
// (netns-connect-recorder.fixture.py) logs it. The only permitted attempt is the
// TCP connect to the echo endpoint (the local server).

const RECORDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'netns-connect-recorder.fixture.py');
const PYTHON = spawnSync('python3', ['-c', 'import socket; socket.AF_PACKET'], { timeout: 10_000 }).status === 0;
const RECORD_SKIP = SKIP || (PYTHON ? false : 'python3 with AF_PACKET unavailable');
type Attempt = { proto: string; dst: string; port: number };
type Recorded = { requests: RequestSummary[]; attempts: Attempt[]; status: number | null };

/** Runs `inner` (argv) inside a namespace that routes everything to lo, with the recorder on. */
function recordInNetns(sb: Sandbox, tag: string, inner: string[]): { attempts: Attempt[]; stdout: string; status: number | null } {
  const out = path.join(sb.root, `attempts-${tag}.json`);
  const ready = path.join(sb.root, `ready-${tag}`);
  const script = [
    'ip link set lo up',
    'ip route add local 0.0.0.0/0 dev lo table local',
    'ip -6 route add local ::/0 dev lo table local',
    'python3 -I "$0" "$1" "$2" & rec=$!',
    'i=0; while [ ! -e "$2" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done',
    'shift 3; "$@"; rc=$?',
    'sleep 0.3; kill -TERM $rec; wait $rec; exit $rc',
  ].join('\n');
  const result = spawnSync('unshare', ['-rn', 'sh', '-c', script, RECORDER, out, ready, 'x', ...inner], {
    encoding: 'utf8', timeout: 120_000,
  });
  const attempts = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, 'utf8')).attempts as Attempt[]) : [];
  assert.ok(fs.existsSync(out), `recorder wrote nothing: ${result.stderr?.slice(0, 300)}`);
  return { attempts, stdout: result.stdout ?? '', status: result.status };
}

/** The echo harness under the recorder; the endpoint listens at `listen`, the env is used as is. */
function runRecorded(sb: Sandbox, env: NodeJS.ProcessEnv, bearer: string, tag: string, listen: Listen,
  extra: { args?: string[]; letCliExit?: boolean } = {}): Recorded {
  const specPath = path.join(sb.root, `spec-${tag}.json`);
  writeJson(specPath, {
    claudeBin: CLAUDE_BIN, env, cwd: sb.cwd, listen, ...extra,
    markers: { engine: bearer, dummies: [DUMMY_OAUTH, DUMMY_REFRESH] },
  });
  const run = recordInNetns(sb, tag, [process.execPath, HARNESS, specPath]);
  assert.equal(run.status, 0, `harness failed in ${tag}`);
  const requests = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}').requests ?? [];
  return { requests, attempts: run.attempts, status: run.status };
}

/** Attempts other than the TCP connect to the echo endpoint. */
function strayAttempts(attempts: Attempt[], listen: Listen): Attempt[] {
  return attempts.filter((a) => !(a.proto === 'tcp' && a.dst === listen.host && a.port === listen.port));
}

test('recorder control: a dial and a DNS query to the outside world are both caught', { skip: RECORD_SKIP }, () => {
  const sb = makeSandbox();
  const probe = "import socket\ns=socket.socket(); s.settimeout(0.5); s.connect_ex(('198.51.100.7', 443))\n"
    + "try:\n  socket.getaddrinfo('api.anthropic.com', 443)\nexcept OSError:\n  pass\n";
  const { attempts } = recordInNetns(sb, 'control', ['python3', '-I', '-c', probe]);
  assert.ok(attempts.some((a) => a.proto === 'tcp' && a.dst === '198.51.100.7' && a.port === 443), 'dial seen');
  assert.ok(attempts.some((a) => a.proto === 'udp' && a.port === 53), 'DNS query seen');
});

const ECHO: Listen = { host: '127.0.0.1', port: 18080 };

for (const [label, key] of [['no key', null], ['a key', SERVER_KEY]] as Array<[string, string | null]>) {
  test(`sealed run with ${label}: nothing but the local server is contacted, no DNS at all`, { skip: RECORD_SKIP }, async () => {
    const sb = makeSandbox();
    const env = await protectedLocalEnv(sb, key);
    const run = runRecorded(sb, env, key ?? LOCAL_NO_KEY_PLACEHOLDER, `sealed-${key ? 'key' : 'nokey'}`, ECHO);
    assertLocalBearerOnly(run.requests);
    assert.deepEqual(strayAttempts(run.attempts, ECHO), [], 'no connect or DNS attempt besides the echo endpoint');
  });
}

test('server answers 401 and the CLI handles it (refresh path): still only the local bearer, no Anthropic contact',
  { skip: RECORD_SKIP }, async () => {
    const sb = makeSandbox();
    const env = await protectedLocalEnv(sb, SERVER_KEY);
    const run = runRecorded(sb, env, SERVER_KEY, 'refresh-401', ECHO, { letCliExit: true });
    assertLocalBearerOnly(run.requests);
    assert.deepEqual(strayAttempts(run.attempts, ECHO), [], 'no token refresh toward Anthropic after a 401');
  });

test('resume of a local chat: the resumed run is sealed the same way', { skip: RECORD_SKIP }, async () => {
  const sb = makeSandbox();
  const env = await protectedLocalEnv(sb, SERVER_KEY);
  const sessionId = crypto.randomUUID();
  runRecorded(sb, env, SERVER_KEY, 'resume-1', ECHO,
    { args: ['-p', 'first', '--max-turns', '1', '--session-id', sessionId], letCliExit: true });
  const resumed = runRecorded(sb, env, SERVER_KEY, 'resume-2', ECHO,
    { args: ['-p', 'second', '--max-turns', '1', '--resume', sessionId], letCliExit: true });
  assertLocalBearerOnly(resumed.requests);
  assert.deepEqual(strayAttempts(resumed.attempts, ECHO), []);
});

for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) {
  test(`an inherited ${key} refuses the local spawn before any CLI starts`, { skip: SKIP }, async () => {
    const sb = makeSandbox();
    const inherited = { ...memberEnv(sb), [key]: key === 'ANTHROPIC_CUSTOM_HEADERS' ? `Authorization: Bearer ${DUMMY_OAUTH}` : DUMMY_OAUTH };
    await assert.rejects(protectedLocalEnvFrom(sb, inherited, SERVER_KEY),
      (error: Error & { code?: string }) => error.code === 'ENGINE_ANTHROPIC_CREDENTIAL_EXPOSED');
  });
}

/** sha256 of every path, link target and file body under `dir`, in sorted order. */
function treeHash(dir: string): string {
  const hash = crypto.createHash('sha256');
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      hash.update(`${path.relative(dir, full)}\0${stat.mode}\0${stat.mtimeMs}\0`);
      if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(full));
      else if (stat.isDirectory()) walk(full);
      else hash.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

test("a sealed local run leaves the member's own plugins/ byte-for-byte unchanged", { skip: RECORD_SKIP }, async () => {
  const sb = makeSandbox();
  const plugins = path.join(sb.source, 'plugins');
  writeJson(path.join(plugins, 'installed_plugins.json'), { version: 2, plugins: { 'demo@market': [{ scope: 'user' }] } });
  writeJson(path.join(plugins, 'known_marketplaces.json'), { market: { source: { source: 'github', repo: 'x/y' } } });
  fs.mkdirSync(path.join(plugins, 'cache', 'market', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(plugins, 'cache', 'market', 'demo', 'plugin.json'), '{"name":"demo"}');
  const before = treeHash(plugins);
  const env = await protectedLocalEnv(sb, SERVER_KEY);
  const run = runRecorded(sb, env, SERVER_KEY, 'plugins', ECHO);
  assertLocalBearerOnly(run.requests);
  assert.deepEqual(strayAttempts(run.attempts, ECHO), []);
  assert.equal(treeHash(plugins), before, 'member plugins/ untouched');
  assert.ok(!fs.lstatSync(path.join(env.CLAUDE_CONFIG_DIR as string, 'plugins')).isSymbolicLink());
});
