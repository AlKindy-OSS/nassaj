/**
 * Steering settings routes (T-1903 / ADR-190). Mounted at /api/session-steer
 * behind authenticateToken. Wire shape: shared/session-steer.contract.ts.
 *
 *   GET  /policy    (any authenticated user)  → SteerPolicy
 *   PUT  /policy    (owner/admin, audited)     → SteerPolicy
 *   GET  /consent   (self)                     → SteerConsent
 *   PUT  /consent   (self, audited)            → SteerConsent
 */

import express, { type Request, type Response } from 'express';

// eslint-disable-next-line boundaries/no-unknown -- shared HTTP rate limiting protects this public module route.
import { createRateLimiter } from '@/middleware/rate-limit.js';
// eslint-disable-next-line boundaries/no-unknown -- shared authentication middleware owns the canonical role predicate.
import { requireRole } from '@/middleware/auth.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

import { getSteerConsent, getSteerPolicy, setSteerConsent, setSteerPolicy } from './steer-policy.js';

const router = express.Router();

const writeLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'Too many steering settings changes, please slow down',
  code: 'SESSION_STEER_SETTINGS_RATE_LIMITED',
});

function requesterId(req: Request): number {
  const id = Number((req as Request & { user?: { id?: unknown } }).user?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AppError('Authentication required.', { code: 'UNAUTHENTICATED', statusCode: 401 });
  }
  return id;
}

router.get('/policy', asyncHandler(async (_req: Request, res: Response) => {
  res.json(getSteerPolicy());
}));

router.put('/policy', requireRole('owner', 'admin'), writeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const result = setSteerPolicy(req.body, requesterId(req));
  if (!result.ok) throw new AppError(result.error, { code: 'INVALID_STEER_POLICY', statusCode: 400 });
  res.json(result.policy);
}));

router.get('/consent', asyncHandler(async (req: Request, res: Response) => {
  res.json({ allowSteerOnMyRuns: getSteerConsent(requesterId(req)) });
}));

router.put('/consent', writeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const result = setSteerConsent(requesterId(req), req.body);
  if (!result.ok) throw new AppError(result.error, { code: 'INVALID_STEER_CONSENT', statusCode: 400 });
  res.json({ allowSteerOnMyRuns: result.allowSteerOnMyRuns });
}));

export default router;
