import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { api } from '../../../utils/api';
import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type {
  ArchivedProjectListItem,
  ArchivedSessionListItem,
  DeleteProjectConfirmation,
  ProjectSortOrder,
  SidebarSearchMode,
  SidebarSection,
  SessionDeleteConfirmation,
  SessionWithProvider,
} from '../types/types';
import {
  clearLegacyMembershipFilter,
  clearLegacyStarredProjectIds,
  filterProjects,
  getAllSessions,
  getMatchedSessionIds,
  getSessionCreationDate,
  readLegacyStarredProjectIds,
  readProjectSortOrder,
  readSidebarSection,
  sortProjects,
  writeSidebarSection,
} from '../utils/utils';

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
  setSidebarVisible: (visible: boolean) => void;
  sidebarVisible: boolean;
  // T-940: notified when the top-level section (Terminals/Projects) changes, so
  // AppContent can mirror it onto the main-content surface.
  onSectionChange?: (section: SidebarSection) => void;
};

export function useSidebarController({
  projects,
  selectedProject,
  selectedSession: _selectedSession,
  isLoading,
  isMobile,
  t,
  onRefresh,
  onProjectSelect,
  onSessionSelect,
  onSessionDelete,
  onLoadMoreSessions,
  onProjectDelete,
  setSidebarVisible,
  sidebarVisible,
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
  const [sessionDeleteConfirmation, setSessionDeleteConfirmation] = useState<SessionDeleteConfirmation | null>(null);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [searchMode, setSearchMode] = useState<SidebarSearchMode>('projects');
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProjectListItem[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSessionListItem[]>([]);
  const [isArchivedSessionsLoading, setIsArchivedSessionsLoading] = useState(false);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [optimisticStarByProjectId, setOptimisticStarByProjectId] = useState<Map<string, boolean>>(new Map());
  // Optimistic project visibility (C-PRIV-6): flip locally on click, then let the
  // `projects_updated` broadcast / refresh confirm the authoritative value.
  const [optimisticVisibilityByProjectId, setOptimisticVisibilityByProjectId] = useState<
    Map<string, 'public' | 'private'>
  >(new Map());
  const [loadingMoreProjects, setLoadingMoreProjects] = useState<Set<string>>(new Set());
  // Optimistic per-session star state, keyed by sessionId. Flip locally on
  // click, then reconcile to the server's authoritative `starred` once it
  // responds (POST /api/sessions/star returns the new value). The map is
  // pruned whenever the projects payload already reflects the optimistic value.
  const [optimisticStarBySessionId, setOptimisticStarBySessionId] = useState<Map<string, boolean>>(new Map());
  const starToggleSequenceBySessionRef = useRef<Map<string, number>>(new Map());
  const starToggleSequenceByProjectRef = useRef<Map<string, number>>(new Map());
  const visibilityToggleSequenceByProjectRef = useRef<Map<string, number>>(new Map());
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
  }, [debouncedSearchQuery, projects]);

  // All sidebar state keys (expanded, starred, loading, etc.) use the DB
  // `projectId` as their identifier after the migration.
  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set<string>();
      if (!prev.has(projectId)) {
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
    const previousStarState = resolveProjectStarState(projectId);
    const optimisticStarState = !previousStarState;
    const latestSequence = (starToggleSequenceByProjectRef.current.get(projectId) ?? 0) + 1;
    starToggleSequenceByProjectRef.current.set(projectId, latestSequence);

    setOptimisticStarByProjectId((previous) => {
      const next = new Map(previous);
      next.set(projectId, optimisticStarState);
      return next;
    });

    const updateStar = async () => {
      try {
        const response = await api.toggleProjectStar(projectId);
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
        const isLatestSequence = starToggleSequenceByProjectRef.current.get(projectId) === latestSequence;
        if (!isLatestSequence) {
          return;
        }

        setOptimisticStarByProjectId((previous) => {
          const next = new Map(previous);
          next.set(projectId, Boolean(payload.isStarred));
          return next;
        });
      } catch (error) {
        const isLatestSequence = starToggleSequenceByProjectRef.current.get(projectId) === latestSequence;
        if (!isLatestSequence) {
          return;
        }

        setOptimisticStarByProjectId((previous) => {
          const next = new Map(previous);
          next.set(projectId, previousStarState);
          return next;
        });
        console.error('[Sidebar] Failed to toggle project star:', error);
        alert(t('messages.updateProjectError'));
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
      const previousStarState = resolveSessionStarState(session);
      const optimisticStarState = !previousStarState;
      const sessionId = session.id;
      const latestSequence = (starToggleSequenceBySessionRef.current.get(sessionId) ?? 0) + 1;
      starToggleSequenceBySessionRef.current.set(sessionId, latestSequence);

      setOptimisticStarBySessionId((previous) => {
        const next = new Map(previous);
        next.set(sessionId, optimisticStarState);
        return next;
      });

      const run = async () => {
        try {
          const response = await api.starSession(sessionId, projectName, optimisticStarState);
          if (!response.ok) {
            throw new Error(`star request failed (${response.status})`);
          }

          const payload = (await response.json()) as { data?: { starred?: boolean } };
          if (starToggleSequenceBySessionRef.current.get(sessionId) !== latestSequence) {
            return;
          }

          const confirmedStar = Boolean(payload.data?.starred ?? optimisticStarState);
          setOptimisticStarBySessionId((previous) => {
            const next = new Map(previous);
            next.set(sessionId, confirmedStar);
            return next;
          });
        } catch (error) {
          if (starToggleSequenceBySessionRef.current.get(sessionId) !== latestSequence) {
            return;
          }

          setOptimisticStarBySessionId((previous) => {
            const next = new Map(previous);
            next.set(sessionId, previousStarState);
            return next;
          });
          console.error('[Sidebar] Failed to toggle session star:', error);
        }
      };

      void run();
    },
    [resolveSessionStarState],
  );

  const isSessionStarred = useCallback(
    (session: SessionWithProvider) => resolveSessionStarState(session),
    [resolveSessionStarState],
  );

  // C-PRIV-6: flip project visibility. Update optimistically, call the server,
  // then drop the optimistic value once the authoritative `projects_updated`
  // broadcast (or a manual refresh) lands. Errors roll the value back.
  const setProjectVisibility = useCallback(
    (projectId: string, nextVisibility: 'public' | 'private') => {
      const previousVisibility =
        optimisticVisibilityByProjectId.get(projectId) ??
        projects.find((candidate) => candidate.projectId === projectId)?.visibility ??
        'public';

      const latestSequence = (visibilityToggleSequenceByProjectRef.current.get(projectId) ?? 0) + 1;
      visibilityToggleSequenceByProjectRef.current.set(projectId, latestSequence);

      setOptimisticVisibilityByProjectId((previous) => {
        const next = new Map(previous);
        next.set(projectId, nextVisibility);
        return next;
      });

      const clearOptimistic = () => {
        if (visibilityToggleSequenceByProjectRef.current.get(projectId) !== latestSequence) {
          return;
        }
        setOptimisticVisibilityByProjectId((previous) => {
          if (!previous.has(projectId)) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(projectId);
          return next;
        });
      };

      const run = async () => {
        try {
          const response = await api.setProjectVisibility(projectId, nextVisibility);
          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as {
              error?: string | { message?: string };
            };
            const errorPayload = payload.error;
            const message =
              typeof errorPayload === 'string'
                ? errorPayload
                : errorPayload && typeof errorPayload === 'object' && errorPayload.message
                  ? errorPayload.message
                  : t('messages.updateProjectError');
            throw new Error(message);
          }

          // The server broadcasts `projects_updated`; refresh to pick up the
          // authoritative list (private projects may even disappear), then drop
          // the optimistic override so the canonical value drives the UI.
          await Promise.resolve(onRefreshRef.current());
          clearOptimistic();
        } catch (error) {
          if (visibilityToggleSequenceByProjectRef.current.get(projectId) === latestSequence) {
            setOptimisticVisibilityByProjectId((previous) => {
              const next = new Map(previous);
              next.set(projectId, previousVisibility);
              return next;
            });
          }
          console.error('[Sidebar] Failed to change project visibility:', error);
          alert(t('messages.updateProjectError'));
        }
      };

      void run();
    },
    [optimisticVisibilityByProjectId, projects, t],
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

      return overlaid.sort((a, b) => {
        const aStarred = Boolean(a.starred);
        const bStarred = Boolean(b.starred);
        if (aStarred !== bStarred) {
          return aStarred ? -1 : 1;
        }
        return getSessionCreationDate(b).getTime() - getSessionCreationDate(a).getTime();
      });
    },
    [optimisticStarBySessionId],
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
    if (optimisticStarByProjectId.size === 0 && optimisticVisibilityByProjectId.size === 0) {
      return projects;
    }

    return projects.map((project) => {
      const optimisticStarState = optimisticStarByProjectId.get(project.projectId);
      const optimisticVisibility = optimisticVisibilityByProjectId.get(project.projectId);

      const nextStar =
        optimisticStarState !== undefined && Boolean(project.isStarred) !== optimisticStarState
          ? optimisticStarState
          : undefined;
      const nextVisibility =
        optimisticVisibility !== undefined && project.visibility !== optimisticVisibility
          ? optimisticVisibility
          : undefined;

      if (nextStar === undefined && nextVisibility === undefined) {
        return project;
      }

      return {
        ...project,
        ...(nextStar !== undefined ? { isStarred: nextStar } : {}),
        ...(nextVisibility !== undefined ? { visibility: nextVisibility } : {}),
      };
    });
  }, [optimisticStarByProjectId, optimisticVisibilityByProjectId, projects]);

  const sortedProjects = useMemo(
    () => sortProjects(projectsWithResolvedStarState, projectSortOrder),
    [projectSortOrder, projectsWithResolvedStarState],
  );

  // T-940: the Projects section renders the previous `all` behaviour verbatim —
  // no membership filtering (visibility is enforced server-side per ADR-052).
  const filteredProjects = useMemo(
    () => filterProjects(sortedProjects, debouncedSearchQuery),
    [debouncedSearchQuery, sortedProjects],
  );

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
    setProjectVisibility,
    getProjectSessions,
    loadMoreSessionsForProject,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
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
    setSearchFilter,
    setDeleteConfirmation,
    setSessionDeleteConfirmation,
    setShowVersionModal,
  };
}
