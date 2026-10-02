/**
 * Snapshot-backed harness job (T-1871 stage 3, spec §8) — the state machine
 * shared by "update" and "restore compatible version":
 *
 *   preflight [lease + cross-process lock; spawns blocked; live-session gate;
 *              prune; layout; open-handle scan; disk guard + count cap;
 *              read `from` AFTER the lease]                     (in the request)
 *   → snapshotting → snapshotted → recheck (PREFLIGHT_CHANGED)
 *   → mutating [durable recovery intent BEFORE the mutation] → verifying
 *   → succeeded | noop | recovering → rolled_back | rollback_failed
 *
 * Preflight refusals are HTTP errors (409/423/507); everything after the 202
 * is reported on the job. `rollback_failed` keeps the lease, the lock and the
 * durable fence of THAT harness only.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { UserUnitProbeError } from '@/modules/workflow-supervisor/index.js';
import { AppError } from '@/shared/utils.js';

import type { HarnessUpdateJob } from '../../../../shared/harness-update.contract.js';

import { clearStageBeforeProbe } from './native-staging.js';
import { parseVersionOutput, type HarnessDescriptor } from './descriptors.js';
import { acquireHarnessFileLock, releaseHarnessFileLock, updaterGroupOf } from './harness-lock.js';
import { pruneHarnessSnapshots } from './harness-retention.js';
import { acquireHarnessLease, releaseHarnessLease } from './lease.js';
import { autoRollback, markRollbackFailed } from './restore-engine.js';
import {
  estimateBinarySnapshotBytes,
  liveBinaryFingerprint,
  takeBinarySnapshot,
  type BinaryLayoutSpec,
} from './snapshot/binary-snapshot.js';
import { snapshotError } from './snapshot/errors.js';
import {
  transitionManifest,
  writeManifest,
  type HarnessSnapshotManifest,
  type ManifestKind,
  type VersionFacts,
} from './snapshot/manifest.js';
import { uncheckedDetailsOf } from './snapshot/open-handles.js';
import { ensurePrivateDir, jobSnapshotDir } from './snapshot/paths.js';
import { assertDiskHeadroom, assertSnapshotCountWithinCap, SNAPSHOT_MAX_AGE_MS } from './snapshot/retention.js';
import {
  backupStores,
  enumerateStoreCoverage,
  estimateStoreBackupBytes,
  storeCheckPaths,
  storesFingerprint,
  type StoreCoverage,
} from './snapshot/store-backup.js';
import { resolveDescriptorBinary, type SnapshotRuntime } from './snapshot-runtime.js';
import {
  appendLog,
  appendOutput,
  failJob,
  finishJob,
  finishNow,
  makeJob,
  setJob,
  storeJob,
  toPublic,
  type InternalJob,
  type RunResult,
  type UpdateTrigger,
} from './update-jobs.js';
import { invalidateInstalledVersion } from './version-status.service.js';

/** Verified outcome of the mutation. */
export type SnapshotVerdict = 'succeeded' | 'noop' | 'rollback';

/** What varies between an update and a restore-compatible job. */
export interface SnapshotMutation {
  kind: ManifestKind;
  mutate(ctx: SnapshotJobContext): Promise<RunResult>;
  judge(from: VersionFacts, to: VersionFacts | null, result: RunResult): SnapshotVerdict;
  onSucceeded?(ctx: SnapshotJobContext): void;
}

/** One running snapshot job. */
export interface SnapshotJobContext {
  rt: SnapshotRuntime;
  descriptor: HarnessDescriptor;
  job: InternalJob;
  layout: BinaryLayoutSpec;
  coverage: StoreCoverage | null;
  dir: string;
  manifest: HarnessSnapshotManifest;
}

/** Lease + cross-process lock of one harness, released together. */
export interface HarnessHold {
  release(): void;
}

/** Takes the in-process lease and the cross-process lock or throws 409 HARNESS_UPDATE_IN_PROGRESS. */
export function holdHarness(rt: SnapshotRuntime, harness: string, jobId: string): HarnessHold {
  const lease = acquireHarnessLease(harness, jobId, rt.now);
  if ('conflict' in lease) throw inProgress(harness, lease.conflict);
  let other: string | null;
  try {
    other = acquireHarnessFileLock(rt.snapshotRoot, harness, jobId);
  } catch (error) {
    releaseHarnessLease(harness, jobId);
    throw error;
  }
  if (other !== null) {
    releaseHarnessLease(harness, jobId);
    throw inProgress(harness, other);
  }
  return {
    release: () => {
      releaseHarnessFileLock(rt.snapshotRoot, harness, jobId);
      releaseHarnessLease(harness, jobId);
    },
  };
}

