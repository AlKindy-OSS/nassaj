/**
 * harness update service (T-1749 / ADR-159 item 4).
 *
 * Runs the FIXED, allowlisted update argv for one harness under:
 *   - an INDEPENDENT single-flight lease PER HARNESS (lease.ts) — never the app
 *     source-update machinery, so an app `update_maintenance` gate is not raised;
 *   - an atomic "no live session of that harness across ALL users" gate, taken
 *     AFTER the lease (the lease already blocks NEW spawns through
 *     spawn-admission, so checking first would leave a TOCTOU window in which a
 *     turn starts between the check and the lease) — the gate reads BOTH the
 *     presence run registry (session-process-monitor.hasActiveRunForProviders)
 *     and the unregistered-launch registry (spawn-admission.hasLiveHarnessLaunch:
 *     managed terminal, resume-turn runner, codex app-server, workflow units)
 *     → `skipped_live_session` / error code `live_session_active`;
 *   - the digest pin (item 5): an ARMED pin over a PINNED harness → refused
 *     `refused_pinned` (the signed re-pin ledger is deferred to T-1753);
 *   - `cleanSpawnEnv()` ONLY as the child env (NOT resolveProviderEnv): the
 *     updater runs as the operator, not a member, so no CLAUDE_CONFIG_DIR / host
 *     secret / provider key must ever reach it;
 *   - a hard timeout with kill;
 *   - a sanitized, capped, append-only log;
 *   - an audit row at start / success / failure { userId, provider, fromVersion,
 *     toVersion, exitCode, trigger };
 *   - post-update verification (binary present + `--version` proves a version
 *     advance) and recovery on failure (npm-prefix: reinstall
 *     the captured previous version under TMPDIR=/var/tmp; git-shallow (hermes):
 *     `git reset --hard <captured rev>` + `uv pip install -e .`; native
 *     self-updaters are ineligible because they have no exact rollback).
 *
 * The lease also BLOCKS new spawns of that harness while its update runs
 * (`isHarnessSpawnBlocked`) — spawn sites consult it and refuse with a clear,
 * generic error rather than racing the binary swap.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { auditLogDb } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/no-unknown -- process presence is a root service shared by all provider launchers.
import { hasActiveRunForProviders } from '@/services/session-process-monitor.js';
// eslint-disable-next-line boundaries/no-unknown -- the root command service owns the canonical secret-stripping environment.
import { cleanSpawnEnv } from '@/services/command-board-custom.js';
import { isVendorBinaryPinEnabled } from '@/services/isolation/vendor-binary-integrity.js';
import { listAllActiveScopes } from '@/modules/workflow-supervisor/index.js';
import { AppError } from '@/shared/utils.js';
import type {
  HarnessUpdateJob,
  HarnessUpdateJobPhase,
  HarnessUpdateJobStatus,
} from '../../../../shared/harness-update.contract.js';

import {
  getHarnessDescriptor,
  HARNESS_UPDATE_DESCRIPTORS,
  parseVersionOutput,
  resolveUvBinary,
  type HarnessDescriptor,
  type HarnessUpdateArgv,
} from './descriptors.js';
import {
  acquireHarnessLease,
  activeHarnessJobId,
  isHarnessLeased,
  releaseHarnessLease,
} from './lease.js';
import { isHarnessPinRefused, invalidateInstalledVersion } from './version-status.service.js';
import {
  clearHarnessRecoveryBlocked,
  hasLiveHarnessLaunch,
  isHarnessRecoveryBlocked,
  markHarnessRecoveryBlocked,
} from './spawn-admission.js';

/** Hard cap on a single update child process. */
export const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
/** Max stored log lines (append-only, oldest dropped). */
const MAX_LOG_LINES = 500;
/** Max characters kept per log line. */
const MAX_LOG_LINE_LEN = 2_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
/** Job store pruning (item 10): finished jobs expire, and the map is capped. */
const JOB_RETENTION_MS = 60 * 60 * 1000;
const MAX_JOBS = 50;

