import fs from 'node:fs/promises';
import path from 'node:path';

import { closedSessionsDb, participantsDb, projectMembersDb, projectsDb, sessionsDb, starredSessionsDb } from '@/modules/database/index.js';
import type { ClosedSessionRow } from '@/modules/database/index.js';
import type { ProjectVisibility } from '@/shared/types.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Owner attribution for a single session. Resolved from the session_participants
 * row flagged 'owner'. `null` for legacy / pre-multi-user sessions that have no
 * participant row (the frontend falls back to a neutral state).
 */
export type SessionOwner = {
  userId: number;
  username: string;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) or null; lets
  // the frontend owner badge render the real avatar instead of the initial.
  avatarUrl: string | null;
};

type SessionSummary = {
  id: string;
  summary: string;
  messageCount: number;
  // Creation timestamp (first transcript timestamp / file birthtime at index
  // time). The sidebar orders sessions by this, newest first — not by activity.
  createdAt: string | null;
  lastActivity: string;
  owner: SessionOwner | null;
  // True when the requesting user has starred this session (per-user favorite).
  // Resolved from starred_sessions scoped to currentUserId; defaults to false
  // for anonymous reads or sessions the user has not starred.
  starred: boolean;
  // "This conversation is finished" marker. Unlike `starred` this state is
  // GLOBAL, not per user: it says something about the conversation itself, so it
  // is resolved WITHOUT currentUserId and is therefore identical in the
  // websocket broadcast (which carries no requester) and in the REST answer.
  // `closedAt` / `closedBy` are the attribution and are null while open.
  closed: boolean;
  closedAt: string | null;
  closedBy: number | null;
};

type SessionsByProvider = Record<'claude' | 'cursor' | 'codex' | 'gemini' | 'antigravity' | 'opencode', SessionSummary[]>;

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  // True when the requesting user owns or participates in >=1 session whose
  // project_path belongs to this project. Purely informational: the project
  // list is NOT filtered server-side (full sharing is preserved) — the frontend
  // "My Projects / All" toggle decides what to show.
  isMember: boolean;
  // Creator attribution for the sidebar "My projects / Team / All" filter.
  // `ownerId` is projects.created_by (null for legacy/orphan rows). `isOwner`
  // is per-requester: the creator OR a project_members 'owner'-role member.
  // Both are view-filter inputs only — never an access decision.
  ownerId: number | null;
  isOwner: boolean;
  // Private-project visibility (B-PRIV). 'private' projects only ever reach a
  // user who is allowed to see them — the list is filtered server-side below.
  visibility: ProjectVisibility;
  // True when the requesting user may toggle this project's visibility / manage
  // its members: the project creator, a project_members 'owner', or the platform
  // owner (an administrative capability, distinct from content visibility).
  canManageVisibility: boolean;
  /**
   * Whether the project directory currently exists on disk.
   *
   * `true`  — the directory is present and accessible on the server filesystem.
   * `false` — the path is missing (deleted, unmounted, or never created). The
   *           frontend uses this to render a "folder missing" warning badge next
   *           to the project name. A false value does NOT archive the project
   *           automatically — archival is performed by the reconcile service.
   *
   * CONTRACT (B-38): key name is `dirExists`, boolean, always present.
   */
  dirExists: boolean;
  sessions: SessionSummary[];
  cursorSessions: SessionSummary[];
  codexSessions: SessionSummary[];
  geminiSessions: SessionSummary[];
  antigravitySessions: SessionSummary[];
  opencodeSessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  skipSynchronization?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
  // Authenticated requester id (from req.user.id). When provided, each project's
  // `isMember` flag reflects whether this user participates in >=1 of its
  // sessions. Read from req.user only — never from request input. Also drives
  // the B-PRIV server-side visibility filter: private projects this user cannot
  // see are excluded from the list entirely.
  currentUserId?: number | null;
  // True when the requester is the platform owner (req.user.role === 'owner').
  // Grants the administrative canManageVisibility capability ONLY — it does NOT
  // bypass the visibility filter (privacy is absolute by owner decision).
  isPlatformOwner?: boolean;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessionsByProvider: SessionsByProvider;
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  cursorSessions: SessionSummary[];
  codexSessions: SessionSummary[];
  geminiSessions: SessionSummary[];
  antigravitySessions: SessionSummary[];
  opencodeSessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;

