/**
 * Owner rollback surfaces of snapshot-backed harnesses (T-1871 stage 3,
 * spec §6, §8, §9, §10; qa conditions 1 and 4):
 *
 *   startManualRollback     restore a succeeded run's snapshot; scope `binary`
 *                           (default) or `binary+data` — data needs a
 *                           `dataLoss` ack when the harness ran since, the
 *                           ledger is unknown, or the stores changed.
 *   startRestoreCompatible  opencode only: install the digest-pinned release
 *                           asset through the same snapshot state machine; the
 *                           path is marked verified only after a real run.
 *   startRecovery           the ONLY exit from `rollback_failed`: `retry` the
 *                           restore, or `acknowledge` a live install that
 *                           answers `--version`. Scoped to that one harness.
 *   listHarnessSnapshots    GET /:id/snapshots (no paths, no member ids).
 *
 * `autoRollback` itself lives in restore-engine.ts (shared with boot reconcile).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

import type {
  HarnessRecoveryAcknowledged,
  HarnessSnapshotSummary,
  HarnessUpdateJob,
} from '../../../../shared/harness-update.contract.js';

import { clearStageBeforeProbe } from './native-staging.js';
import { dataLossFacts, pinBreakFacts, verifyActionAcks } from './acks.js';
import { getHarnessDescriptor, parseVersionOutput, type HarnessDescriptor } from './descriptors.js';
import { releaseHarnessFileLock } from './harness-lock.js';
import { activeHarnessJobId, releaseHarnessLease } from './lease.js';
import { completeRestore } from './restore-engine.js';
import { assertNoOriginConflict, verifyBinarySnapshot } from './snapshot/binary-snapshot.js';
import { snapshotError } from './snapshot/errors.js';
import {
  loadManifest,
  persistRestore,
  transitionManifest,
  type HarnessSnapshotManifest,
  type VersionFacts,
} from './snapshot/manifest.js';
import { harnessSnapshotDir, jobSnapshotDir } from './snapshot/paths.js';
import { resumeStoreRestore, storeCheckPaths } from './snapshot/store-backup.js';
import { resolveDescriptorBinary, resolveSnapshotRuntime, type SnapshotRuntime } from './snapshot-runtime.js';
import {
  assertNotRecoveryBlocked,
  hasLiveHarnessSession,
  holdHarness,
  skippedLiveSessionJob,
  startSnapshotJob,
  type HarnessHold,
  type SnapshotVerdict,
} from './snapshot-update.js';
import {
  finishJob,
  getHarnessUpdateJob,
  makeJob,
  storeJob,
  toPublic,
  type InternalJob,
  type RunResult,
} from './update-jobs.js';
import { invalidateInstalledVersion } from './version-status.service.js';

/** A manifest found on disk (or the fact that it could not be read). */
export type FoundManifest =
  | { dir: string; manifest: HarnessSnapshotManifest }
  | { dir: string; manifest: null };

/** Every job dir of `harness`, oldest first; unreadable manifests are reported, not thrown. */
export function listHarnessManifests(root: string, harness: string): FoundManifest[] {
  const hdir = harnessSnapshotDir(root, harness);
  if (!fs.existsSync(hdir)) return [];
  const found: FoundManifest[] = fs.readdirSync(hdir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(hdir, e.name);
      try {
        return { dir, manifest: loadManifest(dir) };
      } catch {
        return { dir, manifest: null };
      }
    });
  return found.sort((a, b) => (a.manifest?.createdAt ?? 0) - (b.manifest?.createdAt ?? 0));
}

/** The snapshot-backed descriptor of `harness`, else 404 SNAPSHOT_NOT_FOUND. */
function snapshotDescriptor(harness: string): HarnessDescriptor {
  const d = getHarnessDescriptor(harness);
  if (!d?.snapshot) throw snapshotError('SNAPSHOT_NOT_FOUND');
  return d;
}

/** A restorable run: succeeded, unexpired, binary payload present — else 404. */
function loadRollbackTarget(rt: SnapshotRuntime, d: HarnessDescriptor, jobId: unknown): { dir: string; m: HarnessSnapshotManifest } {
  let dir: string;
  let m: HarnessSnapshotManifest;
  try {
    dir = jobSnapshotDir(rt.snapshotRoot, d.id, String(jobId));
    m = loadManifest(dir);
  } catch {
    throw snapshotError('SNAPSHOT_NOT_FOUND');
  }
  const restorable = m.state === 'succeeded' && m.expiresAt > rt.now() && m.binary !== null
    && fs.existsSync(path.join(dir, 'binary'));
  if (!restorable) throw snapshotError('SNAPSHOT_NOT_FOUND');
  return { dir, m };
}

