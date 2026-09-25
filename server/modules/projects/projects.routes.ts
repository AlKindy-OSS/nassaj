/* eslint-disable boundaries/no-unknown -- project router composes shared HTTP middleware. */
import crypto from 'node:crypto';

import express from 'express';
import multer from 'multer';

import { createRateLimiter } from '@/middleware/rate-limit.js';
import { DeviceBoundSseStream } from '@/modules/account-wallet/index.js';
import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  deleteProjectLogo,
  PROJECT_LOGO_MAX_BYTES,
  PROJECT_LOGO_MIME_TO_EXT,
  saveProjectLogo,
} from '@/modules/projects/services/project-logo.service.js';
import { createProject, updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import { parseCanonicalGitHubUrl } from '@/modules/projects/services/git-transport-security.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions, getSessionDeepLinkContext } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { applyLegacyStarredProjectIds, setProjectStar, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';
import { notifySessionMetadataChanged, participantsService, sessionSynchronizerService } from '@/modules/providers/index.js';
import { assertProjectVisible } from '@/modules/projects/services/project-visibility-guard.service.js';
import {
  addMember,
  canManageProject,
  isOrphanProject,
  listMembers,
  recoverOrphanByTransfer,
  removeMember,
  searchMemberCandidates,
} from '@/modules/projects/services/project-visibility-management.service.js';
import type { MembershipAuditContext } from '@/modules/projects/services/project-visibility-management.service.js';

const router = express.Router();

const CLONE_TICKET_TTL_MS = 60_000;
const MAX_CLONE_TICKETS_PER_USER = 8;
const CLONE_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BULK_PROJECT_LIMIT = 100;

type CloneTicketRecord = {
  userId: number;
  expiresAt: number;
  input: {
    workspacePath: string;
    githubUrl: string;
    githubTokenId: number | null;
    newGithubToken: string | null;
  };
};

const cloneTickets = new Map<string, CloneTicketRecord>();

function pruneExpiredCloneTickets(now = Date.now()): void {
  for (const [ticket, record] of cloneTickets) {
    if (record.expiresAt <= now) cloneTickets.delete(ticket);
  }
}

export function createCloneTicket(userId: number, input: CloneTicketRecord['input'], now = Date.now()) {
  pruneExpiredCloneTickets(now);
  const activeForUser = [...cloneTickets.values()].filter((record) => record.userId === userId).length;
  if (activeForUser >= MAX_CLONE_TICKETS_PER_USER) {
    throw new AppError('Too many pending clone requests', {
      code: 'CLONE_TICKET_LIMIT_REACHED', statusCode: 429,
    });
  }
  const ticket = crypto.randomBytes(32).toString('base64url');
  const record = { userId, input, expiresAt: now + CLONE_TICKET_TTL_MS };
  cloneTickets.set(ticket, record);
  const timer = setTimeout(() => {
    if (cloneTickets.get(ticket) === record) cloneTickets.delete(ticket);
  }, CLONE_TICKET_TTL_MS);
  timer.unref();
  return { ticket, expiresInSeconds: CLONE_TICKET_TTL_MS / 1000 };
}

export function consumeCloneTicket(ticket: string, userId: number, now = Date.now()) {
  if (!CLONE_TICKET_PATTERN.test(ticket)) return null;
  const record = cloneTickets.get(ticket);
  if (!record || record.userId !== userId) return null;
  cloneTickets.delete(ticket);
  return record.expiresAt > now ? record.input : null;
}

export function resetCloneTicketsForTests(): void {
  cloneTickets.clear();
}

type AuthenticatedUser = {
  id?: number | string;
  role?: string;
};

/**
 * True when the authenticated user is the platform owner (role 'owner'). Grants
 * administrative capabilities (manage-visibility flag, orphan recovery) but NEVER
 * bypasses the private-project visibility filter — privacy is absolute (B-PRIV).
 */
function isPlatformOwner(req: express.Request): boolean {
  const authenticatedUser = (req as express.Request & { user?: AuthenticatedUser }).user;
  return authenticatedUser?.role === 'owner';
}

/**
 * Reads the authenticated user's numeric id from req.user (set by
 * authenticateToken). Returns null when absent or non-numeric. Ownership and
 * participation are ALWAYS derived from this — never from request input.
 */
function readAuthenticatedUserId(req: express.Request): number | null {
  const authenticatedUser = (req as express.Request & { user?: AuthenticatedUser }).user;
  const rawId = authenticatedUser?.id;
  if (typeof rawId === 'number' && Number.isInteger(rawId)) {
    return rawId;
  }

  if (typeof rawId === 'string' && rawId.trim() !== '') {
    const parsed = Number.parseInt(rawId, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

/** Strict, bounded and order-preserving project selection for bulk mutations. */
function parseBulkProjectIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('Request body must be an object with an ids array.', {
      code: 'INVALID_BULK_IDS', statusCode: 400,
    });
  }
  const ids = (payload as Record<string, unknown>).ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > BULK_PROJECT_LIMIT) {
    throw new AppError(`ids must contain between 1 and ${BULK_PROJECT_LIMIT} project ids.`, {
      code: 'INVALID_BULK_IDS', statusCode: 400,
    });
  }
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const value of ids) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!PROJECT_ID_PATTERN.test(id)) {
      throw new AppError('ids contains an invalid project id.', {
        code: 'INVALID_BULK_IDS', statusCode: 400,
      });
    }
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }
  return uniqueIds;
}

