/**
 * Owner CLI install of a missing harness (T-2062; architect design + qa
 * C1–C9). `POST /api/providers/:id/install` starts a job in the shared harness
 * job store (polled at `GET /update-jobs/:jobId`, `kind: 'install'`).
 *
 * Refused before any download or child process when: platform mode (C2), an
 * operator override env is set, the CLI already resolves, or something that
 * is not "not installed" sits in its place (C3), or the harness lease is held
 * (C8). opencode installs the pinned, digest-verified asset at the measured
 * path (C1); codex downloads the vendor install.sh into a private 0700 dir,
 * audits its sha256 and runs `sh <file>` under a scrubbed env (C5) with a
 * 5-minute process-group timeout. Success is proven only by the SAME
 * resolvers every launch uses (C4).
 *
 * ADR-215 stage A adds antigravity (agy) on the same script path, an
 * allow-list installer env for every script (ش7/ش8), one global install slot,
 * a HOME free-space precheck and the owned-path cleanup of install-cleanup.ts
 * (ش4/ش5). The full script sha256 is logged with an "unreviewed" warning when
 * it is not in the descriptor's reviewed list (owner decision Q1 = option A).
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HarnessBinaryUnresolvedError, HARNESS_BINARY_SPECS, resolveHarnessBinary } from '@/shared/harness-binaries.js';
import { resolveCodexMachineRuntime } from '@/shared/codex-executable.js';
import { AppError, resolveOpenCodeBinaryPath } from '@/shared/utils.js';

import type { HarnessUpdateJob } from '../../../../shared/harness-update.contract.js';
import {
  isInstallableHarness,
  type HarnessInstallJobErrorCode,
  type InstallableHarnessId,
} from '../../../../shared/harness-install.contract.js';

import { parseVersionOutput } from './descriptors.js';
import {
  HARNESS_INSTALL_SOURCES,
  type HarnessInstallSource,
  type OwnedPath,
  type ScriptInstallSource,
} from './install-sources.js';
import { acquireHarnessLease, releaseHarnessLease } from './lease.js';
import type { AssetInstallOptions, ReleaseAssetSpec } from './opencode-asset.js';
import { downloadVerified, fetchAllowed } from './opencode-asset.js';
import { readCapped } from './bounded-fetch.js';
import type { RunCommandOptions } from './run-command.js';
import { resolveSnapshotRuntime } from './snapshot-runtime.js';
import {
  appendDigestLog,
  appendLog,
  failJob,
  makeJob,
  setJob,
  storeJob,
  toPublic,
  type HarnessAuditFn,
  type InternalJob,
  type RunResult,
} from './update-jobs.js';
import { invalidateInstalledVersion } from './version-status.service.js';
import { existingOwnedPaths, removeAppearedOwnedPaths } from './install-cleanup.js';
import {
  detectClaudePlatform,
  binaryUrl,
  currentPlatformFacts,
  findGpgv,
  resolveSignedRelease,
  SignedManifestError,
  type SignedManifestSource,
  type VerifiedRelease,
} from './signed-manifest.js';
import {
  detectNpmGlobalClaude,
  existingSystemCopies,
  npmGlobalPrefixes,
  SYSTEM_CLAUDE_PATHS,
} from './claude-preflight.js';
import type { AckTokenService } from './confirmation.js';
import { hashFile } from './snapshot/durable-fs.js';

/** Prefix of every codex install staging dir (boot removes orphans). */
export const INSTALL_DIR_PREFIX = 'nassaj-harness-install-';
/** Fixed PATH of the installer child (C5). */
export const INSTALL_PATH_ENV = '/usr/local/bin:/usr/bin:/bin';
/**
 * Keys copied from the base env into an installer child (ADR-215 §3.5, ش7):
 * locale, identity and proxies only. Everything else (ANTHROPIC_*, CLAUDE_*,
 * GEMINI_*, CODEX_*, XDG_*, node and npm runtime options …) never reaches it.
 */
