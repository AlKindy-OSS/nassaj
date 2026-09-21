/**
 * B-1088: الملخّص النصّي للمشاركين لا يُعرض في تنصيب الحساب الواحد.
 *
 * الحارسة: حين isMultiUser=false تحجب SidebarProjectItem مكوّن
 * ProjectParticipantsSummary كلياً، فلا نصّ «Participants i…» مقتطع
 * يظهر في شريط الأدوات بجوار «+ New Session».
 * وحين isMultiUser=true يُعرض المكوّن كما كان دائماً.
 */
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// --- إعداد isMultiUser متغيّراً بين الاختبارات ---
let mockIsMultiUser = false;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'ar', dir: () => 'rtl' },
  }),
}));

vi.mock('../../../../contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ isMultiUser: mockIsMultiUser }),
}));

// نسجّل كلّ استدعاء للمكوّن لنتحقّق لاحقاً
const participantsSpy = vi.fn();
vi.mock('../../../participants', () => ({
  ProjectParticipantsSummary: (props: unknown) => {
    participantsSpy(props);
    return null;
  },
}));

const SidebarProjectItem = (await import('./SidebarProjectItem')).default;

const t = ((key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key) as unknown as TFunction;

const baseProject = {
  projectId: 'project-participants-b1088',
  displayName: 'test-project',
  fullPath: '/workspace/test-project',
  sessionMeta: { total: 1 },
};

function renderExpanded() {
  return render(
    <SidebarProjectItem
      project={baseProject}
      selectedProject={null}
      activeProjectTool={undefined}
      onOpenProjectTool={undefined}
      onProjectToolbarPresence={undefined}
      selectedSession={null}
      isExpanded
      isDeleting={false}
      isStarred={false}
      isSessionStarred={() => false}
      onToggleStarSession={() => {}}
      editingProject={null}
      editingName=""
      sessions={[]}
      initialSessionsLoaded
      isLoadingMoreSessions={false}
      currentTime={new Date('2026-09-11T12:00:00.000Z')}
      editingSession={null}
      editingSessionName=""
      onEditingNameChange={() => {}}
      onToggleProject={() => {}}
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

afterEach(() => {
  cleanup();
  participantsSpy.mockClear();
});

describe('SidebarProjectItem — عرض ملخّص المشاركين (B-1088)', () => {
  it('لا يُصيّر ProjectParticipantsSummary في تنصيب الحساب الواحد', () => {
    mockIsMultiUser = false;
    renderExpanded();
    expect(participantsSpy).not.toHaveBeenCalled();
  });

  it('يُصيّر ProjectParticipantsSummary في تنصيب متعدّد المستخدمين', () => {
    mockIsMultiUser = true;
    renderExpanded();
    expect(participantsSpy).toHaveBeenCalled();
  });
});
