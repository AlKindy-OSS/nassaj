/**
 * harness-files.routes — shared vs private skills (ADR-203, T-2003). Mounted at
 * `/api/harness-files` behind authenticateToken (server/index.js).
 *
 *   GET /api/harness-files            → { workspace, me }
 *   PUT /api/harness-files/me         {mode:'shared'|'private'} → view (+ claude)
 *   PUT /api/harness-files/workspace  {allowMemberPrivate:boolean} → view + affectedMembers
 *
 * SELF-SCOPED BY CONSTRUCTION: no route takes a target user. The subject is the
 * authenticated caller from `req.user`; any `userId` in a body is ignored.
 * Role checks are IN-HANDLER (Express routing is case-insensitive, so a
 * path-matching guard could be slipped with `/WORKSPACE`), same idiom as
 * governance-preferences.routes.ts.
 */

import express, { type Request, type Response } from 'express';

import {
  describeHarnessFiles,
  setMyHarnessFilesMode,
  setWorkspaceAllowMemberPrivate,
  type HarnessFilesActor,
} from '@/modules/harness-files/harness-files.service.js';
import { isHarnessFilesPlatformMode } from '@/services/isolation/harness-files-mode.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

/** The authenticated caller; platform mode is read per call. */
const readActor = (req: Request): HarnessFilesActor => {
  const user = (req as Request & { user?: { id?: string | number; role?: string } }).user;
  return {
    userId: user?.id ?? null,
    role: user?.role ?? null,
    platformMode: isHarnessFilesPlatformMode(),
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
};

/** `{mode}` must be one of the two literals; anything else is a 400. */
const parseMode = (body: unknown): 'shared' | 'private' => {
  const mode = (body as { mode?: unknown } | null | undefined)?.mode;
  if (mode !== 'shared' && mode !== 'private') {
    throw new AppError("mode must be 'shared' or 'private'.", {
      code: 'HARNESS_FILES_MODE_INVALID', statusCode: 400,
    });
  }
  return mode;
};

/** `{allowMemberPrivate}` must be a JSON boolean. */
const parseAllow = (body: unknown): boolean => {
  const value = (body as { allowMemberPrivate?: unknown } | null | undefined)?.allowMemberPrivate;
  if (typeof value !== 'boolean') {
    throw new AppError('allowMemberPrivate must be a boolean.', {
      code: 'HARNESS_FILES_WORKSPACE_INVALID', statusCode: 400,
    });
  }
  return value;
};

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(describeHarnessFiles(readActor(req)));
  }),
);

router.put(
  '/me',
  asyncHandler(async (req: Request, res: Response) => {
    const mode = parseMode(req.body);
    res.json(await setMyHarnessFilesMode(mode, readActor(req)));
  }),
);

router.put(
  '/workspace',
  asyncHandler(async (req: Request, res: Response) => {
    const allow = parseAllow(req.body);
    res.json(await setWorkspaceAllowMemberPrivate(allow, readActor(req)));
  }),
);

export default router;
