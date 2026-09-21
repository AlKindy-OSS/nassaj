/**
 * engine-switch-liveness.service.ts — ADR-099/T-1237.
 *
 * The engine re-stamp route must refuse to move a session that is mid-turn: the
 * environment of a running process cannot be changed, so a switch applied under
 * it would let that turn finish on the OLD vendor while the database claims the
 * new one — the exact drift the pin exists to prevent.
 *
 * The predicate itself lives in `claude-sdk.js`, which is NOT a module and may
 * not be imported from inside one (eslint `boundaries/no-unknown`). So it is
 * INJECTED at the composition root, exactly as the session-activity carrier
 * injects its liveness probes — and for the same reason: the route must mirror
 * the one live registry, never keep a second idea of what is running.
 *
 * FAIL-CLOSED, and in the opposite direction to the activity carrier. That one
 * degrades to "not processing" because an un-wired READ should not throw. This
 * one degrades to "busy", because an un-wired WRITE that assumes the session is
 * idle would corrupt the very state it was asked to protect. A missed injection
 * therefore disables switching — visibly — instead of silently permitting the
 * unsafe case.
 */

/** Answers "is a turn executing (or detached-but-registered) for this session?" */
export type EngineSwitchLivenessProbe = (
  sessionId: string,
) => { busy: boolean; reason: 'live' | 'detached' | null };

let probe: EngineSwitchLivenessProbe | null = null;

/**
 * Wires the probe from the app entry. MUST be the same registry the spawn path
 * reads; passing a re-implementation would fork the truth this mirrors.
 */
export function setEngineSwitchLivenessProbe(next: EngineSwitchLivenessProbe | null): void {
  probe = next ?? null;
}

/** Test seam: drops back to the fail-closed default. */
export function resetEngineSwitchLivenessProbe(): void {
  probe = null;
}

/**
 * @returns `{busy:true, reason:'unwired'}` when no probe was injected — see the
 *   fail-closed note above.
 */
export function isEngineSwitchBlocked(
  sessionId: string,
): { busy: boolean; reason: string | null } {
  if (!probe) return { busy: true, reason: 'unwired' };
  try {
    return probe(sessionId);
  } catch {
    // A throwing probe is an unknown state, and unknown means unsafe here.
    return { busy: true, reason: 'probe-error' };
  }
}
