/**
 * B-1541 — an engine-pinned Claude spawn must refuse while any source the CLI
 * loads holds an Anthropic credential (it would be sent to the vendor as
 * x-api-key). Fixtures mirror the real file shapes the CLI reads.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { assertClaudeSpawnEnvAllowed } from './claude-spawn-env-guard.js';
import {
  ENGINE_ANTHROPIC_CREDENTIAL_CODE,
  assertNoAnthropicCredentialForEngine,
  assertNoSettingsOverrideArgv,
  isEngineRoutedEnv,
} from './engine-anthropic-credential-guard.js';

const KIMI_URL = 'https://api.moonshot.ai/anthropic';
const ENGINE_HOSTS = new Set(['api.moonshot.ai']);
const FAKE_KEY = 'sk-' + 'ant-api03-FIXTURE-NOT-A-REAL-KEY';

type Fixture = { root: string; configDir: string; cwd: string; managedDir: string };
let fx: Fixture;

/** A user settings.json shaped like the ones nassaj provisions. */
function userSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: { allow: ['Read(/etc/**)', 'Bash(git status:*)'], deny: [] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node hook.js' }] }] },
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', DISABLE_TELEMETRY: '1' },
    model: 'opus',
    ...extra,
  };
}

/** A global config (.claude.json) shaped like the CLI's own. */
function globalConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numStartups: 42,
    installMethod: 'native',
    autoUpdates: false,
    hasCompletedOnboarding: true,
    projects: { '/home/user/project': { allowedTools: [], hasTrustDialogAccepted: true } },
    ...extra,
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function engineEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin',
    HOME: path.join(fx.root, 'home'),
    CLAUDE_CONFIG_DIR: fx.configDir,
    ANTHROPIC_BASE_URL: KIMI_URL,
    ANTHROPIC_AUTH_TOKEN: 'vendor-engine-token-fixture',
    API_TIMEOUT_MS: '3000000',
    ...extra,
  };
}

async function runGuard(env: NodeJS.ProcessEnv, engineHosts: Set<string> | null = ENGINE_HOSTS): Promise<void> {
  await assertClaudeSpawnEnvAllowed(env, { engineHosts, cwd: fx.cwd, managedSettingsDir: fx.managedDir });
}

async function assertRefused(env: NodeJS.ProcessEnv, expectedKey: string): Promise<void> {
  await assert.rejects(runGuard(env), (error: Error & { code?: string; findings?: Array<{ key: string }> }) => {
    assert.equal(error.code, ENGINE_ANTHROPIC_CREDENTIAL_CODE);
    assert.ok(error.findings?.some((f) => f.key === expectedKey), `expected finding ${expectedKey}`);
    assert.ok(!error.message.includes(FAKE_KEY), 'the refusal must never echo a credential value');
    assert.match(error.message, /An Anthropic key is stored where this engine would receive it/);
    assert.match(error.message, /مفتاح Anthropic/);
    return true;
  });
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'b1541-'));
  fx = {
    root,
    configDir: path.join(root, 'config'),
    cwd: path.join(root, 'project'),
    managedDir: path.join(root, 'etc-claude-code'),
  };
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  fs.mkdirSync(fx.cwd, { recursive: true });
  writeJson(path.join(fx.configDir, 'settings.json'), userSettings());
  writeJson(path.join(fx.configDir, '.claude.json'), globalConfig());
  writeJson(path.join(fx.managedDir, 'managed-settings.json'), {
    cleanupPeriodDays: 30,
    permissions: { deny: ['Bash(rm -rf /:*)'] },
  });
  writeJson(path.join(fx.cwd, '.claude', 'settings.json'), { permissions: { allow: ['Edit(src/**)'] } });
});

