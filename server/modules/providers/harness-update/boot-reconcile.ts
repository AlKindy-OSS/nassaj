/**
 * Boot reconcile of harness snapshot jobs (T-1871 stage 3, spec §8 table).
 * Runs in server boot BEFORE spawn admission opens (the listener) and BEFORE
 * the auto-update scheduler starts; while it runs every snapshot-backed
 * harness is held in the reconcile block of spawn-admission.
 *
 * | found                               | action                                     |
 * |-------------------------------------|--------------------------------------------|
 * | no manifest                         | nothing                                    |
 * | snapshotting/snapshotted/recheck    | live == from → snapshot deleted, abandoned; |
 * |                                     | else blocked (snapshot kept, owner alert)  |
 * | mutating/verifying                  | live == from → abandoned; else autoRollback |
 * | recovering/manual_restoring         | resume by restore.phase, then finish       |
 * | fence set, every job terminal       | live == newest end state → fence cleared   |
 *
 * Before any mutating/verifying/recovering/manual_restoring row, the updater
 * group recorded in the manifest is SIGKILLed and proven dead; unprovable →
 * rollback_failed (fence kept, owner alert).
 * | succeeded without a ledger entry    | ledger reads unknown (automatic)           |
 * | rollback_failed / unreadable        | stay blocked (durable fence), owner alert  |
 *
 * A manifest another LIVE Nassaj process is driving (cross-process lock) is
 * left alone. The durable fence of a harness ends set iff one of its jobs is
 * still unresolved; resolving the jobs that owned it clears it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { HARNESS_UPDATE_DESCRIPTORS, type HarnessDescriptor } from './descriptors.js';
import { isHarnessLockedElsewhere } from './harness-lock.js';
import { pruneHarnessSnapshots } from './harness-retention.js';
import { autoRollback, completeRestore, markRollbackFailed } from './restore-engine.js';
import { listHarnessManifests, type FoundManifest } from './rollback.service.js';
import {
  transitionManifest,
  type HarnessSnapshotManifest,
  type ManifestState,
  type VersionFacts,
} from './snapshot/manifest.js';
import { resolveDescriptorBinary, resolveSnapshotRuntime, type SnapshotRuntime } from './snapshot-runtime.js';
import { readLiveFacts } from './snapshot-update.js';
import { clearHarnessReconcilePending, markHarnessReconcilePending } from './spawn-admission.js';

/** Totals of one reconcile pass (ids and counts only). */
export interface ReconcileReport {
  abandoned: number;
  rolledBack: number;
  rollbackFailed: number;
  invalid: number;
  /** Harnesses left blocked (durable fence set). */
  blocked: string[];
  /** Harnesses a live sibling process owns right now. */
  skippedElsewhere: string[];
}

type Outcome = 'none' | 'resolved' | 'blocked';

const UNMUTATED: ReadonlySet<ManifestState> = new Set(['queued', 'preflight', 'snapshotting', 'snapshotted', 'recheck']);
const MUTATED: ReadonlySet<ManifestState> = new Set(['mutating', 'verifying']);
const RESTORABLE: ReadonlySet<ManifestState> = new Set(['mutating', 'verifying', 'recovering', 'manual_restoring']);

function removePayload(dir: string): void {
  for (const sub of ['binary', 'stores']) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
}

function abandonAtBoot(rt: SnapshotRuntime, dir: string, m: HarnessSnapshotManifest, report: ReconcileReport): Outcome {
  removePayload(dir);
  transitionManifest(dir, m, 'abandoned', rt.now());
  report.abandoned += 1;
  return 'resolved';
}

