/**
 * Per-viewer turn identity (T-1903, E2E blocker). Whenever a socket joins a
 * session that has a live run — of ANY provider — it is told who started the
 * run and whether IT may steer, so a late joiner is never mistaken for the
 * starter (no Stop, no Esc-abort of someone else's turn).
 */

import type { SteerTurnState } from '../../../shared/session-steer.contract.js';

import { isSteeringAllowedFor } from './steer-policy.js';
import { getMidTurnInjection } from './steer-registry.js';

export type SteerViewInput = {
  sessionId: string;
  provider: string | null;
  viewerUserId: number | null;
  /** Launcher of the live run from the provider-neutral run registry, when known. */
  runStarterUserId: number | null;
  isWritable: (sessionId: string, userId: number) => boolean;
};

const asUserId = (value: unknown): number | null => {
  const id = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(id) && (id as number) > 0 ? (id as number) : null;
};

/**
 * The `steer-turn-state` frame for ONE viewer of a live run. `steerable` is
 * true only when every admission precondition that does not depend on the
 * message itself holds for this viewer — for the starter himself that is the
 * admin policy and an armed injection path (consent governs OTHERS); for
 * anyone else policy, the starter's consent AND the run's taint hook.
 * `starterSteerable` says whether the starter may steer his own turn. Never
 * throws; any doubt → false.
 */
export function describeSteerTurnForViewer(input: SteerViewInput): SteerTurnState {
  const adapter = getMidTurnInjection(input.provider);
  let run: ReturnType<NonNullable<typeof adapter>['findRun']> = null;
  try { run = adapter?.findRun(input.sessionId) ?? null; } catch { run = null; }
  const starterUserId = asUserId(run?.starterUserId ?? input.runStarterUserId);
  const viewer = asUserId(input.viewerUserId);
  let steerable = false;
  let starterSteerable = false;
  try {
    const live = Boolean(run && !run.isClosed() && run.permissionMode() !== 'plan' && starterUserId !== null);
    starterSteerable = live && Boolean(run?.injectionArmed())
      && input.isWritable(input.sessionId, starterUserId as number)
      && isSteeringAllowedFor(starterUserId, starterUserId).allowed;
    if (viewer !== null && viewer === starterUserId) {
      steerable = starterSteerable;
    } else {
      steerable = live && viewer !== null && Boolean(run?.taintHookArmed())
        && input.isWritable(input.sessionId, viewer) && isSteeringAllowedFor(starterUserId, viewer).allowed;
    }
  } catch {
    steerable = false;
    starterSteerable = false;
  }
  return {
    type: 'steer-turn-state',
    sessionId: input.sessionId,
    turnId: run ? run.turnId : null,
    starterUserId,
    steerable,
    starterSteerable,
    forViewerUserId: viewer,
    capability: { midTurnInjection: adapter !== null },
  };
}
