import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { api } from '../utils/api';
import type {
  AppSocketMessage,
  AppTab,
  LLMProvider,
  LoadingProgress,
  Project,
  ProjectSession,
  ProjectsUpdatedMessage,
} from '../types/app';
import type { SettingsDeepLink } from '../components/settings/types/types';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  latestMessage: AppSocketMessage | null;
  isMobile: boolean;
  activeSessions: Set<string>;
};

type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

const serialize = (value: unknown) => JSON.stringify(value ?? null);

const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
  includeExternalSessions: boolean,
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    const baseChanged =
      nextProject.projectId !== prevProject.projectId ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      Boolean(nextProject.isStarred) !== Boolean(prevProject.isStarred) ||
      Boolean(nextProject.isMember) !== Boolean(prevProject.isMember) ||
      Boolean(nextProject.isOwner) !== Boolean(prevProject.isOwner) ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions);

    if (baseChanged) {
      return true;
    }

    if (!includeExternalSessions) {
      return false;
    }

    return (
      serialize(nextProject.cursorSessions) !== serialize(prevProject.cursorSessions) ||
      serialize(nextProject.codexSessions) !== serialize(prevProject.codexSessions) ||
      serialize(nextProject.geminiSessions) !== serialize(prevProject.geminiSessions) ||
      serialize(nextProject.antigravitySessions) !== serialize(prevProject.antigravitySessions) ||
      serialize(nextProject.opencodeSessions) !== serialize(prevProject.opencodeSessions)
    );
  });
};

// Defense in depth for `projects_updated` broadcasts: when an incoming project
// omits a per-user flag (`isMember`/`isOwner` undefined), keep the value last
// delivered by the authenticated `GET /api/projects` fetch instead of silently
// dropping it — otherwise the sidebar "My projects"/"Team" filters empty after
// the first broadcast.
const preserveMembershipFlags = (incomingProjects: Project[], previousProjects: Project[]): Project[] => {
  if (previousProjects.length === 0) {
    return incomingProjects;
  }

  const previousByProjectId = new Map(previousProjects.map((project) => [project.projectId, project]));

  return incomingProjects.map((project) => {
    const previousProject = previousByProjectId.get(project.projectId);
    if (!previousProject) {
      return project;
    }

    const preservedFlags: Partial<Pick<Project, 'isMember' | 'isOwner'>> = {};
    if (project.isMember === undefined && previousProject.isMember !== undefined) {
      preservedFlags.isMember = previousProject.isMember;
    }
    if (project.isOwner === undefined && previousProject.isOwner !== undefined) {
      preservedFlags.isOwner = previousProject.isOwner;
    }

    if (Object.keys(preservedFlags).length === 0) {
      return project;
    }

    return { ...project, ...preservedFlags };
  });
};

const getProjectSessions = (project: Project): ProjectSession[] => {
  return [
    ...(project.sessions ?? []),
    ...(project.codexSessions ?? []),
    ...(project.cursorSessions ?? []),
    ...(project.geminiSessions ?? []),
    ...(project.antigravitySessions ?? []),
    ...(project.opencodeSessions ?? []),
  ];
};

const countLoadedProjectSessions = (project: Project): number => getProjectSessions(project).length;

const mergeSessionProviderLists = (baseSessions: ProjectSession[], additionalSessions: ProjectSession[]): ProjectSession[] => {
  const merged = [...baseSessions];
  const seenSessionIds = new Set(baseSessions.map((session) => String(session.id)));

  for (const session of additionalSessions) {
    const sessionId = String(session.id);
    if (seenSessionIds.has(sessionId)) {
      continue;
    }

    merged.push(session);
    seenSessionIds.add(sessionId);
  }

  return merged;
};