type BulkProjectResult =
  | { id: string; success: true }
  | { id: string; success: false; error: { code: string; message: string } };

function bulkProjectFailure(id: string, error: unknown): BulkProjectResult {
  if (error instanceof AppError) {
    return { id, success: false, error: { code: error.code, message: error.message } };
  }
  return { id, success: false, error: { code: 'BULK_ACTION_FAILED', message: 'Bulk action failed.' } };
}

function notifyProjectSessionMetadata(projectPath: string): void {
  for (const session of sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath)) {
    notifySessionMetadataChanged(session.provider as Parameters<typeof notifySessionMetadataChanged>[0], session.session_id);
  }
}

/**
 * MUTATION guard for a project (B-IDOR-PROJECT). The read guard
 * `assertProjectVisible` returns true for EVERY `visibility = 'public'` project
 * to ANY authenticated user (public is readable by the whole team by design,
 * B-PRIV) — and every project on this install is public. Guarding a mutation with
 * it therefore authorized nothing at all: rename / star / restore / archive /
 * delete were open to any authenticated account, and `DELETE ?force=true` drops
 * the project row, every session row for its path, and every transcript file on
 * disk.
 *
 * The mandate is membership-based instead (projectsDb.isProjectWritableByUser:
 * creator, explicit project_members row, or active session participant), the same
 * predicate that already guards file writes inside a project (B-138), OR the
 * administrative management right (`canManageProject`: creator, project 'owner'
 * member, or the platform owner). Including the management right grants no new
 * privilege — a platform owner can already add themselves as a member through the
 * membership route — while keeping administrative access to projects whose
 * `created_by` predates the column.
 *
 * Answers 404, never 403, so a private project the caller cannot see is not
 * disclosed by probing a mutation (the B-PRIV non-disclosure guarantee).
 */
function assertProjectWritable(req: express.Request, projectId: string): void {
  const userId = readAuthenticatedUserId(req);
  const authorized =
    projectsDb.isProjectWritableByUser(projectId, userId) ||
    canManageProject(projectId, userId, isPlatformOwner(req));

  if (!authorized) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }
}

/**
 * Stricter gate for the IRREVERSIBLE force-delete: DB row + session rows +
 * `*.jsonl` transcripts, with no restore path. Being a session participant on a
 * project is enough to WRITE in it, but not to destroy it wholesale — this
 * requires the management right (creator / project 'owner' member / platform
 * owner). 404 on refusal, for the same non-disclosure reason.
 */
