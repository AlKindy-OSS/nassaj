/**
 * A close action and a sidebar refresh run independently.  A refresh that was
 * already in flight can contain the old `closed: false` row, so it must not
 * erase the optimistic state rendered by the main header.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../types/app';

const { projectsApi } = vi.hoisted(() => ({ projectsApi: vi.fn() }));
vi.mock('../utils/api', () => ({
  api: { projects: (...args: unknown[]) => projectsApi(...args) },
}));

import { useProjectsState } from './useProjectsState';

const project = (closed: boolean): Project => ({
  projectId: 'project-1',
  displayName: 'Nassaj',
  fullPath: '/workspace/nassaj',
  sessions: [{ id: 'session-1', summary: 'Conversation', closed }],
} as Project);

const response = (closed: boolean): Response => new Response(JSON.stringify([project(closed)]), {
  status: 200,
  headers: { 'X-Nassaj-Snapshot-State': 'ready' },
});

beforeEach(() => {
  projectsApi.mockReset();
  localStorage.clear();
  window.history.replaceState(null, '', '/session/session-1');
});

afterEach(() => cleanup());

describe('optimistic closed selection', () => {
  it('keeps the header closed while a stale sidebar response still says open', async () => {
    projectsApi
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(true));

    const { result } = renderHook(() => useProjectsState({
      sessionId: 'session-1',
      navigate: vi.fn(),
      latestMessage: null,
      isMobile: false,
      activeSessions: new Set(),
    }));

    await waitFor(() => expect(result.current.selectedSession?.closed).toBe(false));

    act(() => result.current.handleSelectedSessionClosedChange('session-1', true));
    expect(result.current.selectedSession?.closed).toBe(true);

    await act(async () => {
      await result.current.handleSidebarRefresh();
    });
    expect(result.current.selectedSession?.closed).toBe(true);

    await act(async () => {
      await result.current.handleSidebarRefresh();
    });
    expect(result.current.selectedSession?.closed).toBe(true);
  });
});
