/**
 * B-1431 / T-1949 — the sidebar's render-time union of a project's loaded page
 * with its surfaced (off-page, indicator-carrying) rows.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/components/sidebar/hooks/useSidebarController.surfacedSessions.test.tsx
 */
import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../types/app';
import { applyOutcomeDelta, resetSessionCompletionStore } from '../../../stores/sessionCompletionStore';
import {
  applySurfacedSessionContexts,
  getSurfacedSessionsIdentityEpoch,
  __resetSurfacedSessionsStoreForTests,
} from '../../../stores/surfacedSessionsStore';

const apiMocks = vi.hoisted(() => ({
  sessionContexts: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
  api: apiMocks,
}));

const { useSidebarController } = await import('./useSidebarController');

const t = ((key: string) => key) as unknown as TFunction;

function project(projectId: string, sessions: Project['sessions'] = []): Project {
  return {
    projectId,
    displayName: projectId,
    fullPath: `/workspace/${projectId}`,
    isStarred: false,
    sessions,
  };
}

function renderController(projects: Project[], selectedSession: { id: string } | null = null) {
  return renderHook(
    ({ projectsArg, selectedSessionArg }: { projectsArg: Project[]; selectedSessionArg: { id: string } | null }) =>
      useSidebarController({
        projects: projectsArg,
        selectedProject: null,
        selectedSession: selectedSessionArg as never,
        isLoading: false,
        isMobile: false,
        t,
        onRefresh: vi.fn(),
        onProjectSelect: vi.fn(),
        onSessionSelect: vi.fn(),
        setSidebarVisible: vi.fn(),
        sidebarVisible: true,
        bulkLifecycleActions: true,
      }),
    { initialProps: { projectsArg: projects, selectedSessionArg: selectedSession } },
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  apiMocks.sessionContexts.mockResolvedValue({ ok: true, json: async () => ({ contexts: [] }) });
  __resetSurfacedSessionsStoreForTests();
  resetSessionCompletionStore();
});

afterEach(() => {
  __resetSurfacedSessionsStoreForTests();
  resetSessionCompletionStore();
});

describe('B-1431/T-1949 — union of loaded + surfaced rows', () => {
  it('unions a fetched, indicator-carrying row into the rendered list at its natural position', () => {
    const source = project('alpha', [
      { id: 'loaded-1', createdAt: '2026-08-01T00:00:00.000Z' },
    ]);
    applySurfacedSessionContexts(
      ['off-page-1'],
      [{ projectId: 'alpha', provider: 'claude', session: { id: 'off-page-1', createdAt: '2026-09-01T00:00:00.000Z' } as never }],
      getSurfacedSessionsIdentityEpoch(),
    );
    applyOutcomeDelta('off-page-1', 'error', null, 'visible', 'alpha');

    const { result } = renderController([source]);
    act(() => result.current.toggleProject('alpha'));

    // Newer creation time (compareSidebarSessions) puts the surfaced row first.
    const rows = result.current.getSearchVisibleSessions(source);
    expect(rows.map((row) => row.id)).toEqual(['off-page-1', 'loaded-1']);
    expect(rows.find((row) => row.id === 'off-page-1')?.__surfaced).toBe(true);
  });

  it('never lets a surfaced row change the loaded-only count used for load-more', () => {
    const source = project('alpha', [
      { id: 'loaded-1', createdAt: '2026-08-01T00:00:00.000Z' },
    ]);
    applySurfacedSessionContexts(
      ['off-page-1'],
      [{ projectId: 'alpha', provider: 'claude', session: { id: 'off-page-1', createdAt: '2026-09-01T00:00:00.000Z' } as never }],
      getSurfacedSessionsIdentityEpoch(),
    );
    applyOutcomeDelta('off-page-1', 'error', null, 'visible', 'alpha');

    const { result } = renderController([source]);
    act(() => result.current.toggleProject('alpha'));

    // getProjectSessions (loaded-only) is exactly what the delete dialog / the
    // server's `hasMore`+offset math rely on — it must stay blind to the
    // surfaced row even while getSearchVisibleSessions renders it.
    expect(result.current.getProjectSessions(source)).toHaveLength(1);
    expect(result.current.getSearchVisibleSessions(source)).toHaveLength(2);
  });

  it('drops the surfaced row once its indicator clears, unless it is selected', () => {
    const source = project('alpha', []);
    applySurfacedSessionContexts(
      ['off-page-1'],
      [{ projectId: 'alpha', provider: 'claude', session: { id: 'off-page-1', createdAt: '2026-09-01T00:00:00.000Z' } as never }],
      getSurfacedSessionsIdentityEpoch(),
    );
    applyOutcomeDelta('off-page-1', 'error', null, 'visible', 'alpha');

    const { result, rerender } = renderController([source], { id: 'off-page-1' });
    act(() => result.current.toggleProject('alpha'));
    expect(result.current.getSearchVisibleSessions(source).map((r) => r.id)).toEqual(['off-page-1']);

    act(() => applyOutcomeDelta('off-page-1', null, null, 'absent'));
    rerender({ projectsArg: [source], selectedSessionArg: { id: 'off-page-1' } });
    // Still selected — stays visible even with no live indicator.
    expect(result.current.getSearchVisibleSessions(source).map((r) => r.id)).toEqual(['off-page-1']);

    rerender({ projectsArg: [source], selectedSessionArg: null });
    // No longer selected and no indicator — gone.
    expect(result.current.getSearchVisibleSessions(source).map((r) => r.id)).toEqual([]);
  });

  it('sorts a starred surfaced row ahead of an unstarred loaded row, like any other row', () => {
    const source = project('alpha', [
      { id: 'loaded-1', createdAt: '2026-09-05T00:00:00.000Z', starred: false },
    ]);
    applySurfacedSessionContexts(
      ['off-page-starred'],
      [{
        projectId: 'alpha',
        provider: 'claude',
        session: { id: 'off-page-starred', createdAt: '2026-01-01T00:00:00.000Z', starred: true } as never,
      }],
      getSurfacedSessionsIdentityEpoch(),
    );
    applyOutcomeDelta('off-page-starred', 'error', null, 'visible', 'alpha');

    const { result } = renderController([source]);
    act(() => result.current.toggleProject('alpha'));

    // Older creation date, but starred — compareSidebarSessions still puts it
    // first, exactly as it would for a loaded row.
    expect(result.current.getSearchVisibleSessions(source).map((r) => r.id)).toEqual([
      'off-page-starred',
      'loaded-1',
    ]);
  });

  it('applies the hide-closed filter to a surfaced row the same way it applies to a loaded one', () => {
    const source = project('alpha', [
      { id: 'loaded-1', createdAt: '2026-08-01T00:00:00.000Z' },
    ]);
    applySurfacedSessionContexts(
      ['off-page-closed'],
      [{
        projectId: 'alpha',
        provider: 'claude',
        session: { id: 'off-page-closed', createdAt: '2026-09-01T00:00:00.000Z', closed: true } as never,
      }],
      getSurfacedSessionsIdentityEpoch(),
    );
    applyOutcomeDelta('off-page-closed', 'error', null, 'visible', 'alpha');

    const { result } = renderController([source]);
    act(() => result.current.toggleProject('alpha'));
    act(() => result.current.setHideClosedSessions(true));

    // Closed and carrying an indicator: the hide-closed rule (loaded rows'
    // OWN rule — `Boolean(session.closed)`, no indicator override) hides it,
    // exactly as it would a closed loaded row.
    expect(result.current.getSearchVisibleSessions(source).map((r) => r.id)).toEqual(['loaded-1']);
  });
});