export type UpdateTrigger = 'manual' | 'scheduler';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** False only when a timed-out POSIX process group could not be proven dead. */
  quiesced?: boolean;
}

export interface UpdateServiceDeps {
  /** Runs a command with the given env/cwd, bounded by a hard timeout + kill. */
  runCommand?: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number }) => Promise<RunResult>;
  /** Reads `<binary> --version` trimmed stdout (or null). */
  runVersion?: (cmd: string, args: string[]) => Promise<string | null>;
  hasLiveSession?: (providerIds: string[]) => boolean;
  /**
   * Live launches this process started OUTSIDE the presence run registry
   * (workflow units, the managed terminal, resume-turn runs, codex app-server
   * RPCs). Consulted in addition to `hasLiveSession` so the gate is not blind
   * to them. Async because the workflow leg asks systemd.
   */
  hasUnregisteredLaunch?: (providerIds: string[]) => Promise<boolean>;
  pinEnabled?: () => boolean;
  cleanEnv?: () => NodeJS.ProcessEnv;
  audit?: (action: 'harness_update_started' | 'harness_update_succeeded' | 'harness_update_failed', metadata: Record<string, unknown>, userId: number | null) => void;
  now?: () => number;
  /** Test seams for the durable pre-mutation recovery intent. */
  markRecoveryIntent?: (harnessId: string) => void;
  clearRecoveryIntent?: (harnessId: string) => void;
}

interface InternalJob extends HarnessUpdateJob {
  userId: number | null;
  trigger: UpdateTrigger;
  finished: boolean;
  /** Epoch ms the job reached a terminal state (null while running). */
  finishedAt: number | null;
  /** git-shallow only: the pre-update `git rev-parse HEAD`, for rollback. */
  gitRev: string | null;
  /** Keep the lease held after an unverifiable rollback. */
  retainLease: boolean;
  /** Promise that settles when the job leaves a running state (for tests). */
  done: Promise<void>;
}

const jobs = new Map<string, InternalJob>();

/** Test hook: clear the job store. */
export function _resetHarnessJobs(): void {
  jobs.clear();
}

/** Test hook: resolves when the given job's async run has settled. */
export function _awaitHarnessJob(jobId: string): Promise<void> {
  return jobs.get(jobId)?.done ?? Promise.resolve();
}

function toPublic(job: InternalJob): HarnessUpdateJob {
  return {
    jobId: job.jobId,
    provider: job.provider,
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    log: [...job.log],
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    error: job.error ? { ...job.error } : null,
  };
}

/** Returns the public view of a job, or null when unknown. */
export function getHarnessUpdateJob(jobId: string): HarnessUpdateJob | null {
  const job = jobs.get(jobId);
  return job ? toPublic(job) : null;
}

/** The active running job id for a harness (for the version-status/409 view). */
export function activeUpdateJobId(provider: string): string | null {
  return activeHarnessJobId(provider);
}

/**
 * A spawn of `runProviderId` must be refused while an update job holds the lease
 * for the harness that owns that run id. Spawn sites call this and surface a
 * generic "provider updating, try again" error.
 */
export function isHarnessSpawnBlocked(runProviderId: string): boolean {
  for (const descriptor of Object.values(HARNESS_UPDATE_DESCRIPTORS)) {
    if (descriptor.runProviders.includes(runProviderId)) {
      return isHarnessLeased(descriptor.id);
    }
  }
  return false;
}

function setJob(job: InternalJob, patch: Partial<InternalJob>): void {
  Object.assign(job, patch);
}

function appendLog(job: InternalJob, line: string): void {
  const trimmed = String(line)
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\b/giu, '[redacted]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/(^|\s)(?:\/[\w.@~+-]+)+(?:\/[\w.@~+:-]+)*/gu, '$1[path]')
    .replace(/(^|\s)[A-Za-z]:[\\/][^\s]*/gu, '$1[path]')
    .slice(0, MAX_LOG_LINE_LEN);
  job.log.push(trimmed);
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
}

