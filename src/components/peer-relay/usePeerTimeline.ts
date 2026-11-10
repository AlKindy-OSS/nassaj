import { useEffect, useMemo } from 'react';

import { useOptionalAuth } from '../auth/context/AuthContext';
import { getAllSessions } from '../sidebar/utils/utils';
import type { Project } from '../../types/app';

import { loadPeerHoldsForSession, usePeerHoldsForSession, type PeerHoldView } from './peerHoldStore';
import { loadPeerMessagesForSession, usePeerMessagesForSession, type PeerMessageView } from './peerMessageStore';

/** States in which a message never reached the target: hidden from the target's timeline. */
const UNDELIVERED = new Set(['refused', 'failed']);

/** One timeline item: an S1 peer message, or a P2a-min cross-member hold (with its approved message). */
export type PeerTimelineEntry =
  | { kind: 'message'; id: string; createdAt: number; message: PeerMessageView }
  | { kind: 'hold'; id: string; createdAt: number; hold: PeerHoldView; linked: PeerMessageView | null };

export type PeerTimeline = {
  /** Items for this session's timeline, oldest first, with `createdAt` for placement. */
  items: PeerTimelineEntry[];
  /** The signed-in member (null outside an auth provider): decides who gets hold buttons. */
  viewerUserId: number | null;
  /** Ids of peer messages addressed to this session (gates the "started by" tag). */
  inboundIds: ReadonlySet<string>;
  /** Display name of a session the viewer's own session list holds, else undefined. */
  nameOf: (sessionId: string) => string | undefined;
  /** True when the viewer's session list holds the session, so a link can open it. */
  isReadable: (sessionId: string) => boolean;
};

/**
 * Merges messages and holds for one session. In the TARGET session a hold's
 * approved message is folded into the hold card (one card, not two). In the
 * SENDER session a promoted hold is dropped: its message's outbound card
 * carries the delivery state from there.
 */
export function buildPeerEntries(
  messages: PeerMessageView[], holds: PeerHoldView[], sessionId: string | null,
): PeerTimelineEntry[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const folded = new Set<string>();
  const entries: PeerTimelineEntry[] = [];
  for (const hold of holds) {
    if (hold.toSessionId === sessionId) {
      const linked = hold.messageId ? byId.get(hold.messageId) ?? null : null;
      if (linked) folded.add(linked.id);
      entries.push({ kind: 'hold', id: `hold-${hold.id}`, createdAt: hold.createdAt, hold, linked });
    } else if (hold.state !== 'promoted') {
      entries.push({ kind: 'hold', id: `hold-${hold.id}`, createdAt: hold.createdAt, hold, linked: null });
    }
  }
  for (const message of messages) {
    if (folded.has(message.id)) continue;
    if (message.toSessionId === sessionId && UNDELIVERED.has(message.state)) continue;
    entries.push({ kind: 'message', id: `peer-${message.id}`, createdAt: message.createdAt, message });
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * ADR-219 S1: the session's peer messages plus the viewer-side facts a card
 * needs. Readability is what the viewer's session list (server-filtered by the
 * read gate) already holds for the selected project; a session outside it gets
 * no link. Names come from that list too, never from a message body.
 */
export function usePeerTimeline(sessionId: string | null, project: Project | null | undefined): PeerTimeline {
  const messages = usePeerMessagesForSession(sessionId);
  const holds = usePeerHoldsForSession(sessionId);
  const auth = useOptionalAuth();
  const rawUserId = auth?.user?.id;
  const viewerUserId = rawUserId === undefined || rawUserId === null || !Number.isInteger(Number(rawUserId))
    ? null : Number(rawUserId);
  // History on session open (the live frames only cover what happens after it).
  useEffect(() => {
    if (!sessionId) return;
    void loadPeerMessagesForSession(sessionId);
    void loadPeerHoldsForSession(sessionId);
  }, [sessionId]);
  const names = useMemo(() => {
    const byId = new Map<string, string>();
    if (!project) return byId;
    for (const session of getAllSessions(project)) {
      const name = session.summary || session.name || session.title || '';
      byId.set(String(session.id), typeof name === 'string' ? name : '');
    }
    return byId;
  }, [project]);
  return useMemo(() => {
    const items = buildPeerEntries(messages, holds, sessionId);
    const inboundIds = new Set(messages.filter((m) => m.toSessionId === sessionId).map((m) => m.id));
    return {
      items,
      viewerUserId,
      inboundIds,
      nameOf: (id: string) => names.get(id) || undefined,
      isReadable: (id: string) => names.has(id),
    };
  }, [messages, holds, names, sessionId, viewerUserId]);
}
