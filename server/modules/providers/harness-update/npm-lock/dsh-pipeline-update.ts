/**
 * The owner's dsh update through the staged, auto-verified pipeline (T-2091, ADR-225).
 * The button never installs a tag: the candidate is the newest EXACT version on the
 * installed channel (prereleases only while the active version is one), read from the
 * registry; the pipeline then stages, contract-checks and switches it — or holds it.
 * A first install (no active version), or a newer pin reviewed in the release itself, keeps the
 * reviewed repo pin path (npm-lock-install).
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveDshNode } from '../../list/dsh/dsh-launch.js';

import { installDshCandidate } from './dsh-candidate-install.js';
import { runDshContractSuite } from './dsh-contract-run.js';
import { createDshUpdatePipeline } from './dsh-update-pipeline.js';
import type { NpmLockContext, NpmLockSwitch } from './npm-lock-install.js';
import { installNpmLockTarget } from './npm-lock-install.js';
import { npmLockHostDeps } from './npm-lock-source.js';
import { verifyVersionTree } from './trust.js';
import { currentVersion, loadPin, npmCliBesideNode, NpmLockError, targetPin, type NpmLockInstallSource } from './pins.js';

const EXACT = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/u;

/** semver order (prerelease before its release). */
export function compareVersions(a: string, b: string): number {
  const x = EXACT.exec(a);
  const y = EXACT.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i += 1) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return x[4] < y[4] ? -1 : 1;
}

/** The newest version above `current` on its channel, or null. */
export function pickDshCandidate(current: string, published: readonly string[]): string | null {
  const prerelease = current.includes('-');
  const eligible = published.filter((v) => EXACT.test(v) && (prerelease || !v.includes('-')) && compareVersions(v, current) > 0);
  return eligible.sort(compareVersions).at(-1) ?? null;
}

/** The pipeline for this host's dsh install (state under the install root, not tmpfs, not a member tree). */
export function dshUpdatePipeline(source: NpmLockInstallSource, home: string, ctx: Pick<NpmLockContext, 'runCommand' | 'buildEnv'>) {
  const node = resolveDshNode(npmLockHostDeps().nodeRuntime());
  let estimate = 750 * 1024 ** 2;
  try { estimate = loadPin(source, targetPin(source)).manifest.totalBytes; } catch { /* default */ }
  return createDshUpdatePipeline({
    root: source.installRoot(home), activeLink: source.launcher(home), binRel: source.binRel,
    initialActive: currentVersion(source, home), estimatedTreeBytes: estimate,
    freeBytes: (dir: string) => npmLockHostDeps().freeBytes(dir),
    install: (job) => installDshCandidate(job, { node, runCommand: ctx.runCommand, buildEnv: ctx.buildEnv }),
    contractSuite: (job) => runDshContractSuite(job, { node, workRoot: path.dirname(job.dir) }),
    publishedAt: (version: string) => registryPublishedAt(source, ctx, version),
    verifySignatures: (job) => auditSignatures(node, ctx, job.dir),
  });
}

/** npm against a private cache dir under `parent` (deleted after); resolves to the RunResult. */
async function npmIn(node: string, ctx: Pick<NpmLockContext, 'runCommand' | 'buildEnv'>, parent: string, args: string[], cwd?: string) {
  const job = fs.mkdtempSync(path.join(parent, 'nassaj-dsh-npm-'));
  try {
    return await ctx.runCommand(node, [npmCliBesideNode(node), ...args, '--cache', path.join(job, 'cache'), '--no-update-notifier'],
      { env: { ...ctx.buildEnv(job), HOME: job, TMPDIR: job }, ...(cwd ? { cwd } : {}), timeoutMs: 180000 });
  } finally {
    fs.rmSync(job, { recursive: true, force: true });
  }
}

/** qa I2: when `version` was published (registry `time`), or null. */
export async function registryPublishedAt(source: NpmLockInstallSource, ctx: Pick<NpmLockContext, 'runCommand' | 'buildEnv'>, version: string) {
  const node = resolveDshNode(npmLockHostDeps().nodeRuntime());
  const result = await npmIn(node, ctx, source.installRoot(npmLockHome(ctx)), ['view', source.pkg, 'time', '--json']);
  if (result.code !== 0) return null;
  try {
    const time = JSON.parse(result.stdout);
    return typeof time?.[version] === 'string' ? time[version] : null;
  } catch {
    return null;
  }
}

/** qa I2: `npm audit signatures` of the staged tree (registry signatures and provenance). */
export async function auditSignatures(node: string, ctx: Pick<NpmLockContext, 'runCommand' | 'buildEnv'>, dir: string) {
  const result = await npmIn(node, ctx, path.dirname(dir), ['audit', 'signatures'], dir);
  return { ok: result.code === 0 };
}

const npmLockHome = (ctx: Pick<NpmLockContext, 'runCommand' | 'buildEnv'>) => (ctx as Partial<NpmLockContext>).home ?? process.env.HOME ?? '/';

/** The owner's explicit retry of a held dsh candidate (the update control's server action). */
export function clearDshUpdateHold(home: string, version?: string): boolean {
  const source = npmLockHostDeps().source;
  const refuse = async () => { throw new Error('clear only'); };
  return createDshUpdatePipeline({ root: source.installRoot(home), activeLink: source.launcher(home), binRel: source.binRel,
    install: refuse, contractSuite: refuse, freeBytes: () => 0 }).clearHold({ version });
}