/** True when the live install is exactly `facts` (version, binary and tree). */
async function liveEquals(rt: SnapshotRuntime, d: HarnessDescriptor, facts: VersionFacts | null): Promise<boolean> {
  if (!facts) return false;
  try {
    const layout = d.snapshot!.resolveLayout(resolveDescriptorBinary(d));
    const live = await readLiveFacts(rt, d, layout);
    return live !== null && live.version === facts.version
      && live.binarySha256 === facts.binarySha256 && live.treeSha256 === facts.treeSha256;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * C-1: the updater of a crashed process may still be writing (it runs in its
 * own detached group and outlives the server). A live recorded group is
 * SIGKILLed and polled until proven dead within `updaterDeathWaitMs`.
 * Returns false when death cannot be proven.
 */
async function proveUpdaterDead(rt: SnapshotRuntime, m: HarnessSnapshotManifest): Promise<boolean> {
  const group = m.updater;
  if (!group || !rt.updaterGroup.isAlive(group)) return true;
  try {
    rt.updaterGroup.kill(group);
  } catch {
    return false;
  }
  const deadline = Date.now() + rt.updaterDeathWaitMs;
  while (Date.now() < deadline) {
    await sleep(20);
    if (!rt.updaterGroup.isAlive(group)) return true;
  }
  return false;
}

/** Terminal outcome of a job that cannot be settled safely: kept blocked, owner alerted. */
function blockAtBoot(rt: SnapshotRuntime, d: HarnessDescriptor, dir: string, m: HarnessSnapshotManifest, report: ReconcileReport): Outcome {
  markRollbackFailed(rt, d, dir, m);
  report.rollbackFailed += 1;
  return 'blocked';
}

async function restoreAtBoot(
  rt: SnapshotRuntime, d: HarnessDescriptor, dir: string, m: HarnessSnapshotManifest, report: ReconcileReport,
): Promise<Outcome> {
  const ok = m.state === 'manual_restoring'
    ? await completeRestore(rt, d, dir, m, 'manual')
    : await autoRollback(rt, d, dir, m);
  if (ok) report.rolledBack += 1;
  else report.rollbackFailed += 1;
  return ok ? 'resolved' : 'blocked';
}

/**
 * Applies the §8 table row of one manifest. Unmutated jobs are abandoned only
 * when live == from (else the install moved under the snapshot: blocked,
 * snapshot kept for the owner). Before any row that may restore, the recorded
 * updater group must be proven dead.
 */
async function reconcileOne(
  rt: SnapshotRuntime, d: HarnessDescriptor, dir: string, m: HarnessSnapshotManifest, report: ReconcileReport,
): Promise<Outcome> {
  if (UNMUTATED.has(m.state)) {
    return (await liveEquals(rt, d, m.from)) ? abandonAtBoot(rt, dir, m, report) : blockAtBoot(rt, d, dir, m, report);
  }
  if (!RESTORABLE.has(m.state)) return m.state === 'rollback_failed' ? 'blocked' : 'none';
  if (!(await proveUpdaterDead(rt, m))) return blockAtBoot(rt, d, dir, m, report);
  if (MUTATED.has(m.state) && await liveEquals(rt, d, m.from)) return abandonAtBoot(rt, dir, m, report);
  return restoreAtBoot(rt, d, dir, m, report);
}

const TERMINAL: ReadonlySet<ManifestState> = new Set(['succeeded', 'rolled_back', 'abandoned', 'noop']);

/**
 * M-2: a fence left set by a crash between a terminal manifest write and the
 * fence clear. Cleared only when every job is terminal and the live install is
 * exactly what the newest one ended with (`to` if succeeded, else `from`).
 */
async function settleOrphanFence(rt: SnapshotRuntime, d: HarnessDescriptor, found: FoundManifest[]): Promise<Outcome> {
  if (!safeIsSet(rt, d.id) || found.length === 0) return 'none';
  if (!found.every((f) => f.manifest && TERMINAL.has(f.manifest.state))) return 'none';
  const newest = found.at(-1)!.manifest!;
  const expected = newest.state === 'succeeded' ? newest.to : newest.from;
  return (await liveEquals(rt, d, expected)) ? 'resolved' : 'blocked';
}

function safeIsSet(rt: SnapshotRuntime, harness: string): boolean {
  try {
    return rt.fence.isSet(harness);
  } catch {
    return true;
  }
}

/** Reconciles every job of one harness and settles its durable fence. */
async function reconcileHarness(rt: SnapshotRuntime, d: HarnessDescriptor, report: ReconcileReport): Promise<void> {
  if (isHarnessLockedElsewhere(rt.snapshotRoot, d.id)) {
    report.skippedElsewhere.push(d.id);
    return;
  }
  let blocked = false;
  let resolved = false;
  const all = listHarnessManifests(rt.snapshotRoot, d.id);
  for (const found of all) {
    const outcome: Outcome = found.manifest
      ? await reconcileOne(rt, d, found.dir, found.manifest, report).catch((): Outcome => 'blocked')
      : 'blocked';
    if (!found.manifest) report.invalid += 1;
    blocked ||= outcome === 'blocked';
    resolved ||= outcome === 'resolved';
  }
  if (!blocked && !resolved) {
    const orphan = await settleOrphanFence(rt, d, all);
    blocked = orphan === 'blocked';
    resolved = orphan === 'resolved';
  }
  settleFence(rt, d, report, { blocked, resolved });
}

function settleFence(rt: SnapshotRuntime, d: HarnessDescriptor, report: ReconcileReport, o: { blocked: boolean; resolved: boolean }): void {
  try {
    if (o.blocked) rt.fence.mark(d.id);
    else if (o.resolved) rt.fence.clear(d.id);
  } catch {
    /* an unreadable/unwritable fence reads as blocked in admission */
  }
  if (o.blocked) {
    report.blocked.push(d.id);
    rt.audit('harness_update_rollback_failed', { provider: d.id, ownerAlert: true, at: 'boot' }, null);
  }
  if (o.resolved) rt.audit('harness_reconcile_resolved', { provider: d.id }, null);
}

/**
 * Boot entry. Blocks spawns of every snapshot-backed harness until its row of
 * the table is applied, then prunes (boot retention). Never throws: a harness
 * whose reconcile fails stays blocked by its durable fence.
 */
export async function reconcileHarnessSnapshots(perCall: Partial<SnapshotRuntime> = {}): Promise<ReconcileReport> {
  const rt = resolveSnapshotRuntime(perCall);
  const report: ReconcileReport = { abandoned: 0, rolledBack: 0, rollbackFailed: 0, invalid: 0, blocked: [], skippedElsewhere: [] };
  const harnesses = Object.values(HARNESS_UPDATE_DESCRIPTORS).filter((d) => d.snapshot !== null);
  for (const d of harnesses) markHarnessReconcilePending(d.id);
  for (const d of harnesses) {
    try {
      await reconcileHarness(rt, d, report);
    } catch {
      settleFence(rt, d, report, { blocked: true, resolved: false });
    }
    clearHarnessReconcilePending(d.id);
  }
  try {
    pruneHarnessSnapshots(rt);
  } catch {
    /* retention retries at the next preflight / daily tick */
  }
  return report;
}
