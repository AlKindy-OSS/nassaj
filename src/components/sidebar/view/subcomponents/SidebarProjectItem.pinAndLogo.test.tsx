/**
 * علامة التثبيت زرٌّ حقيقي، والشعار يُعرض حين وُجد (‏T-1402 / T-1403).
 *
 * الحادثة التي تحرسها هذه الاختبارات: النجمة السابقة كانت مؤشّراً مرسوماً لا
 * زرّاً، فحاول المالك النقر عليها فلم يحدث شيء — وهو سلوكٌ يقرأ «معطّل» لا
 * «للعرض فقط». فالتثبيت الآن يُبدَّل بالنقر، ومن دون أن يوسّع البطاقة (نفس فخّ
 * زرّ ⋮ الذي كان يحرسه الاختبار المجاور).
 */
import { cloneElement, type ComponentProps } from 'react';
import type { TFunction } from 'i18next';
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

const baseProject = {
  projectId: 'project-1',
  displayName: 'nassaj-dev',
  fullPath: '/workspace/sample-project',
  sessionMeta: { total: 2 },
};

function renderProject(
  overrides: {
    isStarred?: boolean;
    isExpanded?: boolean;
    isSelected?: boolean;
    activeProjectTool?: ComponentProps<typeof SidebarProjectItem>['activeProjectTool'];
    onOpenProjectTool?: ComponentProps<typeof SidebarProjectItem>['onOpenProjectTool'];
    onProjectToolbarPresence?: (id: string | null) => void;
    editingProject?: string;
    onSaveProjectName?: () => void;
    onCancelEditingProject?: () => void;
    logoUrl?: string | null;
    onToggleProject?: () => void;
    onToggleStarProject?: (projectId: string) => void;
  } = {},
) {
  const {
    isStarred = false,
    logoUrl = null,
    onToggleProject = vi.fn(),
    onToggleStarProject = vi.fn(),
  } = overrides;

  const element = (
    <SidebarProjectItem
      project={{ ...baseProject, logoUrl }}
      selectedProject={overrides.isSelected ? baseProject : null}
      activeProjectTool={overrides.activeProjectTool}
      onOpenProjectTool={overrides.onOpenProjectTool}
      onProjectToolbarPresence={overrides.onProjectToolbarPresence}
      selectedSession={null}
      isExpanded={overrides.isExpanded ?? false}
      isDeleting={false}
      isStarred={isStarred}
      isSessionStarred={() => false}
      onToggleStarSession={() => {}}
      editingProject={overrides.editingProject ?? null}
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
      onToggleStarProject={onToggleStarProject}
      onStartEditingProject={() => {}}
      onCancelEditingProject={overrides.onCancelEditingProject ?? (() => {})}
      onSaveProjectName={overrides.onSaveProjectName ?? (() => {})}
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
    />
  );

  const renderResult = render(element);
  const rerenderExpanded = (isExpanded: boolean) => renderResult.rerender(cloneElement(element, { isExpanded }));
  return { ...renderResult, onToggleProject, onToggleStarProject, rerenderExpanded };
}

afterEach(cleanup);

