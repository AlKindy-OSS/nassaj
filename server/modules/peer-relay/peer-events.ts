/**
 * ADR-219 "UI" — the `peer-message` WS frame a peer bubble renders from.
 *
 * Built from the `peer_messages` row only (server-provided sender name, mode,
 * state), never from transcript text. The body is untrusted plain text: a
 * client must render it as text, never as markup. The ref token never leaves
 * the server (it is the delivery proof anchor).
 *
 * Shape (version 1):
 *   { type: 'peer-message', version: 1, sessionIds: [from, to], message: {
 *       id, chainId, parentId, hop, state, cause, fromSessionId, fromUserId,
 *       fromName, fromMode, toSessionId, toUserId, toName, summary, body, bodyBytes,
 *       costUsdCharged, createdAt, updatedAt, deliveredAt } }
 * Times are epoch ms. `state` ∈ queued | delivering | delivered | refused |
 * deferred_quota | failed; `cause` explains refused/deferred/failed rows and
 * `budget_stop` on a delivered row whose turn hit the USD cap. `fromName` and
 * `toName` are the sessions' sanitized titles (one line, controls stripped,
 * wrapper tags escaped, ≤ 80 chars). The same view is served by
 * `GET /api/sessions/:id/peer-messages`.
 */

import type { PeerMessageRow } from '@/modules/database/index.js';

export const PEER_MESSAGE_FRAME = 'peer-message';

export type PeerMessageView = {
  id: string;
  chainId: string;
  parentId: string | null;
  hop: number;
  state: PeerMessageRow['state'];
  cause: string | null;
  fromSessionId: string;
  fromUserId: number;
  fromName: string;
  fromMode: string;
  toSessionId: string;
  toUserId: number | null;
  toName: string;
  summary: string | null;
  body: string;
  bodyBytes: number;
  costUsdCharged: number | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
};

export type PeerMessageFrame = {
  type: typeof PEER_MESSAGE_FRAME;
  version: 1;
  sessionIds: [string, string];
  message: PeerMessageView;
};

/** The row as the UI sees it (no ref token, no internal attempt counters). */
export function toPeerMessageView(row: PeerMessageRow, fromName: string, toName: string): PeerMessageView {
  return {
    id: row.id, chainId: row.chain_id, parentId: row.parent_id, hop: row.hop, state: row.state, cause: row.cause,
    fromSessionId: row.from_session_id, fromUserId: row.from_user_id, fromName, fromMode: row.from_mode,
    toSessionId: row.to_session_id, toUserId: row.to_user_id, toName, summary: row.summary, body: row.body,
    bodyBytes: row.body_bytes, costUsdCharged: row.cost_usd_charged, createdAt: row.created_at,
    updatedAt: row.updated_at, deliveredAt: row.delivered_at,
  };
}

/** The frame both sessions' mirrors receive on every state change. */
export function buildPeerMessageFrame(row: PeerMessageRow, fromName: string, toName: string): PeerMessageFrame {
  return {
    type: PEER_MESSAGE_FRAME,
    version: 1,
    sessionIds: [row.from_session_id, row.to_session_id],
    message: toPeerMessageView(row, fromName, toName),
  };
}
