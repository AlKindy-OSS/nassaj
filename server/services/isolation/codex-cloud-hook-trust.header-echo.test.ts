/**
 * B-1790 — the B-95 service gate in a normal (cloud) Codex chat, against the REAL
 * Codex CLI in a sealed loopback-only network namespace.
 *
 * Measured on codex-cli 0.166.0: a hook in `$CODEX_HOME/hooks.json` runs only when
 * the home's config.toml trusts it; the member homes sync-harness-homes fills carry
 * the gate's hooks.json but no trust, so the gate never ran in a cloud chat. Before
 * a cloud spawn, nassaj now writes trust for exactly its own tagged hooks into the
 * member's config.toml (ensureCodexHomeHookTrust), leaving every other byte alone.
 *
 * The chat is cloud-shaped: the member's CODEX_HOME (a config.toml like a real
 * member's, nassaj-core's dist hooks.json with both guards, no auth.json) and the launch config the spawn
 * composes for a cloud chat (no local engine); only the model endpoint is
 * redirected to a loopback echo server, which answers with a shell call. The shell
 * call shadows `pm2` with a function, so it is harmless when nothing blocks it.
 *
 * Skipped when the CLI, an unprivileged network namespace or python3 with
 * AF_PACKET is unavailable, except under NASSAJ_TEST_RELEASE_GATE=1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  codexMultiAgentConfig, codexTurnDeveloperInstructions, composeCodexLaunchConfig,
} from '../../modules/providers/index.js';

import { ensureCodexHomeHookTrust } from './codex-hook-trust.js';
import {
  netnsAvailable, packetRecorderAvailable, recordInNetns, strayAttempts,
} from './netns-recorder.fixture-helper.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'codex-local-header-echo.fixture.mjs');
const LOOKUP = path.join(HERE, 'codex-hook-trust-lookup.fixture.mjs');
const ECHO = { host: '127.0.0.1', port: 18192 };
const KEY = 'CLOUD-SHAPED-ECHO-KEY-B1790';
// The real gate engine when this host has it (the account home, not the isolated
// test HOME); otherwise the gate test is skipped.
const GATE = process.env.NASSAJ_TEST_SERVICE_GATE
  ?? path.join(os.userInfo().homedir, 'nassaj-core', 'hooks', 'service-gate.js');
// A forbidden self-restart the execpolicy rules do not catch (measured: a
// `bash -c` wrapper), so only the hook can stop it; `pm2` is a local function.
const RESTART = "bash -c 'pm2() { touch ran.txt; }; pm2 restart nassaj-dev'";

function findCodex(): string | null {
  const pinned = process.env.NASSAJ_TEST_CODEX_BIN;
  if (pinned) return fs.existsSync(pinned) ? fs.realpathSync(pinned) : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'codex');
    if (dir && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}

const CODEX_BIN = findCodex();
const SKIP = !CODEX_BIN ? 'codex CLI not installed'
  : !netnsAvailable() ? 'unshare -rn unavailable' : !packetRecorderAvailable() ? 'python3 with AF_PACKET unavailable' : false;
const GATE_SKIP = SKIP || (fs.existsSync(GATE) ? false : 'service-gate engine not on this host');

test('release gate: the cloud hook-trust proof actually ran', { skip: process.env.NASSAJ_TEST_RELEASE_GATE !== '1' }, () => {
  assert.equal(GATE_SKIP, false, `release gate: cloud hook-trust proof would be skipped (${GATE_SKIP})`);
});

type Sandbox = { root: string; home: string; codexHome: string; cwd: string };

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

// A member config.toml as nassaj and the member leave it: settings, trusted
// projects, a connector, and no hook trust.
const MEMBER_CONFIG = [
  'personality = "pragmatic"',
  '',
  '[projects."/srv/member/project"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.member-docs]',
  'url = "http://127.0.0.1:9/mcp"',
  'enabled = false',
  '',
].join('\n');

// nassaj-core's dist/codex/hooks.json (the service gate and the live-root guard),
// read verbatim when this host has it; otherwise this copy of it.
const DIST_HOOKS = path.join(path.dirname(path.dirname(GATE)), 'dist', 'codex', 'hooks.json');
const wrapper = (engine: string, tag: string) => `f=@NASSAJ_CORE@/hooks/${engine}.js; n=/usr/bin/node; [ -r "$f" ] && [ -x "$n" ] || `
  + `{ echo "${engine}: engine $f or $n missing; shell call blocked fail-closed" >&2; exit 2; }; exec "$n" "$f" --harness codex # ${tag}`;
const DIST_TEXT = fs.existsSync(DIST_HOOKS) ? fs.readFileSync(DIST_HOOKS, 'utf8') : JSON.stringify({ hooks: { PreToolUse: [
  { matcher: 'Bash', hooks: [{ type: 'command', command: wrapper('service-gate', 'nassaj-service-gate'), timeout: 10 }] },
  { matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: wrapper('live-root-guard', 'nassaj-service-gate:live-root'), timeout: 10 }] },
] } });

/**
 * A throwaway member home: hooks.json is the dist file rendered for a throwaway
 * nassaj-core whose two engines mark that they ran, then hand the call to the real
 * engines of this host (fail-closed when absent, as the real wrapper is).
 */