const mergeExpandedSessionPages = (previousProjects: Project[], incomingProjects: Project[]): Project[] => {
  if (previousProjects.length === 0) {
    return incomingProjects;
  }

  const previousByProjectId = new Map(previousProjects.map((project) => [project.projectId, project]));

  return incomingProjects.map((incomingProject) => {
    const previousProject = previousByProjectId.get(incomingProject.projectId);
    if (!previousProject) {
      return incomingProject;
    }

    const previousLoadedCount = countLoadedProjectSessions(previousProject);
    const incomingLoadedCount = countLoadedProjectSessions(incomingProject);
    if (previousLoadedCount <= incomingLoadedCount) {
      return incomingProject;
    }

    const mergedProject: Project = {
      ...incomingProject,
      sessions: mergeSessionProviderLists(incomingProject.sessions ?? [], previousProject.sessions ?? []),
      cursorSessions: mergeSessionProviderLists(incomingProject.cursorSessions ?? [], previousProject.cursorSessions ?? []),
      codexSessions: mergeSessionProviderLists(incomingProject.codexSessions ?? [], previousProject.codexSessions ?? []),
      geminiSessions: mergeSessionProviderLists(incomingProject.geminiSessions ?? [], previousProject.geminiSessions ?? []),
      antigravitySessions: mergeSessionProviderLists(incomingProject.antigravitySessions ?? [], previousProject.antigravitySessions ?? []),
      opencodeSessions: mergeSessionProviderLists(incomingProject.opencodeSessions ?? [], previousProject.opencodeSessions ?? []),
    };

    const totalSessions = Number(incomingProject.sessionMeta?.total ?? previousLoadedCount);
    mergedProject.sessionMeta = {
      ...incomingProject.sessionMeta,
      total: totalSessions,
      hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
    };

    return mergedProject;
  });
};

const mergeProjectSessionPage = (
  existingProject: Project,
  sessionsPage: Pick<Project, 'sessions' | 'cursorSessions' | 'codexSessions' | 'geminiSessions' | 'antigravitySessions' | 'opencodeSessions' | 'sessionMeta'>,
): Project => {
  const mergedProject: Project = {
    ...existingProject,
    sessions: mergeSessionProviderLists(existingProject.sessions ?? [], sessionsPage.sessions ?? []),
    cursorSessions: mergeSessionProviderLists(existingProject.cursorSessions ?? [], sessionsPage.cursorSessions ?? []),
    codexSessions: mergeSessionProviderLists(existingProject.codexSessions ?? [], sessionsPage.codexSessions ?? []),
    geminiSessions: mergeSessionProviderLists(existingProject.geminiSessions ?? [], sessionsPage.geminiSessions ?? []),
    antigravitySessions: mergeSessionProviderLists(existingProject.antigravitySessions ?? [], sessionsPage.antigravitySessions ?? []),
    opencodeSessions: mergeSessionProviderLists(existingProject.opencodeSessions ?? [], sessionsPage.opencodeSessions ?? []),
  };

  const totalSessions = Number(sessionsPage.sessionMeta?.total ?? existingProject.sessionMeta?.total ?? 0);
  mergedProject.sessionMeta = {
    ...existingProject.sessionMeta,
    ...sessionsPage.sessionMeta,
    total: totalSessions,
    hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
  };

  return mergedProject;
};

/**
 * True when `sessionId` is already listed under `projectId` in the given
 * projects snapshot. Exported for the B-290 regression test: it is the single
 * fact that separates "this conversation was deleted" from "this conversation
 * has not been indexed yet".
 */
export const isSessionListedInProjects = (
  projects: Project[],
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
): boolean => {
  if (!projectId || !sessionId) {
    return false;
  }
  return projects
    .filter((project) => project.projectId === projectId)
    .some((project) => getProjectSessions(project).some((session) => session.id === sessionId));
};

