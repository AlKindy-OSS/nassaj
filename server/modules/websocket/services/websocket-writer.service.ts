import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Read-only session mirrors (realtime fan-out).
 *
 * Every chat session streams through exactly ONE primary WebSocketWriter — the
 * socket that spawned the run. Swapping that writer mid-run is vetoed (it
 * desynchronises the SDK and aborts tool use), which historically meant a
 * refreshed tab or a second user viewing the same session received NOTHING
 * until they reloaded after the run finished.
 *
 * Mirrors solve this without touching the writer: any additional socket that
 * opens a session is registered here, and `WebSocketWriter.send` fans every
 * payload out to the session's mirrors as a read-only COPY — including
 * permission prompts, so any live viewer can answer an approval whose
 * originating socket is gone. Mirrors never become the writer and never feed
 * input back into the run.
 */
const sessionMirrors = new Map<string, Set<RealtimeClientConnection>>();

/** Bounds per-session fan-out; oldest mirror is evicted first. */
const MAX_MIRRORS_PER_SESSION = 20;

/**
 * Reverse index: socket → the session ids it currently mirrors (B-SEC-MIRROR-LEAK).
 *
 * The original design relied SOLELY on the lazy prune inside `fanOutToMirrors`
 * ("close → readyState !== OPEN → pruned"), which only runs when that same
 * session broadcasts AGAIN. A tab that closes while its session is quiet — or
 * after the run finished — therefore left a permanent `sessionMirrors` entry
 * holding a strong reference to a dead WebSocket (measured: ~7MB/h of retained
 * sockets under normal page-refresh traffic). This index makes the O(1)
 * explicit unregister below possible; it is a WeakMap so a socket dropped
 * without an unregister is still collectable once the forward index releases it.
 */
const mirroredSessionsBySocket = new WeakMap<RealtimeClientConnection, Set<string>>();

/**
 * Best-effort self-cleanup: the FIRST time a socket is registered as a mirror we
 * attach a one-shot `close` listener that unregisters every mirror it holds.
 * Defence in depth behind the explicit `removeSessionMirrorsForSocket` call in
 * the chat close handler — a future registrar that forgets to unregister still
 * cannot leak. Attached once per socket (guarded by the reverse-index entry's
 * creation) so it never accumulates listeners, and feature-detected so the test
 * doubles / SSE-style connections that carry no EventEmitter surface are skipped.
 */
function autoUnregisterMirrorsOnClose(rawWs: RealtimeClientConnection): void {
  const emitter = rawWs as unknown as { once?: (event: string, cb: () => void) => void };
  if (typeof emitter.once !== 'function') {
    return;
  }
  try {
    emitter.once('close', () => {
      removeSessionMirrorsForSocket(rawWs);
    });
  } catch {
    /* listener registration must never break mirror registration */
  }
}

/**
 * Registers a socket as a read-only mirror of a session's live stream.
 * Idempotent per socket. Dead sockets are still pruned opportunistically on every
 * fan-out; the authoritative cleanup is `removeSessionMirrorsForSocket` (called
 * from the chat socket-close handler and from the one-shot listener above).
 */
export function addSessionMirror(sessionId: string, rawWs: RealtimeClientConnection): void {
  if (!sessionId || !rawWs) {
    return;
  }
  let mirrors = sessionMirrors.get(sessionId);
  if (!mirrors) {
    mirrors = new Set();
    sessionMirrors.set(sessionId, mirrors);
  }
  if (!mirrors.has(rawWs) && mirrors.size >= MAX_MIRRORS_PER_SESSION) {
    const oldest = mirrors.values().next().value;
    if (oldest) {
      mirrors.delete(oldest);
      // Keep the reverse index consistent with the eviction.
      mirroredSessionsBySocket.get(oldest)?.delete(sessionId);
    }
  }
  mirrors.add(rawWs);

  let owned = mirroredSessionsBySocket.get(rawWs);
  if (!owned) {
    owned = new Set();
    mirroredSessionsBySocket.set(rawWs, owned);
    autoUnregisterMirrorsOnClose(rawWs);
  }
  owned.add(sessionId);
}

/**
 * Unregisters a socket from EVERY session it mirrors (B-SEC-MIRROR-LEAK).
 *
 * Called from the chat websocket `close` handler — the counterpart the module
 * never had. Read-only with respect to the run: it drops fan-out bookkeeping
 * only, never the primary writer, the SDK query or the replay buffer, so the
 * no-swap veto and ADR-042's listener detection are untouched (a session that
 * loses its last mirror simply reports zero live mirrors, exactly as the lazy
 * prune used to report it — just immediately instead of "on the next broadcast,
 * if any").
 *
 * @returns the number of (session, socket) mirror registrations removed.
 */
