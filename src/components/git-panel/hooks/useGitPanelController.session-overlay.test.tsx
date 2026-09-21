import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

import { rememberSessionWorkspaceGeneration } from '../../../utils/sessionWorkspaceBinding';

import { useGitPanelController } from './useGitPanelController';

const project = { projectId: 'project-1' } as any;

function responseFor(url: string) {
  if (url.includes('/status?')) return { branch: 'main', modified: [] };
  if (url.includes('/remote-status?')) return { hasRemote: false };
  if (url.includes('/branches?')) return { branches: [] };
  if (url.includes('/commits?')) return { commits: [] };
  return { success: true, commit: 'abc123' };
}

describe('Git panel isolated-session commits', () => {
  beforeEach(() => {
    sessionStorage.clear();
    authenticatedFetch.mockReset();
    authenticatedFetch.mockImplementation(async (url: string) => new Response(
      JSON.stringify(responseFor(url)),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
  });

  afterEach(cleanup);

  it('reads the project root when no session is requested, even if a binding exists in storage', async () => {
    rememberSessionWorkspaceGeneration('session-1', 'generation-1');
    renderHook(() => useGitPanelController({ selectedProject: project, activeView: 'changes' }));
    await waitFor(() => {
      expect(authenticatedFetch.mock.calls.some(([url]) => url.startsWith('/api/git/status?'))).toBe(true);
    });
    for (const [url] of authenticatedFetch.mock.calls) {
      const params = new URL(url, 'https://nassaj.test').searchParams;
      expect(params.get('project')).toBe('project-1');
      expect(params.has('sessionId')).toBe(false);
      expect(params.has('generation')).toBe(false);
    }
  });

  it('reads status and diff through the same bound overlay query contract', async () => {
    rememberSessionWorkspaceGeneration('session-1', 'generation-1');
    authenticatedFetch.mockImplementation(async (url: string) => {
      const payload = url.startsWith('/api/git/status?')
        ? { branch: 'main', modified: ['src/file.ts'] }
        : (url.startsWith('/api/git/diff?') ? { diff: 'overlay diff' } : responseFor(url));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    renderHook(() => useGitPanelController({
      selectedProject: project,
      selectedSession: { id: 'session-1' },
      activeView: 'changes',
    }));

    await waitFor(() => {
      expect(authenticatedFetch.mock.calls.some(([url]) => url.startsWith('/api/git/diff?'))).toBe(true);
    });
    for (const endpoint of ['/api/git/status?', '/api/git/diff?']) {
      const [url] = authenticatedFetch.mock.calls.find(([candidate]) => candidate.startsWith(endpoint))!;
      const params = new URL(url, 'https://nassaj.test').searchParams;
      expect(params.get('project')).toBe('project-1');
      expect(params.get('sessionId')).toBe('session-1');
      expect(params.get('generation')).toBe('generation-1');
    }
  });

  it('sends a bound session through commit-session-overlay with its generation', async () => {
    rememberSessionWorkspaceGeneration('session-1', 'generation-1');
    const { result } = renderHook(() => useGitPanelController({
      selectedProject: project,
      selectedSession: { id: 'session-1' },
      activeView: 'changes',
    }));

    let success = false;
    await act(async () => {
      success = await result.current.commitChanges('fix: isolated commit', ['src/file.ts']);
    });

    expect(success).toBe(true);
    const call = authenticatedFetch.mock.calls.find(([url, options]) =>
      url === '/api/git/commit-session-overlay' && options?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body)).toMatchObject({
      project: 'project-1',
      sessionId: 'session-1',
      generation: 'generation-1',
      files: ['src/file.ts'],
    });
  });

  it('fails closed for a selected legacy session without a generation', async () => {
    const { result } = renderHook(() => useGitPanelController({
      selectedProject: project,
      selectedSession: { id: 'legacy-session' },
      activeView: 'changes',
    }));

    let success = true;
    await act(async () => {
      success = await result.current.commitChanges('fix: unsafe fallback', ['src/file.ts']);
    });

    expect(success).toBe(false);
    expect(result.current.operationError).toContain('no isolated workspace binding');
    expect(authenticatedFetch.mock.calls.some(([url]) =>
      url === '/api/git/commit' || url === '/api/git/commit-session-overlay')).toBe(false);
    expect(authenticatedFetch.mock.calls.some(([url]) =>
      url.startsWith('/api/git/status?') || url.startsWith('/api/git/diff?'))).toBe(false);
  });
});