export const isUpdateAdditive = (
  currentProjects: Project[],
  updatedProjects: Project[],
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): boolean => {
  if (!selectedProject || !selectedSession) {
    return true;
  }

  const currentSelectedProject = currentProjects.find((project) => project.projectId === selectedProject.projectId);
  const updatedSelectedProject = updatedProjects.find((project) => project.projectId === selectedProject.projectId);

  if (!currentSelectedProject || !updatedSelectedProject) {
    return false;
  }

  const currentSelectedSession = getProjectSessions(currentSelectedProject).find(
    (session) => session.id === selectedSession.id,
  );
  const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
    (session) => session.id === selectedSession.id,
  );

  // B-290: a BRAND-NEW conversation is absent from the current list by
  // definition — `session_created` mints the id, the URL effect selects it as a
  // placeholder, and it lands in `activeSessions` long before the watcher
  // indexes its JSONL. Treating that absence as "not additive" made the caller
  // drop every `projects_updated` broadcast for the whole run, and since the
  // session never entered the list, the next broadcast was dropped for the same
  // reason — the row only appeared after a full page refresh. Nothing is being
  // replaced here, so this IS the additive case.
  if (!currentSelectedSession) {
    return true;
  }

  if (!updatedSelectedSession) {
    return false;
  }

  return (
    currentSelectedSession.id === updatedSelectedSession.id &&
    currentSelectedSession.title === updatedSelectedSession.title &&
    currentSelectedSession.created_at === updatedSelectedSession.created_at &&
    currentSelectedSession.updated_at === updatedSelectedSession.updated_at
  );
};

const VALID_TABS: Set<string> = new Set(['chat', 'files', 'shell', 'git', 'preview']);

const isValidTab = (tab: string): tab is AppTab => {
  return VALID_TABS.has(tab) || tab.startsWith('plugin:');
};

const readPersistedTab = (): AppTab => {
  try {
    const stored = localStorage.getItem('activeTab');
    if (stored && isValidTab(stored)) {
      return stored as AppTab;
    }
  } catch {
    // localStorage unavailable
  }
  return 'chat';
};