function inProgress(harness: string, activeJobId: string): AppError {
  return new AppError(`An update for "${harness}" is already running.`, {
    code: 'HARNESS_UPDATE_IN_PROGRESS', statusCode: 409, details: { activeJobId },
  });
}

/** 409 HARNESS_RECOVERY_FAILED while the durable fence of `harness` is set. */
export function assertNotRecoveryBlocked(rt: SnapshotRuntime, harness: string): void {
  let blocked: boolean;
  try {
    blocked = rt.fence.isSet(harness);
  } catch {
    blocked = true;
  }
  if (blocked) {
    throw new AppError(`Harness "${harness}" is blocked after a failed recovery.`, {
      code: 'HARNESS_RECOVERY_FAILED', statusCode: 409,
    });
  }
}

/** Why the live-session gate refused a run (B-1474: the failing leg is named). */
export type LiveBlocker =
  | { kind: 'live_run' | 'live_launch' | 'live_unit' }
  | { kind: 'gate_unverifiable'; leg: 'presence' | 'launch_registry' | 'unit_probe'; cause: string };

/** Short machine cause of a leg failure (never raw stderr). */
function gateCause(error: unknown): string {
  if (error instanceof UserUnitProbeError) return error.reason;
  return 'error';
}

/** Server-side detail of a leg failure, bounded for logs. */
function gateDetail(error: unknown): string {
  if (error instanceof UserUnitProbeError) return error.detail;
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/**
 * The atomic cross-user live-session gate, taken UNDER the lease; fails closed.
 * Returns null when the harness is free, else the blocker (a leg that cannot
 * answer yields `gate_unverifiable` naming that leg).
 */
export async function liveSessionBlocker(rt: SnapshotRuntime, d: HarnessDescriptor): Promise<LiveBlocker | null> {
  try {
    if (rt.hasLiveSession(d.runProviders)) return { kind: 'live_run' };
  } catch (error) {
    return unverifiable('presence', error, d);
  }
  try {
    const launch = await rt.hasUnregisteredLaunch(d.runProviders);
    return launch ? { kind: launch } : null;
  } catch (error) {
    return unverifiable(error instanceof UserUnitProbeError ? 'unit_probe' : 'launch_registry', error, d);
  }
}

function unverifiable(
  leg: 'presence' | 'launch_registry' | 'unit_probe',
  error: unknown,
  d: HarnessDescriptor,
): LiveBlocker {
  const cause = gateCause(error);
  console.warn('[harness-live-gate-unverifiable]', { provider: d.id, leg, cause, detail: gateDetail(error) });
  return { kind: 'gate_unverifiable', leg, cause };
}

function blockerLogLine(d: HarnessDescriptor, blocker: LiveBlocker): string {
  if (blocker.kind === 'gate_unverifiable') {
    return `Skipped: the live-session gate for ${d.id} could not be verified (leg=${blocker.leg}, cause=${blocker.cause}).`;
  }
  return `Skipped: a live ${d.id} session is in progress (kind=${blocker.kind}).`;
}

function blockerError(d: HarnessDescriptor, blocker: LiveBlocker): NonNullable<HarnessUpdateJob['error']> {
  if (blocker.kind === 'gate_unverifiable') {
    return {
      code: 'live_gate_unverifiable',
      message: `Could not verify that no ${d.id} session is active; the update was skipped. Try again later.`,
      messageAr: `تعذّر التحقق من خلوّ ${d.id} من جلسات نشطة، فتُخطّي التحديث. أعد المحاولة لاحقاً.`,
    };
  }
  return {
    code: 'live_session_active',
    message: `A live ${d.id} session is in progress; the update was skipped.`,
    messageAr: `توجد جلسة ${d.id} نشطة الآن، فتُخطّي التحديث.`,
  };
}

/** Terminal `skipped_live_session` job (the scheduler simply retries later). */
export function skippedLiveSessionJob(
  rt: SnapshotRuntime,
  d: HarnessDescriptor,
  jobId: string,
  userId: number | null,
  trigger: UpdateTrigger,
  blocker: LiveBlocker,
): HarnessUpdateJob {
  const job = makeJob(jobId, d.id, userId, trigger, 'skipped_live_session', 'done', 100);
  appendLog(job, blockerLogLine(d, blocker));
  job.error = blockerError(d, blocker);
  finishNow(job, rt.now);
  if (trigger !== 'scheduler') {
    const leg = blocker.kind === 'gate_unverifiable' ? blocker.leg : null;
    const cause = blocker.kind === 'gate_unverifiable' ? blocker.cause : null;
    rt.audit('harness_update_skipped', { provider: d.id, kind: blocker.kind, leg, cause }, userId);
  }
  return toPublic(job);
}

interface Preflight {
  layout: BinaryLayoutSpec;
  coverage: StoreCoverage | null;
}

/** Retention, layout, open-handle scan, disk guard and count cap (throws 409/423/507). */
function preflight(rt: SnapshotRuntime, d: HarnessDescriptor): Preflight {
  const spec = d.snapshot;
  if (!spec) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  pruneHarnessSnapshots(rt, d.id);
  const layout = spec.resolveLayout(resolveDescriptorBinary(d));
  const coverage = spec.stores.length > 0 ? enumerateStoreCoverage([...spec.stores], rt.home) : null;
  if (coverage) rt.assertNoHolders(storeCheckPaths(coverage));
  ensurePrivateDir(rt.snapshotRoot);
  const bytes = estimateBinarySnapshotBytes(layout, rt.snapshotRoot, { deviceOf: rt.deviceOf })
    + (coverage ? estimateStoreBackupBytes(coverage) : 0);
  assertDiskHeadroom(bytes, rt.snapshotRoot, rt.statfs);
  assertSnapshotCountWithinCap(rt.snapshotRoot, d.id);
  return { layout, coverage };
}

/** Live version + digests of the install, or null when the version is unreadable. */
export async function readLiveFacts(rt: SnapshotRuntime, d: HarnessDescriptor, layout: BinaryLayoutSpec): Promise<VersionFacts | null> {
  clearStageBeforeProbe(d, layout.binaryPath);
  const version = parseVersionOutput(await rt.runVersion(layout.binaryPath, d.versionArgs));
  if (!version) return null;
  const fp = liveBinaryFingerprint(layout, () => version);
  return { version, binarySha256: fp.sha256, treeSha256: fp.treeSha256 };
}

function sameFacts(a: VersionFacts, b: VersionFacts | null): boolean {
  return b !== null && a.version === b.version && a.binarySha256 === b.binarySha256 && a.treeSha256 === b.treeSha256;
}

/** Options of one snapshot job start. */
export interface SnapshotJobOptions {
  rt: SnapshotRuntime;
  userId: number | null;
  trigger: UpdateTrigger;
  mutation: SnapshotMutation;
}

/**
 * Runs preflight under the lease and starts the job; resolves with the job's
 * initial public view. Throws AppError for a refusal (nothing was changed).
 */
export async function startSnapshotJob(d: HarnessDescriptor, opts: SnapshotJobOptions): Promise<HarnessUpdateJob> {
  const { rt } = opts;
  const jobId = randomUUID();
  const hold = holdHarness(rt, d.id, jobId);
  try {
    assertNotRecoveryBlocked(rt, d.id);
    const blocker = await liveSessionBlocker(rt, d);
    if (blocker) {
      hold.release();
      return skippedLiveSessionJob(rt, d, jobId, opts.userId, opts.trigger, blocker);
    }
    const pre = preflight(rt, d);
    const from = await readLiveFacts(rt, d, pre.layout);
    const job = makeJob(jobId, d.id, opts.userId, opts.trigger, 'running', 'preflight', 5);
    if (!from) return refuseUnrecognized(rt, job, hold);
    job.fromVersion = from.version;
    const ctx = createContext(rt, d, job, pre, from, opts.mutation.kind);
    storeJob(job, rt.now());
    rt.audit('harness_update_started', { provider: d.id, trigger: opts.trigger, kind: opts.mutation.kind }, opts.userId);
    job.done = runSnapshotJob(ctx, opts.mutation).finally(() => {
      if (!job.retainLease) hold.release();
    });
    return toPublic(job);
  } catch (error) {
    hold.release();
    throw error;
  }
}

function refuseUnrecognized(rt: SnapshotRuntime, job: InternalJob, hold: HarnessHold): HarnessUpdateJob {
  hold.release();
  failJob(job, 'installation_unrecognized', 'The installed harness could not be verified.', rt.audit);
  finishNow(job, rt.now);
  return toPublic(job);
}

function createContext(
  rt: SnapshotRuntime,
  d: HarnessDescriptor,
  job: InternalJob,
  pre: Preflight,
  from: VersionFacts,
  kind: ManifestKind,
): SnapshotJobContext {
  const createdAt = rt.now();
  const manifest: HarnessSnapshotManifest = {
    schema: 1, jobId: job.jobId, harness: d.id, kind, trigger: job.trigger, userId: job.userId,
    createdAt, expiresAt: createdAt + SNAPSHOT_MAX_AGE_MS, state: 'snapshotting',
    stateHistory: [{ state: 'snapshotting', at: createdAt }], from, to: null,
    binary: null, stores: null, restore: null, counted: false,
  };
  const dir = jobSnapshotDir(rt.snapshotRoot, d.id, job.jobId);
  return { rt, descriptor: d, job, layout: pre.layout, coverage: pre.coverage, dir, manifest };
}

/** The async part of the job; never throws. */
async function runSnapshotJob(ctx: SnapshotJobContext, mutation: SnapshotMutation): Promise<void> {
  try {
    if (!takeSnapshot(ctx) || !(await recheck(ctx)) || !enterMutating(ctx)) return;
    const result = await mutation.mutate(ctx);
    appendOutput(ctx.job, result);
    await verifyAndSettle(ctx, mutation, result);
  } catch {
    await settleUnexpected(ctx);
  }
}

/** A failure outside the planned paths: roll back once mutation began, else abandon. */
async function settleUnexpected(ctx: SnapshotJobContext): Promise<void> {
  const mutated = ['mutating', 'verifying', 'recovering'].includes(ctx.manifest.state);
  if (!mutated) {
    abandon(ctx, 'update_exception');
    return;
  }
  await recoverJob(ctx, 'update_exception');
}

function codeOf(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.code : fallback;
}

/** snapshotting → snapshotted; any failure abandons without touching live. */
function takeSnapshot(ctx: SnapshotJobContext): boolean {
  const { rt, job } = ctx;
  setJob(job, { phase: 'snapshotting', percent: 15 });
  try {
    ensurePrivateDir(ctx.dir);
    writeManifest(ctx.dir, ctx.manifest);
    const binary = takeBinarySnapshot(ctx.layout, ctx.dir, { deviceOf: rt.deviceOf });
    const stores = ctx.coverage ? backupStores(ctx.coverage, ctx.dir, rt.assertNoHolders) : null;
    ctx.manifest = transitionManifest(ctx.dir, { ...ctx.manifest, binary, stores }, 'snapshotted', rt.now());
    return true;
  } catch (error) {
    abandon(ctx, codeOf(error, 'snapshot_failed'), error);
    return false;
  }
}

/** Re-fingerprints binary and stores just before the mutation (M-2). */
async function recheck(ctx: SnapshotJobContext): Promise<boolean> {
  const { rt } = ctx;
  ctx.manifest = transitionManifest(ctx.dir, ctx.manifest, 'recheck', rt.now());
  const live = await readLiveFacts(rt, ctx.descriptor, ctx.layout).catch(() => null);
  const stores = ctx.manifest.stores;
  const storesSame = !stores || storesFingerprint(stores.coverage) === stores.preFingerprint;
  if (sameFacts(ctx.manifest.from, live) && storesSame) return true;
  abandon(ctx, 'PREFLIGHT_CHANGED');
  return false;
}

/** Durable recovery intent (fence + manifest `mutating`) BEFORE the mutation. */
function enterMutating(ctx: SnapshotJobContext): boolean {
  const { rt, descriptor } = ctx;
  try {
    rt.fence.mark(descriptor.id);
  } catch {
    abandon(ctx, 'recovery_intent_failed');
    return false;
  }
  ctx.manifest = transitionManifest(ctx.dir, ctx.manifest, 'mutating', rt.now());
  setJob(ctx.job, { phase: 'updating', percent: 40 });
  appendLog(ctx.job, `Starting ${descriptor.id} ${ctx.manifest.kind}.`);
  return true;
}

/**
 * Persists the updater's process group the moment it is spawned (atomic
 * manifest write), so a crash leaves boot reconcile a group to prove dead.
 * A failed write throws; the runner then kills the group (run-command.ts).
 */
export function recordUpdaterGroup(ctx: SnapshotJobContext, pid: number): void {
  ctx.manifest = { ...ctx.manifest, updater: updaterGroupOf(pid) };
  writeManifest(ctx.dir, ctx.manifest);
}

/**
 * Deletes the snapshot payload, records `abandoned` and fails the job. A
 * STORE_ACCESS_UNPROVABLE `cause` forwards its unchecked processes to the job.
 */
function abandon(ctx: SnapshotJobContext, code: string, cause?: unknown): void {
  const { rt } = ctx;
  for (const sub of ['binary', 'stores']) fs.rmSync(path.join(ctx.dir, sub), { recursive: true, force: true });
  try {
    ctx.manifest = transitionManifest(ctx.dir, ctx.manifest, 'abandoned', rt.now());
  } catch {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
  clearFence(ctx);
  const extra = code === 'STORE_ACCESS_UNPROVABLE' && cause instanceof AppError
    ? uncheckedDetailsOf(cause.details) ?? {} : {};
  failJob(ctx.job, code, 'The harness action was abandoned before any change.', rt.audit, null, extra);
}

function clearFence(ctx: SnapshotJobContext): void {
  try {
    ctx.rt.fence.clear(ctx.descriptor.id);
  } catch {
    /* stays blocked: fail closed */
  }
}

function failureCode(result: RunResult, to: VersionFacts | null): string {
  if (result.timedOut) return 'update_timeout';
  if (result.code !== 0) return 'update_failed';
  return to === null ? 'verify_failed' : 'update_unverified';
}

/** verifying → succeeded | noop | recovering. */
async function verifyAndSettle(ctx: SnapshotJobContext, mutation: SnapshotMutation, result: RunResult): Promise<void> {
  const { rt, descriptor, job } = ctx;
  if (result.timedOut && result.quiesced === false) {
    // A writer may still be alive: restoring under it is unsafe. Stay blocked.
    job.retainLease = true;
    markRollbackFailed(rt, descriptor, ctx.dir, ctx.manifest);
    finishJob(job, 'rollback_failed', { code: 'rollback_failed', message: 'The updater could not be stopped; the harness stays blocked.' });
    return;
  }
  ctx.manifest = transitionManifest(ctx.dir, ctx.manifest, 'verifying', rt.now());
  setJob(job, { phase: 'verifying', percent: 80 });
  invalidateInstalledVersion(descriptor.id);
  const to = await readLiveFacts(rt, descriptor, ctx.layout).catch(() => null);
  job.toVersion = to?.version ?? null;
  const verdict = mutation.judge(ctx.manifest.from, to, result);
  if (verdict === 'succeeded' && to) settleSucceeded(ctx, mutation, to);
  else if (verdict === 'noop') settleNoop(ctx);
  else await recoverJob(ctx, failureCode(result, to));
}

/** succeeded: post fingerprint, ledger, version record, fence cleared. */
function settleSucceeded(ctx: SnapshotJobContext, mutation: SnapshotMutation, to: VersionFacts): void {
  const { rt, descriptor, job } = ctx;
  const stores = ctx.manifest.stores ? { ...ctx.manifest.stores, postFingerprint: storesFingerprint(ctx.manifest.stores.coverage) } : null;
  ctx.manifest = transitionManifest(ctx.dir, { ...ctx.manifest, to, stores, counted: true }, 'succeeded', rt.now());
  try {
    rt.ledger.recordUpdateSuccess(descriptor.id, job.jobId, rt.now());
  } catch {
    /* no ledger entry → spawn facts read `unknown` (= spawned) */
  }
  try {
    rt.recordVersionChange(descriptor.id, to.version as string);
  } catch {
    /* drift may be over-reported once, never hidden */
  }
  mutation.onSucceeded?.(ctx);
  clearFence(ctx);
  invalidateInstalledVersion(descriptor.id);
  finishJob(job, 'succeeded');
  rt.audit('harness_update_succeeded', {
    provider: descriptor.id, fromVersion: job.fromVersion, toVersion: to.version, exitCode: 0, trigger: job.trigger,
  }, job.userId);
}

/** noop: same version and bytes — the snapshot is discarded, nothing to roll back. */
function settleNoop(ctx: SnapshotJobContext): void {
  const { rt, descriptor, job } = ctx;
  // Fence first: a crash before the rm leaves a `verifying` manifest whose
  // live == from, which boot abandons; the reverse order could orphan the fence.
  clearFence(ctx);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
  finishJob(job, 'noop');
  rt.audit('harness_update_noop', { provider: descriptor.id, version: job.fromVersion, trigger: job.trigger }, job.userId);
}

/** recovering → rolled_back | rollback_failed. */
async function recoverJob(ctx: SnapshotJobContext, code: string): Promise<void> {
  const { rt, descriptor, job } = ctx;
  setJob(job, { phase: 'recovering', percent: 90 });
  appendLog(job, 'Restoring the previous install from the snapshot.');
  if (await autoRollback(rt, descriptor, ctx.dir, ctx.manifest)) {
    finishJob(job, 'rolled_back', { code, message: 'The action failed; the previous install was restored and verified.' });
    return;
  }
  job.retainLease = true;
  finishJob(job, 'rollback_failed', { code: 'rollback_failed', message: 'The restore could not be verified; this harness stays blocked.' });
}
