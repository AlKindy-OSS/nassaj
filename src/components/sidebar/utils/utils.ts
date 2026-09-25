import type { TFunction } from 'i18next';

import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import { SESSION_BUCKET_PROVIDERS, sessionBucketKey } from '../../../../shared/sessionBuckets';
import type { ProjectSortOrder, SettingsProject, SessionViewModel, SessionWithProvider, SidebarSearchScope, SidebarSection } from '../types/types';

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

// Search scope (B-332): titles / messages / both. Per-browser UI preference.
const SIDEBAR_SEARCH_SCOPE_STORAGE_KEY = 'sidebar-search-scope';

export const readSidebarSearchScope = (): SidebarSearchScope => {
  try {
    const stored = localStorage.getItem(SIDEBAR_SEARCH_SCOPE_STORAGE_KEY);
    return stored === 'titles' || stored === 'messages' ? stored : 'all';
  } catch {
    return 'all';
  }
};

export const writeSidebarSearchScope = (scope: SidebarSearchScope): void => {
  try {
    localStorage.setItem(SIDEBAR_SEARCH_SCOPE_STORAGE_KEY, scope);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

// Hide-closed filter: a per-browser UI preference like the two above. Stored as
// '1'/'0' and defaulting to OFF — a filter the user never asked for must not be
// what greets them after an update, and an empty-looking project is a worse
// first impression than one extra faded row.
const SIDEBAR_HIDE_CLOSED_STORAGE_KEY = 'sidebar-hide-closed';

export const readSidebarHideClosed = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_HIDE_CLOSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

export const writeSidebarHideClosed = (hideClosed: boolean): void => {
  try {
    localStorage.setItem(SIDEBAR_HIDE_CLOSED_STORAGE_KEY, hideClosed ? '1' : '0');
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

/**
 * B-861: this model deliberately carries NO activity flag. It used to expose
 * `isActive: diffInMinutes < 10`, a client-side guess from `lastActivity` that
 * no component ever read — while the real row indicator comes from the server
 * (`sessionProcessStateStore`, fed by the process monitor and the presence
 * snapshot). Reviving a timestamp heuristic here would put two disagreeing
 * answers on the same row, so the field is gone rather than wired up.
 */
export const createSessionViewModel = (
  session: SessionWithProvider,
  t: TFunction,
): SessionViewModel => {
  return {
    isCursorSession: session.__provider === 'cursor',
    isCodexSession: session.__provider === 'codex',
    isOpenCodeSession: session.__provider === 'opencode',
    // `Boolean(...)` like the star above, not `=== true`: the flag is absent on
    // legacy rows, and SQLite hands booleans back as 0/1 — a 1 that read as
    // "open" would silently drop the marker from a settled conversation.
    isClosed: Boolean(session.closed),
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

/**
 * Milliseconds used to order sessions, with an invalid/absent date read as 0
 * rather than NaN — NaN makes every comparison return false, which is exactly
 * the "list reshuffles for no reason" symptom this ordering exists to prevent.
 */
const getSessionSortTime = (session: SessionWithProvider): number => {
  const time = getSessionCreationDate(session).getTime();
  return Number.isFinite(time) ? time : 0;
};

/**
 * THE session comparator for the sidebar — used by `getAllSessions` and by the
 * controller's optimistic-star re-sort, so the two can never disagree.
 *
 * Order: starred first, then newest-created first (creation date, NOT last
 * activity, so a conversation keeps its place while it is being worked on),
 * then session id descending.
 *
 * That last step is not decoration. Without it, two sessions sharing a
 * timestamp — same-second creation, a legacy row with no `created_at`, or two
 * rows that both fall back to 0 — were left in whatever order the provider
 * buckets happened to produce, and that order changes between payloads. The
 * server already breaks the same tie with `session_id DESC`
 * (sessions.db.ts `getSessionsByProjectPathPage`); this makes the client agree
 * with it instead of re-shuffling the page it was handed.
 */
export const compareSidebarSessions = (
  a: SessionWithProvider,
  b: SessionWithProvider,
): number => {
  const aStarred = Boolean(a.starred);
  const bStarred = Boolean(b.starred);
  if (aStarred !== bStarred) {
    return aStarred ? -1 : 1;
  }

  const timeDelta = getSessionSortTime(b) - getSessionSortTime(a);
  if (timeDelta !== 0) {
    return timeDelta;
  }

  return String(b.id ?? '').localeCompare(String(a.id ?? ''));
};

/**
 * The timestamp a project is ordered by in "date" mode: the creation time of
 * its newest conversation.
 *
 * Deliberately NOT "latest activity". Last activity moves on every single
 * message, so the project the user is typing in kept climbing over its
 * neighbours mid-sentence — the reordering the owner reported. Creation time of
 * the newest session only changes when a conversation is actually created.
 *
 * Reading it from the LOADED sessions is safe for the same reason: the server
 * returns each project's newest-created page first, so the maximum is already
 * present in page 1 and paging in older conversations cannot change it. A
 * project with no sessions yet scores 0 and is ordered by name below the rest,
 * rather than jumping once its list arrives.
 */
const projectSortTimeCache = new WeakMap<Project, number>();

export const getProjectSortTime = (project: Project): number => {
  // Memoised per project OBJECT: the comparator asks for this O(n log n) times
  // and a payload hands us fresh objects, so a WeakMap both saves the repeated
  // bucket walk and cannot serve a stale score for an updated project.
  const cached = projectSortTimeCache.get(project);
  if (cached !== undefined) {
    return cached;
  }

  let newest = 0;

  for (const provider of SESSION_BUCKET_PROVIDERS) {
    const bucket = (project[sessionBucketKey(provider)] as ProjectSession[] | undefined) ?? [];
    for (const session of bucket) {
      const time = getSessionSortTime(session as SessionWithProvider);
      if (time > newest) {
        newest = time;
      }
    }
  }

  projectSortTimeCache.set(project, newest);
  return newest;
};

const getProjectSortName = (project: Project): string =>
  project.displayName || project.projectId;

/**
 * THE project comparator for the sidebar. Order: starred first, then either the
 * display name or the newest-conversation timestamp depending on the user's
 * chosen mode, and finally `projectId` — the deterministic tie-break, because
 * two projects can share a display name (or a score of 0, the common case for
 * projects with no conversations) and the leftover order then came from
 * whatever the last payload happened to serialise.
 */
export const compareProjects = (
  projectA: Project,
  projectB: Project,
  projectSortOrder: ProjectSortOrder,
): number => {
  const aStarred = Boolean(projectA.isStarred);
  const bStarred = Boolean(projectB.isStarred);
  if (aStarred !== bStarred) {
    return aStarred ? -1 : 1;
  }

  if (projectSortOrder === 'date') {
    const timeDelta = getProjectSortTime(projectB) - getProjectSortTime(projectA);
    if (timeDelta !== 0) {
      return timeDelta;
    }
  }

  const nameDelta = getProjectSortName(projectA).localeCompare(getProjectSortName(projectB));
  if (nameDelta !== 0) {
    return nameDelta;
  }

  return projectA.projectId.localeCompare(projectB.projectId);
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] =>
  [...projects].sort((projectA, projectB) =>
    compareProjects(projectA, projectB, projectSortOrder));

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  // One bucket per provider, read from the shared key list instead of six
  // hand-written blocks — the hand-written version stopped at `opencode`, so
  // hermes/kimi/glm conversations never reached the sidebar at all (B-598).
  return SESSION_BUCKET_PROVIDERS.flatMap((provider) => {
    const bucket = (project[sessionBucketKey(provider)] as ProjectSession[] | undefined) ?? [];
    return bucket.map((session) => ({ ...session, __provider: provider }));
  }).sort(compareSidebarSessions);
};

/**
 * Normalises an Arabic/Latin string for case-insensitive search:
 * lower-cases Latin characters and strips Arabic diacritics (tashkeel)
 * so that "محادثة" matches "مُحَادَثَة" etc.
 */
export const normalizeForSearch = (value: string): string =>
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
/** True when a session's own title/summary contains the normalized query. */
export const sessionTitleMatches = (session: SessionWithProvider, normalizedSearch: string): boolean => {
  const title = normalizeForSearch(
    (typeof session.summary === 'string' && session.summary.trim().length > 0
      ? session.summary
      : typeof session.name === 'string' && session.name.trim().length > 0
        ? session.name
        : typeof session.title === 'string' && session.title.trim().length > 0
          ? session.title
          : '') || session.id,
  );

  return title.includes(normalizedSearch);
};

export const getMatchedSessionIds = (project: Project, normalizedSearch: string): Set<string> => {
  if (!normalizedSearch) {
    return new Set();
  }

  const matched = new Set<string>();

  for (const session of getAllSessions(project)) {
    if (sessionTitleMatches(session, normalizedSearch)) {
      matched.add(session.id);
    }
  }

  return matched;
};

/**
 * Narrows one project's session list to what the current search should show
 * (B-332 follow-up). Pure, so the rule is testable without the controller.
 *
 * `matchBySessionId` carries the server's message matches; entries whose
 * `projectId` is this project but whose session is absent from `sessions` are
 * materialised as rows, because a project loads only its newest page and a
 * match the user cannot see is the same as no match.
 *
 * Returns the full list when nothing inside matched — that is the case where
 * the project itself matched by name or path.
 */
export const selectSearchVisibleSessions = (
  project: Project,
  sessions: SessionWithProvider[],
  options: {
    normalizedSearch: string;
    scope: SidebarSearchScope;
    matchBySessionId: Map<string, { sessionId: string; summary: string; provider: LLMProvider; projectId: string | null }>;
  },
): SessionWithProvider[] => {
  const { normalizedSearch, scope, matchBySessionId } = options;
  if (!normalizedSearch) {
    return sessions;
  }

  const useTitles = scope !== 'messages';
  const useMessages = scope !== 'titles';

  // Matched against the LIST HANDED IN, not the raw project: the caller may
  // have overlaid optimistic state onto it, and a row that is not in that list
  // cannot be shown anyway.
  const matched = sessions.filter(
    (session) =>
      (useTitles && sessionTitleMatches(session, normalizedSearch)) ||
      (useMessages && matchBySessionId.has(session.id)),
  );

  const loadedIds = new Set(sessions.map((session) => session.id));
  const unloaded: SessionWithProvider[] = [];
  if (useMessages) {
    for (const match of matchBySessionId.values()) {
      if (match.projectId !== project.projectId || loadedIds.has(match.sessionId)) {
        continue;
      }
      unloaded.push({
        id: match.sessionId,
        summary: match.summary,
        __provider: match.provider,
        __projectId: project.projectId,
      });
    }
  }

  const visible = [...matched, ...unloaded];
  return visible.length > 0 ? visible : sessions;
};

/**
 * Drops closed conversations from a rendered session list when the sidebar's
 * hide-closed filter is on. Pure, so the rule is testable without the controller.
 *
 * Two rows survive the filter on purpose:
 *  - the session the user is currently reading (`keepSessionId`). Filtering it
 *    away would pull the open conversation out of the list under the reader and
 *    leave the sidebar with nothing highlighted, which reads as "it lost my
 *    place" rather than as a filter.
 *  - anything whose `closed` is absent or falsy — read through `Boolean` for the
 *    same reason `createSessionViewModel` does: SQLite hands booleans back as
 *    0/1 and legacy rows carry no field at all.
 *
 * The source of truth here is the SERVER payload, not the optimistic override in
 * `useConversationClosed`. A row the user just closed therefore stays visible
 * until the next `projects_updated`, which is the kinder behaviour anyway: a row
 * that vanishes the instant you click its close button looks like a deletion.
 */
export const selectClosedVisibleSessions = (
  sessions: SessionWithProvider[],
  options: { hideClosed: boolean; keepSessionId?: string | null },
): SessionWithProvider[] => {
  if (!options.hideClosed) {
    return sessions;
  }

  const kept = sessions.filter(
    (session) => !session.closed || session.id === options.keepSessionId,
  );

  return kept.length === sessions.length ? sessions : kept;
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
