/**
 * B-1668 items 1, 5 and 6 through the hook: broadcasts after "load more",
 * the debounced window refresh, and the selected project after a page merge.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSocketMessage, Project, ProjectSession } from '../types/app';

const { projectsApi, projectSessionsApi, sessionContextApi } = vi.hoisted(() => ({
  projectsApi: vi.fn(),
  projectSessionsApi: vi.fn(),
  sessionContextApi: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  api: {
    projects: (...args: unknown[]) => projectsApi(...args),
    projectSessions: (...args: unknown[]) => projectSessionsApi(...args),
    sessionContext: (...args: unknown[]) => sessionContextApi(...args),
  },
}));

import { useProjectsState } from './useProjectsState';
import { SESSION_WINDOW_REFRESH_DELAY_MS } from './sessionWindowRefresher';

const row = (id: string, minute: number, extra: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  summary: id,
  lastActivity: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
  ...extra,
});

const pageOne = Array.from({ length: 20 }, (_, index) => row(`r${40 - index}`, 40 - index));
const pageTwo = Array.from({ length: 20 }, (_, index) => row(`r${20 - index}`, 20 - index));

const project = (sessions: ProjectSession[], hasMore = true): Project => ({
  projectId: 'p1',
  displayName: 'p1',
  fullPath: '/w/p1',
  sessions,
  sessionMeta: { total: 40, hasMore },
} as Project);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'X-Nassaj-Snapshot-State': 'ready' } });

const broadcast = (sessions: ProjectSession[]): AppSocketMessage => ({
  type: 'projects_updated',
  projects: [project(sessions)],
});

const sessionIds = (projects: Project[]): string[] =>
  ((projects[0]?.sessions as ProjectSession[] | undefined) ?? []).map((session) => session.id);

type Props = { latestMessage: AppSocketMessage | null; sessionId?: string };

const renderState = () => renderHook(
  ({ latestMessage, sessionId }: Props) => useProjectsState({
    sessionId,
    navigate: vi.fn(),
    latestMessage,
    isMobile: false,
    activeSessions: new Set<string>(),
  }),
  { initialProps: { latestMessage: null, sessionId: undefined } as Props },
);

/** Renders, waits for page one, then loads page two. */
const renderWithTwoPages = async () => {
  const rendered = renderState();
  await waitFor(() => expect(sessionIds(rendered.result.current.projects)).toHaveLength(20));
  projectSessionsApi.mockResolvedValueOnce(json({ projectId: 'p1', sessions: pageTwo, sessionMeta: { total: 40, hasMore: false } }));
  await act(async () => {
    await rendered.result.current.loadMoreProjectSessions('p1');
  });
  return rendered;
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  projectsApi.mockReset();
  projectSessionsApi.mockReset();
  sessionContextApi.mockReset();
  projectsApi.mockImplementation(async () => json([project(pageOne)]));
  sessionContextApi.mockResolvedValue(new Response(null, { status: 404 }));
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('load more, then broadcasts', () => {
  it('asks for the next page at the server-paged offset and keeps the selected project in step', async () => {
    const { result, rerender } = renderState();
    await waitFor(() => expect(sessionIds(result.current.projects)).toHaveLength(20));
    rerender({ latestMessage: null, sessionId: 'r40' });
    await waitFor(() => expect(result.current.selectedProject?.projectId).toBe('p1'));

    projectSessionsApi.mockResolvedValueOnce(json({ projectId: 'p1', sessions: pageTwo, sessionMeta: { hasMore: false } }));
    await act(async () => {
      await result.current.loadMoreProjectSessions('p1');
    });

    expect(projectSessionsApi).toHaveBeenCalledWith('p1', { limit: 20, offset: 20 });
    expect(sessionIds([result.current.selectedProject as Project])).toContain('r1');
    expect(result.current.projects[0].sessionMeta?.hasMore).toBe(false);
  });

  it('drops a deleted page-one row instead of keeping it alive from the old page', async () => {
    const { result, rerender } = await renderWithTwoPages();
    rerender({ latestMessage: null, sessionId: 'r35' });
    await waitFor(() => expect(result.current.selectedSession?.id).toBe('r35'));

    const fresh = [...pageOne.filter((session) => session.id !== 'r35'), row('r20', 20)];
    rerender({ latestMessage: broadcast(fresh), sessionId: 'r35' });

    await waitFor(() => expect(sessionIds(result.current.projects)).not.toContain('r35'));
    expect(sessionIds(result.current.projects)).toContain('r1');
    // B-290 fired: the listed record left the selection (only the URL's bare
    // placeholder may remain, exactly as for any id the list does not carry).
    await waitFor(() => expect(result.current.selectedSession?.summary).not.toBe('r35'));
  });

  it('refreshes the deeper rows once per burst and applies renames and closes', async () => {
    const { result, rerender } = await renderWithTwoPages();
    projectSessionsApi.mockReset();
    const refreshed = [...pageOne, ...pageTwo].map((session) =>
      (session.id === 'r10' ? { ...session, summary: 'renamed', closed: true } : session));
    projectSessionsApi.mockResolvedValue(json({ projectId: 'p1', sessions: refreshed, sessionMeta: { hasMore: false } }));

    for (let burst = 0; burst < 3; burst += 1) {
      rerender({ latestMessage: broadcast([...pageOne]), sessionId: undefined });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_WINDOW_REFRESH_DELAY_MS + 10);
    });

    await waitFor(() => expect(projectSessionsApi).toHaveBeenCalledTimes(1));
    expect(projectSessionsApi).toHaveBeenCalledWith('p1', { limit: 40, offset: 0 });
    await waitFor(() => {
      const r10 = (result.current.projects[0].sessions as ProjectSession[]).find((s) => s.id === 'r10');
      expect(r10?.summary).toBe('renamed');
      expect(r10?.closed).toBe(true);
    });
  });

  it('drops a refresh answer that a newer broadcast overtook', async () => {
    const { result, rerender } = await renderWithTwoPages();
    projectSessionsApi.mockReset();
    let release: (response: Response) => void = () => {};
    projectSessionsApi.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    projectSessionsApi.mockResolvedValue(json({ projectId: 'p1', sessions: [...pageOne, ...pageTwo], sessionMeta: { hasMore: false } }));

    rerender({ latestMessage: broadcast([...pageOne]), sessionId: undefined });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_WINDOW_REFRESH_DELAY_MS + 10);
    });
    expect(projectSessionsApi).toHaveBeenCalledTimes(1);

    // A newer broadcast lands while the refresh is in flight.
    rerender({ latestMessage: broadcast([...pageOne]), sessionId: undefined });
    const stale = [...pageOne, ...pageTwo].map((s) => (s.id === 'r10' ? { ...s, summary: 'stale' } : s));
    await act(async () => {
      release(json({ projectId: 'p1', sessions: stale, sessionMeta: { hasMore: false } }));
      await Promise.resolve();
    });

    const r10 = (result.current.projects[0].sessions as ProjectSession[]).find((s) => s.id === 'r10');
    expect(r10?.summary).toBe('r10');
  });

  it('schedules no refresh when nothing beyond page one is loaded, and none after unmount', async () => {
    const { result, rerender, unmount } = renderState();
    await waitFor(() => expect(sessionIds(result.current.projects)).toHaveLength(20));

    rerender({ latestMessage: broadcast([...pageOne]), sessionId: undefined });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_WINDOW_REFRESH_DELAY_MS * 2);
    });
    expect(projectSessionsApi).not.toHaveBeenCalled();
    unmount();
  });

  it('cancels a pending refresh on unmount', async () => {
    const { rerender, unmount } = await renderWithTwoPages();
    projectSessionsApi.mockReset();
    rerender({ latestMessage: broadcast([...pageOne]), sessionId: undefined });
    unmount();
    await vi.advanceTimersByTimeAsync(SESSION_WINDOW_REFRESH_DELAY_MS * 2);
    expect(projectSessionsApi).not.toHaveBeenCalled();
  });
});
