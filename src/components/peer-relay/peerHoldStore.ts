/**
 * ADR-219 P2a-min (T-2074) — client mirror of the `peer-hold` v1 WS frame.
 *
 * A cross-member message waits in `peer_holds` until the target session's
 * owner delivers or rejects it. The server sends the frame to both sessions'
 * gated mirrors on every hold change (server/modules/peer-relay/peer-events.ts).
 * This module validates the view field by field and keeps the newest one per
 * hold id (higher `holdVersion` wins). Card identity (sender, mode, owner,
 * state) comes only from these fields; the body is untrusted text.
 *
 * Seeded from `GET /api/peer-relay/sessions/:id/holds` on session open and from
 * `GET /api/peer-relay/holds` (the caller's inbox); live frames then update it.
 */

import { useMemo, useSyncExternalStore } from 'react';

import { authenticatedFetch } from '../../utils/api';

export const PEER_HOLD_FRAME_TYPE = 'peer-hold';

export const PEER_HOLD_STATES = ['held', 'promoted', 'rejected', 'expired', 'cancelled'] as const;
export type PeerHoldState = (typeof PEER_HOLD_STATES)[number];

export type PeerHoldView = {
  id: string;
  state: PeerHoldState;
  holdVersion: number;
  cause: string | null;
  fromUserId: number;
  /** Server-derived display name of the sending member. */
  fromMemberName: string;
  fromSessionId: string;
  fromName: string;
  toUserId: number;
  toSessionId: string;
  toName: string;
  body: string;
  /** The body with every invisible format/bidi/control character as `⟨U+XXXX⟩`. */
  bodyVisible: string;
  bodySha256: string;
  summary: string | null;
  /** Raw last run mode of the target session; an approve must echo it. */
  targetMode: string | null;
  rejectReason: string | null;
  messageId: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

/** The server caps held rows at 50 per target user, so one page is the whole inbox. */
const INBOX_PAGE = 50;
const MAX_PEER_HOLDS = 500;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const optionalText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Narrows one server hold view, or null when any identity field is malformed. */
export function parsePeerHoldView(value: unknown): PeerHoldView | null {
  const h = value as Record<string, unknown> | null;
  if (!h || typeof h !== 'object') return null;
  if (!isText(h.id) || !isText(h.fromSessionId) || !isText(h.toSessionId)) return null;
  if (!PEER_HOLD_STATES.includes(h.state as PeerHoldState) || !isId(h.holdVersion)) return null;
  if (!isId(h.fromUserId) || !isId(h.toUserId) || !isText(h.bodySha256)) return null;
  // Fail closed: without the server's visible rendering the raw body is never shown.
  if (typeof h.body !== 'string' || typeof h.bodyVisible !== 'string') return null;
  if (!isTime(h.expiresAt) || !isTime(h.createdAt) || !isTime(h.updatedAt)) return null;
  return {
    id: h.id,
    state: h.state as PeerHoldState,
    holdVersion: h.holdVersion,
    cause: optionalText(h.cause),
    fromUserId: h.fromUserId,
    fromMemberName: optionalText(h.fromMemberName) ?? '',
    fromSessionId: h.fromSessionId,
    fromName: optionalText(h.fromName) ?? '',
    toUserId: h.toUserId,
    toSessionId: h.toSessionId,
    toName: optionalText(h.toName) ?? '',
    body: h.body,
    bodyVisible: h.bodyVisible,
    bodySha256: h.bodySha256,
    summary: optionalText(h.summary),
    targetMode: optionalText(h.targetMode),
    rejectReason: optionalText(h.rejectReason),
    messageId: optionalText(h.messageId),
    expiresAt: h.expiresAt,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

/** Narrows one WS frame; unknown versions are rejected rather than guessed. */
export function parsePeerHoldFrame(frame: unknown): PeerHoldView | null {
  const data = frame as { type?: unknown; version?: unknown; hold?: unknown } | null;
  if (!data || data.type !== PEER_HOLD_FRAME_TYPE || data.version !== 1) return null;
  return parsePeerHoldView(data.hold);
}

let byId: ReadonlyMap<string, PeerHoldView> = new Map();
const listeners = new Set<() => void>();

function commit(next: Map<string, PeerHoldView>): void {
  byId = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getSnapshot = () => byId;

/** Applies one view; an older version (or an older update at the same version) is ignored. */
export function applyPeerHold(view: PeerHoldView): void {
  const existing = byId.get(view.id);
  if (existing && (existing.holdVersion > view.holdVersion
    || (existing.holdVersion === view.holdVersion && existing.updatedAt > view.updatedAt))) return;
  const next = new Map(byId);
  next.set(view.id, view);
  if (next.size > MAX_PEER_HOLDS) {
    const oldest = [...next.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) next.delete(oldest.id);
  }
  commit(next);
}

/** WS entry point: true when the frame was a peer-hold frame (valid or not). */
export function ingestPeerHoldFrame(frame: unknown): boolean {
  if ((frame as { type?: unknown } | null)?.type !== PEER_HOLD_FRAME_TYPE) return false;
  const view = parsePeerHoldFrame(frame);
  if (view) applyPeerHold(view);
  return true;
}

/** Forgets every hold (identity change and tests). */
export function resetPeerHolds(): void {
  if (byId.size > 0) commit(new Map());
}

if (typeof window !== 'undefined') {
  window.addEventListener('auth:identity-changing', resetPeerHolds);
}

/** Holds sent from or to `sessionId`, oldest first. */
export function selectPeerHoldsForSession(
  all: ReadonlyMap<string, PeerHoldView>, sessionId: string | null,
): PeerHoldView[] {
  if (!sessionId) return [];
  return [...all.values()]
    .filter((h) => h.fromSessionId === sessionId || h.toSessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Holds waiting for `userId`'s decision, newest first. */
export function selectPeerHoldInbox(all: ReadonlyMap<string, PeerHoldView>, userId: number | null): PeerHoldView[] {
  if (userId === null) return [];
  return [...all.values()]
    .filter((h) => h.state === 'held' && h.toUserId === userId)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** The whole store as React state (stable while nothing changes). */
export function usePeerHolds(): ReadonlyMap<string, PeerHoldView> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** React view of a session's holds. */
export function usePeerHoldsForSession(sessionId: string | null): PeerHoldView[] {
  const all = usePeerHolds();
  return useMemo(() => selectPeerHoldsForSession(all, sessionId), [all, sessionId]);
}

/** Fetches one hold list into the store; the ids it returned, or null on any failure. */
async function loadInto(url: string): Promise<string[] | null> {
  try {
    const response = await authenticatedFetch(url);
    if (!response.ok) return null;
    const body = await response.json() as { holds?: unknown[] };
    const ids: string[] = [];
    for (const row of body.holds ?? []) {
      const view = parsePeerHoldView(row);
      if (view) { applyPeerHold(view); ids.push(view.id); }
    }
    return ids;
  } catch {
    return null; /* best-effort; the live frames still render */
  }
}

/** Seeds the store with one session's holds; never throws. */
export async function loadPeerHoldsForSession(sessionId: string): Promise<void> {
  await loadInto(`/api/peer-relay/sessions/${encodeURIComponent(sessionId)}/holds`);
}

/**
 * Seeds the store with the caller's inbox; never throws. Returns the ids the
 * server still holds for the caller (null on failure), so a hold decided on
 * another device and never framed to this one drops out of the inbox.
 */
export function loadPeerHoldInbox(): Promise<string[] | null> {
  return loadInto(`/api/peer-relay/holds?limit=${INBOX_PAGE}`);
}
