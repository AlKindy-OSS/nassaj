/**
 * B-1764 acceptance: a base URL planted in ANY settings file the Claude CLI loads
 * is refused before Claude spawns.
 *
 * Owner terms: "a project whose .claude/settings.json sets ANTHROPIC_BASE_URL to
 * http://127.0.0.1:11434 (and one in settings.local.json, and one in
 * managed-settings.d) is refused before Claude spawns, for the official path and
 * for each covered spawn site."
 *
 * Why it matters: projects are readable by every member (ADR-089) and a base URL
 * without a gateway credential keeps the saved claude.ai login active, so a base
 * URL one member plants in a shared project would carry the next member's
 * subscription token to the planted host. Ollama's own docs tell users to set
 * exactly this variable.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import '@/shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { assertClaudeSpawnEnvAllowed } from './claude-spawn-env-guard.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const LOCAL_MODEL_URL = 'http://127.0.0.1:11434';
const REFUSED = 'ANTHROPIC_BASE_URL_NOT_ALLOWED';

type Layout = { root: string; project: string; configDir: string; managedDir: string };

/** A sandbox holding a project, a member config dir and a managed-settings dir. */
function makeLayout(t: { after: (fn: () => void) => void }): Layout {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'b1764-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = {
    root,
    project: path.join(root, 'project'),
    configDir: path.join(root, 'member', '.claude'),
    managedDir: path.join(root, 'managed'),
  };
  for (const dir of [path.join(layout.project, '.claude'), layout.configDir, layout.managedDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return layout;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

/** Every settings location the CLI loads besides the member's own settings.json. */
const PLANTED_LOCATIONS: ReadonlyArray<{ name: string; file: (l: Layout) => string }> = [
  { name: 'project .claude/settings.json', file: (l) => path.join(l.project, '.claude', 'settings.json') },
  { name: 'project .claude/settings.local.json', file: (l) => path.join(l.project, '.claude', 'settings.local.json') },
  { name: 'managed-settings.d drop-in', file: (l) => path.join(l.managedDir, 'managed-settings.d', '50-ollama.json') },
  { name: 'managed-settings.json', file: (l) => path.join(l.managedDir, 'managed-settings.json') },
];

function isRefusal(error: unknown): boolean {
  return (error as { code?: string })?.code === REFUSED;
}

for (const location of PLANTED_LOCATIONS) {
  test(`official path: a local-model base URL in the ${location.name} is refused`, async (t) => {
    const l = makeLayout(t);
    writeJson(location.file(l), { env: { ANTHROPIC_BASE_URL: LOCAL_MODEL_URL } });
    await assert.rejects(
      assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, { cwd: l.project, managedSettingsDir: l.managedDir }),
      isRefusal,
    );
  });

  test(`engine-pinned path: a local-model base URL in the ${location.name} is refused`, async (t) => {
    const l = makeLayout(t);
    writeJson(location.file(l), { env: { ANTHROPIC_BASE_URL: LOCAL_MODEL_URL } });
    const env = { CLAUDE_CONFIG_DIR: l.configDir, ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_AUTH_TOKEN: 'engine-key' };
    await assert.rejects(
      assertClaudeSpawnEnvAllowed(env, {
        engineHosts: new Set(['api.moonshot.ai']), cwd: l.project, managedSettingsDir: l.managedDir,
      }),
      isRefusal,
    );
  });
}

test('the project settings are read at the git root too, not only at the cwd', async (t) => {
  const l = makeLayout(t);
  fs.mkdirSync(path.join(l.project, '.git'));
  const nested = path.join(l.project, 'packages', 'app');
  fs.mkdirSync(nested, { recursive: true });
  writeJson(path.join(l.project, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: LOCAL_MODEL_URL } });
  await assert.rejects(
    assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, { cwd: nested, managedSettingsDir: l.managedDir }),
    isRefusal,
  );
});

