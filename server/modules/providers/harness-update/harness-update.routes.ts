/**
 * harness-update routes (T-1749 / ADR-159 item 7). Mounted under /api/providers
 * behind authenticateToken. The mutating/owner surfaces are additionally behind
 * requireRole('owner'). Wire shape is `shared/harness-update.contract.ts`.
 *
 *   GET  /:id/version-status      (any authenticated user)
 *   GET  /version-status          (any authenticated user)
 *   POST /:id/update              (owner, rate-limited) {acks?}
 *   POST /:id/restore-compatible  (owner, rate-limited) {acks?}   — opencode only
 *   POST /:id/rollback            (owner, rate-limited) {jobId, scope, acks?}
 *   POST /:id/recovery            (owner, rate-limited) {action: retry|acknowledge}
 *   GET  /:id/snapshots           (owner, rate-limited)
 *   GET  /update-jobs/:jobId      (owner)
 *   GET  /autoupdate-settings     (owner)
 *   PUT  /autoupdate-settings     (owner)
 */

import express, { type Request, type Response } from 'express';

// eslint-disable-next-line boundaries/no-unknown -- shared HTTP rate limiting protects this public module route.
import { createRateLimiter } from '@/middleware/rate-limit.js';
// eslint-disable-next-line boundaries/no-unknown -- shared authentication middleware owns the canonical role predicate.
import { requireRole } from '@/middleware/auth.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

import type { HarnessVersionStatus } from '../../../../shared/harness-update.contract.js';

import { resolveHarnessId } from './descriptors.js';
import {
  getAllHarnessVersionStatuses,
  getHarnessVersionStatus,
} from './version-status.service.js';
import { getHarnessUpdateJob, startHarnessUpdate } from './update.service.js';
import {
  listHarnessSnapshots,
  startManualRollback,
  startRecovery,
  startRestoreCompatible,
} from './rollback.service.js';
import { getAutoUpdateSettings, setAutoUpdateSettings } from './autoupdate-settings.js';
import { startHarnessAutoUpdateScheduler } from './scheduler.js';

const router = express.Router();

/**
 * The aggregate status route fans out to EVERY harness (a version read each,
 * TTL-cached but still a spawn per harness on a cold cache), so it is the one
 * expensive read here. Same in-memory per-IP limiter the other routes use.
 */
const aggregateStatusLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Too many version-status requests, please slow down',
  code: 'HARNESS_STATUS_RATE_LIMITED',
});

/** Owner mutations (POST) are rate limited. */
const ownerActionLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
  message: 'Too many harness actions, please slow down',
  code: 'HARNESS_ACTION_RATE_LIMITED',
});

/** The snapshot listing has its own budget so polling it never starves the POSTs. */
const snapshotListLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Too many snapshot list requests, please slow down',
  code: 'HARNESS_SNAPSHOTS_RATE_LIMITED',
});

/**
 * Codes answered with a harness-specific body `{ code, message, … }` (spec
 * §9: every 409 carries `code`). Messages are generic server strings; only
 * `required` (server-built acks) and `activeJobId` are added.
 */
const HARNESS_ACTION_CODES: ReadonlySet<string> = new Set([
  'HARNESS_UPDATE_IN_PROGRESS', 'HARNESS_RECOVERY_FAILED', 'HARNESS_MANUAL_ONLY', 'CONFIRMATION_REQUIRED',
  'SNAPSHOT_TAMPERED', 'ORIGIN_NAME_CONFLICT', 'SNAPSHOT_LAYOUT_MISMATCH', 'SNAPSHOT_UNSAFE_ENTRY',
  'STORE_IN_USE', 'STORE_ACCESS_UNPROVABLE', 'INSUFFICIENT_STORAGE', 'SNAPSHOT_COUNT_CAP',
  'NOT_RESTORE_COMPATIBLE', 'SNAPSHOT_NOT_FOUND', 'NO_RECOVERY_PENDING', 'RECOVERY_UNVERIFIED',
  'INVALID_ROLLBACK_SCOPE', 'INVALID_RECOVERY_ACTION', 'PREFLIGHT_CHANGED', 'MANIFEST_INVALID',
  'HARNESS_NOT_UPDATABLE', 'UNKNOWN_HARNESS',
]);

/** Writes the harness action body for a known refusal; false when `err` is not one. */
function sendActionError(res: Response, err: unknown): boolean {
  if (!(err instanceof AppError) || !HARNESS_ACTION_CODES.has(err.code)) return false;
  const details = (err.details ?? {}) as { required?: unknown; activeJobId?: unknown };
  const body: Record<string, unknown> = { code: err.code, message: `Harness action refused (${err.code}).` };
  if (err.code === 'CONFIRMATION_REQUIRED') body.required = Array.isArray(details.required) ? details.required : [];
  if (err.code === 'HARNESS_UPDATE_IN_PROGRESS') body.activeJobId = typeof details.activeJobId === 'string' ? details.activeJobId : '';
  res.status(err.statusCode).json(body);
  return true;
}

