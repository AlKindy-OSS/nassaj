import { useCallback, useRef } from 'react';
import { Archive, FolderPlus, TerminalSquare, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { ArchivedProjectListItem, ArchivedSessionListItem, SidebarSection, SidebarSearchMode, SidebarSearchScope, SidebarTerminalsProps } from '../../types/types';
import type { PublicAction, ExecuteOutcome, DismissOutcome, HistoryEntry } from '../../../../hooks/useServerActions';
import type { DegradedReason } from '../../../../hooks/useVersionCheck';
import type { BulkProjectAction, BulkSelectionKind, BulkSessionAction } from '../../hooks/useSidebarController';
import { useAuth } from '../../../auth';
import PresencePanel from '../../../presence/PresencePanel';
import { getAllSessions } from '../../utils/utils';
import { buildArchivedFolders } from '../../utils/archivedFolders';

import SidebarArchiveToggle from './SidebarArchiveToggle';
import SidebarArchivedList from './SidebarArchivedList';
import SidebarClosedFilterToggle from './SidebarClosedFilterToggle';
import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarSearchRow from './SidebarSearchRow';
import SidebarTerminalsSection from './SidebarTerminalsSection';
import SidebarBulkToolbar from './SidebarBulkToolbar';
import DegradedNotice from './DegradedNotice';

type SidebarContentProps = {
  isLoading: boolean;
  projects: Project[];
  archivedProjects: ArchivedProjectListItem[];
  archivedSessions: ArchivedSessionListItem[];
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  showSidebarSearch: boolean;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  searchScope: SidebarSearchScope;
  onSearchScopeChange: (scope: SidebarSearchScope) => void;
  hideClosedSessions: boolean;
  onHideClosedSessionsChange: (hideClosed: boolean) => void;
  isMessageSearching: boolean;
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
  terminals: SidebarTerminalsProps;
  onRestoreArchivedProject: (projectId: string) => void;
  onArchivedSessionClick: (session: ArchivedSessionListItem) => void;
  onRestoreArchivedSession: (sessionId: string) => void;
  onDeleteArchivedSession: (session: ArchivedSessionListItem) => void;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  /** Select a project — forwarded to PresencePanel's active-conversations menu. */
  onProjectSelect: (project: Project) => void;
  updateAvailable: boolean;
  /** B-1055: the update is staged/promoted and only its activation is owed. */
  updatePrepared?: boolean;
  /** ADR-207: the offered release is already prepared in the background. */
  prestageReady?: boolean;
  /** ADR-156 WI-6: null when healthy, otherwise the published reason code. */
  degradedReason?: DegradedReason | null;
  restartRequired: boolean;
  /** T-944 F1: pending server actions queue. */
  actions: PublicAction[];
  /** T-1684: settled operations, kept for one hour. */
  history?: readonly HistoryEntry[];
  loading: boolean;
  execute: (id: string) => Promise<ExecuteOutcome>;
  refreshActions?: () => Promise<void>;
  dismiss: (id: string) => Promise<DismissOutcome>;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  scheduledMessagesCount: number;
  scheduledMessagesEnabled: boolean;
  scheduledMessagesActive: boolean;
  onOpenScheduledMessages: () => void;
  projectListProps: SidebarProjectListProps;
  bulkSelectionKind: BulkSelectionKind | null;
  bulkSelectedIds: Set<string>;
  isBulkMutating: boolean;
  bulkLifecycleActions: boolean;
  onBulkSelectionKindChange: (kind: BulkSelectionKind) => void;
  onSelectVisibleBulkIds: (ids: string[]) => void;
  onClearBulkSelection: () => void;
  onRunBulkAction: (action: BulkProjectAction | BulkSessionAction) => void;
  onExitBulkSelection: () => void;
  t: TFunction;
};

export default function SidebarContent({
  isLoading,
  projects,
  archivedProjects,
  archivedSessions,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  showSidebarSearch,
  searchMode,
  onSearchModeChange,
  searchScope,
  onSearchScopeChange,
  hideClosedSessions,
  onHideClosedSessionsChange,
  isMessageSearching,
  activeSection,
  onSectionChange,
  terminals,
  onRestoreArchivedProject,
  onArchivedSessionClick,
  onRestoreArchivedSession,
  onDeleteArchivedSession,
  onCreateProject,
  onCollapseSidebar,
  onProjectSelect,
  updateAvailable,
  updatePrepared = false,
  prestageReady = false,
  degradedReason = null,
  restartRequired,
  actions,
  history,
  loading,
  execute,
  dismiss,
  refreshActions,
  releaseInfo,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  scheduledMessagesCount,
  scheduledMessagesEnabled,
  scheduledMessagesActive,
  onOpenScheduledMessages,
  projectListProps,
  bulkSelectionKind,
  bulkSelectedIds,
  isBulkMutating,
  bulkLifecycleActions,
  onBulkSelectionKindChange,
  onSelectVisibleBulkIds,
  onClearBulkSelection,
  onRunBulkAction,
  onExitBulkSelection,
  t,
}: SidebarContentProps) {
  const archivedFolders = buildArchivedFolders(archivedProjects, archivedSessions);
  const toggleBulkId = (id: string) => onSelectVisibleBulkIds(
    bulkSelectedIds.has(id) ? [...bulkSelectedIds].filter((selected) => selected !== id) : [...bulkSelectedIds, id],
  );
  // Measure each mounted viewport so native and overlay scrollbars keep balanced margins.
  const scrollbarObserver = useRef<ResizeObserver | null>(null);
  const bindScrollViewport = useCallback((viewport: HTMLDivElement | null) => {
    scrollbarObserver.current?.disconnect();
    scrollbarObserver.current = null;
    if (!viewport) return;
    const measureScrollbar = () => {
      const width = Math.max(0, viewport.offsetWidth - viewport.clientWidth);
      viewport.style.setProperty('--sidebar-scrollbar-width', `${width}px`);
    };
    measureScrollbar();
    if (typeof ResizeObserver === 'undefined') return;
    scrollbarObserver.current = new ResizeObserver(measureScrollbar);
    scrollbarObserver.current.observe(viewport);
  }, []);
  // Server boundary (ADR-063 amend) is enforced at REST + WS for owner/admin.
  // The tab is visible to every user; non-privileged users see a
  // permission-denied panel instead of the live list — no REST/WS calls fired.
  const { user } = useAuth();
  const { t: tTerminals } = useTranslation('terminals');
  const canUseTerminals = user?.role === 'owner' || user?.role === 'admin';
  const showTerminals = activeSection === 'terminals';

  // The archive toggle has exactly one home at a time (B-332): the search row
  // when that row is on screen, otherwise the presence strip. Mirrors the
  // condition below that renders the row, so the two can never both
  // show it — nor both hide it.
  const showSearchTools =
    (projects.length > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchRowVisible = activeSection === 'projects' && showSearchTools && showSidebarSearch;
  const archiveToggleInStrip = !showTerminals && !searchRowVisible && showSearchTools;

  // Keep creation reachable even when an empty list or Terminals hides search.
  const createProjectInStrip = !searchRowVisible;
  const createProjectControl = (
    <button
      type="button"
      className={`flex flex-shrink-0 items-center justify-center border border-transparent text-xs font-medium text-muted-foreground transition-all hover:bg-muted/60 hover:text-foreground ${createProjectInStrip ? 'h-6 w-6 rounded-lg' : 'h-8 w-8 rounded-xl'}`}
      onClick={onCreateProject}
      aria-label={t('tooltips.createProject')}
      title={t('tooltips.createProject')}
    >
      <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );

  // The hide-closed filter acts on the list independently of the query, so it
  // stays in the presence strip while archive and creation move with search.
  // A non-null trailing control keeps the strip visible even with nobody online.
  const closedFilterInStrip = !showTerminals && showSearchTools && searchMode !== 'archived';
  const visibleBulkIds = bulkSelectionKind === 'projects'
    ? searchMode === 'archived'
      ? archivedProjects.map((project) => project.projectId)
      : projectListProps.filteredProjects.map((project) => project.projectId)
    : bulkSelectionKind === 'sessions'
      ? searchMode === 'archived'
        ? [...archivedProjects.flatMap((project) => getAllSessions(project).map((session) => String(session.id))), ...archivedSessions.map((session) => session.sessionId)]
        : projectListProps.filteredProjects.flatMap((project) => projectListProps.expandedProjects.has(project.projectId) ? projectListProps.getProjectSessions(project).map((session) => session.id) : [])
      : [];

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col bg-background/80 backdrop-blur-sm md:w-72 md:select-none"
      data-app-chrome-surface
      style={{ backgroundColor: 'var(--app-chrome-surface, hsl(var(--background) / 0.8))' }}
    >
      <SidebarHeader
        activeSection={activeSection}
        onSectionChange={onSectionChange}
        runningTerminalsCount={terminals.items.filter((item) => item.status === 'running').length}
        onCollapseSidebar={onCollapseSidebar}
        scheduledMessagesCount={scheduledMessagesCount}
        scheduledMessagesEnabled={scheduledMessagesEnabled}
        scheduledMessagesActive={scheduledMessagesActive}
        onOpenScheduledMessages={onOpenScheduledMessages}
        t={t}
      />

      {/* ADR-156 WI-6: permanent while the node reports a degraded gate. */}
      <DegradedNotice reason={degradedReason} t={t} />

      {/* Live presence (C-MU-UX-PRESENCE): self-contained, renders nothing
          until the first `presence` snapshot arrives. `projects` is forwarded
          so the active-conversations tooltip can map running sessions to their
          project display names.
          Mounted ABOVE the section branch (B-332) so switching to Terminals and
          back no longer unmounts it — the server broadcasts presence on change
          only, so a remount used to leave the strip blank until some brother
          connected or disconnected. */}
      <PresencePanel
        compact={Boolean(bulkSelectionKind)}
        projects={projects}
        onProjectSelect={onProjectSelect}
        trailing={
          closedFilterInStrip || archiveToggleInStrip || createProjectInStrip || bulkSelectionKind ? (
            <>
              {bulkSelectionKind && (
                <div className="flex items-center gap-1" aria-live="polite">
                  <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                    {t('bulk.selectedCount', '{{count}} selected', { count: bulkSelectedIds.size })}
                  </span>
                  <button
                    type="button"
                    onClick={onExitBulkSelection}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border border-transparent text-xs font-medium text-muted-foreground transition-all hover:bg-muted/60 hover:text-foreground"
                    aria-label={t('bulk.exitSelection', 'Exit selection')}
                    title={t('bulk.exitSelection', 'Exit selection')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {closedFilterInStrip && (
                <SidebarClosedFilterToggle
                  hideClosed={hideClosedSessions}
                  onHideClosedChange={onHideClosedSessionsChange}
                  sizeClass="h-6 w-6 rounded-lg"
                  iconClass="h-3.5 w-3.5"
                  t={t}
                />
              )}
              {createProjectInStrip && createProjectControl}
              {archiveToggleInStrip && (
                <SidebarArchiveToggle
                  searchMode={searchMode}
                  onSearchModeChange={onSearchModeChange}
                  sizeClass="h-6 w-6 rounded-lg"
                  iconClass="h-3.5 w-3.5"
                  t={t}
                />
              )}
            </>
          ) : null
        }
      />

      {searchRowVisible && (
        <SidebarSearchRow
          createProjectControl={createProjectControl}
          searchFilter={searchFilter}
          onSearchFilterChange={onSearchFilterChange}
          onClearSearchFilter={onClearSearchFilter}
          searchMode={searchMode}
          onSearchModeChange={onSearchModeChange}
          searchScope={searchScope}
          onSearchScopeChange={onSearchScopeChange}
          isMessageSearching={isMessageSearching}
          t={t}
        />
      )}

      {bulkSelectionKind && activeSection === 'projects' && (
        <SidebarBulkToolbar
          kind={bulkSelectionKind}
          selectedCount={bulkSelectedIds.size}
          visibleCount={visibleBulkIds.length}
          isArchived={searchMode === 'archived'}
          isBusy={isBulkMutating}
          isAvailable={bulkLifecycleActions}
          onSelectVisible={() => onSelectVisibleBulkIds(visibleBulkIds)}
          onClear={onClearBulkSelection}
          onAction={onRunBulkAction}
        />
      )}

      {showTerminals ? (
        canUseTerminals ? (
          <SidebarTerminalsSection terminals={terminals} t={t} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
              <TerminalSquare className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </div>
            <h3 className="text-base font-medium text-foreground">
              {tTerminals('permissionDenied.title')}
            </h3>
            <p className="text-sm text-muted-foreground">
              {tTerminals('permissionDenied.description')}
            </p>
          </div>
        )
      ) : (
        <>
      <ScrollArea
        ref={bindScrollViewport}
        data-sidebar-scroll-area
        className="min-h-0 min-w-0 flex-1 [&>div]:overflow-y-auto [&>div]:overflow-x-hidden [&>div]:overscroll-contain [&>div]:[scrollbar-gutter:stable]"
      >
        {searchMode === 'archived' ? (
          isArchivedSessionsLoading ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
                {t('archived.loadingTitle', 'Loading archive...')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('archived.loadingDescription', 'Fetching hidden workspaces and sessions you can restore later.')}
              </p>
            </div>
          ) : archivedFolders.length === 0 ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <Archive className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
                {archivedSessionsCount > 0
                  ? t('archived.noMatchingSessions', 'No matching archived items')
                  : t('archived.emptyTitle', 'No archived items')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {archivedSessionsCount > 0
                  ? t('archived.tryDifferentSearch', 'Try a different search term.')
                  : t('archived.emptyDescription', 'Archived workspaces and sessions will appear here when you hide them from the active list.')}
              </p>
            </div>
          ) : (
            <div className="pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] pt-2">
              <div className="flex items-center justify-between px-3 pb-1">
                <p className="text-xs text-muted-foreground">
                  {`${archivedSessionsCount} ${t(
                    archivedSessionsCount === 1 ? 'archived.sessionCountOne' : 'archived.sessionCountOther',
                    archivedSessionsCount === 1 ? 'archived item' : 'archived items',
                  )}`}
                </p>
              </div>
              <SidebarArchivedList
                folders={archivedFolders}
                expandByDefault={searchFilter.trim().length > 0}
                bulkSelectionKind={bulkSelectionKind}
                bulkSelectedIds={bulkSelectedIds}
                onToggleBulkId={toggleBulkId}
                onRestoreArchivedProject={onRestoreArchivedProject}
                onArchivedSessionClick={onArchivedSessionClick}
                onRestoreArchivedSession={onRestoreArchivedSession}
                onDeleteArchivedSession={onDeleteArchivedSession}
                t={t}
              />
            </div>
          )
        ) : (
          <SidebarProjectList {...projectListProps} />
        )}
      </ScrollArea>
        </>
      )}

      <SidebarFooter
        updateAvailable={updateAvailable}
        updatePrepared={updatePrepared}
        prestageReady={prestageReady}
        restartRequired={restartRequired}
        actions={actions}
        history={history}
        loading={loading}
        execute={execute}
        dismiss={dismiss}
        refreshActions={refreshActions}
        releaseInfo={releaseInfo}
        latestVersion={latestVersion}
        currentVersion={currentVersion}
        onShowVersionModal={onShowVersionModal}
        onShowSettings={onShowSettings}
        t={t}
      />
    </div>
  );
}
