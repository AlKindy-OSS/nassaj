/**
 * T-2093 (ADR-TURN-SCOPED-CONTROL) — which turn is running in which session.
 *
 * A turn is identified by its `turnKey`: the clientMsgId of the message that
 * started it. A stop names the turn its sender saw; the abort path compares that
 * key with this registry in the same tick as the provider bridge call, so a stop
 * that arrives after a newer turn began never kills the newer turn.
 *
 * Invariants (QA condition 1):
 *   - an existing entry is NEVER overwritten: a second send on a busy session
 *     (refused with `session_busy`) and a steer never register;
 *   - only the owning turn deletes its entry (`release` compares the key).
 *
 * In-memory by design: after a restart nothing is running, and an absent entry
 * makes the abort path fall back to the legacy session-wide stop.
 */

export type ActiveTurnEntry = Readonly<{
  sessionId: string;
  turnKey: string;
  starterUserId: number | null;
  /** The connection writer that launched the turn (identity only). */
  writer: object | null;
}>;

/** `match` = the named turn runs; `stale` = another turn runs; `absent` = none known. */
export type TurnKeyVerdict = 'match' | 'stale' | 'absent';

function starterIndexKey(starterUserId: number, turnKey: string): string {
  return `${starterUserId}\u0000${turnKey}`;
}

export class ActiveTurnRegistry {
  readonly #bySession = new Map<string, ActiveTurnEntry>();
  readonly #byTurnKey = new Map<string, ActiveTurnEntry>();

  /** Registers a turn only when its session has no entry. Returns whether it did. */
  register(entry: ActiveTurnEntry): boolean {
    if (!entry.sessionId || !entry.turnKey || this.#bySession.has(entry.sessionId)) return false;
    const frozen = Object.freeze({ ...entry });
    this.#bySession.set(entry.sessionId, frozen);
    if (entry.starterUserId != null) {
      const indexKey = starterIndexKey(entry.starterUserId, entry.turnKey);
      if (!this.#byTurnKey.has(indexKey)) this.#byTurnKey.set(indexKey, frozen);
    }
    return true;
  }

  /** Deletes the session's entry only while it still belongs to `turnKey`. */
  release(sessionId: string, turnKey: string): boolean {
    const entry = this.#bySession.get(sessionId);
    if (!entry || entry.turnKey !== turnKey) return false;
    this.#bySession.delete(sessionId);
    if (entry.starterUserId != null) {
      const indexKey = starterIndexKey(entry.starterUserId, entry.turnKey);
      if (this.#byTurnKey.get(indexKey) === entry) this.#byTurnKey.delete(indexKey);
    }
    return true;
  }

  /** Compares a stop's expected key with the running turn of the session. */
  verdict(sessionId: string, turnKey: string): TurnKeyVerdict {
    const entry = this.#bySession.get(sessionId);
    if (!entry) return 'absent';
    return entry.turnKey === turnKey ? 'match' : 'stale';
  }

  /** The running turn of a session, if known. */
  get(sessionId: string): ActiveTurnEntry | undefined {
    return this.#bySession.get(sessionId);
  }

  /** A turn the given user started under `turnKey` (empty-id stop resolution). */
  findStartedTurn(starterUserId: number | null, turnKey: string): ActiveTurnEntry | undefined {
    if (starterUserId == null || !turnKey) return undefined;
    return this.#byTurnKey.get(starterIndexKey(starterUserId, turnKey));
  }

  /** Number of registered sessions. */
  size(): number {
    return this.#bySession.size;
  }

  /** Drops every entry (tests only). */
  clear(): void {
    this.#bySession.clear();
    this.#byTurnKey.clear();
  }
}

/** Process-wide registry used by the chat websocket service. */
export const activeTurnRegistry = new ActiveTurnRegistry();
