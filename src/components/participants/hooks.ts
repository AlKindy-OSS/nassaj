import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../utils/api';
import { useWebSocket } from '../../contexts/WebSocketContext';

import type {
  AsyncResourceStatus,
  SessionAgent,
  SessionParticipant,
} from './types';

/** Polling interval for live participant updates (ms). */
const PARTICIPANTS_POLL_INTERVAL_MS = 10_000;

type SessionParticipantsState = {
  status: AsyncResourceStatus;
  participants: SessionParticipant[];
  agents: SessionAgent[];
};

const EMPTY_SESSION_STATE: SessionParticipantsState = {
  status: 'idle',
  participants: [],
  agents: [],
};

// The backend wraps payloads in `{ success: true, data: {...} }`. This unwraps
// the envelope (tolerating a bare body) and surfaces failures consistently.
async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (body && typeof body === 'object' && 'data' in body) {
    if (body.success === false) {
      throw new Error('Request returned success=false');
    }
    return (body.data as Record<string, unknown>) ?? {};
  }
  return body ?? {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Loads humans + agents for a single session and keeps them live via:
 *   - an immediate fetch on mount / sessionId change
 *   - a 10-second polling interval
 *   - an immediate re-fetch on any incoming WebSocket message
 *
 * The legacy `load()` callback is still exposed for consumers that trigger a
 * fetch on hover / explicit user action.
 */
export function useSessionParticipants(sessionId: string | null | undefined) {
  const [state, setState] = useState<SessionParticipantsState>(EMPTY_SESSION_STATE);
  const mountedRef = useRef(true);
  // Tracks whether a fetch is already in-flight to avoid concurrent duplicates.
  const fetchingRef = useRef(false);
  // Guards the legacy `load()` path against duplicate first-load calls.
  const requestedRef = useRef(false);

  const { latestMessage } = useWebSocket();

  /** Inner fetch — safe to call at any time; skips if unmounted or in-flight. */
  const fetchParticipants = useCallback(async () => {
    if (!sessionId || !mountedRef.current || fetchingRef.current) return;
    fetchingRef.current = true;

    try {
      const [participantsData, agentsData] = await Promise.all([
        api.sessionParticipants(sessionId).then(readEnvelope),
        api.sessionAgents(sessionId).then(readEnvelope),
      ]);
      if (!mountedRef.current) return;
      setState({
        status: 'success',
        participants: asArray<SessionParticipant>(participantsData.participants),
        agents: asArray<SessionAgent>(agentsData.agents),
      });
      // Mark legacy guard as satisfied so `load()` won't double-fetch.
      requestedRef.current = true;
    } catch {
      if (!mountedRef.current) return;
      requestedRef.current = false;
      setState((previous) => ({ ...previous, status: 'error' }));
    } finally {
      fetchingRef.current = false;
    }
  }, [sessionId]);

  // Mount / sessionId-change: reset state, start fresh fetch + polling.
  useEffect(() => {
    mountedRef.current = true;
    requestedRef.current = false;
    fetchingRef.current = false;
    setState(EMPTY_SESSION_STATE);

    if (!sessionId) return;

    // Immediate fetch.
    void fetchParticipants();

    // Polling every 10 s.
    const intervalId = setInterval(() => {
      void fetchParticipants();
    }, PARTICIPANTS_POLL_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      mountedRef.current = false;
    };
  }, [sessionId, fetchParticipants]);

  // Re-fetch on any WebSocket activity (signals new session events).
  useEffect(() => {
    if (!latestMessage || !sessionId) return;
    void fetchParticipants();
  }, [latestMessage, sessionId, fetchParticipants]);

  /**
   * Legacy callback kept for hover / on-demand triggers.
   * No-ops when data has already been loaded by the automatic path.
   */
  const load = useCallback(() => {
    if (!sessionId || requestedRef.current) return;
    setState((previous) => ({ ...previous, status: 'loading' }));
    void fetchParticipants();
  }, [sessionId, fetchParticipants]);

  return { ...state, load };
}

type ProjectParticipantsState = {
  status: AsyncResourceStatus;
  users: SessionParticipant[];
  agents: SessionAgent[];
};

const EMPTY_PROJECT_STATE: ProjectParticipantsState = {
  status: 'idle',
  users: [],
  agents: [],
};

/**
 * Lazily loads aggregated participants for a project. Same lazy contract as
 * {@link useSessionParticipants}.
 */
export function useProjectParticipants(projectId: string | null | undefined) {
  const [state, setState] = useState<ProjectParticipantsState>(EMPTY_PROJECT_STATE);
  const requestedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    requestedRef.current = false;
    setState(EMPTY_PROJECT_STATE);
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (!projectId || requestedRef.current) {
      return;
    }
    requestedRef.current = true;
    setState((previous) => ({ ...previous, status: 'loading' }));

    api
      .projectParticipants(projectId)
      .then(readEnvelope)
      .then((data) => {
        if (!mountedRef.current) return;
        setState({
          status: 'success',
          users: asArray<SessionParticipant>(data.users),
          agents: asArray<SessionAgent>(data.agents),
        });
      })
      .catch(() => {
        if (!mountedRef.current) return;
        requestedRef.current = false;
        setState((previous) => ({ ...previous, status: 'error' }));
      });
  }, [projectId]);

  return { ...state, load };
}
