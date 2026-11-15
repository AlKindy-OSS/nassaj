/**
 * The local model servers block of a body that runs on them (ADR-227 Decision 10,
 * T-2098 stage 3b, T-2107 stage 5), mounted under /api/providers behind
 * authenticateToken:
 *
 *   GET /:body/local-overlay   picker block of the caller's servers (claude, codex, dsh)
 *
 * Identity comes from the authenticated session only, never from the request.
 * Each body answers with its own switch, its own grant rule and its own spawn
 * vetting; any other body is a 404.
 */
import express, { type Request } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import {
  authorizedLocalModelServers,
  claudeLocalEngineEnabled,
  claudeLocalModelsRunnable,
  codexLocalEngineEnabled,
  codexLocalModelsRunnable,
  dshLocalEngineEnabled,
  dshLocalModelsRunnable,
} from '@/services/isolation/local-model-config.js';
import { LOCAL_OVERLAY_BODIES, localOverlayForCaller } from '@/services/isolation/local-overlay.js';

type LocalBody = keyof typeof LOCAL_OVERLAY_BODIES;

/** Per body: its switch and its grant rule, the ones its spawn reads. */
const BODY_GATES: Readonly<Record<LocalBody, { enabled: () => boolean; runnable: (id: number) => boolean }>> = {
  claude: { enabled: claudeLocalEngineEnabled, runnable: claudeLocalModelsRunnable },
  codex: { enabled: codexLocalEngineEnabled, runnable: codexLocalModelsRunnable },
  dsh: { enabled: dshLocalEngineEnabled, runnable: dshLocalModelsRunnable },
};

const router = express.Router();

/** The authenticated caller's numeric id; 401 otherwise. */
function callerId(req: Request): number {
  const id = Number((req as Request & { user?: { id?: unknown } }).user?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AppError('Sign-in required.', { code: 'UNAUTHORIZED', statusCode: 401 });
  }
  return id;
}

/** The path's body when it runs on local servers; 404 otherwise. */
function localBody(value: unknown): LocalBody {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(BODY_GATES, value)) {
    return value as LocalBody;
  }
  throw new AppError('This body does not run on local model servers.', { code: 'NOT_FOUND', statusCode: 404 });
}

router.get('/:body/local-overlay', asyncHandler(async (req, res) => {
  const id = callerId(req);
  const body = localBody(req.params.body);
  const rows = localOverlayForCaller(id, {
    ...BODY_GATES[body],
    listServers: authorizedLocalModelServers,
    vetting: LOCAL_OVERLAY_BODIES[body],
  });
  res.json(createApiSuccessResponse(rows));
}));

export default router;