function appendOutput(job: InternalJob, result: RunResult): void {
  for (const stream of [result.stdout, result.stderr]) {
    for (const raw of stream.split('\n')) {
      const line = raw.trimEnd();
      if (line !== '') appendLog(job, line);
    }
  }
}

/** Default bounded command runner (spawn + hard timeout + SIGKILL). */
export function runHarnessUpdateCommand(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn> | null = null;
    let groupId: number | null = null;
    const appendBounded = (current: string, chunk: unknown) => {
      const marker = '\n[output truncated]';
      const contentLimit = MAX_CAPTURE_BYTES - marker.length;
      if (current.length >= contentLimit) {
        return current.endsWith(marker) ? current : `${current.slice(0, contentLimit)}${marker}`;
      }
      const next = `${current}${String(chunk)}`;
      return next.length <= contentLimit
        ? next
        : `${next.slice(0, contentLimit)}${marker}`;
    };
    const finish = (code: number | null, quiesced = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, quiesced });
    };
    const waitForGroupDeath = async () => {
      if (!timedOut || groupId === null || process.platform === 'win32') return true;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          process.kill(-groupId, 0);
        } catch {
          return true;
        }
        await new Promise((done) => setTimeout(done, 20));
      }
      return false;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child?.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // Resolve only from close/error below: rollback must not begin while any
      // member of the update process group can still be mutating the install.
    }, opts.timeoutMs);
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      groupId = child.pid ?? null;
    } catch (err) {
      stderr = appendBounded(stderr, err instanceof Error ? err.message : String(err));
      finish(null);
      return;
    }
    child.stdout?.on('data', (b) => {
      stdout = appendBounded(stdout, b.toString());
    });
    child.stderr?.on('data', (b) => {
      stderr = appendBounded(stderr, b.toString());
    });
    child.on('error', (err) => {
      stderr = appendBounded(stderr, err instanceof Error ? err.message : String(err));
      finish(null);
    });
    child.on('close', (code) => {
      void waitForGroupDeath().then((quiesced) => finish(code, quiesced));
    });
  });
}

/**
 * The gate's second leg (item 6): launches this process started outside the
 * presence run registry. In-process children are counted by spawn-admission;
 * the workflow leg runs as a DETACHED systemd user unit (`wf-*.service` →
 * task-runner → `claude -p`) that outlives this process, so it is probed with
 * `systemctl --user list-units`. A probe failure throws and the caller fails
 * CLOSED (treats the harness as busy) rather than updating under a live turn.
 */
async function defaultHasUnregisteredLaunch(providerIds: string[]): Promise<boolean> {
  if (hasLiveHarnessLaunch(providerIds)) return true;
  if (!providerIds.includes('claude')) return false;
  const units = await listAllActiveScopes();
  return units.length > 0;
}

function defaultRunVersion(cmd: string, args: string[]): Promise<string | null> {
  return runHarnessUpdateCommand(cmd, args, { env: cleanSpawnEnv() as NodeJS.ProcessEnv, timeoutMs: 10_000 }).then((r) =>
    r.stdout.trim() !== '' ? r.stdout : r.stderr.trim() !== '' ? r.stderr : null,
  );
}

/**
 * Starts (or short-circuits) an update for `provider`. Resolves with the job's
 * initial public view. Throws AppError for an unknown / non-updatable harness
 * (route → 4xx) and for a lease conflict (route → 409 with activeJobId).
 */
