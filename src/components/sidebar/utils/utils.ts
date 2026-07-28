import type { TFunction } from 'i18next';

import type { Project } from '../../../types/app';
import type { ProjectSortOrder, SettingsProject, SessionViewModel, SessionWithProvider, SidebarSection } from '../types/types';

// Top-level sidebar section (T-940): Terminals vs Projects. Stored per-browser
// (no identity — just a UI preference). Defaults to 'projects'.
const SIDEBAR_SECTION_STORAGE_KEY = 'sidebar-section';
// Legacy "My projects / Team / All" membership-filter key, removed in T-940.
const LEGACY_MEMBERSHIP_FILTER_STORAGE_KEY = 'sidebarProjectMembershipFilter';

export const readSidebarSection = (): SidebarSection => {
  try {
    return localStorage.getItem(SIDEBAR_SECTION_STORAGE_KEY) === 'terminals' ? 'terminals' : 'projects';
  } catch {
    return 'projects';
  }
};

export const writeSidebarSection = (section: SidebarSection): void => {
  try {
    localStorage.setItem(SIDEBAR_SECTION_STORAGE_KEY, section);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

/** One-time cleanup of the retired membership-filter key (T-940). */
export const clearLegacyMembershipFilter = (): void => {
  try {
    localStorage.removeItem(LEGACY_MEMBERSHIP_FILTER_STORAGE_KEY);
  } catch {
    // ignore
  }
};

export const readProjectSortOrder = (): ProjectSortOrder => {
  try {
    const rawSettings = localStorage.getItem('claude-settings');
    if (!rawSettings) {
      return 'name';
    }

    const settings = JSON.parse(rawSettings) as { projectSortOrder?: ProjectSortOrder };
    return settings.projectSortOrder === 'date' ? 'date' : 'name';
  } catch {
    return 'name';
  }
};

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

export const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

/**
 * Creation date used for sidebar session ordering (newest-created first).
 * Falls back to last activity only for legacy rows that carry no creation
 * timestamp, mirroring the server-side COALESCE(created_at, updated_at).
 */
export const getSessionCreationDate = (session: SessionWithProvider): Date => {
  return new Date(getCreatedTimestamp(session) || getUpdatedTimestamp(session) || 0);
};

export const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

export const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isCursorSession: session.__provider === 'cursor',
    isCodexSession: session.__provider === 'codex',
    isGeminiSession: session.__provider === 'gemini',
    isOpenCodeSession: session.__provider === 'opencode',
    isActive: diffInMinutes < 10,
    // `Boolean(...)` like the star above, not `=== true`: the flag is absent on
    // legacy rows, and SQLite hands booleans back as 0/1 — a 1 that read as
    // "open" would silently drop the marker from a settled conversation.
    isClosed: Boolean(session.closed),
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  const claudeSessions = [...(project.sessions || [])].map((session) => ({
    ...session,
    __provider: 'claude' as const,
  }));

  const cursorSessions = (project.cursorSessions || []).map((session) => ({
    ...session,
    __provider: 'cursor' as const,
  }));

  const codexSessions = (project.codexSessions || []).map((session) => ({
    ...session,
    __provider: 'codex' as const,
  }));

  const geminiSessions = (project.geminiSessions || []).map((session) => ({
    ...session,
    __provider: 'gemini' as const,
  }));

  const antigravitySessions = (project.antigravitySessions || []).map((session) => ({
    ...session,
    __provider: 'antigravity' as const,
  }));

  const opencodeSessions = (project.opencodeSessions || []).map((session) => ({
    ...session,
    __provider: 'opencode' as const,
  }));

  return [
    ...claudeSessions,
    ...cursorSessions,
    ...codexSessions,
    ...geminiSessions,
    ...antigravitySessions,
    ...opencodeSessions,
  ].sort((a, b) => {
    // Starred (per-user favourite) sessions float to the top within the
    // project; among equal star state, newest-created first (NOT last
    // activity, so a session keeps its position while it is being worked on).
    const aStarred = Boolean(a.starred);
    const bStarred = Boolean(b.starred);
    if (aStarred !== bStarred) {
      return aStarred ? -1 : 1;
    }
    return getSessionCreationDate(b).getTime() - getSessionCreationDate(a).getTime();
  });
};

export const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

/**
 * Normalises an Arabic/Latin string for case-insensitive search:
 * lower-cases Latin characters and strips Arabic diacritics (tashkeel)
 * so that "محادثة" matches "مُحَادَثَة" etc.
 */
const normalizeForSearch = (value: string): string =>
  value
    .toLowerCase()
    // Strip Arabic diacritics (U+064B–U+065F range covers all tashkeel marks).
    .replace(/[ً-ٟ]/g, '');

/**
 * Returns the set of session IDs (across all providers) whose title/summary
 * matches the search query for the given project.  Used by the sidebar
 * controller to auto-expand projects that have session-level matches and
 * (optionally) to highlight individual rows.
 */
export const getMatchedSessionIds = (project: Project, normalizedSearch: string): Set<string> => {
  if (!normalizedSearch) {
    return new Set();
  }

  const matched = new Set<string>();
  const sessions = getAllSessions(project);

  for (const session of sessions) {
    const title = normalizeForSearch(
      (typeof session.summary === 'string' && session.summary.trim().length > 0
        ? session.summary
        : typeof session.name === 'string' && session.name.trim().length > 0
          ? session.name
          : typeof session.title === 'string' && session.title.trim().length > 0
            ? session.title
            : '') || session.id,
    );

    if (title.includes(normalizedSearch)) {
      matched.add(session.id);
    }
  }

  return matched;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = normalizeForSearch(searchFilter.trim());
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = normalizeForSearch(project.displayName || project.projectId);
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = normalizeForSearch(project.path || project.fullPath || '');

    // Project name/path match — keep the project regardless of sessions.
    if (displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch)) {
      return true;
    }

    // Session-level match — keep the project so the matched sessions are
    // reachable; the controller auto-expands these projects.
    return getMatchedSessionIds(project, normalizedSearch).size > 0;
  });
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