function assertProjectManageable(req: express.Request, projectId: string): void {
  if (!canManageProject(projectId, readAuthenticatedUserId(req), isPlatformOwner(req))) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }
}

function readQueryStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return '';
}

function readOptionalNumericQueryValue(value: unknown): number | null {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function parseNonNegativeIntQuery(value: unknown, name: string, fallback: number): number {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    throw new AppError(`${name} must be a non-negative integer`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsedValue;
}

function resolveRouteErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Failed to clone repository';
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const skipSynchronization =
      readQueryStringValue(req.query.skipSynchronization).trim() === '1' ||
      readQueryStringValue(req.query.skipSync).trim() === '1';
    const sessionsLimit = readOptionalNumericQueryValue(req.query.sessionsLimit) ?? undefined;
    const sessionsOffset = readOptionalNumericQueryValue(req.query.sessionsOffset) ?? undefined;
    const projects = await getProjectsWithSessions({
      skipSynchronization,
      sessionsLimit,
      sessionsOffset,
      // isMember flagging (c98aeb7) must survive the lightweight query path:
      // the "my projects" sidebar filter depends on it in every response shape.
      // currentUserId also drives the B-PRIV server-side visibility filter.
      currentUserId: readAuthenticatedUserId(req),
      isPlatformOwner: isPlatformOwner(req),
    });
    const snapshot = sessionSynchronizerService.getSnapshotMetadata();
    res.setHeader('X-Nassaj-Snapshot-State', snapshot.state);
    if (snapshot.asOf) {
      res.setHeader('X-Nassaj-Snapshot-As-Of', snapshot.asOf);
    }
    res.json(projects);
  }),
);

router.get(
  '/archived',
  asyncHandler(async (req, res) => {
    const projects = await getArchivedProjectsWithSessions({
      currentUserId: readAuthenticatedUserId(req),
      isPlatformOwner: isPlatformOwner(req),
    });
    const snapshot = sessionSynchronizerService.getSnapshotMetadata();
    res.setHeader('X-Nassaj-Snapshot-State', snapshot.state);
    if (snapshot.asOf) {
      res.setHeader('X-Nassaj-Snapshot-As-Of', snapshot.asOf);
    }
    res.json(createApiSuccessResponse({ projects }));
  }),
);

// Resolve a single conversation named by a direct `/session/:id` URL. This
// route deliberately returns no transcript content and shares the project-list
// visibility boundary, so it cannot be used to enumerate hidden sessions.
router.get(
  '/session-context/:sessionId',
  asyncHandler(async (req, res) => {
    const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
    const context = getSessionDeepLinkContext(sessionId, readAuthenticatedUserId(req));
    if (!context) {
      throw new AppError('Session not found', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    res.json(context);
  }),
);

router.get(
  '/:projectId/sessions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    // B-PRIV guard: 404 (not 403) when the project is not visible to this user.
    assertProjectVisible(projectId, readAuthenticatedUserId(req));
    const limit = parseNonNegativeIntQuery(req.query.limit, 'limit', 20);
    const offset = parseNonNegativeIntQuery(req.query.offset, 'offset', 0);
    const sessionsPage = await getProjectSessionsPage(projectId, {
      limit,
      offset,
      currentUserId: readAuthenticatedUserId(req),
    });
    res.json(sessionsPage);
  }),
);

