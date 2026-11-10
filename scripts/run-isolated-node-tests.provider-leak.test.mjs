// B-1771 acceptance: on 2026-11-09 a member's Claude credentials were rewritten
// incomplete while test tooling ran with the operator's environment. A test case
// started through either runner must not see ANY provider's parent credential
// variable or credential root, and HOME-derived credential files (~/.codex,
// ~/.gemini, ~/.hermes, ~/.cursor, ~/.qwen, ~/.kimi-code ...) must resolve into a
// throwaway directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PARENT_HOME, PARENT_PROVIDER_ENV } from './fixtures/provider-leak-parent-env.mjs';

const tempParent = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'provider-leak-'));
test.after(() => rmSync(tempParent, { recursive: true, force: true }));

const parentEnv = {
  ...process.env,
  NASSAJ_TEST_TEMP_ROOT: tempParent,
  TMPDIR: tempParent,
  HOME: PARENT_HOME,
  ...PARENT_PROVIDER_ENV,
};

function probeLine(stdout) {
  const line = stdout.split('\n').map(row => row.replace(/^\s*#\s*/u, ''))
    .find(row => row.startsWith('PROVIDER_LEAK_PROBE '));
  assert.ok(line, stdout);
  return JSON.parse(line.slice('PROVIDER_LEAK_PROBE '.length));
}

function assertIsolated(seen) {
  assert.deepEqual(seen.leaked, [], `leaked provider variables: ${seen.leaked.join(', ')}`);
  assert.notEqual(seen.homedir, PARENT_HOME);
  assert.ok(!seen.homedir.startsWith(`${PARENT_HOME}/`), seen.homedir);
  assert.ok(seen.claudeConfigDir, 'a child gets its own throwaway CLAUDE_CONFIG_DIR');
  assert.ok(!seen.claudeConfigDir.startsWith(`${PARENT_HOME}/`), seen.claudeConfigDir);
}

test('run-isolated-node-tests: a case sees no provider credential of the parent', () => {
  const result = spawnSync(process.execPath, [
    'scripts/run-isolated-node-tests.mjs', 'server', 'scripts/fixtures/provider-leak-probe.mjs',
  ], { encoding: 'utf8', env: parentEnv });
  assert.equal(result.status, 0, result.stderr);
  assertIsolated(probeLine(result.stdout));
  assert.doesNotMatch(result.stdout + result.stderr, /parent-[a-z]+-(key|oauth|auth|secret|session)/u);
});

test('run-without-core (test:scripts, test:client entry): no provider credential of the parent', () => {
  const result = spawnSync('bash', [
    'scripts/run-without-core.sh', process.execPath, 'scripts/fixtures/provider-leak-probe.mjs',
  ], { encoding: 'utf8', env: parentEnv });
  assert.equal(result.status, 0, result.stderr);
  const seen = probeLine(result.stdout);
  assertIsolated(seen);
  assert.equal(existsSync(seen.homedir), false, 'the throwaway home is removed after the run');
});

test('run-without-core keeps the child exit status', () => {
  const result = spawnSync('bash', ['scripts/run-without-core.sh', 'bash', '-c', 'exit 7'], {
    encoding: 'utf8', env: parentEnv,
  });
  assert.equal(result.status, 7);
});

test('buildIsolatedTestEnv drops the parent test-runner context', async () => {
  // qa B-1771 r1: an inherited NODE_TEST_CONTEXT made the runner's child speak
  // the v8-serialized reporter protocol, so the leak probe was unreadable.
  const { buildIsolatedTestEnv } = await import('./lib/isolated-test-env.mjs');
  const env = buildIsolatedTestEnv({ NODE_TEST_CONTEXT: 'child-v8', NODE_TEST_WORKER_ID: '3', PATH: '/bin' }, '/tmp/h');
  assert.equal(env.NODE_TEST_CONTEXT, undefined);
  assert.equal(env.NODE_TEST_WORKER_ID, undefined);
  assert.equal(env.PATH, '/bin');
});

test('buildIsolatedTestEnv keeps the parent Playwright browser cache (B-1780)', async () => {
  // Browsers are host material installed once under the parent HOME, never a
  // credential; the isolated HOME has none and tests must not install them.
  const { buildIsolatedTestEnv } = await import('./lib/isolated-test-env.mjs');
  const fromHome = buildIsolatedTestEnv({ HOME: '/home/user', PATH: '/bin' }, '/tmp/h');
  assert.equal(fromHome.PLAYWRIGHT_BROWSERS_PATH, '/home/user/.cache/ms-playwright');
  const fromXdg = buildIsolatedTestEnv({ HOME: '/home/user', XDG_CACHE_HOME: '/srv/cache' }, '/tmp/h');
  assert.equal(fromXdg.PLAYWRIGHT_BROWSERS_PATH, '/srv/cache/ms-playwright');
  const explicit = buildIsolatedTestEnv({ HOME: '/home/user', PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' }, '/tmp/h');
  assert.equal(explicit.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw');
  assert.equal(explicit.HOME, '/tmp/h');
});
