import fs from 'node:fs/promises';
import path from 'node:path';


import { canAccessProject, closedSessionsDb, listAccessibleProjectPaths, participantsDb, projectMembersDb, projectsDb, sessionOutcomesDb, sessionsDb, starredSessionsDb } from '@/modules/database/index.js';
import type { ClosedSessionRow } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import type { SessionOutcome } from '../../../../shared/session-outcome.js';
import {
  emptySessionBuckets,
  isSessionBucketProvider,
  sessionBucketKey,
  type SessionBuckets,
} from '../../../../shared/sessionBuckets.js';

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

/**
 * One human on a session, for the sidebar's per-conversation avatar stack. The
 * owner is included here too (role 'owner', always first), so `participants` is
 * the complete cast and `owner` above stays the single-face shorthand older
 * consumers read.
 */
export type SessionParticipantSummary = {
  userId: number;
  username: string;
  avatarUrl: string | null;
  role: 'owner' | 'participant';
  lastSeen: string;
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
  // Every human recorded on this session (owner first). Empty for legacy /
  // pre-multi-user sessions with no participant rows.
  participants: SessionParticipantSummary[];
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
  /**
   * ‏B-577 — كيف انتهت آخر جولة: 'done' | 'error' | 'question'، أو null إن لم
   * تنتهِ جولةٌ عبر هذا الخادم بعد.
   *
   * **عالميّ كـ`closed` لا شخصيّ كـ`starred`**: يقول شيئاً عن المحادثة نفسها،
   * فيُحلّ بلا `currentUserId` ويتطابق في البثّ وفي REST. و`outcomeSeen`
   * عالميّ أيضاً منذ T-1340؛ السؤال لا يصير مقروءاً بمجرد فتح المحادثة.
   */
  outcome: SessionOutcome | null;
  outcomeAt: string | null;
  outcomeSeen: boolean;
};

/**
 * Sessions grouped under their payload keys (`sessions`, `cursorSessions`, …),
 * one bucket per provider in `shared/sessionBuckets.ts`. Shaped as the payload
 * itself so the builders below spread it instead of restating the key list —
 * the restating is what silently dropped hermes/kimi/glm rows (B-598).
 */
type SessionBucketsPayload = SessionBuckets<SessionSummary>;

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
  // Public URL of the project's custom logo, or null when it has none (T-1403).
  logoUrl: string | null;
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
  /**
   * ADR-172 (qa م8): canAccessProject for the requester — platform owner/admin,
   * project member or creator. Independent of PROJECT_MEMBERSHIP_ENFORCE; this
   * is what gates the members dialog (and all access once enforced).
   */
  canAccess: boolean;
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
  dirExists: boolean | null;
  /** Timestamp of the last conclusive directory probe; null while unknown. */
  metadataCheckedAt: string | null;
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
} & SessionBucketsPayload;

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
  // sessions. Read from req.user only — never from request input.
  currentUserId?: number | null;
  // True when the requester is the platform owner (req.user.role === 'owner').
  // Retained for callers; no longer grants any project-read capability (ADR-089).
  isPlatformOwner?: boolean;
  // Whether to fan `loading_progress` frames out to every connected socket while
  // this read walks the project list. Defaults to true, which is right for a
  // user-initiated read: the sidebar draws its progress bar from those frames.
  // The watcher flush passes false — it runs this read ONCE PER CONNECTED
  // IDENTITY (B-825), and each run would otherwise re-broadcast one progress
  // frame per project to every client, multiplying background noise by the
  // number of logged-in accounts.
  broadcastProgress?: boolean;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessionBuckets: SessionBucketsPayload;
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
} & SessionBucketsPayload;

/**
 * The minimum sidebar data needed to open a conversation addressed directly by
 * URL.  Keeping this separate from the paginated project list avoids fetching
 * every older conversation merely to locate one id.
 */