router.post(
  '/create-project',
  asyncHandler(async (req, res) => {
    const requestBody = req.body as Record<string, unknown>;
    const projectPath = typeof requestBody.path === 'string' ? requestBody.path : '';
    const customName = typeof requestBody.customName === 'string' ? requestBody.customName : null;

    if (requestBody.workspaceType !== undefined) {
      throw new AppError('workspaceType is no longer supported. Use the single create-project flow.', {
        code: 'LEGACY_WORKSPACE_TYPE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    if (requestBody.githubUrl || requestBody.githubTokenId || requestBody.newGithubToken) {
      throw new AppError('Repository cloning is not supported on create-project', {
        code: 'CLONE_NOT_SUPPORTED_ON_CREATE_PROJECT',
        statusCode: 400,
        details: 'Create a /api/projects/clone-ticket before opening clone-progress',
      });
    }

    const projectCreationResult = await createProject({
      projectPath,
      customName,
      createdBy: readAuthenticatedUserId(req),
    });

    res.json({
      success: true,
      project: projectCreationResult.project,
      message:
        projectCreationResult.outcome === 'reactivated_archived'
          ? 'Archived project path reused successfully'
          : 'Project created successfully',
    });
  }),
);

/**
 * One-time (or idempotent) migration: apply legacy `localStorage` starred projectIds to the DB, then clear client storage.
 */
router.post(
  '/migrate-legacy-stars',
  asyncHandler(async (req, res) => {
    const projectIds = Array.isArray((req.body as { projectIds?: unknown })?.projectIds)
      ? ((req.body as { projectIds: unknown[] }).projectIds as unknown[]).map((x) => String(x))
      : [];
    const { updated } = applyLegacyStarredProjectIds(projectIds);
    res.json({ success: true, updated });
  }),
);

router.post('/clone-ticket', (req, res) => {
  try {
    const userId = readAuthenticatedUserId(req);
    if (userId === null) return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workspacePath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!workspacePath) return res.status(400).json({ error: 'INVALID_CLONE_REQUEST' });
    let githubUrl: string;
    try {
      githubUrl = parseCanonicalGitHubUrl(typeof body.githubUrl === 'string' ? body.githubUrl : '').cloneUrl;
    } catch {
      return res.status(400).json({ error: 'INVALID_GITHUB_URL' });
    }
    const githubTokenId = body.githubTokenId == null ? null : Number(body.githubTokenId);
    if (githubTokenId !== null && (!Number.isSafeInteger(githubTokenId) || githubTokenId <= 0)) {
      return res.status(400).json({ error: 'INVALID_CLONE_REQUEST' });
    }
    const newGithubToken = typeof body.newGithubToken === 'string' && body.newGithubToken.trim()
      ? body.newGithubToken.trim() : null;
    if (newGithubToken && Buffer.byteLength(newGithubToken, 'utf8') > 16 * 1024) {
      return res.status(400).json({ error: 'INVALID_CLONE_REQUEST' });
    }
    return res.status(201).json(createCloneTicket(userId, {
      workspacePath, githubUrl, githubTokenId, newGithubToken,
    }));
  } catch (error) {
    if (error instanceof AppError) return res.status(error.statusCode).json({ error: error.code });
    return res.status(500).json({ error: 'CLONE_TICKET_CREATE_FAILED' });
  }
});

router.get('/clone-progress', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let cloneOperation: Awaited<ReturnType<typeof startCloneProject>> | null = null;
  let identityInvalidated = false;
  const stream = new DeviceBoundSseStream(
    res,
    (req as express.Request & { user?: unknown }).user,
    () => {
      identityInvalidated = true;
      cloneOperation?.cancel();
    },
  );
  const sendEvent = (type: string, data: Record<string, unknown>) =>
    stream.send({ type, ...data });
  const closeListener = () => {
    cloneOperation?.cancel();
    stream.markClientGone();
  };
  req.on('close', closeListener);

  try {
    const userId = readAuthenticatedUserId(req);
    if (userId === null) {
      throw new AppError('Authenticated user is required', {
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
      });
    }
    const input = consumeCloneTicket(readQueryStringValue(req.query.ticket), userId);
    if (!input) {
      throw new AppError('Clone request is unavailable', {
        code: 'CLONE_TICKET_INVALID', statusCode: 404,
      });
    }

    cloneOperation = await startCloneProject(
      {
        ...input,
        userId,
      },
      {
        onProgress: (message) => {
          sendEvent('progress', { message });
        },
        onComplete: ({ project, message }) => {
          sendEvent('complete', { project, message });
        },
      },
    );

    if (identityInvalidated || !stream.isOpen()) cloneOperation.cancel();

    await cloneOperation.waitForCompletion;
  } catch (error) {
    sendEvent('error', { message: resolveRouteErrorMessage(error) });
  } finally {
    req.off('close', closeListener);
    stream.end();
  }
});

