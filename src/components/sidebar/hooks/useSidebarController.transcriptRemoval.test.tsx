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

describe('B-1610 — session delete', () => {
  it('offers a retry on 409 and keeps the row until the retry succeeds', async () => {
    const confirm = dialogMocks.confirmDialog.mockResolvedValue(true);
    apiMocks.deleteSession.mockResolvedValueOnce(retry409()).mockResolvedValueOnce(response({
      success: true, data: { sessionId: 's1', action: 'deleted', deletedFromDisk: true },
    }));
    const { result, onSessionDelete } = renderController();
    await deleteSession(result);

    expect(confirm).toHaveBeenCalledWith('messages.deleteSessionRetry');
    expect(apiMocks.deleteSession).toHaveBeenCalledTimes(2);
    expect(apiMocks.deleteSession).toHaveBeenLastCalledWith('s1', true);
    expect(onSessionDelete).toHaveBeenCalledOnce();
    expect(dialogMocks.alertDialog).not.toHaveBeenCalled();
  });

  it('waits for the async retry answer before deleting again (T-2039)', async () => {
    let answer!: (accepted: boolean) => void;
    dialogMocks.confirmDialog.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    apiMocks.deleteSession.mockResolvedValueOnce(retry409()).mockResolvedValueOnce(response({
      success: true, data: { sessionId: 's1', action: 'deleted', deletedFromDisk: true },
    }));
    const { result, onSessionDelete } = renderController();
    act(() => { result.current.showDeleteSessionConfirmation('alpha', 's1', 'One'); });
    let running!: Promise<void>;
    act(() => { running = result.current.confirmDeleteSession(true); });

    await vi.waitFor(() => expect(dialogMocks.confirmDialog).toHaveBeenCalledOnce());
    expect(apiMocks.deleteSession).toHaveBeenCalledTimes(1);
    expect(onSessionDelete).not.toHaveBeenCalled();

    await act(async () => { answer(true); await running; });
    expect(apiMocks.deleteSession).toHaveBeenCalledTimes(2);
    expect(onSessionDelete).toHaveBeenCalledOnce();
  });

  it('removes nothing locally when the user declines the retry', async () => {
    dialogMocks.confirmDialog.mockResolvedValue(false);
    apiMocks.deleteSession.mockResolvedValue(retry409());
    const { result, onSessionDelete } = renderController();
    await deleteSession(result);

    expect(apiMocks.deleteSession).toHaveBeenCalledOnce();
    expect(onSessionDelete).not.toHaveBeenCalled();
    expect(dialogMocks.alertDialog).not.toHaveBeenCalled();
  });

  it('shows the neutral notice when the file stayed on the device', async () => {
    apiMocks.deleteSession.mockResolvedValue(response({
      success: true, data: { sessionId: 's1', action: 'deleted', deletedFromDisk: false },
    }));
    const { result, onSessionDelete } = renderController();
    await deleteSession(result);

    expect(onSessionDelete).toHaveBeenCalledWith('s1');
    expect(dialogMocks.alertDialog).toHaveBeenCalledWith('messages.deleteSessionFileKept');
  });

  it('stays silent when archiving (deletedFromDisk is always false there)', async () => {
    apiMocks.deleteSession.mockResolvedValue(response({
      success: true, data: { sessionId: 's1', action: 'archived', deletedFromDisk: false },
    }));
    const { result } = renderController();
    await deleteSession(result, false);
    expect(dialogMocks.alertDialog).not.toHaveBeenCalled();
  });

  it('keeps the generic failure for other errors', async () => {
    const confirm = dialogMocks.confirmDialog;
    apiMocks.deleteSession.mockResolvedValue(response({ error: { code: 'SESSION_NOT_FOUND' } }, 404));
    const { result } = renderController();
    await deleteSession(result);
    expect(confirm).not.toHaveBeenCalled();
    expect(dialogMocks.alertDialog).toHaveBeenCalledWith('messages.deleteSessionFailed');
  });
});

