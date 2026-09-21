import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import SidebarContent from './SidebarContent';

const authRole = vi.hoisted(() => ({ value: 'owner' }));
vi.mock('../../../auth', () => ({ useAuth: () => ({ user: { role: authRole.value } }) }));
vi.mock('../../../presence/PresencePanel', () => ({ default: ({ trailing }: { trailing: React.ReactNode }) => <div data-presence-panel>{trailing}</div> }));
vi.mock('./SidebarHeader', () => ({ default: () => <div data-sidebar-header /> }));
vi.mock('./SidebarSearchScopeMenu', () => ({ default: () => null }));
vi.mock('./SidebarProjectList', () => ({ default: () => <div data-project-list /> }));
vi.mock('./SidebarFooter', () => ({ default: () => <div data-sidebar-footer /> }));
vi.mock('./SidebarClosedFilterToggle', () => ({ default: () => null }));
vi.mock('./SidebarArchiveToggle', () => ({ default: () => <button aria-label="Archive" /> }));

const t = ((key: string) => key) as unknown as TFunction;

function props(showSidebarSearch: boolean): React.ComponentProps<typeof SidebarContent> {
  return {
    isLoading: false,
    projects: [{ projectId: 'p1', displayName: 'Alpha', fullPath: '/alpha' }],
    archivedProjects: [],
    archivedSessions: [],
    archivedSessionsCount: 0,
    isArchivedSessionsLoading: false,
    searchFilter: '',
    onSearchFilterChange: vi.fn(),
    onClearSearchFilter: vi.fn(),
    showSidebarSearch,
    searchMode: 'projects',
    onSearchModeChange: vi.fn(),
    searchScope: 'all',
    onSearchScopeChange: vi.fn(),
    hideClosedSessions: false,
    onHideClosedSessionsChange: vi.fn(),
    isMessageSearching: false,
    activeSection: 'projects',
    onSectionChange: vi.fn(),
    terminals: { items: [], isLoading: false, error: null, selectedTerminalId: null, createError: null, onSelect: vi.fn(), onCreate: vi.fn(), onDelete: vi.fn(), onDismissCreateError: vi.fn() },
    onRestoreArchivedProject: vi.fn(),
    onArchivedSessionClick: vi.fn(),
    onRestoreArchivedSession: vi.fn(),
    onDeleteArchivedSession: vi.fn(),
    onCreateProject: vi.fn(),
    onCollapseSidebar: vi.fn(),
    onProjectSelect: vi.fn(),
    updateAvailable: false,
    restartRequired: false,
    actions: [],
    loading: false,
    execute: vi.fn(),
    dismiss: vi.fn(),
    releaseInfo: null,
    latestVersion: null,
    currentVersion: '1.0.0',
    onShowVersionModal: vi.fn(),
    onShowSettings: vi.fn(),
    scheduledMessagesCount: 0,
    scheduledMessagesEnabled: true,
    scheduledMessagesActive: false,
    onOpenScheduledMessages: vi.fn(),
    projectListProps: {
      filteredProjects: [],
      expandedProjects: new Set(),
      getProjectSessions: () => [],
    } as unknown as React.ComponentProps<typeof SidebarContent>['projectListProps'],
    bulkSelectionKind: null,
    bulkSelectedIds: new Set(),
    isBulkMutating: false,
    bulkLifecycleActions: false,
    onBulkSelectionKindChange: vi.fn(),
    onSelectVisibleBulkIds: vi.fn(),
    onClearBulkSelection: vi.fn(),
    onRunBulkAction: vi.fn(),
    onExitBulkSelection: vi.fn(),
    t,
  };
}

