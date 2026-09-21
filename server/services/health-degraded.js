/**
 * ADR-156 WI-6 (T-1718) — the `degraded` signal published on /health.
 *
 * Decision 7 of ADR-156 admits `degraded` on three conditions: it must be
 * visible to EXTERNAL monitoring, visible in the UI, and never a silent
 * reopen. /health is the only route the maintenance-gate middleware lets
 * through while the gate is closed, so it is the one place an outside probe
 * can learn that this node is not serving normally.
 *
 * The derivation is deliberately read-only and total: it never transitions the
 * gate, and an unreadable journal is itself degraded rather than healthy. That
 * fail-closed default is what keeps a node whose journal is missing or corrupt
 * from reporting a clean bill of health — the shape of the 2026-09-11 outage,
 * where the site was 503 while nothing external said why.
 */

/** Reason codes, narrow and stable — consumed by the UI and by monitoring. */
export const DEGRADED_REASONS = Object.freeze({
  MANUAL: 'manual_recovery_required',
  MAINTENANCE: 'source_update_maintenance',
  UNAVAILABLE: 'maintenance_state_unavailable',
  /** ADR-156 ب.5 (WI-12): reopened on the PREVIOUS generation, source unreconciled. */
  SOURCE_STATE: 'source_state_unreconciled',
});

/**
 * @param {() => { state?: string, phase?: string|null, gateClosed?: boolean }} readPublicStatus
 *   The maintenance gate's public projection. Called at most once.
 * @returns {{ degraded: boolean, degradedReason: string|null, degradedPhase: string|null }}
 */
export function resolveDegraded(readPublicStatus) {
  let status;
  try {
    status = typeof readPublicStatus === 'function' ? readPublicStatus() : null;
  } catch {
    status = null;
  }
  if (!status || typeof status !== 'object') {
    return { degraded: true, degradedReason: DEGRADED_REASONS.UNAVAILABLE, degradedPhase: null };
  }
  const phase = typeof status.phase === 'string' ? status.phase : null;
  // MANUAL outranks the generic closed-gate reason: it is the state that does
  // not clear on its own and needs an operator, so it must never be reported
  // as ordinary maintenance in progress.
  if (status.state === 'MANUAL') {
    return { degraded: true, degradedReason: DEGRADED_REASONS.MANUAL, degradedPhase: phase };
  }
  if (status.gateClosed === true) {
    return { degraded: true, degradedReason: DEGRADED_REASONS.MAINTENANCE, degradedPhase: phase };
  }
  // ADR-156 ب.5: the gate can be OPEN and serving while the source tree still
  // sits at the target commit. That node works, but it is NOT reconciled and
  // its next update is blocked, so condition (أ) of decision 7 requires an
  // outside probe to see it. `exitPath` names what clears it; it rides only on
  // this branch, so the authenticated routes that spread this object gain it
  // while public /health keeps publishing the reason code alone (م-9).
  if (typeof status.degraded === 'string' && status.degraded) {
    return {
      degraded: true,
      degradedReason: DEGRADED_REASONS.SOURCE_STATE,
      degradedPhase: phase,
      degradedDetail: status.degraded,
      exitPath: typeof status.exitPath === 'string' ? status.exitPath : null,
    };
  }
  return { degraded: false, degradedReason: null, degradedPhase: null };
}
