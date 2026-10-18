/**
 * B-1668 item 4: switching conversations pushes exactly one history entry, so
 * the browser's Back returns to the previous conversation instead of an empty
 * home screen.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../types/app';
import { consumeSessionReveal } from '../components/sidebar/utils/sessionReveal';

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

type HookState = ReturnType<typeof useProjectsState>;

const session = (id: string, projectId: string): ProjectSession => ({
  id,
  summary: id,
  lastActivity: '2026-10-01T00:00:00Z',
  __projectId: projectId,
});

const projects: Project[] = [
  { projectId: 'p1', displayName: 'one', fullPath: '/w/one', sessions: [session('A', 'p1'), session('B', 'p1'), session('C', 'p1')] },
  { projectId: 'p2', displayName: 'two', fullPath: '/w/two', sessions: [session('X', 'p2')] },
] as Project[];

const activeSessions = new Set<string>();
const current: { state: HookState | null } = { state: null };

function Harness() {
  const location = useLocation();
  const navigate = useNavigate();
  const sessionId = /^\/session\/([^/]+)/.exec(location.pathname)?.[1];
  current.state = useProjectsState({ sessionId, navigate, latestMessage: null, isMobile: false, activeSessions });
  return null;
}

const renderAt = (path: string) => {
  const router = createMemoryRouter([{ path: '*', element: <Harness /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
};

const select = async (target: ProjectSession, owner?: Project) => {
  await act(async () => {
    current.state?.handleSessionSelect(target, owner);
  });
};

beforeEach(() => {
  projectsApi.mockReset();
  projectsApi.mockImplementation(async () =>
    new Response(JSON.stringify(projects), { status: 200, headers: { 'X-Nassaj-Snapshot-State': 'ready' } }));
  sessionContextApi.mockReset();
  sessionContextApi.mockResolvedValue(new Response(null, { status: 404 }));
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  current.state = null;
});

describe('one history entry per conversation switch', () => {
  it('A -> B -> C, then Back twice, lands on B and then A — never on /', async () => {
    const router = renderAt('/session/A');
    await waitFor(() => expect(current.state?.selectedSession?.id).toBe('A'));

    await select(session('B', 'p1'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/session/B'));
    await select(session('C', 'p1'));
    await waitFor(() => expect(current.state?.selectedSession?.id).toBe('C'));

    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname).toBe('/session/B');
    await waitFor(() => expect(current.state?.selectedSession?.id).toBe('B'));

    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname).toBe('/session/A');
    await waitFor(() => expect(current.state?.selectedSession?.id).toBe('A'));
  });

  it('asks the sidebar to reveal a row the URL selected, never one a click selected (item 10)', async () => {
    const router = renderAt('/session/A');
    await waitFor(() => expect(current.state?.selectedSession?.id).toBe('A'));
    expect(consumeSessionReveal('A')).toBe(true);

    await select(session('B', 'p1'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/session/B'));
    expect(consumeSessionReveal('B')).toBe(false);

    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(current.state?.selectedSession?.id).toBe('A'));
    expect(consumeSessionReveal('A')).toBe(true);
  });

  it('selects the owning project of a cross-project switch without a / entry', async () => {
    const router = renderAt('/session/A');
    await waitFor(() => expect(current.state?.selectedProject?.projectId).toBe('p1'));

    await select(session('X', 'p2'));
    await waitFor(() => expect(current.state?.selectedProject?.projectId).toBe('p2'));
    expect(current.state?.selectedSession?.id).toBe('X');

    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname).toBe('/session/A');
  });

  it('selects an archived owner project handed in by the caller, still with one entry', async () => {
    const archived = { projectId: 'p-archived', displayName: 'old', fullPath: '/w/old', sessions: [] } as unknown as Project;
    const router = renderAt('/session/A');
    await waitFor(() => expect(current.state?.selectedSession?.id).toBe('A'));

    await select(session('Z', 'p-archived'), archived);
    await waitFor(() => expect(router.state.location.pathname).toBe('/session/Z'));
    expect(current.state?.selectedProject?.projectId).toBe('p-archived');

    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname).toBe('/session/A');
  });
});
