/**
 * Claude body on the member's own local model servers (ADR-227, T-2098 stage 3b),
 * mounted at /api/providers/claude behind authenticateToken:
 *
 *   GET /local-overlay   picker block of the caller's servers
 *
 * Identity comes from the authenticated session only, never from the request.
 */
import express, { type Request } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import {
  authorizedLocalModelServers,
  claudeLocalEngineEnabled,
  claudeLocalModelsRunnable,
} from '@/services/isolation/local-model-config.js';
import { claudeLocalOverlayForCaller } from '@/services/isolation/claude-local-overlay.js';

const router = express.Router();

/** The authenticated caller's numeric id; 401 otherwise. */
function callerId(req: Request): number {
  const id = Number((req as Request & { user?: { id?: unknown } }).user?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AppError('Sign-in required.', { code: 'UNAUTHORIZED', statusCode: 401 });
  }
  return id;
}

router.get('/local-overlay', asyncHandler(async (req, res) => {
  const rows = claudeLocalOverlayForCaller(callerId(req), {
    enabled: claudeLocalEngineEnabled,
    runnable: claudeLocalModelsRunnable,
    listServers: authorizedLocalModelServers,
  });
  res.json(createApiSuccessResponse(rows));
}));

export default router;
