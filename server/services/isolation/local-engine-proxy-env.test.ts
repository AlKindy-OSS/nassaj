/**
 * ADR-227 / T-2098 qa item 5 — a local-engine run must not be redirected by a
 * proxy or a Node loader: the spawn env drops every proxy/loader/TLS knob, and a
 * settings `env` block that sets one refuses the spawn.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { LOCAL_ENGINE_ENV_KEYS, applyClaudeLocalEngineEnv } from './apply-claude-local-engine-env.js';
import { assertClaudeSpawnEnvAllowed } from './claude-spawn-env-guard.js';
import { ENGINE_ANTHROPIC_CREDENTIAL_CODE } from './engine-anthropic-credential-guard.js';
import { localEngineDerivedDirName, prepareEnginePinConfigDir } from './engine-pin-config-dir.js';

const ROUTE_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED',
];

const SERVER = {
  id: '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11',
  ownerId: 7,
  providerId: 'nassaj_local_0b9c6a3e6f1e4c419a4e2f1b9e0c7d11',
  baseUrl: 'http://192.168.8.137:8080/v1',
  verifiedAddresses: ['192.168.8.137'],
  models: [{ id: 'gpt-oss-20b', contextWindow: 32768 }],
};
const deps = {
  enabled: () => true,
  runnable: () => true,
  listServers: () => [SERVER],
  getSecret: () => null,
  resolvePrivate: async () => ({ address: '192.168.8.137', family: 4 }),
  cliVersionProven: () => true,
};

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't2098-proxy-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('the local-engine env drops every proxy, loader and TLS override', async () => {
  const env: NodeJS.ProcessEnv = Object.fromEntries(ROUTE_KEYS.map((key) => [key, 'http://10.9.9.9:3128']));
  const verdict = await applyClaudeLocalEngineEnv(env, { userId: 7, requestedModel: `${SERVER.providerId}/gpt-oss-20b` }, deps);
  assert.equal(verdict.status, 'applied');
  for (const key of ROUTE_KEYS) assert.equal(env[key], undefined, key);
});

test('a settings env block carrying a proxy or loader refuses a local-engine spawn', async (t) => {
  const origins = new Set(['http://192.168.8.137:8080']);
  for (const key of ROUTE_KEYS) {
    await t.test(key, async () => {
      const home = path.join(root, key, 'home');
      const cwd = path.join(root, key, 'project');
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { [key]: 'x' } }));
      const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_BASE_URL: 'http://192.168.8.137:8080',
        ANTHROPIC_AUTH_TOKEN: 'nassaj-local-no-key' };
      await assert.rejects(
        assertClaudeSpawnEnvAllowed(env, { engineOrigins: origins, cwd, managedSettingsDir: path.join(root, 'none') }),
        (error: Error & { code?: string; findings?: Array<{ key: string }> }) => error.code === ENGINE_ANTHROPIC_CREDENTIAL_CODE
          && Boolean(error.findings?.some((finding) => finding.key === `env.${key}`)),
      );
    });
  }
});

test('a vendor-engine spawn keeps honouring a proxy in settings (scope: local engine only)', async () => {
  const home = path.join(root, 'v', 'home');
  const cwd = path.join(root, 'v', 'project');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { HTTPS_PROXY: 'x' } }));
  await assertClaudeSpawnEnvAllowed(
    { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'vendor' },
    { engineHosts: new Set(['api.moonshot.ai']), cwd, managedSettingsDir: path.join(root, 'none') },
  );
});

test("the member's own user settings lose their route overrides in the derived dir instead of refusing", async () => {
  const home = path.join(root, 'u', 'home');
  const source = path.join(home, '.claude');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ env: { NODE_OPTIONS: '--require x', DISABLE_TELEMETRY: '1' } }));
  const dir = await prepareEnginePinConfigDir({ HOME: home, CLAUDE_CONFIG_DIR: source }, {
    operatorHome: home, derivedName: localEngineDerivedDirName(SERVER.id), stripEnvKeys: LOCAL_ENGINE_ENV_KEYS,
  });
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.env.NODE_OPTIONS, undefined);
  assert.equal(settings.env.DISABLE_TELEMETRY, '1');
});
