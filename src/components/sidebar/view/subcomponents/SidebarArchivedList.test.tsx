import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ArchivedFolder } from '../../utils/archivedFolders';

import SidebarArchivedList, { type SidebarArchivedListProps } from './SidebarArchivedList';

afterEach(cleanup);

const t = ((key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key)) as unknown as TFunction;

const session = (sessionId: string, isSessionArchived: boolean, projectId: string) => ({
  sessionId,
  provider: 'claude' as const,
  projectId,
  projectPath: `/work/${projectId}`,
  projectDisplayName: projectId,
  sessionTitle: `Chat ${sessionId}`,
  createdAt: null,
  updatedAt: null,
  lastActivity: null,
  isProjectArchived: !isSessionArchived,
  isSessionArchived,
});

const folders: ArchivedFolder[] = [
  { key: 'arch', projectId: 'arch', displayName: 'Archived proj', projectPath: '/work/arch', isProjectArchived: true, sessions: [session('a1', false, 'arch')], latestActivity: null },
  { key: 'live', projectId: 'live', displayName: 'Live proj', projectPath: '/work/live', isProjectArchived: false, sessions: [session('l1', true, 'live')], latestActivity: null },
];

function renderList(overrides: Partial<SidebarArchivedListProps> = {}) {
  const props: SidebarArchivedListProps = {
    folders,
    expandByDefault: false,
    bulkSelectionKind: null,
    bulkSelectedIds: new Set(),
    onToggleBulkId: vi.fn(),
    onRestoreArchivedProject: vi.fn(),
    onArchivedSessionClick: vi.fn(),
    onRestoreArchivedSession: vi.fn(),
    onDeleteArchivedSession: vi.fn(),
    t,
    ...overrides,
  };
  render(<SidebarArchivedList {...props} />);
  return props;
}

describe('SidebarArchivedList', () => {
  it('renders collapsible project folders and expands on toggle', () => {
    renderList();
    const toggle = screen.getByRole('button', { name: 'Expand project: Live proj' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Chat l1')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse project: Live proj' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Chat l1')).toBeTruthy();
  });

  it('marks only archived projects with the theme warning tint', () => {
    renderList();
    const archived = document.querySelector('[data-archived-folder="project"] [data-project-card]');
    const live = document.querySelector('[data-archived-folder="sessions"] [data-project-card]');
    expect(archived?.className).toContain('bg-warning/');
    expect(live?.className).not.toContain('warning');
  });

  it('wires restore project, open, restore session and delete actions', () => {
    const props = renderList({ expandByDefault: true });
    fireEvent.click(screen.getByRole('button', { name: 'Restore workspace: Archived proj' }));
    expect(props.onRestoreArchivedProject).toHaveBeenCalledWith('arch');
    fireEvent.click(screen.getByText('Chat a1'));
    expect(props.onArchivedSessionClick).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'a1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore session: Chat l1' }));
    expect(props.onRestoreArchivedSession).toHaveBeenCalledWith('l1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently: Chat l1' }));
    expect(props.onDeleteArchivedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'l1' }));
    // Sessions inside an archived project are restored with the project.
    expect(screen.queryByRole('button', { name: 'Restore session: Chat a1' })).toBeNull();
  });

  it('offers project checkboxes only for archived projects in bulk mode', () => {
    const props = renderList({ bulkSelectionKind: 'projects' });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(1);
    fireEvent.click(boxes[0]);
    expect(props.onToggleBulkId).toHaveBeenCalledWith('arch');
  });
});
