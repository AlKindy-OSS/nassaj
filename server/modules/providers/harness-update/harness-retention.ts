/**
 * Retention runner for harness snapshots (T-1871 spec §11): one call used at
 * preflight, at boot and by the daily scheduler tick. Deletions are audited
 * with harness, jobId, counts and bytes only; a pruned run is also dropped
 * from the spawn ledger (its data-restore facts can no longer be asked for).
 */

import { HARNESS_UPDATE_DESCRIPTORS } from './descriptors.js';
import { pruneSnapshots, type PruneReport } from './snapshot/retention.js';
import { enumerateStoreCoverage, type StoreSpec } from './snapshot/store-backup.js';
import type { SnapshotRuntime } from './snapshot-runtime.js';

/** Every store dir any snapshot-backed harness covers (for orphan aside sweeps). */
function asideSweepDirs(rt: SnapshotRuntime): string[] {
  const specs = new Map<string, StoreSpec>();
  for (const d of Object.values(HARNESS_UPDATE_DESCRIPTORS)) {
    for (const spec of d.snapshot?.stores ?? []) specs.set(spec.id, spec);
  }
  if (specs.size === 0) return [];
  return enumerateStoreCoverage([...specs.values()], rt.home).coverage
    .filter((c) => c.status === 'present')
    .map((c) => c.dir);
}

/** One audited retention pass (all harnesses, or just `harness`). */
export function pruneHarnessSnapshots(rt: SnapshotRuntime, harness?: string): PruneReport {
  return pruneSnapshots({
    root: rt.snapshotRoot,
    harness,
    now: rt.now(),
    asideSweepDirs: asideSweepDirs(rt),
    audit: (event) => {
      rt.audit(event.action, { provider: event.harness, jobId: event.jobId, count: event.count, bytes: event.bytes }, null);
      if (event.action !== 'harness_snapshot_pruned' || !event.harness || !event.jobId) return;
      try {
        rt.ledger.forgetRun(event.harness, event.jobId);
      } catch {
        /* a stale ledger entry only makes a later fact read unknown-free; harmless */
      }
    },
  });
}
