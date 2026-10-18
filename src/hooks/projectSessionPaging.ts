/**
 * Pure helpers that keep a project's paged session list consistent with the
 * server (B-1668).
 *
 * The sidebar loads each project's sessions one page at a time. Three kinds of
 * rows can sit in a loaded list, and the helpers below tell them apart through
 * client-only tags on the rows themselves:
 *  - server-paged rows: every row of a server page; unstarred ones carry
 *    `__pagedUnstarred`, starred ones are always on the first page;
 *  - the deep-linked row (`__deepLinked`): one conversation merged in for a
 *    `/session/:id` URL, wherever it sits in the server order;
 *  - nothing else — a row is never invented client-side.
 *
 * The next "load more" offset counts server-paged rows only, and a fresh first
 * page reconciles (rather than unions) with the previously loaded rows, so
 * deleted or archived conversations leave the list.
 */
import type { Project, ProjectSession } from '../types/app';
import type { SessionWithProvider } from '../components/sidebar/types/types';
import { compareSessionRecency } from '../components/sidebar/utils/utils';
import {
  SESSION_BUCKET_KEYS,
  type SessionBucketKey,
  type SessionBuckets,
} from '../../shared/sessionBuckets';

/** One page of sessions for a single project: every bucket, plus the meta. */
export type ProjectSessionsPage = Partial<SessionBuckets<ProjectSession>> & Pick<Project, 'sessionMeta'>;

/** Largest page the server accepts (projects-with-sessions-fetch.service.ts). */
const MAX_SESSIONS_PAGE_SIZE = 200;

/** Reads one provider's session bucket off a project payload. */
export const readSessionBucket = (project: Partial<Project>, key: SessionBucketKey): ProjectSession[] =>
  (project[key] as ProjectSession[] | undefined) ?? [];

/** Every loaded session of a project, across provider buckets. */
export const getProjectSessions = (project: Partial<Project>): ProjectSession[] =>
  SESSION_BUCKET_KEYS.flatMap((key) => readSessionBucket(project, key));

const isOlderThan = (session: ProjectSession, boundary: ProjectSession): boolean =>
  compareSessionRecency(session as SessionWithProvider, boundary as SessionWithProvider) > 0;

const isPagedUnstarred = (session: ProjectSession): boolean =>
  Boolean(session.__pagedUnstarred) && !session.starred;

/** Marks a row as having arrived in a server page. */
const tagServerRow = (session: ProjectSession): ProjectSession => {
  if (session.starred) {
    return session.__pagedUnstarred ? { ...session, __pagedUnstarred: false } : session;
  }
  return session.__pagedUnstarred ? session : { ...session, __pagedUnstarred: true };
};

/** Tags every row of a server payload; buckets the payload lacks stay absent. */
export const tagServerPage = <T extends Partial<SessionBuckets<ProjectSession>>>(page: T): T => {
  const tagged = { ...page };
  for (const key of SESSION_BUCKET_KEYS) {
    const bucket = page[key] as ProjectSession[] | undefined;
    if (bucket) {
      (tagged as Record<string, unknown>)[key] = bucket.map(tagServerRow);
    }
  }
  return tagged;
};

/**
 * The oldest server-paged unstarred row: the edge of what the server has
 * handed this client so far. Null when no unstarred page row is loaded.
 */
export const findPagedBoundary = (sessions: ProjectSession[]): ProjectSession | null => {
  let boundary: ProjectSession | null = null;
  for (const session of sessions) {
    if (isPagedUnstarred(session) && (!boundary || isOlderThan(session, boundary))) {
      boundary = session;
    }
  }
  return boundary;
};

/**
 * Offset for the next "load more" request: loaded starred rows plus the
 * unstarred rows that are not older than the paged boundary.
 *
 * The server pages the unstarred set at `offset - starredCount`, so a row the
 * server never paged — a deep-linked conversation, or a row that was starred
 * when page one arrived and has since been unstarred while older than the
 * window — must not count, or every later page skips one conversation.
 */
export const computeNextSessionOffset = (project: Project): number => {
  const sessions = getProjectSessions(project);
  const starredCount = sessions.filter((session) => session.starred).length;
  const boundary = findPagedBoundary(sessions);
  if (!boundary) {
    return starredCount;
  }
  const unstarredCount = sessions.filter(
    (session) => !session.starred && !session.__deepLinked && !isOlderThan(session, boundary),
  ).length;
  return starredCount + unstarredCount;
};

/**
 * Unions a server page into a loaded bucket. A loaded row wins over the page's
 * copy (a late page must not roll back a newer title or close state), except a
 * deep-linked row: the server copy replaces it, which clears the tag so the
 * row starts counting towards the offset.
 */
export const mergeSessionProviderLists = (
  baseSessions: ProjectSession[],
  additionalSessions: ProjectSession[],
): ProjectSession[] => {
  const merged = [...baseSessions];
  const indexById = new Map(baseSessions.map((session, index) => [String(session.id), index]));

  for (const session of additionalSessions) {
    const index = indexById.get(String(session.id));
    if (index === undefined) {
      indexById.set(String(session.id), merged.length);
      merged.push(session);
    } else if (merged[index].__deepLinked) {
      merged[index] = session;
    }
  }

  return merged;
};

/** Merges one "load more" page; `hasMore` is the server's word, never a count. */
export const mergeProjectSessionPage = (
  existingProject: Project,
  sessionsPage: ProjectSessionsPage,
): Project => {
  const taggedPage = tagServerPage(sessionsPage);
  const mergedProject: Project = { ...existingProject };
  for (const key of SESSION_BUCKET_KEYS) {
    mergedProject[key] = mergeSessionProviderLists(
      readSessionBucket(existingProject, key),
      readSessionBucket(taggedPage, key),
    );
  }

  mergedProject.sessionMeta = { ...existingProject.sessionMeta, ...sessionsPage.sessionMeta };
  return mergedProject;
};

