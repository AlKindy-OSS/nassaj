import type { ChatMessage } from '../chat/types/types';

import type { PeerMessageView } from './peerMessageStore';

/** What a viewer sees: six display states folded from the server's state + cause. */
export type PeerDisplayState = 'queued' | 'deferred' | 'delivering' | 'delivered' | 'refused' | 'failed';

/**
 * Folds the server state into the display state. A `queued` row carrying a
 * cause is a retry after a deferral (maintenance drain, a turn that did not
 * start), so it reads as deferred, like `deferred_quota`.
 */
export function peerDisplayState(message: Pick<PeerMessageView, 'state' | 'cause'>): PeerDisplayState {
  switch (message.state) {
    case 'deferred_quota': return 'deferred';
    case 'queued': return message.cause && message.cause !== 'repaired_requeue' ? 'deferred' : 'queued';
    default: return message.state;
  }
}

/**
 * ADR-219 S1: the first reply row of a live delivery turn. The id comes from
 * the server's delivery clientMsgId and must name a peer message the relay
 * frame addressed to this session; the user-role echo never counts.
 */
export function isPeerTurnStart(
  message: ChatMessage, prev: ChatMessage | null, inboundIds: ReadonlySet<string>,
): boolean {
  const id = message.peerDeliveryId;
  if (message.type === 'user' || !id || !inboundIds.has(id)) return false;
  return !(prev && prev.type !== 'user' && prev.peerDeliveryId === id);
}