export type SessionDeepLinkContext = {
  projectId: string;
  provider: string;
  session: SessionSummary;
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
  participants: SessionParticipantSummary[],
  starred: boolean,
  closedMarker: ClosedSessionRow | null,
  outcome: { outcome: SessionOutcome; outcomeAt: string } | null,
  outcomeSeen: boolean,
): SessionSummary {
  return {
    id: row.session_id,
    summary: row.custom_name || '',
    messageCount: 0,
    createdAt: row.created_at ?? null,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    owner,
    participants,
    starred,
    closed: closedMarker !== null,
    closedAt: closedMarker?.closedAt ?? null,
    closedBy: closedMarker?.closedBy ?? null,
    outcome: outcome?.outcome ?? null,
    outcomeAt: outcome?.outcomeAt ?? null,
    outcomeSeen,
  };
}

/**
 * ‏T-1340 — أحكام صفحة الجلسات وإقرارها العالمي باستعلام واحد لا N+1.
 */
function resolveOutcomesForRows(
  rows: SessionRepositoryRow[],
): { outcomes: Map<string, { outcome: SessionOutcome; outcomeAt: string; seen: boolean }> } {
  const ids = rows.map((row) => row.session_id);
  if (ids.length === 0) {
    return { outcomes: new Map() };
  }
  const outcomes = new Map<string, { outcome: SessionOutcome; outcomeAt: string; seen: boolean }>();
  for (const [sessionId, row] of sessionOutcomesDb.getOutcomesForSessions(ids)) {
    outcomes.set(sessionId, {
      outcome: row.outcome,
      outcomeAt: row.outcomeAt,
      seen: !sessionOutcomesDb.isOutcomeVisible(row),
    });
  }
  return { outcomes };
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

/**
 * Batched participant resolution for a page of session rows: ONE query returns
 * every human on every session, grouped here by session_id. Same anti-N+1
 * contract as {@link resolveOwnersForRows} — the sidebar renders an avatar per
 * participant, so it must not cost a query per row.
 */
function resolveParticipantsForRows(
  rows: SessionRepositoryRow[],
): Map<string, SessionParticipantSummary[]> {
  const bySession = new Map<string, SessionParticipantSummary[]>();

  const sessionIds = rows.map((row) => row.session_id);
  if (sessionIds.length === 0) {
    return bySession;
  }

  // The query already orders owner-first within each session, so pushing in
  // arrival order preserves it.
  for (const participantRow of participantsDb.getParticipantsBySessionIds(sessionIds)) {
    const list = bySession.get(participantRow.sessionId) ?? [];
    list.push({
      userId: participantRow.userId,
      username: participantRow.username,
      avatarUrl: participantRow.avatarUrl ?? null,
      role: participantRow.role === 'owner' ? 'owner' : 'participant',
      lastSeen: participantRow.last_seen,
    });
    bySession.set(participantRow.sessionId, list);
  }

  return bySession;
}

function bucketSessionRowsByProvider(
  rows: SessionRepositoryRow[],
  currentUserId: number | null,
): SessionBucketsPayload {
  const buckets = emptySessionBuckets<SessionSummary>();

  const owners = resolveOwnersForRows(rows);
  const participants = resolveParticipantsForRows(rows);
  const stars = resolveStarsForRows(rows, currentUserId);
  const closedMarkers = resolveClosedMarkersForRows(rows);
  const { outcomes } = resolveOutcomesForRows(rows);

  for (const row of rows) {
    // An unknown provider string is now the ONLY reason to skip a row: every
    // provider nassaj can spawn has a bucket, so a row arriving here means the
    // DB carries a provider this build does not know — dropping it beats
    // crashing the list.
    if (!isSessionBucketProvider(row.provider)) {
      continue;
    }
    const bucket = (buckets as Record<string, SessionSummary[]>)[sessionBucketKey(row.provider)];

    bucket.push(
      mapSessionRowToSummary(
        row,
        owners.get(row.session_id) ?? null,
        participants.get(row.session_id) ?? [],
        stars.has(row.session_id),
        closedMarkers.get(row.session_id) ?? null,
        outcomes.get(row.session_id) ?? null,
        (() => {
          const outcome = outcomes.get(row.session_id);
          if (!outcome) return true;
          return outcome.seen;
        })(),
      ),
    );
  }

  return buckets;
}

function readProjectSessionsIncludingArchived(
  projectPath: string,
  currentUserId: number | null,
): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];

  return {
    sessionBuckets: bucketSessionRowsByProvider(rows, currentUserId),
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
  if (currentUserId === null) {
    const rows = sessionsDb.getSessionsByProjectPathPage(
      projectPath,
      pagination.limit,
      pagination.offset,
    ) as SessionRepositoryRow[];
    const total = sessionsDb.countSessionsByProjectPath(projectPath);

    return {
      sessionBuckets: bucketSessionRowsByProvider(rows, currentUserId),
      total,
      hasMore: pagination.offset + rows.length < total,
    };
  }

  // A first page must contain every favourite, including one much older than
  // the newest normal page. Later offsets come from the number of rows already
  // rendered (starred + unstarred), so subtract the known starred prefix before
  // paging the unstarred set. This keeps "Load more" gap-free and duplicate-free.
  const starredRows = sessionsDb.getStarredSessionsByProjectPathForUser(
    currentUserId,
    projectPath,
  ) as SessionRepositoryRow[];
  const starredCount = starredRows.length;
  const unstarredOffset = Math.max(0, pagination.offset - starredCount);
  const unstarredRows = sessionsDb.getUnstarredSessionsByProjectPathPageForUser(
    currentUserId,
    projectPath,
    pagination.limit,
    unstarredOffset,
  ) as SessionRepositoryRow[];
  const unstarredTotal = sessionsDb.countUnstarredSessionsByProjectPathForUser(
    currentUserId,
    projectPath,
  );
  const includeStarred = pagination.offset === 0;
  const rows = includeStarred ? [...starredRows, ...unstarredRows] : unstarredRows;
  const total = starredCount + unstarredTotal;

  return {
    sessionBuckets: bucketSessionRowsByProvider(rows, currentUserId),
    total,
    hasMore: unstarredOffset + unstarredRows.length < unstarredTotal,
  };
}

