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
  type InstallableHarnessId,
} from '../../../../shared/harness-install.contract.js';

import { parseVersionOutput } from './descriptors.js';
import {
  HARNESS_INSTALL_SOURCES,
  type HarnessInstallSource,
  type ScriptInstallSource,
} from './install-sources.js';
import { acquireHarnessLease, releaseHarnessLease } from './lease.js';
import type { AssetInstallOptions, ReleaseAssetSpec } from './opencode-asset.js';
import { fetchAllowed, withAbort } from './opencode-asset.js';
import type { RunCommandOptions } from './run-command.js';
import { resolveSnapshotRuntime } from './snapshot-runtime.js';
import {
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

/** Prefix of every codex install staging dir (boot removes orphans). */
export const INSTALL_DIR_PREFIX = 'nassaj-harness-install-';
/** Fixed PATH of the installer child (C5). */
export const INSTALL_PATH_ENV = '/usr/local/bin:/usr/bin:/bin';
const SCRUBBED_ENV = /^(?:CODEX_|XDG_|OPENCODE_)/u;

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
  verifyInstalled: (id: InstallableHarnessId, deps: InstallDeps) => Promise<string>;
  sources: Readonly<Record<InstallableHarnessId, HarnessInstallSource>>;
  now: () => number;
  /** Overall download deadlines (qa I-1): installer script and opencode asset. */
  scriptDownloadTimeoutMs: number;
  assetDownloadTimeoutMs: number;
}

/** Mutable facts of one run that the failure audit must still see (qa I-2). */
interface InstallRunFacts {
  sha256: string | null;
}

/** Typed failure of one install job, mapped onto the job error codes. */
class InstallError extends Error {
  constructor(readonly jobCode: 'install_failed' | 'install_timeout' | 'verify_failed' | 'script_rejected',
    readonly cause: string, readonly exitCode: number | null = null) {
    super(cause);
  }
}

/** C4: the launch resolvers (codex machine release / opencode registry + digest pin). */
async function defaultVerifyInstalled(id: InstallableHarnessId, deps: InstallDeps): Promise<string> {
  if (id === 'codex') {
    const runtime = resolveCodexMachineRuntime();
    resolveHarnessBinary('codex');
    return runtime.version;
  }
  const version = parseVersionOutput(await deps.runVersion(resolveOpenCodeBinaryPath(), ['--version']));
  if (!version) throw new Error('opencode version unreadable');
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
    scriptDownloadTimeoutMs: 60_000,
    assetDownloadTimeoutMs: 10 * 60 * 1000,
  };
}

let testDeps: Partial<InstallDeps> | null = null;

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
 * Starts an install job for `idOrAlias` (owner route). Throws an AppError
 * refusal (404/403/409) before any side effect; otherwise returns the running
 * job's public view. The job releases the harness lease when it settles.
 */
export function startHarnessInstall(
  idOrAlias: string,
  opts: { userId: number | null },
): HarnessUpdateJob & { done: Promise<void> } {
  const merged: InstallDeps = { ...defaultDeps(), ...(testDeps ?? {}) };
  const deps: InstallDeps = { ...merged, audit: guardAudit(merged.audit) };
  if (!isInstallableHarness(idOrAlias)) throw refuse('HARNESS_NOT_INSTALLABLE', 404);
  const id = idOrAlias;
  if (deps.isPlatform()) throw refuse('PLATFORM_MODE_UNSUPPORTED', 403);
  assertNotInstalled(id, deps);
  const jobId = randomUUID();
  const lease = acquireHarnessLease(id, jobId, deps.now);
  if ('conflict' in lease) throw refuse('HARNESS_UPDATE_IN_PROGRESS', 409, { activeJobId: lease.conflict });
  let job: InternalJob;
  try {
    job = makeJob(jobId, id, opts.userId, 'manual', 'running', 'preflight', 5);
    job.kind = 'install';
    storeJob(job, deps.now());
  } catch (error) {
    releaseHarnessLease(id, jobId);
    throw error;
  }
  job.done = runInstall(job, id, deps).finally(() => releaseHarnessLease(id, jobId));
  return { ...toPublic(job), done: job.done };
}