/** Adds the one conversation resolved for a direct URL, tagged as deep-linked. */
export const addDeepLinkedRow = (
  project: Project,
  bucket: SessionBucketKey,
  session: ProjectSession,
): Project => {
  if (getProjectSessions(project).some((candidate) => String(candidate.id) === String(session.id))) {
    return project;
  }
  return { ...project, [bucket]: [...readSessionBucket(project, bucket), { ...session, __deepLinked: true }] };
};

/**
 * Previous rows that survive a fresh first page: rows of deeper loaded pages
 * (only while the server says more exist beyond page one), and the
 * deep-linked row. Everything else absent from page one is gone.
 */
const selectSurvivingRows = (previous: ProjectSession[], incoming: Project): ProjectSession[] => {
  const incomingRows = getProjectSessions(incoming);
  const incomingIds = new Set(incomingRows.map((session) => String(session.id)));
  const boundary = incoming.sessionMeta?.hasMore === true ? findPagedBoundary(incomingRows) : null;

  return previous.filter((session) => {
    if (incomingIds.has(String(session.id))) return false;
    if (session.__deepLinked) return true;
    return boundary !== null && isPagedUnstarred(session) && isOlderThan(session, boundary);
  });
};

/** Reconciles one project's fresh first page with what was loaded before. */
const reconcileProject = (
  previousProject: Project,
  incomingProject: Project,
): { project: Project; keptDeeper: boolean } => {
  const survivors = selectSurvivingRows(getProjectSessions(previousProject), incomingProject);
  if (survivors.length === 0) {
    return { project: incomingProject, keptDeeper: false };
  }

  const survivorIds = new Set(survivors.map((session) => String(session.id)));
  const merged: Project = { ...incomingProject };
  for (const key of SESSION_BUCKET_KEYS) {
    const kept = readSessionBucket(previousProject, key).filter((session) => survivorIds.has(String(session.id)));
    if (kept.length > 0) {
      merged[key] = [...readSessionBucket(incomingProject, key), ...kept];
    }
  }

  const keptDeeper = survivors.some((session) => !session.__deepLinked);
  if (keptDeeper) {
    merged.sessionMeta = { ...incomingProject.sessionMeta, hasMore: previousProject.sessionMeta?.hasMore };
  }
  return { project: merged, keptDeeper };
};

/**
 * Applies a fresh projects payload (broadcast, fetch or manual refresh) over
 * the loaded state. Returns the merged list and the ids of projects whose
 * deeper pages were kept — those need a window refresh, because rows beyond
 * page one can be renamed, closed or deleted without this payload saying so.
 */
export const mergeExpandedSessionPages = (
  previousProjects: Project[],
  incomingProjects: Project[],
): { projects: Project[]; deeperProjectIds: string[] } => {
  const previousByProjectId = new Map(previousProjects.map((project) => [project.projectId, project]));
  const deeperProjectIds: string[] = [];

  const projects = incomingProjects.map((rawProject) => {
    const incomingProject = tagServerPage(rawProject);
    const previousProject = previousByProjectId.get(incomingProject.projectId);
    if (!previousProject) {
      return incomingProject;
    }
    const { project, keptDeeper } = reconcileProject(previousProject, incomingProject);
    if (keptDeeper) deeperProjectIds.push(project.projectId);
    return project;
  });

  return { projects, deeperProjectIds };
};

/**
 * The request that re-reads every loaded unstarred row of a project in one
 * page, or null when nothing server-paged is loaded. The offset skips the
 * starred prefix, which page one already carries fresh.
 */
export const computeWindowRefreshRequest = (project: Project): { limit: number; offset: number } | null => {
  const sessions = getProjectSessions(project);
  const pagedCount = sessions.filter(isPagedUnstarred).length;
  if (pagedCount === 0) {
    return null;
  }
  const starredCount = sessions.filter((session) => session.starred).length;
  return { limit: Math.min(pagedCount, MAX_SESSIONS_PAGE_SIZE), offset: starredCount };
};

/**
 * Replaces a project's server-paged unstarred rows wholesale with a window
 * refresh page. Starred rows and the deep-linked row stay unless the page
 * itself carries them.
 */
export const applyWindowRefresh = (project: Project, page: ProjectSessionsPage): Project => {
  const taggedPage = tagServerPage(page);
  const pageIds = new Set(getProjectSessions(taggedPage).map((session) => String(session.id)));
  const refreshed: Project = { ...project };
  for (const key of SESSION_BUCKET_KEYS) {
    const kept = readSessionBucket(project, key).filter(
      (session) => !pageIds.has(String(session.id)) && (session.starred || session.__deepLinked),
    );
    refreshed[key] = [...kept, ...readSessionBucket(taggedPage, key)];
  }
  refreshed.sessionMeta = { ...project.sessionMeta, ...page.sessionMeta };
  return refreshed;
};

/**
 * True when `sessionId` is listed under `projectId` in the given projects
 * snapshot. Exported for the B-290 regression test: it is the single fact that
 * separates "this conversation was deleted" from "this conversation has not
 * been indexed yet".
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

/**
 * B-290, shared by every path that replaces loaded rows: a selected session
 * counts as deleted only when it WAS listed before and is absent after. A
 * just-minted conversation is absent from both and must stay selected.
 */
export const wasSessionRemoved = (
  previousProjects: Project[],
  nextProjects: Project[],
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
): boolean =>
  isSessionListedInProjects(previousProjects, projectId, sessionId)
  && !isSessionListedInProjects(nextProjects, projectId, sessionId);