const INSTALL_ENV_PASS: readonly string[] = Object.freeze([
  'LANG', 'LC_ALL', 'USER', 'LOGNAME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
  // TLS trust for curl behind an intercepting proxy (no code-loading effect).
  'SSL_CERT_FILE', 'CURL_CA_BUNDLE',
]);
/**
 * SHELL passes only as a plain absolute path: codex's install.sh picks the
 * profile it edits from it (`pick_profile`), so dropping it would move codex's
 * PATH line from ~/.bashrc to ~/.profile (ش7 parity). agy ignores it (measured).
 */
const SAFE_SHELL = /^\/[A-Za-z0-9._/-]+$/u;

/** Everything the install flow reaches outside its own logic (tests inject). */
export interface InstallDeps {
  fetchImpl: typeof fetch;
  runCommand: (cmd: string, args: string[], opts: RunCommandOptions) => Promise<RunResult>;
  runVersion: (cmd: string, args: string[]) => Promise<string | null>;
  installCompatAsset: (opts: AssetInstallOptions) => Promise<void>;
  /** The pinned opencode release asset (sha-verified). */
  compatAsset: ReleaseAssetSpec;
  cleanEnv: () => NodeJS.ProcessEnv;
  audit: HarnessAuditFn;
  home: () => string;
  isPlatform: () => boolean;
  serverEnv: () => NodeJS.ProcessEnv;
  stagingParent: string;
  /** Registry resolver: a path, or a HarnessBinaryUnresolvedError. */
  resolveBinary: (id: InstallableHarnessId) => string;
  /** Launch-resolver proof of a usable install; its version (throws otherwise). */
  verifyInstalled: (id: InstallableHarnessId, deps: InstallDeps, expectedVersion?: string) => Promise<string>;
  sources: Readonly<Record<InstallableHarnessId, HarnessInstallSource>>;
  now: () => number;
  /** Free bytes on the filesystem holding `dir` (ش4 precheck). */
  freeBytes: (dir: string) => number;
  /** Overall download deadlines (qa I-1): installer script and opencode asset. */
  scriptDownloadTimeoutMs: number;
  assetDownloadTimeoutMs: number;
  /** ADR-215 stage B (claude): verifier, platform, pre-run facts, acks, binary deadline. */
  gpgvPath: () => string | null;
  claudePlatform: () => string | null;
  systemClaudePaths: readonly string[];
  npmPrefixes: (home: string) => string[];
  acks: () => AckTokenService;
  binaryDownloadTimeoutMs: number;
}

/** Mutable facts of one run that the failure audit must still see (qa I-2). */
interface InstallRunFacts {
  sha256: string | null;
  /** True when the digest is in the descriptor's reviewed list. */
  reviewed: boolean | null;
  /** Home-relative paths the cleanup removed (audited). */
  removedPaths: string[];
  /** claude: the signed manifest version and key that verified it. */
  manifestVersion?: string;
  keyFingerprint?: string;
}

/** Typed failure of one install job, mapped onto the job error codes. */
class InstallError extends Error {
  constructor(readonly jobCode: HarnessInstallJobErrorCode,
    readonly cause: string, readonly exitCode: number | null = null,
    /** The installer group could not be proven dead after the timeout kill. */
    readonly unquiesced = false) {
    super(cause);
  }
}

/** C4: the launch resolvers (codex machine release / opencode registry + digest pin). */
async function defaultVerifyInstalled(
  id: InstallableHarnessId,
  deps: InstallDeps,
  expectedVersion?: string,
): Promise<string> {
  if (id === 'codex') {
    const runtime = resolveCodexMachineRuntime();
    resolveHarnessBinary('codex');
    return runtime.version;
  }
  if (id === 'claude') return verifyClaudeInstalled(deps, expectedVersion);
  if (id === 'antigravity') {
    // M-1: the vendor script ends with `agy install || true`; only the
    // registry resolver plus a parsed --version prove the install.
    const version = parseVersionOutput(await deps.runVersion(resolveHarnessBinary('antigravity'), ['--version']));
    if (!version) throw new Error('agy version unreadable');
    return version;
  }
  const version = parseVersionOutput(await deps.runVersion(resolveOpenCodeBinaryPath(), ['--version']));
  if (!version) throw new Error('opencode version unreadable');
  return version;
}

