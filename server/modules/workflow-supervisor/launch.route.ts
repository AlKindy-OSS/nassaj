/**
 * Explicit background-task launch route (ADR-053 §ب-1/§و المرحلة 2) — mounted at
 * /api/workflow-supervisor. THE new web surface for B-103, and the ONLY one.
 *
 *   POST /api/workflow-supervisor/launch  → validate + GATE2 + drop a DurableTask
 *
 * SECURITY POSTURE (الأمان أولاً)
 * -------------------------------
 *   - HARD NO-OP WHEN THE FLAG IS OFF: every verb returns 404 (route effectively
 *     absent) and touches nothing — the master no-op guarantee (criterion 4).
 *   - IDENTITY FROM THE JWT ONLY: userId is taken from req.user.id (set by
 *     authenticateToken at the mount point), NEVER from the request body. The
 *     body cannot name a user.
 *   - FAIL-CLOSED OWNERSHIP PRE-CHECK: the route itself runs the STRICT ownership
 *     predicate (isProjectPathOwnedOrMemberedBy) and returns 403 for a non-owner
 *     with ZERO intent written — so a denied caller leaves NOTHING on disk. The
 *     standalone supervisor re-runs GATE2 (defense-in-depth) before any launch.
 *   - The route WRITES A DURABLE-TASK INTENT ONLY. It launches nothing; the
 *     standalone supervisor owns the privileged systemd-run. The requesting turn
 *     ends cheaply — the structural durability fix over Layer 2.
 *
 * @example
 *   curl -sS -X POST http://localhost:3004/api/workflow-supervisor/launch \
 *     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
 *     -d '{"projectPath":"/home/dev/workspace/demo","scriptOrPrompt":"run the audit",
 *          "conversationId":"a1b2c3","originMessageId":"m-42","model":"haiku",
 *          "handoffPolicy":"card-only"}'
 *   → 202 { "success": true, "data": { "taskId": "…", "status": "queued-for-launch" } }
 */

import express, { type Request, type Response } from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

// Reuse the AUDITED shared limiter rather than duplicating security-sensitive
// code; server/middleware is a cross-cutting infra dir not enumerated in the
// boundaries elements (the route layer imports it the same way).
// eslint-disable-next-line boundaries/no-unknown
import { createRateLimiter } from '../../middleware/rate-limit.js';

import { isSupervisorEnabled, maxPendingIntentsPerUser } from './config.js';
import { writeDurableTask } from './durable-task.js';
import { countPendingIntents } from './queue-guard.js';
import { countBackgroundTasks } from './background-tasks-watcher.service.js';
import { HANDOFF_POLICIES, type HandoffPolicy } from './intent.js';

const router = express.Router();

/** Strict charset for the web-originated id fields (no path/unit injection). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Cap the prompt so the web surface cannot be used to write an unbounded file. */
const MAX_PROMPT_BYTES = 64 * 1024;

/**
 * C1 (T-820 audit) — per-IP rate limit on the launch endpoint. The audit flagged
 * that the mount had NO limiter, so a flood of launches could amplify into
 * host-wide systemctl/DB probes. A conservative fixed window blunts that at the
 * edge (the per-user PENDING cap below bounds the standing queue).
 */
const launchRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Too many background-task launches, slow down.',
});

/**
 * C1 (T-820 audit) — reject a projectPath carrying `..`/NUL/control chars at the
 * edge with a clean 400 (the disk validator hardens it again, defense in depth).
 */
function assertSafeProjectPath(projectPath: string): void {
  if (!projectPath.startsWith('/')) {
    throw new AppError('projectPath must be absolute.', {
      code: 'INVALID_INPUT',
      statusCode: 400,
    });
  }
  for (const ch of projectPath) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) {
      throw new AppError('projectPath contains control characters.', {
        code: 'INVALID_INPUT',
        statusCode: 400,
      });
    }
  }
  if (projectPath.split('/').some((seg) => seg === '..')) {
    throw new AppError('projectPath must not contain "..".', {
      code: 'INVALID_INPUT',
      statusCode: 400,
    });
  }
}

function requireString(value: unknown, field: string, max = 4096): string {
  const raw = typeof value === 'string' ? value : '';
  if (raw.trim().length === 0) {
    throw new AppError(`${field} is required.`, { code: 'INVALID_INPUT', statusCode: 400 });
  }
  if (Buffer.byteLength(raw, 'utf8') > max) {
    throw new AppError(`${field} is too large.`, { code: 'INVALID_INPUT', statusCode: 400 });
  }
  return raw;
}

