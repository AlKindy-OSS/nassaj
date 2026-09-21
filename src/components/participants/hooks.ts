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

/**
 * Floor between two WebSocket-triggered refetches (ms).
 *
 * Without it every streamed message fired a refetch, and the agents endpoint is
 * not cheap on a live conversation: its cache key is the transcript's mtime,
 * which changes on every append, so each call re-streams the whole JSONL, opens
 * one sidecar file per subagent, and rewrites the SQLite cache — per viewer,
 * per open conversation. The roster changes on the scale of minutes; polling it
 * at the token rate bought nothing and paid for it in I/O.
 *
 * A dropped burst is not lost: the trailing edge always fires, and the 10 s
 * poll is the backstop.
 */
const WS_REFETCH_MIN_INTERVAL_MS = 3_000;

type SessionParticipantsState = {
  status: AsyncResourceStatus;
  participants: SessionParticipant[];
  agents: SessionAgent[];
  /** `sessions.provider` — the CLI that ran the turns (B-410). */
  harness: string | null;
  /** `sessions.engine_provider` — the vendor that served them (ADR-088). */
  engine: string | null;
};

const EMPTY_SESSION_STATE: SessionParticipantsState = {
  status: 'idle',
  participants: [],
  agents: [],
  harness: null,
  engine: null,
};

const PARTICIPANTS_CACHE_TTL_MS = 30_000;
const PARTICIPANTS_CACHE_MAX_ENTRIES = 64;
type ParticipantCacheEntry<T> = { value: T; expiresAt: number };

const sessionParticipantsCache = new Map<string, ParticipantCacheEntry<SessionParticipantsState>>();
const sessionParticipantsInFlight = new Map<string, Promise<SessionParticipantsState>>();
const projectParticipantsCache = new Map<string, ParticipantCacheEntry<ProjectParticipantsState>>();
const projectParticipantsInFlight = new Map<string, Promise<ProjectParticipantsState>>();

