import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { clearSessionOutcome } from '../stores/sessionCompletionStore';
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
import type { SettingsDeepLink, SettingsMainTab } from '../components/settings/types/types';
import {
  clearSettingsDestination,
  readSettingsDestination,
  writeSettingsDestination,
} from '../components/settings/settingsUrl';
import {
  SESSION_BUCKET_KEYS,
  SESSION_BUCKET_PROVIDERS,
  sessionBucketKey,
  type SessionBucketKey,
  type SessionBuckets,
} from '../../shared/sessionBuckets';

/**
 * Reads one provider's session bucket off a project payload.
 *
 * Every path below that used to name `cursorSessions`/`codexSessions`/… by hand
 * now goes through this, because the hand-written lists all stopped at
 * `opencode` and silently dropped hermes/kimi/glm conversations (B-598).
 */
const readSessionBucket = (project: Project, key: SessionBucketKey): ProjectSession[] =>
  (project[key] as ProjectSession[] | undefined) ?? [];

/** One page of sessions for a single project: every bucket, plus the meta. */
type ProjectSessionsPage = Partial<SessionBuckets<ProjectSession>> & Pick<Project, 'sessionMeta'>;

type SessionDeepLinkContext = {
  projectId: string;
  provider: string;
  session: ProjectSession;
};

export type SessionDeepLinkResolution =
  | { status: 'idle'; sessionId: null }
  | { status: 'loading'; sessionId: string }
  | { status: 'unauthorized' | 'forbidden' | 'not_found'; sessionId: string }
  | { status: 'error'; sessionId: string; retryable: true };

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

export type ProjectsSnapshotState = 'initializing' | 'ready' | 'stale' | 'error';

const PROJECTS_SNAPSHOT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** قراءة متسامحة مع الخادم القديم الذي لا يرسل رأس حالة اللقطة. */
export const readProjectsSnapshotState = (
  response: Pick<Response, 'headers'>,
): ProjectsSnapshotState | null => {
  const value = response.headers.get('X-Nassaj-Snapshot-State')?.trim().toLowerCase();
  return value === 'initializing' || value === 'ready' || value === 'stale' || value === 'error'
    ? value
    : null;
};

/** Backoff محدود السقف؛ محاولة واحدة فقط تكون مجدولة في كل لحظة. */
export const getProjectsSnapshotRetryDelay = (attempt: number): number =>
  PROJECTS_SNAPSHOT_RETRY_DELAYS_MS[
    Math.min(Math.max(0, Math.floor(attempt)), PROJECTS_SNAPSHOT_RETRY_DELAYS_MS.length - 1)
  ];

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
      nextProject.dirExists !== prevProject.dirExists ||
      nextProject.metadataCheckedAt !== prevProject.metadataCheckedAt ||
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

    // `sessions` (claude) is already covered by `baseChanged` above; the rest of
    // the buckets are the "external sessions" this flag gates.
    return SESSION_BUCKET_KEYS.some(
      (key) =>
        key !== 'sessions' &&
        serialize(nextProject[key]) !== serialize(prevProject[key]),
    );
  });
};

const getProjectSessions = (project: Project): ProjectSession[] =>
  SESSION_BUCKET_KEYS.flatMap((key) => readSessionBucket(project, key));

const countLoadedProjectSessions = (project: Project): number => getProjectSessions(project).length;

/**
 * Carries a session's `starred` flag over from the previous payload when the
 * incoming one omits the key entirely, and returns null when nothing needed it.
 *
 * `undefined` ONLY — an explicit `false` is honoured, because that is how an
 * un-pin performed on another tab or device reaches this one (B-825).
 */
const preserveSessionStars = (
  incomingProject: Project,
  previousProject: Project,
): Partial<SessionBuckets<ProjectSession>> | null => {
  const previousStarBySessionId = new Map(
    getProjectSessions(previousProject).map((session) => [String(session.id), session.starred]),
  );

  const buckets: Partial<SessionBuckets<ProjectSession>> = {};
  let preservedAny = false;

  for (const key of SESSION_BUCKET_KEYS) {
    const sessions = readSessionBucket(incomingProject, key);
    buckets[key] = sessions.map((session) => {
      const previousStarred = previousStarBySessionId.get(String(session.id));
      if (session.starred !== undefined || previousStarred === undefined) {
        return session;
      }
      preservedAny = true;
      return { ...session, starred: previousStarred };
    });
  }

  return preservedAny ? buckets : null;
};