/**
 * qa M1: the launcher the registry resolves must lead (realpath) to the
 * checksum-verified `versions/<v>` of THIS job, and `--version` must be <v>.
 */
async function verifyClaudeInstalled(deps: InstallDeps, expectedVersion?: string): Promise<string> {
  if (!expectedVersion) throw Object.assign(new Error('no verified release'), { code: 'release_unknown' });
  const launcher = resolveHarnessBinary('claude');
  const versionFile = path.join(deps.home(), '.local', 'share', 'claude', 'versions', expectedVersion);
  if (fs.realpathSync(launcher) !== fs.realpathSync(versionFile)) {
    throw Object.assign(new Error('launcher elsewhere'), { code: 'launcher_mismatch' });
  }
  const version = parseVersionOutput(await deps.runVersion(launcher, ['--version']));
  if (version !== expectedVersion) throw Object.assign(new Error('version mismatch'), { code: 'version_mismatch' });
  return version;
}

function defaultDeps(): InstallDeps {
  const rt = resolveSnapshotRuntime();
  return {
    fetchImpl: fetch,
    runCommand: rt.runCommand,
    runVersion: rt.runVersion,
    installCompatAsset: rt.installCompatAsset,
    compatAsset: rt.compatAsset,
    cleanEnv: rt.cleanEnv,
    audit: rt.audit,
    home: () => os.homedir(),
    isPlatform: () => process.env.VITE_IS_PLATFORM === 'true',
    serverEnv: () => process.env,
    stagingParent: '/var/tmp',
    resolveBinary: (id) => resolveHarnessBinary(id),
    verifyInstalled: defaultVerifyInstalled,
    sources: HARNESS_INSTALL_SOURCES,
    now: Date.now,
    freeBytes: (dir) => {
      const st = fs.statfsSync(dir);
      return st.bavail * st.bsize;
    },
    scriptDownloadTimeoutMs: 60_000,
    assetDownloadTimeoutMs: 10 * 60 * 1000,
    gpgvPath: () => findGpgv(),
    claudePlatform: () => detectClaudePlatform(currentPlatformFacts()),
    systemClaudePaths: SYSTEM_CLAUDE_PATHS,
    npmPrefixes: (home) => npmGlobalPrefixes(home),
    acks: rt.acks,
    binaryDownloadTimeoutMs: 10 * 60 * 1000,
  };
}

let testDeps: Partial<InstallDeps> | null = null;

/** ADR-215 §3.6: the job id holding the single global install slot. */
let installSlot: string | null = null;

/** Test hook: frees the global install slot. */
export function _resetInstallSlot(): void {
  installSlot = null;
}

/** Test hook: replace any subset of the install deps (null restores production). */
export function _setInstallTestDeps(next: Partial<InstallDeps> | null): void {
  testDeps = next;
}

/** An audit sink that can never break a job (a DB write failure is swallowed). */
function guardAudit(audit: HarnessAuditFn): HarnessAuditFn {
  return (action, metadata, userId) => {
    try {
      audit(action, metadata, userId);
    } catch {
      /* audit is best effort here; the job result stands */
    }
  };
}

const refuse = (code: string, statusCode: number, details?: Record<string, unknown>) =>
  new AppError(`Harness install refused (${code}).`, { code, statusCode, details });