type RollbackScope = 'binary' | 'binary+data';

function parseScope(scope: unknown): RollbackScope {
  if (scope === undefined || scope === 'binary') return 'binary';
  if (scope === 'binary+data') return 'binary+data';
  throw snapshotError('INVALID_ROLLBACK_SCOPE');
}

/** Inputs of a manual rollback request. */
export interface ManualRollbackRequest {
  harness: string;
  jobId: unknown;
  scope: unknown;
  acks: unknown;
  userId: number | null;
}

/**
 * Starts a manual rollback of run `jobId`. Refusals: 404 unknown/expired,
 * 409 SNAPSHOT_TAMPERED | ORIGIN_NAME_CONFLICT | CONFIRMATION_REQUIRED |
 * HARNESS_UPDATE_IN_PROGRESS | HARNESS_RECOVERY_FAILED, 423 store in use.
 */
export async function startManualRollback(req: ManualRollbackRequest, perCall: Partial<SnapshotRuntime> = {}): Promise<HarnessUpdateJob> {
  const d = snapshotDescriptor(req.harness);
  const scope = parseScope(req.scope);
  const rt = resolveSnapshotRuntime(perCall);
  const target = loadRollbackTarget(rt, d, req.jobId);
  verifyBinarySnapshot(target.m.binary!, target.dir);
  assertNoOriginConflict(target.m.binary!);
  verifyActionAcks(rt, d, {
    action: 'rollback',
    userId: req.userId,
    pinBreak: pinBreakFacts(rt, d, target.m.from.version),
    dataLoss: scope === 'binary+data' ? dataLossFacts(rt, d, target.m) : null,
    acks: req.acks,
  });
  const trackingId = randomUUID();
  const hold = holdHarness(rt, d.id, trackingId);
  try {
    assertNotRecoveryBlocked(rt, d.id);
    if (await hasLiveHarnessSession(rt, d)) {
      hold.release();
      return skippedLiveSessionJob(rt, d, trackingId, req.userId, 'manual');
    }
    if (scope === 'binary+data' && target.m.stores) rt.assertNoHolders(storeCheckPaths(target.m.stores));
    return beginManualRestore(rt, d, { ...target, scope, trackingId, hold, userId: req.userId });
  } catch (error) {
    hold.release();
    throw error;
  }
}

/** Fence first, then `manual_restoring` + restore journal, then the async restore. */
function beginManualRestore(
  rt: SnapshotRuntime,
  d: HarnessDescriptor,
  t: { dir: string; m: HarnessSnapshotManifest; scope: RollbackScope; trackingId: string; hold: HarnessHold; userId: number | null },
): HarnessUpdateJob {
  rt.fence.mark(d.id);
  let m = transitionManifest(t.dir, t.m, 'manual_restoring', rt.now());
  m = persistRestore(t.dir, m, {
    kind: 'manual', scope: t.scope, startedAt: rt.now(), phase: 'staging', files: [], dataLossAck: t.scope === 'binary+data',
  });
  const job = makeJob(t.trackingId, d.id, t.userId, 'manual', 'running', 'recovering', 50);
  job.fromVersion = m.to?.version ?? null;
  job.toVersion = m.from.version;
  storeJob(job, rt.now());
  job.done = runRestoreJob(rt, d, t.dir, m, 'manual', job).finally(() => {
    if (!job.retainLease) t.hold.release();
  });
  return toPublic(job);
}

/** Runs a restore and settles the tracking job. */
async function runRestoreJob(
  rt: SnapshotRuntime,
  d: HarnessDescriptor,
  dir: string,
  m: HarnessSnapshotManifest,
  kind: 'auto' | 'manual',
  job: InternalJob,
): Promise<void> {
  const ok = await completeRestore(rt, d, dir, m, kind);
  if (ok) {
    finishJob(job, 'rolled_back');
    return;
  }
  job.retainLease = true;
  finishJob(job, 'rollback_failed', { code: 'rollback_failed', message: 'The restore could not be verified; this harness stays blocked.' });
}

// ---------------------------------------------------------- restore-compatible

function assetResult(code: number): RunResult {
  return { code, stdout: '', stderr: '', timedOut: false, quiesced: true };
}

/** Verdict of a restore-compatible run: the live binary must BE the pin. */
function judgeCompat(pin: { version: string; sha256: string }) {
  return (from: VersionFacts, to: VersionFacts | null, result: RunResult): SnapshotVerdict => {
    if (result.code !== 0 || !to || to.version !== pin.version || to.binarySha256 !== pin.sha256) return 'rollback';
    const unchanged = from.binarySha256 === to.binarySha256 && from.treeSha256 === to.treeSha256;
    return unchanged ? 'noop' : 'succeeded';
  };
}