/** The job body: install, verify through the launch resolvers, finish or fail. */
async function runInstall(job: InternalJob, id: InstallableHarnessId, deps: InstallDeps): Promise<void> {
  const facts: InstallRunFacts = { sha256: null };
  deps.audit('harness_install_started', { provider: id }, job.userId);
  try {
    setJob(job, { phase: 'downloading', percent: 15 });
    const source = deps.sources[id];
    if (source.kind === 'asset') await installOpencodeAsset(job, deps);
    else await installByScript(job, source, deps, facts);
    setJob(job, { phase: 'verifying', percent: 90 });
    const version = await verifyOrFail(id, deps);
    invalidateInstalledVersion(id);
    appendLog(job, `Installed ${id} ${version}`);
    setJob(job, {
      status: 'succeeded', phase: 'done', percent: 100, toVersion: version,
      finished: true, finishedAt: deps.now(),
    });
    deps.audit('harness_install_succeeded', { provider: id, sha256: facts.sha256, version }, job.userId);
  } catch (error) {
    const e = error instanceof InstallError ? error : new InstallError('install_failed', 'install_exception');
    appendLog(job, `Install failed (${e.cause}).`);
    failJob(job, e.jobCode, `Harness install failed (${e.jobCode}).`, (action, metadata, userId) =>
      deps.audit(action, { ...metadata, sha256: facts.sha256, code: e.jobCode, cause: e.cause }, userId), e.exitCode);
  }
}

async function verifyOrFail(id: InstallableHarnessId, deps: InstallDeps): Promise<string> {
  try {
    return await deps.verifyInstalled(id, deps);
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

/** C5: cleanEnv minus CODEX_*, XDG_*, OPENCODE_*; fixed HOME, TMPDIR and PATH. */
export function buildInstallEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!SCRUBBED_ENV.test(key)) env[key] = value;
  }
  return { ...env, HOME: home, TMPDIR: '/var/tmp', PATH: INSTALL_PATH_ENV };
}

/** codex: download → record sha256 → `sh <file>` (5 min, group kill) → rm dir. */
async function installByScript(
  job: InternalJob,
  source: ScriptInstallSource,
  deps: InstallDeps,
  facts: InstallRunFacts,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(deps.stagingParent, INSTALL_DIR_PREFIX));
  try {
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'install.sh');
    const sha256 = await downloadScript(source, file, deps.fetchImpl, AbortSignal.timeout(deps.scriptDownloadTimeoutMs));
    facts.sha256 = sha256;
    // The full digest goes to the audit row; the log keeps a prefix the
    // secret-redaction pass leaves readable.
    appendLog(job, `Installer downloaded (sha256 ${sha256.slice(0, 16)}…).`);
    setJob(job, { phase: 'installing', percent: 30 });
    await runScript(job, source, file, deps);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

/** Reads a response body, failing past `cap` bytes or when `signal` aborts. */
async function readCapped(res: Response, cap: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > cap) throw Object.assign(new Error('too large'), { code: 'ASSET_TOO_LARGE' });
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  const read = () => withAbort(reader.read(), signal).catch(async (error: unknown) => {
    await reader.cancel().catch(() => {});
    throw error;
  });
  for (let r = await read(); !r.done; r = await read()) {
    total += r.value.length;
    if (total > cap) {
      await reader.cancel();
      throw Object.assign(new Error('too large'), { code: 'ASSET_TOO_LARGE' });
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks);
}

/** Runs the script; output lines feed the log live and move 30 → 85 %. */
async function runScript(job: InternalJob, source: ScriptInstallSource, file: string, deps: InstallDeps): Promise<void> {
  let lines = 0;
  const result = await deps.runCommand(source.interpreter, [file], {
    env: buildInstallEnv(deps.cleanEnv(), deps.home()),
    cwd: path.dirname(file),
    timeoutMs: source.timeoutMs,
    onLine: (line) => {
      lines += 1;
      appendLog(job, line);
      setJob(job, { percent: Math.min(85, 30 + lines) });
    },
  });
  if (result.timedOut) throw new InstallError('install_timeout', 'timeout', result.code);
  if (result.code !== 0) throw new InstallError('install_failed', 'nonzero_exit', result.code);
}

/** A staging dir older than this cannot belong to a live run (timeout is 5 min). */
const ORPHAN_MIN_AGE_MS = 15 * 60 * 1000;

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