/**
 * Generate better display name from path.
 *
 * B-37: The legacy fallback that replaced all '-' with '/' was unreliable
 * because it corrupts paths containing real hyphens (e.g. `nassaj-dev`,
 * `my-app`). `actualProjectDir` (the on-disk cwd stored in the DB row) is
 * now always the primary source. The slug-decode fallback is kept only for
 * very old rows where the cwd column is absent, and even then it fires only
 * when the slug starts with '-' (the encoding of a leading '/') — so project
 * names containing hyphens are never accidentally decoded.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Prefer the real on-disk path recorded in the DB row — it is authoritative
  // and never needs reconstruction.
  let projectPath: string;
  if (actualProjectDir) {
    projectPath = actualProjectDir;
  } else if (projectName.startsWith('-')) {
    // B-37 legacy slug: a string starting with '-' is an encoded absolute path
    // (the leading '/' was stored as '-'). Reconstruct cautiously.
    projectPath = projectName.replace(/-/g, '/');
  } else {
    // Modern or non-encoded name — use as-is to preserve real hyphens.
    projectPath = projectName;
  }

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

function mapSessionRowToSummary(
  row: SessionRepositoryRow,
  owner: SessionOwner | null,
  starred: boolean,
  closedMarker: ClosedSessionRow | null,
): SessionSummary {
  return {
    id: row.session_id,
    summary: row.custom_name || '',
    messageCount: 0,
    createdAt: row.created_at ?? null,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    owner,
    starred,
    closed: closedMarker !== null,
    closedAt: closedMarker?.closedAt ?? null,
    closedBy: closedMarker?.closedBy ?? null,
  };
}

/**
 * Batched star resolution for a page of session rows: a single query returns the
 * subset of these sessions the requesting user has starred (avoids N+1). Returns
 * an empty Set for anonymous reads (no currentUserId).
 */
function resolveStarsForRows(
  rows: SessionRepositoryRow[],
  currentUserId: number | null,
): Set<string> {
  if (currentUserId === null) {
    return new Set<string>();
  }
  return starredSessionsDb.getStarredSessionIds(
    currentUserId,
    rows.map((row) => row.session_id),
  );
}

/**
 * Batched "closed" resolution for a page of session rows.
 *
 * Deliberately NOT scoped to a user: the marker is global, so this returns the
 * same answer for the websocket broadcast (no requester at all) as for a REST
 * read — the sidebar can never show a conversation as open to one viewer and
 * closed to another.
 *
 * ONE page-bounded query, always: ids and attribution (who / when) come back
 * together. The earlier shape asked for the ids, then read the ENTIRE markers
 * table for the attribution — and since this runs per project, a page render
 * was O(projects x closed_sessions), growing with every conversation ever
 * closed. An empty page still short-circuits without touching the DB.
 */
function resolveClosedMarkersForRows(rows: SessionRepositoryRow[]): Map<string, ClosedSessionRow> {
  const markers = new Map<string, ClosedSessionRow>();

  const sessionIds = rows.map((row) => row.session_id);
  if (sessionIds.length === 0) {
    return markers;
  }

  for (const marker of closedSessionsDb.getClosedSessionRows(sessionIds)) {
    markers.set(marker.sessionId, marker);
  }

  return markers;
}

/**
 * Batched owner resolution for a page of session rows: a single query fetches
 * the owner of every session at once (avoids N+1), keyed by session_id. Legacy
 * sessions absent from the map resolve to a null owner.
 */
function resolveOwnersForRows(rows: SessionRepositoryRow[]): Map<string, SessionOwner> {
  const sessionIds = rows.map((row) => row.session_id);
  const owners = new Map<string, SessionOwner>();

  if (sessionIds.length === 0) {
    return owners;
  }

  for (const ownerRow of participantsDb.getOwnersBySessionIds(sessionIds)) {
    owners.set(ownerRow.sessionId, {
      userId: ownerRow.userId,
      username: ownerRow.username,
      avatarUrl: ownerRow.avatarUrl ?? null,
    });
  }

  return owners;
}

