/**
 * The project menu trigger must not also toggle the project's accordion.
 *
 * On touch browsers the original nested button/card interaction let the card
 * receive the reconstructed click, expanding it and visibly moving ⋮. This
 * test pins the trigger marker that the card-level guard checks.
 */
import type { TFunction } from 'i18next';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar', dir: () => 'rtl' } }),
}));

vi.mock('../../../../contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ isMultiUser: false }),
}));

vi.mock('../../../participants', () => ({
  ProjectParticipantsSummary: () => null,
}));

const SidebarProjectItem = (await import('./SidebarProjectItem')).default;

const t = ((key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key) as unknown as TFunction;

const project = {
  projectId: 'project-1',
  displayName: 'nassaj-dev',
  fullPath: '/workspace/sample-project',
  sessionMeta: { total: 2 },
};

function renderProject(
  onToggleProject = vi.fn(),
  onStartBulkSelectionWithId = vi.fn(),
  bulkProps: Partial<Pick<ComponentProps<typeof SidebarProjectItem>, 'bulkSelectionKind' | 'bulkSelectedIds' | 'onToggleBulkSelectedId'>> = {},
) {
  return render(
    <SidebarProjectItem
      project={project}
      selectedProject={null}
      selectedSession={null}
      isExpanded={false}
      isDeleting={false}
      {...bulkProps}
      onStartBulkSelectionWithId={onStartBulkSelectionWithId}
      isStarred={false}
      isSessionStarred={() => false}
      onToggleStarSession={() => {}}
      editingProject={null}
      editingName=""
      sessions={[]}
      initialSessionsLoaded
      isLoadingMoreSessions={false}
      currentTime={new Date('2026-08-10T12:00:00.000Z')}
      editingSession={null}
      editingSessionName=""
      onEditingNameChange={() => {}}
      onToggleProject={onToggleProject}
      onProjectSelect={() => {}}
      onToggleStarProject={() => {}}
      onStartEditingProject={() => {}}
      onCancelEditingProject={() => {}}
      onSaveProjectName={() => {}}
      onDeleteProject={() => {}}
      onArchiveProject={() => {}}
      onSessionSelect={() => {}}
      onDeleteSession={() => {}}
      onLoadMoreSessions={() => {}}
      onNewSession={() => {}}
      onEditingSessionNameChange={() => {}}
      onStartEditingSession={() => {}}
      onCancelEditingSession={() => {}}
      onSaveEditingSession={() => {}}
      t={t}
    />,
  );
}

afterEach(cleanup);

describe('SidebarProjectItem — زر قائمة المشروع', () => {
  it('exposes the full project path in the touch menu and reserves its height near the viewport edge', () => {
    const { container } = renderProject();
    const toggle = container.querySelector('[aria-expanded]')!;
    const pathDescription = document.getElementById(toggle.getAttribute('aria-describedby')!);
    expect(pathDescription?.textContent).toBe(project.fullPath);
    expect(toggle.getAttribute('title')).toContain(project.fullPath);
    fireEvent.contextMenu(toggle, {
      clientX: window.innerWidth - 1,
      clientY: window.innerHeight - 1,
    });
    const menu = screen.getByRole('menu');
    const path = menu.querySelector<HTMLElement>('[data-project-menu-path]')!;
    expect(path.textContent).toBe(project.fullPath);
    expect(path.dir).toBe('ltr');
    expect(path.tabIndex).toBe(0);
    // c4c8f8ce4 lets the complete path wrap instead of fixing one line.
    expect(path.style.height).toBe('');
    expect(path.style.overflowWrap).toBe('anywhere');
    expect(path.classList.contains('break-all')).toBe(true);
    expect(path.querySelectorAll('wbr').length).toBe(project.fullPath.split('/').length - 1);
    expect(Number.parseFloat(menu.style.top) + 6 * 28 + 12 + 28).toBeLessThanOrEqual(window.innerHeight - 10);
    expect(Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 10);
  });

  it('hides the project pin during bulk selection', () => {
    const onToggleBulkSelectedId = vi.fn();
    renderProject(vi.fn(), vi.fn(), {
      bulkSelectionKind: 'projects',
      bulkSelectedIds: new Set(),
      onToggleBulkSelectedId,
    });
    expect(screen.queryByRole('button', { name: 'Pin project: nassaj-dev' })).toBeNull();
    expect(onToggleBulkSelectedId).not.toHaveBeenCalled();
  });

  it('does not start bulk selection when holding the project pin on touch', () => {
    vi.useFakeTimers();
    try {
      const onStartBulkSelectionWithId = vi.fn();
      renderProject(vi.fn(), onStartBulkSelectionWithId);
      const pin = screen.getByRole('button', { name: 'Pin project: nassaj-dev' });
      const press = new Event('pointerdown', { bubbles: true });
      Object.defineProperty(press, 'pointerType', { value: 'touch' });
      fireEvent(pin.querySelector('svg')!, press);
      act(() => vi.advanceTimersByTime(600));
      expect(onStartBulkSelectionWithId).not.toHaveBeenCalled();
      expect(pin.closest('[data-project-card]')?.getAttribute('data-long-press-selection')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('يبدأ تحديد المشروع نفسه من أول بند في القائمة ويغلقها', () => {
    const onStartBulkSelectionWithId = vi.fn();
    renderProject(vi.fn(), onStartBulkSelectionWithId);

    fireEvent.click(screen.getByRole('button', { name: 'Project options: nassaj-dev' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select project' }));

    expect(onStartBulkSelectionWithId).toHaveBeenCalledWith('projects', 'project-1');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('يفتح القائمة من دون توسيع بطاقة المشروع', () => {
    const onToggleProject = vi.fn();
    renderProject(onToggleProject);

    const menu = screen.getByRole('button', { name: 'Project options: nassaj-dev' });
    expect(menu.closest('button button')).toBeNull();
    fireEvent.click(menu);

    expect(onToggleProject).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('سطح التوسيع زر مستقل يحمل حالته ولا يحتوي أزرار الأفعال', () => {
    const onToggleProject = vi.fn();
    const { container } = renderProject(onToggleProject);

    const expand = screen.getByRole('button', { name: 'Expand project: nassaj-dev' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(expand.getAttribute('aria-controls')).toBe('project-sessions-project-1');
    expect(expand.querySelector('button')).toBeNull();
    expect(container.querySelector('button button')).toBeNull();
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pin project: nassaj-dev' }).closest('[data-project-card]')).toBe(expand.parentElement);
    const endRail = container.querySelector('[data-project-end-rail]');
    expect(endRail?.classList.contains('flex')).toBe(true);
    expect(screen.getByRole('button', { name: 'Project options: nassaj-dev' }).parentElement).toBe(endRail);

    fireEvent.click(expand, { detail: 0 });
    expect(onToggleProject).toHaveBeenCalledWith('project-1');
  });

  it('يبدّل اختيار المشروع بنقرة واحدة على البطاقة أو مربع الاختيار في وضع التحديد', () => {
    const onToggleBulkSelectedId = vi.fn();
    const { container } = renderProject(vi.fn(), vi.fn(), {
      bulkSelectionKind: 'projects',
      bulkSelectedIds: new Set(),
      onToggleBulkSelectedId,
    });

    fireEvent.click(container.querySelector('[data-project-card]')!);
    expect(onToggleBulkSelectedId).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggleBulkSelectedId).toHaveBeenCalledTimes(2);
  });

  it('يحجز عمود التحديد في الوضع الجماعي فقط ويحافظ على ترتيب بقية المحتوى', () => {
    const normal = renderProject();
    const normalRow = normal.container.querySelector<HTMLElement>('[data-project-row-main]')!;
    const normalChildren = [...normalRow.children].map((child) => (child as HTMLElement).dataset.projectSelectionRail !== undefined ? 'selection' : (child as HTMLElement).dataset.projectEndRail !== undefined ? 'end' : 'content');
    expect(normal.container.querySelector('[data-project-selection-rail]')).toBeNull();

    normal.unmount();
    const bulk = renderProject(vi.fn(), vi.fn(), {
      bulkSelectionKind: 'projects',
      bulkSelectedIds: new Set(),
      onToggleBulkSelectedId: vi.fn(),
    });
    const bulkRow = bulk.container.querySelector<HTMLElement>('[data-project-row-main]')!;

    expect([...bulkRow.children].slice(1).map((child) => (child as HTMLElement).dataset.projectSelectionRail !== undefined ? 'selection' : (child as HTMLElement).dataset.projectEndRail !== undefined ? 'end' : 'content')).toEqual(normalChildren);
    expect(bulk.container.querySelector('[data-project-selection-rail] input')).toBeTruthy();
  });

  it('لا يبدّل المشروع بالنقر على البطاقة خارج وضع التحديد', () => {
    const onToggleBulkSelectedId = vi.fn();
    const { container } = renderProject(vi.fn(), vi.fn(), { onToggleBulkSelectedId });

    fireEvent.click(container.querySelector('[data-project-card]')!);
    expect(onToggleBulkSelectedId).not.toHaveBeenCalled();
  });
});
