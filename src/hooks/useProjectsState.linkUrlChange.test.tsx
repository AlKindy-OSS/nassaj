/**
 * R2/M1 — `projectsHaveChanges` must notice a link-only change. Otherwise a
 * `projects_updated` broadcast after another user (or another tab) edits the
 * project link is discarded as a no-op and the stale link keeps showing.
 */
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSocketMessage, Project } from '../types/app';

const { projectsApi } = vi.hoisted(() => ({ projectsApi: vi.fn() }));
vi.mock('../utils/api', () => ({
  api: { projects: (...args: unknown[]) => projectsApi(...args) },
}));

import { useProjectsState } from './useProjectsState';

const baseProject = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'project-1',
  displayName: 'Nassaj',
  fullPath: '/workspace/nassaj',
  sessions: [],
  ...overrides,
} as Project);

const restResponse = (project: Project): Response =>
  new Response(JSON.stringify([project]), {
    status: 200,
    headers: { 'X-Nassaj-Snapshot-State': 'ready' },
  });

const broadcast = (project: Project): AppSocketMessage => ({
  type: 'projects_updated',
  projects: [project],
});

const renderWithMessage = () =>
  renderHook(
    ({ latestMessage }: { latestMessage: AppSocketMessage | null }) =>
      useProjectsState({
        navigate: vi.fn(),
        latestMessage,
        isMobile: false,
        activeSessions: new Set<string>(),
      }),
    { initialProps: { latestMessage: null as AppSocketMessage | null } },
  );

beforeEach(() => {
  projectsApi.mockReset();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => cleanup());

describe('a link-only projects_updated broadcast', () => {
  it('applies a changed linkUrl even when nothing else differs', async () => {
    projectsApi.mockResolvedValue(restResponse(baseProject({ linkUrl: null })));

    const { result, rerender } = renderWithMessage();
    await waitFor(() => expect(result.current.projects[0]?.linkUrl ?? null).toBe(null));

    rerender({
      latestMessage: broadcast(baseProject({ linkUrl: 'https://example.com/' })),
    });

    await waitFor(() =>
      expect(result.current.projects[0]?.linkUrl).toBe('https://example.com/'),
    );
  });

  it('applies a changed logoUrl even when nothing else differs', async () => {
    projectsApi.mockResolvedValue(restResponse(baseProject({ logoUrl: null })));

    const { result, rerender } = renderWithMessage();
    await waitFor(() => expect(result.current.projects[0]?.logoUrl ?? null).toBe(null));

    rerender({
      latestMessage: broadcast(baseProject({ logoUrl: 'https://example.com/logo.png' })),
    });

    await waitFor(() =>
      expect(result.current.projects[0]?.logoUrl).toBe('https://example.com/logo.png'),
    );
  });
});
