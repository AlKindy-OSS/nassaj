import { useEffect, useState } from 'react';

import { useWebSocket } from '../../contexts/WebSocketContext';

/**
 * Live presence (C-MU-UX-PRESENCE).
 *
 * One entry per connected brother. Mirrors the backend `presence` snapshot
 * (server/modules/websocket/services/presence.service.ts):
 *
 *   { type: 'presence', users: PresenceUser[], activeConversations: ActiveConversations, timestamp }
 *
 * A user is `connected` while ≥1 of their sockets is open (multi-tab dedupe is
 * done server-side), and `active` while they have ≥1 running provider command —
 * in which case the session/project they are on is surfaced.
 */
export type PresenceUser = {
  userId: string;
  username: string;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) when the user
  // has uploaded one; null falls back to the coloured initial.
  avatarUrl: string | null;
  connected: true;
  active: boolean;
  activeSessionId: string | null;
  activeProjectPath: string | null;
  provider: string | null;
  since: number;
};

/**
 * Server-authoritative active conversations breakdown, carried inside each
 * `presence` message.  `byProject` is already filtered to the projects visible
 * to the current user and sorted descending by count.
 * `total === sum(byProject[*].count) + hiddenCount`.
 */
export type ActiveConversations = {
  total: number;
  byProject: Array<{ projectPath: string; count: number }>;
  hiddenCount: number;
};

/**
 * One live run the recipient may see, carried in every presence snapshot
 * (B-269). Lets any client learn which conversations are busy without having
 * opened them — the `process_state` stream only reaches a session's primary
 * socket and its registered mirrors.
 */
export type RunningSession = {
  sessionId: string;
  state: 'running' | 'frozen';
};

/** WS message name the backend broadcasts presence under. */
export const PRESENCE_MESSAGE_TYPE = 'presence';

type PresenceMessage = {
  type?: string;
  users?: unknown;
  activeConversations?: unknown;
  runningSessions?: unknown;
};

/** Narrows one raw snapshot entry to a PresenceUser, or null when malformed. */
function parsePresenceUser(raw: unknown): PresenceUser | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (entry.userId === undefined || entry.userId === null) {
    return null;
  }
  return {
    userId: String(entry.userId),
    username: typeof entry.username === 'string' ? entry.username : String(entry.userId),
    avatarUrl: typeof entry.avatarUrl === 'string' && entry.avatarUrl.length > 0 ? entry.avatarUrl : null,
    connected: true,
    active: Boolean(entry.active),
    activeSessionId: typeof entry.activeSessionId === 'string' ? entry.activeSessionId : null,
    activeProjectPath: typeof entry.activeProjectPath === 'string' ? entry.activeProjectPath : null,
    provider: typeof entry.provider === 'string' ? entry.provider : null,
    since: typeof entry.since === 'number' ? entry.since : 0,
  };
}

/** Narrows the raw activeConversations field, or returns null when absent/malformed. */
function parseActiveConversations(raw: unknown): ActiveConversations | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const total = typeof entry.total === 'number' ? entry.total : null;
  if (total === null) {
    return null;
  }
  const hiddenCount = typeof entry.hiddenCount === 'number' ? entry.hiddenCount : 0;
  const rawByProject = Array.isArray(entry.byProject) ? entry.byProject : [];
  const byProject = rawByProject
    .filter(
      (item): item is { projectPath: string; count: number } =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).projectPath === 'string' &&
        typeof (item as Record<string, unknown>).count === 'number',
    )
    .map((item) => ({ projectPath: item.projectPath, count: item.count }));

  return { total, byProject, hiddenCount };
}

/**
 * Narrows the raw `runningSessions` field of a presence snapshot (B-269).
 * Returns [] for an absent/malformed field — an older server that does not send
 * it yields an empty list, which reconciliation treats as "presence owns
 * nothing", leaving the legacy mirror-fed behaviour exactly as it was.
 */
export function parseRunningSessions(raw: unknown): RunningSession[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const parsed: RunningSession[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const state = entry.state;
    if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) {
      continue;
    }
    if (state !== 'running' && state !== 'frozen') {
      continue;
    }
    parsed.push({ sessionId: entry.sessionId, state });
  }
  return parsed;
}

type UsePresenceResult = {
  users: PresenceUser[];
  activeConversations: ActiveConversations | null;
};

/**
 * Subscribes to the realtime `presence` channel via the shared WebSocket stream.
 * Returns the current list of connected brothers (empty until the first
 * snapshot arrives — render nothing gracefully in that case) and the
 * server-authoritative active-conversations breakdown (null until the first
 * snapshot arrives).
 *
 * The existing `usePresence(): PresenceUser[]` call signature is preserved via
 * a function overload so existing callers are unaffected.
 */
export function usePresence(): UsePresenceResult {
  const { latestMessage } = useWebSocket();
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const [activeConversations, setActiveConversations] = useState<ActiveConversations | null>(null);

  useEffect(() => {
    const message = latestMessage as PresenceMessage | null;
    if (!message || message.type !== PRESENCE_MESSAGE_TYPE) {
      return;
    }
    const list = Array.isArray(message.users) ? message.users : [];
    const parsed = list
      .map(parsePresenceUser)
      .filter((entry): entry is PresenceUser => entry !== null);
    setUsers(parsed);

    const parsedConversations = parseActiveConversations(message.activeConversations);
    setActiveConversations(parsedConversations);
  }, [latestMessage]);

  return { users, activeConversations };
}
