/**
 * update.service.spawn-env.test.ts — T-1749 / ADR-159 Addendum 3, B-1097 item 2.
 *
 * The rule under test is a HOST-SAFETY rule, not a style one: `/tmp` and
 * `/dev/shm` on this host are tmpfs (RAM), and an `npm install` that stages a
 * tarball there reserves RAM until something deletes it (the 2026-07-29 OOM:
 * 2.7 GB held for 45 hours). ADR-159 Addendum 3 therefore makes `TMPDIR=/var/tmp`
 * binding for the kimi and qwen updates — and, since recovery runs the SAME npm
 * command, for the recovery path too.
 *
 * A descriptor field asserting `env: { TMPDIR: '/var/tmp' }` proves nothing on
 * its own (the classic "helper that never reaches the spawn line"). So this file
 * mocks `node:child_process` and asserts the value on the options object handed
 * to the REAL `spawn()` call — the env the npm process actually receives — by
 * driving the service's own default runner (no injected `runCommand`).
 *
 * Runner: node:test with --experimental-test-module-mocks. The mock MUST be
 * registered before the module under test is imported.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { beforeEach, mock } from 'node:test';

import * as realChildProcess from 'node:child_process';

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: { env?: NodeJS.ProcessEnv; cwd?: string };
}

const calls: SpawnCall[] = [];
/** cmd → exit codes consumed in call order (default 0). */
const exitCodes = new Map<string, number[]>();
/** cmd → stdout text (default a parseable version string). */
const stdoutFor = new Map<string, string>();
/** cmd → stdout values consumed in call order. */
const stdoutSequences = new Map<string, string[]>();

/** A minimal child stub: emits stdout then `close` on the next tick. */
function fakeSpawn(cmd: string, args: string[], opts: SpawnCall['opts']) {
  calls.push({ cmd, args: [...args], opts });
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    const gitOutput = cmd === 'git' && args[0] === 'rev-parse' ? `${'d'.repeat(40)}\n` : '';
    const out = stdoutSequences.get(cmd)?.shift()
      ?? stdoutFor.get(cmd)
      ?? (cmd === 'git' ? gitOutput : '0.42.0\n');
    if (out) child.stdout.emit('data', Buffer.from(out));
    child.emit('close', exitCodes.get(cmd)?.shift() ?? 0);
  });
  return child;
}

mock.module('node:child_process', {
  namedExports: { ...realChildProcess, spawn: fakeSpawn },
});

const { _awaitHarnessJob, _resetHarnessJobs, getHarnessUpdateJob, startHarnessUpdate } =
  await import('./update.service.js');
const { _resetHarnessLeases } = await import('./lease.js');
const { _resetLatestCache } = await import('./version-status.service.js');
const { clearHarnessRecoveryBlocked } = await import('./spawn-admission.js');
const { resolveHermesCheckoutDir, HARNESS_UPDATE_DESCRIPTORS } = await import('./descriptors.js');

beforeEach(() => {
  calls.length = 0;
  exitCodes.clear();
  stdoutFor.clear();
  stdoutSequences.clear();
  _resetHarnessLeases();
  _resetHarnessJobs();
  _resetLatestCache();
  for (const id of ['kimi', 'qwen', 'hermes']) clearHarnessRecoveryBlocked(id);
});

const deps = {
  hasLiveSession: () => false,
  hasUnregisteredLaunch: async () => false,
  pinEnabled: () => false,
  audit: () => {},
  cleanEnv: () => ({ PATH: '/usr/bin', HERMES_PATH: '/home/user/bin/hermes' }),
};

test('kimi: the npm process is spawned with TMPDIR=/var/tmp (never tmpfs)', async () => {
  const binary = HARNESS_UPDATE_DESCRIPTORS.kimi.resolveBinary(deps.cleanEnv());
  stdoutSequences.set(binary, ['0.42.0\n', '0.43.0\n']);
  const job = await startHarnessUpdate('kimi', { deps });
  await _awaitHarnessJob(job.jobId);

  const npmCalls = calls.filter((c) => c.cmd === 'npm');
  assert.equal(npmCalls.length, 1, 'the update ran exactly one npm command');
  assert.ok(npmCalls[0].args.includes('@moonshot-ai/kimi-code@latest'));
  assert.equal(
    npmCalls[0].opts.env?.TMPDIR,
    '/var/tmp',
    'the SPAWNED npm env sets TMPDIR to /var/tmp',
  );
  // The sanitized base env is still underneath it (this is a merge, not a replace).
  assert.ok(typeof npmCalls[0].opts.env?.PATH === 'string');
});

