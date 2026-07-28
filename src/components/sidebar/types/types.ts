import type { LoadingProgress, Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { TerminalActionError, TerminalSummary } from '../../terminals/types/types';

export type ProjectSortOrder = 'name' | 'date';
// Top-level sidebar section (T-940): the header toggles between the Terminals
// list and the Projects list. Replaces the former "My projects / Team / All"
// membership filter. Persisted per-browser; defaults to 'projects'.
export type SidebarSection = 'projects' | 'terminals';
// 'conversations' mode removed with the Projects/Conversations tabs
// (C-MU-UX-SIDEBAR-TABS); the header now toggles projects view vs archive.
export type SidebarSearchMode = 'projects' | 'archived';
export type ArchivedProjectListItem = Project & { isArchived: true };

export type SessionWithProvider = ProjectSession & {
  __provider: LLMProvider;
};

export type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

export type DeleteProjectConfirmation = {
  project: Project;
  sessionCount: number;
};

// Delete confirmation payload used by sidebar UX. `projectId`/`provider` are
// kept for wiring compatibility, while API deletion now keys only by sessionId.
export type SessionDeleteConfirmation = {
  projectId: string | null;
  sessionId: string;
  sessionTitle: string;
  provider: LLMProvider;
  isArchived: boolean;
};

// Standalone-terminals wiring passed into the sidebar (T-939/T-940). All data +
// handlers originate from AppContent's shared controller; the sidebar is a
// view-only consumer that renders the Terminals section.
export type SidebarTerminalsProps = {
  items: TerminalSummary[];
  isLoading: boolean;
  error: string | null;
  selectedTerminalId: string | null;
  createError: TerminalActionError | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onDismissCreateError: () => void;
};

export type SidebarProps = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  // Terminals section (T-940). Provided explicitly by AppContent alongside the
  // spread `sidebarSharedProps`, which does not carry these fields.
  terminals: SidebarTerminalsProps;
  onSectionChange: (section: SidebarSection) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onNewSession: (project: Project) => void;
  onSessionDelete?: (sessionId: string) => void;
  onLoadMoreSessions?: (projectId: string) => Promise<void> | void;
  // `projectId` is the DB identifier; the sidebar hands it back to the parent
  // when the delete flow completes.
  onProjectDelete?: (projectId: string) => void;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  onRefresh: () => Promise<void> | void;
  onShowSettings: (dest?: import('../../settings/types/types').SettingsDeepLink) => void;
  showSettings: boolean;
  settingsInitialTab: string;
  settingsDeepLink?: import('../../settings/types/types').SettingsDeepLink;
  onCloseSettings: () => void;
  isMobile: boolean;
};

export type SessionViewModel = {
  isCursorSession: boolean;
  isCodexSession: boolean;
  isGeminiSession: boolean;
  isOpenCodeSession: boolean;
  isActive: boolean;
  // Derived once here so every surface reads closure the same way: only an
  // explicit `true` closes a row (a missing field on a legacy payload is open).
  isClosed: boolean;
  sessionName: string;
  sessionTime: string;
  messageCount: number;
};

// Retained as `name` for backwards compatibility with existing settings
// consumers; the value is populated from `projectId` by normalizeProjectForSettings.
export type SettingsProject = {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
};
