/**
 * qa #3: "إضافة عضو" must only render when the project payload or the
 * caller's platform role already implies access — otherwise most projects
 * (no recorded creator) 404 the members endpoint for nothing.
 */
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

let mockAuth: { isMultiUser: boolean; user?: { id?: number; role?: string } } = { isMultiUser: true };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'ar', dir: () => 'rtl' },
  }),
}));

vi.mock('../../../../contexts/AuthContext', () => ({
  useOptionalAuth: () => mockAuth,
}));

const manageMembersSpy = vi.fn();
vi.mock('../../../participants', () => ({
  ProjectParticipantsSummary: () => null,
  ManageProjectMembersButton: (props: unknown) => {
    manageMembersSpy(props);
    return null;
  },
}));

const SidebarProjectItem = (await import('./SidebarProjectItem')).default;

const t = ((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key) as unknown as TFunction;

function renderExpanded(project: Record<string, unknown>) {
  return render(
    <SidebarProjectItem
      project={project as any}
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
      currentTime={new Date('2026-09-23T12:00:00.000Z')}
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

const baseProject = {
  projectId: 'project-manage-members',
  displayName: 'test-project',
  fullPath: '/workspace/test-project',
  sessionMeta: { total: 1 },
};

afterEach(() => {
  cleanup();
  manageMembersSpy.mockClear();
  mockAuth = { isMultiUser: true };
});

describe('SidebarProjectItem — بوابة "إضافة عضو" (qa #3, qa م8)', () => {
  it('لا يُصيّر الزرّ حين canAccess غائب', () => {
    mockAuth = { isMultiUser: true, user: { id: 42, role: 'user' } };
    renderExpanded(baseProject);
    expect(manageMembersSpy).not.toHaveBeenCalled();
  });

  it('لا يُصيّر الزرّ حين canAccess صريح بالخطأ', () => {
    mockAuth = { isMultiUser: true, user: { id: 42, role: 'user' } };
    renderExpanded({ ...baseProject, canAccess: false });
    expect(manageMembersSpy).not.toHaveBeenCalled();
  });

  it('لا يكفي isMember/isOwner/ownerId وحدها بلا canAccess (قوالب عرض فقط)', () => {
    mockAuth = { isMultiUser: true, user: { id: 7, role: 'user' } };
    renderExpanded({ ...baseProject, isMember: true, isOwner: true, ownerId: 7 });
    expect(manageMembersSpy).not.toHaveBeenCalled();
  });

  it('يُصيّر الزرّ حين project.canAccess صحيح', () => {
    mockAuth = { isMultiUser: true, user: { id: 42, role: 'user' } };
    renderExpanded({ ...baseProject, canAccess: true });
    expect(manageMembersSpy).toHaveBeenCalled();
  });

  it('لا يكفي دور منصّة admin وحده بلا canAccess', () => {
    mockAuth = { isMultiUser: true, user: { id: 42, role: 'admin' } };
    renderExpanded(baseProject);
    expect(manageMembersSpy).not.toHaveBeenCalled();
  });
});
