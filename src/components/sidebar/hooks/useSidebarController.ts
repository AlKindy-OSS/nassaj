import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { api } from '../../../utils/api';
import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type {
  ArchivedProjectListItem,
  ArchivedSessionListItem,
  ArchiveProjectConfirmation,
  DeleteProjectConfirmation,
  ProjectSortOrder,
  SidebarSearchMode,
  SidebarSearchScope,
  SidebarSection,
  SessionDeleteConfirmation,
  SessionWithProvider,
} from '../types/types';
import {
  clearLegacyMembershipFilter,
  clearLegacyStarredProjectIds,
  compareSidebarSessions,
  filterProjects,
  getAllSessions,
  getMatchedSessionIds,
  normalizeForSearch,
  readLegacyStarredProjectIds,
  readProjectSortOrder,
  readSidebarHideClosed,
  readSidebarSearchScope,
  readSidebarSection,
  selectClosedVisibleSessions,
  selectSearchVisibleSessions,
  sortProjects,
  writeSidebarHideClosed,
  writeSidebarSearchScope,
  writeSidebarSection,
} from '../utils/utils';

import { useSidebarMessageSearch } from './useSidebarMessageSearch';

type ArchivedSessionsApiPayload = {
  success?: boolean;
  data?: {
    sessions?: ArchivedSessionListItem[];
  };
};

type ArchivedProjectsApiPayload = {
  success?: boolean;
  data?: {
    projects?: ArchivedProjectListItem[];
  };
};

type StarMutation = {
  desired: boolean;
  confirmed: boolean;
};

export type BulkSelectionKind = 'projects' | 'sessions';
export type BulkProjectAction = 'archive' | 'restore' | 'delete_permanently';
export type BulkSessionAction = 'archive' | 'restore' | 'close' | 'reopen' | 'delete_permanently';

type UseSidebarControllerArgs = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  isMobile: boolean;
  t: TFunction;
  onRefresh: () => Promise<void> | void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onSessionDelete?: (sessionId: string) => void;
  onLoadMoreSessions?: (projectId: string) => Promise<void> | void;
  // `projectId` is the DB-assigned identifier; callbacks use that post-migration.
  onProjectDelete?: (projectId: string) => void;
  onProjectArchive?: (projectId: string) => void;
  setSidebarVisible: (visible: boolean) => void;
  sidebarVisible: boolean;
  /** Server capability from /health. Missing means unavailable, never assumed. */
  bulkLifecycleActions: boolean;
  // T-940: notified when the top-level section (Terminals/Projects) changes, so
  // AppContent can mirror it onto the main-content surface.
  onSectionChange?: (section: SidebarSection) => void;
};

