/**
 * B-141 — server/load-env.js must distinguish a genuinely-missing .env (ENOENT,
 * an optional-config case → continue as before) from ANY OTHER read failure
 * (EACCES / EISDIR / partial read / wrong cwd → fail-fast). Before the fix the
 * bare try/catch swallowed every error with a console.log and fell through, so a
 * transient read failure silently dropped DATABASE_PATH to the ~/.cloudcli/auth.db
 * default (≠ the live ~/.local/share/nassaj-dev/db.sqlite) and booted the backend
 * on an empty database with a fresh bootstrap-owner window.
 *
 * Strategy: exercise the REAL server/load-env.js in child processes so the actual
 * process.exit / exit code is observed (load-env runs its logic as a top-level
 * import side effect, and ESM modules cannot be re-evaluated twice in one
 * process). fs.readFileSync is forced to throw a chosen error through Node's
 * module-mocking API before load-env imports it. This avoids mutating the shared
 * fs builtin, which Node 24's ESM loader itself uses to load source files. No
 * scratch files are written and nothing on disk is touched.
 *
 * Framework: node:test + node:assert/strict via tsx (package.json "test"),
 * matching the sibling server suite. Run with:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/load-env.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { describe } from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
// The real module under test — not a copy, so the test can never drift from it.
const LOAD_ENV = path.join(import.meta.dirname, 'load-env.js');

/**
 * Run the real load-env.js in a child, forcing fs.readFileSync(<APP_ROOT>/.env)
 * to throw an Error whose `.code` is `errCode` (or no code when null). The
 * child registers the mock before importing load-env, without changing the fs
 * object used by Node's own module loader.
 */
function runLoadEnv(errCode: string | null): SpawnSyncReturns<string> {
  const codeLiteral = errCode === null ? 'undefined' : JSON.stringify(errCode);
  const label = errCode ?? 'unclassified';
  const targetUrl = JSON.stringify(pathToFileURL(LOAD_ENV).href);
  const script =
    `import { mock } from 'node:test';` +
    `mock.module('fs', { defaultExport: { readFileSync() {` +
    `  const e = new Error('simulated ${label} read failure');` +
    `  e.code = ${codeLiteral};` +
    `  throw e;` +
    `} } });` +
    `await import(${targetUrl});`;
  return spawnSync(process.execPath, [
    '--experimental-test-module-mocks',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('load-env .env read error handling (B-141)', () => {
  // Any non-ENOENT read error must abort boot loudly rather than fall through to
  // the wrong default database.
  for (const code of ['EACCES', 'EISDIR'] as const) {
    test(`non-ENOENT read error (${code}) → fail-fast: exit 1 + stderr names .env`, () => {
      const { status, stderr } = runLoadEnv(code);
      assert.equal(status, 1, `expected exit 1 on ${code}, got status=${status}`);
      assert.match(stderr, /\.env/, 'stderr must point at the .env read failure');
      assert.match(stderr, new RegExp(code), 'stderr must surface the underlying error');
    });
  }

  test('read error with no error code → fail-fast (only ENOENT is tolerated)', () => {
    const { status } = runLoadEnv(null);
    assert.equal(status, 1, 'an unclassified read error must not be swallowed');
  });

  test('missing .env (ENOENT) → continue silently: exit 0, no fatal on stderr', () => {
    const { status, stderr } = runLoadEnv('ENOENT');
    assert.equal(status, 0, `ENOENT must continue (exit 0), got status=${status}`);
    assert.doesNotMatch(stderr, /FATAL/, 'ENOENT must not take the fail-fast path');
  });
});