test('Bedrock / Vertex sibling base URLs in project settings are refused without their flag', async (t) => {
  const l = makeLayout(t);
  const file = path.join(l.project, '.claude', 'settings.local.json');
  const ctx = { cwd: l.project, managedSettingsDir: l.managedDir };
  writeJson(file, { env: { ANTHROPIC_BEDROCK_BASE_URL: LOCAL_MODEL_URL } });
  await assert.rejects(assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, ctx), isRefusal);
  writeJson(file, { env: { ANTHROPIC_VERTEX_BASE_URL: 'https://us-east5-aiplatform.googleapis.com' } });
  await assert.rejects(assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, ctx), isRefusal);
  // The flag set in the same project settings enables its own cloud (same rule as the user tier).
  writeJson(file, {
    env: { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_BASE_URL: 'https://us-east5-aiplatform.googleapis.com' },
  });
  await assert.doesNotReject(assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, ctx));
});

// ── Spawn sites: each refuses before its claude child starts ─────────────────

/** A fake claude that leaves a marker if it is ever executed. */
function fakeClaude(l: Layout): { bin: string; marker: string } {
  const marker = path.join(l.root, 'spawned');
  const bin = path.join(l.root, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\necho '{}'\n`, { mode: 0o755 });
  return { bin, marker };
}

test('spawn site — workflow resume runner: refuses a project-planted base URL, claude never runs', async (t) => {
  const l = makeLayout(t);
  writeJson(path.join(l.project, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: LOCAL_MODEL_URL } });
  const { bin, marker } = fakeClaude(l);
  // eslint-disable-next-line boundaries/dependencies -- the spawn site itself is the unit under test.
  const { defaultRunResumeTurn, WORKFLOW_CLAUDE_BIN_ENV } = await import('@/modules/workflow-supervisor/resume-turn-runner.js');
  const previous = process.env[WORKFLOW_CLAUDE_BIN_ENV];
  process.env[WORKFLOW_CLAUDE_BIN_ENV] = bin;
  t.after(() => {
    if (previous === undefined) delete process.env[WORKFLOW_CLAUDE_BIN_ENV];
    else process.env[WORKFLOW_CLAUDE_BIN_ENV] = previous;
  });
  const result = await defaultRunResumeTurn({
    userId: 1, conversationId: 'conv-b1764', projectPath: l.project, prompt: 'p', systemFraming: 's',
    model: null, disallowedTools: ['Task'], env: { CLAUDE_CONFIG_DIR: l.configDir, PATH: '/usr/bin:/bin' }, maxHoldMs: 1_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', new RegExp(REFUSED));
  assert.equal(fs.existsSync(marker), false, 'claude must never have started');
});

test('spawn site — workflow task-runner: refuses a project-planted base URL at its cwd', async (t) => {
  const l = makeLayout(t);
  writeJson(path.join(l.project, '.claude', 'settings.local.json'), { env: { ANTHROPIC_BASE_URL: LOCAL_MODEL_URL } });
  const { bin, marker } = fakeClaude(l);
  const taskDir = path.join(l.root, 'task');
  const tsxLoader = import.meta.resolve('tsx');
  const run = spawnSync(
    process.execPath,
    ['--import', tsxLoader, path.join(SERVER_ROOT, 'modules/workflow-supervisor/task-runner.ts'),
      '--task-dir', taskDir, '--claude-bin', bin, '--prompt', 'hi'],
    {
      cwd: l.project, // systemd --working-directory = the project
      env: { PATH: '/usr/bin:/bin', HOME: l.root, CLAUDE_CONFIG_DIR: l.configDir },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskDir, 'DONE'), 'utf8')).exit_code, 126);
  assert.match(fs.readFileSync(path.join(taskDir, 'stderr.log'), 'utf8'), new RegExp(REFUSED));
  assert.equal(fs.existsSync(marker), false, 'claude must not run on a refused project');
});

test('spawn site — turn-supervisor adapter: refuses a base URL planted at its spawn cwd', async (t) => {
  const l = makeLayout(t);
  writeJson(path.join(l.project, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: LOCAL_MODEL_URL } });
  /* eslint-disable boundaries/dependencies -- the spawn site itself is the unit under test. */
  const { createClaudeSdkTurnAdapter } = await import('@/modules/turn-supervisor/adapters/claude-sdk-adapter.js');
  const { TurnAdapterRegistry } = await import('@/modules/turn-supervisor/adapters/registry.js');
  const { createCaptureOnlyWriter } = await import('@/modules/turn-supervisor/adapters/capture-only-writer.js');
  /* eslint-enable boundaries/dependencies */
  // The adapter spawns without a cwd, so the child inherits this process's cwd.
  const previousCwd = process.cwd();
  process.chdir(l.project);
  t.after(() => process.chdir(previousCwd));
  let spawned = false;
  const registry = new TurnAdapterRegistry([createClaudeSdkTurnAdapter({
    enabled: () => true,
    getAuthStatus: async () => ({ installed: true, authenticated: true }),
    resolveEnvironment: () => ({ PATH: process.env.PATH, CLAUDE_CONFIG_DIR: l.configDir }),
    assertRunAllowed: async () => undefined,
    queryFactory: () => {
      spawned = true;
      return (async function* stream() { /* never reached */ })();
    },
  })]);
  const probe = await registry.probe({ provider: 'claude', userId: '7' });
  await assert.rejects(
    registry.invoke({
      capability: probe.capability!, model: 'claude-sonnet-4-6', prompt: 'p', system: 's',
      persist: false, writer: createCaptureOnlyWriter(),
    }),
    (error: unknown) => isRefusal(error) || isRefusal((error as { cause?: unknown })?.cause),
  );
  assert.equal(spawned, false, 'the SDK query must never be constructed');
});

test('every Claude spawn site routes settings through the full-set guard with its spawn cwd', () => {
  const read = (rel: string) => fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
  const sdk = read('claude-sdk.js');
  // The probe, /btw and live-run pre-profile checks name their real spawn cwd.
  assert.equal((sdk.match(/await assertClaudeSpawnEnvAllowed\(sdkOptions\.env, \{ cwd: /g) ?? []).length, 3);
  assert.match(read('modules/providers/list/claude/claude-catalog.client.ts'),
    /await assertClaudeSpawnEnvAllowed\(probeEnv, \{ cwd: probeCwd \}\)/);
  assert.match(read('modules/turn-supervisor/adapters/claude-sdk-adapter.ts'),
    /await assertClaudeSpawnEnvAllowed\(env, \{ cwd: process\.cwd\(\) \}\)/);
  assert.match(read('modules/workflow-supervisor/task-runner.ts'),
    /await assertClaudeSpawnEnvAllowed\(childEnv, \{ cwd: process\.cwd\(\) \}\)/);
  assert.match(read('services/isolation/managed-claude-launcher.ts'),
    /assertClaudeSettingsRoutingAllowed\(profileEnv as NodeJS\.ProcessEnv, \{ cwd: process\.cwd\(\), engineOrigins \}\)/);
  // No site keeps the user-settings-only check.
  for (const rel of ['claude-sdk.js', 'modules/providers/list/claude/claude-catalog.client.ts',
    'modules/turn-supervisor/adapters/claude-sdk-adapter.ts']) {
    assert.doesNotMatch(read(rel), /assertSettingsEnvAllowed/, `${rel} still checks only the user settings`);
  }
});

// ── Edges ────────────────────────────────────────────────────────────────────

test('a malformed project settings file is refused (cannot prove there is no override)', async (t) => {
  const l = makeLayout(t);
  writeJson(path.join(l.project, '.claude', 'settings.json'), '{ "env": { "ANTHROPIC_BASE_URL": ');
  await assert.rejects(
    assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, { cwd: l.project, managedSettingsDir: l.managedDir }),
    isRefusal,
  );
});

test('a non-object env block in a settings file is refused', async (t) => {
  const l = makeLayout(t);
  writeJson(path.join(l.managedDir, 'managed-settings.d', '10.json'), { env: ['ANTHROPIC_BASE_URL=http://x'] });
  await assert.rejects(
    assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, { cwd: l.project, managedSettingsDir: l.managedDir }),
    isRefusal,
  );
});

test('an unreadable project settings file is refused', { skip: process.getuid?.() === 0 }, async (t) => {
  const l = makeLayout(t);
  const file = path.join(l.project, '.claude', 'settings.local.json');
  writeJson(file, { theme: 'dark' });
  fs.chmodSync(file, 0o000);
  try {
    await assert.rejects(
      assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, { cwd: l.project, managedSettingsDir: l.managedDir }),
      isRefusal,
    );
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

test('an unreadable managed-settings.d directory is refused', { skip: process.getuid?.() === 0 }, async (t) => {
  const l = makeLayout(t);
  const dropIns = path.join(l.managedDir, 'managed-settings.d');
  fs.mkdirSync(dropIns);
  fs.chmodSync(dropIns, 0o000);
  try {
    await assert.rejects(
      assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, { cwd: l.project, managedSettingsDir: l.managedDir }),
      isRefusal,
    );
  } finally {
    fs.chmodSync(dropIns, 0o700);
  }
});

test('an unknown *_BASE_URL in project settings is refused even when it names Anthropic', async (t) => {
  const l = makeLayout(t);
  writeJson(path.join(l.project, '.claude', 'settings.json'), { env: { CLAUDE_GATEWAY_BASE_URL: 'https://api.anthropic.com' } });
  await assert.rejects(
    assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, { cwd: l.project, managedSettingsDir: l.managedDir }),
    (error: unknown) => isRefusal(error) && /CLAUDE_GATEWAY_BASE_URL/.test(String((error as Error).message)),
  );
});

test('official anthropic.com in project, local and managed settings is allowed', async (t) => {
  const l = makeLayout(t);
  for (const location of PLANTED_LOCATIONS) {
    writeJson(location.file(l), { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
  }
  writeJson(path.join(l.configDir, 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
  await assert.doesNotReject(
    assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, { cwd: l.project, managedSettingsDir: l.managedDir }),
  );
});

test('missing files, no env block and empty dirs are all allowed', async (t) => {
  const l = makeLayout(t);
  writeJson(path.join(l.project, '.claude', 'settings.json'), { theme: 'dark' });
  fs.mkdirSync(path.join(l.managedDir, 'managed-settings.d'));
  await assert.doesNotReject(
    assertClaudeSpawnEnvAllowed({ CLAUDE_CONFIG_DIR: l.configDir }, { cwd: l.project, managedSettingsDir: l.managedDir }),
  );
});

test('an operator-allowlisted gateway in project settings is allowed (NASSAJ_ALLOWED_ANTHROPIC_HOSTS)', async (t) => {
  const l = makeLayout(t);
  writeJson(path.join(l.project, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://gw.corp.example' } });
  const env = { CLAUDE_CONFIG_DIR: l.configDir, NASSAJ_ALLOWED_ANTHROPIC_HOSTS: 'gw.corp.example' };
  await assert.doesNotReject(assertClaudeSpawnEnvAllowed(env, { cwd: l.project, managedSettingsDir: l.managedDir }));
});

test('engine regression: a kimi/glm engine-pinned env with clean settings still passes', async (t) => {
  const l = makeLayout(t);
  for (const [host, url] of [['api.moonshot.ai', 'https://api.moonshot.ai/anthropic'], ['api.z.ai', 'https://api.z.ai/api/anthropic']]) {
    const env = { CLAUDE_CONFIG_DIR: l.configDir, ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: 'engine-key' };
    await assert.doesNotReject(
      assertClaudeSpawnEnvAllowed(env, { engineHosts: new Set([host]), cwd: l.project, managedSettingsDir: l.managedDir }),
    );
    // The engine host is authorized for the spawn env only; without the verdict it is refused.
    await assert.rejects(
      assertClaudeSpawnEnvAllowed(env, { cwd: l.project, managedSettingsDir: l.managedDir }),
      isRefusal,
    );
  }
});

test('engine regression: B-1541 still refuses an Anthropic key in project settings of a pinned run', async (t) => {
  const l = makeLayout(t);
  writeJson(path.join(l.project, '.claude', 'settings.json'), { env: { ANTHROPIC_API_KEY: 'sk-ant-planted' } });
  const env = { CLAUDE_CONFIG_DIR: l.configDir, ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'k' };
  await assert.rejects(
    assertClaudeSpawnEnvAllowed(env, { engineHosts: new Set(['api.z.ai']), cwd: l.project, managedSettingsDir: l.managedDir }),
    (error: unknown) => (error as { code?: string })?.code === 'ENGINE_ANTHROPIC_CREDENTIAL_EXPOSED',
  );
});
