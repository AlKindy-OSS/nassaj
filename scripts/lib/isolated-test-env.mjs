#!/usr/bin/env node
/**
 * isolated-test-env — gives test processes a throwaway HOME and no provider
 * credential (B-1771).
 *
 * On 2026-11-09 a server test run with the operator's HOME rewrote a member's
 * live `.credentials.json` with a fixture token and broke every chat of that
 * member. Every test entry point (run-without-core.sh, run-isolated-node-tests.mjs)
 * now builds its child environment here: every provider credential variable and
 * credential-root knob is dropped (the list is shared with the spawn isolation
 * seam), and HOME / CLAUDE_CONFIG_DIR point into a directory the run owns, so
 * dotfile credentials (~/.codex, ~/.gemini, ~/.hermes, ~/.cursor, ~/.qwen,
 * ~/.kimi-code, ~/.nassaj-users) resolve there too.
 *
 * CLI: `node scripts/lib/isolated-test-env.mjs <command> [args...]` runs the
 * command in a fresh home under TMPDIR, removes it afterwards, and exits with
 * the child's status (or dies by the child's signal).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProviderCredentialEnvName } from '../../server/services/isolation/provider-credential-env.js';

/**
 * Set by a parent `node --test` for its own children; inherited, it switches a
 * nested test process to the v8-serialized reporter protocol.
 */
const RUNNER_CONTEXT_ENV = new Set(['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']);

/**
 * Playwright's browser cache of the parent: its PLAYWRIGHT_BROWSERS_PATH, else
 * Playwright's Linux default under the parent's cache dir. Browsers are host
 * material, not credentials, and the throwaway HOME has none (B-1780).
 * @param {NodeJS.ProcessEnv} parentEnv
 * @returns {string}
 */
function parentPlaywrightBrowsersPath(parentEnv) {
  if (parentEnv.PLAYWRIGHT_BROWSERS_PATH) return parentEnv.PLAYWRIGHT_BROWSERS_PATH;
  const cache = parentEnv.XDG_CACHE_HOME || path.join(parentEnv.HOME || os.homedir(), '.cache');
  return path.join(cache, 'ms-playwright');
}

/**
 * Copy of `parentEnv` without provider credentials, credential roots or the
 * parent test-runner context, with
 * HOME, USERPROFILE and CLAUDE_CONFIG_DIR inside `home`. Test knobs
 * (NASSAJ_TEST_*) are kept. Git identity defaults keep commits working without
 * the operator's ~/.gitconfig.
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {string} home absolute path the caller owns
 * @returns {NodeJS.ProcessEnv}
 */
export function buildIsolatedTestEnv(parentEnv, home) {
  const env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (RUNNER_CONTEXT_ENV.has(name)) continue;
    if (name.startsWith('NASSAJ_TEST_') || !isProviderCredentialEnvName(name)) env[name] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    PLAYWRIGHT_BROWSERS_PATH: parentPlaywrightBrowsersPath(parentEnv),
    GIT_AUTHOR_NAME: parentEnv.GIT_AUTHOR_NAME || 'nassaj-test',
    GIT_AUTHOR_EMAIL: parentEnv.GIT_AUTHOR_EMAIL || 'nassaj-test@localhost',
    GIT_COMMITTER_NAME: parentEnv.GIT_COMMITTER_NAME || 'nassaj-test',
    GIT_COMMITTER_EMAIL: parentEnv.GIT_COMMITTER_EMAIL || 'nassaj-test@localhost',
  };
}

/** Runs argv in a fresh isolated home; returns the child's spawnSync result. */
function runIsolated(argv) {
  const parent = process.env.TMPDIR || os.tmpdir();
  const root = mkdtempSync(path.join(parent, 'nassaj-test-home-'));
  const home = path.join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  try {
    return spawnSync(argv[0], argv.slice(1), { env: buildIsolatedTestEnv(process.env, home), stdio: 'inherit' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stderr.write('usage: isolated-test-env.mjs <command> [args...]\n');
    process.exit(64);
  }
  const result = runIsolated(argv);
  if (result.error) {
    process.stderr.write(`isolated-test-env: ${result.error.message}\n`);
    process.exit(127);
  }
  if (result.signal) {
    // Die by the same signal so callers see it; the core limit stays at zero.
    process.removeAllListeners(result.signal);
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 1);
}