/** asyncHandler that maps harness refusals to their wire bodies. */
function actionHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return asyncHandler(async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!sendActionError(res, err)) throw err;
    }
  });
}

/** Canonical harness id of the route param, else 404 UNKNOWN_HARNESS. */
function requireHarnessId(req: Request): string {
  const id = resolveHarnessId(req.params.id);
  if (!id) throw new AppError('Unknown harness.', { code: 'UNKNOWN_HARNESS', statusCode: 404 });
  return id;
}

/** The request body as a plain object (never trusted beyond its fields). */
function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

const readUserId = (req: Request): number | null => {
  const raw = (req as Request & { user?: { id?: unknown } }).user?.id;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

// GET all — array of statuses for every harness (frontend iterates this).
router.get(
  '/version-status',
  aggregateStatusLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const statuses: HarnessVersionStatus[] = await getAllHarnessVersionStatuses({
      getJob: getHarnessUpdateJob,
    });
    res.json(statuses);
  }),
);

// GET one harness status.
router.get(
  '/:id/version-status',
  asyncHandler(async (req: Request, res: Response) => {
    const id = resolveHarnessId(req.params.id);
    if (!id) {
      throw new AppError('Unknown harness.', { code: 'UNKNOWN_HARNESS', statusCode: 404 });
    }
    const status = await getHarnessVersionStatus(id, { getJob: getHarnessUpdateJob });
    res.json(status);
  }),
);

// POST update (owner only). 202 | 409 {code,…} | 423 | 507.
router.post(
  '/:id/update',
  requireRole('owner'),
  ownerActionLimiter,
  actionHandler(async (req: Request, res: Response) => {
    const id = requireHarnessId(req);
    const job = await startHarnessUpdate(id, { userId: readUserId(req), trigger: 'manual', acks: bodyOf(req).acks });
    res.status(202).json({ jobId: job.jobId, provider: job.provider, status: job.status });
  }),
);

// POST restore-compatible (owner only; opencode only, else 404).
router.post(
  '/:id/restore-compatible',
  requireRole('owner'),
  ownerActionLimiter,
  actionHandler(async (req: Request, res: Response) => {
    const id = requireHarnessId(req);
    const job = await startRestoreCompatible(id, { userId: readUserId(req), acks: bodyOf(req).acks });
    res.status(202).json({ jobId: job.jobId, provider: job.provider, status: job.status });
  }),
);

// POST rollback of one succeeded run (owner only).
router.post(
  '/:id/rollback',
  requireRole('owner'),
  ownerActionLimiter,
  actionHandler(async (req: Request, res: Response) => {
    const id = requireHarnessId(req);
    const body = bodyOf(req);
    const job = await startManualRollback({
      harness: id, jobId: body.jobId, scope: body.scope, acks: body.acks, userId: readUserId(req),
    });
    res.status(202).json({ jobId: job.jobId, provider: job.provider, status: job.status });
  }),
);

// POST recovery out of rollback_failed (owner only; that harness only).
router.post(
  '/:id/recovery',
  requireRole('owner'),
  ownerActionLimiter,
  actionHandler(async (req: Request, res: Response) => {
    const id = requireHarnessId(req);
    const result = await startRecovery(id, { action: bodyOf(req).action, userId: readUserId(req) });
    if ('jobId' in result) {
      res.status(202).json({ jobId: result.jobId, provider: result.provider, status: result.status });
      return;
    }
    res.json(result);
  }),
);

// GET snapshots of one harness (owner only; no paths, no member ids).
router.get(
  '/:id/snapshots',
  requireRole('owner'),
  snapshotListLimiter,
  actionHandler(async (req: Request, res: Response) => {
    res.json(listHarnessSnapshots(requireHarnessId(req)));
  }),
);

// GET job poll (owner only).
router.get(
  '/update-jobs/:jobId',
  requireRole('owner'),
  asyncHandler(async (req: Request, res: Response) => {
    const jobId = typeof req.params.jobId === 'string' ? req.params.jobId : '';
    const job = getHarnessUpdateJob(jobId);
    if (!job) {
      throw new AppError('Unknown update job.', { code: 'UNKNOWN_UPDATE_JOB', statusCode: 404 });
    }
    res.json(job);
  }),
);

// GET/PUT auto-update settings (owner only).
router.get(
  '/autoupdate-settings',
  requireRole('owner'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(getAutoUpdateSettings());
  }),
);

router.put(
  '/autoupdate-settings',
  requireRole('owner'),
  asyncHandler(async (req: Request, res: Response) => {
    const result = setAutoUpdateSettings(req.body);
    if (!result.ok) {
      throw new AppError(result.error, { code: 'INVALID_AUTOUPDATE_SETTINGS', statusCode: 400 });
    }
    startHarnessAutoUpdateScheduler();
    res.json(result.settings);
  }),
);

export default router;
