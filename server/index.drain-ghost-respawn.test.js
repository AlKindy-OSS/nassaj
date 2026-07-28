/**
 * B-24 regression: a DRAINED-but-ORPHANED instance must not make PM2 respawn a
 * ghost.
 *
 * BACKGROUND (verified against the installed PM2 7.0.1 source, not from docs):
 *   - lib/God.js:404 `God.handleExit(clu, exit_code)` looks the process up as
 *     `clusters_db[clu.pm2_env.pm_id]` and decides the restart from THAT slot's
 *     status — there is no check that the exiting pid is still the slot's pid.
 *   - lib/God.js:414-424 the ONLY input that suppresses the restart regardless
 *     of slot status is `stop_exit_codes`.
 *   So when our predecessor finishes an hours-long drain while the replacement
 *   is already `online`, PM2 sees an `online` slot "exit" and spawns a third
 *   process. Marking that late exit with a sentinel code listed in
 *   `stop_exit_codes` is the only mitigation available without patching PM2.
 *
 * WHY THE UNUSUAL HARNESS: server/index.js calls startServer() at module scope,
 * so importing it would boot the HTTP server, the websocket server and the real
 * database. Following the precedent of server/index.security.test.js, these
 * tests EXTRACT THE REAL SOURCE TEXT of `resolveDrainExitCode` (and of the
 * drain's injected `exit` wrapper) from server/index.js and evaluate it with
 * injected collaborators. The bytes under test are the bytes that ship.
 *
 * The last test pins the ecosystem side: index.js and every ecosystem*.config.cjs
 * must agree on the sentinel value, otherwise the guard is a no-op in production
 * (the exact "dead security helper" failure mode).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');
const INDEX_PATH = path.join(HERE, 'index.js');
const INDEX_SOURCE = fs.readFileSync(INDEX_PATH, 'utf8');
const require_ = createRequire(import.meta.url);

/** Slice a balanced `{...}` block starting at the first `{` at/after `from`. */
function sliceBalancedBlock(source, from) {
  const start = source.indexOf('{', from);
  assert.notStrictEqual(start, -1, 'expected a block to extract');
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced block while extracting source');
}

/** The sentinel constant, read from index.js so the test cannot drift from it. */
function readSentinelFromIndex() {
  const m = INDEX_SOURCE.match(/const DRAIN_ORPHAN_EXIT_CODE = (\d+);/);
  assert.ok(m, 'DRAIN_ORPHAN_EXIT_CODE not declared in server/index.js (B-24 guard missing)');
  return Number(m[1]);
}

/**
 * Build a callable `resolveDrainExitCode` out of the real source text in
 * index.js, with `fs` and the sentinel constant supplied from outside.
 */
function loadResolveDrainExitCode() {
  const marker = 'function resolveDrainExitCode(';
  const at = INDEX_SOURCE.indexOf(marker);
  assert.notStrictEqual(
    at,
    -1,
    'resolveDrainExitCode not found in server/index.js — the B-24 ghost-respawn guard is missing',
  );
  const signatureEnd = INDEX_SOURCE.indexOf(')', at);
  const params = INDEX_SOURCE.slice(at + marker.length, signatureEnd);
  const body = sliceBalancedBlock(INDEX_SOURCE, signatureEnd);
  const factory = new Function(
    'fs',
    'DRAIN_ORPHAN_EXIT_CODE',
    `return function resolveDrainExitCode(${params}) ${body};`,
  );
  return factory(fs, readSentinelFromIndex());
}

/** Deps that describe "PM2 still tracks us" unless overridden. */
function deps(overrides = {}) {
  return {
    requestedCode: 0,
    pidPath: '/tmp/pm2-pids/nassaj-dev-5.pid',
    ownPid: 4242,
    readPidFile: () => '4242\n',
    isProcessAlive: () => true,
    logger: { warn() {}, log() {}, error() {} },
    ...overrides,
  };
}

test('orphan after drain: PM2 slot taken by another LIVE pid → sentinel exit code', () => {
  const resolveDrainExitCode = loadResolveDrainExitCode();
  const sentinel = readSentinelFromIndex();

  const code = resolveDrainExitCode(
    deps({ readPidFile: () => '9999\n', isProcessAlive: (pid) => pid === 9999 }),
  );

  assert.strictEqual(
    code,
    sentinel,
    'a drained orphan must exit with the stop_exit_codes sentinel so God.handleExit ' +
      'does not respawn a ghost beside the live replacement (B-24)',
  );
  assert.notStrictEqual(sentinel, 0, 'the sentinel must differ from the normal exit code');
});

test('orphan detection logs the takeover so the operator can see why the code changed', () => {
  const resolveDrainExitCode = loadResolveDrainExitCode();
  const warnings = [];
  resolveDrainExitCode(
    deps({
      readPidFile: () => '9999',
      isProcessAlive: () => true,
      logger: { warn: (...a) => warnings.push(a.join(' ')), log() {}, error() {} },
    }),
  );
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /9999/);
});