describe('B-1610 — project delete', () => {
  it('retries on a pre-commit 409 and reports failed and kept files', async () => {
    const confirm = dialogMocks.confirmDialog.mockResolvedValue(true);
    apiMocks.deleteProject.mockResolvedValueOnce(retry409()).mockResolvedValueOnce(response({
      success: true, transcripts: { removed: 3, keptForSafety: 1, failed: 2 },
    }));
    const { result, onProjectDelete } = renderController();
    await deleteProject(result);

    expect(confirm).toHaveBeenCalledWith('messages.deleteProjectRetry');
    expect(apiMocks.deleteProject).toHaveBeenCalledTimes(2);
    expect(onProjectDelete).toHaveBeenCalledWith('alpha');
    expect(dialogMocks.alertDialog).toHaveBeenCalledWith(
      'messages.projectTranscriptsFailed:2\nmessages.projectTranscriptsKept:1',
    );
    expect(result.current.deletingProjects.size).toBe(0);
  });

  it('is silent when every file was removed', async () => {
    apiMocks.deleteProject.mockResolvedValue(response({
      success: true, transcripts: { removed: 3, keptForSafety: 0, failed: 0 },
    }));
    const { result } = renderController();
    await deleteProject(result);
    expect(dialogMocks.alertDialog).not.toHaveBeenCalled();
  });

  it('still shows the server message for other failures', async () => {
    apiMocks.deleteProject.mockResolvedValue(response({ error: { message: 'Insufficient permissions' } }, 403));
    const { result, onProjectDelete } = renderController();
    await deleteProject(result);
    expect(onProjectDelete).not.toHaveBeenCalled();
    expect(dialogMocks.alertDialog).toHaveBeenCalledWith('Insufficient permissions');
  });
});

describe('B-1610 — bulk delete', () => {
  it('asks with the danger tone and sends nothing when declined (T-2039)', async () => {
    dialogMocks.confirmDialog.mockResolvedValue(false);
    const { result } = renderController();
    act(() => {
      result.current.enterBulkSelection('sessions');
      result.current.selectVisibleBulkIds(['s1', 's2']);
    });
    let outcome: boolean | undefined;
    await act(async () => { outcome = await result.current.runBulkAction('delete_permanently'); });

    expect(outcome).toBe(false);
    expect(dialogMocks.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }));
    expect(apiMocks.bulkSessions).not.toHaveBeenCalled();
    expect(result.current.bulkSelectedIds).toEqual(new Set(['s1', 's2']));
  });

  it('keeps only the retryable session selected and explains why', async () => {
    dialogMocks.confirmDialog.mockResolvedValue(true);
    apiMocks.bulkSessions.mockResolvedValue(response({ success: true, data: { results: [
      { id: 's1', success: true, result: { action: 'deleted', deletedFromDisk: false } },
      { id: 's2', success: false, error: { code: 'TRANSCRIPT_REMOVAL_RETRY', message: 'x' } },
    ] } }));
    const { result } = renderController();
    act(() => {
      result.current.enterBulkSelection('sessions');
      result.current.selectVisibleBulkIds(['s1', 's2']);
    });
    await act(async () => { await result.current.runBulkAction('delete_permanently'); });

    expect(result.current.bulkSelectedIds).toEqual(new Set(['s2']));
    expect(dialogMocks.alertDialog).toHaveBeenCalledWith(
      'messages.bulkTranscriptRetry:1\nmessages.bulkSessionFilesKept:1',
    );
  });

  it('sums project transcript counts across the batch', async () => {
    dialogMocks.confirmDialog.mockResolvedValue(true);
    apiMocks.bulkProjects.mockResolvedValue(response({ success: true, data: { results: [
      { id: 'alpha', success: true, transcripts: { removed: 1, keptForSafety: 0, failed: 1 } },
      { id: 'beta', success: true, transcripts: { removed: 0, keptForSafety: 0, failed: 2 } },
    ] } }));
    const { result } = renderController();
    act(() => {
      result.current.enterBulkSelection('projects');
      result.current.selectVisibleBulkIds(['alpha', 'beta']);
    });
    await act(async () => { await result.current.runBulkAction('delete_permanently'); });

    expect(result.current.bulkSelectionKind).toBeNull();
    expect(dialogMocks.alertDialog).toHaveBeenCalledWith('messages.projectTranscriptsFailed:3');
  });
});