/**
 * Resolves one active, visible conversation for `/session/:id` navigation.
 *
 * The sidebar intentionally receives a short page per project. A direct URL
 * may therefore name a conversation outside that page; returning this one
 * summary lets the client select it without progressively loading the entire
 * project history. The project visibility check preserves the list endpoint's
 * non-disclosure boundary.
 */
export function getSessionDeepLinkContext(
  sessionId: string,
  currentUserId: number | null,
): SessionDeepLinkContext | null {
  const row = sessionsDb.getSessionById(sessionId) as SessionRepositoryRow & {
    project_path?: string | null;
    isArchived?: number;
  } | null;

  if (!row || row.isArchived || !row.project_path || !isSessionBucketProvider(row.provider)) {
    return null;
  }

  const project = projectsDb.getProjectPath(row.project_path);
  if (!project || !projectsDb.isProjectVisibleToUser(project.project_id, currentUserId)) {
    return null;
  }

  const bucket = bucketSessionRowsByProvider([row], currentUserId);
  const session = bucket[sessionBucketKey(row.provider)][0];
  if (!session) {
    return null;
  }

  return { projectId: project.project_id, provider: row.provider, session };
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
    sessionSynchronizerService.requestBackgroundSynchronization();
  }

  const allProjectRows = projectsDb.getProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    detected_name?: string | null;
    isStarred?: number;
    created_by?: number | null;
    logo_url?: string | null;
    dir_exists?: number | null;
    dir_checked_at?: string | null;
  }>;

  const currentUserId =
    typeof options.currentUserId === 'number' ? options.currentUserId : null;

  // Opt-out seam for background reads; see `broadcastProgress` in the options.
  const reportProgress: (progress: ProgressUpdate) => void =
    options.broadcastProgress === false ? () => {} : broadcastProgress;

  // ADR-089 retired project visibility, so this resolves to every active
  // project. The call is kept as the single seam every read gate shares: if a
  // future release reintroduces scoping, it lands here and reaches all of them.
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
  // role. View-filter input only — never an access decision.
  const ownedProjectIds =
    currentUserId !== null
      ? new Set(projectMembersDb.listUserOwnedProjectIds(currentUserId))
      : new Set<string>();

  // One set-based query for the per-project `canAccess` flag (active projects).
  const accessiblePaths = new Set(listAccessibleProjectPaths(currentUserId));

  for (let rowIdx = 0; rowIdx < projectRows.length; rowIdx++) {
    const row = projectRows[rowIdx];
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    reportProgress({
      phase: 'loading',
      current: processedProjects,
      total: totalProjects,
      currentProject: projectPath,
    });

    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : row.detected_name?.trim() || path.basename(projectPath) || projectPath;

    const sessionsPage = readProjectSessionsPageByPath(projectPath, currentUserId, {
      limit: options.sessionsLimit,
      offset: options.sessionsOffset,
    });

    const ownerId = typeof row.created_by === 'number' ? row.created_by : null;
    const isOwner =
      currentUserId !== null && (ownerId === currentUserId || ownedProjectIds.has(projectId));
    const dirExists = row.dir_exists === null || row.dir_exists === undefined
      ? null
      : Boolean(row.dir_exists);

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      logoUrl: row.logo_url ?? null,
      isMember: memberProjectPaths.has(projectPath),
      ownerId,
      isOwner,
      canAccess: accessiblePaths.has(projectPath),
      dirExists,
      metadataCheckedAt: row.dir_checked_at ?? null,
      ...sessionsPage.sessionBuckets,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  reportProgress({
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
    sessionSynchronizerService.requestBackgroundSynchronization();
  }

  const currentUserId =
    typeof options.currentUserId === 'number' ? options.currentUserId : null;

  const allProjectRows = projectsDb.getArchivedProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    detected_name?: string | null;
    isStarred?: number;
    created_by?: number | null;
    logo_url?: string | null;
    dir_exists?: number | null;
    dir_checked_at?: string | null;
  }>;

  // getVisibleProjectPaths only resolves ACTIVE projects, so archived rows are
  // resolved per-row by isProjectVisibleToUser (which ignores the archived flag).
  // Post-ADR-089 both answer existence; the pair is kept in step deliberately.
  const projectRows = allProjectRows.filter((row) =>
    projectsDb.isProjectVisibleToUser(row.project_id, currentUserId),
  );

  const archivedProjects: ArchivedProjectListItem[] = [];

  for (let rowIdx = 0; rowIdx < projectRows.length; rowIdx++) {
    const row = projectRows[rowIdx];
    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : row.detected_name?.trim() || path.basename(row.project_path) || row.project_path;

    const sessionsPage = readProjectSessionsIncludingArchived(row.project_path, currentUserId);

    const ownerId = typeof row.created_by === 'number' ? row.created_by : null;
    const isOwner =
      currentUserId !== null &&
      (ownerId === currentUserId ||
        projectMembersDb.getRole(row.project_id, currentUserId) === 'owner');
    const archivedDirExists = row.dir_exists === null || row.dir_exists === undefined
      ? null
      : Boolean(row.dir_exists);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      logoUrl: row.logo_url ?? null,
      // Archived view does not drive the "My Projects" filter; default to false.
      isMember: false,
      ownerId,
      isOwner,
      canAccess: canAccessProject(row.project_id, currentUserId),
      dirExists: archivedDirExists,
      metadataCheckedAt: row.dir_checked_at ?? null,
      isArchived: true,
      ...sessionsPage.sessionBuckets,
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
    ...sessionsPage.sessionBuckets,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