export function useProjectsState({
  sessionId,
  navigate,
  latestMessage,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>(readPersistedTab);

  useEffect(() => {
    try {
      localStorage.setItem('activeTab', activeTab);
    } catch {
      // Silently ignore storage errors
    }
  }, [activeTab]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const [settingsDeepLink, setSettingsDeepLink] = useState<SettingsDeepLink | undefined>(undefined);
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);
  /**
   * `newSessionTrigger` is an explicit, monotonic intent signal for user-driven
   * New Session actions.
   *
   * It exists because `handleNewSession` can be invoked while the app is already in
   * the same visible state (`selectedSession === null`, `activeTab === 'chat'`,
   * route already `/`). In that case, React/router updates are idempotent and no
   * downstream reset logic runs.
   *
   * Usage across the codebase:
   * 1) Produced here in `handleNewSession` via increment (always changes).
   * 2) Returned from this hook and threaded through:
   *    useProjectsState -> AppContent -> MainContent -> ChatInterface.
   * 3) Consumed in `useChatSessionState` as an effect dependency to forcibly clear
   *    chat-local state (`currentSessionId`, pending draft message, streaming flags,
   *    pending session storage keys, pagination/scroll artifacts).
   *
   * Keeping this signal dedicated avoids coupling resets to unrelated counters/events
   * (for example websocket/project refresh updates) that could cause accidental resets.
   */
  const [newSessionTrigger, setNewSessionTrigger] = useState(0);

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHandledMessageRef = useRef<AppSocketMessage | null>(null);

  // Captured once at mount from the URL that "Open in new tab → New Session" writes.
  // Cleared after first consumption so subsequent project-list re-renders are no-ops.
  const newSessionProjectParamRef = useRef<string | null>(
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('newSessionProject')
      : null,
  );

  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}) => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const response = await api.projects();
      const projectData = (await response.json()) as Project[];

      setProjects((prevProjects) => {
        const mergedProjects = mergeExpandedSessionPages(prevProjects, projectData);

        if (prevProjects.length === 0) {
          return mergedProjects;
        }

        return projectsHaveChanges(prevProjects, mergedProjects, true)
          ? mergedProjects
          : prevProjects;
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  const openSettings = useCallback((tab = 'tools', deepLink?: SettingsDeepLink) => {
    setSettingsInitialTab(tab);
    setSettingsDeepLink(deepLink);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  // Restore new-session intent from the `?newSessionProject=<id>` param written
  // by SidebarProjectSessions's "Open in new tab" context menu item.
  // Mirrors handleNewSession (minus navigate('/') — we're already at root).
  useEffect(() => {
    const param = newSessionProjectParamRef.current;
    if (!param || isLoadingProjects || projects.length === 0 || sessionId) {
      return;
    }

    // Consume once — clear the ref before acting so re-renders are no-ops.
    newSessionProjectParamRef.current = null;

    const target = projects.find((p) => p.projectId === param);

    // Remove the param from the address bar without a React Router navigation
    // (the route is still '/'; query params are transparent to route matching).
    window.history.replaceState(null, '', window.location.pathname);

    if (!target) {
      // Project not found (renamed/deleted?): stay on home screen silently.
      return;
    }

    setSelectedProject(target);
    setSelectedSession(null);
    setActiveTab('chat');
    setNewSessionTrigger((previous) => previous + 1);
  }, [isLoadingProjects, projects, sessionId]);

  useEffect(() => {
    if (!latestMessage) {
      return;
    }

    // `latestMessage` is event-like data. This effect also depends on local state
    // (`projects`, `selectedProject`, `selectedSession`) to compute derived updates.
    // Without this guard, handling one websocket message can update that local
    // state, retrigger the effect, and re-handle the same websocket message.
    if (lastHandledMessageRef.current === latestMessage) {
      return;
    }
    lastHandledMessageRef.current = latestMessage;

    if (latestMessage.type === 'loading_progress') {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }

      setLoadingProgress(latestMessage as LoadingProgress);

      if (latestMessage.phase === 'complete') {
        loadingProgressTimeoutRef.current = setTimeout(() => {
          setLoadingProgress(null);
          loadingProgressTimeoutRef.current = null;
        }, 500);
      }

      return;
    }

    if (latestMessage.type !== 'projects_updated') {
      return;
    }

    const projectsMessage = latestMessage as ProjectsUpdatedMessage;

    if (projectsMessage.updatedSessionId && selectedSession && selectedProject) {
      if (projectsMessage.updatedSessionId === selectedSession.id) {
        const isSessionActive = activeSessions.has(selectedSession.id);

        if (!isSessionActive) {
          setExternalMessageUpdate((prev) => prev + 1);
        }
      }
    }

    const hasActiveSession = Boolean(selectedSession && activeSessions.has(selectedSession.id));

    const incomingProjectsWithMembership = preserveMembershipFlags(projectsMessage.projects, projects);
    const updatedProjects = mergeExpandedSessionPages(projects, incomingProjectsWithMembership);

    if (
      hasActiveSession &&
      !isUpdateAdditive(projects, updatedProjects, selectedProject, selectedSession)
    ) {
      return;
    }

    setProjects((previousProjects) =>
      projectsHaveChanges(previousProjects, updatedProjects, true) ? updatedProjects : previousProjects,
    );

    if (!selectedProject) {
      return;
    }

    const updatedSelectedProject = updatedProjects.find(
      (project) => project.projectId === selectedProject.projectId,
    );

    if (!updatedSelectedProject) {
      return;
    }

    if (serialize(updatedSelectedProject) !== serialize(selectedProject)) {
      setSelectedProject(updatedSelectedProject);
    }

    if (!selectedSession) {
      return;
    }

    const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
      (session) => session.id === selectedSession.id,
    );

    if (!updatedSelectedSession) {
      // B-290: "absent from the payload" means DELETED only for a session that
      // was actually in the list before. A just-minted conversation is absent
      // until the watcher indexes its JSONL, and a broadcast triggered by some
      // other file can easily land inside that window — clearing the selection
      // there would drop the user out of the conversation they are streaming.
      if (isSessionListedInProjects(projects, selectedProject.projectId, selectedSession.id)) {
        setSelectedSession(null);
      }
    }
  }, [latestMessage, selectedProject, selectedSession, activeSessions, projects]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    // Project membership is resolved through `projectId` after the migration.
    for (const project of projects) {
      const claudeSession = project.sessions?.find((session) => session.id === sessionId);
      if (claudeSession) {
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'claude';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...claudeSession, __provider: 'claude' });
        }
        return;
      }

      const cursorSession = project.cursorSessions?.find((session) => session.id === sessionId);
      if (cursorSession) {
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'cursor';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...cursorSession, __provider: 'cursor' });
        }
        return;
      }

      const codexSession = project.codexSessions?.find((session) => session.id === sessionId);
      if (codexSession) {
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'codex';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...codexSession, __provider: 'codex' });
        }
        return;
      }

      const geminiSession = project.geminiSessions?.find((session) => session.id === sessionId);
      if (geminiSession) {
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'gemini';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...geminiSession, __provider: 'gemini' });
        }
        return;
      }

      const antigravitySession = project.antigravitySessions?.find((session) => session.id === sessionId);
      if (antigravitySession) {
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'antigravity';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...antigravitySession, __provider: 'antigravity' });
        }
        return;
      }

      const opencodeSession = project.opencodeSessions?.find((session) => session.id === sessionId);
      if (opencodeSession) {
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'opencode';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...opencodeSession, __provider: 'opencode' });
        }
        return;
      }
    }

    // Session id is in the URL but not yet present on any project payload (common
    // right after `session_created` + navigate, before the next projects refresh).
    // Without a `selectedSession`, chat state clears `currentSessionId` and the
    // UI stops reading the session store even though messages stream under this id.
    if (selectedSession?.id === sessionId) {
      return;
    }

    if (!selectedProject) {
      return;
    }

    let providerFromStorage: string | null = null;
    try {
      providerFromStorage = localStorage.getItem('selected-provider');
    } catch {
      providerFromStorage = null;
    }

    const normalizedProvider: LLMProvider =
      providerFromStorage === 'cursor'
        ? 'cursor'
        : providerFromStorage === 'codex'
          ? 'codex'
          : providerFromStorage === 'gemini'
            ? 'gemini'
            : providerFromStorage === 'antigravity'
              ? 'antigravity'
            : providerFromStorage === 'opencode'
              ? 'opencode'
            : 'claude';

    setSelectedSession({
      id: sessionId,
      __provider: normalizedProvider,
      __projectId: selectedProject.projectId,
      summary: '',
    });
  }, [sessionId, projects, selectedProject, selectedSession?.id, selectedSession?.__provider]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      setSelectedSession(session);

      if (activeTab === 'preview') {
        setActiveTab('chat');
      }

      const provider = localStorage.getItem('selected-provider') || 'claude';
      if (provider === 'cursor') {
        sessionStorage.setItem('cursorSessionId', session.id);
      }

      if (isMobile) {
        // Sessions are tagged with the owning project's DB `projectId` when
        // picked from the sidebar (see useSidebarController); compare against
        // the current selection's `projectId` so we know whether to collapse
        // the sidebar after navigation.
        const sessionProjectId = session.__projectId;
        const currentProjectId = selectedProject?.projectId;

        if (sessionProjectId !== currentProjectId) {
          setSidebarOpen(false);
        }
      }

      navigate(`/session/${session.id}`);
    },
    [activeTab, isMobile, navigate, selectedProject?.projectId],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab('chat');
      setNewSessionTrigger((previous) => previous + 1);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) =>
        prevProjects.map((project) => {
          const sessions = project.sessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];
          const cursorSessions = project.cursorSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];
          const codexSessions = project.codexSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];
          const geminiSessions = project.geminiSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];
          const antigravitySessions = project.antigravitySessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];
          const opencodeSessions = project.opencodeSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [];

          const removedFromProject = (
            sessions.length !== (project.sessions?.length ?? 0)
            || cursorSessions.length !== (project.cursorSessions?.length ?? 0)
            || codexSessions.length !== (project.codexSessions?.length ?? 0)
            || geminiSessions.length !== (project.geminiSessions?.length ?? 0)
            || antigravitySessions.length !== (project.antigravitySessions?.length ?? 0)
            || opencodeSessions.length !== (project.opencodeSessions?.length ?? 0)
          );

          if (!removedFromProject) {
            return project;
          }

          const updatedProject: Project = {
            ...project,
            sessions,
            cursorSessions,
            codexSessions,
            geminiSessions,
            antigravitySessions,
            opencodeSessions,
          };

          const totalSessions = Math.max(0, Number(project.sessionMeta?.total ?? 0) - 1);
          updatedProject.sessionMeta = {
            ...project.sessionMeta,
            total: totalSessions,
            hasMore: countLoadedProjectSessions(updatedProject) < totalSessions,
          };

          return updatedProject;
        }),
      );
    },
    [navigate, selectedSession?.id],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const response = await api.projects();
      const freshProjects = (await response.json()) as Project[];
      const mergedProjects = mergeExpandedSessionPages(projects, freshProjects);

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, mergedProjects, true) ? mergedProjects : prevProjects,
      );

      if (!selectedProject) {
        return;
      }

      const refreshedProject = mergedProjects.find((project) => project.projectId === selectedProject.projectId);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === selectedSession.id,
      );

      if (refreshedSession) {
        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        const normalizedRefreshedSession =
          refreshedSession.__provider || !selectedSession.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: selectedSession.__provider };

        if (serialize(normalizedRefreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [projects, selectedProject, selectedSession]);

  const loadMoreProjectSessions = useCallback(async (projectId: string) => {
    const project = projects.find((candidate) => candidate.projectId === projectId);
    if (!project) {
      return;
    }

    const loadedCount = countLoadedProjectSessions(project);
    const totalCount = Number(project.sessionMeta?.total ?? 0);
    if (totalCount > 0 && loadedCount >= totalCount) {
      return;
    }

    const response = await api.projectSessions(projectId, {
      limit: 20,
      offset: loadedCount,
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string | { message?: string } };
      const errorPayload = payload.error;
      const message =
        typeof errorPayload === 'string'
          ? errorPayload
          : errorPayload && typeof errorPayload === 'object' && errorPayload.message
            ? errorPayload.message
            : `Failed to load more sessions for project ${projectId}`;
      throw new Error(message);
    }

    const sessionsPage = (await response.json()) as Pick<Project, 'sessions' | 'cursorSessions' | 'codexSessions' | 'geminiSessions' | 'antigravitySessions' | 'opencodeSessions' | 'sessionMeta'>;

    let mergedProjectForSelection: Project | null = null;
    setProjects((previousProjects) =>
      previousProjects.map((candidate) => {
        if (candidate.projectId !== projectId) {
          return candidate;
        }

        const mergedProject = mergeProjectSessionPage(candidate, sessionsPage);
        mergedProjectForSelection = mergedProject;
        return mergedProject;
      }),
    );

    if (selectedProject?.projectId === projectId && mergedProjectForSelection) {
      setSelectedProject(mergedProjectForSelection);
    }
  }, [projects, selectedProject?.projectId]);

  // `projectId` is the DB identifier passed from the sidebar's delete flow
  // after the migration away from folder-derived project names.
  const handleProjectDelete = useCallback(
    (projectId: string) => {
      if (selectedProject?.projectId === projectId) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) => prevProjects.filter((project) => project.projectId !== projectId));
    },
    [navigate, selectedProject?.projectId],
  );

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onLoadMoreSessions: loadMoreProjectSessions,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      settingsDeepLink,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      loadMoreProjectSessions,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      projects,
      setActiveTab,
      settingsInitialTab,
      settingsDeepLink,
      selectedProject,
      selectedSession,
      showSettings,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    settingsDeepLink,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    loadMoreProjectSessions,
    handleProjectDelete,
    handleSidebarRefresh,
  };
}
