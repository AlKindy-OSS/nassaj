import { useEffect, useMemo } from 'react';

import { getAllSessions } from '../sidebar/utils/utils';
import type { Project } from '../../types/app';

import { loadPeerMessagesForSession, usePeerMessagesForSession, type PeerMessageView } from './peerMessageStore';

/** States in which a message never reached the target: hidden from the target's timeline. */
const UNDELIVERED = new Set(['refused', 'failed']);

export type PeerTimeline = {
  /** Items for this session's timeline, oldest first, with `createdAt` for placement. */
  items: PeerMessageView[];
  /** Ids of peer messages addressed to this session (gates the "started by" tag). */
  inboundIds: ReadonlySet<string>;
  /** Display name of a session the viewer's own session list holds, else undefined. */
  nameOf: (sessionId: string) => string | undefined;
  /** True when the viewer's session list holds the session, so a link can open it. */
  isReadable: (sessionId: string) => boolean;
};

/**
 * ADR-219 S1: the session's peer messages plus the viewer-side facts a card
 * needs. Readability is what the viewer's session list (server-filtered by the
 * read gate) already holds for the selected project; a session outside it gets
 * no link. Names come from that list too, never from a message body.
 */
export function usePeerTimeline(sessionId: string | null, project: Project | null | undefined): PeerTimeline {
  const messages = usePeerMessagesForSession(sessionId);
  // History on session open (the live frames only cover what happens after it).
  useEffect(() => {
    if (sessionId) void loadPeerMessagesForSession(sessionId);
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
    const items = messages.filter((m) => m.toSessionId !== sessionId || !UNDELIVERED.has(m.state));
    const inboundIds = new Set(messages.filter((m) => m.toSessionId === sessionId).map((m) => m.id));
    return {
      items,
      inboundIds,
      nameOf: (id: string) => names.get(id) || undefined,
      isReadable: (id: string) => names.has(id),
    };
  }, [messages, names, sessionId]);
}
