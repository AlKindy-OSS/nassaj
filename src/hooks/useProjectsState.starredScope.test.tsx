/**
 * A `projects_updated` frame must never blank a pin it does not speak about
 * (B-825).
 *
 * The server now builds one payload per recipient, so `starred` arrives
 * correct. This is the version-skew net underneath that: an older server sends
 * a frame with no `starred` key at all, and dropping it silently would hollow
 * every bookmark on the first broadcast. The second case is the reason the net
 * is keyed on `undefined` and not on falsiness — an explicit `starred: false`
 * is a real un-pin from another tab and must still land.
 */
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSocketMessage, Project, ProjectSession } from '../types/app';

const { projectsApi } = vi.hoisted(() => ({ projectsApi: vi.fn() }));
vi.mock('../utils/api', () => ({
  api: { projects: (...args: unknown[]) => projectsApi(...args) },
}));

import { useProjectsState } from './useProjectsState';

const PINNED_SESSION_ID = 'session-pinned';

const projectWith = (sessions: ProjectSession[]): Project => ({
  projectId: 'project-1',
  displayName: 'Nassaj',
  fullPath: '/workspace/nassaj',
  sessions,
} as Project);

/** The authenticated REST read: the pin is present and true. */
const restResponse = (): Response =>
  new Response(
    JSON.stringify([
      projectWith([{ id: PINNED_SESSION_ID, summary: 'Pinned', starred: true, updated_at: 'T1' }]),
    ]),
    { status: 200, headers: { 'X-Nassaj-Snapshot-State': 'ready' } },
  );

/**
 * A broadcast frame. It always carries a second, newer conversation so the
 * frame is a real change and cannot be dropped as a no-op — which would let the
 * pin survive for the wrong reason.
 */
const broadcast = (pinnedSession: ProjectSession): AppSocketMessage => ({
  type: 'projects_updated',
  projects: [
    projectWith([
      { id: 'session-new', summary: 'Newer', updated_at: 'T2' },
      pinnedSession,
    ]),
  ],
});

const readPinned = (projects: Project[]): ProjectSession | undefined =>
  (projects[0]?.sessions as ProjectSession[] | undefined)?.find(
    (session) => session.id === PINNED_SESSION_ID,
  );

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
  projectsApi.mockResolvedValue(restResponse());
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => cleanup());

describe('per-user flags across a projects_updated broadcast', () => {
  it('keeps the pin when the frame omits `starred` entirely', async () => {
    const { result, rerender } = renderWithMessage();
    await waitFor(() => expect(readPinned(result.current.projects)?.starred).toBe(true));

    rerender({
      latestMessage: broadcast({ id: PINNED_SESSION_ID, summary: 'Pinned', updated_at: 'T1' }),
    });

    await waitFor(() => expect(result.current.projects[0]?.sessions).toHaveLength(2));
    expect(readPinned(result.current.projects)?.starred).toBe(true);
  });

  it('honours an explicit un-pin performed elsewhere', async () => {
    const { result, rerender } = renderWithMessage();
    await waitFor(() => expect(readPinned(result.current.projects)?.starred).toBe(true));

    rerender({
      latestMessage: broadcast({
        id: PINNED_SESSION_ID,
        summary: 'Pinned',
        starred: false,
        updated_at: 'T1',
      }),
    });

    await waitFor(() => expect(readPinned(result.current.projects)?.starred).toBe(false));
  });
});