/** C3: allowed only when the registry says exactly "not installed" and nothing sits at the path. */
function assertNotInstalled(id: InstallableHarnessId, deps: InstallDeps): void {
  const spec = HARNESS_BINARY_SPECS[id];
  if ((deps.serverEnv()[spec.overrideEnv]?.trim() ?? '') !== '') throw refuse('HARNESS_OVERRIDE_SET', 409);
  let reason: string;
  try {
    deps.resolveBinary(id);
    reason = 'resolved';
  } catch (error) {
    reason = error instanceof HarnessBinaryUnresolvedError ? error.reason : 'invalid-install';
  }
  if (reason === 'resolved') throw refuse('HARNESS_ALREADY_INSTALLED', 409);
  if (reason !== 'not-installed') throw refuse('HARNESS_INSTALL_INVALID', 409);
  let occupied = false;
  try {
    fs.lstatSync(spec.measured(deps.home()));
    occupied = true;
  } catch {
    /* absent: the only installable state */
  }
  if (occupied) throw refuse('HARNESS_INSTALL_INVALID', 409);
}

/**
 * ADR-215 stage B pre-run warnings through the ADR-159 acknowledgement flow:
 * a system claude copy (owner decision 2: warn, allow) and an npm-global
 * claude the vendor installer will uninstall. Throws 409
 * CONFIRMATION_REQUIRED until the owner echoes the fresh tokens.
 */
function verifyClaudePreRunAcks(deps: InstallDeps, opts: { userId: number | null; acks?: unknown }): void {
  const copies = existingSystemCopies(deps.systemClaudePaths);
  const npm = detectNpmGlobalClaude(deps.npmPrefixes(deps.home()));
  if (copies.length === 0 && !npm) return;
  deps.acks().verifyAcks({
    userId: opts.userId ?? -1, harness: 'claude', harnessName: 'Claude Code', action: 'install',
    pinBreak: null, dataLoss: null,
    systemCopy: copies.length > 0 ? { paths: copies } : null,
    npmRemoval: npm,
  }, Array.isArray(opts.acks) ? opts.acks : undefined);
}

/**
 * Starts an install job for `idOrAlias` (owner route). Throws an AppError
 * refusal (404/403/409) before any side effect; otherwise returns the running
 * job's public view. The job releases the harness lease when it settles.
 */
export function startHarnessInstall(
  idOrAlias: string,
  opts: { userId: number | null; acks?: unknown },
): HarnessUpdateJob & { done: Promise<void> } {
  const merged: InstallDeps = { ...defaultDeps(), ...(testDeps ?? {}) };
  const deps: InstallDeps = { ...merged, audit: guardAudit(merged.audit) };
  if (!isInstallableHarness(idOrAlias)) throw refuse('HARNESS_NOT_INSTALLABLE', 404);
  const id = idOrAlias;
  if (deps.isPlatform()) throw refuse('PLATFORM_MODE_UNSUPPORTED', 403);
  assertNotInstalled(id, deps);
  if (installSlot) throw refuse('HARNESS_INSTALL_SLOT_BUSY', 409, { activeJobId: installSlot });
  const jobId = randomUUID();
  const lease = acquireHarnessLease(id, jobId, deps.now);
  if ('conflict' in lease) throw refuse('HARNESS_UPDATE_IN_PROGRESS', 409, { activeJobId: lease.conflict });
  let job: InternalJob;
  try {
    // qa I1: acks are consumed only once the slot is free and the lease held,
    // so a busy refusal never burns the owner's confirmation tokens.
    if (id === 'claude') verifyClaudePreRunAcks(deps, opts);
    job = makeJob(jobId, id, opts.userId, 'manual', 'running', 'preflight', 5);
    job.kind = 'install';
    storeJob(job, deps.now());
  } catch (error) {
    releaseHarnessLease(id, jobId);
    throw error;
  }
  installSlot = jobId;
  job.done = runInstall(job, id, deps).finally(() => {
    // retainLease: a not-quiesced installer keeps lease and slot until restart.
    if (job.retainLease) return;
    releaseHarnessLease(id, jobId);
    if (installSlot === jobId) installSlot = null;
  });
  return { ...toPublic(job), done: job.done };
}

