/**
 * رابط المشروع (T-1950): الأيقونة تظهر لِـhttp(s) فقط، لا تفتح/تطوي الصفّ عند
 * النقر عليها، وبند القائمة يتبدّل نصّه إضافة/تعديل مع تدفّق حفظ/إلغاء وخطأ.
 */
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { setProjectLink } = vi.hoisted(() => ({ setProjectLink: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar', dir: () => 'rtl' } }),
}));

vi.mock('../../../../contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ isMultiUser: false }),
}));

vi.mock('../../../participants', () => ({
  ProjectParticipantsSummary: () => null,
}));

vi.mock('../../../../utils/api', () => ({ api: { setProjectLink } }));

const SidebarProjectItem = (await import('./SidebarProjectItem')).default;

const t = ((key: string, opts?: { defaultValue?: string; name?: string }) => {
  const value = opts?.defaultValue ?? key;
  return opts?.name ? value.replace('{{name}}', opts.name) : value;
}) as unknown as TFunction;

const baseProject = {
  projectId: 'project-1',
  displayName: 'nassaj-dev',
  fullPath: '/workspace/sample-project',
  sessionMeta: { total: 2 },
};

function renderProject(linkUrl: string | null = null) {
  return render(
    <SidebarProjectItem
      project={{ ...baseProject, linkUrl }}
      selectedProject={null}
      selectedSession={null}
      isExpanded={false}
      isDeleting={false}
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
      onToggleProject={vi.fn()}
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

function openLinkEditor() {
  fireEvent.click(screen.getByRole('button', { name: 'Project options: nassaj-dev' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /link/i }));
}

afterEach(() => {
  cleanup();
  setProjectLink.mockReset();
});

describe('SidebarProjectItem — رابط المشروع', () => {
  it('يعرض أيقونة الرابط لعنوان http(s) صالح فقط', () => {
    renderProject('https://example.com/repo');
    expect(screen.getByRole('link', { name: /Open project link/i })).toBeTruthy();

    cleanup();
    renderProject('javascript:alert(1)');
    expect(screen.queryByRole('link', { name: /Open project link/i })).toBeNull();

    cleanup();
    renderProject(null);
    expect(screen.queryByRole('link', { name: /Open project link/i })).toBeNull();
  });

  it('لا يُشغّل تحديد/طيّ المشروع عند النقر على أيقونة الرابط', () => {
    const onToggleProject = vi.fn();
    render(
      <SidebarProjectItem
        project={{ ...baseProject, linkUrl: 'https://example.com' }}
        selectedProject={null}
        selectedSession={null}
        isExpanded={false}
        isDeleting={false}
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
    fireEvent.click(screen.getByRole('link', { name: /Open project link/i }));
    expect(onToggleProject).not.toHaveBeenCalled();
  });

  it('يتبدّل نصّ بند القائمة بين إضافة وتعديل تبعاً لوجود رابط', () => {
    renderProject(null);
    fireEvent.click(screen.getByRole('button', { name: 'Project options: nassaj-dev' }));
    expect(screen.getByRole('menuitem', { name: 'Add link…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit link…' })).toBeNull();

    cleanup();
    renderProject('https://example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Project options: nassaj-dev' }));
    expect(screen.getByRole('menuitem', { name: 'Edit link…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Add link…' })).toBeNull();
  });

  it('Enter يحفظ الرابط الصالح وEsc يلغي التحرير دون حفظ', async () => {
    setProjectLink.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { linkUrl: 'https://example.com/' } }),
    });
    renderProject(null);
    openLinkEditor();

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'example.com' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(setProjectLink).toHaveBeenCalledWith('project-1', 'https://example.com');

    cleanup();
    renderProject(null);
    openLinkEditor();
    const cancelInput = screen.getByRole('textbox');
    fireEvent.change(cancelInput, { target: { value: 'example.com' } });
    fireEvent.keyDown(cancelInput, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(setProjectLink).toHaveBeenCalledTimes(1);
  });

  it('يضيف https:// تلقائياً لعنوان مضيف:منفذ مثل localhost:3000', async () => {
    setProjectLink.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { linkUrl: 'https://localhost:3000/' } }),
    });
    renderProject(null);
    openLinkEditor();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'localhost:3000' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(setProjectLink).toHaveBeenCalledWith('project-1', 'https://localhost:3000');
  });

  it('يعرض خطأً عند رابط غير صالح دون استدعاء الخادم', () => {
    renderProject(null);
    openLinkEditor();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(setProjectLink).not.toHaveBeenCalled();
  });

  it('يعرض خطأ الحفظ الفاشل ويبقي وضع التحرير مفتوحاً', async () => {
    setProjectLink.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    renderProject(null);
    openLinkEditor();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
