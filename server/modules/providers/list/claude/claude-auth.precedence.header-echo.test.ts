/**
 * ADR-200 S4 / G1 M-1 — Claude credential precedence, MEASURED against the real
 * CLI with a header echo. Every credential is a dummy; the CLI and the echo
 * endpoint run inside a loopback-only network namespace (`unshare -rn`), so no
 * request can leave the host. Reuses the S2 echo fixture.
 *
 * The OAuth dummy is the fixture's `engine` marker, so `authorization: engine`
 * means "the OAuth bearer was sent"; an API-key dummy in `x-api-key` means the
 * key won; an AUTH_TOKEN dummy in `authorization` means the auth token won.
 *
 * Each row is then checked against BOTH readers of the precedence — the link
 * mode inventory and the auth status provider — so they cannot drift from the
 * wire. Skipped when the CLI or an unprivileged netns is unavailable.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readClaudeInventoryFromEnv } from '@/modules/providers/services/harness-credential-inventory.js';

import { ClaudeProviderAuth } from './claude-auth.provider.js';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../../services/isolation/engine-pin-header-echo.fixture.mjs');
const OAUTH = 'sk' + '-ant-oat01-DUMMY-M1-OAUTH';
const API_KEY = 'sk' + '-ant-api03-DUMMY-M1-APIKEY';
const AUTH_TOKEN = 'DUMMY-M1-AUTHTOKEN';

function findClaude(): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'claude');
    if (dir && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}
const netnsAvailable = () => spawnSync('unshare', ['-rn', 'sh', '-c', 'ip link set lo up'], { timeout: 10_000 }).status === 0;
const CLAUDE_BIN = findClaude();
const SKIP = !CLAUDE_BIN ? 'claude CLI not installed' : (!netnsAvailable() ? 'unshare -rn unavailable' : false);

type Winner = 'api_key' | 'auth_token' | 'oauth';
type Row = {
  name: string;
  env?: Record<string, string>;
  settingsEnv?: Record<string, string>;
  expect: Winner;
};

/** Every row the precedence rule decides: any key or auth token beats any OAuth. */
const ROWS: Row[] = [
  { name: 'env OAuth only', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH }, expect: 'oauth' },
  { name: 'settings OAuth only', settingsEnv: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH }, expect: 'oauth' },
  {
    name: 'env OAuth + settings API key', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH },
    settingsEnv: { ANTHROPIC_API_KEY: API_KEY }, expect: 'api_key',
  },
  {
    name: 'settings OAuth + settings API key',
    settingsEnv: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: API_KEY }, expect: 'api_key',
  },
  {
    name: 'env OAuth + settings AUTH_TOKEN', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH },
    settingsEnv: { ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN }, expect: 'auth_token',
  },
  {
    name: 'env OAuth + env API key', env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: API_KEY },
    expect: 'api_key',
  },
];

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

type Sandbox = { root: string; home: string; configDir: string; cwd: string };

function makeSandbox(row: Row): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-echo-'));
  roots.push(root);
  const sb = { root, home: path.join(root, 'home'), configDir: path.join(root, 'home', '.claude'), cwd: path.join(root, 'project') };
  fs.mkdirSync(sb.cwd, { recursive: true });
  writeJson(path.join(sb.configDir, '.claude.json'), { hasCompletedOnboarding: true });
  if (row.settingsEnv) writeJson(path.join(sb.configDir, 'settings.json'), { env: row.settingsEnv });
  return sb;
}

/** The winner the wire shows, from one echoed request. */
function wireWinner(sb: Sandbox, row: Row): Winner | 'none' {
  const env = {
    PATH: process.env.PATH, HOME: sb.home, CLAUDE_CONFIG_DIR: sb.configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', ...row.env,
  };
  const specPath = path.join(sb.root, 'spec.json');
  writeJson(specPath, { claudeBin: CLAUDE_BIN, env, cwd: sb.cwd, markers: { engine: OAUTH, dummies: [API_KEY, AUTH_TOKEN] } });
  const result = spawnSync('unshare', [
    '-rn', 'sh', '-c', 'ip link set lo up && exec "$0" "$1" "$2"', process.execPath, HARNESS, specPath,
  ], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, `harness failed: ${result.stderr?.slice(0, 300)}`);
  const requests = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}').requests ?? [];
  assert.ok(requests.length > 0, 'the CLI reached the echo endpoint');
  const first = requests[0] as { authorization: string; xApiKey: string };
  if (first.xApiKey === 'dummy') return 'api_key';
  if (first.authorization === 'dummy') return 'auth_token';
  return first.authorization === 'engine' ? 'oauth' : 'none';
}

/** What both nassaj readers say runs for the row's spawn env and files. */
async function nassajVerdicts(sb: Sandbox, row: Row): Promise<{ inventory: string; status: string }> {
  const env = { CLAUDE_CONFIG_DIR: sb.configDir, ...row.env };
  const inventory = readClaudeInventoryFromEnv(env).effective;
  const status = await (new ClaudeProviderAuth() as unknown as {
    checkCredentials(env: NodeJS.ProcessEnv): Promise<{ method: string | null }>;
  }).checkCredentials(env);
  return { inventory, status: status.method === 'oauth_token' ? 'subscription' : 'api_key' };
}

for (const row of ROWS) {
  test(`Claude precedence on the wire: ${row.name} → ${row.expect}`, { skip: SKIP }, async () => {
    const sb = makeSandbox(row);
    assert.equal(wireWinner(sb, row), row.expect, 'measured wire winner');
    const verdicts = await nassajVerdicts(sb, row);
    const expectedMode = row.expect === 'oauth' ? 'subscription' : 'api_key';
    assert.equal(verdicts.status, expectedMode, 'auth provider agrees with the wire');
    assert.equal(verdicts.inventory, expectedMode, 'link-mode inventory agrees with the wire');
  });
}
