/**
 * Global session process-state store (frozen-session indicator).
 *
 * The server monitors each in-flight provider run's child process via /proc
 * and broadcasts `kind: 'status', text: 'process_state'` messages over the
 * session WebSocket (primary socket + read-only mirrors). A single listener
 * (AppContent) feeds those messages into this module-level map so any
 * component — sidebar rows, the chat header, the status spinner — can
 * subscribe per sessionId without prop drilling.
 *
 * States:
 *  - 'running': the child process is alive and schedulable.
 *  - 'frozen':  the child process was stopped externally (kill -STOP → 'T').
 *  - 'idle':    no live process for the session (turn finished) — stored as
 *               absence so the map only holds genuinely active sessions.
 *
 * B-269 — SECOND feed: the `process_state` stream above only ever reaches a
 * session's primary socket and its registered read-only mirrors, and a mirror is
 * registered when the client OPENS that session. So this store used to know the
 * state of the currently-open conversation and nothing else, while the presence
 * badge counted every running conversation globally — "5 active", one Running
 * badge. The presence snapshot now carries a `runningSessions` list (already
 * filtered to what the recipient may see) which `reconcilePresenceProcessStates`
 * folds in, so sidebar badges and project busy dots light up for sessions this
 * client has never opened.
 */

import { useSyncExternalStore } from 'react';

export type SessionProcessState = 'running' | 'frozen' | 'idle';

const VALID_STATES: ReadonlySet<string> = new Set(['running', 'frozen', 'idle']);

const states = new Map<string, SessionProcessState>();
const listeners = new Set<() => void>();

/**
 * Session ids whose entry was last written by a presence snapshot (B-269).
 *
 * Provenance matters because presence is NOT omniscient: a run whose writer has
 * no authenticated userId is never registered in presence at all, yet still
 * broadcasts `process_state` through its mirrors. Reconciliation therefore
 * prunes only ids presence itself put here — never an id the mirror stream owns
 * — so the two feeds compose instead of erasing each other.
 */
const presenceOwned = new Set<string>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Raw subscription to any change in the store, for callers outside React's
 * useSyncExternalStore (and for asserting that a snapshot which changes nothing
 * stays silent — every emit re-reads every subscribed sidebar row).
 */
export { subscribe as subscribeSessionProcessState };

/** Updates a session's process state; 'idle' clears the entry. */
export function setSessionProcessState(sessionId: string, state: string): void {
  if (!sessionId || !VALID_STATES.has(state)) {
    return;
  }
  if (state === 'idle') {
    // The mirror stream declared this session finished — drop presence's claim
    // too, so the next snapshot re-adds it only if the run really is still live.
    presenceOwned.delete(sessionId);
    if (!states.delete(sessionId)) {
      return;
    }
  } else {
    if (states.get(sessionId) === state) {
      return;
    }
    states.set(sessionId, state as SessionProcessState);
  }
  emitChange();
}

/**
 * B-269: folds one presence snapshot's `runningSessions` list into the store.
 *
 * The list is authoritative for the runs presence knows about: every entry is
 * written, and any id presence previously wrote but no longer lists is cleared
 * (its run ended). Ids owned by the mirror stream alone are left untouched — see
 * `presenceOwned`.
 *
 * @param entries - Session ids with their server-observed process state.
 */
export function reconcilePresenceProcessStates(
  entries: ReadonlyArray<{ sessionId: string; state: SessionProcessState }>,
): void {
  let changed = false;
  const seen = new Set<string>();

  for (const { sessionId, state } of entries) {
    if (!sessionId || state === 'idle') {
      continue;
    }
    seen.add(sessionId);
    presenceOwned.add(sessionId);
    if (states.get(sessionId) !== state) {
      states.set(sessionId, state);
      changed = true;
    }
  }

  for (const sessionId of [...presenceOwned]) {
    if (seen.has(sessionId)) {
      continue;
    }
    presenceOwned.delete(sessionId);
    if (states.delete(sessionId)) {
      changed = true;
    }
  }

  if (changed) {
    emitChange();
  }
}

/**
 * Non-reactive read of a session's current process state (null when idle or
 * unknown). Used by transition detectors that need the previous state before
 * applying an update, without subscribing.
 */
export function getSessionProcessState(sessionId?: string | null): SessionProcessState | null {
  return sessionId ? (states.get(sessionId) ?? null) : null;
}

/**
 * Reactive process state for one session. Returns null when the session has
 * no live process (idle/unknown) so callers can simply hide the badge.
 */
export function useSessionProcessState(sessionId?: string | null): SessionProcessState | null {
  return useSyncExternalStore(subscribe, () =>
    sessionId ? (states.get(sessionId) ?? null) : null,
  );
}

/**
 * Project-level rollup: true while ANY of the given session ids has a live
 * 'running' process. Drives the busy dot next to a project's name in the
 * sidebar; clears automatically when the last run goes idle ('idle' deletes
 * the entry, see setSessionProcessState). 'frozen' deliberately does not
 * count — a paused process is not "working".
 */
export function useAnySessionProcessing(
  sessionIds: ReadonlyArray<string | null | undefined>,
): boolean {
  return useSyncExternalStore(subscribe, () =>
    sessionIds.some((id) => Boolean(id) && states.get(id as string) === 'running'),
  );
}

/**
 * Stable snapshot of running session ids — rebuilt only when the store
 * changes. We cache one Set instance and reuse it between getSnapshot calls
 * so that useSyncExternalStore's referential equality check (`Object.is`)
 * doesn't trigger spurious re-renders every render cycle.
 */
let cachedRunningSet: ReadonlySet<string> = new Set<string>();

function buildRunningSet(): ReadonlySet<string> {
  const next = new Set<string>();
  for (const [id, state] of states) {
    if (state === 'running') {
      next.add(id);
    }
  }
  // Reuse the previous instance when the content is identical to avoid
  // breaking referential equality inside useSyncExternalStore.
  if (next.size === cachedRunningSet.size) {
    let same = true;
    for (const id of next) {
      if (!cachedRunningSet.has(id)) {
        same = false;
        break;
      }
    }
    if (same) {
      return cachedRunningSet;
    }
  }
  cachedRunningSet = next;
  return cachedRunningSet;
}

/**
 * Returns the current snapshot of all session ids whose process state is
 * 'running'. The returned Set reference is stable across renders as long as
 * the running set does not change — safe to use as a useMemo dependency.
 *
 * Used by PresencePanel to map running sessions → projects for the
 * active-conversations tooltip.
 */
export function useRunningSessionIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, buildRunningSet);
}
