/**
 * dsh install acceptance (T-2086 S4, ADR-224), in the owner's terms:
 *
 *   "I install DeepSeek Harness from Settings → the indicator shows the pinned
 *    version, equal to `dsh --version`; updating to a newer reviewed pin works;
 *    rollback restores the previous version; a tampered file in the install
 *    tree is detected and the launch refused; the install refuses clearly when
 *    node < 24.9 or free disk < 3 GB."
 *
 * The real install/update/rollback services run against a sandbox HOME under
 * /var/tmp. Only `npm ci` is faked: it materialises a small fixture tree that
 * matches its committed-style tree manifest, so every byte check is real. The
 * launcher is a real Node script, so `dsh --version` is a real exec.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { assertDshTreeTrusted, DSH_LAUNCH_ERROR } from '../../list/dsh/dsh-launch.js';
import { HARNESS_INSTALL_SOURCES } from '../install-sources.js';
import { _resetInstallSlot, _setInstallTestDeps, startHarnessInstall } from '../install.service.js';
import { _resetHarnessLeases } from '../lease.js';
import { listHarnessSnapshots, startManualRollback } from '../rollback.service.js';
import type { RecoveryFence } from '../snapshot-runtime.js';
import { _awaitHarnessJob, _resetHarnessJobs, getHarnessUpdateJob, type RunResult } from '../update-jobs.js';
import { startHarnessUpdate } from '../update.service.js';
import { _resetLatestCache, getHarnessVersionStatus, invalidateInstalledVersion } from '../version-status.service.js';

import { DSH_NPM_LOCK_SOURCE, type NpmLockInstallSource } from './pins.js';
import { _resetNpmLockTrust, verifyNpmLockTreesAtBoot } from './trust.js';
import { _setNpmLockTestDeps } from './npm-lock-install.js';
import { buildPinManifest } from './tree-manifest.js';

const PKG = '@deepseek-ai/dsh';
const BIN_REL = 'node_modules/@deepseek-ai/dsh/lib/bin.js';
const GB = 1024 ** 3;
const LAUNCHER = path.join(SANDBOX_HOME, '.local', 'bin', 'dsh');
const VERSIONS = path.join(SANDBOX_HOME, '.local', 'share', 'dsh', 'versions');
const OK: RunResult = { code: 0, stdout: 'added 2 packages', stderr: '', timedOut: false };

const scratch = fs.mkdtempSync(path.join('/var/tmp', 'dsh-s4-acceptance-'));
const lockRoot = path.join(scratch, 'locks');
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

/** package.json + package-lock.json of a fixture pin. */
function pinFiles(version: string): { packageJson: string; lock: string } {
  const packageJson = `${JSON.stringify({ name: 'nassaj-dsh-pin', private: true, version: '0.0.0',
    dependencies: { [PKG]: version } }, null, 2)}\n`;
  const lock = `${JSON.stringify({ name: 'nassaj-dsh-pin', version: '0.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { dependencies: { [PKG]: version } }, [`node_modules/${PKG}`]: { version, license: 'MIT' } } },
  null, 2)}\n`;
  return { packageJson, lock };
}

