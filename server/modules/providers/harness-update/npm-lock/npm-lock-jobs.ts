/**
 * Owner update and rollback jobs of an npm-lock harness (T-2086 S4, ADR-224).
 * Same gates as every other harness job, in the same order: the harness lease
 * FIRST (it blocks new launches through spawn-admission), the durable recovery
 * fence, then the cross-user live-session gate; the fence is set for the whole
 * mutation and cleared only once the active version is proven.
 *
 *   update   → install the reviewed target pin beside the current one, switch.
 *   rollback → switch back to the kept previous version after a full re-check.
 *
 * Rollback offers are listed in the snapshot list shape: the kept previous
 * version is the "snapshot" (`jobId` = `npm-lock-version:<v>`).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { AppError } from '@/shared/utils.js';

import type { HarnessSnapshotSummary, HarnessUpdateJob } from '../../../../../shared/harness-update.contract.js';
import type { HarnessDescriptor } from '../descriptors.js';
import { buildInstallEnv } from '../install.service.js';
import { acquireHarnessLease, releaseHarnessLease } from '../lease.js';
import type { SnapshotRuntime } from '../snapshot-runtime.js';
import { assertNotRecoveryBlocked, liveSessionBlocker, skippedLiveSessionJob } from '../snapshot-update.js';
import {
  appendLog, failJob, finishJob, makeJob, setJob, storeJob, toPublic, type InternalJob, type UpdateTrigger,
} from '../update-jobs.js';
import { invalidateInstalledVersion } from '../version-status.service.js';

import { updateDshThroughPipeline } from './dsh-pipeline-update.js';
import { rollbackCandidate, rollbackNpmLock, type NpmLockContext, type NpmLockSwitch } from './npm-lock-install.js';
import { activeNpmLockSource } from './npm-lock-source.js';
import { currentVersion, loadReviewedPin, NpmLockError, versionDir } from './pins.js';

/** The rollback offer id of kept version `v`. */
const OFFER_PREFIX = 'npm-lock-version:';

/** Parent of the private npm job dir (never tmpfs). */
const NPM_LOCK_STAGING_PARENT = '/var/tmp';

function npmLockContext(rt: SnapshotRuntime, job: InternalJob): NpmLockContext {
  return {
    home: rt.home,
    runCommand: rt.runCommand,
    runVersion: rt.runVersion,
    buildEnv: (home) => buildInstallEnv(rt.cleanEnv(), home),
    stagingParent: NPM_LOCK_STAGING_PARENT,
    log: (line) => appendLog(job, line),
    onLine: (line) => appendLog(job, line),
  };
}

/** Ends the job from a verified switch (noop when nothing moved). */
function settleSwitch(rt: SnapshotRuntime, d: HarnessDescriptor, job: InternalJob, sw: NpmLockSwitch): void {
  job.toVersion = sw.toVersion;
  for (const v of sw.pruned) appendLog(job, `Removed old version ${v} (two versions are kept).`);
  if (sw.fromVersion === sw.toVersion) {
    appendLog(job, `${d.id} is already at the reviewed version ${sw.toVersion}.`);
    finishJob(job, 'noop');
    rt.audit('harness_update_noop', { provider: d.id, version: sw.toVersion, trigger: job.trigger }, job.userId);
    return;
  }
  try {
    rt.recordVersionChange(d.id, sw.toVersion);
  } catch {
    /* ledger unavailable — drift may be over-reported once, never hidden */
  }
  appendLog(job, `${d.id} ${sw.fromVersion ?? 'none'} → ${sw.toVersion}`);
  setJob(job, { status: 'succeeded', phase: 'done', percent: 100, error: null, finished: true, finishedAt: rt.now() });
  rt.audit('harness_update_succeeded', {
    provider: d.id, fromVersion: sw.fromVersion, toVersion: sw.toVersion, pruned: sw.pruned, trigger: job.trigger,
  }, job.userId);
}

