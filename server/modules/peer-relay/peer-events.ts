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
 *       costUsdCharged, deliveryPath, createdAt, updatedAt, deliveredAt } }
 * Times are epoch ms. `state` ∈ queued | delivering | delivered | refused |
 * deferred_quota | failed; `cause` explains refused/deferred/failed rows and
 * `budget_stop` on a delivered row whose turn hit the USD cap. `fromName` and
 * `toName` are the sessions' sanitized titles (one line, controls stripped,
 * wrapper tags escaped, ≤ 80 chars). The same view is served by
 * `GET /api/sessions/:id/peer-messages`.
 */

import type { PeerMessageRow } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/dependencies -- ADR-219: the relay's own leaf repository (see peer-relay.service.ts).
import type { PeerHoldRow } from '@/modules/database/repositories/peer-holds.db.js';

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
  /** `resume` once a delivery was claimed (P2a-min: the only path); null before. */
  deliveryPath: string | null;
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
    bodyBytes: row.body_bytes, costUsdCharged: row.cost_usd_charged, deliveryPath: row.delivery_path, createdAt: row.created_at,
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

// ---------------------------------------------------------------------------
// ADR-219 P2a-min — the `peer-hold` frame (the hold card's contract).
//
// Shape (version 1):
//   { type: 'peer-hold', version: 1, sessionIds: [from, to], hold: PeerHoldView }
// Sent to both sessions' gated mirrors on every hold state change. `body` is the
// full untrusted text (render as text, never markup); `bodyVisible` is the same
// text with every invisible format/bidi/control character shown as `⟨U+XXXX⟩`.
// `targetMode` is the target session's last run mode (raw CLI mode, null when
// unknown); `expectedTargetMode` of an approve must equal it. The buttons belong
// to `toUserId` only and only while `state === 'held'`; the server enforces it.
// ---------------------------------------------------------------------------

export const PEER_HOLD_FRAME = 'peer-hold';

export type PeerHoldView = {
  id: string; chainId: string; state: PeerHoldRow['state']; holdVersion: number; holdCauses: string;
  cause: string | null; fromUserId: number; fromMemberName: string; fromSessionId: string; fromName: string;
  fromMode: string; toUserId: number; toSessionId: string; toName: string; projectId: string | null;
  body: string; bodyVisible: string; bodySha256: string; bodyBytes: number; summary: string | null; hop: number;
  targetMode: string | null; targetModeLabel: string | null; targetModeShown: string | null;
  decidedBy: number | null; decidedAt: number | null; rejectReason: string | null; messageId: string | null;
  expiresAt: number; createdAt: number; updatedAt: number;
};

export type PeerHoldFrame = { type: typeof PEER_HOLD_FRAME; version: 1; sessionIds: [string, string]; hold: PeerHoldView };

/** Invisible characters a reviewer must see: format (Cf, bidi, zero-width), line/paragraph separators, C0/C1 except \n and \t. */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]|[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

/** The body with every invisible character shown as a visible `⟨U+XXXX⟩` token (N4). */
export function visibleBody(body: string): string {
  return body.replace(INVISIBLE, (ch) => `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`);
}

export type PeerHoldNames = { fromMemberName: string; fromName: string; toName: string; targetMode: string | null };

/** The hold as the card sees it (server-derived names and mode; never the transcript). */
export function toPeerHoldView(row: PeerHoldRow, names: PeerHoldNames): PeerHoldView {
  return {
    id: row.id, chainId: row.chain_id, state: row.state, holdVersion: row.hold_version, holdCauses: row.hold_causes,
    cause: row.cause, fromUserId: row.from_user_id, fromMemberName: names.fromMemberName,
    fromSessionId: row.from_session_id, fromName: names.fromName, fromMode: row.from_mode, toUserId: row.to_user_id,
    toSessionId: row.to_session_id, toName: names.toName, projectId: row.project_id, body: row.body,
    bodyVisible: visibleBody(row.body), bodySha256: row.body_sha256, bodyBytes: row.body_bytes, summary: row.summary,
    hop: row.hop, targetMode: names.targetMode,
    targetModeLabel: names.targetMode === null ? null : `${names.targetMode} (this session's last run)`,
    targetModeShown: row.target_mode_shown, decidedBy: row.decided_by, decidedAt: row.decided_at,
    rejectReason: row.reject_reason, messageId: row.message_id, expiresAt: row.expires_at, createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The frame both sessions' mirrors receive on every hold change. */
export function buildPeerHoldFrame(view: PeerHoldView): PeerHoldFrame {
  return { type: PEER_HOLD_FRAME, version: 1, sessionIds: [view.fromSessionId, view.toSessionId], hold: view };
}