export function useSidebarController({
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
  setSidebarVisible,
  sidebarVisible,
  bulkLifecycleActions,
  onSectionChange,
}: UseSidebarControllerArgs) {
  const paletteOps = usePaletteOps();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [editingName, setEditingName] = useState('');
  const [initialSessionsLoaded, setInitialSessionsLoaded] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  // Top-level section (T-940): Terminals vs Projects, persisted per-browser.
  const [activeSection, setActiveSectionState] = useState<SidebarSection>(readSidebarSection);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [deletingProjects, setDeletingProjects] = useState<Set<string>>(new Set());
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteProjectConfirmation | null>(null);
  const [archiveConfirmation, setArchiveConfirmation] = useState<ArchiveProjectConfirmation | null>(null);
  const [sessionDeleteConfirmation, setSessionDeleteConfirmation] = useState<SessionDeleteConfirmation | null>(null);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [searchMode, setSearchMode] = useState<SidebarSearchMode>('projects');
  // What the query is matched against (B-332). Persisted per-browser.
  const [searchScope, setSearchScopeState] = useState<SidebarSearchScope>(readSidebarSearchScope);
  // Hide closed conversations from the project lists. Per-browser preference,
  // default off.
  const [hideClosedSessions, setHideClosedSessionsState] = useState<boolean>(readSidebarHideClosed);
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProjectListItem[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSessionListItem[]>([]);
  const [isArchivedSessionsLoading, setIsArchivedSessionsLoading] = useState(false);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [optimisticStarByProjectId, setOptimisticStarByProjectId] = useState<Map<string, boolean>>(new Map());
  const [loadingMoreProjects, setLoadingMoreProjects] = useState<Set<string>>(new Set());
  // Selection deliberately has one kind at a time. Mixing project and
  // conversation IDs makes destructive actions ambiguous and is especially
  // error-prone on narrow sidebars.
  const [bulkSelectionKind, setBulkSelectionKind] = useState<BulkSelectionKind | null>(null);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkMutating, setIsBulkMutating] = useState(false);
  // Optimistic per-session star state, keyed by sessionId. Flip locally on
  // click, then reconcile to the server's authoritative `starred` once it
  // responds (POST /api/sessions/star returns the new value). The map is
  // pruned whenever the projects payload already reflects the optimistic value.
  const [optimisticStarBySessionId, setOptimisticStarBySessionId] = useState<Map<string, boolean>>(new Map());
  // One mutation runner per id. While a request is in flight, further clicks
  // only replace `desired`; the runner then sends that latest absolute state.
  // This prevents out-of-order toggle responses from leaving the server at an
  // older intent than the UI.
  const sessionStarMutationsRef = useRef<Map<string, StarMutation>>(new Map());
  const projectStarMutationsRef = useRef<Map<string, StarMutation>>(new Map());
  const migrationStartedRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);

  const isSidebarCollapsed = !isMobile && !sidebarVisible;

  // T-940: drop the retired membership-filter key once on mount.
  useEffect(() => {
    clearLegacyMembershipFilter();
  }, []);

  // Persist the section and notify the parent so the main-content surface mirrors
  // it. Defaults to 'projects'.
  const setActiveSection = useCallback(
    (section: SidebarSection) => {
      setActiveSectionState(section);
      writeSidebarSection(section);
      onSectionChange?.(section);
    },
    [onSectionChange],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setInitialSessionsLoaded(new Set());
  }, [projects]);

  useEffect(() => {
    // Auto-expand only when the selected project identity changes.
    // Depending on the full `selectedProject` object (or `selectedSession`) causes
    // websocket-driven list refreshes to re-open projects users manually collapsed.
    const selectedProjectId = selectedProject?.projectId;
    if (!selectedProjectId) {
      return;
    }

    setExpandedProjects((prev) => {
      if (prev.has(selectedProjectId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(selectedProjectId);
      return next;
    });
  }, [selectedProject?.projectId]);

  useEffect(() => {
    if (projects.length > 0 && !isLoading) {
      const loadedProjects = new Set<string>();
      projects.forEach((project) => {
        if (project.sessions && project.sessions.length >= 0) {
          loadedProjects.add(project.projectId);
        }
      });
      setInitialSessionsLoaded(loadedProjects);
    }
  }, [projects, isLoading]);

  useEffect(() => {
    const loadSortOrder = () => {
      setProjectSortOrder(readProjectSortOrder());
    };

    loadSortOrder();

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'claude-settings') {
        loadSortOrder();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    const interval = setInterval(() => {
      if (document.hasFocus()) {
        loadSortOrder();
      }
    }, 1000);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const fetchArchivedSessions = useCallback(async () => {
    setIsArchivedSessionsLoading(true);

    try {
      const [archivedProjectsResponse, archivedSessionsResponse] = await Promise.all([
        api.archivedProjects(),
        api.getArchivedSessions(),
      ]);

      if (!archivedProjectsResponse.ok) {
        throw new Error(`Failed to load archived projects: ${archivedProjectsResponse.status}`);
      }

      if (!archivedSessionsResponse.ok) {
        throw new Error(`Failed to load archived sessions: ${archivedSessionsResponse.status}`);
      }

      const archivedProjectsPayload = (await archivedProjectsResponse.json()) as ArchivedProjectsApiPayload;
      const archivedSessionsPayload = (await archivedSessionsResponse.json()) as ArchivedSessionsApiPayload;
      const nextProjects = Array.isArray(archivedProjectsPayload.data?.projects) ? archivedProjectsPayload.data.projects : [];
      const archivedProjectIds = new Set(nextProjects.map((project) => project.projectId));
      const nextStandaloneSessions = Array.isArray(archivedSessionsPayload.data?.sessions)
        ? archivedSessionsPayload.data.sessions.filter((session) => !session.projectId || !archivedProjectIds.has(session.projectId))
        : [];

      setArchivedProjects(nextProjects);
      setArchivedSessions(nextStandaloneSessions);
    } catch (error) {
      console.error('[Sidebar] Failed to load archived sessions:', error);
    } finally {
      setIsArchivedSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (migrationStartedRef.current) {
      return;
    }

    const legacyStarredProjectIds = readLegacyStarredProjectIds();
    if (legacyStarredProjectIds.length === 0) {
      return;
    }

    migrationStartedRef.current = true;

    const migrateLegacyStars = async () => {
      try {
        await api.migrateLegacyProjectStars(legacyStarredProjectIds);
        await onRefreshRef.current();
      } catch (error) {
        console.error('[Sidebar] Failed to migrate legacy starred projects:', error);
      } finally {
        clearLegacyStarredProjectIds();
      }
    };

    void migrateLegacyStars();
  }, [onRefresh]);

  useEffect(() => {
    void fetchArchivedSessions();
  }, [fetchArchivedSessions]);

  useEffect(() => {
    if (searchMode !== 'archived') {
      return;
    }

    // Refresh archive contents when the archived tab opens so restore actions
    // and background synchronizer updates are reflected without a full reload.
    void fetchArchivedSessions();
  }, [fetchArchivedSessions, searchMode]);

  useEffect(() => {
    setOptimisticStarByProjectId((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const next = new Map(previous);
      let changed = false;

      for (const [projectId, optimisticValue] of previous.entries()) {
        const project = projects.find((candidate) => candidate.projectId === projectId);
        if (!project) {
          next.delete(projectId);
          changed = true;
          continue;
        }

        if (Boolean(project.isStarred) === optimisticValue) {
          next.delete(projectId);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [projects]);

  // Drop optimistic session stars once the projects payload (which carries the
  // per-session `starred` flag) already reflects the optimistic value, so the
  // server stays the source of truth after a refresh.
  useEffect(() => {
    setOptimisticStarBySessionId((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const serverStarBySessionId = new Map<string, boolean>();
      for (const project of projects) {
        for (const session of getAllSessions(project)) {
          serverStarBySessionId.set(session.id, Boolean(session.starred));
        }
      }

      const next = new Map(previous);
      let changed = false;

      for (const [sessionId, optimisticValue] of previous.entries()) {
        // Keep the optimistic value while the session is absent from the
        // current payload (e.g. not yet loaded), since the user just acted on it.
        if (!serverStarBySessionId.has(sessionId)) {
          continue;
        }

        if (serverStarBySessionId.get(sessionId) === optimisticValue) {
          next.delete(sessionId);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [projects]);

  // Debounce search text updates so project and archive filtering avoid
  // running on every keypress.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearchQuery(searchFilter.trim());
    }, 300);

    return () => {
      clearTimeout(timeout);
    };
  }, [searchFilter]);

  const setSearchScope = useCallback((scope: SidebarSearchScope) => {
    setSearchScopeState(scope);
    writeSidebarSearchScope(scope);
  }, []);

  const setHideClosedSessions = useCallback((hideClosed: boolean) => {
    setHideClosedSessionsState(hideClosed);
    writeSidebarHideClosed(hideClosed);
  }, []);

  // Message-body matches (B-332). Only the projects view searches conversations;
  // the archive view stays title-only, and 'titles' scope disables the scan.
  const messageSearch = useSidebarMessageSearch(
    debouncedSearchQuery,
    searchScope !== 'titles' && searchMode === 'projects',
  );

  // Row-level snippets, keyed by session — what SidebarSessionItem renders.
  const messageSearchSnippets = useMemo(() => {
    const snippets = new Map<string, string>();
    for (const match of messageSearch.matchBySessionId.values()) {
      snippets.set(match.sessionId, match.snippet);
    }
    return snippets;
  }, [messageSearch.matchBySessionId]);

  // Projects owning ≥1 conversation whose body matched. `projectIds` comes
  // straight from the server payload; the session-id fallback covers rows whose
  // project could not be resolved server-side.
  const messageMatchedProjectIds = useMemo(() => {
    if (messageSearch.matchBySessionId.size === 0 && messageSearch.projectIds.size === 0) {
      return new Set<string>();
    }

    const matched = new Set(messageSearch.projectIds);
    for (const project of projects) {
      if (matched.has(project.projectId)) {
        continue;
      }
      if (getAllSessions(project).some((session) => messageSearch.matchBySessionId.has(session.id))) {
        matched.add(project.projectId);
      }
    }
    return matched;
  }, [messageSearch.matchBySessionId, messageSearch.projectIds, projects]);

  // Auto-expand projects whose sessions match the search query (but whose own
  // name does not), so the user sees the matching sessions without having to
  // open each project manually.  When the search is cleared the expanded set
  // returns to its previous state (the effect below is additive only).
  useEffect(() => {
    if (!debouncedSearchQuery) {
      return;
    }

    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase()
      // Strip Arabic diacritics – mirrors normalizeForSearch in utils.ts.
      .replace(/[ً-ٟ]/g, '');

    if (!normalizedSearch) {
      return;
    }

    setExpandedProjects((prev) => {
      let changed = false;
      const next = new Set(prev);

      for (const project of projects) {
        // Already expanded — nothing to do.
        if (next.has(project.projectId)) {
          continue;
        }

        // A message-body match always lives inside a session, so the project
        // must open for the matching row (and its snippet) to be reachable.
        if (messageMatchedProjectIds.has(project.projectId)) {
          next.add(project.projectId);
          changed = true;
          continue;
        }

        // If the project name itself matched there is no need to force-expand
        // (the project is visible but there is no session filter to reveal).
        const projectNameNorm = (project.displayName || project.projectId)
          .toLowerCase()
          .replace(/[ً-ٟ]/g, '');
        const pathNorm = (project.path || project.fullPath || '')
          .toLowerCase()
          .replace(/[ً-ٟ]/g, '');

        if (projectNameNorm.includes(normalizedSearch) || pathNorm.includes(normalizedSearch)) {
          continue;
        }

        if (getMatchedSessionIds(project, normalizedSearch).size > 0) {
          next.add(project.projectId);
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [debouncedSearchQuery, messageMatchedProjectIds, projects]);

  // All sidebar state keys (expanded, starred, loading, etc.) use the DB
  // `projectId` as their identifier after the migration.
  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  const handleSessionClick = useCallback(
    (session: SessionWithProvider, projectId: string) => {
      // Tag the session with its owning projectId so downstream handlers
      // can correlate it with the selectedProject in the app state.
      onSessionSelect({ ...session, __projectId: projectId });
    },
    [onSessionSelect],
  );

  const resolveProjectStarState = useCallback(
    (projectId: string): boolean => {
      if (optimisticStarByProjectId.has(projectId)) {
        return Boolean(optimisticStarByProjectId.get(projectId));
      }

      return projects.some((project) => project.projectId === projectId && Boolean(project.isStarred));
    },
    [optimisticStarByProjectId, projects],
  );

  const toggleStarProject = useCallback((projectId: string) => {
    const activeMutation = projectStarMutationsRef.current.get(projectId);
    const previousStarState = activeMutation?.desired ?? resolveProjectStarState(projectId);
    const optimisticStarState = !previousStarState;

    setOptimisticStarByProjectId((previous) => {
      const next = new Map(previous);
      next.set(projectId, optimisticStarState);
      return next;
    });

    if (activeMutation) {
      activeMutation.desired = optimisticStarState;
      return;
    }

    const mutation: StarMutation = {
      desired: optimisticStarState,
      confirmed: previousStarState,
    };
    projectStarMutationsRef.current.set(projectId, mutation);

    const updateStar = async () => {
      while (projectStarMutationsRef.current.get(projectId) === mutation) {
        const requestedState = mutation.desired;
        try {
          const response = await api.toggleProjectStar(projectId, requestedState);
          if (!response.ok) {
            const payload = (await response.json()) as { error?: string | { message?: string } };
            const errorPayload = payload.error;
            const message =
              typeof errorPayload === 'string'
                ? errorPayload
                : errorPayload && typeof errorPayload === 'object' && errorPayload.message
                  ? errorPayload.message
                  : t('messages.updateProjectError');
            throw new Error(message);
          }

          const payload = (await response.json()) as { isStarred?: boolean };
          mutation.confirmed = Boolean(payload.isStarred ?? requestedState);
        } catch (error) {
          if (mutation.desired !== requestedState) {
            continue;
          }

          setOptimisticStarByProjectId((previous) => {
            const next = new Map(previous);
            next.set(projectId, mutation.confirmed);
            return next;
          });
          console.error('[Sidebar] Failed to toggle project star:', error);
          alert(t('messages.updateProjectError'));
          projectStarMutationsRef.current.delete(projectId);
          return;
        }

        if (mutation.desired !== requestedState) {
          continue;
        }

        setOptimisticStarByProjectId((previous) => {
          const next = new Map(previous);
          next.set(projectId, mutation.confirmed);
          return next;
        });
        projectStarMutationsRef.current.delete(projectId);
        return;
      }
    };

    void updateStar();
  }, [resolveProjectStarState, t]);

  const isProjectStarred = useCallback(
    (projectId: string) => resolveProjectStarState(projectId),
    [resolveProjectStarState],
  );

  // Resolve a session's star state: optimistic value wins while a toggle is in
  // flight, otherwise fall back to the server-stamped `starred` field.
  const resolveSessionStarState = useCallback(
    (session: SessionWithProvider): boolean => {
      if (optimisticStarBySessionId.has(session.id)) {
        return Boolean(optimisticStarBySessionId.get(session.id));
      }
      return Boolean(session.starred);
    },
    [optimisticStarBySessionId],
  );

  // Toggle a session's per-user star. Flip optimistically (so the icon fills and
  // the row floats to the top immediately), call the idempotent endpoint, then
  // reconcile to the server's returned value. Errors roll the value back.
  // `projectName` is the owning project's DB id, used by the server to scope the row.
  const toggleStarSession = useCallback(
    (session: SessionWithProvider, projectName: string) => {
      const activeMutation = sessionStarMutationsRef.current.get(session.id);
      const previousStarState = activeMutation?.desired ?? resolveSessionStarState(session);
      const optimisticStarState = !previousStarState;
      const sessionId = session.id;

      setOptimisticStarBySessionId((previous) => {
        const next = new Map(previous);
        next.set(sessionId, optimisticStarState);
        return next;
      });

      if (activeMutation) {
        activeMutation.desired = optimisticStarState;
        return;
      }

      const mutation: StarMutation = {
        desired: optimisticStarState,
        confirmed: previousStarState,
      };
      sessionStarMutationsRef.current.set(sessionId, mutation);

      const run = async () => {
        while (sessionStarMutationsRef.current.get(sessionId) === mutation) {
          const requestedState = mutation.desired;
          try {
            const response = await api.starSession(sessionId, projectName, requestedState);
            if (!response.ok) {
              throw new Error(`star request failed (${response.status})`);
            }

            const payload = (await response.json()) as { data?: { starred?: boolean } };
            mutation.confirmed = Boolean(payload.data?.starred ?? requestedState);
          } catch (error) {
            if (mutation.desired !== requestedState) {
              continue;
            }

            setOptimisticStarBySessionId((previous) => {
              const next = new Map(previous);
              next.set(sessionId, mutation.confirmed);
              return next;
            });
            console.error('[Sidebar] Failed to toggle session star:', error);
            sessionStarMutationsRef.current.delete(sessionId);
            return;
          }

          if (mutation.desired !== requestedState) {
            continue;
          }

          setOptimisticStarBySessionId((previous) => {
            const next = new Map(previous);
            next.set(sessionId, mutation.confirmed);
            return next;
          });
          sessionStarMutationsRef.current.delete(sessionId);
          return;
        }
      };

      void run();
    },
    [resolveSessionStarState],
  );

  const isSessionStarred = useCallback(
    // Rows are rendered from `getProjectSessions`, which has already overlaid
    // the optimistic state onto the session object before it sorts the list.
    // Read that same object here instead of consulting the map a second time.
    // Otherwise a payload/effect reconciliation between those two reads can
    // leave a row in the unpinned position while its bookmark still uses the
    // preceding (pinned) value for one render.
    (session: SessionWithProvider) => Boolean(session.starred),
    [],
  );

  // Build the project's session list, then overlay any optimistic star state so
  // a just-clicked session fills its icon and floats to the top without waiting
  // for the next refresh. getAllSessions already sorts starred-first by `starred`.
  const getProjectSessions = useCallback(
    (project: Project) => {
      const sessions = getAllSessions(project);
      if (optimisticStarBySessionId.size === 0) {
        return sessions;
      }

      let mutated = false;
      const overlaid = sessions.map((session) => {
        if (!optimisticStarBySessionId.has(session.id)) {
          return session;
        }
        const optimisticStar = Boolean(optimisticStarBySessionId.get(session.id));
        if (Boolean(session.starred) === optimisticStar) {
          return session;
        }
        mutated = true;
        return { ...session, starred: optimisticStar };
      });

      if (!mutated) {
        return sessions;
      }

      // Same comparator `getAllSessions` used, not a copy of it: the two ran
      // side by side and a divergence would move rows on nothing more than
      // whether a star had been clicked this render.
      return overlaid.sort(compareSidebarSessions);
    },
    [optimisticStarBySessionId],
  );

  /**
   * The session list the sidebar actually RENDERS while a search is running
   * (B-332 follow-up): a hit inside one conversation must show that conversation,
   * not its whole project.
   *
   * Rules, in order:
   *  1. No query → the full list, untouched.
   *  2. Sessions whose title matched (unless the scope is messages-only) plus
   *     sessions whose body matched (unless the scope is titles-only).
   *  3. A body match the loaded page does not contain (projects load their 20
   *     newest sessions) is materialised from the search payload — id, title and
   *     provider are all the row needs. Without this the project would open onto
   *     a list that does not contain the match at all.
   *  4. Nothing matched inside → the project itself matched by name or path, so
   *     its full list is the right answer.
   *
   * Kept separate from `getProjectSessions` on purpose: that one still answers
   * "how many sessions does this project have" for the delete dialog, which must
   * never be narrowed by an unrelated search.
   *
   * The hide-closed filter runs LAST, on the search result rather than before
   * it: a user who types a query is naming the rows they want, and answering a
   * deliberate search with "no results" because the match happens to be closed
   * is the filter overruling the user. Searching therefore reveals closed rows
   * again — the filter governs the resting list.
   */
  const getSearchVisibleSessions = useCallback(
    (project: Project): SessionWithProvider[] => {
      const searchVisible = selectSearchVisibleSessions(project, getProjectSessions(project), {
        normalizedSearch: normalizeForSearch(debouncedSearchQuery.trim()),
        scope: searchScope,
        matchBySessionId: messageSearch.matchBySessionId,
      });

      return selectClosedVisibleSessions(searchVisible, {
        hideClosed: hideClosedSessions && !debouncedSearchQuery.trim(),
        keepSessionId: selectedSession?.id ?? null,
      });
    },
    [
      selectedSession?.id,
      debouncedSearchQuery,
      getProjectSessions,
      hideClosedSessions,
      messageSearch.matchBySessionId,
      searchScope,
    ],
  );

  const loadMoreSessionsForProject = useCallback(async (projectId: string) => {
    if (!onLoadMoreSessions) {
      return;
    }

    let shouldLoad = false;
    setLoadingMoreProjects((previous) => {
      if (previous.has(projectId)) {
        return previous;
      }

      shouldLoad = true;
      const next = new Set(previous);
      next.add(projectId);
      return next;
    });

    if (!shouldLoad) {
      return;
    }

    try {
      await onLoadMoreSessions(projectId);
    } catch (error) {
      console.error('[Sidebar] Failed to load more sessions:', error);
      alert(t('messages.refreshError'));
    } finally {
      setLoadingMoreProjects((previous) => {
        const next = new Set(previous);
        next.delete(projectId);
        return next;
      });
    }
  }, [onLoadMoreSessions, t]);

  const projectsWithResolvedStarState = useMemo(() => {
    if (optimisticStarByProjectId.size === 0) {
      return projects;
    }

    return projects.map((project) => {
      const optimisticStarState = optimisticStarByProjectId.get(project.projectId);

      const nextStar =
        optimisticStarState !== undefined && Boolean(project.isStarred) !== optimisticStarState
          ? optimisticStarState
          : undefined;
      if (nextStar === undefined) {
        return project;
      }

      return { ...project, isStarred: nextStar };
    });
  }, [optimisticStarByProjectId, projects]);

  const sortedProjects = useMemo(
    () => sortProjects(projectsWithResolvedStarState, projectSortOrder),
    [projectSortOrder, projectsWithResolvedStarState],
  );

  // T-940: the Projects section renders every project — project visibility was
  // retired by ADR-089, so there is nothing to filter by membership.
  // Two layers, merged (B-332): the local title filter resolves instantly, and
  // message matches join it as the SSE scan streams in. `titles` keeps the
  // former behaviour verbatim; `messages` drops title-only hits entirely.
  const filteredProjects = useMemo(() => {
    const titleFiltered = filterProjects(sortedProjects, debouncedSearchQuery);

    if (searchScope === 'titles' || !debouncedSearchQuery) {
      return titleFiltered;
    }

    if (searchScope === 'messages') {
      return sortedProjects.filter((project) => messageMatchedProjectIds.has(project.projectId));
    }

    if (messageMatchedProjectIds.size === 0) {
      return titleFiltered;
    }

    const titleMatchedIds = new Set(titleFiltered.map((project) => project.projectId));
    return sortedProjects.filter(
      (project) => titleMatchedIds.has(project.projectId) || messageMatchedProjectIds.has(project.projectId),
    );
  }, [debouncedSearchQuery, messageMatchedProjectIds, searchScope, sortedProjects]);

  const filteredArchivedSessions = useMemo(() => {
    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return archivedSessions;
    }

    return archivedSessions.filter((session) => {
      const searchableFields = [
        session.sessionTitle,
        session.projectDisplayName,
        session.projectPath ?? '',
        session.provider,
      ];

      return searchableFields.some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [archivedSessions, debouncedSearchQuery]);

  const filteredArchivedProjects = useMemo(() => {
    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return archivedProjects;
    }

    return archivedProjects.filter((project) => {
      const projectMatches = [
        project.displayName,
        project.fullPath || '',
      ].some((value) => value.toLowerCase().includes(normalizedSearch));

      if (projectMatches) {
        return true;
      }

      return getAllSessions(project).some((session) => {
        const sessionSummary =
          typeof session.summary === 'string' && session.summary.trim().length > 0
            ? session.summary
            : typeof session.name === 'string'
              ? session.name
              : '';

        return [
          sessionSummary,
          session.__provider,
        ].some((value) => value.toLowerCase().includes(normalizedSearch));
      });
    });
  }, [archivedProjects, debouncedSearchQuery]);

  const startEditing = useCallback((project: Project) => {
    // `editingProject` is keyed by projectId so it stays stable across
    // display-name mutations that happen while the input is open.
    setEditingProject(project.projectId);
    setEditingName(project.displayName);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingProject(null);
    setEditingName('');
  }, []);

  const saveProjectName = useCallback(
    // `projectId` is the DB primary key; the rename API resolves the path
    // through the `projects` table before writing the new display name.
    async (projectId: string) => {
      try {
        const response = await api.renameProject(projectId, editingName);
        if (response.ok) {
          await paletteOps.refreshProjects();
        } else {
          console.error('Failed to rename project');
        }
      } catch (error) {
        console.error('Error renaming project:', error);
      } finally {
        setEditingProject(null);
        setEditingName('');
      }
    },
    [editingName, paletteOps],
  );

  const showDeleteSessionConfirmation = useCallback(
    // Kept with project/provider arguments for component wiring compatibility;
    // deletion now uses only `sessionId` via /api/providers/sessions/:sessionId.
    (
      projectId: string | null,
      sessionId: string,
      sessionTitle: string,
      provider: SessionDeleteConfirmation['provider'] = 'claude',
      options: {
        isArchived?: boolean;
      } = {},
    ) => {
      setSessionDeleteConfirmation({
        projectId,
        sessionId,
        sessionTitle,
        provider,
        isArchived: Boolean(options.isArchived),
      });
    },
    [],
  );

  const confirmDeleteSession = useCallback(async (hardDelete = false) => {
    if (!sessionDeleteConfirmation) {
      return;
    }

    const { sessionId } = sessionDeleteConfirmation;
    setSessionDeleteConfirmation(null);

    try {
      const response = await api.deleteSession(sessionId, hardDelete);

      if (response.ok) {
        onSessionDelete?.(sessionId);
        await fetchArchivedSessions();
      } else {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to delete session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.deleteSessionFailed'));
      }
    } catch (error) {
      console.error('[Sidebar] Error deleting session:', error);
      alert(t('messages.deleteSessionError'));
    }
  }, [fetchArchivedSessions, onSessionDelete, sessionDeleteConfirmation, t]);

  /**
   * Archive one session straight from its row (B-332) — the soft delete the
   * confirmation dialog already performs, minus the dialog. Archiving is
   * reversible from the archive view, which is why it needs no confirmation;
   * permanent deletion still goes through the dialog.
   */
  const archiveSession = useCallback(async (sessionId: string) => {
    try {
      const response = await api.deleteSession(sessionId, false);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to archive session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.archiveSessionFailed', 'Failed to archive the session. Please try again.'));
        return;
      }

      onSessionDelete?.(sessionId);
      await fetchArchivedSessions();
    } catch (error) {
      console.error('[Sidebar] Error archiving session:', error);
      alert(t('messages.archiveSessionFailed', 'Failed to archive the session. Please try again.'));
    }
  }, [fetchArchivedSessions, onSessionDelete, t]);

  const requestProjectDelete = useCallback(
    (project: Project) => {
      setDeleteConfirmation({
        project,
        sessionCount: getProjectSessions(project).length,
      });
    },
    [getProjectSessions],
  );

  const confirmDeleteProject = useCallback(async (deleteData = false) => {
    if (!deleteConfirmation) {
      return;
    }

    const { project } = deleteConfirmation;

    setDeleteConfirmation(null);
    // Track in-flight deletes by projectId so the UI can disable actions
    // even if the project object is rebuilt while the request is flying.
    setDeletingProjects((prev) => new Set([...prev, project.projectId]));

    try {
      const response = await api.deleteProject(project.projectId, deleteData);

      if (response.ok) {
        onProjectDelete?.(project.projectId);
      } else {
        const data = (await response.json()) as { error?: string | { message?: string } };
        const err = data.error;
        const message =
          typeof err === 'string' ? err : err && typeof err === 'object' && err.message ? err.message : t('messages.deleteProjectFailed');
        alert(message);
      }
    } catch (error) {
      console.error('Error deleting project:', error);
      alert(t('messages.deleteProjectError'));
    } finally {
      setDeletingProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.projectId);
        return next;
      });
    }
  }, [deleteConfirmation, onProjectDelete, t]);

  const requestProjectArchive = useCallback(
    (project: Project) => {
      setArchiveConfirmation({
        project,
        sessionCount: getProjectSessions(project).length,
      });
    },
    [getProjectSessions],
  );

  const confirmArchiveProject = useCallback(async () => {
    if (!archiveConfirmation) {
      return;
    }

    const { project } = archiveConfirmation;

    setArchiveConfirmation(null);
    setDeletingProjects((prev) => new Set([...prev, project.projectId]));

    try {
      const response = await api.deleteProject(project.projectId, false);

      if (response.ok) {
        onProjectArchive?.(project.projectId);
      } else {
        const data = (await response.json()) as { error?: string | { message?: string } };
        const err = data.error;
        const message =
          typeof err === 'string' ? err : err && typeof err === 'object' && err.message ? err.message : t('messages.archiveProjectFailed');
        alert(message);
      }
    } catch (error) {
      console.error('Error archiving project:', error);
      alert(t('messages.archiveProjectFailed'));
    } finally {
      setDeletingProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.projectId);
        return next;
      });
    }
  }, [archiveConfirmation, onProjectArchive, t]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      onProjectSelect(project);
    },
    [onProjectSelect],
  );

  const openArchivedSession = useCallback((session: ArchivedSessionListItem) => {
    const activeProject = session.projectId
      ? projects.find((candidate) => candidate.projectId === session.projectId)
      : null;
    const archivedProject = session.projectId
      ? archivedProjects.find((candidate) => candidate.projectId === session.projectId)
      : null;
    const matchingProject = activeProject ?? archivedProject ?? null;
    const sessionPayload: ProjectSession = {
      id: session.sessionId,
      summary: session.sessionTitle,
      __provider: session.provider,
      __projectId: matchingProject?.projectId ?? session.projectId ?? undefined,
    };

    // Archived sessions still need a selected project context. Active projects
    // come from the normal sidebar list, while archived-project sessions resolve
    // through the archive payload loaded by this controller.
    if (matchingProject) {
      handleProjectSelect(matchingProject);
    }

    onSessionSelect(sessionPayload);
  }, [archivedProjects, handleProjectSelect, onSessionSelect, projects]);

  const restoreArchivedProject = useCallback(async (projectId: string) => {
    try {
      const response = await api.restoreProject(projectId);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to restore project:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.restoreProjectFailed', 'Failed to restore project. Please try again.'));
        return;
      }

      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
      ]);
    } catch (error) {
      console.error('[Sidebar] Error restoring project:', error);
      alert(t('messages.restoreProjectError', 'Error restoring project. Please try again.'));
    }
  }, [fetchArchivedSessions, onRefresh, t]);

  const restoreArchivedSession = useCallback(async (sessionId: string) => {
    try {
      const response = await api.restoreSession(sessionId);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to restore session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.restoreSessionFailed', 'Failed to restore session. Please try again.'));
        return;
      }

      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
      ]);
    } catch (error) {
      console.error('[Sidebar] Error restoring session:', error);
      alert(t('messages.restoreSessionError', 'Error restoring session. Please try again.'));
    }
  }, [fetchArchivedSessions, onRefresh, t]);

  const refreshProjects = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchArchivedSessions, onRefresh]);

  const enterBulkSelection = useCallback((kind: BulkSelectionKind = 'projects') => {
    setBulkSelectionKind(kind);
    setBulkSelectedIds(new Set());
  }, []);

  /** Starts selection with its initiating row selected in the same render. */
  const startBulkSelectionWithId = useCallback((kind: BulkSelectionKind, id: string) => {
    setBulkSelectionKind(kind);
    setBulkSelectedIds(new Set([id]));
  }, []);

  const exitBulkSelection = useCallback(() => {
    setBulkSelectionKind(null);
    setBulkSelectedIds(new Set());
  }, []);

  const toggleBulkSelectedId = useCallback((id: string) => {
    setBulkSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectVisibleBulkIds = useCallback((ids: string[]) => {
    setBulkSelectedIds(new Set(ids));
  }, []);

  const runBulkAction = useCallback(async (
    action: BulkProjectAction | BulkSessionAction,
  ): Promise<boolean> => {
    if (!bulkSelectionKind || bulkSelectedIds.size === 0 || isBulkMutating) return false;

    // Keep the client fail-closed during a rolling update: this check occurs
    // before the confirmation dialog so an unavailable server cannot produce
    // a misleading confirmation followed by a 404.
    if (!bulkLifecycleActions) {
      alert(t('bulk.unavailable', 'Bulk changes are unavailable until the server update completes.'));
      return false;
    }

    const isPermanentDelete = action === 'delete_permanently';
    if (isPermanentDelete) {
      const count = bulkSelectedIds.size;
      const kind = bulkSelectionKind === 'projects'
        ? t('bulk.projects', 'projects')
        : t('bulk.sessions', 'conversations');
      const confirmationMessage = t(
        'bulk.confirmPermanentDelete',
        'Permanently delete {{count}} {{kind}}? This cannot be undone.',
        { count, kind },
      );
      if (!window.confirm(confirmationMessage)) {
        return false;
      }
    }

    setIsBulkMutating(true);
    let failureMessage: string | null = null;
    try {
      const ids = [...bulkSelectedIds];
      const response = bulkSelectionKind === 'projects'
        ? await api.bulkProjects(ids, action)
        : await api.bulkSessions(ids, action);
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null) as {
          error?: { message?: unknown };
          message?: unknown;
        } | null;
        const serverMessage = errorPayload?.error?.message ?? errorPayload?.message;
        failureMessage = typeof serverMessage === 'string' && serverMessage.trim()
          ? serverMessage
          : t('bulk.actionFailedStatus', 'Bulk action could not be completed (HTTP {{status}}).', { status: response.status });
        throw new Error(`Bulk action failed (${response.status})`);
      }
      const payload = (await response.json()) as { data?: { results?: Array<{ id: string; success: boolean }> } };
      const failedIds = payload.data?.results?.filter((result) => !result.success).map((result) => result.id) ?? [];
      const failedCount = failedIds.length;
      // A 200 can include idempotent and per-item outcomes. Refresh from the
      // server's source of truth rather than locally guessing which row moved.
      await Promise.all([Promise.resolve(onRefresh()), fetchArchivedSessions()]);
      if (failedCount > 0) {
        // Do not silently discard the user's unresolved selection. Retaining
        // only failed IDs lets them retry or inspect precisely what remains.
        setBulkSelectedIds(new Set(failedIds));
        alert(t('bulk.partialFailure', '{{count}} item(s) could not be updated.', { count: failedCount }));
      } else {
        exitBulkSelection();
      }
      return true;
    } catch (error) {
      console.error('[Sidebar] Bulk action failed:', error);
      alert(failureMessage ?? t('bulk.actionFailed', 'Could not update all selected items. Please try again.'));
      return false;
    } finally {
      setIsBulkMutating(false);
    }
  }, [bulkLifecycleActions, bulkSelectedIds, bulkSelectionKind, exitBulkSelection, fetchArchivedSessions, isBulkMutating, onRefresh, t]);

  const updateSessionSummary = useCallback(
    // `_projectId` and `_provider` are preserved for compatibility with
    // existing sidebar callback signatures; backend rename only needs sessionId.
    async (_projectId: string, sessionId: string, summary: string, _provider: LLMProvider) => {
      const trimmed = summary.trim();
      if (!trimmed) {
        setEditingSession(null);
        setEditingSessionName('');
        return;
      }
      try {
        const response = await api.renameSession(sessionId, trimmed);
        if (response.ok) {
          await onRefresh();
        } else {
          console.error('[Sidebar] Failed to rename session:', response.status);
          alert(t('messages.renameSessionFailed'));
        }
      } catch (error) {
        console.error('[Sidebar] Error renaming session:', error);
        alert(t('messages.renameSessionError'));
      } finally {
        setEditingSession(null);
        setEditingSessionName('');
      }
    },
    [onRefresh, t],
  );

  const collapseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, [setSidebarVisible]);

  const expandSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, [setSidebarVisible]);

  return {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    initialSessionsLoaded,
    currentTime,
    projectSortOrder,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    deletingProjects,
    loadingMoreProjects,
    deleteConfirmation,
    archiveConfirmation,
    sessionDeleteConfirmation,
    showVersionModal,
    filteredProjects,
    activeSection,
    setActiveSection,
    archivedProjects: filteredArchivedProjects,
    archivedSessions: filteredArchivedSessions,
    archivedSessionsCount: archivedProjects.length + archivedSessions.length,
    isArchivedSessionsLoading,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    toggleStarSession,
    isSessionStarred,
    getProjectSessions,
    getSearchVisibleSessions,
    loadMoreSessionsForProject,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    archiveSession,
    messageSearchSnippets,
    isMessageSearching: messageSearch.isSearching,
    requestProjectDelete,
    confirmDeleteProject,
    requestProjectArchive,
    confirmArchiveProject,
    handleProjectSelect,
    openArchivedSession,
    restoreArchivedProject,
    restoreArchivedSession,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar,
    expandSidebar,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    searchMode,
    setSearchMode,
    searchScope,
    setSearchScope,
    hideClosedSessions,
    setHideClosedSessions,
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
  };
}