router.get(
  '/:projectId/participants',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectVisible(projectId, readAuthenticatedUserId(req));
    const result = await participantsService.getProjectParticipants(projectId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.put('/:projectId/rename', (req, res) => {
  try {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    // The display name is shared state shown to every viewer of the project, so
    // renaming takes the WRITE mandate, not visibility (404, not 403).
    assertProjectWritable(req, projectId);
    const { displayName } = req.body as { displayName?: unknown };
    updateProjectDisplayName(projectId, displayName);
    res.json({ success: true });
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to rename project' });
  }
});

/**
 * NOTE ON STARS — verified, not assumed: a project star is NOT a personal
 * preference. It is the single `projects.isStarred` COLUMN on the shared project
 * row (migrations.ts adds it to `projects`; setProjectStar writes it via
 * projectsDb.updateProjectIsStarredById), so one user's change affects the
 * sidebar ordering for EVERYONE. Contrast `starred_sessions`, which is a real
 * per-user table keyed by user_id — that one is a personal preference and is
 * left alone. Because this one is shared state, it takes the WRITE mandate.
 */
router.post(
  '/:projectId/toggle-star',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectWritable(req, projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.starred !== undefined && typeof body.starred !== 'boolean') {
      throw new AppError('Field "starred" must be a boolean.', {
        code: 'INVALID_STARRED_FLAG',
        statusCode: 400,
      });
    }

    // Explicit state is the retry-safe contract. Absence retains the old
    // toggle behaviour temporarily so older clients do not break mid-upgrade.
    const { isStarred } = typeof body.starred === 'boolean'
      ? setProjectStar(projectId, body.starred)
      : toggleProjectStar(projectId);
    res.json({ success: true, isStarred });
  }),
);

/**
 * PROJECT LOGO (T-1403) — upload / replace / remove.
 *
 * In-memory storage so the bytes are validated (magic bytes, SVG sanitization —
 * see project-logo.service.ts) BEFORE anything touches the disk. The multer
 * fileFilter is deliberately only a cheap first pass on the declared type; the
 * authoritative check is the content inspection in the service.
 *
 * Authorization is the WRITE mandate, like rename and star: a project logo is
 * shared state that every viewer of the project sees, not a personal preference.
 */
const projectLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROJECT_LOGO_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, Boolean(PROJECT_LOGO_MIME_TO_EXT[file.mimetype]));
  },
}).single('logo');

router.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const ids = parseBulkProjectIds(req.body);
    const action = (req.body as Record<string, unknown> | null)?.action;
    if (action !== 'archive' && action !== 'restore' && action !== 'delete_permanently') {
      throw new AppError('action must be archive, restore, or delete_permanently.', {
        code: 'INVALID_BULK_ACTION', statusCode: 400,
      });
    }

    const results: BulkProjectResult[] = [];
    for (const id of ids) {
      try {
        // Capture the path before permanent deletion removes the row, allowing
        // the sidebar metadata channel to refresh its affected sessions.
        const projectPath = projectsDb.getProjectById(id)?.project_path;
        if (action === 'delete_permanently') {
          assertProjectManageable(req, id);
          await deleteOrArchiveProject(id, true);
        } else if (action === 'archive') {
          assertProjectWritable(req, id);
          await deleteOrArchiveProject(id, false);
        } else {
          assertProjectWritable(req, id);
          restoreArchivedProject(id);
        }
        if (projectPath) notifyProjectSessionMetadata(projectPath);
        results.push({ id, success: true });
      } catch (error) {
        results.push(bulkProjectFailure(id, error));
      }
    }
    res.json(createApiSuccessResponse({ action, results }));
  }),
);