export async function startHarnessUpdate(
  idOrAlias: string,
  options: { userId?: number | null; trigger?: UpdateTrigger; deps?: UpdateServiceDeps } = {},
): Promise<HarnessUpdateJob> {
  const descriptor = getHarnessDescriptor(idOrAlias);
  if (!descriptor) {
    throw new AppError(`Unknown harness "${idOrAlias}".`, {
      code: 'UNKNOWN_HARNESS',
      statusCode: 404,
    });
  }
  if (!descriptor.updatable) {
    throw new AppError(
      `Harness "${descriptor.id}" cannot be updated in place (${descriptor.reason ?? 'not-updatable'}).`,
      { code: 'HARNESS_NOT_UPDATABLE', statusCode: 400 },
    );
  }
  const deps = options.deps ?? {};
  const userId = options.userId ?? null;
  const trigger = options.trigger ?? 'manual';
  const now = deps.now ?? Date.now;
  const pinEnabled = deps.pinEnabled ?? (() => isVendorBinaryPinEnabled());
  const hasLiveSession = deps.hasLiveSession ?? hasActiveRunForProviders;
  const hasUnregisteredLaunch = deps.hasUnregisteredLaunch ?? defaultHasUnregisteredLaunch;
  const audit = deps.audit ?? ((action, metadata, uid) => auditLogDb.record(action, { userId: uid, metadata }));

  const jobId = randomUUID();

  // (item 5) armed pin over a pinned harness → refuse before doing anything.
  if (isHarnessPinRefused(descriptor, pinEnabled)) {
    const job = makeJob(jobId, descriptor.id, userId, trigger, 'refused_pinned', 'done', 100, now);
    job.error = {
      code: 'pinned_refused',
      message: 'This harness is digest-pinned; a signed re-pin (T-1753) is required before it can update.',
      messageAr: 'هذه الواجهة مثبّتة ببصمة رقمية؛ يلزم إعادة تثبيت موقَّعة (T-1753) قبل تحديثها.',
    };
    finishNow(job, now);
    return toPublic(job);
  }

  // Single-flight lease FIRST (TOCTOU): holding it makes spawn-admission refuse
  // every NEW spawn of this harness, so the live-session check below can no
  // longer be outrun by a turn that starts between the check and the lease.
  const acquired = acquireHarnessLease(descriptor.id, jobId, now);
  if ('conflict' in acquired) {
    throw new AppError(`An update for "${descriptor.id}" is already running.`, {
      code: 'HARNESS_UPDATE_IN_PROGRESS',
      statusCode: 409,
      // surfaced to the route so it can return { activeJobId }
      details: { activeJobId: acquired.conflict },
    });
  }
  if (isHarnessRecoveryBlocked(descriptor.id)) {
    releaseHarnessLease(descriptor.id, jobId);
    throw new AppError(`Harness "${descriptor.id}" is blocked after a failed recovery.`, {
      code: 'HARNESS_RECOVERY_FAILED', statusCode: 409,
    });
  }

  // Atomic no-live-session gate across ALL users, taken UNDER the lease. Any
  // already-running turn (registered or not) wins: release and skip.
  let live = false;
  try {
    live = hasLiveSession(descriptor.runProviders)
      || await hasUnregisteredLaunch(descriptor.runProviders);
  } catch {
    // A gate that cannot answer fails CLOSED: never swap bytes under a turn.
    live = true;
  }
  if (live) {
    releaseHarnessLease(descriptor.id, jobId);
    const job = makeJob(jobId, descriptor.id, userId, trigger, 'skipped_live_session', 'done', 100, now);
    appendLog(job, `Skipped: a live ${descriptor.id} session is in progress.`);
    job.error = {
      code: 'live_session_active',
      message: `A live ${descriptor.id} session is in progress; the update was skipped.`,
      messageAr: `توجد جلسة ${descriptor.id} نشطة الآن، فتُخطّي التحديث.`,
    };
    finishNow(job, now);
    return toPublic(job);
  }

  const job = makeJob(jobId, descriptor.id, userId, trigger, 'running', 'preflight', 5, now);
  jobs.set(jobId, job);
  pruneJobs(now());
  audit('harness_update_started', { provider: descriptor.id, trigger }, userId);

  job.done = runUpdate(job, descriptor, deps, audit).finally(() => {
    if (!job.retainLease) releaseHarnessLease(descriptor.id, jobId);
  });

  return toPublic(job);
}

