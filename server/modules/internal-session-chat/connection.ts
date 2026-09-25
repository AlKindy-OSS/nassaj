/**
 * `/internal-session-chat` socket admission (ADR-187). The gateway has already
 * authenticated the upgrade and tracked the socket for account revocation; this
 * only admits a current room member and ties the subscription to the socket life.
 * Every refusal closes with the terminal 4404 so the client stops reconnecting.
 */
import { isInternalChatReady } from './access.js';
import { INTERNAL_CHAT_NOT_FOUND_CLOSE, internalChatRealtime, type InternalChatSocket } from './realtime.js';

export type InternalChatConnection = InternalChatSocket & {
  close: (code?: number, reason?: string) => void;
  on: (event: 'close', listener: () => void) => unknown;
};

/** Returns true when the socket was subscribed; otherwise it has been closed. */
export function handleInternalChatConnection(
  socket: InternalChatConnection,
  requestUrl: string,
  userId: unknown,
): boolean {
  const sessionId = new URL(requestUrl, 'http://localhost').searchParams.get('sessionId');
  const admitted = isInternalChatReady() && typeof sessionId === 'string' && sessionId !== ''
    && Number.isInteger(userId) && internalChatRealtime.subscribe(sessionId, userId as number, socket);
  if (!admitted) {
    socket.close(INTERNAL_CHAT_NOT_FOUND_CLOSE, 'Not found');
    return false;
  }
  socket.on('close', () => internalChatRealtime.unsubscribe(socket));
  return true;
}
