/**
 * /api/credential-sharing — the one-time retirement notice (ADR-152 A1 §3.10).
 *
 *   GET  /retirement-notice      → 200 { notice: null | {...} }   (owner role only)
 *   POST /retirement-notice/ack  → 204, idempotent, strict audit   (owner role only)
 *
 * Every other role gets 404, so the notice's existence is not disclosed. The
 * router sits behind authenticateToken (server/index.js).
 */

import express, { type Request, type Response } from 'express';

import { createRateLimiter } from '@/middleware/rate-limit.js';
import { providerSharingRetirementNoticeService } from '@/modules/providers/services/provider-sharing-retirement-notice.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const ackLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
  message: 'Too many acknowledgements; try again in a minute.',
  code: 'RETIREMENT_NOTICE_RATE_LIMITED',
});

/** The caller's id when they hold the owner role; anyone else gets a 404. */
function requireOwner(req: Request): number {
  const user = (req as Request & { user?: { id?: unknown; role?: unknown } }).user;
  const id = Number(user?.id);
  if (user?.role !== 'owner' || !Number.isSafeInteger(id) || id <= 0) {
    throw new AppError('Not found.', { code: 'NOT_FOUND', statusCode: 404 });
  }
  return id;
}

router.get('/retirement-notice', asyncHandler(async (req: Request, res: Response) => {
  requireOwner(req);
  res.json(createApiSuccessResponse({ notice: providerSharingRetirementNoticeService.getNotice() }));
}));

router.post('/retirement-notice/ack', ackLimiter, asyncHandler(async (req: Request, res: Response) => {
  const ownerId = requireOwner(req);
  providerSharingRetirementNoticeService.acknowledge(ownerId);
  res.status(204).end();
}));

export default router;