/** Boot: sweep a crashed run's staging and correct a stale `checking` status (qa I4). Never throws. */
export function recoverDshUpdatePipeline(home: string): void {
  try {
    const source = npmLockHostDeps().source;
    if (!fs.existsSync(path.join(source.installRoot(home), 'update-state.json'))) return;
    const refuse = async () => { throw new Error('recover only'); };
    createDshUpdatePipeline({ root: source.installRoot(home), activeLink: source.launcher(home), binRel: source.binRel,
      install: refuse, contractSuite: refuse, freeBytes: () => 0 }).recover();
  } catch (error) {
    console.warn('[dsh] update pipeline recovery skipped', { error: String((error as Error)?.message ?? error).slice(0, 200) });
  }
}

/** Published versions of the package (`npm view <pkg> versions --json`, private cache). */
async function publishedVersions(source: NpmLockInstallSource, ctx: NpmLockContext): Promise<string[]> {
  const node = resolveDshNode(npmLockHostDeps().nodeRuntime());
  const job = fs.mkdtempSync(path.join(ctx.stagingParent, 'nassaj-dsh-view-'));
  try {
    const result = await ctx.runCommand(node, [npmCliBesideNode(node), 'view', source.pkg, 'versions', '--json', '--cache',
      path.join(job, 'cache'), '--no-update-notifier'], { env: { ...ctx.buildEnv(job), HOME: job, TMPDIR: '/var/tmp' }, timeoutMs: 120000 });
    if (result.code !== 0) throw new NpmLockError('dsh_update_registry_unavailable', 'npm_view_failed');
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    if (error instanceof NpmLockError) throw error;
    throw new NpmLockError('dsh_update_registry_unavailable', 'npm_view_unreadable');
  } finally {
    fs.rmSync(job, { recursive: true, force: true });
  }
}

/**
 * A live launch on the active version failed a capability probe: right after a pipeline switch
 * this rolls back to the previous version and holds the candidate (no flapping). Never throws.
 */
export async function reportDshLaunchCapability(code: string, home: string, serverEnv: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if ((serverEnv.DSH_PATH ?? '').trim() !== '') return false;
  try {
    const source = npmLockHostDeps().source;
    const version = currentVersion(source, home);
    if (!version) return false;
    const refuse = async () => { throw new Error('report only'); };
    const pipeline = createDshUpdatePipeline({ root: source.installRoot(home), activeLink: source.launcher(home), binRel: source.binRel,
      install: refuse, contractSuite: refuse, freeBytes: () => 0 });
    const rolledBack = await pipeline.reportLaunchCapabilityFailure({ version, code });
    if (rolledBack) console.warn('[dsh] update rolled back after a failed capability probe', { version, code });
    return rolledBack;
  } catch {
    return false;
  }
}

/** A live launch passed its handshake: ends `switched` and resets the channel counter. Never throws. */
export function reportDshLaunchSuccess(home: string, serverEnv: NodeJS.ProcessEnv = process.env): void {
  if ((serverEnv.DSH_PATH ?? '').trim() !== '') return;
  try {
    const source = npmLockHostDeps().source;
    const version = currentVersion(source, home);
    if (!version || !fs.existsSync(path.join(source.installRoot(home), 'update-state.json'))) return;
    const refuse = async () => { throw new Error('report only'); };
    createDshUpdatePipeline({ root: source.installRoot(home), activeLink: source.launcher(home), binRel: source.binRel,
      install: refuse, contractSuite: refuse, freeBytes: () => 0 }).reportLaunchSuccess({ version });
  } catch {
    /* status only */
  }
}

/** The pipeline status for version-status (installed | checking | held | switched | rolled_back). */
export function dshIntegrationStatus(home: string): { state: string; code: string | null; candidateVersion: string | null;
  clearable: boolean } | null {
  try {
    const file = path.join(npmLockHostDeps().source.installRoot(home), 'update-state.json');
    const status = JSON.parse(fs.readFileSync(file, 'utf8'))?.status;
    if (!status || typeof status.state !== 'string') return null;
    return { state: status.state, code: status.code ?? null, candidateVersion: status.candidateVersion ?? null, clearable: status.clearable === true };
  } catch {
    return null;
  }
}

/** The owner's update: the reviewed pin when it is newer or nothing is installed; else the pipeline. */
export async function updateDshThroughPipeline(source: NpmLockInstallSource, ctx: NpmLockContext): Promise<NpmLockSwitch> {
  const current = currentVersion(source, ctx.home);
  // A first install, or a newer pin reviewed in the release itself, keeps the reviewed-pin path.
  if (!current || compareVersions(targetPin(source), current) > 0) return installNpmLockTarget(source, ctx);
  const candidate = pickDshCandidate(current, await publishedVersions(source, ctx));
  if (!candidate) {
    ctx.log(`${source.pkg} ${current} is the newest version on its channel.`);
    return { fromVersion: current, toVersion: current, pruned: [] };
  }
  ctx.log(`Checking ${source.pkg} ${candidate} offline before switching (contract suite).`);
  const result = (await dshUpdatePipeline(source, ctx.home, ctx).run({ version: candidate })) as { status: string; code?: string };
  if (result.status !== 'green') {
    ctx.log(`Update held: integration check failed (${result.code}). ${current} stays active.`);
    throw new NpmLockError(result.code ?? 'dsh_update_contract_failed', 'update_held');
  }
  ctx.log(`${source.pkg} ${candidate} passed the contract suite and is now active.`);
  await verifyVersionTree(source, ctx.home, candidate);
  return { fromVersion: current, toVersion: candidate, pruned: [] };
}
