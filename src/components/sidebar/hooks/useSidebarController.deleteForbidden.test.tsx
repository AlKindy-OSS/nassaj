/**
 * B-1647 — a permanent delete refused with session_delete_forbidden shows its
 * own localized explanation (single delete and bulk results).
 */
import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../types/app';

const apiMocks = vi.hoisted(() => ({
  archivedProjects: vi.fn(),
  getArchivedSessions: vi.fn(),
  deleteSession: vi.fn(),
  deleteProject: vi.fn(),
  bulkProjects: vi.fn(),
  bulkSessions: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({ api: apiMocks }));

// T-2039: confirm/alert go through the themed dialog service, not window.*.
const dialogMocks = vi.hoisted(() => ({
  confirmDialog: vi.fn<(options: unknown) => Promise<boolean>>(),
  alertDialog: vi.fn<(options: unknown) => Promise<void>>(),
}));

vi.mock('../../../shared/dialogs/dialogService', () => dialogMocks);

const { useSidebarController } = await import('./useSidebarController');

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const retry409 = () => response({
  success: false,
  error: { code: 'TRANSCRIPT_REMOVAL_RETRY', message: 'The conversation file could not be removed.' },
}, 409);

const t = ((key: string, fallback?: string | { count?: number }, options?: { count?: number }) => {
  const count = typeof fallback === 'object' ? fallback.count : options?.count;
  return count === undefined ? key : `${key}:${count}`;
}) as unknown as TFunction;

const alpha: Project = { projectId: 'alpha', displayName: 'alpha', fullPath: '/w/alpha', sessions: [] };

// Stable identities: a fresh array per render would re-run the hook's effects forever.
const projects = [alpha];
const onRefresh = vi.fn();

function renderController() {
  const onSessionDelete = vi.fn();
  const onProjectDelete = vi.fn();
  const view = renderHook(() => useSidebarController({
    projects,
    selectedProject: null,
    selectedSession: null,
    isLoading: false,
    isMobile: false,
    t,
    onRefresh,
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    onSessionDelete,
    onProjectDelete,
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
    bulkLifecycleActions: true,
  }));
  return { ...view, onSessionDelete, onProjectDelete };
}

async function deleteSession(result: ReturnType<typeof renderController>['result'], hard = true) {
  act(() => { result.current.showDeleteSessionConfirmation('alpha', 's1', 'One'); });
  await act(async () => { await result.current.confirmDeleteSession(hard); });
}

async function deleteProject(result: ReturnType<typeof renderController>['result']) {
  act(() => { result.current.requestProjectDelete(alpha); });
  await act(async () => { await result.current.confirmDeleteProject(true); });
}

beforeEach(() => {
  vi.clearAllMocks();
  dialogMocks.alertDialog.mockResolvedValue(undefined);
  dialogMocks.confirmDialog.mockResolvedValue(false);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  apiMocks.archivedProjects.mockResolvedValue(response({ success: true, data: { projects: [] } }));
  apiMocks.getArchivedSessions.mockResolvedValue(response({ success: true, data: { sessions: [] } }));
});

describe('B-1647 — session_delete_forbidden', () => {
  it('single delete: shows the forbidden explanation, not the generic failure', async () => {
    apiMocks.deleteSession.mockResolvedValue(response({
      success: false, error: { code: 'session_delete_forbidden', message: 'Forbidden' },
    }, 403));
    const { result, onSessionDelete } = renderController();
    await deleteSession(result);

    expect(onSessionDelete).not.toHaveBeenCalled();
    expect(dialogMocks.alertDialog).toHaveBeenCalledWith('chat:sessionDelete.forbidden');
    expect(dialogMocks.alertDialog).not.toHaveBeenCalledWith('messages.deleteSessionFailed');
  });

  it('bulk: a forbidden item adds the explanation to the outcome notice', async () => {
    dialogMocks.confirmDialog.mockResolvedValue(true);
    apiMocks.bulkSessions.mockResolvedValue(response({
      success: true,
      data: { results: [
        { id: 's1', success: false, error: { code: 'session_delete_forbidden' } },
        { id: 's2', success: true, result: {} },
      ] },
    }));
    const { result } = renderController();
    act(() => {
      result.current.enterBulkSelection('sessions');
      result.current.toggleBulkSelectedId('s1');
      result.current.toggleBulkSelectedId('s2');
    });
    await act(async () => {
      await result.current.runBulkAction('delete_permanently');
    });
    const notice = String(dialogMocks.alertDialog.mock.lastCall?.[0]);
    expect(notice).toContain('chat:sessionDelete.forbidden');
  });
});
