/**
 * governance-preferences.routes — the per-engine governance switch surface
 * (owner decision 2026-08-08). Mounted at `/api/governance` behind
 * authenticateToken (server/index.js).
 *
 *   GET  /api/governance/preferences            → { channels: [...] }
 *   PUT  /api/governance/preferences/:provider  → the channel, re-read from disk
 *
 * SELF-SCOPED BY CONSTRUCTION. Neither route takes a target user: the subject is
 * always the authenticated caller, read from `req.user` which only
 * authenticateToken sets. There is no request field a client could use to aim a
 * change at somebody else's tree, so the "may A change B" question never arises
 * and never has to be answered correctly.
 *
 * ROLE IS CHECKED INSIDE THE HANDLER, not by mounted middleware — the same
 * idiom, and for the same reason, as the provider skills/MCP writes
 * (provider.routes.ts:1683-1689): Express routing is case-INSENSITIVE, so a
 * path-matching guard can be slipped past with `/PREFERENCES`, while reading
 * `req.user.role` in the handler is immune to path casing. The read stays open
 * to every authenticated member and carries `canManage` so the client can render
 * a control or a read-only badge without guessing.
 */

import express, { type Request, type Response } from 'express';

import {
  GOVERNANCE_CHANNEL_PROVIDERS,
  governancePreferencesService,
  type GovernanceActorContext,
  type GovernanceMode,
} from '@/modules/providers/services/governance-preferences.service.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

/**
 * Platform mode, read at CALL time from the same variable the provider routes
 * read (provider.routes.ts:157-169). Duplicated deliberately rather than
 * imported across a module boundary: it is one comparison, and it must be read
 * per call so a test can set it without module games.
 *
 * WHY IT GATES A GOVERNANCE WRITE: platform mode does not authenticate
 * differently — it DISABLES authentication and answers every request as the
 * first user, so `role === 'owner'` there means "anyone who opened a socket"
 * (middleware/auth.js:49-58, B-186).
 */
const isPlatformMode = (): boolean => process.env.VITE_IS_PLATFORM === 'true';

/**
 * The authenticated caller, who is also the subject of every route here. The
 * request provenance rides along because the AUDIT ROW IS WRITTEN BY THE
 * SERVICE, not here: an exemption deletes the file that would otherwise be its
 * own evidence, so the record has to be produced by the same function that
 * performs the deletion rather than by whichever caller remembers to.
 */
const readActor = (req: Request): GovernanceActorContext => {
  const user = (req as Request & { user?: { id?: string | number; role?: string } }).user;
  return {
    userId: user?.id ?? null,
    role: user?.role ?? null,
    platformMode: isPlatformMode(),
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
};

/**
 * Validates `:provider` against the CHANNEL list, not the provider union. An
 * engine with no nassaj channel has no switch to flip, so naming one is a 400
 * rather than a silently accepted no-op that a client would render as success.
 */
const parseChannelProvider = (value: unknown): LLMProvider => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const match = GOVERNANCE_CHANNEL_PROVIDERS.find((provider) => provider === normalized);
  if (!match) {
    throw new AppError('Unknown governance channel.', {
      code: 'GOVERNANCE_CHANNEL_UNKNOWN',
      statusCode: 400,
      details: { provider: normalized },
    });
  }
  return match;
};

/** Reads the requested position. Anything but the two literals is a 400. */
const parseMode = (body: unknown): GovernanceMode => {
  const mode = (body as { mode?: unknown } | null | undefined)?.mode;
  if (mode !== 'governed' && mode !== 'exempt') {
    throw new AppError("mode must be 'governed' or 'exempt'.", {
      code: 'GOVERNANCE_MODE_INVALID',
      statusCode: 400,
    });
  }
  return mode;
};

// Every channel's position for the caller. Open to any authenticated member: the
// positions are not secret, and a member who may not change one still needs to
// SEE whether their engines carry nassaj instructions.
router.get(
  '/preferences',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ channels: governancePreferencesService.listChannels(readActor(req)) });
  }),
);

// Flips one switch for the caller's own tree. `exempt` is owner/admin only and
// removes the material from disk; `governed` is open to any role and rebuilds
// it. Both are audited inside the service (see readActor above). The response is
// the channel RE-READ from disk — never an optimistic echo of the request, so a
// removal that did not take reports itself instead of showing a green result.
router.put(
  '/preferences/:provider',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseChannelProvider(req.params.provider);
    const mode = parseMode(req.body);
    res.json(governancePreferencesService.setMode(provider, mode, readActor(req)));
  }),
);

export default router;
