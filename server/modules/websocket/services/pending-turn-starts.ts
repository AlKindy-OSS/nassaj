/**
 * T-2095 qa: turns between admission and provider start (the pre-turn
 * checkpoint window). No provider session exists yet, so a stop that arrives
 * here has nothing to abort; it marks the pending start instead, and the
 * dispatch never starts the provider.
 *
 * A stop matches a pending start only for the same session (and turn key, when
 * named), or, with no session id, for the same starter on the same connection
 * and turn key: the same scope the abort paths already allow.
 */

export type PendingTurnStart = {
  readonly sessionId: string | null;
  readonly turnKey: string | null;
  readonly starterUserId: number | null;
  /** Identity of the raw connection the turn was sent on. */
  readonly connection: unknown;
  stopped: boolean;
};

export type PendingStopRequest = {
  sessionId: string;
  turnKey: string | null;
  userId: number | null;
  connection: unknown;
};

function matches(entry: PendingTurnStart, request: PendingStopRequest): boolean {
  if (request.turnKey && entry.turnKey !== request.turnKey) return false;
  if (request.sessionId) return entry.sessionId === request.sessionId;
  return request.userId != null && entry.starterUserId === request.userId
    && entry.connection != null && entry.connection === request.connection;
}

export class PendingTurnStarts {
  readonly #entries = new Set<PendingTurnStart>();

  /** Records a turn entering its pre-start window. */
  begin(entry: Omit<PendingTurnStart, 'stopped'>): PendingTurnStart {
    const pending: PendingTurnStart = { ...entry, stopped: false };
    this.#entries.add(pending);
    return pending;
  }

  /** Ends the window; the caller reads `stopped` right after. */
  end(pending: PendingTurnStart): void {
    this.#entries.delete(pending);
  }

  /** Marks the newest matching pending start stopped and returns it, or null. */
  stop(request: PendingStopRequest): PendingTurnStart | null {
    const found = [...this.#entries].reverse().find((entry) => !entry.stopped && matches(entry, request));
    if (!found) return null;
    found.stopped = true;
    return found;
  }

  /** Number of turns currently in their pre-start window. */
  size(): number {
    return this.#entries.size;
  }
}

/** Process-wide registry used by the chat dispatch and the abort path. */
export const pendingTurnStarts = new PendingTurnStarts();