test('qwen: same TMPDIR on the spawned npm process', async () => {
  const binary = HARNESS_UPDATE_DESCRIPTORS.qwen.resolveBinary(deps.cleanEnv());
  stdoutSequences.set(binary, ['0.42.0\n', '0.43.0\n']);
  const job = await startHarnessUpdate('qwen', { deps });
  await _awaitHarnessJob(job.jobId);
  const npmCall = calls.find((c) => c.cmd === 'npm');
  assert.ok(npmCall, 'npm was spawned');
  assert.ok(npmCall!.args.includes('@qwen-code/qwen-code@latest'));
  assert.equal(npmCall!.opts.env?.TMPDIR, '/var/tmp');
});

test('the npm RECOVERY reinstall keeps TMPDIR=/var/tmp too', async () => {
  const binary = HARNESS_UPDATE_DESCRIPTORS.kimi.resolveBinary(deps.cleanEnv());
  stdoutSequences.set(binary, ['0.42.0\n', '0.42.0\n']);
  exitCodes.set('npm', [1, 0]); // update fails, then exact-version recovery succeeds
  const job = await startHarnessUpdate('kimi', { deps });
  await _awaitHarnessJob(job.jobId);

  const npmCalls = calls.filter((c) => c.cmd === 'npm');
  assert.equal(npmCalls.length, 2, 'update + recovery');
  assert.ok(npmCalls[1].args.includes('@moonshot-ai/kimi-code@0.42.0'), 'recovery pins the captured version');
  assert.equal(npmCalls[1].opts.env?.TMPDIR, '/var/tmp', 'recovery spawns under /var/tmp as well');
  assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'update_failed');
});

test('hermes: `hermes update` runs in the checkout with HERMES_HOME isolation', async () => {
  const job = await startHarnessUpdate('hermes', { deps });
  await _awaitHarnessJob(job.jobId);

  const checkout = resolveHermesCheckoutDir();
  const revParse = calls.find((c) => c.cmd === 'git' && c.args[0] === 'rev-parse');
  assert.ok(revParse, 'the pre-update revision is captured before the update');
  assert.equal(revParse!.opts.cwd, checkout);

  const update = calls.find((c) => c.args[0] === 'update');
  assert.ok(update, 'the hermes updater was spawned');
  assert.deepEqual(update!.args, ['update', '--yes']);
  assert.equal(update!.opts.cwd, checkout, 'it runs INSIDE the git checkout');
  assert.ok(
    typeof update!.opts.env?.HERMES_HOME === 'string' && update!.opts.env.HERMES_HOME.endsWith('/.hermes'),
    'HERMES_HOME isolation reaches the spawned updater',
  );
});

test('hermes failure rolls the checkout back to the captured revision', async () => {
  {
    const hermesBin = HARNESS_UPDATE_DESCRIPTORS.hermes.resolveBinary(deps.cleanEnv());
    exitCodes.set(hermesBin, [1]); // `hermes update` fails

    const job = await startHarnessUpdate('hermes', { deps });
    await _awaitHarnessJob(job.jobId);

    const checkout = resolveHermesCheckoutDir();
    const reset = calls.find((c) => c.cmd === 'git' && c.args[0] === 'reset');
    assert.ok(reset, 'recovery ran git reset --hard');
    assert.deepEqual(reset!.args, ['reset', '--hard', 'd'.repeat(40)]);
    assert.equal(reset!.opts.cwd, checkout);

    const reinstall = calls.find((c) => c.args[0] === 'pip');
    assert.ok(reinstall, 'recovery reinstalled the venv with uv');
    assert.deepEqual(reinstall!.args.slice(0, 2), ['pip', 'install']);
    assert.equal(reinstall!.opts.cwd, checkout);
    assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'failed');
  }
});
