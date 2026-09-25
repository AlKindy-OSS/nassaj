import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  applyOutcomePayload,
  isOutcomeSignalKind,
} from '@/modules/websocket/services/session-outcome.service.js';
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
/**
 * ADR-172 (P1-2): drops every mirror a given user's sockets hold on the listed
 * sessions — used when the user loses access to the project owning them, so an
 * already-open tab stops receiving that project's stream. Identity is the
 * JWT-stamped `socket.userId`, never client input. Returns the mirrors removed.
 */
export function removeSessionMirrorsForUser(
  userId: string | number,
  sessionIds: Iterable<string>,
): number {
  const target = String(userId);
  let removed = 0;
  for (const sessionId of sessionIds) {
    const mirrors = sessionMirrors.get(sessionId);
    if (!mirrors) {
      continue;
    }
    for (const socket of mirrors) {
      if (socket.userId === null || socket.userId === undefined || String(socket.userId) !== target) {
        continue;
      }
      mirrors.delete(socket);
      mirroredSessionsBySocket.get(socket)?.delete(sessionId);
      removed += 1;
    }
    if (mirrors.size === 0) {
      sessionMirrors.delete(sessionId);
    }
  }
  return removed;
}

/**
 * ADR-172 (qa #6): stop streaming the listed sessions to a user's OWN sockets
 * (the primary writer of a turn they launched). The revocation coordinator
 * separately aborts runs actually launched by that user. Returns the number of
 * writers detached.
 */
export function detachWritersForUser(userId: string | number, sessionIds: Iterable<string>): number {
  const target = String(userId);
  const sessions = [...sessionIds];
  let detached = 0;
  for (const writer of liveWriters) {
    if (writer.userId === null || writer.userId === undefined || String(writer.userId) !== target) {
      continue;
    }
    for (const sessionId of sessions) writer.detachedSessionIds.add(sessionId);
    detached += 1;
  }
  return detached;
}

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
/** Live writers, for ADR-172 revocation (dropped when their socket closes). */
const liveWriters = new Set<WebSocketWriter>();

export class WebSocketWriter {
  ws: RealtimeClientConnection;
  sessionId: string | null;
  userId: string | number | null;
  isWebSocketWriter: boolean;
  private outputRevoked: boolean;
  private readonly revocableRuns: Map<string, { provider: string; token: object }>;
  /** Sessions whose stream must no longer reach this writer's own socket. */
  detachedSessionIds: Set<string>;

  constructor(ws: RealtimeClientConnection, userId: string | number | null = null) {
    this.ws = ws;
    this.sessionId = null;
    this.userId = userId;
    this.isWebSocketWriter = true;
    this.outputRevoked = false;
    this.revocableRuns = new Map();
    this.detachedSessionIds = new Set();
    // Only writers bound to a real socket (one that emits 'close') are tracked,
    // so inert server-owned writers (scheduled dispatch) never accumulate here.
    const emitter = ws as unknown as { once?: (event: string, cb: () => void) => void };
    if (typeof emitter?.once === 'function') {
      try {
        emitter.once('close', () => liveWriters.delete(this));
        liveWriters.add(this);
      } catch {
        /* registration must never break writer construction */
      }
    }
  }

