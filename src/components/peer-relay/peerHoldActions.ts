/**
 * ADR-219 P2a-min (T-2074) — the owner's deliver / reject calls for a held
 * cross-member message.
 *
 * Each call echoes what the owner saw (version, body hash, last run mode) so
 * the server can refuse a decision made on a stale card. Any `hold` the server
 * returns (200, or a 409 with the fresh row) is applied to the store, which
 * refreshes the card. A refused call is never retried here: the owner must
 * read the refreshed card and decide again.
 */

import { authenticatedFetch } from '../../utils/api';

import { applyPeerHold, parsePeerHoldView, type PeerHoldView } from './peerHoldStore';

/** Longest reject reason the server accepts. */
export const REJECT_REASON_MAX = 200;

export type PeerHoldDecisionResult = { ok: true } | { ok: false; code: string };

async function postDecision(holdId: string, action: 'approve' | 'reject', payload: object): Promise<PeerHoldDecisionResult> {
  try {
    const response = await authenticatedFetch(
      `/api/peer-relay/holds/${encodeURIComponent(holdId)}/${action}`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
    const data = await response.json().catch(() => null) as { hold?: unknown; code?: unknown } | null;
    const fresh = parsePeerHoldView(data?.hold);
    if (fresh) applyPeerHold(fresh);
    if (response.ok) return { ok: true };
    return { ok: false, code: typeof data?.code === 'string' ? data.code : 'unknown' };
  } catch {
    return { ok: false, code: 'network' };
  }
}

/** Delivers the hold exactly as the owner saw it. */
export function approvePeerHold(hold: PeerHoldView): Promise<PeerHoldDecisionResult> {
  return postDecision(hold.id, 'approve', {
    expectedHoldVersion: hold.holdVersion,
    expectedTextHash: hold.bodySha256,
    expectedTargetMode: hold.targetMode,
  });
}

/** Rejects the hold; a blank reason is omitted, a long one is cut to the server limit. */
export function rejectPeerHold(hold: PeerHoldView, reason: string): Promise<PeerHoldDecisionResult> {
  const trimmed = reason.trim().slice(0, REJECT_REASON_MAX);
  return postDecision(hold.id, 'reject', {
    expectedHoldVersion: hold.holdVersion,
    ...(trimmed ? { reason: trimmed } : {}),
  });
}
