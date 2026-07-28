import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { createProject, updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { applyLegacyStarredProjectIds, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';
import { participantsService } from '@/modules/providers/index.js';
import { assertProjectVisible } from '@/modules/projects/services/project-visibility-guard.service.js';
import {
  addMember,
  canManageProject,
  isOrphanProject,
  listMembers,
  recoverOrphanByTransfer,
  removeMember,
  setVisibility,
} from '@/modules/projects/services/project-visibility-management.service.js';

const router = express.Router();

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
    res.json(createApiSuccessResponse({ projects }));
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
        details: 'Use /api/projects/clone-progress for cloning workflows',
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

router.get('/clone-progress', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type: string, data: Record<string, unknown>) => {
    if (res.writableEnded) {
      return;
    }

    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  let cloneOperation: Awaited<ReturnType<typeof startCloneProject>> | null = null;
  const closeListener = () => {
    cloneOperation?.cancel();
  };
  req.on('close', closeListener);

  try {
    const queryParams = req.query as Record<string, unknown>;
    const workspacePath = readQueryStringValue(queryParams.path);
    const githubUrl = readQueryStringValue(queryParams.githubUrl);
    const githubTokenId = readOptionalNumericQueryValue(queryParams.githubTokenId);
    const newGithubToken = readQueryStringValue(queryParams.newGithubToken) || null;

    const authenticatedUser = (req as typeof req & { user?: AuthenticatedUser }).user;
    const userId = authenticatedUser?.id;
    if (userId === undefined || userId === null) {
      throw new AppError('Authenticated user is required', {
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
      });
    }

    cloneOperation = await startCloneProject(
      {
        workspacePath,
        githubUrl,
        githubTokenId,
        newGithubToken,
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

    await cloneOperation.waitForCompletion;
  } catch (error) {
    sendEvent('error', { message: resolveRouteErrorMessage(error) });
  } finally {
    req.off('close', closeListener);
    if (!res.writableEnded) {
      res.end();
    }
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
 * row (migrations.ts adds it to `projects`; toggleProjectStar flips it via
 * projectsDb.updateProjectIsStarredById), so one user's toggle changes the
 * sidebar ordering for EVERYONE. Contrast `starred_sessions`, which is a real
 * per-user table keyed by user_id — that one is a personal preference and is
 * left alone. Because this one is shared state, it takes the WRITE mandate.
 */
router.post(
  '/:projectId/toggle-star',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    assertProjectWritable(req, projectId);
    const { isStarred } = toggleProjectStar(projectId);
    res.json({ success: true, isStarred });
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
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * PATCH /api/projects/:projectId/visibility — toggle public/private.
 * Body: { visibility: 'public' | 'private' }.
 * Authorization (server-side): creator, project_members 'owner', or platform
 * owner. Switching to private records the creator as a project_members 'owner'.
 */
router.patch(
  '/:projectId/visibility',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const rawVisibility = (req.body as { visibility?: unknown })?.visibility;
    const visibility = rawVisibility === 'private' ? 'private' : rawVisibility === 'public' ? 'public' : null;
    if (visibility === null) {
      throw new AppError("visibility must be 'public' or 'private'", {
        code: 'INVALID_VISIBILITY',
        statusCode: 400,
      });
    }

    const result = setVisibility(
      projectId,
      visibility,
      readAuthenticatedUserId(req),
      isPlatformOwner(req),
    );
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * GET /api/projects/:projectId/members — manager-only membership listing.
 */
router.get(
  '/:projectId/members',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const result = listMembers(projectId, readAuthenticatedUserId(req), isPlatformOwner(req));
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
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const body = (req.body ?? {}) as { userId?: unknown; role?: unknown };
    const targetUserId = readBodyUserId(body.userId);
    if (targetUserId === null) {
      throw new AppError('A valid userId is required', { code: 'INVALID_USER_ID', statusCode: 400 });
    }
    const role = body.role === 'owner' ? 'owner' : 'member';

    const result = addMember(
      projectId,
      targetUserId,
      role,
      readAuthenticatedUserId(req),
      isPlatformOwner(req),
    );
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * DELETE /api/projects/:projectId/members/:userId — remove a member.
 */
router.delete(
  '/:projectId/members/:userId',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const targetUserId = readBodyUserId(req.params.userId);
    if (targetUserId === null) {
      throw new AppError('A valid userId is required', { code: 'INVALID_USER_ID', statusCode: 400 });
    }

    const result = removeMember(
      projectId,
      targetUserId,
      readAuthenticatedUserId(req),
      isPlatformOwner(req),
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
