/**
 * Restore engine of the snapshot-backed harness flows (T-1871 stage 3,
 * spec §3, §5, §6, §8). Shared by the update job (auto rollback), the manual
 * rollback, owner recovery retries and boot reconcile.
 *
 * A restore completes in a fixed order, each step resumable after a crash:
 *   1. data   — journaled store restore (auto: only when the stores changed
 *               since the backup; manual: only for scope `binary+data`);
 *               an interrupted journal is reverted before `swapping` and
 *               rolled forward from `swapping`;
 *   2. binary — verified snapshot re-materialized / symlinks swapped;
 *   3. proof  — `--version` must equal `from.version` AND the live binary
 *               sha256 must equal `from.binarySha256`.
 * Any failure ends in `rollback_failed`: the durable fence stays set for THAT
 * harness only and the owner is alerted through the audit log.
 */

import fs from 'node:fs';

import { parseVersionOutput, type HarnessDescriptor } from './descriptors.js';
import { assertNoPendingNativeStage, clearNativeStaging } from './native-staging.js';
import { restoreBinary } from './snapshot/binary-snapshot.js';
import { hashFile } from './snapshot/durable-fs.js';
import {
  persistRestore,
  transitionManifest,
  type HarnessSnapshotManifest,
} from './snapshot/manifest.js';
import { restoreStores, resumeStoreRestore, storesFingerprint } from './snapshot/store-backup.js';
import { resolveDescriptorBinary, type SnapshotRuntime } from './snapshot-runtime.js';
import { invalidateInstalledVersion } from './version-status.service.js';

export type RestoreKind = 'auto' | 'manual';

const UNSETTLED = new Set(['staging', 'asiding', 'swapping']);

/** True when this restore must (re)apply the store backup. */
function needsDataRestore(m: HarnessSnapshotManifest, kind: RestoreKind): boolean {
  if (!m.stores || m.stores.sets.length === 0) return false;
  if (kind === 'manual') return m.restore?.scope === 'binary+data';
  return storesFingerprint(m.stores.coverage) !== m.stores.preFingerprint;
}

/** Step 1: finish an interrupted journal, then restore the stores if still needed. */
function restoreData(rt: SnapshotRuntime, dir: string, m: HarnessSnapshotManifest, kind: RestoreKind): HarnessSnapshotManifest {
  let next = m;
  if (next.restore && UNSETTLED.has(next.restore.phase) && next.restore.files.length > 0) {
    next = resumeStoreRestore(dir, next);
  }
  if (next.restore?.phase === 'committed' && next.restore.scope === 'binary+data') return next;
  if (!needsDataRestore(next, kind)) return next;
  return restoreStores(dir, next, kind, {
    now: rt.now(),
    dataLossAck: next.restore?.dataLossAck ?? false,
    assertNoHolders: rt.assertNoHolders,
  });
}

/** Step 3: the restored install must be exactly `from` (version and bytes). */
async function assertRestoredIdentity(rt: SnapshotRuntime, d: HarnessDescriptor, m: HarnessSnapshotManifest): Promise<void> {
  const binaryPath = resolveDescriptorBinary(d);
  invalidateInstalledVersion(d.id);
  const version = parseVersionOutput(await rt.runVersion(binaryPath, d.versionArgs));
  const sha256 = hashFile(fs.realpathSync(binaryPath)).sha256;
  if (version !== m.from.version || sha256 !== m.from.binarySha256) {
    throw new Error('restored harness identity does not match the snapshot');
  }
}

/** Marks the restore committed so retention can later prune its asides. */
function settleRestoreRecord(dir: string, m: HarnessSnapshotManifest): HarnessSnapshotManifest {
  if (!m.restore || !UNSETTLED.has(m.restore.phase)) return m;
  return persistRestore(dir, m, { ...m.restore, phase: 'committed' });
}

/** Terminal failure: fence kept (only this harness), manifest `rollback_failed`, owner alert. */
export function markRollbackFailed(rt: SnapshotRuntime, d: HarnessDescriptor, dir: string, m: HarnessSnapshotManifest): void {
  try {
    rt.fence.mark(d.id);
  } catch {
    /* the retained in-memory lease still blocks this harness */
  }
  try {
    if (m.state !== 'rollback_failed') transitionManifest(dir, m, 'rollback_failed', rt.now());
  } catch {
    /* boot reconcile resumes from the last persisted state */
  }
  rt.audit('harness_update_rollback_failed', { provider: d.id, jobId: m.jobId, ownerAlert: true }, m.userId);
}

/**
 * Completes a restore of the snapshot in `dir` whose manifest is already in
 * `recovering` (auto) or `manual_restoring` (manual). Returns true when the
 * previous install is back and proven; false after `rollback_failed`.
 */
export async function completeRestore(
  rt: SnapshotRuntime,
  d: HarnessDescriptor,
  dir: string,
  manifest: HarnessSnapshotManifest,
  kind: RestoreKind,
): Promise<boolean> {
  let m = manifest;
  try {
    m = restoreData(rt, dir, m, kind);
    if (!m.binary) throw new Error('snapshot has no binary record');
    restoreBinary(m.binary, dir, m.jobId, rt.snapshotRoot);
    // A pending native stage would swap itself in on the proof's own
    // `--version` run (and on every later launch): remove it first.
    if (d.stagesNativeUpdate) clearNativeStaging(resolveDescriptorBinary(d));
    await assertRestoredIdentity(rt, d, m);
    if (d.stagesNativeUpdate) assertNoPendingNativeStage(resolveDescriptorBinary(d));
    m = transitionManifest(dir, settleRestoreRecord(dir, m), 'rolled_back', rt.now());
    rt.fence.clear(d.id);
    recordRestoredVersion(rt, d, m);
    rt.audit('harness_update_rolled_back', { provider: d.id, jobId: m.jobId, kind }, m.userId);
    return true;
  } catch {
    markRollbackFailed(rt, d, dir, m);
    return false;
  }
}

/** The restored `from` version is a Nassaj-made change, never drift. */
function recordRestoredVersion(rt: SnapshotRuntime, d: HarnessDescriptor, m: HarnessSnapshotManifest): void {
  if (!m.from.version) return;
  try {
    rt.recordVersionChange(d.id, m.from.version);
  } catch {
    /* drift may be over-reported once, never hidden */
  }
}

/**
 * Auto rollback of a failed update (spec §8 `recovering`): allowed only while
 * the lease or the durable recovery intent is held — both callers hold one.
 */
export async function autoRollback(
  rt: SnapshotRuntime,
  d: HarnessDescriptor,
  dir: string,
  manifest: HarnessSnapshotManifest,
): Promise<boolean> {
  const m = manifest.state === 'recovering' ? manifest : transitionManifest(dir, manifest, 'recovering', rt.now());
  return completeRestore(rt, d, dir, m, 'auto');
}
