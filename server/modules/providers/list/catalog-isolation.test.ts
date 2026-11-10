/**
 * catalog-isolation.test.ts — B-1284 / B-1375, at the ACTUAL spawn.
 *
 * The model-list probes (`agy models`, `opencode models`) used to spawn with the
 * raw server env: every member was shown, and spent, the operator's account, and
 * the child inherited host secrets such as JWT_SECRET. A test that swaps the
 * runner seam never sees the env that reaches the process, so this file spies on
 * `node:child_process.spawn` itself — the call both probes make on Linux — and
 * asserts what the child would really receive:
 *
 *   • two members → two different credential trees (agy HOME, opencode XDG_DATA_HOME);
 *   • no JWT_SECRET in any probe env (SEC-ENV-1 strip reaches the catalog path);
 *   • fail-closed: when isolation is unavailable for the caller (resolveProviderEnv
 *     throws AppError) the probe returns the degraded fallback and NOTHING is
 *     spawned or fetched — never the operator's environment.
 *
 * Runner: node:test + node:assert/strict via tsx.
 */

// B-1771: FIRST import — HOME, CLAUDE_CONFIG_DIR and provider credential env move
// into a sandbox, so an ad-hoc run cannot touch the operator's live logins.
import '../../../shared/__tests__/sandbox-home.js';
// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import '../../../shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-isolation-b1284-'));
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_JWT = process.env.JWT_SECRET;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.JWT_SECRET = 'catalog-isolation-host-secret';

type SpawnRecord = { command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined };
const spawns: SpawnRecord[] = [];

/** stdout each probe prints: agy's `<id>\t<label>` lines, opencode's `provider/model` ids. */
const stdoutFor = (args: readonly string[], command: string): string => (
  /opencode/u.test(command) ? 'anthropic/claude-sonnet-4-5\n' : 'gemini-9-pro\tGemini 9 Pro\n'
);

const fakeSpawn = (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
  spawns.push({ command, args, env: options?.env });
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding(): void };
    stderr: EventEmitter;
    kill(): void;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.emit('data', stdoutFor(args, command));
    child.emit('close', 0);
  });
  return child;
};

const realChildProcess = await import('node:child_process');
const { default: _childDefault, ...childNamed } = realChildProcess;
mock.module('node:child_process', {
  namedExports: { ...childNamed, spawn: fakeSpawn },
  defaultExport: { ...realChildProcess.default, spawn: fakeSpawn },
});

// KNOWN_PROVIDERS is made mutable so the negative case can take a provider OUT of
// the isolation seam — the real path to an AppError refusal.
const realKnown = await import('@/services/isolation/known-providers.js');
const knownProviders = [...realKnown.KNOWN_PROVIDERS];
mock.module(new URL('../../../services/isolation/known-providers.js', import.meta.url).href, {
  namedExports: { KNOWN_PROVIDERS: knownProviders },
});

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
initializeDatabase();

const { AntigravityProviderModels } = await import('./antigravity/antigravity-models.provider.js');
const { __resetAgyModelsCliCircuit } = await import('./antigravity/antigravity-models-cli.client.js');
const { __resetAntigravityCatalogCircuit } = await import('./antigravity/antigravity-catalog.client.js');
const { OpenCodeProviderModels } = await import('./opencode/opencode-models.provider.js');
const { resolveCatalogEnv } = await import('@/services/isolation/resolve-provider-env.js');

const antigravity = new AntigravityProviderModels();
const opencode = new OpenCodeProviderModels();
const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
  try { closeConnection(); } catch { /* already closed */ }
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_JWT === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  spawns.length = 0;
  __resetAgyModelsCliCircuit();
  __resetAntigravityCatalogCircuit();
  globalThis.fetch = (async () => {
    throw new Error('the catalog probe must not reach the network in this test');
  }) as typeof fetch;
});

/** The single spawn a probe made, with its env asserted present. */
const onlySpawnEnv = (): NodeJS.ProcessEnv => {
  assert.equal(spawns.length, 1, 'exactly one probe child');
  const env = spawns[0].env;
  assert.ok(env, 'the probe must pass an env, never inherit the server one');
  return env;
};

test('B-1284: `agy models` runs under each member\'s own HOME, without host secrets', async () => {
  const first = await antigravity.getSupportedModels(1);
  const firstEnv = onlySpawnEnv();
  spawns.length = 0;
  await antigravity.getSupportedModels(2);
  const secondEnv = onlySpawnEnv();

  assert.ok(first.OPTIONS.some((option) => option.value === 'gemini-9-pro'), 'the CLI catalog is served');
  assert.notEqual(firstEnv.HOME, secondEnv.HOME, 'two members must not read one agy login');
  assert.match(firstEnv.HOME ?? '', /nassaj-users[/\\]1$/u);
  assert.match(secondEnv.HOME ?? '', /nassaj-users[/\\]2$/u);
  assert.equal(firstEnv.JWT_SECRET, undefined, 'B-1375: JWT_SECRET must never reach the probe');
});

test('B-1284: `opencode models` runs under each member\'s own XDG data home, without host secrets', async () => {
  await opencode.getSupportedModels(1);
  const firstEnv = onlySpawnEnv();
  spawns.length = 0;
  await opencode.getSupportedModels(2);
  const secondEnv = onlySpawnEnv();

  assert.notEqual(firstEnv.XDG_DATA_HOME, secondEnv.XDG_DATA_HOME, 'two members must not read one auth.json');
  assert.match(firstEnv.XDG_DATA_HOME ?? '', /nassaj-users[/\\]1[/\\]\.local[/\\]share$/u);
  assert.match(secondEnv.XDG_DATA_HOME ?? '', /nassaj-users[/\\]2[/\\]\.local[/\\]share$/u);
  assert.equal(firstEnv.JWT_SECRET, undefined, 'B-1375: JWT_SECRET must never reach the probe');
});

test('B-1284 / ADR-152 A1: a probe with no member spawns nothing and degrades (no operator HOME)', async () => {
  const catalog = await antigravity.getSupportedModels(null);
  assert.equal(spawns.length, 0, 'no probe child runs on the operator tree');
  assert.equal(catalog.degraded, true);
});

test('B-1284 fail-closed: isolation unavailable → degraded fallback, no spawn, no fetch, no operator env', async () => {
  const removed = ['agy', 'opencode'].map((provider) => knownProviders.splice(knownProviders.indexOf(provider), 1)[0]);
  try {
    assert.equal(resolveCatalogEnv(1, 'agy'), null, 'resolveCatalogEnv answers null, not the operator env');

    const agyCatalog = await antigravity.getSupportedModels(1);
    const openCodeCatalog = await opencode.getSupportedModels(1);

    assert.equal(spawns.length, 0, 'no probe child may start when isolation is unavailable');
    assert.equal(agyCatalog.degraded, true);
    assert.equal(openCodeCatalog.degraded, true);
  } finally {
    knownProviders.push(...removed);
  }
});

test('B-1284 / ADR-152 A1: a member\'s agy probe never runs on the operator tree', async () => {
  await antigravity.getSupportedModels(1);
  const env = onlySpawnEnv();
  assert.notEqual(env.HOME, process.env.HOME, 'no sharing policy can hand a member the operator tree');
  assert.ok(String(env.HOME).includes(`${path.sep}.nassaj-users${path.sep}1`), `member tree expected, got ${env.HOME}`);
  assert.equal(env.JWT_SECRET, undefined);
});
