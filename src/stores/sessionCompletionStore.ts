/**
 * Finished-but-unopened session tracker (sidebar "done" indicator).
 *
 * Complements sessionProcessStateStore: that store only knows about LIVE runs
 * ('running'/'frozen', cleared on idle). This one remembers which sessions
 * FINISHED a run while the user was elsewhere, so the sidebar can show a
 * steady "done — not opened yet" dot until the conversation is opened.
 *
 * Lifecycle:
 *  - AppContent calls `markSessionFinishedUnopened` when a completion signal
 *    (kind 'complete'/'error', or a process_state 'idle' broadcast) arrives
 *    for a session that is NOT currently open.
 *  - Opening the session (`clearSessionFinishedUnopened`) removes the mark.
 *
 * Persistence is client-side localStorage (same pattern as
 * `sidebarProjectMembershipFilter`) so the mark survives page refreshes; the
 * list is capped so the key cannot grow without bound. A `storage` listener
 * keeps multiple tabs of the same browser in sync (opening the conversation
 * in one tab clears the dot everywhere).
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'sidebarSessionsFinishedUnopened';

/** Upper bound on remembered session ids; oldest marks are dropped first. */
export const MAX_TRACKED_SESSIONS = 200;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no DOM/storage access).
// ---------------------------------------------------------------------------

/** Appends a session id (newest last), de-duplicated and capped. */
export function appendFinishedId(
  ids: readonly string[],
  sessionId: string,
  max: number = MAX_TRACKED_SESSIONS,
): string[] {
  const next = ids.filter((id) => id !== sessionId);
  next.push(sessionId);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Removes a session id; returns null when nothing changed. */
export function removeFinishedId(ids: readonly string[], sessionId: string): string[] | null {
  if (!ids.includes(sessionId)) {
    return null;
  }
  return ids.filter((id) => id !== sessionId);
}

type CompletionSignal = {
  kind?: unknown;
  text?: unknown;
  processState?: unknown;
  sessionId?: unknown;
};

/**
 * True for WebSocket payloads that mean "this session's run just ended":
 * the turn-level 'complete'/'error' messages, and the /proc monitor's final
 * `process_state: 'idle'` broadcast (covers viewers that only mirror).
 */
export function isCompletionSignal(msg: CompletionSignal): boolean {
  if (msg.kind === 'complete' || msg.kind === 'error') {
    return true;
  }
  return msg.kind === 'status' && msg.text === 'process_state' && msg.processState === 'idle';
}

/**
 * Decides whether a payload should flip its session to "finished — unopened":
 * it must be a completion signal for a real session that is not the one the
 * user is currently looking at (an open conversation needs no reminder).
 */
export function shouldMarkSessionFinished(
  msg: CompletionSignal,
  openSessionId: string | null | undefined,
): boolean {
  return (
    typeof msg.sessionId === 'string' &&
    msg.sessionId !== '' &&
    msg.sessionId !== openSessionId &&
    isCompletionSignal(msg)
  );
}

// ---------------------------------------------------------------------------
// Store (localStorage-backed, useSyncExternalStore-compatible).
// ---------------------------------------------------------------------------

function readStorage(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id): id is string => typeof id === 'string' && id !== '');
  } catch {
    return [];
  }
}

function writeStorage(ids: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable (private mode/quota) — keep the in-memory state.
  }
}

let finishedIds: string[] = typeof localStorage === 'undefined' ? [] : readStorage();
let finishedIdSet: ReadonlySet<string> = new Set(finishedIds);

const listeners = new Set<() => void>();

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

function commit(ids: string[], persist: boolean): void {
  finishedIds = ids;
  finishedIdSet = new Set(ids);
  if (persist) {
    writeStorage(ids);
  }
  emitChange();
}

/** Marks a session as "finished — not opened yet". Idempotent re-mark refreshes recency. */
export function markSessionFinishedUnopened(sessionId: string): void {
  if (!sessionId) {
    return;
  }
  commit(appendFinishedId(finishedIds, sessionId), true);
}

/** Clears the mark (the user opened the conversation). No-op when absent. */
export function clearSessionFinishedUnopened(sessionId: string): void {
  if (!sessionId) {
    return;
  }
  const next = removeFinishedId(finishedIds, sessionId);
  if (next) {
    commit(next, true);
  }
}

/** Reactive: is this single session finished and not yet opened? */
export function useSessionFinishedUnopened(sessionId?: string | null): boolean {
  return useSyncExternalStore(subscribe, () =>
    sessionId ? finishedIdSet.has(sessionId) : false,
  );
}

/**
 * Project-level rollup: true while ANY of the given session ids is finished
 * and unopened. The caller decides precedence against the live busy state
 * (a running session outranks a finished one on the project dot).
 */
export function useAnySessionFinishedUnopened(
  sessionIds: ReadonlyArray<string | null | undefined>,
): boolean {
  return useSyncExternalStore(subscribe, () =>
    sessionIds.some((id) => Boolean(id) && finishedIdSet.has(id as string)),
  );
}

// Cross-tab sync: another tab opening the conversation updates localStorage;
// reflect that here so every visible sidebar clears the dot together.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    commit(readStorage(), false);
  });
}
