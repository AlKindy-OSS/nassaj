import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

/**
 * B-1327: every authenticated realtime socket (chat, /shell, /terminal) keyed
 * by its JWT-derived user id, so administrative revocation can close all of a
 * user's transports — including JWT sockets without a device principal.
 */
const socketsByUser = new Map<string, Set<RealtimeClientConnection>>();

/** Tracks `socket` under `userId`; returns an idempotent untrack callback. */
export function trackUserSocket(userId: string | number, socket: RealtimeClientConnection): () => void {
  const key = String(userId);
  let sockets = socketsByUser.get(key);
  if (!sockets) {
    sockets = new Set();
    socketsByUser.set(key, sockets);
  }
  sockets.add(socket);
  return () => {
    const current = socketsByUser.get(key);
    if (!current) return;
    current.delete(socket);
    if (current.size === 0) socketsByUser.delete(key);
  };
}

/** Snapshot of the tracked sockets of one user. */
export function trackedSocketsOfUser(userId: string | number): RealtimeClientConnection[] {
  return [...(socketsByUser.get(String(userId)) ?? [])];
}
