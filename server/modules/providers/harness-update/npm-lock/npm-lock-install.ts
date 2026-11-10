/**
 * npm-lock install / update / rollback of a reviewed pin (T-2086 S4, ADR-224).
 *
 * Install of `<v>` (owner install and update share it):
 *   1. preflight: absolute node >= the pin's floor (the S2 resolver), the npm
 *      CLI beside that node, free space >= minFreeBytes in HOME and /var/tmp;
 *   2. the reviewed package.json + package-lock.json go into
 *      `versions/.staging-<v>`; `node npm-cli.js ci --ignore-scripts` runs there
 *      with TMPDIR=/var/tmp, HOME and `--cache` in a private /var/tmp job dir
 *      (deleted afterwards);
 *   3. the staged tree must match the committed full-tree manifest, else it is
 *      deleted (`verify_failed`); then it is renamed to `versions/<v>`;
 *   4. the launcher link is swapped atomically; `dsh --version` must equal
 *      `<v>`, else the previous link is restored;
 *   5. retention keeps the current version plus the newest other one.
 *
 * Nothing here takes a lease or a gate: the callers (install.service,
 * update.service, rollback.service) hold the harness lease around it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveDshNode } from '../../list/dsh/dsh-launch.js';
import { parseVersionOutput } from '../descriptors.js';
import type { RunCommandOptions } from '../run-command.js';
import type { RunResult } from '../update-jobs.js';

import { npmLockHostDeps } from './npm-lock-source.js';
import {
  currentVersion,
  entryPath,
  isReviewedVersion,
  keptVersions,
  loadPin,
  npmLockCiArgv,
  NpmLockError,
  stagingDir,
  targetPin,
  versionDir,
  versionsDir,
  type NpmLockInstallSource,
} from './pins.js';
import { recordTreeVerdict, verifyVersionTree } from './trust.js';
import { verifyTreeManifest } from './tree-manifest.js';

export { _setNpmLockTestDeps } from './npm-lock-source.js';

/** Prefix of the private /var/tmp job dir (boot orphan cleanup removes it). */
const JOB_DIR_PREFIX = 'nassaj-harness-install-';

/** What one npm-lock flow reaches outside its own logic. */
export interface NpmLockContext {
  home: string;
  runCommand: (cmd: string, args: string[], opts: RunCommandOptions) => Promise<RunResult>;
  runVersion: (cmd: string, args: string[]) => Promise<string | null>;
  /** The installer child env (allow-list; HOME/TMPDIR/PATH are overridden here). */
  buildEnv: (home: string) => NodeJS.ProcessEnv;
  /** Parent of the private job dir (always /var/tmp in production). */
  stagingParent: string;
  log: (line: string) => void;
  onLine?: (line: string) => void;
}

/** Result of a version switch. */
export interface NpmLockSwitch {
  fromVersion: string | null;
  toVersion: string;
  pruned: string[];
}

/** The verified node + npm CLI that run the install. */
function preflight(source: NpmLockInstallSource, ctx: NpmLockContext): { node: string; npmCli: string } {
  const host = npmLockHostDeps();
  let node: string;
  try {
    node = resolveDshNode(host.nodeRuntime());
  } catch {
    throw new NpmLockError('node_unsupported', 'node_below_minimum');
  }
  for (const dir of [ctx.home, ctx.stagingParent]) {
    let free: number;
    try {
      free = host.freeBytes(dir);
    } catch {
      throw new NpmLockError('insufficient_space', 'free_space_unreadable');
    }
    if (free < source.minFreeBytes) throw new NpmLockError('insufficient_space', 'below_minimum');
  }
  const { args } = npmLockCiArgv(node, '');
  if (!fs.statSync(args[0], { throwIfNoEntry: false })?.isFile()) {
    throw new NpmLockError('install_failed', 'npm_unavailable');
  }
  return { node, npmCli: args[0] };
}

/** Creates `dir` (and missing parents, 0755) and refuses a symlink or foreign owner. */
function ensureOwnedDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid?.()) {
    throw new NpmLockError('install_failed', 'install_dir_unsafe');
  }
}

/** Removes a tree this flow owns. */
function removeTree(dir: string): void {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
}

