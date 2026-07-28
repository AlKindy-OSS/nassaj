/**
 * Participant tracking routes (mounted at /api/sessions).
 *
 *   GET    /api/sessions/starred                 → the caller's starred sessions
 *   POST   /api/sessions/star                     → star/unstar a session for the caller
 *   GET    /api/sessions/:sessionId/participants  → human participants of a session
 *   GET    /api/sessions/:sessionId/agents        → model + subagents of a session
 *   POST   /api/sessions/:sessionId/close         → mark a conversation finished
 *   DELETE /api/sessions/:sessionId/close         → reopen it
 *
 * All are auth-protected by the mount point in index.js. Handlers stay thin:
 * validate input, delegate to the relevant service/repository, shape response.
 */

import express, { type Request, type Response } from 'express';

import { closedSessionsDb, sessionsDb, starredSessionsDb } from '@/modules/database/index.js';
import { participantsService } from '@/modules/providers/services/participants.service.js';
import { notifySessionMetadataChanged } from '@/modules/providers/services/sessions-watcher.service.js';
import { assertSessionAccessible } from '@/modules/providers/services/sessions.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9._/-]{1,400}$/;

function parseSessionId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!SESSION_ID_PATTERN.test(raw)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }
  return raw;
}

/**
 * Provider of a session, for the refresh broadcast only. The broadcast payload
 * carries it as a hint; a session whose row has vanished still deserves the
 * refresh, so an unknown provider falls back to 'claude' rather than skipping
 * the notification and leaving every sidebar stale.
 */
function sessionProviderForBroadcast(sessionId: string) {
  const provider = sessionsDb.getSessionById(sessionId)?.provider;
  return (provider ?? 'claude') as Parameters<typeof notifySessionMetadataChanged>[0];
}

/** Optional projectName from a request body; null when absent, validated when present. */
function parseOptionalProjectName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!PROJECT_NAME_PATTERN.test(raw)) {
    throw new AppError('Invalid projectName.', {
      code: 'INVALID_PROJECT_NAME',
      statusCode: 400,
    });
  }
  return raw;
}

type AuthenticatedUser = { id?: number | string };

/**
 * Reads the authenticated user's numeric id from req.user (set by
 * authenticateToken at the mount point). Stars are ALWAYS scoped to this id —
 * never to any user identifier taken from request input.
 */
function readAuthenticatedUserId(req: Request): number {
  const rawId = (req as Request & { user?: AuthenticatedUser }).user?.id;
  const userId =
    typeof rawId === 'number'
      ? rawId
      : typeof rawId === 'string' && rawId.trim() !== ''
        ? Number.parseInt(rawId, 10)
        : NaN;

  if (!Number.isInteger(userId)) {
    throw new AppError('Authentication required.', {
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

router.get(
  '/starred',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readAuthenticatedUserId(req);
    const sessions = starredSessionsDb.listStarredSessions(userId);
    res.json(createApiSuccessResponse({ sessions }));
  })
);

router.post(
  '/star',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readAuthenticatedUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const sessionId = parseSessionId(body.sessionId);
    const projectName = parseOptionalProjectName(body.projectName);

    if (typeof body.starred !== 'boolean') {
      throw new AppError('Field "starred" must be a boolean.', {
        code: 'INVALID_STARRED_FLAG',
        statusCode: 400,
      });
    }

    const starred = starredSessionsDb.setStarred(userId, sessionId, body.starred, projectName);
    res.json(createApiSuccessResponse({ sessionId, projectName, starred }));
  })
);

// The two routes below describe WHO (humans) and WHAT (model + subagents) is
// working inside one session. Both ran on the sessionId alone, so any
// authenticated user could enumerate the collaborators — and the agent roster
// parsed out of the transcript — of a session in a project they cannot see.
// They now pass through the shared session gate in 'read' mode (participation OR
// project visibility), which answers 404 on refusal so the session's existence is
// not disclosed either. Placed BEFORE the service call so nothing is read from
// the database or the transcript for an unauthorized caller.
router.get(
  '/:sessionId/participants',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    assertSessionAccessible(sessionId, readAuthenticatedUserId(req), 'read');
    const participants = participantsService.listSessionParticipants(sessionId);
    res.json(createApiSuccessResponse({ participants }));
  })
);

router.get(
  '/:sessionId/agents',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    assertSessionAccessible(sessionId, readAuthenticatedUserId(req), 'read');
    const agents = await participantsService.listSessionAgents(sessionId);
    res.json(createApiSuccessResponse({ agents }));
  })
);

// Closing marks a conversation as finished. Unlike a star the flag is GLOBAL —
// every member of the project sees the same state — which is exactly why the
// gate here is 'write' and not 'read': every project defaults to public, so the
// read predicate would let ANY authenticated user close (or reopen) every
// conversation in every public project. 'write' keeps the action with the people
// who own the conversation or the project.
//
// The state itself is presentation-only and reversible: nothing in the
// resume/read path consults it, POST and DELETE are both idempotent, and
// re-closing preserves the ORIGINAL closer so "who finished this" stays honest.
// The response is flat (`{ success, closed }`) per the sidebar contract.
router.post(
  '/:sessionId/close',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const userId = readAuthenticatedUserId(req);
    assertSessionAccessible(sessionId, userId, 'write');

    closedSessionsDb.closeSession(sessionId, userId);
    // Read back rather than echo the request: on a repeat close the stored
    // marker still names the FIRST closer, and that is what the caller must see.
    const closed = closedSessionsDb.getClosedSession(sessionId);
    // The flag lives only in the DB, so no file watcher will ever notice it.
    // Without this the sidebar keeps the value it last fetched and the row looks
    // untouched until a reload — which is exactly how this shipped broken.
    notifySessionMetadataChanged(sessionProviderForBroadcast(sessionId), sessionId);
    res.json({ success: true, closed });
  })
);

router.delete(
  '/:sessionId/close',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    assertSessionAccessible(sessionId, readAuthenticatedUserId(req), 'write');

    closedSessionsDb.reopenSession(sessionId);
    notifySessionMetadataChanged(sessionProviderForBroadcast(sessionId), sessionId);
    res.json({ success: true });
  })
);

export default router;
