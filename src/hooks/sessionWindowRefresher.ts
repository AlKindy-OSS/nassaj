/**
 * Debounced re-read of the session rows a project loaded beyond page one
 * (B-1668).
 *
 * A `projects_updated` broadcast carries page one only. Rows the user paged in
 * with "load more" can be renamed, closed or deleted with no payload saying
 * so; after a burst of broadcasts this re-reads all loaded unstarred rows of
 * the project in one request and replaces them wholesale.
 *
 * Race guard: every server merge into a project bumps that project's
 * generation. A response whose generation moved on while it was in flight is
 * dropped — it may predate a newer broadcast or a "load more" page. A refresh
 * never starts while a "load more" for the same project is in flight.
 */
import type { Project } from '../types/app';

import {
  applyWindowRefresh,
  computeWindowRefreshRequest,
  type ProjectSessionsPage,
} from './projectSessionPaging';

export const SESSION_WINDOW_REFRESH_DELAY_MS = 1_500;

export type SessionWindowRefresherDeps = {
  getProjects: () => Project[];
  fetchPage: (projectId: string, request: { limit: number; offset: number }) => Promise<Response>;
  /** Called with the list before and after the refresh; must apply `next`. */
  applyRefresh: (projectId: string, page: ProjectSessionsPage, previous: Project[], next: Project[]) => void;
  delayMs?: number;
};

export type SessionWindowRefresher = {
  schedule: (projectIds: Iterable<string>) => void;
  bumpGeneration: (projectIds: Iterable<string>) => void;
  setLoadingMore: (projectId: string, loading: boolean) => void;
  dispose: () => void;
};

/** Creates one refresher; the hook owns exactly one per mounted state. */
export function createSessionWindowRefresher(deps: SessionWindowRefresherDeps): SessionWindowRefresher {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const generations = new Map<string, number>();
  const loadingMore = new Set<string>();
  const delayMs = deps.delayMs ?? SESSION_WINDOW_REFRESH_DELAY_MS;
  let disposed = false;

  const generationOf = (projectId: string): number => generations.get(projectId) ?? 0;

  const bumpGeneration = (projectIds: Iterable<string>): void => {
    for (const projectId of projectIds) generations.set(projectId, generationOf(projectId) + 1);
  };

  const run = async (projectId: string): Promise<void> => {
    timers.delete(projectId);
    if (disposed) return;
    if (loadingMore.has(projectId)) {
      schedule([projectId]);
      return;
    }
    const project = deps.getProjects().find((candidate) => candidate.projectId === projectId);
    const request = project ? computeWindowRefreshRequest(project) : null;
    if (!request) return;

    const generation = generationOf(projectId);
    try {
      const response = await deps.fetchPage(projectId, request);
      if (!response.ok) return;
      const page = (await response.json()) as ProjectSessionsPage;
      if (disposed || generationOf(projectId) !== generation) return;
      const previous = deps.getProjects();
      const next = previous.map((candidate) =>
        candidate.projectId === projectId ? applyWindowRefresh(candidate, page) : candidate);
      bumpGeneration([projectId]);
      deps.applyRefresh(projectId, page, previous, next);
    } catch (error) {
      // Best effort: the next broadcast schedules another attempt.
      console.warn('[Sidebar] Session window refresh failed:', error);
    }
  };

  function schedule(projectIds: Iterable<string>): void {
    if (disposed) return;
    for (const projectId of projectIds) {
      const pending = timers.get(projectId);
      if (pending) clearTimeout(pending);
      timers.set(projectId, setTimeout(() => void run(projectId), delayMs));
    }
  }

  return {
    schedule,
    bumpGeneration,
    setLoadingMore: (projectId, loading) => {
      if (loading) loadingMore.add(projectId);
      else loadingMore.delete(projectId);
    },
    dispose: () => {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
