/**
 * Owner decision (2026-09-30): the project toolbar reads, in visual
 * left→right order, [folder] [git] [Project Board] [member avatar stack]
 * [add-member circle] [flexible gap] ["جلسة جديدة"]. Since the toolbar row is
 * `dir="rtl"`, that visual order is the *reverse* of DOM order — so in DOM
 * order the add-member circle comes first, then the avatar stack, then the
 * board tool. This guards that DOM order directly, so a future reshuffle of
 * the toolbar trips a test instead of only a screenshot.
 */
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'ar', dir: () => 'rtl' },
  }),
}));

vi.mock('../../../../contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ isMultiUser: true, user: { id: 42, role: 'user' } }),
}));

// Stand-ins carrying recognizable test ids — the real ProjectParticipantsSummary
// and ManageProjectMembersButton pull in network-backed hooks unrelated to
// this ordering guarantee.
vi.mock('../../../participants', () => ({
  ProjectParticipantsSummary: () => <span data-testid="avatar-stack-stub" />,
  ManageProjectMembersButton: () => <button type="button" data-testid="add-member-stub">+</button>,
}));

const SidebarProjectItem = (await import('./SidebarProjectItem')).default;

const t = ((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key) as unknown as TFunction;

const baseProject = {
  projectId: 'project-toolbar-order',
  displayName: 'test-project',
  fullPath: '/workspace/test-project',
  sessionMeta: { total: 1 },
  canAccess: true,
};

function renderExpanded() {
  return render(
    <SidebarProjectItem
      project={baseProject}
      selectedProject={null}
      activeProjectTool={undefined}
      onOpenProjectTool={() => {}}
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
      currentTime={new Date('2026-09-29T12:00:00.000Z')}
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

afterEach(() => cleanup());

describe('SidebarProjectItem — ترتيب شريط أدوات المشروع', () => {
  it('زرّ الإضافة ثم صفّ الوجوه ثم لوحة المشروع، بترتيب DOM واحد (معكوس بصرياً بفعل RTL)', () => {
    renderExpanded();
    const board = document.querySelector('[data-project-tool="board"]');
    const avatarStack = screen.getByTestId('avatar-stack-stub');
    const addButton = screen.getByTestId('add-member-stub');
    expect(board).not.toBeNull();

    // DOM_POSITION_FOLLOWING: each element is a later sibling than the last,
    // regardless of the `dir="rtl"` strip's visual left/right flip.
    // eslint-disable-next-line no-bitwise
    expect(addButton.compareDocumentPosition(avatarStack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // eslint-disable-next-line no-bitwise
    expect(avatarStack.compareDocumentPosition(board!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('صفّ الوجوه يعقب زرّ الإضافة داخل الحاوية نفسها المتراكبة (-ms-2)', () => {
    renderExpanded();
    const avatarStack = screen.getByTestId('avatar-stack-stub');
    expect(avatarStack.parentElement?.className).toContain('[&>*+*]:-ms-2');
  });
});
