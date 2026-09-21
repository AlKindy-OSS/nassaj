/**
 * Boot security status (T-1085).
 *
 * When a host-level guard degrades to a warning instead of refusing to boot
 * (single-user posture — see security-posture.js), the risk does not disappear;
 * only the enforcement does. A warning that lives solely in a pm2 log line is a
 * warning nobody reads. This tiny in-memory store keeps every degraded verdict
 * from startup so the authenticated system API can surface it in the UI for as
 * long as the process runs.
 *
 * In-memory ON PURPOSE: the warnings describe THIS process's boot state (its
 * gids, the sockets it could reach). Persisting them would let a stale row
 * outlive the condition and alarm an operator who already fixed the host.
 */

/** @typedef {{ id: string, severity: 'warning'|'info', title: string, detail: string, remediation: string[] }} BootSecurityWarning */

/** @type {Map<string, BootSecurityWarning>} */
const warnings = new Map();

/**
 * Records (or replaces, by id) one degraded-guard verdict.
 * @param {BootSecurityWarning} warning
 */
export function recordBootSecurityWarning(warning) {
  warnings.set(warning.id, { severity: 'warning', ...warning });
}

/** Clears a previously recorded warning (used when a guard re-runs clean). */
export function clearBootSecurityWarning(id) {
  warnings.delete(id);
}

/** @returns {BootSecurityWarning[]} every warning raised during this boot */
export function getBootSecurityWarnings() {
  return [...warnings.values()];
}

/** Test helper: forget everything recorded so far. */
export function resetBootSecurityWarnings() {
  warnings.clear();
}
