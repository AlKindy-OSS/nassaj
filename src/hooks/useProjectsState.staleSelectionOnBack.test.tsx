/**
 * qa-critic round 1 (B-1469 follow-up) — browser evidence: going back from
 * `/session/X` to `/` with the browser's own Back button (not through
 * `handleProjectSelect`/`handleNewSession`, which already clear
 * `selectedSession` themselves) left `selectedSession` pointing at X. The URL
 * said "no session" but the next message sent from `/` landed in X's history
 * instead of starting a new conversation — confirmed in the live dev server
 * (A/B: reverting this effect reproduced it, X picking up a second,
 * unrelated send; restoring it, the next send correctly minted a new id).
 *
 * `sessionId` here mirrors `routeSessionIdFromPathname(location.pathname)` —
 * it goes `undefined` for ANY navigation away from `/session/:id` (Back
 * button, `/scheduled`, or a plain `navigate('/')`), which is exactly the
 * condition this hook's own clearing effect keys off.
 *
 * RUNNER: vitest.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../types/app';

const { projectsApi } = vi.hoisted(() => ({ projectsApi: vi.fn() }));
vi.mock('../utils/api', () => ({
  api: { projects: (...args: unknown[]) => projectsApi(...args), sessionContext: vi.fn() },
}));

import { useProjectsState } from './useProjectsState';

const SID = 'session-X';
const project = {
  projectId: 'project-1',
  displayName: 'Nassaj',
  fullPath: '/workspace/nassaj',
  sessions: [{ id: SID, title: 'X' }],
} as unknown as Project;

const projectsResponse = () => new Response(JSON.stringify([project]), {
  status: 200,
  headers: { 'X-Nassaj-Snapshot-State': 'ready' },
});

beforeEach(() => {
  projectsApi.mockReset();
  projectsApi.mockImplementation(async () => projectsResponse());
  localStorage.clear();
});
afterEach(() => cleanup());

describe('selectedSession clears when the route session id disappears outside the leaving path', () => {
  it('Back-button-style navigation (sessionId -> undefined with no handler call) clears selectedSession', async () => {
    const { result, rerender } = renderHook(
      ({ routeSessionId }: { routeSessionId?: string }) => useProjectsState({
        sessionId: routeSessionId,
        navigate: vi.fn(),
        latestMessage: null,
        isMobile: false,
        activeSessions: new Set(),
      }),
      { initialProps: { routeSessionId: SID as string | undefined } },
    );

    await waitFor(() => expect(result.current.selectedSession?.id).toBe(SID));

    // The browser's own Back button: the URL's session id disappears with no
    // `handleProjectSelect`/`handleNewSession`/`selectProjectForTool` call in
    // between (those already clear `selectedSession` themselves).
    rerender({ routeSessionId: undefined });

    await waitFor(() => expect(result.current.selectedSession).toBeNull());
  });

  it('does not touch selectedSession while the route still names the same session', async () => {
    const { result, rerender } = renderHook(
      ({ routeSessionId }: { routeSessionId?: string }) => useProjectsState({
        sessionId: routeSessionId,
        navigate: vi.fn(),
        latestMessage: null,
        isMobile: false,
        activeSessions: new Set(),
      }),
      { initialProps: { routeSessionId: SID as string | undefined } },
    );

    await waitFor(() => expect(result.current.selectedSession?.id).toBe(SID));
    const firstSelection = result.current.selectedSession;

    act(() => rerender({ routeSessionId: SID }));

    expect(result.current.selectedSession).toBe(firstSelection);
  });
});