function bucketSessionRowsByProvider(
  rows: SessionRepositoryRow[],
  currentUserId: number | null,
): SessionsByProvider {
  const byProvider: SessionsByProvider = {
    claude: [],
    cursor: [],
    codex: [],
    gemini: [],
    antigravity: [],
    opencode: [],
  };

  const owners = resolveOwnersForRows(rows);
  const stars = resolveStarsForRows(rows, currentUserId);
  const closedMarkers = resolveClosedMarkersForRows(rows);

  for (const row of rows) {
    const provider = row.provider as keyof SessionsByProvider;
    const bucket = byProvider[provider];
    if (!bucket) {
      continue;
    }

    bucket.push(
      mapSessionRowToSummary(
        row,
        owners.get(row.session_id) ?? null,
        stars.has(row.session_id),
        closedMarkers.get(row.session_id) ?? null,
      ),
    );
  }

  return byProvider;
}

function readProjectSessionsIncludingArchived(
  projectPath: string,
  currentUserId: number | null,
): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];

  return {
    sessionsByProvider: bucketSessionRowsByProvider(rows, currentUserId),
    total: rows.length,
    hasMore: false,
  };
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionsPageByPath(
  projectPath: string,
  currentUserId: number | null,
  options: SessionPaginationOptions = {},
): ProjectSessionsPageResult {
  const pagination = normalizeSessionPagination(options);
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath);

  return {
    sessionsByProvider: bucketSessionRowsByProvider(rows, currentUserId),
    total,
    hasMore: pagination.offset + rows.length < total,
  };
}

