/**
 * warm-credential-processes — revocation reaches warm sessions (ADR-152 A1 §3.5, AT3).
 *
 * A provider process that outlives its turn (a Claude run held open for a
 * scheduled wake-up or a background task) keeps the credential it was spawned
 * on. When the grant behind it is revoked, declined or its owner disabled, the
 * next turn would still run on the former grantor's credential. Such a process
 * registers here with the principal it was spawned on; at every turn admission
 * (and on every grant change) the principal is resolved again, and a process
 * whose principal no longer matches is terminated before the turn.
 *
 * In-memory only: a warm process does not survive a server restart either.
 */

import { resolveCredentialPrincipal } from './credential-principal.js';

/**
 * A warm process, recorded with the credential UNIT it was admitted under (a
 * Claude run on the glm engine is unit 'glm', own key only) — so a turn on
 * another unit never recomputes it on the wrong one (qa M3).
 * @typedef {{ userId: number, unit: string, ownOnly: boolean, principalId: number,
 *   terminate: (reason: string) => void }} WarmProcess
 */

/** @type {Map<symbol, WarmProcess>} */
const warmProcesses = new Map();

/** The reason handed to `terminate` when the principal changed. */
export const WARM_PRINCIPAL_CHANGED = 'credential-principal-changed';

/**
 * Registers a warm process from its admission (credential-gate.js
 * assertCredentialLinked: principalId, unit, ownOnly). Returns its unregister
 * function (idempotent).
 * @param {{ userId: number, unit: string, ownOnly?: boolean, principalId: number,
 *   terminate: (reason: string) => void }} entry
 * @returns {() => void}
 */
export function registerWarmCredentialProcess(entry) {
  const token = Symbol('warm-credential-process');
  warmProcesses.set(token, {
    userId: Number(entry.userId),
    unit: entry.unit,
    ownOnly: entry.ownOnly === true,
    principalId: Number(entry.principalId),
    terminate: entry.terminate,
  });
  return () => { warmProcesses.delete(token); };
}

/**
 * Terminates every warm process (optionally of one member and/or credential
 * unit) whose freshly resolved principal differs from the one it runs on. An
 * own-key-only process is recomputed as its own member. Never throws: a failed
 * terminate is logged and the entry still dropped.
 * @param {{ userId?: number|string|null, unit?: string|null }} [filter]
 * @returns {number} how many processes were terminated
 */
export function terminateStaleWarmProcesses(filter = {}) {
  const userId = filter.userId === null || filter.userId === undefined ? null : Number(filter.userId);
  let terminated = 0;
  for (const [token, entry] of [...warmProcesses]) {
    if (userId !== null && entry.userId !== userId) continue;
    if (filter.unit && entry.unit !== filter.unit) continue;
    const current = entry.ownOnly
      ? entry.userId
      : Number(resolveCredentialPrincipal(entry.userId, entry.unit).principalId);
    if (current === entry.principalId) continue;
    warmProcesses.delete(token);
    terminated += 1;
    try {
      entry.terminate(WARM_PRINCIPAL_CHANGED);
    } catch (error) {
      console.error('[warm-credential] terminate failed', {
        userId: entry.userId,
        unit: entry.unit,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return terminated;
}

/** Test seam: number of registered warm processes. */
export function countWarmCredentialProcessesForTests() {
  return warmProcesses.size;
}

/** Test seam: forget every registration. */
export function resetWarmCredentialProcessesForTests() {
  warmProcesses.clear();
}