function requireId(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!ID_PATTERN.test(raw)) {
    throw new AppError(`${field} has an invalid format.`, {
      code: 'INVALID_INPUT',
      statusCode: 400,
    });
  }
  return raw;
}

function optionalHandoffPolicy(value: unknown): HandoffPolicy {
  if (value === undefined || value === null || value === '') {
    return 'card-only';
  }
  if (typeof value !== 'string' || !(HANDOFF_POLICIES as readonly string[]).includes(value)) {
    throw new AppError('handoffPolicy is not a recognized value.', {
      code: 'INVALID_INPUT',
      statusCode: 400,
    });
  }
  return value as HandoffPolicy;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || value.length > 128) {
    throw new AppError(`${field} is invalid.`, { code: 'INVALID_INPUT', statusCode: 400 });
  }
  return value;
}

/** Reads the authenticated integer user id — the ONLY source of identity. */
function authUserId(req: Request): number {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  if (!Number.isInteger(id)) {
    // authenticateToken should guarantee this; fail closed regardless.
    throw new AppError('Unauthenticated.', { code: 'UNAUTHENTICATED', statusCode: 401 });
  }
  return id as number;
}

router.post(
  '/launch',
  launchRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    // Master no-op: OFF => the route is effectively absent (criterion 4).
    if (!isSupervisorEnabled(process.env)) {
      throw new AppError('Not found.', { code: 'NOT_FOUND', statusCode: 404 });
    }

    const userId = authUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const projectPath = requireString(body.projectPath, 'projectPath');
    assertSafeProjectPath(projectPath);
    const scriptOrPrompt = requireString(body.scriptOrPrompt, 'scriptOrPrompt', MAX_PROMPT_BYTES);
    const conversationId = requireId(body.conversationId, 'conversationId');
    const originMessageId = requireId(body.originMessageId, 'originMessageId');
    const model = optionalString(body.model, 'model');
    const effort = optionalString(body.effort, 'effort');
    const handoffPolicy = optionalHandoffPolicy(body.handoffPolicy);

    // FAIL-CLOSED ownership pre-check (STRICT ownership, NOT visibility). A
    // non-owner is denied here with ZERO intent written to disk (criterion 2).
    let owned = false;
    try {
      owned = projectsDb.isProjectPathOwnedOrMemberedBy(projectPath, userId);
    } catch {
      owned = false; // a DB blip fails closed
    }
    if (!owned) {
      throw new AppError('You do not own this project.', {
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    }

    // C1 (T-820 audit) — per-user PENDING-intent cap. Reject an (N+1)th launch
    // with 429 BEFORE writing, so a single owner cannot flood the intents dir
    // (each queued intent costs a GATE2 + systemctl probe every tick). The count
    // fails CLOSED on a read error (treated as full).
    const pending = countPendingIntents(userId, process.env);
    if (pending >= maxPendingIntentsPerUser(process.env)) {
      throw new AppError('Too many pending background tasks; wait for some to finish.', {
        code: 'RATE_LIMITED',
        statusCode: 429,
      });
    }

    const result = await writeDurableTask({
      userId,
      projectPath,
      scriptOrPrompt,
      conversationId,
      originMessageId,
      model,
      effort,
      handoffPolicy,
    });

    if (!result.written) {
      throw new AppError('Could not queue the background task.', {
        code: 'LAUNCH_WRITE_FAILED',
        statusCode: 500,
        details: { reason: result.reason },
      });
    }

    res.status(202).json(
      createApiSuccessResponse({ taskId: result.taskId, status: 'queued-for-launch' }),
    );
  }),
);

/**
 * GET /background-tasks/count — the badge's refetch target (paired with the
 * `background-tasks-updated` WS signal, runner-watcher pattern). 404 when the
 * flag is OFF. Server-only for now; the client badge that consumes it is deferred
 * to a later wave (build:client is out of scope here).
 */
router.get(
  '/background-tasks/count',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isSupervisorEnabled(process.env)) {
      throw new AppError('Not found.', { code: 'NOT_FOUND', statusCode: 404 });
    }
    authUserId(req); // authenticated callers only (identity unused for the count)
    const counts = countBackgroundTasks(process.env);
    res.json(createApiSuccessResponse(counts));
  }),
);

export default router;