  send(data: unknown): void {
    // A revoked device identity owns neither the primary stream nor its mirrors,
    // and may not commit a terminal outcome after the wallet switched slots.
    if (this.outputRevoked) {
      return;
    }
    const serialized = JSON.stringify(data);
    const targetSessionId =
      data && typeof data === 'object' && typeof (data as { sessionId?: unknown }).sessionId === 'string'
        ? (data as { sessionId: string }).sessionId
        : this.sessionId;
    const detached = targetSessionId !== null && this.detachedSessionIds.has(targetSessionId);
    // Project-membership revocation is a content fence, not merely a transport
    // detach: no primary send, mirror fan-out, or terminal outcome persistence
    // may cross it while the close handshake is pending (or ends as 1006).
    if (detached) return;
    if (this.ws.readyState === WS_OPEN_STATE) {
      try {
        this.ws.send(serialized);
      } catch {
        // B-891: a transport failure belongs to this viewer, not the run.
        // Preserve mirror delivery and outcome recording even if send fails
        // after the OPEN check. Never swap the active writer as recovery.
      }
    }
    // Mirror fan-out: key by the payload's own sessionId when present (most
    // normalized messages carry it; covers resumed runs where setSessionId was
    // never called on this writer), falling back to the writer's sessionId.
    const payloadSessionId = targetSessionId;
    if (payloadSessionId) {
      fanOutToMirrors(payloadSessionId, serialized, this.ws);
    }

    /**
     * ‏B-577 — حالة المحادثة تُكتب هنا، عند المختنق الذي تمرّ به حمولاتُ **كل**
     * مزوّد. فتصير حقيقةً خادميّة يراها كل عضو، بدل اشتقاقٍ في كل متصفّح على
     * حِدة يضيع على من كان مغلقاً لحظة الانتهاء.
     *
     * الحارس أوّلاً: هذه الدالّة تُستدعى مع كل قطعة بثّ (توكن بتوكن)، فلا يدخلها
     * منطقُ اشتقاقٍ ولا لمسُ قاعدة إلا لخمسة أنواع.
     */
    if (
      payloadSessionId
      && data
      && typeof data === 'object'
      && isOutcomeSignalKind((data as { kind?: unknown }).kind)
    ) {
      applyOutcomePayload(payloadSessionId, data as Parameters<typeof applyOutcomePayload>[1]);
    }
  }

  updateWebSocket(newRawWs: RealtimeClientConnection): void {
    this.ws = newRawWs;
  }

  /**
   * Permanently fences output from the run owned by `expectedRawWs`. Returning
   * false means the writer has already moved to a newer transport, so a delayed
   * close event must not revoke it.
   */
  revokeRunOutput(expectedRawWs: RealtimeClientConnection): boolean {
    if (this.ws !== expectedRawWs || this.outputRevoked) {
      return false;
    }
    this.outputRevoked = true;
    return true;
  }

  /** Provider terminal handlers use this to skip late transcript persistence. */
  isRunOutputRevoked(sessionId: string | null = this.sessionId): boolean {
    return this.outputRevoked || (sessionId !== null && this.detachedSessionIds.has(sessionId));
  }

  /** Fences only the listed project sessions while preserving unrelated runs. */
  revokeProjectSessions(sessionIds: Iterable<string>, expectedRawWs: RealtimeClientConnection): number {
    if (this.ws !== expectedRawWs) return 0;
    const revoked = new Set(sessionIds);
    for (const sessionId of revoked) this.detachedSessionIds.add(sessionId);
    let owned = 0;
    for (const sessionId of this.revocableRuns.keys()) {
      if (revoked.has(sessionId)) owned += 1;
    }
    return owned;
  }

  /** Binds a supervised run that has no child-process monitor registration. */
  bindRevocableRun(sessionId: string, provider: string): object {
    const token = {};
    this.revocableRuns.set(sessionId, { provider, token });
    return token;
  }

  /** Releases only the exact supervised generation that created `token`. */
  releaseRevocableRun(sessionId: string, token: object): void {
    if (this.revocableRuns.get(sessionId)?.token === token) {
      this.revocableRuns.delete(sessionId);
    }
  }

  /** Returns writer-owned supervised runs for this exact raw transport. */
  getRevocableRuns(expectedRawWs: RealtimeClientConnection): Array<{
    sessionId: string; provider: string; token: unknown;
  }> {
    if (this.ws !== expectedRawWs) return [];
    return [...this.revocableRuns.entries()].map(([sessionId, run]) => ({ sessionId, ...run }));
  }

  /** Rechecks a supervised generation immediately before cancellation. */
  isRevocableRunCurrent(
    run: { sessionId: string; token: unknown },
    expectedRawWs: RealtimeClientConnection,
  ): boolean {
    return this.ws === expectedRawWs
      && this.revocableRuns.get(run.sessionId)?.token === run.token;
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