function makeJob(
  jobId: string,
  provider: string,
  userId: number | null,
  trigger: UpdateTrigger,
  status: HarnessUpdateJobStatus,
  phase: HarnessUpdateJobPhase,
  percent: number,
  now: () => number,
): InternalJob {
  return {
    jobId,
    provider,
    status,
    phase,
    percent,
    log: [],
    fromVersion: null,
    toVersion: null,
    error: null,
    userId,
    trigger,
    finished: false,
    finishedAt: null,
    gitRev: null,
    retainLease: false,
    done: Promise.resolve(),
  };
}

/** Stores an already-terminal job (pin refusal / live-session skip). */
function finishNow(job: InternalJob, now: () => number): void {
  job.finished = true;
  job.finishedAt = now();
  job.done = Promise.resolve();
  jobs.set(job.jobId, job);
  pruneJobs(now());
}

/**
 * Bounds the in-memory job store (item 10): finished jobs older than
 * JOB_RETENTION_MS are dropped, then the map is capped at MAX_JOBS by dropping
 * the OLDEST finished entries (insertion order = LRU here; a running job is
 * never evicted, so an active poll can always still find its job).
 */
function pruneJobs(nowMs: number): void {
  for (const [id, job] of jobs) {
    if (job.finished && job.finishedAt !== null && nowMs - job.finishedAt > JOB_RETENTION_MS) {
      jobs.delete(id);
    }
  }
  if (jobs.size <= MAX_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.finished) jobs.delete(id);
  }
}