test('still the tracked instance → exit code unchanged (0), so kill -INT still self-heals', () => {
  const resolveDrainExitCode = loadResolveDrainExitCode();
  assert.strictEqual(resolveDrainExitCode(deps()), 0);
});

test('stale pid file (slot pid is dead) → 0: nothing is serving, PM2 must restart us', () => {
  const resolveDrainExitCode = loadResolveDrainExitCode();
  assert.strictEqual(
    resolveDrainExitCode(deps({ readPidFile: () => '9999', isProcessAlive: () => false })),
    0,
  );
});

test('pid file missing/unreadable → 0 (PM2 unlinks it when IT stops us)', () => {
  const resolveDrainExitCode = loadResolveDrainExitCode();
  assert.strictEqual(
    resolveDrainExitCode(
      deps({
        readPidFile: () => {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        },
      }),
    ),
    0,
  );
});

test('garbage pid file / no pm_pid_path (not under PM2) → 0', () => {
  const resolveDrainExitCode = loadResolveDrainExitCode();
  assert.strictEqual(resolveDrainExitCode(deps({ readPidFile: () => 'not-a-pid' })), 0);
  assert.strictEqual(resolveDrainExitCode(deps({ readPidFile: () => '0' })), 0);
  assert.strictEqual(resolveDrainExitCode(deps({ pidPath: undefined })), 0);
});

test('a non-zero (failure) code is never masked as an intentional stop', () => {
  const resolveDrainExitCode = loadResolveDrainExitCode();
  assert.strictEqual(
    resolveDrainExitCode(
      deps({ requestedCode: 1, readPidFile: () => '9999', isProcessAlive: () => true }),
    ),
    1,
  );
});

test("the drain's injected exit wrapper routes through the guard (not a dead helper)", () => {
  // Extract the real `exit: (code) => {...}` passed to createShutdownDrain and
  // run it, proving the guard is on the live path and its verdict is what
  // reaches process.exit.
  const at = INDEX_SOURCE.indexOf('const drainThenShutdown = createShutdownDrain({');
  assert.notStrictEqual(at, -1, 'createShutdownDrain call not found in index.js');
  const arrow = 'exit: (code) => {';
  const arrowAt = INDEX_SOURCE.indexOf(arrow, at);
  assert.notStrictEqual(arrowAt, -1, "the drain's exit wrapper was not found");
  const body = sliceBalancedBlock(INDEX_SOURCE, arrowAt + arrow.length - 1);

  const exited = [];
  const closed = [];
  const wrapper = new Function(
    'closeConnection',
    'console',
    'process',
    'resolveDrainExitCode',
    `return (code) => ${body};`,
  )(
    () => closed.push('db'),
    { error() {}, warn() {}, log() {} },
    { exit: (c) => exited.push(c) },
    () => 75_75, // distinctive stub verdict: whatever the guard says must win
  );

  wrapper(0);
  assert.deepStrictEqual(closed, ['db'], 'the DB must still be closed on the way out');
  assert.deepStrictEqual(
    exited,
    [75_75],
    'the drain must exit with the code the B-24 guard returns, not the raw drain code',
  );
});

test('every ecosystem*.config.cjs declares the same sentinel in stop_exit_codes', () => {
  const sentinel = readSentinelFromIndex();
  const configs = fs
    .readdirSync(REPO_ROOT)
    // Matches both the fleet template (ecosystem.config.example.cjs, tracked)
    // and any host file (ecosystem.<node>.config.cjs — gitignored per B-110).
    .filter((f) => /^ecosystem\..*\.cjs$/.test(f));
  assert.ok(configs.length > 0, 'no ecosystem config found');

  for (const file of configs) {
    const mod = require_(path.join(REPO_ROOT, file));
    const app = (mod.apps || []).find((a) => a.name === 'nassaj-dev');
    assert.ok(app, `${file}: nassaj-dev app entry not found`);
    assert.ok(
      Array.isArray(app.stop_exit_codes),
      `${file}: stop_exit_codes missing — without it PM2 still respawns a ghost on the ` +
        'late exit of a drained orphan (B-24), and the code-side guard is dead code',
    );
    assert.ok(
      app.stop_exit_codes.includes(sentinel),
      `${file}: stop_exit_codes must include ${sentinel} (DRAIN_ORPHAN_EXIT_CODE in server/index.js)`,
    );
    assert.ok(
      !app.stop_exit_codes.includes(0),
      `${file}: 0 must NOT be in stop_exit_codes — the B-41 listen guard exits 0 on a held ` +
        'port and relies on PM2 rescheduling it',
    );
    // Guard the drain design that made B-24 possible in the first place, so a
    // future edit cannot silently flip it (B-95).
    assert.strictEqual(app.treekill, false, `${file}: treekill must stay false (ADR-021/ADR-022)`);
    assert.strictEqual(app.kill_timeout, 86400000, `${file}: kill_timeout must stay 24h (B-95)`);
  }
});
