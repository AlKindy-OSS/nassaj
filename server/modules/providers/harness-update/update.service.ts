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
 *     advance) and rollback on failure.
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

import { AppError } from '@/shared/utils.js';

import type { HarnessUpdateJob } from '../../../../shared/harness-update.contract.js';

import {
  getHarnessDescriptor,
  HARNESS_UPDATE_DESCRIPTORS,
  isVersionAdvance,
  type HarnessDescriptor,
} from './descriptors.js';
import { activeHarnessJobId, isHarnessLeased } from './lease.js';
import { UPDATE_TIMEOUT_MS, type UnregisteredLaunch } from './run-command.js';
import { startNpmLockUpdate } from './npm-lock/npm-lock-jobs.js';
import { pinBreakFacts, pinOf, verifyActionAcks } from './acks.js';
import { snapshotError } from './snapshot/errors.js';
import type { VersionFacts } from './snapshot/manifest.js';
import { resolveSnapshotRuntime, type SnapshotRuntime } from './snapshot-runtime.js';
import {
  recordUpdaterGroup,
  startSnapshotJob,
  type SnapshotVerdict,
} from './snapshot-update.js';
import type { HarnessAuditFn, RunResult, UpdateTrigger } from './update-jobs.js';

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
  hasUnregisteredLaunch?: (providerIds: string[]) => Promise<UnregisteredLaunch>;
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
 * the npm-lock harness (dsh) runs its staged pipeline.
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
  if (descriptor.installMethod === 'npm-lock') return startNpmLockUpdate(descriptor, rt, { userId, trigger });
  if (descriptor.snapshot) return startSnapshotUpdate(descriptor, { rt, userId, trigger, acks: options.acks });
  // Every updatable harness is snapshot-backed or npm-lock since the npm-prefix
  // harness (qwen) was removed (ADR-229); anything else fails closed.
  throw new AppError(`Harness "${descriptor.id}" has no supported update path.`, {
    code: 'HARNESS_NOT_UPDATABLE', statusCode: 400,
  });
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
      mutate: (ctx) => rt.runCommand(argv.cmd, argv.args, {
        env, cwd: argv.cwd, timeoutMs: UPDATE_TIMEOUT_MS, onSpawn: (pid) => recordUpdaterGroup(ctx, pid),
      }),
      judge: judgeUpdate,
    },
  });
}