export function removeSessionMirrorsForSocket(
  rawWs: RealtimeClientConnection | null | undefined,
): number {
  if (!rawWs) {
    return 0;
  }
  const owned = mirroredSessionsBySocket.get(rawWs);
  if (!owned) {
    return 0;
  }
  mirroredSessionsBySocket.delete(rawWs);

  let removed = 0;
  for (const sessionId of owned) {
    const mirrors = sessionMirrors.get(sessionId);
    if (!mirrors) {
      continue;
    }
    if (mirrors.delete(rawWs)) {
      removed += 1;
    }
    if (mirrors.size === 0) {
      sessionMirrors.delete(sessionId);
    }
  }
  owned.clear();
  return removed;
}

/**
 * Test-only introspection of the fan-out index size (number of sessions that
 * still hold at least one mirror registration). Exported so the leak regression
 * test can assert on the REAL module state instead of re-implementing it; never
 * used in production code.
 */
export function __mirroredSessionCountForTests(): number {
  return sessionMirrors.size;
}

/**
 * Fans a serialized payload out to a session's mirrors, skipping the primary
 * socket (no double-delivery to the spawner) and pruning closed sockets.
 */
function fanOutToMirrors(
  sessionId: string,
  serialized: string,
  primary: RealtimeClientConnection,
): void {
  const mirrors = sessionMirrors.get(sessionId);
  if (!mirrors || mirrors.size === 0) {
    return;
  }
  for (const mirror of mirrors) {
    if (mirror.readyState !== WS_OPEN_STATE) {
      mirrors.delete(mirror);
      continue;
    }
    if (mirror === primary) {
      continue;
    }
    try {
      mirror.send(serialized);
    } catch {
      mirrors.delete(mirror);
    }
  }
  if (mirrors.size === 0) {
    sessionMirrors.delete(sessionId);
  }
}

/**
 * ADR-042 (B-80c) listener-detection seam. Returns the number of LIVE mirrors a
 * session still has, pruning dead sockets on the way (same eviction discipline
 * as `fanOutToMirrors`). Used by the claude-sdk ghost sweep to decide whether a
 * session has lost every listener; it imports this — never the reverse — so the
 * dependency stays one-directional (claude-sdk → writer) with no circularity.
 */
export function countLiveMirrors(sessionId: string): number {
  const mirrors = sessionMirrors.get(sessionId);
  if (!mirrors || mirrors.size === 0) {
    return 0;
  }
  let live = 0;
  for (const mirror of mirrors) {
    if (mirror.readyState !== WS_OPEN_STATE) {
      mirrors.delete(mirror);
      continue;
    }
    live += 1;
  }
  if (mirrors.size === 0) {
    sessionMirrors.delete(sessionId);
  }
  return live;
}

/**
 * Thin transport adapter that gives WebSocket connections the same interface as
 * SSE writers used by API routes (`send`, `setSessionId`, `getSessionId`).
 */
export class WebSocketWriter {
  ws: RealtimeClientConnection;
  sessionId: string | null;
  userId: string | number | null;
  isWebSocketWriter: boolean;

  constructor(ws: RealtimeClientConnection, userId: string | number | null = null) {
    this.ws = ws;
    this.sessionId = null;
    this.userId = userId;
    this.isWebSocketWriter = true;
  }

  send(data: unknown): void {
    const serialized = JSON.stringify(data);
    if (this.ws.readyState === WS_OPEN_STATE) {
      this.ws.send(serialized);
    }
    // Mirror fan-out: key by the payload's own sessionId when present (most
    // normalized messages carry it; covers resumed runs where setSessionId was
    // never called on this writer), falling back to the writer's sessionId.
    const payloadSessionId =
      data && typeof data === 'object' && typeof (data as { sessionId?: unknown }).sessionId === 'string'
        ? (data as { sessionId: string }).sessionId
        : this.sessionId;
    if (payloadSessionId) {
      fanOutToMirrors(payloadSessionId, serialized, this.ws);
    }
  }

  updateWebSocket(newRawWs: RealtimeClientConnection): void {
    this.ws = newRawWs;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * ADR-042 (B-80c): true when this session's PRIMARY socket is still open. The
   * ghost sweep treats `false` here (and zero live mirrors) as "no listener",
   * the precondition for detaching the session from the drain count. Read-only —
   * it never swaps or closes the socket (honours the no-swap veto).
   */
  isPrimarySocketAlive(): boolean {
    return this.ws?.readyState === WS_OPEN_STATE;
  }
}
