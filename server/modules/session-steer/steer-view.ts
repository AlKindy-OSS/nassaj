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
 * message itself holds for this viewer. Never throws; any doubt → false.
 */
export function describeSteerTurnForViewer(input: SteerViewInput): SteerTurnState {
  const adapter = getMidTurnInjection(input.provider);
  let run: ReturnType<NonNullable<typeof adapter>['findRun']> = null;
  try { run = adapter?.findRun(input.sessionId) ?? null; } catch { run = null; }
  const starterUserId = asUserId(run?.starterUserId ?? input.runStarterUserId);
  const viewer = asUserId(input.viewerUserId);
  let steerable = false;
  try {
    steerable = Boolean(run && !run.isClosed() && run.hooksArmed() && run.permissionMode() !== 'plan'
      && viewer !== null && starterUserId !== null && viewer !== starterUserId
      && input.isWritable(input.sessionId, viewer) && isSteeringAllowedFor(starterUserId).allowed);
  } catch {
    steerable = false;
  }
  return {
    type: 'steer-turn-state',
    sessionId: input.sessionId,
    turnId: run ? run.turnId : null,
    starterUserId,
    steerable,
    forViewerUserId: viewer,
    capability: { midTurnInjection: adapter !== null },
  };
}
