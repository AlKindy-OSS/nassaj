import { useCallback, useRef } from 'react';
import { Archive, Folder, FolderPlus, RotateCcw, TerminalSquare, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { ArchivedProjectListItem, ArchivedSessionListItem, SidebarSection, SidebarSearchMode, SidebarSearchScope, SidebarTerminalsProps } from '../../types/types';
import type { PublicAction, ExecuteOutcome, DismissOutcome, HistoryEntry } from '../../../../hooks/useServerActions';
import type { DegradedReason } from '../../../../hooks/useVersionCheck';
import type { BulkProjectAction, BulkSelectionKind, BulkSessionAction } from '../../hooks/useSidebarController';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { useAuth } from '../../../auth';
import PresencePanel from '../../../presence/PresencePanel';
import { getAllSessions } from '../../utils/utils';

import SidebarArchiveToggle from './SidebarArchiveToggle';
import SidebarClosedFilterToggle from './SidebarClosedFilterToggle';
import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarSearchRow from './SidebarSearchRow';
import SidebarTerminalsSection from './SidebarTerminalsSection';
import SidebarBulkToolbar from './SidebarBulkToolbar';
import DegradedNotice from './DegradedNotice';

type ArchivedSessionGroup = {
  key: string;
  projectId: string | null;
  projectDisplayName: string;
  projectPath: string | null;
  isProjectArchived: boolean;
  sessions: ArchivedSessionListItem[];
  latestActivity: string | null;
};

/**
 * Groups archived sessions by project metadata so the archive view preserves
 * the same mental model as the active sidebar: projects first, then sessions.
 */
function groupArchivedSessionsByProject(sessions: ArchivedSessionListItem[]): ArchivedSessionGroup[] {
  const groups = new Map<string, ArchivedSessionGroup>();

  for (const session of sessions) {
    const key = session.projectId ?? session.projectPath ?? `session:${session.sessionId}`;
    const existingGroup = groups.get(key);

    if (existingGroup) {
      existingGroup.sessions.push(session);
      if (!existingGroup.latestActivity || (session.lastActivity && session.lastActivity > existingGroup.latestActivity)) {
        existingGroup.latestActivity = session.lastActivity;
      }
      continue;
    }

    groups.set(key, {
      key,
      projectId: session.projectId,
      projectDisplayName: session.projectDisplayName,
      projectPath: session.projectPath,
      isProjectArchived: session.isProjectArchived,
      sessions: [session],
      latestActivity: session.lastActivity,
    });
  }

  return [...groups.values()].sort((groupA, groupB) => {
    const a = groupA.latestActivity ?? '';
    const b = groupB.latestActivity ?? '';
    return b.localeCompare(a);
  });
}

function formatCompactArchivedAge(dateString: string | null): string {
  if (!dateString) {
    return '';
  }

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, Date.now() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  return `${Math.floor(diffInHours / 24)}d`;
}

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
  const groupedArchivedSessions = groupArchivedSessionsByProject(archivedSessions);
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
          ) : archivedProjects.length === 0 && groupedArchivedSessions.length === 0 ? (
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
            <div className="space-y-3 px-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-muted-foreground">
                  {`${archivedSessionsCount} ${t(
                    archivedSessionsCount === 1 ? 'archived.sessionCountOne' : 'archived.sessionCountOther',
                    archivedSessionsCount === 1 ? 'archived item' : 'archived items',
                  )}`}
                </p>
              </div>
              {archivedProjects.map((project) => {
                const projectSessions = getAllSessions(project);

                return (
                  <div key={project.projectId} className="overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm">
                    <div className="flex items-start justify-between gap-3 border-b border-border/60 px-3 py-2.5">
                      {bulkSelectionKind === 'projects' && (
                        <input type="checkbox" aria-label={`${t('bulk.selectProject', 'Select project')}: ${project.displayName}`} checked={bulkSelectedIds.has(project.projectId)} onChange={() => onSelectVisibleBulkIds(bulkSelectedIds.has(project.projectId) ? [...bulkSelectedIds].filter((id) => id !== project.projectId) : [...bulkSelectedIds, project.projectId])} className="mt-1 h-4 w-4 flex-none accent-primary" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm font-medium text-foreground">
                            {project.displayName}
                          </span>
                          <span className="inline-flex items-center justify-center rounded-full bg-muted px-1 py-px text-center text-[7px] font-medium uppercase leading-none tracking-[0.02em] text-muted-foreground">
                            {t('archived.projectArchived', 'Project archived')}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground/70" title={project.fullPath}>
                          {project.fullPath}
                        </p>
                      </div>
                      <button
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                        onClick={() => onRestoreArchivedProject(project.projectId)}
                        title={t('archived.restoreProject', 'Restore workspace')}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {projectSessions.length > 0 && (
                      <div className="divide-y divide-border/50">
                        {projectSessions.map((session) => (
                          <div key={String(session.id)} className="flex items-center gap-2">
                          {bulkSelectionKind === 'sessions' && <input type="checkbox" aria-label={t('bulk.selectSession', 'Select conversation')} checked={bulkSelectedIds.has(String(session.id))} onChange={() => onSelectVisibleBulkIds(bulkSelectedIds.has(String(session.id)) ? [...bulkSelectedIds].filter((id) => id !== String(session.id)) : [...bulkSelectedIds, String(session.id)])} className="ms-3 h-4 w-4 flex-none accent-primary" />}
                          <button
                            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-start transition-colors hover:bg-accent/40"
                            onClick={() => onArchivedSessionClick({
                              sessionId: String(session.id),
                              provider: session.__provider,
                              projectId: project.projectId,
                              projectPath: project.fullPath,
                              projectDisplayName: project.displayName,
                              sessionTitle:
                                (typeof session.summary === 'string' && session.summary.trim().length > 0
                                  ? session.summary
                                  : typeof session.name === 'string' && session.name.trim().length > 0
                                    ? session.name
                                    : String(session.id)),
                              createdAt: typeof session.created_at === 'string' ? session.created_at : null,
                              updatedAt: typeof session.updated_at === 'string' ? session.updated_at : null,
                              lastActivity:
                                typeof session.lastActivity === 'string'
                                  ? session.lastActivity
                                  : typeof session.updated_at === 'string'
                                    ? session.updated_at
                                    : typeof session.created_at === 'string'
                                      ? session.created_at
                                      : null,
                              isProjectArchived: true,
                            })}
                          >
                            <SessionProviderLogo provider={session.__provider} className="h-3.5 w-3.5 flex-shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-xs font-medium text-foreground">
                                  {(typeof session.summary === 'string' && session.summary.trim().length > 0
                                    ? session.summary
                                    : typeof session.name === 'string' && session.name.trim().length > 0
                                      ? session.name
                                      : String(session.id))}
                                </span>
                                <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                                  {formatCompactArchivedAge(
                                    typeof session.lastActivity === 'string'
                                      ? session.lastActivity
                                      : typeof session.updated_at === 'string'
                                        ? session.updated_at
                                        : typeof session.created_at === 'string'
                                          ? session.created_at
                                          : null,
                                  )}
                                </span>
                              </div>
                              <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                                {session.__provider}
                              </p>
                            </div>
                          </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {groupedArchivedSessions.map((group) => (
                <div key={group.key} className="overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm">
                  <div className="flex items-start justify-between gap-3 border-b border-border/60 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium text-foreground">
                          {group.projectDisplayName}
                        </span>
                        {group.isProjectArchived && (
                          <span className="inline-flex items-center justify-center rounded-full bg-muted px-1 py-px text-center text-[7px] font-medium uppercase leading-none tracking-[0.02em] text-muted-foreground">
                            {t('archived.projectArchived', 'Project archived')}
                          </span>
                        )}
                      </div>
                      {group.projectPath && (
                        <p className="mt-1 truncate text-xs text-muted-foreground/70" title={group.projectPath}>
                          {group.projectPath}
                        </p>
                      )}
                    </div>
                    <span className="flex-shrink-0 text-[11px] text-muted-foreground">
                      {group.sessions.length}
                    </span>
                  </div>
                  <div className="divide-y divide-border/50">
                    {group.sessions.map((session) => (
                      <div key={session.sessionId} className="flex items-center gap-2 px-3 py-2.5">
                        {bulkSelectionKind === 'sessions' && <input type="checkbox" aria-label={`${t('bulk.selectSession', 'Select conversation')}: ${session.sessionTitle}`} checked={bulkSelectedIds.has(session.sessionId)} onChange={() => onSelectVisibleBulkIds(bulkSelectedIds.has(session.sessionId) ? [...bulkSelectedIds].filter((id) => id !== session.sessionId) : [...bulkSelectedIds, session.sessionId])} className="h-4 w-4 flex-none accent-primary" />}
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2 text-start transition-colors hover:text-foreground"
                          onClick={() => onArchivedSessionClick(session)}
                        >
                          <SessionProviderLogo provider={session.provider} className="h-3.5 w-3.5 flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-xs font-medium text-foreground">
                                {session.sessionTitle}
                              </span>
                              {session.lastActivity && (
                                <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                                  {formatCompactArchivedAge(session.lastActivity)}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                              {session.provider}
                            </p>
                          </div>
                        </button>
                        <button
                          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                          onClick={() => onRestoreArchivedSession(session.sessionId)}
                          title={t('archived.restore', 'Restore session')}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-700 transition-colors hover:bg-red-100 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/30"
                          onClick={() => onDeleteArchivedSession(session)}
                          title={t('archived.deletePermanently', 'Delete permanently')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
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
