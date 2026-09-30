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
 *     `git reset --hard <captured rev>` + `uv pip install -e .`).
 *
 * T-1871 stage 3: a harness whose descriptor carries a `snapshot` spec (claude,
 * codex, agy, cursor, opencode) runs the snapshot state machine instead
 * (snapshot-update.ts): verified snapshot + store backup before the updater,
 * `noop` / `rolled_back` / `rollback_failed` outcomes, server-built acks.
 *
 * The lease also BLOCKS new spawns of that harness while its update runs
 * (`isHarnessSpawnBlocked`) — spawn sites consult it and refuse with a clear,
 * generic error rather than racing the binary swap.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

 
// eslint-disable-next-line boundaries/no-unknown -- the root command service owns the canonical secret-stripping environment.
import { cleanSpawnEnv } from '@/services/command-board-custom.js';
import { HarnessBinaryUnresolvedError } from '@/shared/harness-binaries.js';
import { AppError } from '@/shared/utils.js';

import type { HarnessUpdateJob } from '../../../../shared/harness-update.contract.js';

import {
  getHarnessDescriptor,
  HARNESS_UPDATE_DESCRIPTORS,
  isVersionAdvance,
  npmPrefixInstallArgs,
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
import {
  defaultRunVersion,
  runHarnessUpdateCommand,
  UPDATE_TIMEOUT_MS,
} from './run-command.js';
import { recordJobVersionChange } from './version-drift.js';
import { isHarnessPinRefused, invalidateInstalledVersion } from './version-status.service.js';
import {
  clearHarnessRecoveryBlocked,
  markHarnessRecoveryBlocked,
} from './spawn-admission.js';
import { pinBreakFacts, pinOf, verifyActionAcks } from './acks.js';
import { clearNativeStaging, pendingNativeStage } from './native-staging.js';
import { snapshotError } from './snapshot/errors.js';
import type { VersionFacts } from './snapshot/manifest.js';
import { resolveSnapshotRuntime, type SnapshotRuntime } from './snapshot-runtime.js';
import {
  assertNotRecoveryBlocked,
  hasLiveHarnessSession,
  recordUpdaterGroup,
  skippedLiveSessionJob,
  startSnapshotJob,
  type SnapshotVerdict,
} from './snapshot-update.js';
import {
  appendLog,
  appendOutput,
  failJob,
  finishNow,
  makeJob,
  setJob,
  storeJob,
  toPublic,
  type HarnessAuditFn,
  type InternalJob,
  type RunResult,
  type UpdateTrigger,
} from './update-jobs.js';

export { runHarnessUpdateCommand, UPDATE_TIMEOUT_MS } from './run-command.js';
export {
  _awaitHarnessJob,
  _resetHarnessJobs,
  getHarnessUpdateJob,
  type RunResult,
  type UpdateTrigger,
} from './update-jobs.js';

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
  audit?: HarnessAuditFn;
  now?: () => number;
  /** Test seams for the durable pre-mutation recovery intent. */
  markRecoveryIntent?: (harnessId: string) => void;
  clearRecoveryIntent?: (harnessId: string) => void;
  /** Records a verified job-made version change so it is never reported as drift. */
  recordVersionChange?: (harnessId: string, version: string) => void;
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

/** The descriptor of an updatable harness, else 404 / 400. */
function requireUpdatableDescriptor(idOrAlias: string): HarnessDescriptor {
  const descriptor = getHarnessDescriptor(idOrAlias);
  if (!descriptor) {
    throw new AppError(`Unknown harness "${idOrAlias}".`, { code: 'UNKNOWN_HARNESS', statusCode: 404 });
  }
  if (!descriptor.updatable) {
    throw new AppError(
      `Harness "${descriptor.id}" cannot be updated in place (${descriptor.reason ?? 'not-updatable'}).`,
      { code: 'HARNESS_NOT_UPDATABLE', statusCode: 400 },
    );
  }
  return descriptor;
}

/** Maps the legacy dependency seams onto the shared snapshot runtime. */
function runtimeFromDeps(deps: UpdateServiceDeps): SnapshotRuntime {
  const over: Partial<SnapshotRuntime> = {};
  if (deps.runCommand) over.runCommand = deps.runCommand;
  if (deps.runVersion) over.runVersion = deps.runVersion;
  if (deps.hasLiveSession) over.hasLiveSession = deps.hasLiveSession;
  if (deps.hasUnregisteredLaunch) over.hasUnregisteredLaunch = deps.hasUnregisteredLaunch;
  if (deps.pinEnabled) over.pinArmed = deps.pinEnabled;
  if (deps.cleanEnv) over.cleanEnv = deps.cleanEnv;
  if (deps.audit) over.audit = deps.audit;
  if (deps.now) over.now = deps.now;
  if (deps.recordVersionChange) over.recordVersionChange = deps.recordVersionChange;
  const rt = resolveSnapshotRuntime(over);
  if (deps.markRecoveryIntent || deps.clearRecoveryIntent) {
    rt.fence = {
      mark: deps.markRecoveryIntent ?? rt.fence.mark,
      clear: deps.clearRecoveryIntent ?? rt.fence.clear,
      isSet: rt.fence.isSet,
    };
  }
  return rt;
}

/**
 * Starts (or short-circuits) an update for `provider`. Resolves with the job's
 * initial public view. Throws AppError for an unknown / non-updatable harness
 * (route → 4xx), a lease conflict (409 with activeJobId), a required
 * acknowledgement (409 CONFIRMATION_REQUIRED) and a snapshot preflight refusal
 * (409 / 423 / 507). Snapshot-backed harnesses run the T-1871 state machine;
 * npm / git harnesses keep their exact-version recovery path.
 */
export async function startHarnessUpdate(
  idOrAlias: string,
  options: { userId?: number | null; trigger?: UpdateTrigger; deps?: UpdateServiceDeps; acks?: unknown } = {},
): Promise<HarnessUpdateJob> {
  const descriptor = requireUpdatableDescriptor(idOrAlias);
  const userId = options.userId ?? null;
  const trigger = options.trigger ?? 'manual';
  if (trigger === 'scheduler' && descriptor.manualOnly) {
    throw new AppError(`Harness "${descriptor.id}" updates only from the owner's button.`, {
      code: 'HARNESS_MANUAL_ONLY', statusCode: 409,
    });
  }
  const rt = runtimeFromDeps(options.deps ?? {});
  if (descriptor.snapshot) return startSnapshotUpdate(descriptor, { rt, userId, trigger, acks: options.acks });
  return startLegacyUpdate(descriptor, rt, options.deps ?? {}, userId, trigger);
}

/** Verdict of an update run: noop, a proven version advance, else rollback. */
function judgeUpdate(from: VersionFacts, to: VersionFacts | null, result: RunResult): SnapshotVerdict {
  if (result.timedOut || result.code !== 0 || !to?.version || !from.version) return 'rollback';
  const sameBytes = from.binarySha256 === to.binarySha256 && from.treeSha256 === to.treeSha256;
  if (from.version === to.version && sameBytes) return 'noop';
  return isVersionAdvance(from.version, to.version) ? 'succeeded' : 'rollback';
}

/**
 * Snapshot-backed update: a `pinBreak` acknowledgement is required only while
 * the opt-in digest pin is armed for a pinned harness (the pin table is never
 * modified), then the fixed updater argv runs inside the §8 state machine.
 */
async function startSnapshotUpdate(
  descriptor: HarnessDescriptor,
  opts: { rt: SnapshotRuntime; userId: number | null; trigger: UpdateTrigger; acks: unknown },
): Promise<HarnessUpdateJob> {
  const { rt } = opts;
  const target = rt.pinArmed() && pinOf(descriptor)
    ? await rt.latestVersion(descriptor).catch(() => null)
    : null;
  verifyActionAcks(rt, descriptor, {
    action: 'update', userId: opts.userId, pinBreak: pinBreakFacts(rt, descriptor, target), dataLoss: null, acks: opts.acks,
  });
  const baseEnv = rt.cleanEnv();
  const argv = descriptor.updateArgv(baseEnv);
  // A snapshot harness has no argv only when its launcher is not the measured
  // layout the argv is derived from (codex standalone): refuse as such.
  if (!argv) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...(argv.env ?? {}) };
  return startSnapshotJob(descriptor, {
    rt,
    userId: opts.userId,
    trigger: opts.trigger,
    mutation: {
      kind: 'update',
      mutate: async (ctx) => {
        const run = (cmd: string, args: string[]) => rt.runCommand(cmd, args, {
          env, cwd: argv.cwd, timeoutMs: UPDATE_TIMEOUT_MS, onSpawn: (pid) => recordUpdaterGroup(ctx, pid),
        });
        if (!descriptor.stagesNativeUpdate) return run(argv.cmd, argv.args);
        // A stage left from outside Nassaj must never ride along with this update.
        clearNativeStaging(ctx.layout.binaryPath);
        const result = await run(argv.cmd, argv.args);
        if (result.code !== 0 || result.timedOut) return result;
        return applyNativeStageInLease(ctx.layout.binaryPath, descriptor.versionArgs, result, run);
      },
      judge: judgeUpdate,
    },
  });
}