function makeMemberHome(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b1790-cloud-'));
  roots.push(root);
  const sb = { root, home: path.join(root, 'home'), codexHome: path.join(root, 'home', '.codex'), cwd: path.join(root, 'project') };
  const core = path.join(root, 'core');
  for (const dir of [sb.codexHome, sb.cwd, path.join(core, 'hooks')]) fs.mkdirSync(dir, { recursive: true });
  for (const engine of ['service-gate', 'live-root-guard']) {
    const real = path.join(path.dirname(GATE), `${engine}.js`);
    fs.writeFileSync(path.join(core, 'hooks', `${engine}.js`), [
      "const fs = require('fs'); const { spawnSync } = require('child_process');",
      `fs.writeFileSync(${JSON.stringify(path.join(root, `${engine}-fired`))}, '');`,
      `if (!fs.existsSync(${JSON.stringify(real)})) process.exit(2);`,
      `const r = spawnSync('/usr/bin/node', [${JSON.stringify(real)}, ...process.argv.slice(2)], { input: fs.readFileSync(0) });`,
      'process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 2);',
    ].join('\n'));
  }
  fs.writeFileSync(path.join(sb.codexHome, 'config.toml'), MEMBER_CONFIG, { mode: 0o600 });
  fs.writeFileSync(path.join(sb.codexHome, 'hooks.json'), DIST_TEXT.replaceAll('@NASSAJ_CORE@', core));
  return sb;
}

/** The cloud launch config the spawn composes, with only the endpoint redirected to the echo server. */
function cloudLaunch(sb: Sandbox) {
  const config = {
    ...composeCodexLaunchConfig({
      multiAgentConfig: codexMultiAgentConfig(null, true),
      developerInstructions: codexTurnDeveloperInstructions('delegate', { helpers: true, reason: null, cpu: null }, () => 'Nassaj runtime.'),
      sandboxMode: 'workspace-write',
      docsWritableRoots: [],
      localConfig: null,
    }),
    model_provider: 'echo',
    'model_providers.echo.name': 'echo',
    'model_providers.echo.base_url': `http://${ECHO.host}:${ECHO.port}/v1`,
    'model_providers.echo.env_key': 'ECHO_KEY',
    'model_providers.echo.wire_api': 'responses',
  };
  const env = { PATH: process.env.PATH, HOME: sb.home, TMPDIR: sb.root, CODEX_HOME: sb.codexHome, ECHO_KEY: KEY };
  return { env, config, model: 'gpt-5' };
}

/** One chat turn whose model answer is `command`, recorded in the sealed namespace. */
function chat(sb: Sandbox, tag: string, command: string) {
  const specPath = path.join(sb.root, `spec-${tag}.json`);
  fs.writeFileSync(specPath, JSON.stringify({
    codexBin: CODEX_BIN, ...cloudLaunch(sb), cwd: sb.cwd, listen: ECHO, respond: 'tool-call', command,
    sandboxMode: 'workspace-write', markers: { engine: KEY, dummies: ['NO-DUMMY-B1790'] },
  }), { mode: 0o600 });
  const run = recordInNetns(sb.root, tag, [process.execPath, HARNESS, specPath]);
  assert.equal(run.status, 0, `harness failed in ${tag}`);
  const requests = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}').requests ?? [];
  assert.ok(requests.filter((r: { path: string }) => r.path.startsWith('/v1/responses')).length >= 2, 'the shell call came back');
  return {
    gate: fs.existsSync(path.join(sb.root, 'service-gate-fired')),
    liveRoot: fs.existsSync(path.join(sb.root, 'live-root-guard-fired')),
    ran: fs.existsSync(path.join(sb.cwd, 'ran.txt')),
  };
}

/** Trust for the member home, looked up by the real CLI inside the sealed namespace. */
function trustInNetns(sb: Sandbox, tag: string) {
  const run = recordInNetns(sb.root, tag, [process.execPath, '--import', 'tsx', LOOKUP, JSON.stringify({
    codexBin: CODEX_BIN, codexHome: sb.codexHome, cwd: sb.cwd, mode: 'ensure',
  })]);
  assert.equal(run.status, 0, `trust lookup failed in ${tag}`);
  return run;
}

test('control: in a member home without trust the gate never runs and the call goes through', { skip: GATE_SKIP }, () => {
  const sb = makeMemberHome();
  const result = chat(sb, 'untrusted', RESTART);
  assert.deepEqual(result, { gate: false, liveRoot: false, ran: true }, 'B-1790: the untrusted guards are skipped silently');
});

test('B-1790: in a normal Codex chat, the service guard blocks a forbidden server-restart command', { skip: GATE_SKIP }, () => {
  const sb = makeMemberHome();
  const lookup = trustInNetns(sb, 'lookup');
  assert.deepEqual(strayAttempts(lookup.attempts, ECHO), [], 'the trust lookup contacts nothing');
  const config = fs.readFileSync(path.join(sb.codexHome, 'config.toml'), 'utf8');
  assert.ok(config.startsWith(MEMBER_CONFIG), 'the member config is kept byte for byte');
  const result = chat(sb, 'trusted', RESTART);
  assert.deepEqual(result, { gate: true, liveRoot: true, ran: false }, 'both guards ran; the gate blocked the restart');
});

test('the trust lookup of a member home with a login contacts nothing', { skip: SKIP }, async () => {
  const sb = makeMemberHome();
  fs.writeFileSync(path.join(sb.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-DUMMY-B1790-LOOKUP' }), { mode: 0o600 });
  const lookup = trustInNetns(sb, 'lookup-login');
  assert.deepEqual(strayAttempts(lookup.attempts, ECHO), [], 'no attempt from the lookup run');
  // Already trusted: a second launch neither runs the CLI nor rewrites the file.
  const before = fs.statSync(path.join(sb.codexHome, 'config.toml')).mtimeMs;
  await ensureCodexHomeHookTrust({
    codexBin: CODEX_BIN as string, codexHome: sb.codexHome, cwd: sb.cwd,
    spawnImpl: () => { throw new Error('no CLI run expected'); },
  });
  assert.equal(fs.statSync(path.join(sb.codexHome, 'config.toml')).mtimeMs, before);
});