/** The job body: fence → mutation → proof → fence cleared; a doubtful end keeps it. */
async function runNpmLockJob(
  rt: SnapshotRuntime,
  d: HarnessDescriptor,
  job: InternalJob,
  mutate: (ctx: NpmLockContext) => Promise<NpmLockSwitch>,
): Promise<void> {
  try {
    rt.fence.mark(d.id);
  } catch {
    failJob(job, 'recovery_intent_failed', 'The update recovery fence could not be persisted.', rt.audit);
    return;
  }
  setJob(job, { phase: 'updating', percent: 30 });
  try {
    const sw = await mutate(npmLockContext(rt, job));
    invalidateInstalledVersion(d.id);
    rt.fence.clear(d.id);
    settleSwitch(rt, d, job, sw);
  } catch (error) {
    invalidateInstalledVersion(d.id);
    const known = error instanceof NpmLockError && error.jobCode !== 'recovery_failed';
    if (!known) {
      job.retainLease = true;
      failJob(job, 'recovery_failed', 'The previous harness identity could not be restored.', rt.audit);
      return;
    }
    rt.fence.clear(d.id);
    appendLog(job, `Failed (${error.causeCode}); the active version was not changed.`);
    failJob(job, error.jobCode, `The ${d.id} job failed (${error.jobCode}).`, rt.audit);
  }
}

/** Lease → fence check → live-session gate → background job (update or rollback). */
async function startNpmLockJob(
  d: HarnessDescriptor,
  rt: SnapshotRuntime,
  opts: { userId: number | null; trigger: UpdateTrigger },
  mutate: (ctx: NpmLockContext) => Promise<NpmLockSwitch>,
): Promise<HarnessUpdateJob> {
  const jobId = randomUUID();
  const lease = acquireHarnessLease(d.id, jobId, rt.now);
  if ('conflict' in lease) {
    throw new AppError(`An update for "${d.id}" is already running.`, {
      code: 'HARNESS_UPDATE_IN_PROGRESS', statusCode: 409, details: { activeJobId: lease.conflict },
    });
  }
  try {
    assertNotRecoveryBlocked(rt, d.id);
  } catch (error) {
    releaseHarnessLease(d.id, jobId);
    throw error;
  }
  const blocker = await liveSessionBlocker(rt, d);
  if (blocker) {
    releaseHarnessLease(d.id, jobId);
    return skippedLiveSessionJob(rt, d, jobId, opts.userId, opts.trigger, blocker);
  }
  const job = makeJob(jobId, d.id, opts.userId, opts.trigger, 'running', 'preflight', 5);
  job.fromVersion = currentVersion(activeNpmLockSource(), rt.home);
  storeJob(job, rt.now());
  rt.audit('harness_update_started', { provider: d.id, trigger: opts.trigger }, opts.userId);
  job.done = runNpmLockJob(rt, d, job, mutate).finally(() => {
    if (!job.retainLease) releaseHarnessLease(d.id, jobId);
  });
  return toPublic(job);
}

/** Owner update: the reviewed pin on first install, then the auto-verified pipeline (T-2091). */
export function startNpmLockUpdate(
  d: HarnessDescriptor,
  rt: SnapshotRuntime,
  opts: { userId: number | null; trigger: UpdateTrigger },
): Promise<HarnessUpdateJob> {
  // T-2091: after the first install, the update runs the staged, contract-checked pipeline.
  return startNpmLockJob(d, rt, opts, (ctx) => updateDshThroughPipeline(activeNpmLockSource(), ctx));
}

/** Owner rollback to the kept previous version; `offerId` must name it (else 404). */
export function startNpmLockRollback(
  d: HarnessDescriptor,
  rt: SnapshotRuntime,
  opts: { userId: number | null; offerId: unknown },
): Promise<HarnessUpdateJob> {
  const previous = rollbackCandidate(activeNpmLockSource(), rt.home);
  if (!previous || opts.offerId !== `${OFFER_PREFIX}${previous}`) {
    throw new AppError('No kept version to roll back to.', { code: 'SNAPSHOT_NOT_FOUND', statusCode: 404 });
  }
  return startNpmLockJob(d, rt, { userId: opts.userId, trigger: 'manual' },
    (ctx) => rollbackNpmLock(activeNpmLockSource(), ctx));
}

/** The rollback offer (kept previous version) in the snapshot-list shape; [] when none. */
export function listNpmLockRollbackOffers(home: string): HarnessSnapshotSummary[] {
  const source = activeNpmLockSource();
  const previous = rollbackCandidate(source, home);
  if (!previous) return [];
  let bytes = 0;
  try {
    bytes = loadReviewedPin(source, home, previous).manifest.totalBytes;
  } catch {
    return [];
  }
  return [{
    jobId: `${OFFER_PREFIX}${previous}`,
    createdAt: fs.lstatSync(versionDir(source, home, previous)).mtimeMs,
    expiresAt: Number.MAX_SAFE_INTEGER,
    fromVersion: previous,
    toVersion: currentVersion(source, home),
    state: 'succeeded',
    storeCount: 0,
    bytes,
    dataRestore: { requiresAck: false, firstSpawnAt: null, spawnCount: 0, storesChanged: null, unknown: false },
  }];
}