function readParticipantCache<T>(cache: Map<string, ParticipantCacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Refresh insertion order so capacity eviction is least-recently-used.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function writeParticipantCache<T>(cache: Map<string, ParticipantCacheEntry<T>>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + PARTICIPANTS_CACHE_TTL_MS });
  while (cache.size > PARTICIPANTS_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/** Test-only reset for module-level caches and single-flight registries. */
export function resetParticipantCachesForTests(): void {
  sessionParticipantsCache.clear();
  sessionParticipantsInFlight.clear();
  projectParticipantsCache.clear();
  projectParticipantsInFlight.clear();
}

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

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
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
export function useSessionParticipants(sessionId: string | null | undefined, active = true) {
  const [state, setState] = useState<SessionParticipantsState>(EMPTY_SESSION_STATE);
  const mountedRef = useRef(true);
  // Tracks whether a fetch is already in-flight to avoid concurrent duplicates.
  const fetchingRef = useRef(false);
  // Guards the legacy `load()` path against duplicate first-load calls.
  const requestedRef = useRef(false);
  // Throttle state for the WebSocket trigger (see WS_REFETCH_MIN_INTERVAL_MS).
  const lastWsFetchRef = useRef(0);
  const wsTimerRef = useRef<number | null>(null);

  const { latestMessage } = useWebSocket();

  /** Inner fetch — safe to call at any time; skips if unmounted or in-flight. */
  const fetchParticipants = useCallback(async () => {
    if (!sessionId || !active || !mountedRef.current || fetchingRef.current) return;
    fetchingRef.current = true;

    try {
      let request = sessionParticipantsInFlight.get(sessionId);
      if (!request) {
        request = Promise.all([
          api.sessionParticipants(sessionId).then(readEnvelope),
          api.sessionAgents(sessionId).then(readEnvelope),
        ]).then(([participantsData, agentsData]) => ({
          status: 'success' as const,
          participants: asArray<SessionParticipant>(participantsData.participants),
          agents: asArray<SessionAgent>(agentsData.agents),
          harness: asString(agentsData.harness),
          engine: asString(agentsData.engine),
        }));
        sessionParticipantsInFlight.set(sessionId, request);
        void request.then(
          () => sessionParticipantsInFlight.delete(sessionId),
          () => sessionParticipantsInFlight.delete(sessionId),
        );
      }
      const next = await request;
      if (!mountedRef.current) return;
      writeParticipantCache(sessionParticipantsCache, sessionId, next);
      setState(next);
      // Mark legacy guard as satisfied so `load()` won't double-fetch.
      requestedRef.current = true;
    } catch {
      if (!mountedRef.current) return;
      requestedRef.current = false;
      setState((previous) => ({ ...previous, status: 'error' }));
    } finally {
      fetchingRef.current = false;
    }
  }, [active, sessionId]);

  // Mount / sessionId-change: reset state, start fresh fetch + polling.
  useEffect(() => {
    mountedRef.current = true;
    requestedRef.current = false;
    fetchingRef.current = false;
    setState(sessionId ? (readParticipantCache(sessionParticipantsCache, sessionId) ?? EMPTY_SESSION_STATE) : EMPTY_SESSION_STATE);

    if (!sessionId || !active) return;

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
  }, [active, sessionId, fetchParticipants]);

  // Re-fetch on WebSocket activity, throttled with a trailing edge: the first
  // message after a quiet period fetches immediately, and a burst collapses
  // into ONE follow-up scheduled at the end of the window. The trailing timer
  // is what makes dropping safe — without it the last message of a burst (the
  // one that settled the roster) would be the one silently discarded.
  useEffect(() => {
    if (!active || !latestMessage || !sessionId) return;

    const sinceLast = Date.now() - lastWsFetchRef.current;
    if (sinceLast >= WS_REFETCH_MIN_INTERVAL_MS) {
      lastWsFetchRef.current = Date.now();
      void fetchParticipants();
      return;
    }

    if (wsTimerRef.current !== null) return; // a trailing fetch is already queued
    wsTimerRef.current = window.setTimeout(() => {
      wsTimerRef.current = null;
      lastWsFetchRef.current = Date.now();
      void fetchParticipants();
    }, WS_REFETCH_MIN_INTERVAL_MS - sinceLast);
  }, [active, latestMessage, sessionId, fetchParticipants]);

  // The trailing timer outlives the effect that scheduled it, so it is cleared
  // on unmount / session change rather than on every message.
  useEffect(() => {
    return () => {
      if (wsTimerRef.current !== null) {
        window.clearTimeout(wsTimerRef.current);
        wsTimerRef.current = null;
      }
      lastWsFetchRef.current = 0;
    };
  }, [sessionId]);

  /**
   * Legacy callback kept for hover / on-demand triggers.
   * No-ops when data has already been loaded by the automatic path.
   */
  const load = useCallback(() => {
    if (!active || !sessionId || requestedRef.current) return;
    setState((previous) => ({ ...previous, status: 'loading' }));
    void fetchParticipants();
  }, [active, sessionId, fetchParticipants]);

  return { ...state, load };
}

type ProjectParticipantsState = {
  status: AsyncResourceStatus;
  users: SessionParticipant[];
  agents: SessionAgent[];
  /** Source of the agent observations returned for this project. */
  agentsSource: 'cache' | null;
};

const EMPTY_PROJECT_STATE: ProjectParticipantsState = {
  status: 'idle',
  users: [],
  agents: [],
  agentsSource: null,
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
    const cached = projectId ? readParticipantCache(projectParticipantsCache, projectId) : undefined;
    requestedRef.current = Boolean(cached);
    setState(cached ?? EMPTY_PROJECT_STATE);
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

    let request = projectParticipantsInFlight.get(projectId);
    if (!request) {
      request = api.projectParticipants(projectId)
        .then(readEnvelope)
        .then((data) => ({
          status: 'success' as const,
          users: asArray<SessionParticipant>(data.users),
          agents: asArray<SessionAgent>(data.agents),
          agentsSource: data.agentsSource === 'cache' ? 'cache' as const : null,
        }));
      projectParticipantsInFlight.set(projectId, request);
      void request.then(
        () => projectParticipantsInFlight.delete(projectId),
        () => projectParticipantsInFlight.delete(projectId),
      );
    }
    request.then((next) => {
        if (!mountedRef.current) return;
        writeParticipantCache(projectParticipantsCache, projectId, next);
        setState(next);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        requestedRef.current = false;
        setState((previous) => ({ ...previous, status: 'error' }));
      });
  }, [projectId]);

  return { ...state, load };
}