/** The job body: install, verify through the launch resolvers, finish or fail. */
async function runInstall(job: InternalJob, id: InstallableHarnessId, deps: InstallDeps): Promise<void> {
  const facts: InstallRunFacts = { sha256: null, reviewed: null, removedPaths: [] };
  deps.audit('harness_install_started', { provider: id }, job.userId);
  const source = deps.sources[id];
  const held: { guard: OwnedGuard | null } = { guard: null };
  const arm = (owned: readonly OwnedPath[]) => { held.guard = ownedGuard(job, owned, deps, facts); };
  try {
    setJob(job, { phase: 'downloading', percent: 15 });
    if (source.kind === 'asset') {
      await installOpencodeAsset(job, deps);
    } else if (source.kind === 'signed-manifest') {
      assertFreeSpace(source.minFreeBytes, [deps.home(), deps.stagingParent], deps);
      await installBySignedManifest(job, source, deps, facts, arm);
    } else {
      assertFreeSpace(source.minFreeBytes, [deps.home()], deps);
      arm(source.ownedPaths(deps.home()));
      await installByScript(job, source, deps, facts);
    }
    setJob(job, { phase: 'verifying', percent: 90 });
    const version = await verifyOrFail(id, deps, facts.manifestVersion);
    held.guard?.settle(true);
    invalidateInstalledVersion(id);
    appendLog(job, `Installed ${id} ${version}`);
    setJob(job, {
      status: 'succeeded', phase: 'done', percent: 100, toVersion: version,
      finished: true, finishedAt: deps.now(),
    });
    deps.audit('harness_install_succeeded', {
      provider: id, sha256: facts.sha256, reviewed: facts.reviewed, version, removedPaths: facts.removedPaths,
      manifestVersion: facts.manifestVersion, keyFingerprint: facts.keyFingerprint,
    }, job.userId);
  } catch (error) {
    const e = error instanceof InstallError ? error : new InstallError('install_failed', 'install_exception');
    if (e.unquiesced) {
      job.retainLease = true;
      appendLog(job, 'The installer could not be stopped; cleanup skipped and installs stay blocked until restart.');
    } else {
      held.guard?.settle(false);
    }
    appendLog(job, `Install failed (${e.cause}).`);
    failJob(job, e.jobCode, `Harness install failed (${e.jobCode}).`, (action, metadata, userId) =>
      deps.audit(action, {
        ...metadata, sha256: facts.sha256, reviewed: facts.reviewed, code: e.jobCode, cause: e.cause,
        removedPaths: facts.removedPaths, manifestVersion: facts.manifestVersion, keyFingerprint: facts.keyFingerprint,
      }, userId), e.exitCode);
  }
}

async function verifyOrFail(id: InstallableHarnessId, deps: InstallDeps, expectedVersion?: string): Promise<string> {
  try {
    return await deps.verifyInstalled(id, deps, expectedVersion);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    throw new InstallError('verify_failed', typeof code === 'string' ? code : 'unverified');
  }
}