/**
 * kimi-code stages its update and swaps it in on the NEXT run of the binary.
 * Force that swap here, inside the lease and before verification (which then
 * hashes the bytes that really run); a stage that is still pending afterwards
 * fails the update so the snapshot is restored.
 */
async function applyNativeStageInLease(
  binaryPath: string,
  versionArgs: string[],
  updateResult: RunResult,
  run: (cmd: string, args: string[]) => Promise<RunResult>,
): Promise<RunResult> {
  if (pendingNativeStage(binaryPath).length === 0) return updateResult;
  const swap = await run(binaryPath, versionArgs);
  const combined: RunResult = {
    ...swap,
    stdout: `${updateResult.stdout}${swap.stdout}`,
    stderr: `${updateResult.stderr}${swap.stderr}`,
  };
  if (swap.code !== 0 || swap.timedOut) return combined;
  const pending = pendingNativeStage(binaryPath);
  if (pending.length === 0) return combined;
  return { ...combined, code: 1, stderr: `${combined.stderr}\nnative update stage was not applied (${pending.join(', ')})` };
}

/** npm-prefix / git-shallow update with exact-version recovery (T-1749). */
async function startLegacyUpdate(
  descriptor: HarnessDescriptor,
  rt: SnapshotRuntime,
  deps: UpdateServiceDeps,
  userId: number | null,
  trigger: UpdateTrigger,
): Promise<HarnessUpdateJob> {
  const jobId = randomUUID();
  // (item 5) armed pin over a pinned harness → refuse before doing anything.
  if (isHarnessPinRefused(descriptor, rt.pinArmed)) return refusedPinnedJob(rt, descriptor.id, jobId, userId, trigger);
  // Single-flight lease FIRST (TOCTOU): holding it makes spawn-admission refuse
  // every NEW spawn of this harness, so the live-session check below can no
  // longer be outrun by a turn that starts between the check and the lease.
  const acquired = acquireHarnessLease(descriptor.id, jobId, rt.now);
  if ('conflict' in acquired) {
    throw new AppError(`An update for "${descriptor.id}" is already running.`, {
      code: 'HARNESS_UPDATE_IN_PROGRESS', statusCode: 409, details: { activeJobId: acquired.conflict },
    });
  }
  try {
    assertNotRecoveryBlocked(rt, descriptor.id);
  } catch (error) {
    releaseHarnessLease(descriptor.id, jobId);
    throw error;
  }
  if (await hasLiveHarnessSession(rt, descriptor)) {
    releaseHarnessLease(descriptor.id, jobId);
    return skippedLiveSessionJob(rt, descriptor, jobId, userId, trigger);
  }
  const job = makeJob(jobId, descriptor.id, userId, trigger, 'running', 'preflight', 5);
  storeJob(job, rt.now());
  rt.audit('harness_update_started', { provider: descriptor.id, trigger }, userId);
  job.done = runUpdate(job, descriptor, deps, rt.audit).finally(() => {
    if (!job.retainLease) releaseHarnessLease(descriptor.id, jobId);
  });
  return toPublic(job);
}

