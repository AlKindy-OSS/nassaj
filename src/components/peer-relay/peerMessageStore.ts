/**
 * ADR-219 S1 (T-2072) — client mirror of the `peer-message` v1 WS frame.
 *
 * The server sends the frame to both sessions' gated mirrors on every state
 * change (server/modules/peer-relay/peer-events.ts). This module validates the
 * frame field by field and keeps the newest view per message id. A bubble's
 * identity (sender name, direction, state) comes only from these fields; the
 * body is untrusted text and is never parsed for identity.
 *
 * On session open the store is seeded from `GET /api/sessions/:id/peer-messages`
 * (same view shape, server-gated like the session itself); live frames then
 * update it. The store is cleared on an identity change.
 */

import { useMemo, useSyncExternalStore } from 'react';

import { authenticatedFetch } from '../../utils/api';

export const PEER_MESSAGE_FRAME_TYPE = 'peer-message';

export const PEER_MESSAGE_STATES = [
  'queued', 'delivering', 'delivered', 'refused', 'deferred_quota', 'failed',
] as const;
export type PeerMessageState = (typeof PEER_MESSAGE_STATES)[number];

export type PeerMessageView = {
  id: string;
  chainId: string;
  hop: number;
  state: PeerMessageState;
  cause: string | null;
  fromSessionId: string;
  fromName: string;
  fromMode: string;
  toSessionId: string;
  /** Server-sanitized title of the target session ('' when absent). */
  toName: string;
  summary: string | null;
  body: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
};

/** Cap on remembered messages; the oldest by `updatedAt` is dropped first. */
const MAX_PEER_MESSAGES = 500;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Narrows one frame to a view, or null when any identity field is malformed.
 * Unknown versions and states are rejected rather than guessed.
 */
export function parsePeerMessageFrame(frame: unknown): PeerMessageView | null {
  const data = frame as { type?: unknown; version?: unknown; message?: unknown } | null;
  if (!data || data.type !== PEER_MESSAGE_FRAME_TYPE || data.version !== 1) return null;
  return parsePeerMessageView(data.message);
}

/** Narrows one server view (the frame's `message`, or a history row). */
export function parsePeerMessageView(value: unknown): PeerMessageView | null {
  const m = value as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') return null;
  if (!isText(m.id) || !isText(m.fromSessionId) || !isText(m.toSessionId)) return null;
  if (!PEER_MESSAGE_STATES.includes(m.state as PeerMessageState)) return null;
  if (typeof m.body !== 'string' || !isTime(m.createdAt) || !isTime(m.updatedAt)) return null;
  return {
    id: m.id,
    chainId: isText(m.chainId) ? m.chainId : m.id,
    hop: typeof m.hop === 'number' ? m.hop : 0,
    state: m.state as PeerMessageState,
    cause: optionalText(m.cause),
    fromSessionId: m.fromSessionId,
    fromName: isText(m.fromName) ? m.fromName : '',
    fromMode: optionalText(m.fromMode) ?? '',
    toSessionId: m.toSessionId,
    toName: isText(m.toName) ? m.toName : '',
    summary: optionalText(m.summary),
    body: m.body,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    deliveredAt: isTime(m.deliveredAt) ? m.deliveredAt : null,
  };
}

let byId: ReadonlyMap<string, PeerMessageView> = new Map();
const listeners = new Set<() => void>();

function commit(next: Map<string, PeerMessageView>): void {
  byId = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getSnapshot = () => byId;

/** Applies one view; an older `updatedAt` than the stored one is ignored. */
export function applyPeerMessage(view: PeerMessageView): void {
  const existing = byId.get(view.id);
  if (existing && existing.updatedAt > view.updatedAt) return;
  const next = new Map(byId);
  next.set(view.id, view);
  if (next.size > MAX_PEER_MESSAGES) {
    const oldest = [...next.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) next.delete(oldest.id);
  }
  commit(next);
}

/** WS entry point: true when the frame was a peer-message frame (valid or not). */
export function ingestPeerMessageFrame(frame: unknown): boolean {
  if ((frame as { type?: unknown } | null)?.type !== PEER_MESSAGE_FRAME_TYPE) return false;
  const view = parsePeerMessageFrame(frame);
  if (view) applyPeerMessage(view);
  return true;
}

/** Forgets every message (identity change and tests). */
export function resetPeerMessages(): void {
  if (byId.size > 0) commit(new Map());
}

if (typeof window !== 'undefined') {
  window.addEventListener('auth:identity-changing', resetPeerMessages);
}

/** Messages sent from or to `sessionId`, oldest first. */
export function selectPeerMessagesForSession(
  all: ReadonlyMap<string, PeerMessageView>, sessionId: string | null,
): PeerMessageView[] {
  if (!sessionId) return [];
  return [...all.values()]
    .filter((m) => m.fromSessionId === sessionId || m.toSessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** React view of the session's peer messages; stable while nothing changes. */
export function usePeerMessagesForSession(sessionId: string | null): PeerMessageView[] {
  const all = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => selectPeerMessagesForSession(all, sessionId), [all, sessionId]);
}

/**
 * Seeds the store with a session's peer messages after a reload. A failure
 * leaves the store as it is (live frames still arrive); never throws.
 */
export async function loadPeerMessagesForSession(sessionId: string): Promise<void> {
  try {
    const response = await authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/peer-messages`);
    if (!response.ok) return;
    const body = await response.json() as { data?: { messages?: unknown[] } };
    for (const row of body.data?.messages ?? []) {
      const view = parsePeerMessageView(row);
      if (view) applyPeerMessage(view);
    }
  } catch {
    /* history is best-effort; the live frames still render */
  }
}