afterEach(() => {
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('clean engine-pinned config is allowed', async () => {
  await runGuard(engineEnv());
});

test('channel 1: user settings env.ANTHROPIC_API_KEY is refused', async () => {
  writeJson(path.join(fx.configDir, 'settings.json'),
    userSettings({ env: { DISABLE_TELEMETRY: '1', ANTHROPIC_API_KEY: FAKE_KEY } }));
  await assertRefused(engineEnv(), 'env.ANTHROPIC_API_KEY');
});

test('channel 2: <cwd>/.claude/settings.json env.ANTHROPIC_API_KEY is refused', async () => {
  writeJson(path.join(fx.cwd, '.claude', 'settings.json'),
    { permissions: { allow: [] }, env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  await assertRefused(engineEnv(), 'env.ANTHROPIC_API_KEY');
});

test('channel 3: <cwd>/.claude/settings.local.json env.ANTHROPIC_API_KEY is refused', async () => {
  writeJson(path.join(fx.cwd, '.claude', 'settings.local.json'), { env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  await assertRefused(engineEnv(), 'env.ANTHROPIC_API_KEY');
});

test('channel 4: apiKeyHelper is refused in every settings source', async (t) => {
  const sources = [
    () => path.join(fx.configDir, 'settings.json'),
    () => path.join(fx.cwd, '.claude', 'settings.json'),
    () => path.join(fx.cwd, '.claude', 'settings.local.json'),
    () => path.join(fx.managedDir, 'managed-settings.json'),
  ];
  for (const [i, source] of sources.entries()) {
    await t.test(`source ${i}`, async () => {
      const file = source();
      const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      writeJson(file, { ...current, apiKeyHelper: '/usr/local/bin/print-anthropic-key.sh' });
      try {
        await assertRefused(engineEnv(), 'apiKeyHelper');
      } finally {
        writeJson(file, current);
      }
    });
  }
});

test('channel 5: CLAUDE_CONFIG_DIR/.claude.json primaryApiKey is refused', async () => {
  writeJson(path.join(fx.configDir, '.claude.json'), globalConfig({ primaryApiKey: FAKE_KEY }));
  await assertRefused(engineEnv(), 'primaryApiKey');
});

test('channel 5b: ~/.claude.json primaryApiKey is refused when CLAUDE_CONFIG_DIR is unset', async () => {
  const env = engineEnv();
  delete env.CLAUDE_CONFIG_DIR;
  writeJson(path.join(env.HOME!, '.claude.json'), globalConfig({ primaryApiKey: FAKE_KEY }));
  assert.throws(
    () => assertNoAnthropicCredentialForEngine(env, { cwd: fx.cwd, managedSettingsDir: fx.managedDir }),
    (error: Error & { code?: string }) => error.code === ENGINE_ANTHROPIC_CREDENTIAL_CODE,
  );
});

test('channel 6: ANTHROPIC_API_KEY in the spawn env is refused', async () => {
  await assertRefused(engineEnv({ ANTHROPIC_API_KEY: FAKE_KEY }), 'ANTHROPIC_API_KEY');
});

test('channel 7a: managed policy settings env.ANTHROPIC_API_KEY is refused', async () => {
  writeJson(path.join(fx.managedDir, 'managed-settings.json'),
    { cleanupPeriodDays: 30, env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  await assertRefused(engineEnv(), 'env.ANTHROPIC_API_KEY');
});

test('channel 7b: managed-settings.d drop-in credential is refused', async () => {
  writeJson(path.join(fx.managedDir, 'managed-settings.d', '50-org.json'), { env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  await assertRefused(engineEnv(), 'env.ANTHROPIC_API_KEY');
});

test('channel 7c: ANTHROPIC_CUSTOM_HEADERS is refused in env and in settings', async () => {
  await assertRefused(engineEnv({ ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${FAKE_KEY}` }), 'ANTHROPIC_CUSTOM_HEADERS');
  writeJson(path.join(fx.configDir, 'settings.json'),
    userSettings({ env: { ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${FAKE_KEY}` } }));
  await assertRefused(engineEnv(), 'env.ANTHROPIC_CUSTOM_HEADERS');
});

test('other Anthropic credentials are refused too', async () => {
  await assertRefused(engineEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FIXTURE' }), 'CLAUDE_CODE_OAUTH_TOKEN');
  writeJson(path.join(fx.cwd, '.claude', 'settings.local.json'),
    { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FIXTURE' } });
  await assertRefused(engineEnv(), 'env.CLAUDE_CODE_OAUTH_TOKEN');
  writeJson(path.join(fx.cwd, '.claude', 'settings.local.json'), { env: { ANTHROPIC_AUTH_TOKEN: FAKE_KEY } });
  await assertRefused(engineEnv(), 'env.ANTHROPIC_AUTH_TOKEN');
});

test('project settings at the git root are checked when cwd is a subdirectory', async () => {
  fs.mkdirSync(path.join(fx.cwd, '.git'));
  writeJson(path.join(fx.cwd, '.claude', 'settings.local.json'), { env: { ANTHROPIC_API_KEY: FAKE_KEY } });
  const sub = path.join(fx.cwd, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  assert.throws(
    () => assertNoAnthropicCredentialForEngine(engineEnv(), { cwd: sub, managedSettingsDir: fx.managedDir }),
    (error: Error & { code?: string }) => error.code === ENGINE_ANTHROPIC_CREDENTIAL_CODE,
  );
});

test('malformed JSON in any source fails closed', async (t) => {
  const files = [
    () => path.join(fx.configDir, 'settings.json'),
    () => path.join(fx.cwd, '.claude', 'settings.local.json'),
    () => path.join(fx.managedDir, 'managed-settings.json'),
    () => path.join(fx.configDir, '.claude.json'),
  ];
  for (const [i, file] of files.entries()) {
    await t.test(`file ${i}`, async () => {
      const target = file();
      const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{ "env": { "ANTHROPIC_API_KEY": ');
      try {
        // The credential guard itself refuses with its own code...
        assert.throws(
          () => assertNoAnthropicCredentialForEngine(engineEnv(), { cwd: fx.cwd, managedSettingsDir: fx.managedDir }),
          (error: Error & { code?: string; findings?: Array<{ key: string }> }) =>
            error.code === ENGINE_ANTHROPIC_CREDENTIAL_CODE
            && Boolean(error.findings?.some((f) => f.key === '<malformed-json>')),
        );
        // ...and the full spawn guard refuses too (user settings.json is already
        // fail-closed upstream by the base-URL guard, which may answer first).
        await assert.rejects(runGuard(engineEnv()));
      } finally {
        if (before === null) fs.rmSync(target); else fs.writeFileSync(target, before);
      }
    });
  }
});

test('a non-object settings env block fails closed', async () => {
  writeJson(path.join(fx.configDir, 'settings.json'), userSettings({ env: ['ANTHROPIC_API_KEY'] }));
  await assertRefused(engineEnv(), '<malformed-env>');
});

test('an unreadable source fails closed', { skip: process.getuid?.() === 0 }, async () => {
  const file = path.join(fx.cwd, '.claude', 'settings.local.json');
  writeJson(file, { env: {} });
  fs.chmodSync(file, 0o000);
  try {
    await assertRefused(engineEnv(), '<unreadable:EACCES>');
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

test('official (non-pinned) run with ANTHROPIC_API_KEY everywhere is allowed', async () => {
  writeJson(path.join(fx.configDir, 'settings.json'), userSettings({ env: { ANTHROPIC_API_KEY: FAKE_KEY } }));
  writeJson(path.join(fx.configDir, '.claude.json'), globalConfig({ primaryApiKey: FAKE_KEY }));
  const env = engineEnv({ ANTHROPIC_API_KEY: FAKE_KEY });
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  await runGuard(env, null);
  await runGuard({ ...env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, new Set());
});

test('blank credential values are not treated as present', async () => {
  writeJson(path.join(fx.configDir, 'settings.json'), userSettings({ env: { ANTHROPIC_API_KEY: '' }, apiKeyHelper: null }));
  await runGuard(engineEnv({ ANTHROPIC_API_KEY: '  ' }));
});

test('CLAUDE_CONFIG_DIR unset: the CHILD HOME locates user settings, not os.homedir()', async () => {
  const env = engineEnv();
  delete env.CLAUDE_CONFIG_DIR;
  env.HOME = path.join(fx.root, 'other-home');
  assert.notEqual(env.HOME, os.homedir());
  writeJson(path.join(env.HOME, '.claude', 'settings.json'), userSettings({ env: { ANTHROPIC_API_KEY: FAKE_KEY } }));
  assert.throws(
    () => assertNoAnthropicCredentialForEngine(env, { cwd: fx.cwd, managedSettingsDir: fx.managedDir }),
    (error: Error & { code?: string; findings?: Array<{ key: string; file: string }> }) =>
      error.code === ENGINE_ANTHROPIC_CREDENTIAL_CODE
      && Boolean(error.findings?.some((f) => f.key === 'env.ANTHROPIC_API_KEY'
        && f.file === path.join(env.HOME!, '.claude', 'settings.json'))),
  );
});

test('a persistently malformed global config is still refused after the single retry', () => {
  fs.writeFileSync(path.join(fx.configDir, '.claude.json'), '{"numStartups": 4');
  const started = Date.now();
  assert.throws(
    () => assertNoAnthropicCredentialForEngine(engineEnv(), { cwd: fx.cwd, managedSettingsDir: fx.managedDir }),
    (error: Error & { code?: string }) => error.code === ENGINE_ANTHROPIC_CREDENTIAL_CODE,
  );
  assert.ok(Date.now() - started >= 15, 'the global config was re-read after a short pause');
});

test('settings overrides on the command line are refused anywhere in argv', () => {
  for (const argv of [
    ['--settings', '{"env":{"ANTHROPIC_API_KEY":"x"}}'],
    ['--resume', 's1', '--settings={"apiKeyHelper":"/bin/echo"}'],
    ['--settings', '/home/user/evil-settings.json'],
    ['--setting-sources', 'user'],
    ['--setting-sources=project'],
  ]) {
    assert.throws(() => assertNoSettingsOverrideArgv(argv),
      (error: Error & { code?: string }) => error.code === ENGINE_ANTHROPIC_CREDENTIAL_CODE, argv.join(' '));
  }
  // `--` after a value-taking option is consumed as its value, so it is no barrier.
  assert.throws(
    () => assertNoSettingsOverrideArgv(
      ['--resume', 's1', '--append-system-prompt', '--', '--settings', '{"env":{"ANTHROPIC_API_KEY":"x"}}'],
    ),
    (error: Error & { code?: string }) => error.code === ENGINE_ANTHROPIC_CREDENTIAL_CODE,
  );
  assert.throws(() => assertNoSettingsOverrideArgv(['--resume', 's1', '--', '--settings', 'prompt text']),
    (error: Error & { code?: string }) => error.code === ENGINE_ANTHROPIC_CREDENTIAL_CODE);
  assertNoSettingsOverrideArgv(['--model', 'kimi-k2']);
});

test('isEngineRoutedEnv distinguishes vendor from official routing', () => {
  assert.equal(isEngineRoutedEnv({ ANTHROPIC_BASE_URL: KIMI_URL }), true);
  assert.equal(isEngineRoutedEnv({
    ANTHROPIC_BASE_URL: 'https://proxy.corp.example', NASSAJ_ALLOWED_ANTHROPIC_HOSTS: 'proxy.corp.example',
  }), false);
  assert.equal(isEngineRoutedEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), false);
  assert.equal(isEngineRoutedEnv({ ANTHROPIC_BASE_URL: 'https://evil-anthropic.com' }), true);
  assert.equal(isEngineRoutedEnv({ ANTHROPIC_BASE_URL: 'not a url' }), true);
  assert.equal(isEngineRoutedEnv({}), false);
});