describe('SidebarContent top-rail layout', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    authRole.value = 'owner';
  });

  it.each(['rtl', 'ltr'])('moves exactly one create trigger beside archive (%s)', (dir) => {
    const initial = props(false);
    const { container, rerender } = render(<div dir={dir}><SidebarContent {...initial} /></div>);
    const check = (home: string, hasArchive = true) => {
      const buttons = screen.getAllByRole('button', { name: 'tooltips.createProject' });
      expect(buttons).toHaveLength(1);
      expect(buttons[0].closest(home)).not.toBeNull();
      if (hasArchive) expect(buttons[0].nextElementSibling?.getAttribute('aria-label')).toBe('Archive');
      vi.mocked(initial.onCreateProject).mockClear();
      fireEvent.click(buttons[0]);
      expect(initial.onCreateProject).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-sidebar-header]')?.contains(buttons[0])).toBe(false);
    };
    check('[data-presence-panel]');
    rerender(<div dir={dir}><SidebarContent {...initial} showSidebarSearch /></div>);
    check('[data-sidebar-search-row]');
    rerender(<div dir={dir}><SidebarContent {...initial} projects={[]} /></div>);
    check('[data-presence-panel]', false);
    rerender(<div dir={dir}><SidebarContent {...initial} activeSection="terminals" /></div>);
    check('[data-presence-panel]', false);
  });

  it('keeps one bounded scroll viewport with one stable scrollbar gutter in both selection modes', () => {
    const normalProps = props(true);
    const { container, rerender } = render(<SidebarContent {...normalProps} />);
    const scrollArea = container.querySelector('[data-sidebar-scroll-area]')!;
    const normalClasses = scrollArea.className;
    expect(scrollArea.classList.contains('min-h-0')).toBe(true);
    expect(scrollArea.classList.contains('overflow-y-auto')).toBe(false);
    expect(scrollArea.classList.contains('[&>div]:[scrollbar-gutter:stable]')).toBe(true);
    expect(scrollArea.classList.contains('[&>div]:overflow-x-hidden')).toBe(true);
    rerender(<SidebarContent {...normalProps} bulkSelectionKind="sessions" />);
    expect(container.querySelector('[data-sidebar-scroll-area]')!.className).toBe(normalClasses);
  });

  it('measures native gutter changes and reconnects after switching sections', () => {
    const measureCallbacks: Array<() => void> = [];
    const observers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal('ResizeObserver', class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: () => void) {
        measureCallbacks.push(callback);
        observers.push(this);
      }
    });
    const initialProps = props(true);
    const { container, rerender, unmount } = render(<SidebarContent {...initialProps} />);
    const viewport = container.querySelector<HTMLElement>('[data-sidebar-scroll-area] > div')!;
    Object.defineProperty(viewport, 'offsetWidth', { value: 288, configurable: true });
    for (const gutter of [4, 10, 0]) {
      Object.defineProperty(viewport, 'clientWidth', { value: 288 - gutter, configurable: true });
      measureCallbacks[0]();
      expect(viewport.style.getPropertyValue('--sidebar-scrollbar-width')).toBe(`${gutter}px`);
    }
    rerender(<SidebarContent {...initialProps} activeSection="terminals" />);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    rerender(<SidebarContent {...initialProps} />);
    expect(observers).toHaveLength(2);
    expect(container.querySelector('[data-sidebar-scroll-area]')).not.toBeNull();
    unmount();
    expect(observers[1].disconnect).toHaveBeenCalledOnce();
  });

  it('places visible search after presence and before project content', () => {
    const { container } = render(<SidebarContent {...props(true)} />);
    const header = container.querySelector('[data-sidebar-header]')!;
    const presence = container.querySelector('[data-presence-panel]')!;
    const search = container.querySelector('[data-sidebar-search-row]')!;
    const list = container.querySelector('[data-project-list]')!;

    expect(header.compareDocumentPosition(presence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(presence.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(search.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not reserve a search row when the preference is off', () => {
    const { container } = render(<SidebarContent {...props(false)} />);

    expect(container.querySelector('[data-sidebar-search-row]')).toBeNull();
    expect(container.querySelector('[data-presence-panel]')).toBeTruthy();
    expect(container.querySelector('[data-project-list]')).toBeTruthy();
  });

  it('shows permission-denied message for Terminals when user is not owner/admin', () => {
    authRole.value = 'member';
    const { container } = render(
      <SidebarContent {...props(false)} activeSection="terminals" />,
    );

    // Permission-denied state renders (useTranslation in test env returns the key).
    expect(container.querySelector('h3')?.textContent).toBe('permissionDenied.title');
    expect(container.querySelector('p.text-muted-foreground')?.textContent).toBe('permissionDenied.description');
    // Project list is not rendered in terminals section.
    expect(container.querySelector('[data-project-list]')).toBeNull();
    // Scroll area (project list) is not rendered.
    expect(container.querySelector('[data-sidebar-scroll-area]')).toBeNull();
  });

  it('shows the terminals section for owner/admin in the terminals tab', () => {
    authRole.value = 'owner';
    const { container } = render(
      <SidebarContent {...props(false)} activeSection="terminals" />,
    );

    // SidebarTerminalsSection renders; no permission-denied panel.
    expect(container.querySelector('[data-presence-panel]')).toBeTruthy();
    expect(container.querySelector('[data-sidebar-scroll-area]')).toBeNull();
    // No permission-denied heading visible.
    const headings = Array.from(container.querySelectorAll('h3'));
    expect(headings.every((h) => !h.textContent?.includes('permissionDenied'))).toBe(true);
  });
});