/** Runs `npm ci` of the staged lock under a private /var/tmp HOME + cache. */
async function runNpmCi(source: NpmLockInstallSource, ctx: NpmLockContext, node: string, cwd: string): Promise<void> {
  const jobDir = fs.mkdtempSync(path.join(ctx.stagingParent, JOB_DIR_PREFIX));
  try {
    fs.chmodSync(jobDir, 0o700);
    const cache = path.join(jobDir, 'cache');
    const argv = npmLockCiArgv(node, cache);
    ctx.log(`Running npm ci of the reviewed lock (${source.pkg}).`);
    const env = {
      ...ctx.buildEnv(jobDir),
      HOME: jobDir,
      TMPDIR: '/var/tmp',
      PATH: `${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
    };
    const result = await ctx.runCommand(argv.cmd, argv.args, { env, cwd, timeoutMs: source.timeoutMs, onLine: ctx.onLine });
    if (result.timedOut) throw new NpmLockError('install_timeout', 'timeout');
    if (result.code !== 0) throw new NpmLockError('install_failed', 'nonzero_exit');
  } finally {
    removeTree(jobDir);
  }
}

/** Steps 1–3: the verified tree of `version` exists at `versions/<v>`. */
async function placePin(source: NpmLockInstallSource, ctx: NpmLockContext, version: string): Promise<void> {
  const pin = loadPin(source, version);
  const { node } = preflight(source, ctx);
  ensureOwnedDir(versionsDir(source, ctx.home));
  const final = versionDir(source, ctx.home, version);
  if (fs.existsSync(final)) {
    if ((await verifyVersionTree(source, ctx.home, version)) === 'verified') {
      ctx.log(`${source.pkg} ${version} is already on disk and matches its manifest.`);
      return;
    }
    removeTree(final);
  }
  const staging = stagingDir(source, ctx.home, version);
  removeTree(staging);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(staging, 'package.json'), pin.packageJson, { flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'package-lock.json'), pin.lock, { flag: 'wx' });
    await runNpmCi(source, ctx, node, staging);
    const verdict = await verifyTreeManifest(staging, pin.manifest);
    if (!verdict.ok) {
      ctx.log(`The installed tree does not match the reviewed manifest (${verdict.changedPackages.join(', ') || 'tree'}).`);
      throw new NpmLockError('verify_failed', 'tree_mismatch');
    }
    fs.chmodSync(staging, 0o755);
    fs.renameSync(staging, final);
    recordTreeVerdict(final, 'verified');
    ctx.log(`Tree verified: ${pin.manifest.fileCount} files match the reviewed manifest.`);
  } finally {
    removeTree(staging);
  }
}

/** Atomically points the launcher at `version`'s entry (absolute symlink). */
function switchLauncher(source: NpmLockInstallSource, home: string, version: string): void {
  const launcher = source.launcher(home);
  ensureOwnedDir(path.dirname(launcher));
  const tmp = `${launcher}.nassaj-${process.pid}-${Date.now()}`;
  fs.symlinkSync(entryPath(source, home, version), tmp);
  fs.renameSync(tmp, launcher);
}

/** Step 4 proof: link literally at `version`, and `dsh --version` says `version`. */
async function assertActive(source: NpmLockInstallSource, ctx: NpmLockContext, version: string): Promise<void> {
  if (currentVersion(source, ctx.home) !== version) throw new NpmLockError('verify_failed', 'launcher_mismatch');
  const read = parseVersionOutput(await ctx.runVersion(source.launcher(ctx.home), ['--version']));
  if (read !== version) throw new NpmLockError('verify_failed', 'version_mismatch');
}

/** Switches to `version` and proves it; on failure restores `previous` (or removes the link). */
async function activate(source: NpmLockInstallSource, ctx: NpmLockContext, version: string): Promise<NpmLockSwitch> {
  const previous = currentVersion(source, ctx.home);
  switchLauncher(source, ctx.home, version);
  try {
    await assertActive(source, ctx, version);
  } catch (error) {
    if (previous) {
      switchLauncher(source, ctx.home, previous);
      await assertActive(source, ctx, previous).catch(() => {
        throw new NpmLockError('recovery_failed', 'previous_unverified');
      });
      ctx.log(`Restored ${source.pkg} ${previous}.`);
    } else {
      fs.rmSync(source.launcher(ctx.home), { force: true });
    }
    throw error;
  }
  return { fromVersion: previous, toVersion: version, pruned: prune(source, ctx.home, version) };
}

/** Step 5: keeps `current` plus the newest other version; returns removed versions. */
function prune(source: NpmLockInstallSource, home: string, current: string): string[] {
  const others = keptVersions(source, home).filter((v) => v !== current);
  const removed = others.slice(Math.max(0, source.keepVersions - 1));
  for (const v of removed) removeTree(versionDir(source, home, v));
  return removed;
}

/** Install or update to the reviewed target pin; a no-op when it is already active. */
export async function installNpmLockTarget(source: NpmLockInstallSource, ctx: NpmLockContext): Promise<NpmLockSwitch> {
  const version = targetPin(source);
  const current = currentVersion(source, ctx.home);
  await placePin(source, ctx, version);
  if (current === version) {
    await assertActive(source, ctx, version);
    return { fromVersion: current, toVersion: version, pruned: prune(source, ctx.home, version) };
  }
  return activate(source, ctx, version);
}

/** The kept version a rollback would restore (newest non-current reviewed one), or null. */
export function rollbackCandidate(source: NpmLockInstallSource, home: string): string | null {
  const current = currentVersion(source, home);
  return keptVersions(source, home).find((v) => v !== current && isReviewedVersion(source, home, v)) ?? null;
}

/** Rollback to the kept previous version after a full re-check of its tree. */
export async function rollbackNpmLock(source: NpmLockInstallSource, ctx: NpmLockContext): Promise<NpmLockSwitch> {
  const target = rollbackCandidate(source, ctx.home);
  if (!target) throw new NpmLockError('no_previous_version', 'nothing_kept');
  if ((await verifyVersionTree(source, ctx.home, target)) !== 'verified') {
    throw new NpmLockError('verify_failed', 'previous_tree_tampered');
  }
  return activate(source, ctx, target);
}