/**
 * "Restore compatible version" (opencode only; 404 NOT_RESTORE_COMPATIBLE
 * otherwise). The fixed release asset is verified (size, tarball sha, single
 * entry, binary sha == pin, --version == pin) before it replaces the live
 * binary; any failure rolls back from the snapshot.
 */
export async function startRestoreCompatible(
  harness: string,
  opts: { userId: number | null; acks: unknown },
  perCall: Partial<SnapshotRuntime> = {},
): Promise<HarnessUpdateJob> {
  const d = getHarnessDescriptor(harness);
  if (!d?.snapshot || !d.restoreCompatible) throw snapshotError('NOT_RESTORE_COMPATIBLE');
  const rt = resolveSnapshotRuntime(perCall);
  verifyActionAcks(rt, d, { action: 'restore-compatible', userId: opts.userId, pinBreak: null, dataLoss: null, acks: opts.acks });
  return startSnapshotJob(d, {
    rt,
    userId: opts.userId,
    trigger: 'manual',
    mutation: {
      kind: 'restore-compatible',
      mutate: async (ctx) => {
        try {
          await rt.installCompatAsset({
            jobId: ctx.job.jobId,
            spec: rt.compatAsset,
            destPath: ctx.layout.binaryPath,
            readVersion: async (bin) => {
              clearStageBeforeProbe(d, bin);
              return parseVersionOutput(await rt.runVersion(bin, d.versionArgs));
            },
          });
          return assetResult(0);
        } catch {
          return assetResult(1);
        }
      },
      judge: judgeCompat({ version: rt.compatAsset.version, sha256: rt.compatAsset.binarySha256 }),
      onSucceeded: () => rt.compatVerified.set(d.id),
    },
  });
}

// ------------------------------------------------------------------ recovery

/** Newest `rollback_failed` manifest of `harness`, if any. */
function newestFailed(rt: SnapshotRuntime, harness: string): { dir: string; manifest: HarnessSnapshotManifest } | null {
  const failed = listHarnessManifests(rt.snapshotRoot, harness)
    .filter((f): f is { dir: string; manifest: HarnessSnapshotManifest } => f.manifest?.state === 'rollback_failed');
  return failed.at(-1) ?? null;
}

/** Drops a lease kept by a finished `rollback_failed` job (or by a previous process). */
function releaseRetained(rt: SnapshotRuntime, harness: string): void {
  const holder = activeHarnessJobId(harness);
  if (!holder) return;
  const job = getHarnessUpdateJob(holder);
  if (job && (job.status === 'queued' || job.status === 'running')) return;
  releaseHarnessFileLock(rt.snapshotRoot, harness, holder);
  releaseHarnessLease(harness, holder);
}

/**
 * Owner exit from `rollback_failed` (qa condition 1). `acknowledge` accepts
 * the live install once it answers `--version` (manifests → abandoned, fence
 * cleared); `retry` re-runs the restore of the newest failed run as a job.
 * Only the named harness is affected.
 */
export async function startRecovery(
  harness: string,
  opts: { action: unknown; userId: number | null },
  perCall: Partial<SnapshotRuntime> = {},
): Promise<HarnessUpdateJob | HarnessRecoveryAcknowledged> {
  const d = getHarnessDescriptor(harness);
  if (!d) throw snapshotError('SNAPSHOT_NOT_FOUND');
  if (opts.action !== 'retry' && opts.action !== 'acknowledge') throw snapshotError('INVALID_RECOVERY_ACTION');
  const rt = resolveSnapshotRuntime(perCall);
  if (!rt.fence.isSet(d.id)) throw snapshotError('NO_RECOVERY_PENDING');
  releaseRetained(rt, d.id);
  const active = activeHarnessJobId(d.id);
  if (active) {
    throw new AppError(`An action for "${d.id}" is still running.`, {
      code: 'HARNESS_UPDATE_IN_PROGRESS', statusCode: 409, details: { activeJobId: active },
    });
  }
  if (opts.action === 'acknowledge') return acknowledgeRecovery(rt, d, opts.userId);
  const failed = newestFailed(rt, d.id);
  if (!failed) throw snapshotError('NO_RECOVERY_PENDING');
  return retryRecovery(rt, d, failed, opts.userId);
}

/**
 * M-1: a store journal left mid-restore is settled before the owner's
 * acknowledgement (reverted before `swapping`, rolled forward from it) so no
 * store file stays half-swapped or stranded aside. Unsettleable → 409.
 */
