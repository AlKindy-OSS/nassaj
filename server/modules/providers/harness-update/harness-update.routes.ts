/**
 * harness-update routes (T-1749 / ADR-159 item 7). Mounted under /api/providers
 * behind authenticateToken. The mutating/owner surfaces are additionally behind
 * requireRole('owner'). Wire shape is `shared/harness-update.contract.ts`.
 *
 *   GET  /:id/version-status      (any authenticated user)
 *   GET  /version-status          (any authenticated user)
 *   POST /:id/update              (owner)
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

import type {
  HarnessUpdateConflict,
  HarnessVersionStatus,
} from '../../../../shared/harness-update.contract.js';

import { resolveHarnessId } from './descriptors.js';
import {
  getAllHarnessVersionStatuses,
  getHarnessVersionStatus,
} from './version-status.service.js';
import { getHarnessUpdateJob, startHarnessUpdate } from './update.service.js';
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

// POST update (owner only).
router.post(
  '/:id/update',
  requireRole('owner'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = resolveHarnessId(req.params.id);
    if (!id) {
      throw new AppError('Unknown harness.', { code: 'UNKNOWN_HARNESS', statusCode: 404 });
    }
    try {
      const job = await startHarnessUpdate(id, { userId: readUserId(req), trigger: 'manual' });
      res.status(202).json({ jobId: job.jobId, provider: job.provider, status: job.status });
    } catch (err) {
      if (err instanceof AppError && err.code === 'HARNESS_UPDATE_IN_PROGRESS') {
        const details = err.details as { activeJobId?: string } | undefined;
        const body: HarnessUpdateConflict = { activeJobId: details?.activeJobId ?? '' };
        res.status(409).json(body);
        return;
      }
      throw err;
    }
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