function refusedPinnedJob(rt: SnapshotRuntime, provider: string, jobId: string, userId: number | null, trigger: UpdateTrigger): HarnessUpdateJob {
  const job = makeJob(jobId, provider, userId, trigger, 'refused_pinned', 'done', 100);
  job.error = {
    code: 'pinned_refused',
    message: 'This harness is digest-pinned; a signed re-pin (T-1753) is required before it can update.',
    messageAr: 'هذه الواجهة مثبّتة ببصمة رقمية؛ يلزم إعادة تثبيت موقَّعة (T-1753) قبل تحديثها.',
  };
  finishNow(job, rt.now);
  return toPublic(job);
}

async function runUpdate(
  job: InternalJob,
  descriptor: HarnessDescriptor,
  deps: UpdateServiceDeps,
  audit: HarnessAuditFn,
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
    : descriptorBinaryOrEmpty(descriptor);

  try {
    // The child env is built ONCE and the SAME object is handed to
    // descriptor.updateArgv(env) and to the spawn, so the argv can never be
    // resolved against a different env than the process actually gets.
    const argv: HarnessUpdateArgv | null = descriptor.updateArgv(baseEnv, { gitCheckoutDir });
    if (!argv) {
      failJob(job, 'no_update_argv', 'No update command is defined for this harness.', audit);
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
      failJob(job, 'installation_unrecognized', 'The installed harness could not be verified.', audit);
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
        failJob(job, 'installation_unrecognized', 'The git installation has no exact recoverable revision.', audit);
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
        failJob(job, 'dirty_installation', 'The git installation has local changes.', audit);
        return;
      }
      if (upstream.code !== 0 || !/^[0-9a-f]{40}$/iu.test(upstream.stdout.trim())) {
        failJob(job, 'installation_unrecognized', 'The git installation has no verified upstream.', audit);
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
      failJob(job, 'recovery_intent_failed', 'The update recovery fence could not be persisted.', audit);
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
        job, descriptor, runCommand, runVersion, env, clearRecoveryIntent, gitCheckoutDir,
      );
      if (!recovered) {
        recoveryFailed(job, descriptor, audit, result.code);
        return;
      }
      failJob(job, result.timedOut ? 'update_timeout' : 'update_failed', `Update ${reason}.`, audit, result.code);
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
        job, descriptor, runCommand, runVersion, env, clearRecoveryIntent, gitCheckoutDir,
      );
      if (!recovered) {
        recoveryFailed(job, descriptor, audit, 0);
        return;
      }
      failJob(job, 'verify_failed', 'Post-update verification failed: no readable version.', audit, 0);
      return;
    }

    if (!isVersionAdvance(job.fromVersion, toVersion)) {
      const recovered = await recover(
        job, descriptor, runCommand, runVersion, env, clearRecoveryIntent, gitCheckoutDir,
      );
      if (!recovered) {
        recoveryFailed(job, descriptor, audit, 0);
        return;
      }
      failJob(job, 'update_unverified', 'The updater exited without a provable version advance.', audit, 0);
      return;
    }

    // Success requires a provable forward version transition.
    // The installed-version probe cache is dropped so the next status read shows
    // the new version instead of the pre-update one (item 9).
    invalidateInstalledVersion(descriptor.id);
    // T-1871: record the change BEFORE the fence clears, so no status read can
    // see the new version without the ledger knowing a job made it. A ledger
    // failure is not an update failure; the worst case is one false drift row.
    try {
      (deps.recordVersionChange ?? recordJobVersionChange)(descriptor.id, toVersion);
    } catch {
      /* ledger unavailable — drift may be over-reported once, never hidden */
    }
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
          job, descriptor, runCommand, runVersion, recoveryEnv,
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
    failJob(job, 'update_exception', 'Unexpected update failure.', audit);
  }
}

