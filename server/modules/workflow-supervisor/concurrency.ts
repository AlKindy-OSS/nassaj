/**
 * Per-user workflow-scope concurrency cap (ADR-053 §ج-4).
 *
 * WHY A NEW COMPONENT (not the runner's flock)
 * --------------------------------------------
 * The minwal runner serializes to ONE cycle globally via a single flock — there
 * is no notion of a per-user count. Interactive, multi-user workflows need
 * concurrency > 1, so unbounded parallel `claude -p` scopes would exhaust host
 * memory (the 2026-06-06 OOM lesson). This module counts the user's currently
 * ACTIVE scopes and rejects (or lets the caller queue) an (N+1)th launch.
 *
 * SOURCE OF TRUTH = live systemd, not an in-memory tally
 * ------------------------------------------------------
 * The count is derived from the live scope units (`wf-*.scope`) tagged with the
 * owning user, so a supervisor restart or a scope that died out-of-band cannot
 * desync a counter. The unit lister is injected (real: `systemctl --user
 * list-units`; test: a stub) so the gate is deterministic in tests. Fail-safe:
 * if the lister throws we treat the user as AT capacity (deny), never as empty —
 * a monitoring failure must not open the floodgate.
 */

import { maxConcurrentPerUser, maxConcurrentGlobal } from './config.js';

/** Returns the set of active `wf-*.scope` unit names owned by `userId`. */
export type ActiveScopeLister = (userId: number) => Promise<string[]>;

/** Returns the set of ALL active `wf-*.service` unit names (host-wide). */
export type AllActiveScopeLister = () => Promise<string[]>;

export type AdmissionResult =
  | { admit: true; active: number; cap: number }
  | { admit: false; active: number; cap: number; reason: string };

/**
 * Decide whether one more scope may launch for `userId`. ALLOW when the user's
 * active scope count is strictly below the cap; DENY otherwise. Fail-closed: a
 * throwing lister yields DENY (treated as at-capacity), never an accidental
 * ALLOW.
 *
 * @param userId       real integer user id
 * @param listActive   injected live-scope lister
 * @param env          for reading the cap (test seam)
 */
export async function admitLaunch(
  userId: number,
  listActive: ActiveScopeLister,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdmissionResult> {
  const cap = maxConcurrentPerUser(env);

  let active: number;
  try {
    const units = await listActive(userId);
    active = units.length;
  } catch {
    // Cannot enumerate => assume saturated. Never launch into an unknown state.
    return {
      admit: false,
      active: cap,
      cap,
      reason: 'could not enumerate active scopes (fail-closed deny)',
    };
  }

  if (active < cap) {
    return { admit: true, active, cap };
  }
  return {
    admit: false,
    active,
    cap,
    reason: `per-user concurrency cap reached (${active}/${cap})`,
  };
}

/**
 * HOST-WIDE admission gate (§ج-5, الشرط 7). Applied AFTER the per-user gate so a
 * launch that is fine for the user but would exceed the host's total capacity is
 * QUEUED rather than launched into OOM. ALLOW when the total active scope count
 * is strictly below the global cap; DENY otherwise. Fail-closed: a throwing
 * lister yields DENY (treated as at-capacity), never an accidental ALLOW.
 *
 * @param listAllActive injected live host-wide scope lister
 * @param env           for reading the cap (test seam)
 */
export async function admitLaunchGlobal(
  listAllActive: AllActiveScopeLister,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdmissionResult> {
  const cap = maxConcurrentGlobal(env);

  let active: number;
  try {
    const units = await listAllActive();
    active = units.length;
  } catch {
    // Cannot enumerate => assume saturated. Never launch into an unknown state.
    return {
      admit: false,
      active: cap,
      cap,
      reason: 'could not enumerate host-wide active scopes (fail-closed deny)',
    };
  }

  if (active < cap) {
    return { admit: true, active, cap };
  }
  return {
    admit: false,
    active,
    cap,
    reason: `global concurrency cap reached (${active}/${cap})`,
  };
}
