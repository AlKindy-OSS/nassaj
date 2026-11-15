/**
 * ADR-173 rev.3 P1 (always on, no flag): the pure half of "one Claude run per
 * session". claude-sdk.js owns the live maps; this module decides who a run
 * belongs to, which phase it is in, when it counts as stuck, and holds the
 * launch reservations that close the gap between a busy check and the run's
 * registration.
 */

export type ClaudeRunPhase = 'running' | 'post_result' | 'scheduled_wake' | 'launching';

export interface RunActivitySnapshot {
  /** Epoch ms of the last stream event of the run (its start before the first). */
  lastEventAt: number;
  /** tool_use blocks still waiting for their tool_result. */
  openToolUses: number;
  /** The main loop is quiet after a result while the channel is held. */
  quiet: boolean;
  /** CLI tasks (agents, background Bash, workflows) not yet ended. */
  pendingTasks: number;
}

export interface RunActivity {
  observe(message: unknown, taskState: { quiet: boolean; pending: number }): void;
  snapshot(): RunActivitySnapshot;
}

export interface LaunchReservation {
  userId: unknown;
  token: symbol;
  at: number;
}

const DEFAULT_STUCK_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_LAUNCH_RESERVATION_MAX_MS = 180_000;

function positiveIntegerOr(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Silence after which a running turn counts as stuck (CLAUDE_RUN_STUCK_AFTER_MS). */
export function readRunStuckAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerOr(env.CLAUDE_RUN_STUCK_AFTER_MS, DEFAULT_STUCK_AFTER_MS);
}

/** Launch-reservation safety valve (CLAUDE_LAUNCH_RESERVATION_MAX_MS). */
export function readLaunchReservationMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerOr(env.CLAUDE_LAUNCH_RESERVATION_MAX_MS, DEFAULT_LAUNCH_RESERVATION_MAX_MS);
}

/**
 * Whether `senderUserId` is someone other than the run owner. Two anonymous
 * sides (single-user install) are the same user; one anonymous side never is.
 */
export function isForeignRunSender(ownerUserId: unknown, senderUserId: unknown): boolean {
  const ownerKnown = ownerUserId !== null && ownerUserId !== undefined;
  const senderKnown = senderUserId !== null && senderUserId !== undefined;
  if (!ownerKnown && !senderKnown) return false;
  return !ownerKnown || !senderKnown || String(ownerUserId) !== String(senderUserId);
}

function contentBlocks(message: unknown): Array<Record<string, unknown>> {
  const content = (message as { message?: { content?: unknown } } | null)?.message?.content;
  return Array.isArray(content) ? content.filter((block) => block && typeof block === 'object') : [];
}

/** Per-run stream activity, fed with every raw SDK message of the run. */
export function createRunActivity(now: () => number = Date.now): RunActivity {
  let lastEventAt = now();
  let quiet = false;
  let pendingTasks = 0;
  const openToolUses = new Set<string>();
  return {
    observe(message, taskState) {
      lastEventAt = now();
      quiet = taskState.quiet;
      pendingTasks = taskState.pending;
      const type = (message as { type?: unknown } | null)?.type;
      for (const block of contentBlocks(message)) {
        if (type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
          openToolUses.add(block.id);
        } else if (type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          openToolUses.delete(block.tool_use_id);
        }
      }
    },
    snapshot: () => ({ lastEventAt, openToolUses: openToolUses.size, quiet, pendingTasks }),
  };
}

/**
 * Phase and stuck verdict of a registered run. Stuck = running, no stream event
 * for `stuckAfterMs`, and either the run's CLI process is known dead (M-b: nothing
 * in flight can still answer) or there is no pending approval, no pending task and
 * no tool call in flight (qa condition 5). Unknown liveness counts as alive. A run
 * without activity data is never stuck.
 */
export function describeRunOccupancy(input: {
  activity: RunActivitySnapshot | null;
  wakeOnly: boolean;
  pendingApproval: boolean;
  now: number;
  stuckAfterMs: number;
  processDead?: boolean;
}): { phase: Exclude<ClaudeRunPhase, 'launching'>; stuck: boolean } {
  const { activity } = input;
  if (input.wakeOnly) return { phase: 'scheduled_wake', stuck: false };
  if (!activity) return { phase: 'running', stuck: false };
  if (activity.quiet) return { phase: 'post_result', stuck: false };
  const silent = input.now - activity.lastEventAt >= input.stuckAfterMs;
  const nothingInFlight = !input.pendingApproval && activity.pendingTasks === 0 && activity.openToolUses === 0;
  return { phase: 'running', stuck: silent && (input.processDead === true || nothingInFlight) };
}

type HeldReservation = LaunchReservation & { timer: NodeJS.Timeout; abort: (() => void) | null };

/**
 * One launch reservation per session, taken in the same tick as the busy check and
 * released by its own token (registration or the launch's end). A launch that never
 * gets that far (a CLI that never speaks) is ended by `cancel` — a privileged stop, or
 * the safety valve once `maxMs` passes: its abort runs, its token is REVOKED (the
 * launch may no longer spawn or register) and only then is the reservation freed, so a
 * freed reservation never admits a second run beside it.
 */
export function createLaunchReservations(deps: {
  maxMs: () => number;
  onExpire: (sessionId: string, userId: unknown) => void;
}) {
  const held = new Map<string, HeldReservation>();
  const revoked = new Set<symbol>();
  const cancel = (sessionId: string): { userId: unknown; aborted: boolean } | null => {
    const current = held.get(sessionId);
    if (!current) return null;
    clearTimeout(current.timer);
    held.delete(sessionId);
    revoked.add(current.token);
    current.abort?.();
    return { userId: current.userId, aborted: current.abort !== null };
  };
  return {
    /** Takes the reservation; false when another launch holds it. */
    reserve(sessionId: string, userId: unknown, token: symbol): boolean {
      if (held.has(sessionId)) return false;
      const timer = setTimeout(() => {
        if (held.get(sessionId)?.token !== token) return;
        deps.onExpire(sessionId, userId);
        cancel(sessionId);
      }, deps.maxMs());
      timer.unref?.();
      held.set(sessionId, { userId, token, at: Date.now(), timer, abort: null });
      return true;
    },
    /** The launch's own abort (its SDK controller), used by `cancel`. */
    attachAbort(sessionId: string, token: symbol, abort: () => void): void {
      const current = held.get(sessionId);
      if (current?.token === token) current.abort = abort;
    },
    /** Ends the launch holding `sessionId`: abort, revoke, free. Null when none. */
    cancel,
    /** The token still holds its reservation (not released, not revoked). */
    holds: (sessionId: string, token: symbol): boolean => held.get(sessionId)?.token === token,
    /** A cancelled launch: it must neither spawn nor register. */
    isRevoked: (token: symbol): boolean => revoked.has(token),
    /** The launch's own end; also forgets a revoked token. */
    release(sessionId: string, token: symbol): void {
      revoked.delete(token);
      const current = held.get(sessionId);
      if (!current || current.token !== token) return;
      clearTimeout(current.timer);
      held.delete(sessionId);
    },
    holder(sessionId: string): LaunchReservation | null {
      const current = held.get(sessionId);
      return current ? { userId: current.userId, token: current.token, at: current.at } : null;
    },
  };
}
