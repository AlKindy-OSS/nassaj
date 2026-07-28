import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import {
  normalizeProjectCost,
  normalizeProjectStats,
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
  /** True only until the FIRST answer for the current project arrives. */
  isLoading: boolean;
  refresh: () => void;
};

async function fetchJson(url: string): Promise<unknown> {
  const response = await authenticatedFetch(url);
  if (!response.ok) {
    // 404 on an older server is indistinguishable from "no data" on purpose:
    // both mean "we have nothing to show", and neither may become a number.
    return null;
  }
  return (await response.json()) as unknown;
}

export function useProjectStats(projectId: string | null | undefined): UseProjectStats {
  const [cost, setCost] = useState<ProjectCost | null>(null);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Guards against a slow answer for a project the user already left.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const load = useCallback(async (targetProjectId: string) => {
    const encoded = encodeURIComponent(targetProjectId);
    const [costResult, statsResult] = await Promise.allSettled([
      fetchJson(`/api/projects/${encoded}/cost`),
      fetchJson(`/api/projects/${encoded}/stats`),
    ]);
    if (projectIdRef.current !== targetProjectId) return;

    setCost(costResult.status === 'fulfilled' ? normalizeProjectCost(costResult.value) : null);
    setStats(statsResult.status === 'fulfilled' ? normalizeProjectStats(statsResult.value) : null);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    setCost(null);
    setStats(null);
    if (!projectId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void load(projectId);
  }, [projectId, load]);

  const refresh = useCallback(() => {
    if (projectIdRef.current) {
      void load(projectIdRef.current);
    }
  }, [load]);

  return { cost, stats, isLoading, refresh };
}
