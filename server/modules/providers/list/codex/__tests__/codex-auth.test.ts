import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock, before, after } from 'node:test';

/**
 * End-to-end wiring test for CodexProviderAuth.getStatus() installed detection
 * (B-56 follow-up). cross-spawn is mocked at the module boundary so the test
 * never depends on a real `codex` binary; this proves the provider -> shared
 * isCliInstalled -> spawn.sync chain reports installed correctly.
 *
 * spawn.sync is configured per test via the mutable `nextSyncResult`. cross-spawn
 * exports a callable default with a `.sync` property; cli-detect imports that
 * default and calls `.sync` on it, so mocking the default alone is sufficient.
 */
type SyncResult = { status: number | null; signal?: NodeJS.Signals | null; error?: NodeJS.ErrnoException };

let nextSyncResult: SyncResult = { status: null };
const syncFn = () => nextSyncResult;

let CodexProviderAuth: typeof import('@/modules/providers/list/codex/codex-auth.provider.js').CodexProviderAuth;

let HOME_DIR = '';

before(async () => {
  // Isolate HOME so the credential read (~/.codex/auth.json) is deterministic.
  HOME_DIR = await mkdtemp(path.join(os.tmpdir(), 'codex-auth-'));
  process.env.HOME = HOME_DIR;

  // cross-spawn is CJS exporting a callable with a `.sync` property. cli-detect
  // imports the default and calls `.sync`, so mocking the default alone covers
  // it. (CJS module mocks reject defaultExport + namedExports together.)
  const defaultExport = Object.assign(
    () => { throw new Error('async spawn not used in this test'); },
    { sync: syncFn },
  );
  mock.module('cross-spawn', { defaultExport });

  ({ CodexProviderAuth } = await import('@/modules/providers/list/codex/codex-auth.provider.js'));
});

after(async () => {
  await rm(HOME_DIR, { recursive: true, force: true });
});

test('getStatus reports installed=false when codex is missing (ENOENT)', async () => {
  nextSyncResult = {
    status: null,
    error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT', syscall: 'spawn codex' }),
  };
  const status = await new CodexProviderAuth().getStatus();
  assert.equal(status.provider, 'codex');
  assert.equal(status.installed, false);
});

test('getStatus reports installed=true when codex --version exits 0', async () => {
  nextSyncResult = { status: 0 };
  const status = await new CodexProviderAuth().getStatus();
  assert.equal(status.installed, true);
});

test('getStatus reports installed=true when codex present but auth.json absent', async () => {
  // installed must reflect the binary, independent of credential presence.
  nextSyncResult = { status: 0 };
  const status = await new CodexProviderAuth().getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
});

test('getStatus reports installed=true + authenticated=true when an API key is configured', async () => {
  nextSyncResult = { status: 0 };
  const codexDir = path.join(HOME_DIR, '.codex');
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    path.join(codexDir, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'sk-test-xxx' }),
    'utf8',
  );
  const status = await new CodexProviderAuth().getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.method, 'api_key');
});
