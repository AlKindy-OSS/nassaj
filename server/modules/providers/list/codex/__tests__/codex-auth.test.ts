import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock, before, after } from 'node:test';

import { createCodexMachineFixture } from '@/shared/tests/codex-release-fixture.js';

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
  delete process.env.CODEX_PATH;

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

const enoent = (): SyncResult => ({
  status: null,
  error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT', syscall: 'spawn codex' }),
});

test('getStatus reports installed=false when the machine release is absent', async () => {
  nextSyncResult = enoent();
  const status = await new CodexProviderAuth(() => false).getStatus();
  assert.equal(status.provider, 'codex');
  assert.equal(status.installed, false);
});

test('T-1872: a PATH codex never counts as installed without the machine release', async () => {
  nextSyncResult = { status: 0 };
  delete process.env.CODEX_PATH;
  const status = await new CodexProviderAuth().getStatus();
  assert.equal(status.installed, false);
});

test('T-1872: the machine release counts as installed even when PATH has no codex', async () => {
  nextSyncResult = enoent();
  const machine = createCodexMachineFixture(path.join(HOME_DIR, 'machine'));
  process.env.CODEX_PATH = machine.launcher;
  try {
    const status = await new CodexProviderAuth().getStatus();
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, false);
  } finally { delete process.env.CODEX_PATH; }
});

test('getStatus reports installed=true + authenticated=true when an API key is configured', async () => {
  const codexDir = path.join(HOME_DIR, '.codex');
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    path.join(codexDir, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'sk-test-xxx' }),
    'utf8',
  );
  const status = await new CodexProviderAuth(() => true).getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.method, 'api_key');
});

/**
 * ADR-200 S3 — the Codex precedence rule, as measured against codex-cli
 * 0.160.0 with `codex login status` (throwaway CODEX_HOME, dummy values):
 * a recorded auth_mode decides alone; without one a non-null key wins.
 */
test('S3: resolveCodexEffectiveAuth encodes the measured Codex precedence', async () => {
  const { resolveCodexEffectiveAuth } = await import('@/modules/providers/list/codex/codex-auth.provider.js');
  const tokens = { id_token: 'h.p.s', access_token: 'DUMMY' };
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-d', tokens }, 'api_key'],
    [{ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-d', tokens }, 'subscription'],
    [{ auth_mode: 'apikey', OPENAI_API_KEY: null, tokens }, 'none'],
    [{ OPENAI_API_KEY: 'sk-d', tokens }, 'api_key'],
    [{ OPENAI_API_KEY: null, tokens }, 'subscription'],
    [{ tokens }, 'subscription'],
    [{ OPENAI_API_KEY: '', tokens }, 'none'],
    [{ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-d' }, 'none'],
    [{ OPENAI_API_KEY: 'sk-d' }, 'api_key'],
    [{}, 'none'],
  ];
  for (const [auth, expected] of cases) {
    assert.equal(resolveCodexEffectiveAuth(auth), expected, JSON.stringify(auth));
  }
});

test('S3: getStatus reports the credential that runs, not just the first one found', async () => {
  const codexDir = path.join(HOME_DIR, '.codex');
  await mkdir(codexDir, { recursive: true });
  const tokens = { id_token: 'h.p.s', access_token: 'DUMMY' };
  const write = (auth: object) => writeFile(path.join(codexDir, 'auth.json'), JSON.stringify(auth), 'utf8');

  await write({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-d', tokens });
  let status = await new CodexProviderAuth(() => true).getStatus();
  assert.equal(status.method, 'api_key');
  assert.equal(status.authMode, 'both');

  await write({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-d', tokens });
  status = await new CodexProviderAuth(() => true).getStatus();
  assert.equal(status.method, 'credentials_file');
  assert.equal(status.authMode, 'both');

  await write({ auth_mode: 'apikey', OPENAI_API_KEY: null, tokens });
  status = await new CodexProviderAuth(() => true).getStatus();
  assert.equal(status.authenticated, false);
  assert.equal(status.authMode, 'subscription_oauth');
});
