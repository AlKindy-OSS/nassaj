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

const project = {
  projectId: 'project-1',
  displayName: 'Nassaj',
  fullPath: '/workspace/nassaj',
  sessions: [],
} as unknown as Project;

const projectsResponse = () => new Response(JSON.stringify([project]), {
  status: 200,
  headers: { 'X-Nassaj-Snapshot-State': 'ready' },
});

const contextResponse = (sessionId: string) => new Response(JSON.stringify({
  projectId: project.projectId,
  provider: 'codex',
  session: { id: sessionId, title: sessionId },
}), { status: 200 });

const renderDeepLink = (sessionId = 'session-target') => renderHook(
  ({ routeSessionId }: { routeSessionId?: string }) => useProjectsState({
    sessionId: routeSessionId,
    navigate: vi.fn(),
    latestMessage: null,
    isMobile: false,
    activeSessions: new Set(),
  }),
  { initialProps: { routeSessionId: sessionId as string | undefined } },
);

beforeEach(() => {
  projectsApi.mockReset();
  projectsApi.mockImplementation(async () => projectsResponse());
  sessionContextApi.mockReset();
  localStorage.clear();
});

afterEach(() => cleanup());

describe('session deep-link resolution', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ] as const)('distinguishes authenticated HTTP %i', async (status, expectedStatus) => {
    sessionContextApi.mockResolvedValue(new Response(null, { status }));
    const { result } = renderDeepLink();

    await waitFor(() => expect(result.current.deepLinkResolution.status).toBe(expectedStatus));
    expect(result.current.selectedSession).toBeNull();
  });

  it('reports a true 404 as not found without making it a transient failure', async () => {
    sessionContextApi.mockResolvedValue(new Response(null, { status: 404 }));
    const { result } = renderDeepLink();

    await waitFor(() => expect(result.current.deepLinkResolution.status).toBe('not_found'));
    expect(sessionContextApi).toHaveBeenCalledTimes(1);
  });

  it('keeps a 5xx retryable and resolves it after an explicit retry', async () => {
    sessionContextApi
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(contextResponse('session-target'));
    const { result } = renderDeepLink();

    await waitFor(() => expect(result.current.deepLinkResolution.status).toBe('error'));
    act(() => result.current.retryDeepLinkResolution());

    await waitFor(() => expect(result.current.selectedSession?.id).toBe('session-target'));
    expect(result.current.deepLinkResolution.status).toBe('idle');
    expect(sessionContextApi).toHaveBeenCalledTimes(2);
  });

  it('keeps a network failure retryable', async () => {
    sessionContextApi.mockRejectedValue(new TypeError('network unavailable'));
    const { result } = renderDeepLink();

    await waitFor(() => expect(result.current.deepLinkResolution).toEqual({
      status: 'error',
      sessionId: 'session-target',
      retryable: true,
    }));
  });

  it('aborts the old request and ignores its stale late response after route change', async () => {
    let resolveOld!: (response: Response) => void;
    let oldSignal: AbortSignal | undefined;
    sessionContextApi.mockImplementationOnce((_sessionId: string, options?: RequestInit) => {
      oldSignal = options?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveOld = resolve; });
    });
    sessionContextApi.mockResolvedValueOnce(contextResponse('session-new'));

    const { result, rerender } = renderDeepLink('session-old');
    await waitFor(() => expect(sessionContextApi).toHaveBeenCalledTimes(1));

    rerender({ routeSessionId: 'session-new' });
    await waitFor(() => expect(oldSignal?.aborted).toBe(true));
    await waitFor(() => expect(result.current.selectedSession?.id).toBe('session-new'));

    await act(async () => {
      resolveOld(contextResponse('session-old'));
      await Promise.resolve();
    });

    expect(result.current.selectedSession?.id).toBe('session-new');
  });
});