async function runUpdate(
  job: InternalJob,
  descriptor: HarnessDescriptor,
  deps: UpdateServiceDeps,
  audit: NonNullable<UpdateServiceDeps['audit']>,
): Promise<void> {
  const runCommand = deps.runCommand ?? runHarnessUpdateCommand;
  const runVersion = deps.runVersion ?? defaultRunVersion;
  const cleanEnv = deps.cleanEnv ?? (cleanSpawnEnv as () => NodeJS.ProcessEnv);
  const markRecoveryIntent = deps.markRecoveryIntent ?? markHarnessRecoveryBlocked;
  const clearRecoveryIntent = deps.clearRecoveryIntent ?? clearHarnessRecoveryBlocked;
  const baseEnv: NodeJS.ProcessEnv = cleanEnv();
  let mutationStarted = false;
  let recoveryEnv = baseEnv;
  // Capture the checkout once from the server-owned descriptor. In particular,
  // cleanSpawnEnv intentionally strips HERMES_CHECKOUT_DIR, so re-resolving it
  // later would update one tree and verify/rollback another.
  const gitCheckoutDir = descriptor.installMethod === 'git-shallow'
    ? descriptor.gitCheckoutDir
    : undefined;
  const resolvedBinary = gitCheckoutDir
    ? path.join(gitCheckoutDir, 'venv', 'bin', 'hermes')
    : descriptor.resolveBinary(baseEnv);

  try {
    // The child env is built ONCE and the SAME object is handed to
    // descriptor.updateArgv(env) and to the spawn, so the argv can never be
    // resolved against a different env than the process actually gets.
    const argv: HarnessUpdateArgv | null = descriptor.updateArgv(baseEnv, { gitCheckoutDir });
    if (!argv) {
      failJob(job, 'no_update_argv', 'No update command is defined for this harness.', audit, descriptor);
      return;
    }
    // Descriptor env (TMPDIR=/var/tmp for npm, HERMES_HOME for hermes) wins over
    // the sanitized base — it is code-owned data, never a request field.
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...(argv.env ?? {}) };
    recoveryEnv = env;

    // Capture pre-update version for recovery + audit.
    const fromRaw = await runVersion(resolvedBinary, descriptor.versionArgs);
    job.fromVersion = parseVersionOutput(fromRaw);
    if (!job.fromVersion || !isRecognizedBinary(descriptor, resolvedBinary)) {
      failJob(job, 'installation_unrecognized', 'The installed harness could not be verified.', audit, descriptor);
      return;
    }

    // git-shallow (hermes): capture the exact pre-update commit so recovery can
    // roll the checkout back to the bytes that were running.
    if (descriptor.installMethod === 'git-shallow' && gitCheckoutDir) {
      const rev = await runCommand('git', ['rev-parse', '--verify', 'HEAD'], {
        env,
        cwd: gitCheckoutDir,
        timeoutMs: 30_000,
      });
      const captured = rev.code === 0 ? rev.stdout.trim().split('\n')[0]?.trim() : '';
      if (/^[0-9a-f]{40}$/i.test(captured ?? '')) {
        job.gitRev = captured!;
      } else {
        failJob(job, 'installation_unrecognized', 'The git installation has no exact recoverable revision.', audit, descriptor);
        return;
      }
      const [status, upstream] = await Promise.all([
        runCommand('git', ['status', '--porcelain', '--untracked-files=normal'], {
          env, cwd: gitCheckoutDir, timeoutMs: 30_000,
        }),
        runCommand('git', ['rev-parse', '--verify', '@{upstream}'], {
          env, cwd: gitCheckoutDir, timeoutMs: 30_000,
        }),
      ]);
      if (status.code !== 0 || status.stdout.trim() !== '') {
        failJob(job, 'dirty_installation', 'The git installation has local changes.', audit, descriptor);
        return;
      }
      if (upstream.code !== 0 || !/^[0-9a-f]{40}$/iu.test(upstream.stdout.trim())) {
        failJob(job, 'installation_unrecognized', 'The git installation has no verified upstream.', audit, descriptor);
        return;
      }
    }

    setJob(job, { phase: 'updating', percent: 40 });
    appendLog(job, `Starting ${descriptor.id} update.`);
    try {
      // Durable intent is written before the first install mutation. A crash
      // from this point leaves launches blocked until exact identity is proved.
      markRecoveryIntent(descriptor.id);
    } catch {
      failJob(job, 'recovery_intent_failed', 'The update recovery fence could not be persisted.', audit, descriptor);
      return;
    }
    mutationStarted = true;
    const result = await runCommand(argv.cmd, argv.args, {
      env,
      cwd: argv.cwd,
      timeoutMs: UPDATE_TIMEOUT_MS,
    });
    appendOutput(job, result);

    if (result.timedOut || result.code !== 0) {
      if (result.timedOut && result.quiesced === false) {
        recoveryFailed(job, descriptor, audit, result.code);
        return;
      }
      const reason = result.timedOut ? 'timed out' : `exit code ${result.code}`;
      const recovered = await recover(
        job, descriptor, runCommand, runVersion, env, baseEnv, clearRecoveryIntent, gitCheckoutDir,
      );
      if (!recovered) {
        recoveryFailed(job, descriptor, audit, result.code);
        return;
      }
      failJob(
        job,
        result.timedOut ? 'update_timeout' : 'update_failed',
        `Update ${reason}.`,
        audit,
        descriptor,
        result.code,
      );
      return;
    }

    // Post-update verification.
    setJob(job, { phase: 'verifying', percent: 80 });
    invalidateInstalledVersion(descriptor.id);
    const afterRaw = await runVersion(resolvedBinary, descriptor.versionArgs);
    const toVersion = parseVersionOutput(afterRaw);
    job.toVersion = toVersion;
    if (toVersion === null) {
      // Binary vanished / unreadable after update → recover, fail.
      const recovered = await recover(
        job, descriptor, runCommand, runVersion, env, baseEnv, clearRecoveryIntent, gitCheckoutDir,
      );
      if (!recovered) {
        recoveryFailed(job, descriptor, audit, 0);
        return;
      }
      failJob(job, 'verify_failed', 'Post-update verification failed: no readable version.', audit, descriptor, 0);
      return;
    }

    if (!isVersionAdvance(job.fromVersion, toVersion)) {
      const recovered = await recover(
        job, descriptor, runCommand, runVersion, env, baseEnv, clearRecoveryIntent, gitCheckoutDir,
      );
      if (!recovered) {
        recoveryFailed(job, descriptor, audit, 0);
        return;
      }
      failJob(job, 'update_unverified', 'The updater exited without a provable version advance.', audit, descriptor, 0);
      return;
    }

    // Success requires a provable forward version transition.
    // The installed-version probe cache is dropped so the next status read shows
    // the new version instead of the pre-update one (item 9).
    invalidateInstalledVersion(descriptor.id);
    try {
      clearRecoveryIntent(descriptor.id);
    } catch {
      recoveryFailed(job, descriptor, audit, 0);
      return;
    }
    setJob(job, {
      status: 'succeeded', phase: 'done', percent: 100, error: null,
      finished: true, finishedAt: Date.now(),
    });
    audit('harness_update_succeeded', {
      provider: descriptor.id,
      fromVersion: job.fromVersion,
      toVersion,
      exitCode: 0,
      trigger: job.trigger,
    }, job.userId);
  } catch {
    if (mutationStarted) {
      try {
        const recovered = await recover(
          job, descriptor, runCommand, runVersion, recoveryEnv, baseEnv,
          clearRecoveryIntent, gitCheckoutDir,
        );
        if (!recovered) {
          recoveryFailed(job, descriptor, audit, null);
          return;
        }
      } catch {
        recoveryFailed(job, descriptor, audit, null);
        return;
      }
    }
    failJob(job, 'update_exception', 'Unexpected update failure.', audit, descriptor);
  }
}