router.post('/:projectId/logo', (req, res) => {
  projectLogoUpload(req, res, async (uploadError: unknown) => {
    try {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      // Authorize BEFORE reporting anything about the upload itself, so an
      // unauthorized caller learns nothing beyond "no such project".
      assertProjectWritable(req, projectId);

      if (uploadError) {
        if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'Image exceeds the 2MB size limit' });
          return;
        }
        res.status(400).json({ error: 'Invalid upload' });
        return;
      }

      const file = (req as express.Request & { file?: { buffer: Buffer } }).file;
      if (!file) {
        // Missing field, or rejected by fileFilter (unsupported declared type).
        res.status(400).json({ error: 'A valid image file (png, jpeg, webp, svg) is required' });
        return;
      }

      const logoUrl = await saveProjectLogo(projectId, file.buffer);
      res.json(createApiSuccessResponse({ projectId, logoUrl }));
    } catch (error) {
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error('Project logo upload error:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Failed to save project logo' });
    }
  });
});

router.delete(
  '/:projectId/logo',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectWritable(req, projectId);
    await deleteProjectLogo(projectId);
    res.json(createApiSuccessResponse({ projectId, logoUrl: null }));
  }),
);

router.post(
  '/:projectId/restore',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    // Un-archiving puts the project back in everyone's active list — a mutation.
    assertProjectWritable(req, projectId);
    restoreArchivedProject(projectId);
    res.json(createApiSuccessResponse({ projectId, isArchived: false }));
  }),
);

/**
 * - `force` not set / false: archive project in DB only (`isArchived` = 1; hidden from active list).
 * - `force=true`: remove DB row, delete session rows for that path, remove all `*.jsonl` under the Claude project dir.
 */
router.delete(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const force = req.query.force === 'true';
    // Two-tier gate (B-IDOR-PROJECT). Archiving is reversible → WRITE mandate.
    // force=true is not: it removes the project row, every session row for its
    // path, and every transcript file on disk → management right only.
    // Platform-owner recovery of ORPHANED projects has its own route (B-PRIV-5).
    if (force) {
      assertProjectManageable(req, projectId);
    } else {
      assertProjectWritable(req, projectId);
    }
    await deleteOrArchiveProject(projectId, force);
    res.json({ success: true });
  }),
);

/**
 * Coerces a body field into a positive integer user id, or null when absent or
 * malformed. Used by the membership/recovery routes (never trusts the client for
 * authorization — only for the *target* of an already-authorized operation).
 */
function readBodyUserId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * PATCH /api/projects/:projectId/visibility — REMOVED by ADR-089.
 *
 * Project visibility (public/private) is retired: every project is shared with
 * every team member. The route answers 410 Gone rather than 404 so a stale
 * client (a tab loaded before the deploy, still holding the old sidebar button)
 * gets an unambiguous "this feature no longer exists" instead of a misleading
 * "project not found".
 */
router.patch(
  '/:projectId/visibility',
  asyncHandler(async (_req, _res) => {
    throw new AppError('Project visibility was retired — every project is shared with the team', {
      code: 'VISIBILITY_RETIRED',
      statusCode: 410,
    });
  }),
);

/** Actor context of a membership mutation: ip, user agent, platform-owner flag (JWT). */
function readAuditContext(req: express.Request): MembershipAuditContext {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    isPlatformOwner: isPlatformOwner(req),
  };
}

function readProjectIdParam(req: express.Request): string {
  return typeof req.params.projectId === 'string' ? req.params.projectId : '';
}

/** ADR-172: 30 candidate searches per minute per authenticated user. */
const memberCandidatesLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  code: 'RATE_LIMITED',
  key: (req: express.Request) => `user:${readAuthenticatedUserId(req) ?? 'anonymous'}`,
});

/**
 * GET /api/projects/:projectId/members — membership listing (ADR-172: any user
 * with access to the project; 404 otherwise).
 */
