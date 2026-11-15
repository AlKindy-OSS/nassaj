/**
 * ADR-227 "Codex and DSH bodies" / T-2107 — header-echo against the REAL Codex CLI
 * (the permanent no-leak proof, like the Claude body's sh8): a Codex chat on my
 * local model server never sends my ChatGPT login or any OpenAI key — not to my
 * server, and not anywhere else.
 *
 * Every credential is a dummy: a ChatGPT login in the member's CODEX_HOME,
 * OPENAI_API_KEY and CODEX_API_KEY in the inherited env. The CLI and the echo
 * endpoint run in a loopback-only network namespace that routes EVERY destination
 * to `lo`, where an AF_PACKET recorder logs each connect and DNS attempt, so
 * nothing can leave the host and any attempt to reach a vendor is seen.
 *
 *   - baseline: the member home with the apps feature on (what stage 3 measured
 *     as a leak to chatgpt.com) makes the CLI try to reach beyond the server;
 *   - protected: the production sequence of codex-local-run.js (env, provider
 *     config, per-server credential-free home with the member's roles, skills and
 *     hooks) and the launch config composed exactly as the spawn composes it
 *     (composeCodexLaunchConfig): every request carries ONLY the server key (or the
 *     fixed placeholder), nothing but the server is contacted, and the member's
 *     PreToolUse hook (the B-95 service gate's slot) fires and blocks a tool call;
 *   - the hook-trust lookup run (codex-hook-trust.js) contacts nothing at all.
 *
 * Skipped when the CLI, an unprivileged network namespace or python3 with
 * AF_PACKET is unavailable, except under NASSAJ_TEST_RELEASE_GATE=1 (the proof
 * run by `node scripts/prove-local-engine.mjs codex`), where a skip fails.
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

import { LOCAL_NO_KEY_PLACEHOLDER } from './apply-claude-local-engine-env.js';
import { applyCodexLocalEngineEnvOrThrow } from './apply-codex-local-engine-env.js';
import { readCodexHookTrust } from './codex-hook-trust.js';
import { prepareCodexLocalHome } from './codex-local-home.js';
import {
  assertRecorderCatches, netnsAvailable, packetRecorderAvailable, recordInNetns, strayAttempts, type Attempt, type Listen,
} from './netns-recorder.fixture-helper.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'codex-local-header-echo.fixture.mjs');
const LOOKUP = path.join(HERE, 'codex-hook-trust-lookup.fixture.mjs');
// Built at runtime so the source carries no token-shaped literal for the export leak scan.
const DUMMY_ACCESS = ['DUMMY', 'T2107', 'CHATGPT', 'ACCESS'].join('-');
const DUMMY_REFRESH = ['DUMMY', 'T2107', 'CHATGPT', 'REFRESH'].join('-');
const DUMMY_OPENAI = ['sk', 'DUMMY', 'T2107', 'OPENAI'].join('-');
const DUMMY_CODEX = ['sk', 'DUMMY', 'T2107', 'CODEX'].join('-');
const DUMMIES = [DUMMY_ACCESS, DUMMY_REFRESH, DUMMY_OPENAI, DUMMY_CODEX, 'acct-DUMMY-T2107'];
const SERVER_KEY = 'LOCAL-SERVER-KEY-T2107';
const ECHO = { host: '127.0.0.1', port: 18190 };

const SERVER = {
  id: '5d0b8a51-2c3e-4f6a-9b7c-1e2d3f4a5b6c',
  ownerId: 7,
  providerId: 'nassaj_local_5d0b8a512c3e4f6a9b7c1e2d3f4a5b6c',
  baseUrl: `http://${ECHO.host}:${ECHO.port}/v1`,
  models: [{ id: 'local-test-model', contextWindow: 32768 }],
};
const MODEL = `${SERVER.providerId}/local-test-model`;

/** The `codex` binary under test: NASSAJ_TEST_CODEX_BIN, else the first on PATH, or null. */
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

test('release gate: the Codex header-echo proof actually ran', { skip: process.env.NASSAJ_TEST_RELEASE_GATE !== '1' }, () => {
  assert.equal(SKIP, false, `release gate: header-echo would be skipped (${SKIP})`);
});

type Sandbox = { root: string; home: string; codexHome: string; cwd: string };
type Request = { path: string; host: string; authorization: string; leakedHeaders: string[]; bodyHasDummy: boolean };

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

