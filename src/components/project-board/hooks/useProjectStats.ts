import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import {
  normalizeCodebaseStats,
  normalizeProjectCost,
  normalizeProjectStats,
  type CodebaseStats,
  type ProjectCost,
  type ProjectStats,
} from '../projectStatsHelpers';

/**
 * Cost + statistics for the selected project (ADR-078).
 *
 * Two independent endpoints, deliberately not fetched as one: the header total
 * (`/cost`) must still appear when the richer `/stats` scan is unavailable, and
 * vice-versa. Both are scans over provider transcripts, so this hook fetches
 * once per project and exposes `refresh` instead of following the board's
 * WebSocket refresh — a re-scan on every file save would be pure waste.
 *
 * A missing endpoint (older server) resolves to `null`, never to an empty
 * object: the views render nothing at all rather than an authoritative-looking
 * $0.00.
 */
export type UseProjectStats = {
  cost: ProjectCost | null;
  stats: ProjectStats | null;
  /** The working tree's own measurements (T-1169); null on an older server. */
  codeStats: CodebaseStats | null;
  /** True only until the FIRST answer for the current project arrives. */
  isLoading: boolean;
  /** Set only when every statistics endpoint failed for the current project. */
  loadError: string | null;
  refresh: () => void;
};

const ENDPOINT_UNAVAILABLE = Symbol('project-stats-endpoint-unavailable');

async function fetchJson(url: string): Promise<unknown> {
  const response = await authenticatedFetch(url);
  if (response.status === 404) {
    // An older server has no statistics endpoints. This is an empty capability,
    // not a network failure, so the tab may explain that no data is available.
    return ENDPOINT_UNAVAILABLE;
  }
  if (!response.ok) throw new Error(`Statistics request failed (${response.status})`);
  return (await response.json()) as unknown;
}

export function useProjectStats(projectId: string | null | undefined): UseProjectStats {
  const [stateProjectId, setStateProjectId] = useState(projectId);
  const [cost, setCost] = useState<ProjectCost | null>(null);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [codeStats, setCodeStats] = useState<CodebaseStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Guards against a slow answer for a project the user already left.
  const projectIdRef = useRef(projectId);
  // Project identity alone is insufficient: a manual rescan may overtake the
  // initial request for the SAME project. Only the newest generation may own
  // the state, regardless of which network response happens to finish last.
  const loadGenerationRef = useRef(0);
  projectIdRef.current = projectId;

  const load = useCallback(async (targetProjectId: string, force = false) => {
    const generation = ++loadGenerationRef.current;
    const encoded = encodeURIComponent(targetProjectId);
    // `force` only reaches the codebase walk: it is the one answer served from a
    // memo, and re-pricing the ledger on a refresh click would be minutes of I/O.
    const [costResult, statsResult, codeResult] = await Promise.allSettled([
      fetchJson(`/api/projects/${encoded}/cost`),
      fetchJson(`/api/projects/${encoded}/stats`),
      fetchJson(`/api/projects/${encoded}/code-stats${force ? '?force=1' : ''}`),
    ]);
    if (
      projectIdRef.current !== targetProjectId ||
      loadGenerationRef.current !== generation
    ) {
      return;
    }

    const costValue =
      costResult.status === 'fulfilled' && costResult.value !== ENDPOINT_UNAVAILABLE
        ? normalizeProjectCost(costResult.value)
        : null;
    const statsValue =
      statsResult.status === 'fulfilled' && statsResult.value !== ENDPOINT_UNAVAILABLE
        ? normalizeProjectStats(statsResult.value)
        : null;
    const codeValue =
      codeResult.status === 'fulfilled' && codeResult.value !== ENDPOINT_UNAVAILABLE
        ? normalizeCodebaseStats(codeResult.value)
        : null;
    const results = [costResult, statsResult, codeResult];
    const hasPayload = Boolean(costValue || statsValue || codeValue);
    const anyFailed = results.some((result) => result.status === 'rejected');
    const allUnavailable = results.every(
      (result) => result.status === 'fulfilled' && result.value === ENDPOINT_UNAVAILABLE,
    );

    setCost(costValue);
    setStats(previous => statsResult.status === 'rejected' && previous ? { ...previous, skillsStale: true } : statsValue);
    setCodeStats(codeValue);
    setLoadError(
      !hasPayload && anyFailed
        ? 'statistics-load-failed'
        : allUnavailable
          ? 'statistics-unavailable'
          : null,
    );
    setIsLoading(false);
  }, []);

  useEffect(() => {
    setStateProjectId(projectId);
    setCost(null);
    setStats(null);
    setCodeStats(null);
    setLoadError(null);
    if (!projectId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void load(projectId);
    return () => {
      // Invalidate the in-flight generation before a project change/unmount.
      loadGenerationRef.current += 1;
    };
  }, [projectId, load]);

  const refresh = useCallback(() => {
    if (projectIdRef.current) {
      void load(projectIdRef.current, true);
    }
  }, [load]);

  return stateProjectId === projectId ? { cost, stats, codeStats, isLoading, loadError, refresh } : { cost: null, stats: null, codeStats: null, isLoading: Boolean(projectId), loadError: null, refresh };
}