// Broadcast progress to all connected WebSocket clients
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    type: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Reads all projects from DB and returns provider-bucketed session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const allProjectRows = projectsDb.getProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
    visibility?: ProjectVisibility;
    created_by?: number | null;
  }>;

  const currentUserId =
    typeof options.currentUserId === 'number' ? options.currentUserId : null;

  // B-PRIV central enforcement: resolve the set of project paths this user is
  // allowed to see (public + creator + explicit member + session-derived) and
  // drop everything else BEFORE building the payload, so a private project is
  // never serialized to a non-member in the first place.
  const visibleProjectPaths = new Set(projectsDb.getVisibleProjectPaths(currentUserId));
  const projectRows = allProjectRows.filter((row) => visibleProjectPaths.has(row.project_path));

  const totalProjects = projectRows.length;
  const projects: ProjectListItem[] = [];
  let processedProjects = 0;

  // One set-based query: the distinct project paths this user participates in,
  // used to flag each project's `isMember` without filtering the list.
  const memberProjectPaths =
    currentUserId !== null
      ? new Set(participantsDb.getProjectPathsForUser(currentUserId))
      : new Set<string>();

  // project_ids where the user holds the project_members 'owner' role — one query
  // instead of a per-project lookup. Combined with created_by and platform-owner
  // role to decide canManageVisibility below.
  const ownedProjectIds =
    currentUserId !== null
      ? new Set(projectMembersDb.listUserOwnedProjectIds(currentUserId))
      : new Set<string>();

  // B-38 (parallelised): resolve all dirExists checks in one concurrent batch
  // instead of awaiting each fs.access inside the loop (which serialises I/O
  // across every project). Results are indexed by position to match projectRows.
  const dirExistsResults = await Promise.all(
    projectRows.map((row) =>
      fs.access(row.project_path).then(() => true, () => false),
    ),
  );

  for (let rowIdx = 0; rowIdx < projectRows.length; rowIdx++) {
    const row = projectRows[rowIdx];
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    broadcastProgress({
      phase: 'loading',
      current: processedProjects,
      total: totalProjects,
      currentProject: projectPath,
    });

    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);

    const sessionsPage = readProjectSessionsPageByPath(projectPath, currentUserId, {
      limit: options.sessionsLimit,
      offset: options.sessionsOffset,
    });

    const visibility: ProjectVisibility = row.visibility === 'private' ? 'private' : 'public';
    const ownerId = typeof row.created_by === 'number' ? row.created_by : null;
    const isOwner =
      currentUserId !== null && (ownerId === currentUserId || ownedProjectIds.has(projectId));
    const canManageVisibility =
      isOwner || (currentUserId !== null && options.isPlatformOwner === true);

    const dirExists = dirExistsResults[rowIdx];

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      isMember: memberProjectPaths.has(projectPath),
      ownerId,
      isOwner,
      visibility,
      canManageVisibility,
      dirExists,
      sessions: sessionsPage.sessionsByProvider.claude,
      cursorSessions: sessionsPage.sessionsByProvider.cursor,
      codexSessions: sessionsPage.sessionsByProvider.codex,
      geminiSessions: sessionsPage.sessionsByProvider.gemini,
      antigravitySessions: sessionsPage.sessionsByProvider.antigravity,
      opencodeSessions: sessionsPage.sessionsByProvider.opencode,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  });

  return projects;
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'skipSynchronization' | 'currentUserId' | 'isPlatformOwner'> = {},
): Promise<ArchivedProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const currentUserId =
    typeof options.currentUserId === 'number' ? options.currentUserId : null;

  const allProjectRows = projectsDb.getArchivedProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
    visibility?: ProjectVisibility;
    created_by?: number | null;
  }>;

  // B-PRIV: getVisibleProjectPaths only resolves active projects, so archived
  // visibility is decided per-row by isProjectVisibleToUser (which ignores the
  // archived flag). A private archived project stays hidden from non-members.
  const projectRows = allProjectRows.filter((row) =>
    projectsDb.isProjectVisibleToUser(row.project_id, currentUserId),
  );

  const archivedProjects: ArchivedProjectListItem[] = [];

  // B-38 (parallelised): resolve all dirExists checks in one concurrent batch.
  const archivedDirExistsResults = await Promise.all(
    projectRows.map((row) =>
      fs.access(row.project_path).then(() => true, () => false),
    ),
  );

  for (let rowIdx = 0; rowIdx < projectRows.length; rowIdx++) {
    const row = projectRows[rowIdx];
    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);

    const sessionsPage = readProjectSessionsIncludingArchived(row.project_path, currentUserId);

    const visibility: ProjectVisibility = row.visibility === 'private' ? 'private' : 'public';
    const ownerId = typeof row.created_by === 'number' ? row.created_by : null;
    const isOwner =
      currentUserId !== null &&
      (ownerId === currentUserId ||
        projectMembersDb.getRole(row.project_id, currentUserId) === 'owner');
    const canManageVisibility =
      isOwner || (currentUserId !== null && options.isPlatformOwner === true);

    const archivedDirExists = archivedDirExistsResults[rowIdx];

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      // Archived view does not drive the "My Projects" filter; default to false.
      isMember: false,
      ownerId,
      isOwner,
      visibility,
      canManageVisibility,
      dirExists: archivedDirExists,
      isArchived: true,
      sessions: sessionsPage.sessionsByProvider.claude,
      cursorSessions: sessionsPage.sessionsByProvider.cursor,
      codexSessions: sessionsPage.sessionsByProvider.codex,
      geminiSessions: sessionsPage.sessionsByProvider.gemini,
      antigravitySessions: sessionsPage.sessionsByProvider.antigravity,
      opencodeSessions: sessionsPage.sessionsByProvider.opencode,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  return archivedProjects;
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions & { currentUserId?: number | null } = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const currentUserId =
    typeof options.currentUserId === 'number' ? options.currentUserId : null;
  const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, currentUserId, {
    limit: options.limit,
    offset: options.offset,
  });
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessionsByProvider.claude,
    cursorSessions: sessionsPage.sessionsByProvider.cursor,
    codexSessions: sessionsPage.sessionsByProvider.codex,
    geminiSessions: sessionsPage.sessionsByProvider.gemini,
    antigravitySessions: sessionsPage.sessionsByProvider.antigravity,
    opencodeSessions: sessionsPage.sessionsByProvider.opencode,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