router.get(
  '/:projectId/members',
  asyncHandler(async (req, res) => {
    const result = listMembers(readProjectIdParam(req), readAuthenticatedUserId(req));
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * GET /api/projects/:projectId/member-candidates?q= — users that may be added.
 * q must be 2..64 chars; returns {id, displayName, avatar} only, max 20.
 */
router.get(
  '/:projectId/member-candidates',
  memberCandidatesLimiter,
  asyncHandler(async (req, res) => {
    const result = searchMemberCandidates(
      readProjectIdParam(req),
      readQueryStringValue(req.query.q),
      readAuthenticatedUserId(req),
    );
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * POST /api/projects/:projectId/members — add/update a member.
 * Body: { userId: number, role?: 'owner' | 'member' }.
 */
router.post(
  '/:projectId/members',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { userId?: unknown; role?: unknown };
    const targetUserId = readBodyUserId(body.userId);
    if (targetUserId === null) {
      throw new AppError('A valid userId is required', { code: 'INVALID_USER_ID', statusCode: 400 });
    }
    if (body.role !== undefined && body.role !== 'owner' && body.role !== 'member') {
      throw new AppError("role must be 'owner' or 'member'", {
        code: 'INVALID_ROLE', statusCode: 400,
      });
    }
    const role = body.role ?? 'member';

    const result = addMember(
      readProjectIdParam(req),
      targetUserId,
      role,
      readAuthenticatedUserId(req),
      readAuditContext(req),
    );
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * DELETE /api/projects/:projectId/members/:userId — remove a member. The
 * creator cannot be removed (409 cannot_remove_creator).
 */
router.delete(
  '/:projectId/members/:userId',
  asyncHandler(async (req, res) => {
    const targetUserId = readBodyUserId(req.params.userId);
    if (targetUserId === null) {
      throw new AppError('A valid userId is required', { code: 'INVALID_USER_ID', statusCode: 400 });
    }

    const result = removeMember(
      readProjectIdParam(req),
      targetUserId,
      readAuthenticatedUserId(req),
      readAuditContext(req),
    );
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * GET /api/projects/:projectId/orphan-status — platform-owner check for whether
 * a project is orphaned (no creator and no owner member). Metadata only.
 */
router.get(
  '/:projectId/orphan-status',
  asyncHandler(async (req, res) => {
    if (!isPlatformOwner(req)) {
      throw new AppError('Insufficient permissions', {
        code: 'PROJECT_MANAGE_FORBIDDEN',
        statusCode: 403,
      });
    }
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    res.json(createApiSuccessResponse({ projectId, orphaned: isOrphanProject(projectId) }));
  }),
);

/**
 * POST /api/projects/:projectId/recover — platform-owner orphan recovery by
 * transfer of ownership. Body: { newOwnerUserId: number }. Metadata only — does
 * not read project content. Refuses non-orphans.
 */
router.post(
  '/:projectId/recover',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const newOwnerUserId = readBodyUserId((req.body as { newOwnerUserId?: unknown })?.newOwnerUserId);
    if (newOwnerUserId === null) {
      throw new AppError('A valid newOwnerUserId is required', {
        code: 'INVALID_USER_ID',
        statusCode: 400,
      });
    }
    const result = recoverOrphanByTransfer(projectId, newOwnerUserId, isPlatformOwner(req));
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * DELETE /api/projects/:projectId/recover — platform-owner deletion of an
 * ORPHANED project. Metadata only (DB row + session jsonl); refuses non-orphans
 * so a project with a legitimate manager can never be removed by this path.
 */
router.delete(
  '/:projectId/recover',
  asyncHandler(async (req, res) => {
    if (!isPlatformOwner(req)) {
      throw new AppError('Insufficient permissions', {
        code: 'PROJECT_MANAGE_FORBIDDEN',
        statusCode: 403,
      });
    }
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    if (!projectsDb.getProjectById(projectId)) {
      throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    }
    if (!isOrphanProject(projectId)) {
      throw new AppError('Project is not orphaned', {
        code: 'PROJECT_NOT_ORPHANED',
        statusCode: 409,
      });
    }
    const force = req.query.force === 'true';
    await deleteOrArchiveProject(projectId, force);
    res.json(createApiSuccessResponse({ projectId, deleted: true }));
  }),
);

export default router;
