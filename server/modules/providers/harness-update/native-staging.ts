/**
 * Native self-updater staging (T-1873, qa HIGH): kimi-code's `kimi update`
 * does NOT replace the binary. It downloads into `<bin dir>/.staging/`
 * (`staged.json` + the new exe) and the swap (old → `kimi.bak`, staged → kimi,
 * re-exec) happens at the start of the NEXT run of ANY kimi command — and a
 * manual stage applies even with KIMI_CODE_NO_AUTO_UPDATE=1 (measured from the
 * live 2.1.1 binary: maybeRelaunchWithStagedNativeUpdate).
 *
 * A stage left behind would therefore be swapped in by the first member run,
 * outside the update lease and the snapshot — defeating rollback, button-only
 * updates and (with the digest pin on) verifying the bytes that actually run.
 * Nassaj owns the only update path, so a pending stage outside its update
 * window is never legitimate: it is applied inside the lease right after an
 * update, and removed everywhere else (restore, launch).
 */

import fs from 'node:fs';
import path from 'node:path';

import { isHarnessLeased } from './lease.js';

/** kimi-code's staging dir for an exe (`getNativeStagingDir`). */
export function nativeStagingDir(binaryPath: string): string {
  return path.join(path.dirname(binaryPath), '.staging');
}

/** Staging records that would make the next run swap: staged.json and swap claims. */
export function pendingNativeStage(binaryPath: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(nativeStagingDir(binaryPath));
  } catch {
    return [];
  }
  return entries.filter((entry) => entry === 'staged.json' || entry.startsWith('staged.json.swap-')).sort();
}

/**
 * Removes the whole staging dir (records and staged exes). A symlinked
 * `.staging` is unlinked, never followed. Returns true when something was removed.
 */
export function clearNativeStaging(binaryPath: string): boolean {
  const dir = nativeStagingDir(binaryPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fs.rmSync(dir, { force: true });
  else fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Throws when a stage is still pending (post-update / post-restore proof). */
export function assertNoPendingNativeStage(binaryPath: string): void {
  const pending = pendingNativeStage(binaryPath);
  if (pending.length > 0) {
    throw new Error(`native updater stage still pending (${pending.join(', ')})`);
  }
}

/**
 * Launch guard for a harness with a native staging updater: outside a Nassaj
 * update window (no lease on `harnessId`), any staging is removed before the
 * binary runs, so a launch can never swap in unverified, un-snapshotted bytes.
 * Returns true when a stale stage was removed (the caller may log it).
 */
export function clearStaleNativeStageBeforeLaunch(harnessId: string, binaryPath: string): boolean {
  if (isHarnessLeased(harnessId)) return false;
  const removed = clearNativeStaging(binaryPath);
  if (removed) {
    console.warn('[harness-update] removed a native update stage left outside a Nassaj update', {
      harness: harnessId,
    });
  }
  return removed;
}

/**
 * Removes a pending stage before a `--version` probe of a staging harness:
 * the probe itself would otherwise perform the swap. Every probe outside the
 * update's own forced swap (the from-facts, the indicator, restore proofs and
 * recovery acknowledgements) goes through here.
 */
export function clearStageBeforeProbe(d: { stagesNativeUpdate?: boolean }, binaryPath: string): void {
  if (d.stagesNativeUpdate && binaryPath) clearNativeStaging(binaryPath);
}
