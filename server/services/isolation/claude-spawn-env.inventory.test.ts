/**
 * B-446 — every Claude-body spawn site passes the iron-rule routing guard.
 *
 * Two workflow-supervisor spawns (the unit's task-runner and the Tier-B resume
 * runner) used to hand `claude` an unchecked env. Three layers keep that closed:
 *   1. an enumeration of every file that spawns the Claude body and the guard
 *      call it must make;
 *   2. a discovery sweep: a server file that resolves the claude binary (or the
 *      Agent SDK) and spawns must be enumerated or exempted — a new site fails;
 *   3. no enumerated site passes raw `process.env` as a spawn env, plus a
 *      behaviour check that the shared guard and the resume runner refuse a
 *      competitor route before any process starts.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { assertClaudeSpawnEnvAllowed } from './claude-spawn-env-guard.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');

/** File → the routing-guard call it must make before its Claude spawn. */
const CLAUDE_SPAWN_SITES: ReadonlyArray<{ file: string; guard: RegExp }> = [
  { file: 'claude-sdk.js', guard: /resolveClaudeRunProfileOrThrow\(/ },
  { file: 'services/isolation/managed-claude-launcher.ts', guard: /resolveClaudeRunProfileOrThrow\)\(/ },
  { file: 'modules/providers/list/claude/claude-catalog.client.ts', guard: /assertAnthropicBaseUrlAllowed\(/ },
  { file: 'modules/turn-supervisor/adapters/claude-sdk-adapter.ts', guard: /assertAnthropicBaseUrlAllowed\(/ },
  { file: 'modules/workflow-supervisor/task-runner.ts', guard: /await assertClaudeSpawnEnvAllowed\(childEnv\)/ },
  { file: 'modules/workflow-supervisor/resume-turn-runner.ts', guard: /await assertClaudeSpawnEnvAllowed\(params\.env/ },
];

/** Files that match the discovery pattern but never spawn the Claude body themselves. */
const EXEMPT: Readonly<Record<string, string>> = {
  'services/isolation/provider-cage-wiring.js': 'launch helper; every caller is guarded first',
  'shared/claude-cli-path.ts': 'runs where.exe to locate claude on Windows; never the harness',
};

const RESOLVES_CLAUDE = /resolveHarnessBinary(WithOverride)?\('claude'|claude-agent-sdk['"]|\bclaudeBin\b|resolveClaudeCodeExecutablePath/;
const SPAWNS = /\bspawn(Sync)?\(|execFile(Sync)?\(|pty\.spawn\(|\bquery\(|spawnFn\(|spawnImpl\(|crossSpawn\(/;
/** A spawn option that forwards the server env unchecked. */
const RAW_ENV_OPTION = /\benv\s*:\s*(process\.env|\{\s*\.\.\.process\.env\s*\})\s*[,}]/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function read(rel: string): string {
  return stripComments(fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8'));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', '__tests__'].includes(e.name)) sourceFiles(abs, out);
    } else if (/\.(js|ts)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name)) {
      out.push(path.relative(SERVER_ROOT, abs));
    }
  }
  return out;
}

test('every enumerated Claude spawn site calls the routing guard', () => {
  for (const { file, guard } of CLAUDE_SPAWN_SITES) {
    assert.match(read(file), guard, `${file} must route its Claude spawn env through the iron-rule guard`);
  }
});

test('no enumerated Claude spawn site hands raw process.env to the child', () => {
  for (const { file } of CLAUDE_SPAWN_SITES) {
    assert.doesNotMatch(read(file), RAW_ENV_OPTION, `${file} spawns with raw process.env`);
  }
});

test('discovery: a file that resolves claude and spawns is enumerated or exempted', () => {
  const known = new Set(CLAUDE_SPAWN_SITES.map((s) => s.file));
  const offenders = sourceFiles(SERVER_ROOT).filter((rel) => {
    if (known.has(rel) || rel in EXEMPT) return false;
    const src = read(rel);
    return RESOLVES_CLAUDE.test(src) && SPAWNS.test(src);
  });
  assert.deepEqual(offenders, [], 'new Claude spawn site(s) are not enumerated with their routing guard');
});

test('the raw-env detector catches both raw forms and ignores a guarded copy', () => {
  assert.match('spawn(bin, args, { env: process.env, stdio })', RAW_ENV_OPTION);
  assert.match('spawn(bin, args, { env: { ...process.env } })', RAW_ENV_OPTION);
  assert.doesNotMatch('spawn(bin, args, { env: childEnv })', RAW_ENV_OPTION);
});

test('the shared guard refuses a competitor route and allows official Anthropic', async () => {
  await assert.rejects(
    assertClaudeSpawnEnvAllowed({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }),
    (err: { code?: string }) => err.code === 'ANTHROPIC_BASE_URL_NOT_ALLOWED',
  );
  await assert.doesNotReject(assertClaudeSpawnEnvAllowed({}));
  await assert.doesNotReject(assertClaudeSpawnEnvAllowed({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }));
});

test('the resume runner refuses a competitor-routed env before spawning claude', async (t) => {
  const { defaultRunResumeTurn, WORKFLOW_CLAUDE_BIN_ENV } = await import('@/modules/workflow-supervisor/resume-turn-runner.js');
  // A real executable that would leave a marker if the runner ever started it.
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'b446-'));
  const marker = path.join(scratch, 'spawned');
  const fakeClaude = path.join(scratch, 'claude');
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const previousBin = process.env[WORKFLOW_CLAUDE_BIN_ENV];
  process.env[WORKFLOW_CLAUDE_BIN_ENV] = fakeClaude;
  t.after(() => {
    if (previousBin === undefined) delete process.env[WORKFLOW_CLAUDE_BIN_ENV];
    else process.env[WORKFLOW_CLAUDE_BIN_ENV] = previousBin;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const result = await defaultRunResumeTurn({
    userId: 1,
    conversationId: 'conv-b446',
    projectPath: SERVER_ROOT,
    prompt: 'p',
    systemFraming: 's',
    model: null,
    disallowedTools: ['Task'],
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
    maxHoldMs: 1_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null, 'no child exit code: claude never started');
  assert.match(result.error ?? '', /ANTHROPIC_BASE_URL_NOT_ALLOWED/);
  assert.equal(fs.existsSync(marker), false, 'the claude binary must never have run');
});

test('the workflow task-runner seals a refusal and never starts claude on a competitor route', (t) => {
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'b446-unit-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, 'spawned');
  const fakeClaude = path.join(scratch, 'claude');
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ntouch '${marker}'\necho '{}'\n`, { mode: 0o755 });
  const runUnit = (taskDir: string, extraEnv: NodeJS.ProcessEnv) => spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(SERVER_ROOT, 'modules/workflow-supervisor/task-runner.ts'),
      '--task-dir', taskDir, '--claude-bin', fakeClaude, '--prompt', 'hi'],
    { env: { PATH: '/usr/bin:/bin', HOME: scratch, ...extraEnv }, encoding: 'utf8', timeout: 60_000 },
  );

  const refusedDir = path.join(scratch, 'refused');
  const refused = runUnit(refusedDir, { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' });
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(refusedDir, 'DONE'), 'utf8')).exit_code, 126);
  assert.match(fs.readFileSync(path.join(refusedDir, 'stderr.log'), 'utf8'), /ANTHROPIC_BASE_URL_NOT_ALLOWED/);
  assert.equal(fs.existsSync(marker), false, 'claude must not run on a refused env');

  const okDir = path.join(scratch, 'ok');
  const ok = runUnit(okDir, {});
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(okDir, 'DONE'), 'utf8')).exit_code, 0);
  assert.equal(fs.existsSync(marker), true, 'an official-route env still runs claude');
});
