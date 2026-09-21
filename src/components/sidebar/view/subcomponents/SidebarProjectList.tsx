import { useEffect } from 'react';
import type { TFunction } from 'i18next';

import type { LoadingProgress, Project, ProjectSession, LLMProvider } from '../../../../types/app';
import { setPageContextName } from '../../../../utils/pageTitleNotification';
import type { ProjectToolbarProps, SessionWithProvider } from '../../types/types';
import type { BulkSelectionKind } from '../../hooks/useSidebarController';

import SidebarProjectItem from './SidebarProjectItem';
import SidebarProjectsState from './SidebarProjectsState';

export type SidebarProjectListProps = ProjectToolbarProps & {
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  expandedProjects: Set<string>;
  editingProject: string | null;
  editingName: string;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  deletingProjects: Set<string>;
  bulkSelectionKind: BulkSelectionKind | null;
  bulkSelectedIds: Set<string>;
  onToggleBulkSelectedId: (id: string) => void;
  onStartBulkSelectionWithId: (kind: BulkSelectionKind, id: string) => void;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  onLoadMoreSessions: (projectId: string) => void;
  loadingMoreProjects: Set<string>;
  isProjectStarred: (projectName: string) => boolean;
  isSessionStarred: (session: SessionWithProvider) => boolean;
  onToggleStarSession: (session: SessionWithProvider, projectName: string) => void;
  onEditingNameChange: (value: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onArchiveProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

export default function SidebarProjectList({
  projects,
  activeProjectTool,
  onOpenProjectTool,
  onProjectToolbarPresence,
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
  onToggleBulkSelectedId,
  onStartBulkSelectionWithId,
  getProjectSessions,
  onLoadMoreSessions,
  loadingMoreProjects,
  isProjectStarred,
  isSessionStarred,
  onToggleStarSession,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onArchiveProject,
  onSessionSelect,
  onDeleteSession,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectListProps) {
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    // اسم المشروع وحده — **لا العنوان كاملاً**: اسم العلامة يملكه
    // `BrandingContext` (إعداد المالك في الإعدادات)، وتركيبُ السلسلة هنا كان
    // يثبّت `ـنسَّاجـ` في الكود فيدهس الاسم المخصّص عند أول اختيار مشروع.
    //
    // NOT `document.title = …`: this effect re-runs on every `projects_updated`
    // broadcast (a finished turn always emits one), so a direct assignment wiped
    // the `[Done]` completion marker ~0.5s after it appeared. The shared writer
    // re-applies the marker when it is still meant to be showing.
    setPageContextName(selectedProject?.displayName);
  }, [selectedProject]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  return (
    <div className="space-y-1 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] pt-2">
      {!showProjects
        ? state
        : filteredProjects.map((project) => (
            // React key + per-project state lookups all use the DB `projectId`
            // so they remain stable across renames and session changes.
            <SidebarProjectItem
              activeProjectTool={activeProjectTool}
              onOpenProjectTool={onOpenProjectTool}
              onProjectToolbarPresence={onProjectToolbarPresence}
              key={project.projectId}
              project={project}
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              isExpanded={expandedProjects.has(project.projectId)}
              isDeleting={deletingProjects.has(project.projectId)}
              bulkSelectionKind={bulkSelectionKind}
              bulkSelectedIds={bulkSelectedIds}
              onToggleBulkSelectedId={onToggleBulkSelectedId}
              onStartBulkSelectionWithId={onStartBulkSelectionWithId}
              isStarred={isProjectStarred(project.projectId)}
              isSessionStarred={isSessionStarred}
              onToggleStarSession={onToggleStarSession}
              editingProject={editingProject}
              editingName={editingName}
              sessions={getProjectSessions(project)}
              initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
              isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
              currentTime={currentTime}
              editingSession={editingSession}
              editingSessionName={editingSessionName}
              onEditingNameChange={onEditingNameChange}
              onToggleProject={onToggleProject}
              onProjectSelect={onProjectSelect}
              onToggleStarProject={onToggleStarProject}
              onStartEditingProject={onStartEditingProject}
              onCancelEditingProject={onCancelEditingProject}
              onSaveProjectName={onSaveProjectName}
              onDeleteProject={onDeleteProject}
              onArchiveProject={onArchiveProject}
              onSessionSelect={onSessionSelect}
              onDeleteSession={onDeleteSession}
              onLoadMoreSessions={onLoadMoreSessions}
              onNewSession={onNewSession}
              onEditingSessionNameChange={onEditingSessionNameChange}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              t={t}
            />
          ))}
    </div>
  );
}
