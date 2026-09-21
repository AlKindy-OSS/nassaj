import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../auth/context/AuthContext';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { isUpdatePrepared, useVersionCheck } from '../../../hooks/useVersionCheck';
import { countPendingServerActions, useServerActions } from '../../../hooks/useServerActions';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useSidebarController } from '../hooks/useSidebarController';
import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import type { LLMProvider } from '../../../types/app';
import type { SidebarProps } from '../types/types';
import { SidebarSessionExtrasProvider } from '../context/SidebarSessionExtrasContext';

import SidebarCollapsed from './subcomponents/SidebarCollapsed';
import SidebarContent from './subcomponents/SidebarContent';
import SidebarModals from './subcomponents/SidebarModals';
import type { SidebarProjectListProps } from './subcomponents/SidebarProjectList';

function Sidebar({
  projects,
  activeProjectTool,
  onOpenProjectTool,
  onProjectToolbarPresence,
  selectedProject,
  selectedSession,
  terminals,
  onSectionChange,
  onProjectSelect,
  onSessionSelect,
  onNewSession,
  onSessionDelete,
  onLoadMoreSessions,
  onProjectDelete,
  onProjectArchive,
  isLoading,
  loadingProgress,
  onRefresh,
  onShowSettings,
  isMobile,
  scheduledMessagesCount,
  scheduledMessagesEnabled,
  scheduledMessagesActive,
  onOpenScheduledMessages,
}: SidebarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  // Release discovery is authenticated and server-side; private repository
  // credentials and coordinates never enter the browser bundle.
  const {
    updateAvailable: updateAvailableFromHealth,
    updatePrepared: updatePreparedFromHealth,
    preparedSignals,
    latestVersion,
    currentVersion,
    sourceVersion,
    releaseInfo,
    installMode,
    restartRequired,
    hasPendingActions,
    bulkLifecycleActions,
    degradedReason,
  } = useVersionCheck();

  // T-944 F1: fetch pending action queue, keep live via WS + /health signal
  const { user: actionUser } = useAuth();
  const { actions, history: actionsHistory, loading: actionsLoading, execute, dismiss, refetch } = useServerActions(hasPendingActions,
    actionUser?.role === 'owner' ? String(actionUser.id) : undefined);
  // B-1055 / review م-6. The staged-candidate branch of "prepared, awaiting
  // activation" is only true when the queue holds the safe-restart row bound to
  // that exact build. This is the one place that holds both halves — /health
  // via useVersionCheck and the queue via useServerActions — so the judgement
  // is completed here rather than guessed from a generic pending flag.
  const queuedRestartBuildIds = useMemo(
    () => actions
      .filter((action) => action.actionType === 'safe-restart' && action.status === 'pending')
      .map((action) => action.expectedServerBuildId),
    [actions],
  );
  const updatePrepared = updatePreparedFromHealth
    || isUpdatePrepared(preparedSignals, queuedRestartBuildIds);
  const updateAvailable = updateAvailableFromHealth || updatePrepared;
  const { preferences, setPreference } = useUiPreferences();
  const { sidebarVisible, showSidebarSearch } = preferences;
  const paletteOps = usePaletteOps();

  const {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    initialSessionsLoaded,
    currentTime,
    editingSession,
    editingSessionName,
    searchFilter,
    searchMode,
    setSearchMode,
    searchScope,
    setSearchScope,
    hideClosedSessions,
    setHideClosedSessions,
    messageSearchSnippets,
    isMessageSearching,
    archiveSession,
    deletingProjects,
    deleteConfirmation,
    archiveConfirmation,
    sessionDeleteConfirmation,
    showVersionModal,
    filteredProjects,
    activeSection,
    setActiveSection,
    archivedProjects,
    archivedSessions,
    archivedSessionsCount,
    isArchivedSessionsLoading,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    toggleStarSession,
    isSessionStarred,
    getSearchVisibleSessions,
    loadingMoreProjects,
    loadMoreSessionsForProject,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
    requestProjectArchive,
    confirmArchiveProject,
    handleProjectSelect,
    openArchivedSession,
    restoreArchivedProject,
    restoreArchivedSession,
    updateSessionSummary,
    collapseSidebar: handleCollapseSidebar,
    expandSidebar: handleExpandSidebar,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    setSearchFilter,
    setDeleteConfirmation,
    setArchiveConfirmation,
    setSessionDeleteConfirmation,
    setShowVersionModal,
    bulkSelectionKind,
    bulkSelectedIds,
    isBulkMutating,
    enterBulkSelection,
    startBulkSelectionWithId,
    exitBulkSelection,
    toggleBulkSelectedId,
    selectVisibleBulkIds,
    runBulkAction,
  } = useSidebarController({
    projects,
    selectedProject,
    selectedSession,
    isLoading,
    isMobile,
    t,
    onRefresh,
    onProjectSelect,
    onSessionSelect,
    onSessionDelete,
    onLoadMoreSessions,
    onProjectDelete,
    onProjectArchive,
    setSidebarVisible: (visible) => setPreference('sidebarVisible', visible),
    sidebarVisible,
    bulkLifecycleActions,
    onSectionChange,
  });

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  // When the user hides the search bar via preferences, clear any active search
  // filter — with no input on screen there would be no way to undo it.
  // `searchMode` is NOT reset any more (B-332): the archive toggle moves to the
  // presence strip when the search row is hidden, so the archive view keeps a
  // visible way back.
  useEffect(() => {
    if (!showSidebarSearch && searchFilter) {
      setSearchFilter('');
    }
  }, [showSidebarSearch, searchFilter, setSearchFilter]);

  const handleProjectCreated = () => {
    void paletteOps.refreshProjects();
  };

  const sessionExtras = useMemo(
    () => ({
      messageSnippets: messageSearchSnippets,
      onArchiveSession: (sessionId: string) => {
        void archiveSession(sessionId);
      },
      hideClosedSessions,
    }),
    [archiveSession, hideClosedSessions, messageSearchSnippets],
  );

  const projectListProps: SidebarProjectListProps = {
    activeProjectTool,
    onOpenProjectTool,
    onProjectToolbarPresence,
    projects,
    filteredProjects,
    selectedProject,
    selectedSession,
    isLoading,
    loadingProgress,
    expandedProjects,
    editingProject,
    editingName,
    initialSessionsLoaded,
    currentTime,
    editingSession,
    editingSessionName,
    deletingProjects,
    bulkSelectionKind,
    bulkSelectedIds,
    onToggleBulkSelectedId: toggleBulkSelectedId,
    onStartBulkSelectionWithId: startBulkSelectionWithId,
    // The list renders the search-narrowed view: a hit inside one conversation
    // shows that conversation, not its whole project. The unfiltered
    // `getProjectSessions` stays behind for counts (e.g. the delete dialog).
    getProjectSessions: getSearchVisibleSessions,
    loadingMoreProjects,
    isProjectStarred,
    isSessionStarred,
    onToggleStarSession: toggleStarSession,
    onEditingNameChange: setEditingName,
    onToggleProject: toggleProject,
    onProjectSelect: handleProjectSelect,
    onToggleStarProject: toggleStarProject,
    onStartEditingProject: startEditing,
    onCancelEditingProject: cancelEditing,
    onSaveProjectName: (projectName) => {
      void saveProjectName(projectName);
    },
    onDeleteProject: requestProjectDelete,
    onArchiveProject: requestProjectArchive,
    onSessionSelect: handleSessionClick,
    onDeleteSession: showDeleteSessionConfirmation,
    onLoadMoreSessions: loadMoreSessionsForProject,
    onNewSession,
    onEditingSessionNameChange: setEditingSessionName,
    onStartEditingSession: (sessionId, initialName) => {
      setEditingSession(sessionId);
      setEditingSessionName(initialName);
    },
    onCancelEditingSession: () => {
      setEditingSession(null);
      setEditingSessionName('');
    },
    onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => {
      void updateSessionSummary(projectName, sessionId, summary, provider);
    },
    t,
  };

  return (
    <>
        <SidebarModals
          projects={projects}
        showNewProject={showNewProject}
        onCloseNewProject={() => setShowNewProject(false)}
        onProjectCreated={handleProjectCreated}
        archiveConfirmation={archiveConfirmation}
        onCancelArchiveProject={() => setArchiveConfirmation(null)}
        onConfirmArchiveProject={confirmArchiveProject}
        deleteConfirmation={deleteConfirmation}
        onCancelDeleteProject={() => setDeleteConfirmation(null)}
        onConfirmDeleteProject={confirmDeleteProject}
        sessionDeleteConfirmation={sessionDeleteConfirmation}
        onCancelDeleteSession={() => setSessionDeleteConfirmation(null)}
        onConfirmDeleteSession={confirmDeleteSession}
        showVersionModal={showVersionModal}
        updatePrepared={updatePrepared}
        onCloseVersionModal={() => setShowVersionModal(false)}
        releaseInfo={releaseInfo}
        currentVersion={currentVersion}
        sourceVersion={sourceVersion}
        latestVersion={latestVersion}
        installMode={installMode}
        t={t}
      />

      {isSidebarCollapsed ? (
        <SidebarCollapsed
          onExpand={handleExpandSidebar}
          onShowSettings={onShowSettings}
          onOpenTerminals={() => {
            setActiveSection('terminals');
            handleExpandSidebar();
          }}
          runningTerminalsCount={terminals.items.filter((item) => item.status === 'running').length}
          terminalsActive={activeSection === 'terminals'}
          updateAvailable={updateAvailable}
          updatePrepared={updatePrepared}
          restartRequired={restartRequired}
          pendingActionsCount={countPendingServerActions(actions)}
          onShowVersionModal={() => setShowVersionModal(true)}
          projects={projects}
          onProjectSelect={handleProjectSelect}
          sessionProvider={selectedSession?.__provider ?? null}
          scheduledMessagesCount={scheduledMessagesCount}
          scheduledMessagesEnabled={scheduledMessagesEnabled}
          scheduledMessagesActive={scheduledMessagesActive}
          onOpenScheduledMessages={onOpenScheduledMessages}
          t={t}
        />
      ) : (
        <SidebarSessionExtrasProvider value={sessionExtras}>
        <SidebarContent
            isLoading={isLoading}
            projects={projects}
            archivedProjects={archivedProjects}
            archivedSessions={archivedSessions}
            archivedSessionsCount={archivedSessionsCount}
            isArchivedSessionsLoading={isArchivedSessionsLoading}
            searchFilter={searchFilter}
            onSearchFilterChange={setSearchFilter}
            onClearSearchFilter={() => setSearchFilter('')}
            showSidebarSearch={showSidebarSearch}
            searchMode={searchMode}
            onSearchModeChange={setSearchMode}
            searchScope={searchScope}
            onSearchScopeChange={setSearchScope}
            hideClosedSessions={hideClosedSessions}
            onHideClosedSessionsChange={setHideClosedSessions}
            isMessageSearching={isMessageSearching}
            activeSection={activeSection}
            onSectionChange={setActiveSection}
            terminals={terminals}
            onRestoreArchivedProject={restoreArchivedProject}
            onArchivedSessionClick={openArchivedSession}
            onRestoreArchivedSession={restoreArchivedSession}
            onDeleteArchivedSession={(session) => {
              showDeleteSessionConfirmation(
                session.projectId,
                session.sessionId,
                session.sessionTitle,
                session.provider,
                { isArchived: true },
              );
            }}
            onCreateProject={() => setShowNewProject(true)}
        onCollapseSidebar={handleCollapseSidebar}
            onProjectSelect={handleProjectSelect}
            updateAvailable={updateAvailable}
            updatePrepared={updatePrepared}
            degradedReason={degradedReason}
            restartRequired={restartRequired}
            actions={actions}
            history={actionsHistory}
            loading={actionsLoading}
            execute={execute}
            dismiss={dismiss}
            refreshActions={refetch}
            releaseInfo={releaseInfo}
            latestVersion={latestVersion}
            currentVersion={currentVersion}
            onShowVersionModal={() => setShowVersionModal(true)}
            onShowSettings={onShowSettings}
        scheduledMessagesCount={scheduledMessagesCount}
        scheduledMessagesEnabled={scheduledMessagesEnabled}
        scheduledMessagesActive={scheduledMessagesActive}
        onOpenScheduledMessages={onOpenScheduledMessages}
        projectListProps={projectListProps}
        bulkSelectionKind={bulkSelectionKind}
        bulkSelectedIds={bulkSelectedIds}
        isBulkMutating={isBulkMutating}
        bulkLifecycleActions={bulkLifecycleActions}
        onBulkSelectionKindChange={enterBulkSelection}
        onSelectVisibleBulkIds={selectVisibleBulkIds}
        onClearBulkSelection={exitBulkSelection}
        onRunBulkAction={(action) => { void runBulkAction(action); }}
        onExitBulkSelection={exitBulkSelection}
            t={t}
          />
        </SidebarSessionExtrasProvider>
      )}

    </>
  );
}

export default Sidebar;