// Defense in depth for `projects_updated` broadcasts: when an incoming payload
// omits a per-user field, keep the value last delivered by the authenticated
// `GET /api/projects` fetch instead of silently dropping it. Project-level
// `isMember`/`isOwner` empty the sidebar's "My projects"/"Team" filters when
// lost; session-level `starred` empties the pin. This only covers version skew
// against a server that predates the per-recipient broadcast — the real fix for
// B-825 is that the server now builds one payload per recipient identity.
const preserveUserScopedFlags = (incomingProjects: Project[], previousProjects: Project[]): Project[] => {
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

    const preservedBuckets = preserveSessionStars(project, previousProject);
    if (Object.keys(preservedFlags).length === 0 && preservedBuckets === null) {
      return project;
    }

    return { ...project, ...preservedFlags, ...preservedBuckets };
  });
};

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

    const mergedProject: Project = { ...incomingProject };
    for (const key of SESSION_BUCKET_KEYS) {
      mergedProject[key] = mergeSessionProviderLists(
        readSessionBucket(incomingProject, key),
        readSessionBucket(previousProject, key),
      );
    }

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
  sessionsPage: ProjectSessionsPage,
): Project => {
  const mergedProject: Project = { ...existingProject };
  for (const key of SESSION_BUCKET_KEYS) {
    mergedProject[key] = mergeSessionProviderLists(
      readSessionBucket(existingProject, key),
      readSessionBucket(sessionsPage as Project, key),
    );
  }

  const totalSessions = Number(sessionsPage.sessionMeta?.total ?? existingProject.sessionMeta?.total ?? 0);
  mergedProject.sessionMeta = {
    ...existingProject.sessionMeta,
    ...sessionsPage.sessionMeta,
    total: totalSessions,
    hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
  };

  return mergedProject;
};

