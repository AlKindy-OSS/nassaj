import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const response = () => new Response(JSON.stringify([]), {
  status: 200,
  headers: { 'X-Nassaj-Snapshot-State': 'ready' },
});

beforeEach(() => {
  projectsApi.mockReset();
  projectsApi.mockResolvedValue(response());
  sessionContextApi.mockReset();
  window.history.replaceState(null, '', '/?settings=agents&settingsAgent=codex&settingsCategory=permissions');
});

afterEach(cleanup);

describe('settings URL history', () => {
  it('updates the open settings destination when browser history changes', async () => {
    const { result } = renderHook(() => useProjectsState({
      navigate: vi.fn(),
      latestMessage: null,
      isMobile: false,
      activeSessions: new Set(),
    }));

    // The modal must be present on the first render for a shared URL; it should
    // not depend on the post-mount synchronization effect to appear.
    expect(result.current.showSettings).toBe(true);
    await waitFor(() => expect(result.current.showSettings).toBe(true));
    expect(result.current.settingsDeepLink).toEqual({
      tab: 'agents', agent: 'codex', category: 'permissions',
    });

    act(() => {
      window.history.replaceState(null, '', '/?settings=git');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await waitFor(() => expect(result.current.settingsDeepLink).toEqual({ tab: 'git' }));
    expect(result.current.settingsInitialTab).toBe('git');

    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await waitFor(() => expect(result.current.showSettings).toBe(false));
    expect(result.current.settingsDeepLink).toBeUndefined();
  });
});