function settleJournal(dir: string, m: HarnessSnapshotManifest): HarnessSnapshotManifest {
  const phase = m.restore?.phase;
  if (!m.restore || phase === 'committed' || phase === 'reverted') return m;
  try {
    return resumeStoreRestore(dir, m);
  } catch {
    throw snapshotError('RECOVERY_UNVERIFIED');
  }
}

async function acknowledgeRecovery(rt: SnapshotRuntime, d: HarnessDescriptor, userId: number | null): Promise<HarnessRecoveryAcknowledged> {
  const binary = resolveDescriptorBinary(d);
  clearStageBeforeProbe(d, binary);
  const version = parseVersionOutput(await rt.runVersion(binary, d.versionArgs));
  if (!version) throw snapshotError('RECOVERY_UNVERIFIED');
  const failed = d.snapshot
    ? listHarnessManifests(rt.snapshotRoot, d.id)
      .filter((f): f is { dir: string; manifest: HarnessSnapshotManifest } => f.manifest?.state === 'rollback_failed')
    : [];
  const settled = failed.map((f) => ({ dir: f.dir, manifest: settleJournal(f.dir, f.manifest) }));
  for (const f of settled) transitionManifest(f.dir, f.manifest, 'abandoned', rt.now());
  const abandoned = settled.length;
  rt.fence.clear(d.id);
  invalidateInstalledVersion(d.id);
  rt.audit('harness_recovery_acknowledged', { provider: d.id, version, abandoned }, userId);
  return { provider: d.id, status: 'acknowledged' };
}

async function retryRecovery(
  rt: SnapshotRuntime,
  d: HarnessDescriptor,
  failed: { dir: string; manifest: HarnessSnapshotManifest },
  userId: number | null,
): Promise<HarnessUpdateJob> {
  const trackingId = randomUUID();
  const hold = holdHarness(rt, d.id, trackingId);
  const kind = failed.manifest.restore?.kind === 'manual' ? 'manual' : 'auto';
  let m: HarnessSnapshotManifest;
  try {
    m = transitionManifest(failed.dir, failed.manifest, kind === 'manual' ? 'manual_restoring' : 'recovering', rt.now());
  } catch (error) {
    hold.release();
    throw error;
  }
  const job = makeJob(trackingId, d.id, userId, 'recovery', 'running', 'recovering', 50);
  job.toVersion = m.from.version;
  storeJob(job, rt.now());
  job.done = runRestoreJob(rt, d, failed.dir, m, kind, job).finally(() => {
    if (!job.retainLease) hold.release();
  });
  return toPublic(job);
}

// ------------------------------------------------------------------ listing

/**
 * Listing facts WITHOUT hashing any store (a GET must stay cheap): spawn facts
 * only, `storesChanged: null`. `requiresAck` is a lower bound — the rollback
 * itself re-checks the live stores and may still answer CONFIRMATION_REQUIRED.
 */
function listingFacts(rt: SnapshotRuntime, d: HarnessDescriptor, m: HarnessSnapshotManifest): HarnessSnapshotSummary['dataRestore'] {
  const hasData = m.state === 'succeeded' && (m.stores?.sets.length ?? 0) > 0;
  const spawn = m.state === 'succeeded' ? rt.ledger.spawnFactsSince(d.id, m.jobId) : { firstSpawnAt: null, count: 0, unknown: false };
  return {
    requiresAck: hasData && (spawn.count > 0 || spawn.unknown),
    firstSpawnAt: spawn.firstSpawnAt,
    spawnCount: spawn.count,
    storesChanged: null,
    unknown: spawn.unknown,
  };
}

function summaryOf(rt: SnapshotRuntime, d: HarnessDescriptor, m: HarnessSnapshotManifest): HarnessSnapshotSummary {
  return {
    jobId: m.jobId,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    fromVersion: m.from.version,
    toVersion: m.to?.version ?? null,
    state: m.state,
    storeCount: m.stores?.sets.length ?? 0,
    bytes: (m.binary?.copiedBytes ?? 0) + (m.stores?.totalBytes ?? 0),
    dataRestore: listingFacts(rt, d, m),
  };
}

/** GET /:id/snapshots — newest first; unknown harness → 404, legacy harness → []. */
export function listHarnessSnapshots(harness: string, perCall: Partial<SnapshotRuntime> = {}): HarnessSnapshotSummary[] {
  const d = getHarnessDescriptor(harness);
  if (!d) throw snapshotError('SNAPSHOT_NOT_FOUND');
  if (!d.snapshot) return [];
  const rt = resolveSnapshotRuntime(perCall);
  return listHarnessManifests(rt.snapshotRoot, d.id)
    .flatMap((f) => (f.manifest ? [summaryOf(rt, d, f.manifest)] : []))
    .reverse();
}