/** base64url JSON segment of a dummy (unsigned) JWT. */
const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A throwaway member home whose CODEX_HOME holds a dummy ChatGPT login. */
function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't2107-echo-'));
  roots.push(root);
  const sb = { root, home: path.join(root, 'home'), codexHome: path.join(root, 'home', '.codex'), cwd: path.join(root, 'project') };
  for (const dir of [sb.codexHome, sb.cwd]) fs.mkdirSync(dir, { recursive: true });
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-DUMMY-T2107', chatgpt_plan_type: 'plus' } };
  const idToken = [segment({ alg: 'none' }), segment({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 }), 'sig'].join('.');
  fs.writeFileSync(path.join(sb.codexHome, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken, access_token: DUMMY_ACCESS, refresh_token: DUMMY_REFRESH, account_id: 'acct-DUMMY-T2107' },
    last_refresh: new Date().toISOString(),
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(sb.codexHome, 'AGENTS.md'), '# governance\n');
  // The member tree the spawn links: a role, a skill and the PreToolUse hook slot
  // the B-95 service gate uses (here a marker that blocks every shell call).
  fs.mkdirSync(path.join(sb.codexHome, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(sb.codexHome, 'agents', 'researcher.toml'), 'name = "researcher"\ndescription = "r"\n'
    + 'developer_instructions = "Research only."\n');
  fs.mkdirSync(path.join(sb.codexHome, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(sb.codexHome, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nDemo.\n');
  const hook = `touch ${JSON.stringify(path.join(root, 'hook-fired'))}; echo blocked-by-gate >&2; exit 2 # nassaj-service-gate`;
  fs.writeFileSync(path.join(sb.codexHome, 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hook, timeout: 10 }] }] },
  }));
  return sb;
}

/** The isolated member spawn env before any engine is applied (dummy keys inherited). */
function memberEnv(sb: Sandbox): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: sb.home, TMPDIR: sb.root, CODEX_HOME: sb.codexHome,
    OPENAI_API_KEY: DUMMY_OPENAI, CODEX_API_KEY: DUMMY_CODEX,
  };
}

type Resolved = { address: string; family: 4 | 6 };

/** The production local sequence (codex-local-run.js), no DB. */
async function protectedLaunch(sb: Sandbox, key: string | null, server = SERVER, resolved: Resolved = { address: ECHO.host, family: 4 }) {
  const env = memberEnv(sb);
  const applied = await applyCodexLocalEngineEnvOrThrow(env, { userId: 7, requestedModel: MODEL, storedPin: null, cliVersion: '0.0.0' }, {
    enabled: () => true,
    runnable: () => true,
    listServers: () => [{ ...server, verifiedAddresses: [resolved.address] }],
    getSecret: () => key,
    resolvePrivate: async () => resolved,
    isVersionProven: () => true,
  });
  assert.ok(applied, 'a local model id takes the local path');
  env.CODEX_HOME = await prepareCodexLocalHome(env.CODEX_HOME as string, applied.local.serverId, {
    hookTrust: (codexHome: string) => readCodexHookTrust({ codexBin: CODEX_BIN as string, codexHome, cwd: sb.cwd }),
  });
  // T-2107 qa high 4: the exact object the spawn chokepoint composes (helpers on).
  const config = composeCodexLaunchConfig({
    multiAgentConfig: codexMultiAgentConfig(null, true),
    developerInstructions: codexTurnDeveloperInstructions('delegate', { helpers: true, reason: null, cpu: null }, () => 'Nassaj runtime.'),
    sandboxMode: 'read-only',
    docsWritableRoots: [],
    localConfig: applied.config,
  });
  return { env, config, model: applied.local.model };
}

/** Runs the harness under the connect/DNS recorder inside a namespace that routes everything to lo. */
function runRecorded(sb: Sandbox, tag: string, launch: { env: NodeJS.ProcessEnv; config: object; model: string },
  listen: Listen = ECHO, extra: { resumeId?: string; respond?: 'tool-call' } = {}) {
  const specPath = path.join(sb.root, `spec-${tag}.json`);
  fs.writeFileSync(specPath, JSON.stringify({
    codexBin: CODEX_BIN, ...launch, ...extra, cwd: sb.cwd, listen,
    markers: { engine: launch.env.NASSAJ_LOCAL_API_KEY, dummies: DUMMIES },
  }), { mode: 0o600 });
  const run = recordInNetns(sb.root, tag, [process.execPath, HARNESS, specPath]);
  fs.rmSync(specPath, { force: true });
  assert.equal(run.status, 0, `harness failed in ${tag}`);
  const parsed = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
  return { requests: (parsed.requests ?? []) as Request[], attempts: run.attempts, threadId: (parsed.threadId ?? null) as string | null };
}

function assertLocalKeyOnly(run: { requests: Request[]; attempts: Attempt[] }, listen: Listen = ECHO): void {
  const responses = run.requests.filter((request) => request.path.startsWith('/v1/responses'));
  assert.ok(responses.length > 0, 'the protected CLI reached my server');
  for (const request of run.requests) {
    assert.equal(request.authorization, 'engine', `only the local key on ${request.path}`);
    assert.deepEqual(request.leakedHeaders, [], 'no dummy credential in any header');
    assert.equal(request.bodyHasDummy, false, 'no dummy credential in any body');
  }
  assert.deepEqual(strayAttempts(run.attempts, listen), [], 'nothing but my server was contacted, no DNS');
}