/** What `npm ci` leaves in `dir` for the fixture pin `version`. */
function materialize(dir: string, version: string): void {
  const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version, bin: { dsh: 'lib/bin.js' } }));
  fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), `#!/usr/bin/env node\nconsole.log('${version}');\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}\n');
}

/** Writes a reviewed fixture pin (lock + manifest) under `lockRoot/<version>`. */
async function reviewPin(version: string): Promise<void> {
  const dir = path.join(lockRoot, version);
  const { packageJson, lock } = pinFiles(version);
  const probe = path.join(scratch, `probe-${version}`);
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'package.json'), packageJson);
  fs.writeFileSync(path.join(probe, 'package-lock.json'), lock);
  materialize(probe, version);
  const manifest = await buildPinManifest({ harness: 'dsh', pkg: PKG, binRel: BIN_REL, installedDir: probe, lockBytes: Buffer.from(lock) });
  fs.rmSync(probe, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), packageJson);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), lock);
  fs.writeFileSync(path.join(dir, 'tree-manifest.json'), JSON.stringify(manifest));
}

const npmCalls: { args: string[]; cwd?: string; env: NodeJS.ProcessEnv }[] = [];

/** Fake `node npm-cli.js ci …`: materialises the pin named by cwd/package.json. */
async function fakeNpm(_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string }): Promise<RunResult> {
  npmCalls.push({ args, cwd: opts.cwd, env: opts.env });
  if (!args.includes('ci') || !opts.cwd) return { code: 1, stdout: '', stderr: 'unexpected', timedOut: false };
  const wanted = JSON.parse(fs.readFileSync(path.join(opts.cwd, 'package.json'), 'utf8')).dependencies[PKG];
  materialize(opts.cwd, wanted);
  return OK;
}

let pins: string[] = [];
let node = { execPath: process.execPath, version: '24.18.1' };
let free = 10 * GB;
const fenceSet = new Set<string>();
const fence: RecoveryFence = {
  mark: (h) => { fenceSet.add(h); },
  clear: (h) => { fenceSet.delete(h); },
  isSet: (h) => fenceSet.has(h),
};
const noLive = { hasLiveSession: () => false, hasUnregisteredLaunch: async () => null };

function source(): NpmLockInstallSource {
  return { ...DSH_NPM_LOCK_SOURCE, reviewedPins: Object.freeze([...pins]), lockRoot: () => lockRoot };
}

function wire(): void {
  const src = source();
  _setNpmLockTestDeps({ source: src, nodeRuntime: () => node, freeBytes: () => free });
  _setInstallTestDeps({
    home: () => SANDBOX_HOME,
    isPlatform: () => false,
    serverEnv: () => ({}),
    stagingParent: scratch,
    audit: () => {},
    cleanEnv: () => ({ PATH: process.env.PATH }),
    runCommand: fakeNpm,
    freeBytes: () => free,
    sources: { ...HARNESS_INSTALL_SOURCES, dsh: src },
  });
}

/** The real `dsh --version` of the terminal launcher. */
const dshVersion = () => execFileSync(LAUNCHER, ['--version'], { encoding: 'utf8' }).trim();

async function installFromSettings(): Promise<ReturnType<typeof getHarnessUpdateJob>> {
  const job = startHarnessInstall('dsh', { userId: 1 });
  await job.done;
  return getHarnessUpdateJob(job.jobId);
}

async function updateFromSettings(): Promise<ReturnType<typeof getHarnessUpdateJob>> {
  const job = await startHarnessUpdate('dsh', {
    userId: 1, trigger: 'manual',
    deps: { runCommand: fakeNpm, ...noLive, audit: () => {}, markRecoveryIntent: fence.mark, clearRecoveryIntent: fence.clear },
  });
  await _awaitHarnessJob(job.jobId);
  return getHarnessUpdateJob(job.jobId);
}

function resetWorld(): void {
  fs.rmSync(path.join(SANDBOX_HOME, '.local'), { recursive: true, force: true, maxRetries: 2 });
  for (const dir of fs.existsSync(VERSIONS) ? fs.readdirSync(VERSIONS) : []) fs.chmodSync(path.join(VERSIONS, dir), 0o755);
  _resetHarnessJobs();
  _resetHarnessLeases();
  _resetInstallSlot();
  _resetNpmLockTrust();
  _resetLatestCache();
  invalidateInstalledVersion();
  fenceSet.clear();
  npmCalls.length = 0;
  pins = ['1.0.0'];
  node = { execPath: process.execPath, version: '24.18.1' };
  free = 10 * GB;
  wire();
}

beforeEach(async () => {
  for (const v of ['1.0.0', '1.1.0', '1.2.0']) if (!fs.existsSync(path.join(lockRoot, v))) await reviewPin(v);
  resetWorld();
});

afterEach(() => {
  _setInstallTestDeps(null);
  _setNpmLockTestDeps(null);
});

describe('owner installs DeepSeek Harness from Settings', () => {
  test('the indicator shows the pinned version, equal to `dsh --version`', async () => {
    const job = await installFromSettings();
    assert.equal(job?.status, 'succeeded', JSON.stringify(job?.error));
    assert.equal(job?.toVersion, '1.0.0');
    assert.equal(dshVersion(), '1.0.0');
    const status = await getHarnessVersionStatus('dsh');
    assert.equal(status?.installedVersion, dshVersion());
    assert.equal(status?.latestVersion, '1.0.0', 'the target is the reviewed pin, never npm latest');
    assert.equal(status?.upToDate, true);
    assert.equal(status?.manualOnly, true);
    // One copy: the terminal launcher is the managed tree's entry.
    assert.equal(fs.realpathSync(LAUNCHER), fs.realpathSync(path.join(VERSIONS, '1.0.0', BIN_REL)));
    // npm ci of the reviewed lock, scripts off, cache and TMPDIR under /var/tmp.
    const ci = npmCalls.at(-1);
    assert.ok(ci?.args.includes('ci') && ci.args.includes('--ignore-scripts'), JSON.stringify(ci?.args));
    assert.equal(ci?.env.TMPDIR, '/var/tmp');
    const cache = ci?.args[ci.args.indexOf('--cache') + 1] ?? '';
    assert.ok(cache.startsWith('/var/tmp/') || cache.startsWith(`${scratch}/`), cache);
    assert.equal(fs.existsSync(cache), false, 'the npm cache is deleted after the install');
  });

  test('updating to a newer reviewed pin works', async () => {
    assert.equal((await installFromSettings())?.status, 'succeeded');
    pins = ['1.0.0', '1.1.0'];
    wire();
    invalidateInstalledVersion();
    const before = await getHarnessVersionStatus('dsh');
    assert.equal(before?.upToDate, false);
    const job = await updateFromSettings();
    assert.equal(job?.status, 'succeeded', JSON.stringify(job?.error));
    assert.equal(job?.fromVersion, '1.0.0');
    assert.equal(job?.toVersion, '1.1.0');
    assert.equal(dshVersion(), '1.1.0');
    assert.equal(fenceSet.size, 0, 'the recovery fence is cleared after a verified switch');
  });

  test('rollback restores the previous version; two versions are kept', async () => {
    await installFromSettings();
    pins = ['1.0.0', '1.1.0'];
    wire();
    await updateFromSettings();
    const offers = listHarnessSnapshots('dsh');
    assert.equal(offers.length, 1);
    assert.equal(offers[0].fromVersion, '1.0.0');
    const job = await startManualRollback(
      { harness: 'dsh', jobId: offers[0].jobId, scope: 'binary', acks: undefined, userId: 1 },
      { ...noLive, fence, audit: () => {} },
    );
    await _awaitHarnessJob(job.jobId);
    assert.equal(getHarnessUpdateJob(job.jobId)?.status, 'succeeded', JSON.stringify(getHarnessUpdateJob(job.jobId)?.error));
    assert.equal(dshVersion(), '1.0.0');
    // A third pin prunes the oldest: current + one previous remain.
    pins = ['1.0.0', '1.1.0', '1.2.0'];
    wire();
    assert.equal((await updateFromSettings())?.status, 'succeeded');
    assert.equal(dshVersion(), '1.2.0');
    assert.equal(fs.readdirSync(VERSIONS).filter((n) => !n.startsWith('.')).length, 2);
  });

  test('a tampered file in the install tree is detected and the launch refused', async () => {
    await installFromSettings();
    assert.doesNotThrow(() => assertDshTreeTrusted(LAUNCHER, { serverEnv: {} }));
    const pkgJson = path.join(VERSIONS, '1.0.0', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    fs.chmodSync(path.dirname(pkgJson), 0o755);
    fs.chmodSync(pkgJson, 0o644);
    fs.appendFileSync(pkgJson, ' ');
    _resetNpmLockTrust();
    await verifyNpmLockTreesAtBoot();
    assert.throws(() => assertDshTreeTrusted(LAUNCHER, { serverEnv: {} }), { code: DSH_LAUNCH_ERROR.TREE_TAMPERED });
  });

  test('a node_modules file edited after the boot check is refused on the next launch (no restart)', async () => {
    await installFromSettings();
    _resetNpmLockTrust();
    await verifyNpmLockTreesAtBoot();
    assert.doesNotThrow(() => assertDshTreeTrusted(LAUNCHER, { serverEnv: {} }));
    const pkgJson = path.join(VERSIONS, '1.0.0', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    fs.chmodSync(path.dirname(pkgJson), 0o755);
    fs.chmodSync(pkgJson, 0o644);
    fs.appendFileSync(pkgJson, ' ');
    assert.throws(() => assertDshTreeTrusted(LAUNCHER, { serverEnv: {} }), { code: DSH_LAUNCH_ERROR.TREE_TAMPERED });
  });

  test('a file planted in the tree after the boot check is refused on the next launch', async () => {
    await installFromSettings();
    _resetNpmLockTrust();
    await verifyNpmLockTreesAtBoot();
    const dir = path.join(VERSIONS, '1.0.0', 'node_modules', '@deepseek-ai', 'dsh');
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'planted.js'), 'process.exit(0)\n');
    assert.throws(() => assertDshTreeTrusted(LAUNCHER, { serverEnv: {} }), { code: DSH_LAUNCH_ERROR.TREE_TAMPERED });
  });

  test('the DSH_PATH operator override is never silent: boot warning and version status say so', async () => {
    const { warnDshPathOverride } = await import('../../list/dsh/dsh-launch.js');
    const warnings: unknown[][] = [];
    assert.equal(warnDshPathOverride((...args) => warnings.push(args), {}), false);
    assert.equal(warnings.length, 0);
    assert.equal(warnDshPathOverride((...args) => warnings.push(args), { DSH_PATH: LAUNCHER }), true);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /DSH_PATH/);
    assert.equal(JSON.stringify(warnings).includes(LAUNCHER), false, 'the override path is not logged');
    await installFromSettings();
    invalidateInstalledVersion();
    assert.equal((await getHarnessVersionStatus('dsh', { serverEnv: {} }))?.operatorOverride, undefined);
    invalidateInstalledVersion();
    const status = await getHarnessVersionStatus('dsh', { serverEnv: { DSH_PATH: LAUNCHER } });
    assert.deepEqual(status?.operatorOverride, { env: 'DSH_PATH', treeCheckSkipped: true });
  });

  test('an edited launch entry is refused on the very next launch (cheap check)', async () => {
    await installFromSettings();
    const entry = path.join(VERSIONS, '1.0.0', BIN_REL);
    fs.chmodSync(path.dirname(entry), 0o755);
    fs.chmodSync(entry, 0o755);
    fs.appendFileSync(entry, '// planted\n');
    assert.throws(() => assertDshTreeTrusted(LAUNCHER, { serverEnv: {} }), { code: DSH_LAUNCH_ERROR.TREE_TAMPERED });
  });

  test('after a restart a launch waits for the boot check (fail-closed), then passes', async () => {
    await installFromSettings();
    _resetNpmLockTrust();
    assert.throws(() => assertDshTreeTrusted(LAUNCHER, { serverEnv: {} }), { code: DSH_LAUNCH_ERROR.TREE_UNVERIFIED });
    await verifyNpmLockTreesAtBoot();
    assert.doesNotThrow(() => assertDshTreeTrusted(LAUNCHER, { serverEnv: {} }));
  });

  test('a copy Nassaj did not install is refused; the DSH_PATH operator override is the operator\'s choice', () => {
    fs.mkdirSync(path.dirname(LAUNCHER), { recursive: true });
    fs.writeFileSync(LAUNCHER, '#!/usr/bin/env node\nconsole.log("9.9.9")\n', { mode: 0o755 });
    assert.throws(() => assertDshTreeTrusted(LAUNCHER, { serverEnv: {} }), { code: DSH_LAUNCH_ERROR.TREE_UNMANAGED });
    assert.doesNotThrow(() => assertDshTreeTrusted(LAUNCHER, { serverEnv: { DSH_PATH: LAUNCHER } }));
  });

  test('install refuses clearly when node < 24.9', async () => {
    node = { execPath: process.execPath, version: '24.8.0' };
    wire();
    const job = await installFromSettings();
    assert.equal(job?.status, 'failed');
    assert.equal(job?.error?.code, 'node_unsupported');
    assert.equal(npmCalls.length, 0);
    assert.equal(fs.existsSync(LAUNCHER), false);
  });

  test('install refuses clearly when free disk < 3 GB', async () => {
    free = 2 * GB;
    wire();
    const job = await installFromSettings();
    assert.equal(job?.status, 'failed');
    assert.equal(job?.error?.code, 'insufficient_space');
    assert.equal(npmCalls.length, 0);
    assert.equal(fs.existsSync(LAUNCHER), false);
  });
});