describe('SidebarProjectItem — التثبيت والشعار', () => {
  it('registers only the selected expanded toolbar and releases it when collapsed or removed', () => {
    const presence = vi.fn();
    const open = vi.fn();
    const row = renderProject({ isExpanded: true, isSelected: true, activeProjectTool: 'git', onOpenProjectTool: open, onProjectToolbarPresence: presence });
    expect(presence).toHaveBeenLastCalledWith('project-1');
    const buttons = Array.from(row.container.querySelectorAll<HTMLButtonElement>('[data-project-tool]'));
    expect(buttons.map(button => button.dataset.projectTool)).toEqual(['board', 'git', 'files']);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(buttons[2]);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1' }), 'files');
    row.rerenderExpanded(false);
    expect(presence).toHaveBeenLastCalledWith(null);
    row.rerenderExpanded(true);
    expect(presence).toHaveBeenLastCalledWith('project-1');
    row.unmount();
    expect(presence).toHaveBeenLastCalledWith(null);
    presence.mockClear();
    const other = renderProject({ isExpanded: true, onOpenProjectTool: open, onProjectToolbarPresence: presence });
    expect(presence).not.toHaveBeenCalled();
    expect(other.container.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it('ينقر على علامة التثبيت فيبدّل الحالة بلا توسيع البطاقة', () => {
    const { onToggleProject, onToggleStarProject } = renderProject();

    fireEvent.click(screen.getByRole('button', { name: 'Pin project: nassaj-dev' }));

    expect(onToggleStarProject).toHaveBeenCalledWith('project-1');
    expect(onToggleProject).not.toHaveBeenCalled();
  });

  it('يعرض «إلغاء التثبيت» للمشروع المثبَّت', () => {
    const { onToggleStarProject } = renderProject({ isStarred: true });

    const pinButton = screen.getByRole('button', { name: 'Unpin project: nassaj-dev' });
    const pinIcon = pinButton.querySelector('svg');

    expect(pinButton.classList.contains('h-7')).toBe(true);
    expect(pinButton.classList.contains('w-6')).toBe(true);
    expect(pinButton.closest('[data-project-pin-slot]')).not.toBeNull();
    expect(pinButton.closest('button button')).toBeNull();
    expect(pinButton.classList.contains('text-[color:var(--project-accent,hsl(var(--primary)))]')).toBe(true);
    expect([...pinButton.classList].some((name) => name === 'border' || name.startsWith('border-'))).toBe(false);
    expect([...pinButton.classList].some((name) => name.startsWith('bg-'))).toBe(false);
    expect(pinButton.classList.contains('hover:text-[color:var(--project-accent,hsl(var(--primary)/0.8))]')).toBe(true);
    expect(pinButton.classList.contains('opacity-0')).toBe(false);
    expect(document.querySelector('[data-project-pin-ghost]')).toBeNull();
    expect(pinButton.classList.contains('transition-colors')).toBe(true);
    expect(pinButton.classList.contains('hover:bg-accent')).toBe(false);
    expect(pinIcon?.classList.contains('h-3.5')).toBe(true);
    expect(pinIcon?.classList.contains('w-3.5')).toBe(true);
    expect(pinIcon?.classList.contains('-translate-y-px')).toBe(false);
    expect(pinIcon?.classList.contains('rotate-[35deg]')).toBe(false);
    expect(pinIcon?.classList.contains('fill-current')).toBe(true);
    expect(pinIcon?.classList.contains('fill-none')).toBe(false);
    expect(pinIcon?.getAttribute('stroke-width')).toBe('0');

    fireEvent.click(pinButton);

    expect(onToggleStarProject).toHaveBeenCalledWith('project-1');
  });

  it('يبقي زر التثبيت ظاهراً في مساحته على اللمس والفأرة', () => {
    renderProject();
    const pin = screen.getByRole('button', { name: 'Pin project: nassaj-dev' });
    expect(pin.closest('[data-project-pin-slot]')).not.toBeNull();
    expect(pin.classList.contains('pointer-events-auto')).toBe(true);
    expect(pin.classList.contains('opacity-0')).toBe(false);
    expect(pin.classList.contains('absolute')).toBe(false);
    expect(pin.classList.contains('text-muted-foreground/25')).toBe(true);
    expect(pin.classList.contains('hover:text-muted-foreground/60')).toBe(true);
    expect(pin.querySelector('svg')?.classList.contains('fill-current')).toBe(true);
    expect(pin.querySelector('svg')?.getAttribute('stroke-width')).toBe('0');
    expect(document.querySelector('[data-project-pin-ghost]')).toBeNull();
  });

  it('تطابق أيقونة قائمة المشروع فعل التثبيت أو إلغاءه', () => {
    renderProject();
    fireEvent.click(screen.getByRole('button', { name: 'Project options: nassaj-dev' }));
    expect(
      screen
        .getByRole('menuitem', { name: 'Pin project: nassaj-dev' })
        .querySelector('svg')
        ?.classList.contains('lucide-pin'),
    ).toBe(true);

    cleanup();
    renderProject({ isStarred: true });
    fireEvent.click(screen.getByRole('button', { name: 'Project options: nassaj-dev' }));
    expect(
      screen
        .getByRole('menuitem', { name: 'Unpin project: nassaj-dev' })
        .querySelector('svg')
        ?.classList.contains('lucide-pin-off'),
    ).toBe(true);
  });

  it('لا يغيّر لون أو خلفية صف المشروع عند التثبيت', () => {
    const { container } = renderProject({ isStarred: true });
    const row = container.querySelector('[aria-controls="project-sessions-project-1"]');

    expect(row?.classList.contains('bg-amber-50/50')).toBe(false);
    expect(row?.classList.contains('border-amber-200/30')).toBe(false);
  });

  it('يرسم شعار المشروع حين وُجد، ولا يرسم مربّعاً فارغاً حين لا شعار', () => {
    renderProject({ logoUrl: '/project-logos/project-1.png?v=7' });
    const logo = document.querySelector('img[src="/project-logos/project-1.png?v=7"]');
    expect(logo).toBeTruthy();

    cleanup();
    renderProject({ logoUrl: null });
    expect(document.querySelector('img[src^="/project-logos/"]')).toBeNull();
  });

  it('يعرض Tooltip مخصَّصاً بالاسم والمسار عند التحويم على الاسم والشعار، ويبقي النقر مبدِّلاً للتوسيع', () => {
    vi.useFakeTimers();
    try {
      const { onToggleProject } = renderProject({ logoUrl: '/project-logos/project-1.png?v=7' });
      const nameText = screen.getByText('nassaj-dev');
      const nameTrigger = nameText.parentElement!;
      // لا title أصليّاً على المُشغِّل حتى لا تظهر فقاعتان معاً (b449ad002).
      expect(nameTrigger.getAttribute('title')).toBeNull();
      // نسخة واحدة من المسار موجودة دوماً (span مخفيّ لقارئ الشاشة عبر aria-describedby).
      expect(screen.getAllByText('/workspace/sample-project')).toHaveLength(1);

      fireEvent.mouseEnter(nameTrigger);
      act(() => vi.advanceTimersByTime(400));
      // نسخة ثانية ظهرت: محتوى الـTooltip المخصَّص.
      expect(screen.getAllByText('/workspace/sample-project')).toHaveLength(2);

      fireEvent.click(nameText);
      expect(onToggleProject).toHaveBeenCalledWith('project-1');

      fireEvent.mouseLeave(nameTrigger);
      act(() => vi.advanceTimersByTime(50));

      const logo = document.querySelector('img[src="/project-logos/project-1.png?v=7"]')!;
      expect(logo.getAttribute('title')).toBeNull();
      fireEvent.mouseEnter(logo.parentElement!);
      act(() => vi.advanceTimersByTime(400));
      expect(screen.getAllByText('/workspace/sample-project')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('يضع بندَي الشعار في القائمة، وبند الإزالة للمشروع صاحب الشعار وحده', () => {
    renderProject({ logoUrl: null });
    fireEvent.click(screen.getByRole('button', { name: 'Project options: nassaj-dev' }));
    expect(screen.getByRole('menuitem', { name: 'Change project logo' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Remove logo' })).toBeNull();

    cleanup();
    renderProject({ logoUrl: '/project-logos/project-1.svg?v=9' });
    fireEvent.click(screen.getByRole('button', { name: 'Project options: nassaj-dev' }));
    expect(screen.getByRole('menuitem', { name: 'Remove logo' })).toBeTruthy();
  });
});

it('project rename keeps IME Enter local and exposes neutral save/cancel actions', () => {
  const save = vi.fn(); const cancel = vi.fn(); const toggle = vi.fn();
  renderProject({ editingProject: 'project-1', onSaveProjectName: save, onCancelEditingProject: cancel, onToggleProject: toggle });
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(save).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(toggle).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'tooltips.save' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'tooltips.cancel' })).toBeTruthy();
});
