import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';

const apiMocks = vi.hoisted(() => ({
  archivedProjects: vi.fn(),
  getArchivedSessions: vi.fn(),
  starSession: vi.fn(),
  toggleProjectStar: vi.fn(),
  bulkProjects: vi.fn(),
  bulkSessions: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
  api: apiMocks,
}));

const { useSidebarController } = await import('./useSidebarController');

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

function project(
  projectId: string,
  options: { isStarred?: boolean; sessions?: Project['sessions'] } = {},
): Project {
  return {
    projectId,
    displayName: projectId,
    fullPath: `/workspace/${projectId}`,
    isStarred: options.isStarred ?? false,
    sessions: options.sessions ?? [],
  };
}

function renderController(projects: Project[], bulkLifecycleActions = true) {
  return renderHook(() =>
    useSidebarController({
      projects,
      selectedProject: null,
      selectedSession: null,
      isLoading: false,
      isMobile: false,
      t,
      onRefresh: vi.fn(),
      onProjectSelect: vi.fn(),
      onSessionSelect: vi.fn(),
      setSidebarVisible: vi.fn(),
      sidebarVisible: true,
      bulkLifecycleActions,
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  apiMocks.archivedProjects.mockResolvedValue(response({ success: true, data: { projects: [] } }));
  apiMocks.getArchivedSessions.mockResolvedValue(response({ success: true, data: { sessions: [] } }));
});

describe('B-754 — session star mutations', () => {
  it('يسلسل النقر السريع ويُبقي ترتيب الصف وحالة رمزه من النية المتفائلة نفسها', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMocks.starSession.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const source = project('alpha', {
      sessions: [
        { id: 'older', createdAt: '2026-08-01T00:00:00.000Z', starred: false },
        { id: 'newer', createdAt: '2026-08-02T00:00:00.000Z', starred: false },
      ],
    });
    const { result } = renderController([source]);
    const initialOlderRow = result.current.getProjectSessions(source).find((row) => row.id === 'older')!;

    act(() => {
      result.current.toggleStarSession(initialOlderRow, source.projectId);
    });

    let rows = result.current.getProjectSessions(source);
    expect(rows.map((session) => session.id)).toEqual(['older', 'newer']);
    expect(result.current.isSessionStarred(rows[0])).toBe(true);

    act(() => {
      result.current.toggleStarSession(rows[0], source.projectId);
    });

    rows = result.current.getProjectSessions(source);
    expect(rows.map((session) => session.id)).toEqual(['newer', 'older']);
    expect(result.current.isSessionStarred(rows[1])).toBe(false);
    expect(apiMocks.starSession).toHaveBeenCalledTimes(1);
    expect(apiMocks.starSession).toHaveBeenNthCalledWith(1, 'older', 'alpha', true);

    await act(async () => {
      first.resolve(response({ data: { starred: true } }));
      await first.promise;
    });

    await waitFor(() => expect(apiMocks.starSession).toHaveBeenCalledTimes(2));
    expect(apiMocks.starSession).toHaveBeenNthCalledWith(2, 'older', 'alpha', false);

    await act(async () => {
      second.resolve(response({ data: { starred: false } }));
      await second.promise;
    });

    rows = result.current.getProjectSessions(source);
    expect(rows.map((session) => session.id)).toEqual(['newer', 'older']);
    expect(result.current.isSessionStarred(rows[1])).toBe(false);
  });

  it('يرجع إلى آخر حالة مؤكدة حين تفشل آخر طفرة للمحادثة', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMocks.starSession.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const source = project('alpha', {
      sessions: [{ id: 'session-1', createdAt: '2026-08-01T00:00:00.000Z', starred: false }],
    });
    const { result } = renderController([source]);
    const initialRow = result.current.getProjectSessions(source)[0];

    act(() => {
      result.current.toggleStarSession(initialRow, source.projectId);
      result.current.toggleStarSession(initialRow, source.projectId);
    });

    await act(async () => {
      first.resolve(response({ data: { starred: true } }));
      await first.promise;
    });
    await waitFor(() => expect(apiMocks.starSession).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(response({}, false));
      await second.promise;
    });

    const row = result.current.getProjectSessions(source)[0];
    expect(result.current.isSessionStarred(row)).toBe(true);
  });
});

