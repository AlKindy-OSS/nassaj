/**
 * Regression contract for leaving an existing conversation through New Session.
 * The route prop can remain stale for one render after navigate('/'); that stale
 * id must not reselect the conversation that the user explicitly left.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../types/app';

const { projectsApi, sessionContextApi } = vi.hoisted(() => ({
  projectsApi: vi.fn(),
  sessionContextApi: vi.fn(),
}));
vi.mock('../utils/api', () => ({
  api: {
    projects: (...args: unknown[]) => projectsApi(...args),
    sessionContext: (...args: unknown[]) => sessionContextApi(...args),
  },
}));

import { useProjectsState } from './useProjectsState';

const project: Project = {
  projectId: 'project-1',
  displayName: 'Nassaj',
  fullPath: '/workspace/nassaj',
  sessions: [
    { id: 'session-old', title: 'Old conversation' },
    { id: 'session-other', title: 'Other conversation' },
  ],
} as Project;

const response = (projects: Project[] = [project]): Response =>
  new Response(JSON.stringify(projects), {
    status: 200,
    headers: { 'X-Nassaj-Snapshot-State': 'ready' },
  });

beforeEach(() => {
  projectsApi.mockReset();
  projectsApi.mockResolvedValue(response());
  sessionContextApi.mockReset();
  localStorage.clear();
  window.history.replaceState(null, '', '/session/session-old');
});

afterEach(() => cleanup());

describe('New Session navigation', () => {
  it('does not let the stale route id reselect the conversation after the first click', async () => {
    const navigate = vi.fn();
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId?: string }) =>
        useProjectsState({
          sessionId,
          navigate,
          latestMessage: null,
          isMobile: false,
          activeSessions: new Set(),
        }),
      { initialProps: { sessionId: 'session-old' as string | undefined } },
    );

    await waitFor(() => expect(result.current.selectedSession?.id).toBe('session-old'));

    act(() => result.current.handleNewSession(project));

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/');
    expect(result.current.selectedSession).toBeNull();
    expect(result.current.newSessionTrigger).toBe(1);

    // React Router commits the new route after the click-state render.
    rerender({ sessionId: undefined });
    expect(result.current.selectedSession).toBeNull();
  });

  it('releases the guard after a different route commits, allowing a later return', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId?: string }) =>
        useProjectsState({
          sessionId,
          navigate: vi.fn(),
          latestMessage: null,
          isMobile: false,
          activeSessions: new Set(),
        }),
      { initialProps: { sessionId: 'session-old' as string | undefined } },
    );

    await waitFor(() => expect(result.current.selectedSession?.id).toBe('session-old'));
    act(() => result.current.handleNewSession(project));
    expect(result.current.selectedSession).toBeNull();

    rerender({ sessionId: 'session-other' });
    await waitFor(() => expect(result.current.selectedSession?.id).toBe('session-other'));

    rerender({ sessionId: 'session-old' });
    await waitFor(() => expect(result.current.selectedSession?.id).toBe('session-old'));
  });

  it('starts a new conversation exactly once when already on the root route', async () => {
    const navigate = vi.fn();
    const { result } = renderHook(() =>
      useProjectsState({
        sessionId: undefined,
        navigate,
        latestMessage: null,
        isMobile: false,
        activeSessions: new Set(),
      }),
    );

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    act(() => result.current.handleNewSession(project));

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/');
    expect(result.current.newSessionTrigger).toBe(1);
    expect(result.current.selectedSession).toBeNull();
  });

  it('ignores a late deep-link resolution for the conversation being left', async () => {
    const projectWithoutListedSession = {
      ...project,
      sessions: project.sessions?.filter((session) => session.id === 'session-other'),
    } as Project;
    projectsApi.mockResolvedValue(response([projectWithoutListedSession]));

    let resolveContext!: (response: Response) => void;
    sessionContextApi.mockReturnValue(new Promise<Response>((resolve) => {
      resolveContext = resolve;
    }));

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId?: string }) =>
        useProjectsState({
          sessionId,
          navigate: vi.fn(),
          latestMessage: null,
          isMobile: false,
          activeSessions: new Set(),
        }),
      { initialProps: { sessionId: 'session-old' as string | undefined } },
    );

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    act(() => result.current.handleProjectSelect(projectWithoutListedSession));
    // Explicit project selection leaves the stale route before opening a draft.
    expect(result.current.selectedSession).toBeNull();
    act(() => result.current.handleNewSession(projectWithoutListedSession));
    expect(result.current.selectedSession).toBeNull();

    rerender({ sessionId: 'session-other' });
    await waitFor(() => expect(result.current.selectedSession?.id).toBe('session-other'));

    await act(async () => {
      resolveContext(new Response(JSON.stringify({
        projectId: project.projectId,
        provider: 'claude',
        session: project.sessions?.[0],
      }), { status: 200 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.selectedSession?.id).toBe('session-other');
  });
});


describe('Project tool navigation', () => {
  it.each(['files', 'git', 'board'] as const)('returns from %s to the retained session or another conversation', async (tool) => {
    const navigate = vi.fn();
    const { result } = renderHook(() => useProjectsState({
      sessionId: 'session-old', navigate, latestMessage: null, isMobile: true, activeSessions: new Set(),
    }));
    await waitFor(() => expect(result.current.selectedSession?.id).toBe('session-old'));
    const retained = result.current.selectedSession!;
    act(() => result.current.setActiveTab(tool));
    expect(result.current.selectedSession).toBe(retained);
    expect(result.current.newSessionTrigger).toBe(0);
    act(() => result.current.setActiveTab('chat'));
    expect(result.current.selectedSession).toBe(retained);
    act(() => {
      result.current.setActiveTab(tool);
      result.current.setSidebarOpen(true);
    });
    act(() => {
      result.current.sidebarSharedProps.onProjectSelect(project);
      result.current.handleSessionSelect({ ...retained, __projectId: project.projectId });
    });
    expect(result.current.activeTab).toBe('chat');
    expect(result.current.selectedSession?.id).toBe('session-old');
    expect(result.current.sidebarOpen).toBe(false);
    expect(navigate).toHaveBeenLastCalledWith('/session/session-old');
    act(() => result.current.setActiveTab(tool));
    act(() => {
      result.current.sidebarSharedProps.onProjectSelect(project);
      result.current.handleSessionSelect(project.sessions![1]);
    });
    expect(result.current.activeTab).toBe('chat');
    expect(result.current.selectedSession?.id).toBe('session-other');
    expect(navigate).toHaveBeenLastCalledWith('/session/session-other');
    expect(result.current.newSessionTrigger).toBe(0);
  });

  it('keeps project B selected while the route still carries a session from A', async () => {
    const otherProject = { ...project, projectId: 'project-2', displayName: 'Other', sessions: [] };
    projectsApi.mockResolvedValue(response([project, otherProject]));
    const navigate = vi.fn();
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId?: string }) => useProjectsState({
        sessionId, navigate, latestMessage: null, isMobile: false, activeSessions: new Set(),
      }), { initialProps: { sessionId: 'session-old' as string | undefined } },
    );
    await waitFor(() => expect(result.current.selectedSession?.id).toBe('session-old'));
    const newSessionTrigger = result.current.newSessionTrigger;
    act(() => {
      result.current.sidebarSharedProps.onProjectSelect(otherProject);
      result.current.setActiveTab('files');
    });
    expect(result.current.selectedProject?.projectId).toBe('project-2');
    expect(result.current.selectedSession).toBeNull();
    expect(result.current.activeTab).toBe('files');
    expect(result.current.newSessionTrigger).toBe(newSessionTrigger);
    rerender({ sessionId: undefined });
    expect(result.current.selectedProject?.projectId).toBe('project-2');
    expect(result.current.selectedSession).toBeNull();
  });
});