function isRecognizedBinary(descriptor: HarnessDescriptor, binary: string): boolean {
  if (!path.isAbsolute(binary)) return false;
  if (descriptor.installMethod !== 'npm-prefix' || !descriptor.npm) return true;
  const prefix = path.resolve(descriptor.npm.prefix);
  const resolved = path.resolve(binary);
  return resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`);
}

function isVersionAdvance(fromVersion: string, toVersion: string): boolean {
  const parse = (value: string): number[] | null => {
    const match = value.match(/\d+(?:\.\d+)+/u);
    return match ? match[0].split('.').map((part) => Number.parseInt(part, 10)) : null;
  };
  const from = parse(fromVersion);
  const to = parse(toVersion);
  if (!from || !to) return false;
  for (let i = 0; i < Math.max(from.length, to.length); i += 1) {
    const left = from[i] ?? 0;
    const right = to[i] ?? 0;
    if (right > left) return true;
    if (right < left) return false;
  }
  return false;
}

/**
 * Per-method recovery (Addendum 3). `env` is the SAME merged env the update ran
 * under, so the npm reinstall keeps TMPDIR=/var/tmp (never tmpfs) and the hermes
 * rollback keeps HERMES_HOME.
 *   - npm-prefix : reinstall the captured previous version into the same prefix.
 *   - git-shallow: `git reset --hard <captured rev>` then `uv pip install -e .`
 *                  into the checkout's own venv.
 *   - native     : ineligible before this function; no exact rollback exists.
 */
async function recover(
  job: InternalJob,
  descriptor: HarnessDescriptor,
  runCommand: NonNullable<UpdateServiceDeps['runCommand']>,
  runVersion: NonNullable<UpdateServiceDeps['runVersion']>,
  env: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv,
  clearRecoveryIntent: (harnessId: string) => void,
  gitCheckoutDir?: string,
): Promise<boolean> {
  if (descriptor.installMethod === 'npm-prefix' && descriptor.npm && job.fromVersion) {
    setJob(job, { phase: 'recovering' });
    const spec = `${descriptor.npm.pkg}@${job.fromVersion}`;
    appendLog(job, `Recovery: reinstalling ${spec}`);
    const result = await runCommand('npm', ['install', '--prefix', descriptor.npm.prefix, spec], {
      env,
      timeoutMs: UPDATE_TIMEOUT_MS,
    });
    appendOutput(job, result);
    if (result.code !== 0 || result.timedOut) return false;
    const restored = parseVersionOutput(await runVersion(descriptor.resolveBinary(baseEnv), descriptor.versionArgs));
    if (restored !== job.fromVersion) return false;
    try {
      clearRecoveryIntent(descriptor.id);
      return true;
    } catch {
      return false;
    }
  }
  if (descriptor.installMethod === 'git-shallow' && gitCheckoutDir && job.gitRev) {
    setJob(job, { phase: 'recovering' });
    const cwd = gitCheckoutDir;
    appendLog(job, `Recovery: git reset --hard ${job.gitRev}`);
    const reset = await runCommand('git', ['reset', '--hard', job.gitRev], {
      env, cwd, timeoutMs: UPDATE_TIMEOUT_MS,
    });
    appendOutput(job, reset);
    if (reset.code !== 0 || reset.timedOut) return false;
    appendLog(job, 'Recovery: uv pip install -e .');
    const reinstall = await runCommand(
      resolveUvBinary(process.env),
      ['pip', 'install', '--python', path.join(cwd, 'venv', 'bin', 'python'), '-e', '.'],
      { env, cwd, timeoutMs: UPDATE_TIMEOUT_MS },
    );
    appendOutput(job, reinstall);
    if (reinstall.code !== 0 || reinstall.timedOut) return false;
    const [revision, restoredRaw] = await Promise.all([
      runCommand('git', ['rev-parse', '--verify', 'HEAD'], { env, cwd, timeoutMs: 30_000 }),
      runVersion(path.join(cwd, 'venv', 'bin', 'hermes'), descriptor.versionArgs),
    ]);
    const restored = revision.code === 0
      && revision.stdout.trim() === job.gitRev
      && parseVersionOutput(restoredRaw) === job.fromVersion;
    if (!restored) return false;
    try {
      clearRecoveryIntent(descriptor.id);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function recoveryFailed(
  job: InternalJob,
  descriptor: HarnessDescriptor,
  audit: NonNullable<UpdateServiceDeps['audit']>,
  exitCode: number | null,
): void {
  job.retainLease = true;
  try {
    markHarnessRecoveryBlocked(descriptor.id);
  } catch {
    // The in-memory lease remains held when durable fail-closed persistence is
    // unavailable; never release admission after an unverified rollback.
  }
  failJob(job, 'recovery_failed', 'The previous harness identity could not be restored.', audit, descriptor, exitCode);
}

/** Arabic renderings of the machine failure codes (UI is ar-first). */
const FAILURE_MESSAGES_AR: Readonly<Record<string, string>> = Object.freeze({
  update_failed: 'فشل تنفيذ أمر التحديث.',
  update_timeout: 'تجاوز التحديث المهلة المحدّدة فأُوقف.',
  verify_failed: 'تعذّر التحقّق بعد التحديث: لا إصدار مقروء.',
  no_update_argv: 'لا أمر تحديث معرَّفاً لهذه الواجهة.',
  update_exception: 'خطأ غير متوقّع أثناء التحديث.',
  installation_unrecognized: 'تعذّر التحقق من طريقة تثبيت أداة التشغيل.',
  dirty_installation: 'يحوي تثبيت Git تعديلات محلية، لذلك رُفض التحديث.',
  update_unverified: 'انتهى أمر التحديث دون إثبات انتقال إلى إصدار أحدث.',
  recovery_intent_failed: 'تعذّر تثبيت حاجز الاسترجاع قبل بدء التحديث.',
  recovery_failed: 'تعذّر استرجاع هوية أداة التشغيل السابقة؛ أُوقفت التشغيلات حتى الإصلاح.',
});

function failJob(
  job: InternalJob,
  code: string,
  message: string,
  audit: NonNullable<UpdateServiceDeps['audit']>,
  descriptor: HarnessDescriptor,
  exitCode: number | null = null,
): void {
  setJob(job, {
    status: 'failed',
    phase: 'done',
    percent: 100,
    error: { code, message, messageAr: FAILURE_MESSAGES_AR[code] ?? 'فشل تحديث الواجهة.' },
    finished: true,
    finishedAt: Date.now(),
  });
  audit('harness_update_failed', {
    provider: descriptor.id,
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    exitCode,
    trigger: job.trigger,
    code,
  }, job.userId);
}