/**
 * The registry-resolved binary, or '' when the CLI is not installed ('' is never
 * a recognized binary and reads as "no version").
 */
function descriptorBinaryOrEmpty(descriptor: HarnessDescriptor): string {
  try {
    return descriptor.resolveBinary();
  } catch (error) {
    if (error instanceof HarnessBinaryUnresolvedError) return '';
    throw error;
  }
}

function isRecognizedBinary(descriptor: HarnessDescriptor, binary: string): boolean {
  if (!path.isAbsolute(binary)) return false;
  if (descriptor.installMethod !== 'npm-prefix' || !descriptor.npm) return true;
  const prefix = path.resolve(descriptor.npm.prefix);
  const resolved = path.resolve(binary);
  return resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`);
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
  clearRecoveryIntent: (harnessId: string) => void,
  gitCheckoutDir?: string,
): Promise<boolean> {
  if (descriptor.installMethod === 'npm-prefix' && descriptor.npm && job.fromVersion) {
    setJob(job, { phase: 'recovering' });
    const spec = `${descriptor.npm.pkg}@${job.fromVersion}`;
    appendLog(job, `Recovery: reinstalling ${spec}`);
    const result = await runCommand('npm', npmPrefixInstallArgs(descriptor.npm.prefix, spec), {
      env,
      timeoutMs: UPDATE_TIMEOUT_MS,
    });
    appendOutput(job, result);
    if (result.code !== 0 || result.timedOut) return false;
    const restored = parseVersionOutput(await runVersion(descriptorBinaryOrEmpty(descriptor), descriptor.versionArgs));
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
  audit: HarnessAuditFn,
  exitCode: number | null,
): void {
  job.retainLease = true;
  try {
    markHarnessRecoveryBlocked(descriptor.id);
  } catch {
    // The in-memory lease remains held when durable fail-closed persistence is
    // unavailable; never release admission after an unverified rollback.
  }
  failJob(job, 'recovery_failed', 'The previous harness identity could not be restored.', audit, exitCode);
}
