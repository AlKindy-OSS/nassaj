/**
 * Open-sessions counter (server-wide "sessions running NOW").
 *
 * Definition: a session is "open" while it has a provider run actually
 * executing on this server — registered at spawn time and removed when the run
 * reaches a terminal state (complete / error / process exit). It is NOT tied to
 * WebSocket connections (that is what presence "connected" answers) and NOT
 * read from session-registry.js (whose methods are no-ops behind the
 * per-provider SESSION_REGISTRY_<P> flag and only cover non-claude providers).
 * The feeding call sites are the exact run-lifecycle seams presence already
 * trusts: services/session-process-monitor.js (register/unregister) and
 * agy-cli.js (spawn / notifyTerminal).
 *
 * The count is GLOBAL: unique sessionIds across all users and all providers.
 * Unlike presence, runs are counted even when unauthenticated (no userId) and
 * keep counting after their owner's last socket closes — the process is still
 * running on the server either way.
 *
 * WS contract (frontend relies on this):
 *
 *   { type: 'open_sessions_count', count: number, timestamp: string }
 *
 *   * `count`     — number of sessions with a running provider command right
 *                   now, server-wide (unique by sessionId).
 *   * `timestamp` — ISO-8601 emission time.
 *
 * Sent (a) once to each chat WebSocket right after it connects (initial
 * value), and (b) to every connected client whenever the count CHANGES.
 * Re-registering an already-tracked sessionId or stopping an unknown one does
 * not re-broadcast — the previous-value comparison keeps the channel quiet.
 */

import {
  WS_OPEN_STATE,
  connectedClients,
} from '@/modules/websocket/services/websocket-state.service.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

/** WS message type the frontend keys the counter widget on. */
export const OPEN_SESSIONS_MESSAGE_TYPE = 'open_sessions_count';

/** sessionIds with a provider run currently executing. Set = unique by id. */
const openSessions = new Set<string>();

/**
 * Last count actually broadcast. Starts at null so the very first change
 * (0 -> 1) always goes out; afterwards equal counts are suppressed.
 */
let lastBroadcastCount: number | null = null;

/** Current number of open sessions (unique sessionIds with a live run). */
export function openSessionsCount(): number {
  return openSessions.size;
}

function buildPayload(): string {
  return JSON.stringify({
    type: OPEN_SESSIONS_MESSAGE_TYPE,
    count: openSessions.size,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Broadcasts the current count to every open chat client, but only when it
 * differs from the last broadcast value (noise guard: spawn re-registrations
 * and stop calls for unknown ids never hit the wire).
 */
function broadcastIfChanged(): void {
  const count = openSessions.size;
  if (count === lastBroadcastCount) {
    return;
  }
  lastBroadcastCount = count;
  const payload = buildPayload();
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      try {
        client.send(payload);
      } catch {
        // A failing socket is cleaned up by its own close handler.
      }
    }
  });
}

/**
 * Marks a session's run as started. Idempotent per sessionId: the Set dedupes,
 * so the second registration of the same id (e.g. the process monitor's
 * refresh once the real sessionId is captured) changes nothing and emits
 * nothing. Ignores empty/non-string ids.
 */
export function openSessionStarted(sessionId: string | null | undefined): void {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return;
  }
  openSessions.add(sessionId);
  broadcastIfChanged();
}

/**
 * Marks a session's run as terminal. Safe for unknown ids (a spawn-failure
 * teardown may fire before the start was ever recorded) — that is a no-op
 * with no broadcast.
 */
export function openSessionStopped(sessionId: string | null | undefined): void {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return;
  }
  if (!openSessions.delete(sessionId)) {
    return;
  }
  broadcastIfChanged();
}

/**
 * Sends the current count to ONE socket — the initial value a freshly
 * connected client receives so its counter renders before the next change.
 */
export function sendOpenSessionsCount(ws: RealtimeClientConnection): void {
  if (!ws || ws.readyState !== WS_OPEN_STATE) {
    return;
  }
  try {
    ws.send(buildPayload());
  } catch {
    // Same contract as the broadcast path: never throw on a dying socket.
  }
}

/** Test-only: clears tracked sessions and the previous-broadcast memory. */
export function resetOpenSessionsForTest(): void {
  openSessions.clear();
  lastBroadcastCount = null;
}