describe('B-754 — project star mutations', () => {
  it('يرسل الحالات المطلوبة بالتسلسل ويجعل آخر نقرة هي الحالة النهائية', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMocks.toggleProjectStar.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const projects = [project('alpha'), project('zulu')];
    const { result } = renderController(projects);

    act(() => {
      result.current.toggleStarProject('zulu');
    });
    expect(result.current.filteredProjects.map((item) => item.projectId)).toEqual(['zulu', 'alpha']);
    expect(result.current.isProjectStarred('zulu')).toBe(true);

    act(() => {
      result.current.toggleStarProject('zulu');
    });
    expect(result.current.filteredProjects.map((item) => item.projectId)).toEqual(['alpha', 'zulu']);
    expect(result.current.isProjectStarred('zulu')).toBe(false);
    expect(apiMocks.toggleProjectStar).toHaveBeenCalledTimes(1);
    expect(apiMocks.toggleProjectStar).toHaveBeenNthCalledWith(1, 'zulu', true);

    await act(async () => {
      first.resolve(response({ isStarred: true }));
      await first.promise;
    });
    await waitFor(() => expect(apiMocks.toggleProjectStar).toHaveBeenCalledTimes(2));
    expect(apiMocks.toggleProjectStar).toHaveBeenNthCalledWith(2, 'zulu', false);

    await act(async () => {
      second.resolve(response({ isStarred: false }));
      await second.promise;
    });
    expect(result.current.isProjectStarred('zulu')).toBe(false);
  });

  it('يرجع المشروع إلى آخر حالة مؤكدة حين تفشل آخر طفرة', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMocks.toggleProjectStar.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderController([project('alpha')]);

    act(() => {
      result.current.toggleStarProject('alpha');
      result.current.toggleStarProject('alpha');
    });

    await act(async () => {
      first.resolve(response({ isStarred: true }));
      await first.promise;
    });
    await waitFor(() => expect(apiMocks.toggleProjectStar).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(response({ error: 'failed' }, false));
      await second.promise;
    });

    expect(result.current.isProjectStarred('alpha')).toBe(true);
    expect(window.alert).toHaveBeenCalledTimes(1);
  });
});

describe('bulk lifecycle safety', () => {
  it('does not open confirmation or call the API when health has not advertised the capability', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { result } = renderController([project('alpha')], false);

    act(() => {
      result.current.enterBulkSelection('projects');
      result.current.selectVisibleBulkIds(['alpha']);
    });

    await act(async () => {
      await result.current.runBulkAction('delete_permanently');
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(apiMocks.bulkProjects).not.toHaveBeenCalled();
    expect(result.current.bulkSelectedIds).toEqual(new Set(['alpha']));
  });

  it('keeps the selection after a non-success bulk response', async () => {
    apiMocks.bulkProjects.mockResolvedValue(response({ error: { message: 'not allowed' } }, false));
    const { result } = renderController([project('alpha')]);
    act(() => {
      result.current.enterBulkSelection('projects');
      result.current.selectVisibleBulkIds(['alpha']);
    });

    await act(async () => {
      await result.current.runBulkAction('archive');
    });

    expect(apiMocks.bulkProjects).toHaveBeenCalledWith(['alpha'], 'archive');
    expect(result.current.bulkSelectionKind).toBe('projects');
    expect(result.current.bulkSelectedIds).toEqual(new Set(['alpha']));
  });

  it('retains only failed IDs after a partial successful response', async () => {
    apiMocks.bulkProjects.mockResolvedValue(response({
      data: { results: [{ id: 'alpha', success: true }, { id: 'beta', success: false }] },
    }));
    const { result } = renderController([project('alpha'), project('beta')]);
    act(() => {
      result.current.enterBulkSelection('projects');
      result.current.selectVisibleBulkIds(['alpha', 'beta']);
    });

    await act(async () => {
      await result.current.runBulkAction('archive');
    });

    expect(result.current.bulkSelectionKind).toBe('projects');
    expect(result.current.bulkSelectedIds).toEqual(new Set(['beta']));
  });
});


describe('independent project expansion', () => {
  it('keeps other projects open through session selection and closing one project', () => {
    const alpha = project('alpha');
    const betaSession = { id: 'beta-session', __provider: 'claude' as const };
    const beta = project('beta', { sessions: [betaSession] });
    const projects = [alpha, beta];
    const onSessionSelect = vi.fn();
    const { result, rerender } = renderHook(
      ({ selectedProject, selectedSession }: { selectedProject: Project | null; selectedSession: ProjectSession | null }) =>
        useSidebarController({
          projects, selectedProject, selectedSession, isLoading: false, isMobile: false, t,
          onRefresh: vi.fn(), onProjectSelect: vi.fn(), onSessionSelect,
          setSidebarVisible: vi.fn(), sidebarVisible: true, bulkLifecycleActions: true,
        }),
      { initialProps: { selectedProject: null, selectedSession: null } as {
        selectedProject: Project | null; selectedSession: ProjectSession | null;
      } },
    );

    act(() => {
      result.current.toggleProject('alpha');
      result.current.toggleProject('beta');
      result.current.toggleProject('beta');
      result.current.toggleProject('beta');
    });
    expect([...result.current.expandedProjects]).toEqual(['alpha', 'beta']);

    act(() => result.current.handleSessionClick(betaSession, 'beta'));
    expect(onSessionSelect).toHaveBeenCalledWith({ ...betaSession, __projectId: 'beta' });
    rerender({ selectedProject: beta, selectedSession: betaSession });
    expect([...result.current.expandedProjects]).toEqual(['alpha', 'beta']);

    act(() => result.current.toggleProject('beta'));
    expect([...result.current.expandedProjects]).toEqual(['alpha']);
    rerender({ selectedProject: { ...beta }, selectedSession: { ...betaSession } });
    expect([...result.current.expandedProjects]).toEqual(['alpha']);

    rerender({ selectedProject: alpha, selectedSession: null });
    expect([...result.current.expandedProjects]).toEqual(['alpha']);
    rerender({ selectedProject: beta, selectedSession: betaSession });
    expect([...result.current.expandedProjects]).toEqual(['alpha', 'beta']);
  });
});