/** C1: ~/.opencode/bin (0755, no symlinks) then the pinned asset at the measured path. */
async function installOpencodeAsset(job: InternalJob, deps: InstallDeps): Promise<void> {
  const destPath = HARNESS_BINARY_SPECS.opencode.measured(deps.home());
  try {
    ensurePrivateBinDir(path.dirname(destPath), deps.home());
  } catch {
    throw new InstallError('install_failed', 'bin_dir_unsafe');
  }
  setJob(job, { phase: 'installing', percent: 30 });
  try {
    await deps.installCompatAsset({
      jobId: job.jobId,
      spec: deps.compatAsset,
      destPath,
      stagingParent: deps.stagingParent,
      fetchImpl: deps.fetchImpl,
      signal: AbortSignal.timeout(deps.assetDownloadTimeoutMs),
      readVersion: async (bin) => parseVersionOutput(await deps.runVersion(bin, ['--version'])),
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ASSET_DOWNLOAD_TIMEOUT') throw new InstallError('script_rejected', 'download_timeout');
    throw new InstallError('install_failed', typeof code === 'string' ? code : 'asset_install_failed');
  }
  appendLog(job, 'Pinned opencode release installed.');
}

/**
 * Creates `binDir` and its parent below `home` one level at a time (mode
 * 0755, never recursive past the parent), refusing any symlink or non-dir.
 */
export function ensurePrivateBinDir(binDir: string, home: string): void {
  const parent = path.dirname(binDir);
  if (path.dirname(parent) !== home) throw new Error('unexpected bin dir location');
  for (const dir of [parent, binDir]) {
    try {
      fs.mkdirSync(dir, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid?.()) {
      throw new Error('bin dir is not a plain owned directory');
    }
  }
}

/**
 * ADR-215 §3.5 allow-list env: fixed HOME, TMPDIR and PATH; LANG, LC_ALL,
 * USER, LOGNAME and proxies when present; SHELL only as a plain absolute path.
 */
export function buildInstallEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INSTALL_ENV_PASS) {
    const value = base[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  if (typeof base.SHELL === 'string' && SAFE_SHELL.test(base.SHELL)) env.SHELL = base.SHELL;
  return { ...env, HOME: home, TMPDIR: '/var/tmp', PATH: INSTALL_PATH_ENV };
}

/** ش4: fails `insufficient_space` when any of `dirs` lacks `minFreeBytes`. */
function assertFreeSpace(minFreeBytes: number, dirs: readonly string[], deps: InstallDeps): void {
  if (minFreeBytes <= 0) return;
  for (const dir of dirs) {
    let free: number;
    try {
      free = deps.freeBytes(dir);
    } catch {
      throw new InstallError('insufficient_space', 'free_space_unreadable');
    }
    if (free < minFreeBytes) throw new InstallError('insufficient_space', 'below_minimum');
  }
}

/** Records the digest: full sha256 in the log, plus the unreviewed warning (Q1 = A). */
function recordDigest(job: InternalJob, source: ScriptInstallSource, sha256: string, facts: InstallRunFacts): void {
  facts.sha256 = sha256;
  facts.reviewed = source.knownSha256.includes(sha256);
  appendDigestLog(job, 'Installer downloaded:', sha256);
  if (!facts.reviewed) {
    appendLog(job, 'Warning: unreviewed script. Its sha256 is not in the list reviewed for this Nassaj release.');
  }
}

/** Settles the owned-path cleanup once: success removes staging leftovers, failure every appeared file. */
interface OwnedGuard {
  settle: (ok: boolean) => void;
}

/**
 * ش4/ش5: snapshots the descriptor's owned paths before the vendor step, so
 * that a failure anywhere later (download, script, timeout, verify) removes
 * only what appeared during this job. Removals are logged and audited.
 */
function ownedGuard(
  job: InternalJob,
  owned: readonly OwnedPath[],
  deps: InstallDeps,
  facts: InstallRunFacts,
): OwnedGuard {
  const home = deps.home();
  const before = existingOwnedPaths(owned);
  const sinceMs = deps.now();
  let settled = false;
  return {
    settle(ok) {
      if (settled) return;
      settled = true;
      const { removed, skipped } = removeAppearedOwnedPaths(owned, before, { home, sinceMs, stagingOnly: ok });
      const rel = (p: string) => `~/${path.relative(home, p)}`;
      for (const p of removed) appendLog(job, `Removed partial install file ${rel(p)}`);
      for (const s of skipped) appendLog(job, `Left in place ${rel(s.path)} (${s.reason})`);
      facts.removedPaths.push(...removed.map(rel));
    },
  };
}

/** Script install: download → sha256 → `<interpreter> <file>` (group kill) → rm dir. */
async function installByScript(
  job: InternalJob,
  source: ScriptInstallSource,
  deps: InstallDeps,
  facts: InstallRunFacts,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(deps.stagingParent, INSTALL_DIR_PREFIX));
  let keepDir = false;
  try {
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'install.sh');
    const signal = AbortSignal.timeout(deps.scriptDownloadTimeoutMs);
    recordDigest(job, source, await downloadScript(source, file, deps.fetchImpl, signal), facts);
    setJob(job, { phase: 'installing', percent: 30 });
    await runInstaller(job, { cmd: source.interpreter, args: [file], cwd: dir, timeoutMs: source.timeoutMs }, deps);
  } catch (error) {
    // A live installer may still read its script: boot reconcile removes the dir.
    keepDir = error instanceof InstallError && error.unquiesced;
    throw error;
  } finally {
    if (!keepDir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * claude (ADR-215 stage B): signed release → arm cleanup → streamed binary →
 * `<binary> install <v>` (ش1: never `latest`) → installed-file checksum.
 */
async function installBySignedManifest(
  job: InternalJob,
  source: SignedManifestSource,
  deps: InstallDeps,
  facts: InstallRunFacts,
  arm: (owned: readonly OwnedPath[]) => void,
): Promise<void> {
  const home = deps.home();
  const dir = fs.mkdtempSync(path.join(deps.stagingParent, INSTALL_DIR_PREFIX));
  let keepDir = false;
  try {
    fs.chmodSync(dir, 0o700);
    const release = await verifiedRelease(job, source, dir, deps, facts);
    arm(source.ownedPaths(home, release.version));
    const binary = await downloadClaudeBinary(source, release, dir, deps);
    appendLog(job, `Binary downloaded and matched the signed checksum (${release.size} bytes).`);
    setJob(job, { phase: 'installing', percent: 50 });
    await runInstaller(job, {
      cmd: binary, args: ['install', release.version], cwd: dir, timeoutMs: source.timeoutMs,
      // qa I2: measured M-2 saw api.anthropic.com twice; the install needs none of it.
      extraEnv: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    }, deps);
    assertInstalledChecksum(home, release);
  } catch (error) {
    keepDir = error instanceof InstallError && error.unquiesced;
    throw error;
  } finally {
    if (!keepDir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** ش2/ش3: latest → manifest + signature → gpgv VALIDSIG → parsed verified bytes. */
async function verifiedRelease(
  job: InternalJob,
  source: SignedManifestSource,
  dir: string,
  deps: InstallDeps,
  facts: InstallRunFacts,
): Promise<VerifiedRelease> {
  let release: VerifiedRelease;
  try {
    release = await resolveSignedRelease(source, {
      dir, platform: deps.claudePlatform(), fetchImpl: deps.fetchImpl,
      signal: AbortSignal.timeout(deps.scriptDownloadTimeoutMs),
      gpgv: { gpgvPath: deps.gpgvPath, runCommand: deps.runCommand },
    });
  } catch (error) {
    if (error instanceof SignedManifestError) throw new InstallError(error.jobCode, error.cause);
    throw new InstallError('script_rejected', 'manifest_failed');
  }
  facts.manifestVersion = release.version;
  facts.keyFingerprint = source.keyFingerprint;
  appendLog(job, `Signed manifest verified: claude ${release.version} for ${release.platform} `
    + `(key …${source.keyFingerprint.slice(-16)}).`);
  appendDigestLog(job, 'Expected binary:', release.checksum);
  return release;
}

/** ش3: streams the binary through downloadVerified (size + sha256 of the signed manifest). */
async function downloadClaudeBinary(
  source: SignedManifestSource,
  release: VerifiedRelease,
  dir: string,
  deps: InstallDeps,
): Promise<string> {
  const file = path.join(dir, `claude-${release.version}`);
  const spec: ReleaseAssetSpec = {
    url: binaryUrl(source, release), allowedHosts: source.allowedHosts, maxRedirects: source.maxRedirects,
    size: release.size, capBytes: source.binaryCapBytes, tarballSha256: release.checksum, entryName: 'claude',
    binarySha256: release.checksum, version: release.version, maxUncompressedBytes: source.binaryCapBytes,
  };
  const signal = AbortSignal.timeout(deps.binaryDownloadTimeoutMs);
  try {
    await downloadVerified(await fetchAllowed(spec, deps.fetchImpl, signal), file, spec, signal);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ASSET_DOWNLOAD_TIMEOUT') throw new InstallError('script_rejected', 'download_timeout');
    throw new InstallError('script_rejected', typeof code === 'string' ? code : 'binary_download_failed');
  }
  fs.chmodSync(file, 0o700);
  return file;
}

/** ش2: the installed version file is a regular file whose sha256 is the signed checksum. */
function assertInstalledChecksum(home: string, release: VerifiedRelease): void {
  const versionFile = path.join(home, '.local', 'share', 'claude', 'versions', release.version);
  let digest: string;
  try {
    if (!fs.lstatSync(versionFile).isFile()) throw new Error('not a file');
    digest = hashFile(versionFile).sha256;
  } catch {
    throw new InstallError('verify_failed', 'installed_version_missing');
  }
  if (digest !== release.checksum) throw new InstallError('verify_failed', 'installed_checksum_mismatch');
}

/** Fetches the script across the allowlist into `file` (0600, capped); returns its sha256. */
async function downloadScript(
  source: ScriptInstallSource,
  file: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  let body: Uint8Array;
  try {
    const res = await fetchAllowed(source, fetchImpl, signal);
    body = await readCapped(res, source.capBytes, signal);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ASSET_DOWNLOAD_TIMEOUT') throw new InstallError('script_rejected', 'download_timeout');
    throw new InstallError('script_rejected', typeof code === 'string' ? code : 'download_failed');
  }
  if (body.length === 0) throw new InstallError('script_rejected', 'empty_script');
  fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
  return createHash('sha256').update(body).digest('hex');
}

/** Runs the vendor installer step; output lines feed the log live and move 30 → 85 %. */
async function runInstaller(
  job: InternalJob,
  argv: { cmd: string; args: string[]; cwd: string; timeoutMs: number; extraEnv?: Record<string, string> },
  deps: InstallDeps,
): Promise<void> {
  let lines = 0;
  const result = await deps.runCommand(argv.cmd, argv.args, {
    env: { ...buildInstallEnv(deps.cleanEnv(), deps.home()), ...(argv.extraEnv ?? {}) },
    cwd: argv.cwd,
    timeoutMs: argv.timeoutMs,
    onLine: (line) => {
      lines += 1;
      appendLog(job, line);
      setJob(job, { percent: Math.min(85, 30 + lines) });
    },
  });
  if (result.timedOut && result.quiesced === false) {
    // A member of the installer's process group may still be writing: no
    // cleanup, and the lease and slot stay held (like update.service).
    throw new InstallError('install_timeout', 'not_quiesced', result.code, true);
  }
  if (result.timedOut) throw new InstallError('install_timeout', 'timeout', result.code);
  if (result.code !== 0) throw new InstallError('install_failed', 'nonzero_exit', result.code);
}

/** A staging dir older than this cannot belong to a live run (longest timeout: 10 min). */
const ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;

/**
 * Boot (C8): removes codex install staging dirs a crashed run left behind
 * (own, plain directories older than `minAgeMs` only). Returns the count.
 */
export function removeOrphanInstallDirs(parent = '/var/tmp', minAgeMs = ORPHAN_MIN_AGE_MS, now = Date.now()): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(INSTALL_DIR_PREFIX)) continue;
    const full = path.join(parent, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isDirectory() || st.uid !== process.getuid?.() || now - st.mtimeMs < minAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* best effort; retried next boot */
    }
  }
  return removed;
}
