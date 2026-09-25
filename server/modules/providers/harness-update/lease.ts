/**
 * harness-update lease (T-1749 / ADR-159 item 4) — an INDEPENDENT single-flight
 * lease keyed PER HARNESS. Deliberately NOT the app source-update machinery
 * (`update-writer-lease.js` / `source-update-jobs`): a harness update is a
 * self-contained idempotent CLI reinstall, and reusing the app-update lease
 * would raise the app's `update_maintenance` gate (front-end maintenance banner,
 * blocked chat) for what is a background binary refresh (ADR-159 §Alternatives).
 *
 * Two distinct harnesses may update concurrently; the SAME harness may not. A
 * lease also blocks NEW spawns of that harness (the update service's live-run
 * check + the spawn-admission helper both read `isHarnessLeased`). In-process
 * only — this install runs a single server process.
 */

export interface HarnessLease {
  provider: string;
  jobId: string;
  acquiredAt: number;
}

const leases = new Map<string, HarnessLease>();

/**
 * Acquires the single-flight lease for `provider`. Returns the new lease, or
 * `{ conflict: <existing jobId> }` when one is already held. Never throws.
 */
export function acquireHarnessLease(
  provider: string,
  jobId: string,
  now: () => number = Date.now,
): { lease: HarnessLease } | { conflict: string } {
  const existing = leases.get(provider);
  if (existing) {
    return { conflict: existing.jobId };
  }
  const lease: HarnessLease = { provider, jobId, acquiredAt: now() };
  leases.set(provider, lease);
  return { lease };
}

/** Releases the lease for `provider` IFF it is held by `jobId` (idempotent). */
export function releaseHarnessLease(provider: string, jobId: string): void {
  const existing = leases.get(provider);
  if (existing && existing.jobId === jobId) {
    leases.delete(provider);
  }
}

/** True when an update job currently holds the lease for `provider`. */
export function isHarnessLeased(provider: string): boolean {
  return leases.has(provider);
}

/** The active job id holding the lease, or null. */
export function activeHarnessJobId(provider: string): string | null {
  return leases.get(provider)?.jobId ?? null;
}

/** Test hook: drop every lease. Never used on the request path. */
export function _resetHarnessLeases(): void {
  leases.clear();
}
