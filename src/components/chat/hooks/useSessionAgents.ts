/**
 * useSessionAgents — the server's own list of a session's agents (ADR-218).
 *
 * The transcript scan (`useRunProgress`) only sees the current reply, so an
 * agent launched in an earlier turn, resumed through SendMessage, or still
 * running after a reload is invisible to it. The server keeps a registry of
 * those agents; this hook reads it:
 *   - one REST snapshot (`GET /api/sessions/:id/agents/live`) when the session
 *     opens or changes;
 *   - then every `session-agents` WS frame for THIS session (full snapshots,
 *     newest wins). A frame for another session is ignored.
 * State resets on a session switch. `{supported:false}` (a provider without a
 * registry) yields no rows, so the card behaves exactly as before.
 */

import { useEffect, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { authenticatedFetch } from '../../../utils/api';

export type SessionAgentState = 'running' | 'done' | 'failed' | 'stopped' | 'unknown';

/** One row of the server snapshot (the public `AgentRow`). */
export interface SessionAgentRow {
  key: string;
  sessionId: string;
  source: 'claude-subagent' | 'workflow';
  agentId?: string;
  toolUseIds: string[];
  label: string;
  agentType?: string;
  model?: string;
  effort?: string;
  background: boolean;
  state: SessionAgentState;
  startedAt: number;
  endedAt?: number;
  lastEventAt: number;
  accuracy: 'live' | 'reconstructed';
}

export interface SessionAgentsSnapshot {
  supported: boolean;
  agents: SessionAgentRow[];
}

const STATES: ReadonlySet<string> = new Set(['running', 'done', 'failed', 'stopped', 'unknown']);
const EMPTY: SessionAgentsSnapshot = { supported: false, agents: [] };

const optString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** One validated row, or null when the shape is not a session-agent row. */
function parseRow(raw: unknown): SessionAgentRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || typeof r.sessionId !== 'string') return null;
  if (typeof r.state !== 'string' || !STATES.has(r.state)) return null;
  const startedAt = typeof r.startedAt === 'number' ? r.startedAt : 0;
  return {
    key: r.key,
    sessionId: r.sessionId,
    source: r.source === 'workflow' ? 'workflow' : 'claude-subagent',
    agentId: optString(r.agentId),
    toolUseIds: Array.isArray(r.toolUseIds) ? r.toolUseIds.filter((id): id is string => typeof id === 'string') : [],
    label: typeof r.label === 'string' ? r.label : '',
    agentType: optString(r.agentType),
    model: optString(r.model),
    effort: optString(r.effort),
    background: r.background === true,
    state: r.state as SessionAgentState,
    startedAt,
    endedAt: typeof r.endedAt === 'number' ? r.endedAt : undefined,
    lastEventAt: typeof r.lastEventAt === 'number' ? r.lastEventAt : startedAt,
    accuracy: r.accuracy === 'live' ? 'live' : 'reconstructed',
  };
}

/**
 * Validates a snapshot (REST `data` or WS frame) for `sessionId`.
 * @returns the snapshot; rows of another session are dropped; null when malformed.
 */
export function parseSessionAgentsSnapshot(raw: unknown, sessionId: string): SessionAgentsSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.supported !== 'boolean') return null;
  if (!r.supported) return EMPTY;
  const rows = Array.isArray(r.agents) ? r.agents.map(parseRow) : [];
  return { supported: true, agents: rows.filter((row): row is SessionAgentRow => row !== null && row.sessionId === sessionId) };
}

type Held = { sessionId: string | null; snapshot: SessionAgentsSnapshot };

/**
 * @param sessionId the open session, or null.
 * @returns the latest snapshot for that session (empty until one arrives).
 */
export function useSessionAgents(sessionId: string | null): SessionAgentsSnapshot {
  const { sessionAgentsFrames } = useWebSocket();
  const [held, setHeld] = useState<Held>({ sessionId, snapshot: EMPTY });
  // Seq of the newest WS frame applied for the open session. A REST answer is
  // applied only when no frame newer than the one cached at open arrived since,
  // so a late REST answer never rolls a live frame back, while a frame cached
  // from an earlier visit is still replaced by the fresh REST read.
  const appliedSeqRef = useRef(0);
  const framesRef = useRef(sessionAgentsFrames);
  framesRef.current = sessionAgentsFrames;

  useEffect(() => {
    const cached = sessionId ? framesRef.current?.get(sessionId) : undefined;
    const baseline = cached?.seq ?? 0;
    appliedSeqRef.current = baseline;
    const cachedSnapshot = cached && sessionId ? parseSessionAgentsSnapshot(cached.frame, sessionId) : null;
    setHeld({ sessionId, snapshot: cachedSnapshot ?? EMPTY });
    if (!sessionId) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/agents/live`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const body = await response.json();
        const snapshot = parseSessionAgentsSnapshot(body?.data, sessionId);
        if (!snapshot || controller.signal.aborted || appliedSeqRef.current !== baseline) return;
        setHeld({ sessionId, snapshot });
      } catch {
        /* the next WS frame or the next open recovers it */
      }
    })();
    return () => controller.abort();
  }, [sessionId]);

  const frame = sessionId ? sessionAgentsFrames?.get(sessionId) : undefined;
  useEffect(() => {
    if (!sessionId || !frame || frame.seq <= appliedSeqRef.current) return;
    const snapshot = parseSessionAgentsSnapshot(frame.frame, sessionId);
    if (!snapshot) return;
    appliedSeqRef.current = frame.seq;
    setHeld({ sessionId, snapshot });
  }, [sessionId, frame]);

  // A switch renders once before the reset effect runs: never show the old list.
  return held.sessionId === sessionId ? held.snapshot : EMPTY;
}
