import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => (
    key === 'projects.pushReminder' ? `${options?.count} commits ready to push` : key
  ), i18n: { language: 'en', dir: () => 'ltr' } }),
}));
vi.mock('../../../../contexts/AuthContext', () => ({ useOptionalAuth: () => ({ isMultiUser: false }) }));
vi.mock('../../../participants', () => ({ ProjectParticipantsSummary: () => null }));
vi.mock('../../../../utils/api', () => ({ authenticatedFetch }));

const SidebarProjectItem = (await import('./SidebarProjectItem')).default;
const t = ((key: string, options?: { count?: number; defaultValue?: string }) =>
  key === 'projects.pushReminder' ? `${options?.count} commits ready to push` : (options?.defaultValue ?? key)) as unknown as TFunction;

let observers: Array<() => void> = [];
const originalIntersectionObserver = globalThis.IntersectionObserver;

class ProjectRowObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe() { observers.push(() => this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
  root = null;
  rootMargin = '80px';
  thresholds = [0];
}

const project = {
  projectId: 'project-push-reminder', displayName: 'nassaj-dev', fullPath: '/workspace/nassaj-dev', sessionMeta: { total: 176 },
};

function projectItem() {
  return <SidebarProjectItem
    project={project} selectedProject={null} selectedSession={null} isExpanded={false} isDeleting={false}
    isStarred={false} isSessionStarred={() => false} onToggleStarSession={() => {}}
    editingProject={null} editingName="" sessions={[]} initialSessionsLoaded isLoadingMoreSessions={false}
    currentTime={new Date()} editingSession={null} editingSessionName="" onEditingNameChange={() => {}}
    onToggleProject={() => {}} onProjectSelect={() => {}} onToggleStarProject={() => {}}
    onStartEditingProject={() => {}} onCancelEditingProject={() => {}} onSaveProjectName={() => {}}
    onDeleteProject={() => {}} onArchiveProject={() => {}} onSessionSelect={() => {}}
    onDeleteSession={() => {}} onLoadMoreSessions={() => {}} onNewSession={() => {}}
    onEditingSessionNameChange={() => {}} onStartEditingSession={() => {}} onCancelEditingSession={() => {}}
    onSaveEditingSession={() => {}} activeProjectTool={undefined} onOpenProjectTool={undefined}
    onProjectToolbarPresence={undefined} t={t}
  />;
}

afterEach(() => {
  cleanup();
  authenticatedFetch.mockReset();
  observers = [];
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

describe('SidebarProjectItem — تذكير الدفْع', () => {
  it('يظهر عدد الالتزامات الجاهزة للدفع بعد دخول صف المشروع نطاق الرؤية', async () => {
    globalThis.IntersectionObserver = ProjectRowObserver as unknown as typeof IntersectionObserver;
    authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({ isRepositoryRoot: true, hasUpstream: true, ahead: 3 }) });
    const { rerender } = render(projectItem());

    observers.forEach((notify) => notify());
    await waitFor(() => expect(screen.getByRole('img', { name: '3 commits ready to push' })).toBeTruthy());
    expect(document.querySelector('[data-project-push-reminder]')?.textContent).toBe('');
    expect(authenticatedFetch).toHaveBeenCalledWith(
      '/api/git/remote-status?project=project-push-reminder', expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    rerender(projectItem());
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ isRepositoryRoot: true, hasUpstream: false, ahead: 3 }],
    [{ isRepositoryRoot: true, hasUpstream: true, ahead: 0 }],
    [{ isRepositoryRoot: true, hasUpstream: true, ahead: '3' }],
    [{ isRepositoryRoot: false, hasUpstream: true, ahead: 3 }],
    [{ hasUpstream: true, ahead: 3 }],
  ])('يخفي الشارة إن لم تستوفِ الاستجابة الشرط: %o', async (status) => {
    globalThis.IntersectionObserver = ProjectRowObserver as unknown as typeof IntersectionObserver;
    authenticatedFetch.mockResolvedValue({ ok: true, json: async () => status });
    render(projectItem());
    observers.forEach((notify) => notify());
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('img', { name: /commits ready to push/ })).toBeNull();
  });

  it('يخفي الشارة عند فشل واجهة البرمجة', async () => {
    globalThis.IntersectionObserver = ProjectRowObserver as unknown as typeof IntersectionObserver;
    authenticatedFetch.mockRejectedValue(new Error('offline'));
    render(projectItem());
    observers.forEach((notify) => notify());
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('img', { name: /commits ready to push/ })).toBeNull();
  });
});