/** Add the one conversation resolved for a direct URL to its existing project. */
export const mergeDeepLinkedSession = (
  projects: Project[],
  context: SessionDeepLinkContext,
): Project[] => {
  if (!SESSION_BUCKET_PROVIDERS.includes(context.provider as LLMProvider)) {
    return projects;
  }

  const bucket = sessionBucketKey(context.provider as LLMProvider);
  return projects.map((project) =>
    project.projectId === context.projectId
      ? mergeProjectSessionPage(project, {
          [bucket]: [context.session],
          sessionMeta: project.sessionMeta,
        })
      : project,
  );
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
  return VALID_TABS.has(tab);
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
  const [deepLinkResolution, setDeepLinkResolution] = useState<SessionDeepLinkResolution>({
    status: 'idle',
    sessionId: null,
  });
  const [deepLinkRetrySequence, setDeepLinkRetrySequence] = useState(0);

  // A sidebar refresh may have started before the close request completed, so
  // its response can still say `closed: false`. Keep that older snapshot from
  // overwriting the action the user has just seen. The marker is removed as
  // soon as a later server payload confirms the same value.
  const optimisticClosedBySessionRef = useRef(new Map<string, boolean>());

  /**
   * Reflect a close/reopen action in the authoritative UI selection immediately.
   *
   * The close endpoint persists the marker, but its `projects_updated` payload is
   * asynchronous.  The main header reads `selectedSession`, so waiting for that
   * payload left it displaying a stale snapshot until a page refresh.  Keep the
   * selected record in sync at the state owner instead of relying on a sibling
   * component event bridge.
   */
  const handleSelectedSessionClosedChange = useCallback((targetSessionId: string, closed: boolean) => {
    optimisticClosedBySessionRef.current.set(targetSessionId, closed);
    setSelectedSession((current) =>
      current?.id === targetSessionId ? { ...current, closed } : current,
    );
  }, []);

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
  // Seed the settings surface from the address bar during the first render.
  // Waiting for the effect below left a direct shared settings URL rendering
  // the workspace first, and could lose the destination while the app booted.
  const [showSettings, setShowSettings] = useState(() => Boolean(readSettingsDestination()));
  const [settingsInitialTab, setSettingsInitialTab] = useState(
    () => readSettingsDestination()?.tab ?? 'agents',
  );
  const [settingsDeepLink, setSettingsDeepLink] = useState<SettingsDeepLink | undefined>(
    () => readSettingsDestination(),
  );
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);
  const [projectsSnapshotSignal, setProjectsSnapshotSignal] = useState<{
    state: ProjectsSnapshotState | null;
    sequence: number;
  }>({ state: null, sequence: 0 });

  useEffect(() => {
    const syncSettingsFromLocation = () => {
      const destination = readSettingsDestination();
      if (destination) {
        setSettingsInitialTab(destination.tab);
        setSettingsDeepLink(destination);
        setShowSettings(true);
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const oauthStatus = params.get('connectorOAuth');
      if (params.get('settings') === 'connectors'
        && ['linked', 'failed', 'unavailable'].includes(oauthStatus ?? '')) {
        setSettingsInitialTab('connectors');
        setSettingsDeepLink({ tab: 'connectors' });
        setShowSettings(true);
        return;
      }

      setSettingsDeepLink(undefined);
      setShowSettings(false);
    };

    syncSettingsFromLocation();
    window.addEventListener('popstate', syncSettingsFromLocation);
    return () => window.removeEventListener('popstate', syncSettingsFromLocation);
  }, []);
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
  const resolvingDeepLinkSessionIdRef = useRef<string | null>(null);
  const resolvedDeepLinkSessionIdRef = useRef<string | null>(null);
  const deepLinkRequestSequenceRef = useRef(0);
  /**
   * Session route that an explicit New Session action is leaving.
   *
   * `navigate('/')` does not update the `sessionId` route prop in the same render
   * as the click. Route-synchronisation effects must not reselect this stale id
   * while React Router is committing the navigation.
   */
  const departingSessionIdRef = useRef<string | null>(null);
  const projectsSnapshotRetryAttemptRef = useRef(0);
  const projectsSnapshotStateRef = useRef<ProjectsSnapshotState | null>(null);

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
      const snapshotState = readProjectsSnapshotState(response);
      projectsSnapshotStateRef.current = snapshotState;
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
      // sequence يضمن إعادة جدولة المحاولة التالية حتى إن بقيت الحالة stale.
      setProjectsSnapshotSignal((previous) => ({
        state: snapshotState,
        sequence: previous.sequence + 1,
      }));
    } catch (error) {
      console.error('Error fetching projects:', error);
      // عطل شبكة عابر أثناء انتظار اللقطة لا يوقف دورة الجاهزية نهائياً.
      const snapshotState = projectsSnapshotStateRef.current;
      if (
        snapshotState === 'initializing' ||
        snapshotState === 'stale' ||
        snapshotState === 'error'
      ) {
        setProjectsSnapshotSignal((previous) => ({
          state: snapshotState,
          sequence: previous.sequence + 1,
        }));
      }
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
    const normalizedTab: SettingsMainTab = tab === 'tools' ? 'agents' : tab as SettingsMainTab;
    const destination = deepLink ?? { tab: normalizedTab };
    setSettingsInitialTab(destination.tab);
    setSettingsDeepLink(destination);
    writeSettingsDestination(destination);
    setShowSettings(true);
  }, []);

  const closeSettings = useCallback(() => {
    clearSettingsDestination();
    setSettingsDeepLink(undefined);
    setShowSettings(false);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    const snapshotState = projectsSnapshotSignal.state;
    if (
      snapshotState !== 'initializing' &&
      snapshotState !== 'stale' &&
      snapshotState !== 'error'
    ) {
      projectsSnapshotRetryAttemptRef.current = 0;
      return;
    }

    const attempt = projectsSnapshotRetryAttemptRef.current;
    const timeout = setTimeout(() => {
      projectsSnapshotRetryAttemptRef.current = attempt + 1;
      void fetchProjects({ showLoadingState: false });
    }, getProjectsSnapshotRetryDelay(attempt));

    return () => clearTimeout(timeout);
  }, [fetchProjects, projectsSnapshotSignal]);

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

    const incomingProjectsWithUserFlags = preserveUserScopedFlags(projectsMessage.projects, projects);
    const updatedProjects = mergeExpandedSessionPages(projects, incomingProjectsWithUserFlags);

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
    if (
      departingSessionIdRef.current !== null &&
      sessionId !== departingSessionIdRef.current
    ) {
      departingSessionIdRef.current = null;
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      resolvingDeepLinkSessionIdRef.current = null;
      resolvedDeepLinkSessionIdRef.current = null;
      setDeepLinkResolution({ status: 'idle', sessionId: null });
      return;
    }

    if (projects.length === 0 || selectedSession?.id === sessionId) {
      if (selectedSession?.id === sessionId) {
        setDeepLinkResolution({ status: 'idle', sessionId: null });
      }
      return;
    }

    if (departingSessionIdRef.current === sessionId) {
      return;
    }

    const isAlreadyListed = projects.some((project) =>
      getProjectSessions(project).some((session) => session.id === sessionId),
    );
    if (isAlreadyListed) {
      setDeepLinkResolution({ status: 'idle', sessionId: null });
      return;
    }
    if (resolvedDeepLinkSessionIdRef.current === sessionId || resolvingDeepLinkSessionIdRef.current === sessionId) {
      return;
    }

    resolvingDeepLinkSessionIdRef.current = sessionId;
    const requestSequence = ++deepLinkRequestSequenceRef.current;
    const controller = new AbortController();
    let definitiveResult = false;
    setDeepLinkResolution({ status: 'loading', sessionId });

    void api.sessionContext(sessionId, { signal: controller.signal })
      .then(async (response) => {
        if (requestSequence !== deepLinkRequestSequenceRef.current || controller.signal.aborted) {
          return null;
        }
        if (response.status === 401) {
          definitiveResult = true;
          setDeepLinkResolution({ status: 'unauthorized', sessionId });
          return null;
        }
        if (response.status === 403) {
          definitiveResult = true;
          setDeepLinkResolution({ status: 'forbidden', sessionId });
          return null;
        }
        if (response.status === 404) {
          definitiveResult = true;
          setDeepLinkResolution({ status: 'not_found', sessionId });
          return null;
        }
        if (!response.ok) {
          setDeepLinkResolution({ status: 'error', sessionId, retryable: true });
          return null;
        }
        return response.json() as Promise<SessionDeepLinkContext>;
      })
      .then((context) => {
        if (
          requestSequence !== deepLinkRequestSequenceRef.current ||
          controller.signal.aborted ||
          !context ||
          departingSessionIdRef.current === sessionId
        ) {
          return;
        }

        const targetProject = projects.find((project) => project.projectId === context.projectId);
        if (!targetProject || !SESSION_BUCKET_PROVIDERS.includes(context.provider as LLMProvider)) {
          setDeepLinkResolution({ status: 'error', sessionId, retryable: true });
          return;
        }

        const provider = context.provider as LLMProvider;
        const selected = { ...context.session, __provider: provider, __projectId: context.projectId };
        const mergedProjects = mergeDeepLinkedSession(projects, context);
        setProjects(mergedProjects);
        setSelectedProject(mergedProjects.find((project) => project.projectId === context.projectId) ?? targetProject);
        setSelectedSession(selected);
        definitiveResult = true;
        setDeepLinkResolution({ status: 'idle', sessionId: null });
      })
      .catch((error) => {
        if (
          requestSequence !== deepLinkRequestSequenceRef.current ||
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return;
        }
        console.error('Error resolving session deep link:', error);
        setDeepLinkResolution({ status: 'error', sessionId, retryable: true });
      })
      .finally(() => {
        if (
          requestSequence === deepLinkRequestSequenceRef.current &&
          resolvingDeepLinkSessionIdRef.current === sessionId
        ) {
          resolvingDeepLinkSessionIdRef.current = null;
        }
        // Only a successful lookup or a definitive access/not-found response is
        // resolved. Network/5xx failures and cancelled stale requests stay
        // retryable and must never fence off a later attempt.
        if (
          definitiveResult &&
          requestSequence === deepLinkRequestSequenceRef.current &&
          !controller.signal.aborted &&
          departingSessionIdRef.current !== sessionId
        ) {
          resolvedDeepLinkSessionIdRef.current = sessionId;
        }
      });

    return () => {
      controller.abort();
      if (resolvingDeepLinkSessionIdRef.current === sessionId) {
        resolvingDeepLinkSessionIdRef.current = null;
      }
    };
  }, [deepLinkRetrySequence, projects, selectedSession?.id, sessionId]);

  const retryDeepLinkResolution = useCallback(() => {
    if (!sessionId) return;
    resolvedDeepLinkSessionIdRef.current = null;
    resolvingDeepLinkSessionIdRef.current = null;
    setDeepLinkRetrySequence((sequence) => sequence + 1);
  }, [sessionId]);

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

    if (departingSessionIdRef.current === sessionId) {
      return;
    }

    // Project membership is resolved through `projectId` after the migration.
    // Buckets are scanned in provider order (shared/sessionBuckets.ts) rather
    // than as six copy-pasted blocks; the copies were what left hermes/kimi/glm
    // sessions unopenable from a URL even once they reached the payload (B-598).
    for (const project of projects) {
      for (const provider of SESSION_BUCKET_PROVIDERS) {
        const session = readSessionBucket(project, sessionBucketKey(provider))
          .find((candidate) => candidate.id === sessionId);
        if (!session) {
          continue;
        }

        if (selectedProject?.projectId !== project.projectId) {
          setSelectedProject(project);
        }
        if (selectedSession?.id !== sessionId || selectedSession.__provider !== provider) {
          setSelectedSession({ ...session, __provider: provider });
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
      departingSessionIdRef.current = sessionId ?? null;
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate, sessionId],
  );

  /** Selects a project resolved from a project-tool URL without a second navigation. */
  const selectProjectForTool = useCallback(
    (project: Project) => {
      departingSessionIdRef.current = sessionId ?? null;
      setSelectedProject(project);
      setSelectedSession(null);
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile, sessionId],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      setSelectedSession(session);

      setActiveTab('chat');

      const provider = localStorage.getItem('selected-provider') || 'claude';
      if (provider === 'cursor') {
        sessionStorage.setItem('cursorSessionId', session.id);
      }

      if (isMobile) setSidebarOpen(false);

      navigate(`/session/${session.id}`);
    },
    [isMobile, navigate],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      departingSessionIdRef.current = sessionId ?? null;
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab('chat');
      setNewSessionTrigger((previous) => previous + 1);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate, sessionId],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      /**
       * B-544 — حالةُ جلسةٍ حُذفت تُحذف معها.
       *
       * إطفاءُ المؤشّر معلّقٌ على **فتح** المحادثة، ومحادثةٌ حُذفت لا صفَّ لها
       * يُفتح — فتبقى علامتُها على عنوان التبويب أبداً بلا سبيل إلى إزالتها.
       */
      clearSessionOutcome(sessionIdToDelete);

      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) =>
        prevProjects.map((project) => {
          const remainingByKey = new Map<SessionBucketKey, ProjectSession[]>();
          let removedFromProject = false;

          for (const key of SESSION_BUCKET_KEYS) {
            const bucket = readSessionBucket(project, key);
            const remaining = bucket.filter((session) => session.id !== sessionIdToDelete);
            remainingByKey.set(key, remaining);
            if (remaining.length !== bucket.length) {
              removedFromProject = true;
            }
          }

          if (!removedFromProject) {
            return project;
          }

          const updatedProject: Project = { ...project };
          for (const [key, remaining] of remainingByKey) {
            updatedProject[key] = remaining;
          }

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
      const snapshotState = readProjectsSnapshotState(response);
      projectsSnapshotStateRef.current = snapshotState;
      const freshProjects = (await response.json()) as Project[];
      const mergedProjects = mergeExpandedSessionPages(projects, freshProjects);

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, mergedProjects, true) ? mergedProjects : prevProjects,
      );
      setProjectsSnapshotSignal((previous) => ({
        state: snapshotState,
        sequence: previous.sequence + 1,
      }));

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

      setSelectedSession((current) => {
        if (!current) return current;

        const refreshedSession = getProjectSessions(refreshedProject).find(
          (session) => session.id === current.id,
        );
        if (!refreshedSession) return current;

        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        let normalizedRefreshedSession =
          refreshedSession.__provider || !current.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: current.__provider };

        const optimisticClosed = optimisticClosedBySessionRef.current.get(current.id);
        if (optimisticClosed !== undefined) {
          if (normalizedRefreshedSession.closed === optimisticClosed) {
            // The server has caught up; future refreshes are authoritative again.
            optimisticClosedBySessionRef.current.delete(current.id);
          } else {
            normalizedRefreshedSession = { ...normalizedRefreshedSession, closed: optimisticClosed };
          }
        }

        return serialize(normalizedRefreshedSession) === serialize(current)
          ? current
          : normalizedRefreshedSession;
      });
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [projects, selectedProject]);

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

    const sessionsPage = (await response.json()) as ProjectSessionsPage;

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

  // Archive removes the project from the list without resetting selection or
  // navigating — the selected project/session remain valid until the user acts.
  const handleProjectArchive = useCallback(
    (projectId: string) => {
      setProjects((prevProjects) => prevProjects.filter((project) => project.projectId !== projectId));
    },
    [],
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
      onProjectArchive: handleProjectArchive,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: (destination?: SettingsDeepLink) => openSettings(destination?.tab ?? 'agents', destination),
      isMobile,
    }),
    [
      handleNewSession,
      handleProjectDelete,
      handleProjectArchive,
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
      selectedProject,
      selectedSession,
      openSettings,
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
    deepLinkResolution,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    closeSettings,
    fetchProjects,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleProjectSelect,
    selectProjectForTool,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    loadMoreProjectSessions,
    handleProjectDelete,
    handleProjectArchive,
    handleSidebarRefresh,
    handleSelectedSessionClosedChange,
    retryDeepLinkResolution,
  };
}