test('recorder control: a dial and a DNS query to the outside world are both caught', { skip: SKIP }, () => {
  assertRecorderCatches(makeSandbox().root, 'chatgpt.com');
});

test('baseline: on my member home with apps on, the CLI tries to reach beyond my server', { skip: SKIP }, () => {
  const sb = makeSandbox();
  const env = { ...memberEnv(sb), NASSAJ_LOCAL_API_KEY: SERVER_KEY };
  const config = {
    model_provider: 'nassaj_local', 'model_providers.nassaj_local.name': 'x',
    'model_providers.nassaj_local.base_url': SERVER.baseUrl, 'model_providers.nassaj_local.env_key': 'NASSAJ_LOCAL_API_KEY',
    'model_providers.nassaj_local.wire_api': 'responses',
  };
  const run = runRecorded(sb, 'baseline', { env, config, model: 'local-test-model' });
  assert.ok(strayAttempts(run.attempts, ECHO).length > 0, 'the unprotected run attempts another destination');
});

for (const [label, key] of [['no key', null], ['a key', SERVER_KEY]] as Array<[string, string | null]>) {
  test(`a server with ${label}: only ${key ? 'its key' : 'the placeholder'}, never my login or keys, nothing else contacted`,
    { skip: SKIP }, async () => {
      const sb = makeSandbox();
      const launch = await protectedLaunch(sb, key);
      assert.equal(launch.env.NASSAJ_LOCAL_API_KEY, key ?? LOCAL_NO_KEY_PLACEHOLDER);
      assert.equal(fs.existsSync(path.join(launch.env.CODEX_HOME as string, 'auth.json')), false);
      assertLocalKeyOnly(runRecorded(sb, key ? 'key' : 'nokey', launch));
    });
}

test('a server registered by name runs on its vetted literal, never the name', { skip: SKIP }, async () => {
  const sb = makeSandbox();
  const listen = { host: '127.0.0.1', port: 18191 };
  const launch = await protectedLaunch(sb, SERVER_KEY, { ...SERVER, baseUrl: `http://localhost:${listen.port}/v1` });
  assert.ok(!JSON.stringify(launch).includes('localhost'), 'the name is nowhere in the launch');
  const run = runRecorded(sb, 'literal', launch, listen);
  assertLocalKeyOnly(run, listen);
  for (const request of run.requests) assert.equal(request.host, `127.0.0.1:${listen.port}`);
});

test('resume of a local chat: the resumed run is sealed the same way', { skip: SKIP }, async () => {
  const sb = makeSandbox();
  const launch = await protectedLaunch(sb, SERVER_KEY);
  const first = runRecorded(sb, 'resume-1', launch);
  assert.ok(first.threadId, 'the first run started a thread');
  assertLocalKeyOnly(runRecorded(sb, 'resume-2', launch, ECHO, { resumeId: first.threadId as string }));
});

test('qa critical 2: my PreToolUse hook (the service gate slot) fires in a local run and blocks the call', { skip: SKIP }, async () => {
  const sb = makeSandbox();
  const launch = await protectedLaunch(sb, SERVER_KEY);
  const run = runRecorded(sb, 'hook', launch, ECHO, { respond: 'tool-call' });
  assertLocalKeyOnly(run);
  assert.ok(run.requests.filter((r) => r.path.startsWith('/v1/responses')).length >= 2, 'the tool call came back to my server');
  assert.ok(fs.existsSync(path.join(sb.root, 'hook-fired')), 'the hook ran');
  assert.equal(fs.existsSync(path.join(sb.cwd, 'ran.txt')), false, 'the hook blocked the shell call');
});

test('T-2107 qa backlog: the hook-trust lookup run on the local home contacts nothing', { skip: SKIP }, async () => {
  const sb = makeSandbox();
  let attempts: Attempt[] | null = null;
  await prepareCodexLocalHome(sb.codexHome, SERVER.id, {
    hookTrust: async (codexHome: string) => {
      const run = recordInNetns(sb.root, 'lookup', [process.execPath, '--import', 'tsx', LOOKUP, JSON.stringify({
        codexBin: CODEX_BIN, codexHome, cwd: sb.cwd, mode: 'read',
      })]);
      assert.equal(run.status, 0, 'the lookup run succeeded');
      attempts = run.attempts;
      return JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}').entries;
    },
  });
  assert.ok(attempts, 'the lookup ran under the recorder');
  assert.deepEqual(attempts, [], 'zero connect or DNS attempts from the lookup run');
});
