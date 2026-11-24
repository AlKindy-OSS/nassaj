import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { readSessionWorkspaceGeneration } from '../../../utils/sessionWorkspaceBinding';
import type {
  TurnCheckpointListResponse,
  TurnCheckpointSummary,
  TurnFileDiffResponse,
  TurnFileDiffState,
  TurnListStatus,
} from '../types/turnCheckpoints';

type UseTurnCheckpointsOptions = {
  projectId: string | null;
  sessionId: string | null;
};

export type TurnCheckpointsController = {
  status: TurnListStatus;
  turns: TurnCheckpointSummary[];
  hasOlder: boolean;
  isLoadingOlder: boolean;
  /** Per-file diff state keyed `${turnSeq}:${path}`. */
  fileDiffs: Record<string, TurnFileDiffState>;
  retry: () => void;
  loadOlder: () => Promise<void>;
  loadFileDiff: (turnSeq: number, path: string) => Promise<void>;
};

/** Cache key of one file diff inside one turn. */
export function turnFileKey(turnSeq: number, path: string): string {
  return `${turnSeq}:${path}`;
}

/** Query of the caller's bound overlay, or null when no binding exists (always a 404). */
function overlayQuery(projectId: string | null, sessionId: string | null): URLSearchParams | null {
  if (!projectId || !sessionId) return null;
  const generation = readSessionWorkspaceGeneration(sessionId);
  if (!generation) return null;
  return new URLSearchParams({ project: projectId, sessionId, generation });
}

async function getJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  const response = await authenticatedFetch(url);
  if (!response.ok) return { status: response.status, body: null };
  return { status: response.status, body: (await response.json()) as T };
}

function diffStateOf(body: TurnFileDiffResponse): TurnFileDiffState {
  if ('withheld' in body && body.withheld) return { status: 'withheld', reason: body.reason };
  if ('diff' in body && typeof body.diff === 'string') {
    return { status: 'ready', diff: body.diff, truncated: Boolean(body.truncated) };
  }
  return { status: 'unavailable' };
}

/**
 * T-2095: the caller's own turn checkpoints for one session overlay, newest
 * first. Any 404 (no overlay, another owner, no store) is one neutral state.
 */
export function useTurnCheckpoints({ projectId, sessionId }: UseTurnCheckpointsOptions): TurnCheckpointsController {
  const query = overlayQuery(projectId, sessionId);
  const queryText = query?.toString() ?? null;
  const [status, setStatus] = useState<TurnListStatus>(queryText ? 'loading' : 'notFound');
  const [turns, setTurns] = useState<TurnCheckpointSummary[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [fileDiffs, setFileDiffs] = useState<Record<string, TurnFileDiffState>>({});
  const [reloadToken, setReloadToken] = useState(0);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    requested.current = new Set();
    setFileDiffs({});
    setTurns([]);
    setNextBefore(null);
    if (!queryText) {
      setStatus('notFound');
      return undefined;
    }
    let cancelled = false;
    setStatus('loading');
    getJson<TurnCheckpointListResponse>(`/api/git/turn-checkpoints?${queryText}`)
      .then(({ status: code, body }) => {
        if (cancelled) return;
        if (code === 404) { setStatus('notFound'); return; }
        if (!body) { setStatus('error'); return; }
        setTurns(body.turns ?? []);
        setNextBefore(body.nextBefore ?? null);
        setStatus('ready');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [queryText, reloadToken]);

  const retry = useCallback(() => setReloadToken((value) => value + 1), []);

  const loadOlder = useCallback(async () => {
    if (!queryText || nextBefore == null || isLoadingOlder) return;
    const params = new URLSearchParams(queryText);
    params.set('before', String(nextBefore));
    setIsLoadingOlder(true);
    try {
      const { body } = await getJson<TurnCheckpointListResponse>(`/api/git/turn-checkpoints?${params.toString()}`);
      if (!body) return;
      setTurns((previous) => {
        const seen = new Set(previous.map((turn) => turn.turnSeq));
        return [...previous, ...(body.turns ?? []).filter((turn) => !seen.has(turn.turnSeq))];
      });
      setNextBefore(body.nextBefore ?? null);
    } catch {
      // The button stays; the next click retries the same cursor.
    } finally {
      setIsLoadingOlder(false);
    }
  }, [isLoadingOlder, nextBefore, queryText]);

  const loadFileDiff = useCallback(async (turnSeq: number, path: string) => {
    const key = turnFileKey(turnSeq, path);
    if (!queryText || requested.current.has(key)) return;
    requested.current.add(key);
    const params = new URLSearchParams(queryText);
    params.set('turnSeq', String(turnSeq));
    params.set('path', path);
    setFileDiffs((previous) => ({ ...previous, [key]: { status: 'loading' } }));
    let next: TurnFileDiffState = { status: 'unavailable' };
    try {
      const { body } = await getJson<TurnFileDiffResponse>(`/api/git/turn-checkpoints/diff?${params.toString()}`);
      if (body) next = diffStateOf(body);
    } catch {
      next = { status: 'unavailable' };
    }
    if (next.status === 'unavailable') requested.current.delete(key);
    setFileDiffs((previous) => ({ ...previous, [key]: next }));
  }, [queryText]);

  return {
    status, turns, hasOlder: nextBefore != null, isLoadingOlder, fileDiffs, retry, loadOlder, loadFileDiff,
  };
}
