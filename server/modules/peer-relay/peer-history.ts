/**
 * ADR-219 S1 (coordinator 3c) — the server marker of peer-woken turns in history.
 * A leaf (the relay repository only), so the providers' history path can use it
 * without loading the relay service graph.
 */

// eslint-disable-next-line boundaries/dependencies -- ADR-219: the relay's own table as a leaf (see peer-relay.service.ts).
import { peerMessagesDb } from '@/modules/database/repositories/peer-messages.db.js';

type MarkedMessage = { role?: unknown; kind?: unknown; isSynthetic?: unknown; peerDeliveryId?: string; peerProofRef?: string };

/**
 * History projection (coordinator 3c): a transcript proof row whose ref names a
 * DELIVERED relay row of this session marks that row and the rows of its turn
 * (until the next human message) with `peerDeliveryId`. The internal ref is
 * always stripped; any `peerDeliveryId` not proven here is dropped.
 */
export function projectPeerDeliveryMarkers<T extends MarkedMessage>(messages: T[], sessionId: string): T[] {
  const refs = [...new Set(messages.map((m) => m.peerProofRef).filter((r): r is string => typeof r === 'string'))];
  let byRef = new Map<string, string>();
  try {
    byRef = peerMessagesDb.deliveredIdsByRef(sessionId, refs);
  } catch {
    /* no markers: the rows still render as ordinary history */
  }
  let current: string | null = null;
  return messages.map((message) => {
    const { peerProofRef, peerDeliveryId: _untrusted, ...rest } = message;
    if (peerProofRef) current = byRef.get(peerProofRef) ?? null;
    // A human message, or any synthetic row that is not a proof, ends the marked turn.
    else if (rest.role === 'user' && rest.kind === 'text') current = null;
    return (current ? { ...rest, peerDeliveryId: current } : rest) as T;
  });
}
