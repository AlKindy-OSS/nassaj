/** Isolated realtime registry. It never shares the provider chat writer or mirrors. */
import { onSessionProjectTransfer } from '@/modules/database/index.js';

import { internalSessionChatDb } from './repository.js';

export type InternalChatSocket = {
  send: (frame: string) => void;
  readyState?: number;
  close?: (code?: number, reason?: string) => void;
};
type Subscription = { sessionId: string; userId: number; socket: InternalChatSocket };

const subscriptions = new Set<Subscription>();
const OPEN = 1;
const REVOKED = 'internal-chat.membership_revoked';
/** Terminal close code: the client must not reconnect on it (same meaning as /terminal 4404). */
export const INTERNAL_CHAT_NOT_FOUND_CLOSE = 4404;

const emit = (socket: InternalChatSocket, event: string, data: Record<string, unknown>) => {
  if (socket.readyState !== undefined && socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify({ type: event, ...data }));
  } catch {
    /* a dead socket is removed by its own close handler */
  }
};

/** Ends one subscription with the personal, content-free revocation frame, then closes it terminally. */
const drop = (item: Subscription) => {
  emit(item.socket, REVOKED, { sessionId: item.sessionId });
  subscriptions.delete(item);
  try {
    item.socket.close?.(INTERNAL_CHAT_NOT_FOUND_CLOSE, 'Not found');
  } catch {
    /* already closed */
  }
};

/**
 * Delivers to subscribers whose access is re-verified at send time. A subscriber
 * who lost room membership, project access or an active account is dropped
 * instead of being sent the frame.
 */
const deliver = (match: (item: Subscription) => boolean, event: string, data: Record<string, unknown>) => {
  for (const item of [...subscriptions]) {
    if (!match(item)) continue;
    if (internalSessionChatDb.activeMember(item.sessionId, item.userId)) emit(item.socket, event, data);
    else drop(item);
  }
};

export const internalChatRealtime = {
  subscribe(sessionId: string, userId: number, socket: InternalChatSocket): boolean {
    if (!internalSessionChatDb.activeMember(sessionId, userId)) return false;
    subscriptions.add({ sessionId, userId, socket });
    return true;
  },
  unsubscribe(socket: InternalChatSocket): void {
    for (const item of [...subscriptions]) if (item.socket === socket) subscriptions.delete(item);
  },
  publishMessage(sessionId: string, message: Record<string, unknown>): void {
    deliver(item => item.sessionId === sessionId, 'internal-chat.message.created', { sessionId, message });
  },
  revoke(sessionId: string, userId: number): void {
    for (const item of [...subscriptions]) if (item.sessionId === sessionId && item.userId === userId) drop(item);
  },
  revokeSession(sessionId: string): void {
    for (const item of [...subscriptions]) if (item.sessionId === sessionId) drop(item);
  },
  /** ADR-172 project-membership removal: drop the user's rooms in the project's sessions. */
  revokeUserSessions(userId: number, sessionIds: Iterable<string>): number {
    const scope = new Set(sessionIds);
    let dropped = 0;
    for (const item of [...subscriptions]) {
      if (item.userId !== userId || !scope.has(item.sessionId)) continue;
      drop(item);
      dropped += 1;
    }
    return dropped;
  },
  publishMentionState(sessionId: string, userId: number, unreadMentionCount: number, roomVersion: number): void {
    deliver(item => item.sessionId === sessionId && item.userId === userId,
      'internal-chat.mention-state.changed', { sessionId, unreadMentionCount, roomVersion });
  },
};

// A cross-project transfer puts the room into revalidation; end live subscriptions now.
onSessionProjectTransfer(sessionId => internalChatRealtime.revokeSession(sessionId));
