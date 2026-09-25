/**
 * credential-grants.routes — user-to-user credential delegation (T-1675).
 * Mounted at `/api/credential-grants` behind authenticateToken (server/index.js).
 *
 *   GET    /                                  → the caller's full picture
 *   PUT    /:provider/grantees  {userIds:[]}  → the caller's grantee set for a provider
 *   DELETE /:provider/grantees/:userId        → revoke one grant the caller owns
 *   PUT    /:provider/use  {ownerUserId|null} → which received grant the caller runs on
 *
 * SELF-SCOPED BY CONSTRUCTION, like governance-preferences: the subject of every
 * write is `req.user`. An owner can only add or remove grantees on their OWN
 * credential, and a grantee can only accept or decline grants offered to THEM.
 * There is no request field that aims a change at a third party, and no role is
 * ever consulted — a member sharing their own subscription is not an admin act.
 */

import express, { type Request, type Response } from 'express';

import { createRateLimiter } from '@/middleware/rate-limit.js';
import { auditLogDb, credentialGrantsDb, getConnection, userDb } from '@/modules/database/index.js';
import {
  isGrantableKey,
  GRANTABLE_UNITS,
  credentialUnit,
  resolveCredentialPrincipal,
} from '@/services/isolation/credential-principal.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

// Writes hand a subscription to another account: a member has no reason to do
// that more than a handful of times a minute, and a runaway client must not be
// able to churn the audit log. Reads stay unlimited (the settings page polls).
const writeLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Too many credential-sharing changes; try again in a minute.',
  code: 'CREDENTIAL_GRANT_RATE_LIMITED',
});

type Member = { id: number; username: string };

const readCallerId = (req: Request): number => {
  const raw = (req as Request & { user?: { id?: string | number } }).user?.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('Authentication required.', { code: 'UNAUTHENTICATED', statusCode: 401 });
  }
  return id;
};

const parseProvider = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isGrantableKey(normalized)) {
    throw new AppError('This provider cannot be delegated.', {
      code: 'CREDENTIAL_GRANT_PROVIDER_UNKNOWN',
      statusCode: 400,
      details: { provider: normalized },
    });
  }
  // agy → gemini: one credential, one grant (credential-principal.js).
  return credentialUnit(normalized);
};

const parseUserId = (value: unknown): number => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('Invalid user id.', { code: 'CREDENTIAL_GRANT_USER_INVALID', statusCode: 400 });
  }
  return id;
};

/** Active accounts other than the caller — the only valid grantees. */
const listActiveMembers = (callerId: number): Member[] =>
  userDb
    .listUsers()
    .filter((user) => Number(user.id) !== callerId && user.status === 'active')
    .map((user) => ({ id: Number(user.id), username: user.username }));

const usernameIndex = (): Map<number, string> => {
  const index = new Map<number, string>();
  for (const user of userDb.listUsers()) index.set(Number(user.id), user.username);
  return index;
};

/**
 * The caller's picture, in the shape the settings page renders:
 *   given:     grants the caller owns, per provider, with each grantee's answer;
 *   received:  grants offered to the caller, per provider, with the one in use;
 *   members:   whom the caller may add as a grantee.
 */
function buildOverview(callerId: number) {
  const names = usernameIndex();
  const nameOf = (id: number) => names.get(id) ?? `#${id}`;

  const given = credentialGrantsDb.listByOwner(callerId).map((row) => ({
    provider: row.provider,
    userId: row.granteeUserId,
    username: nameOf(row.granteeUserId),
    declined: row.declinedAt !== null,
    createdAt: row.createdAt,
  }));

  const received = credentialGrantsDb.listByGrantee(callerId).map((row) => ({
    provider: row.provider,
    ownerUserId: row.ownerUserId,
    ownerUsername: nameOf(row.ownerUserId),
    declined: row.declinedAt !== null,
    createdAt: row.createdAt,
    inUse: false,
  }));
  for (const provider of GRANTABLE_UNITS) {
    const { grantedBy } = resolveCredentialPrincipal(callerId, provider);
    if (grantedBy === null) continue;
    const row = received.find((r) => r.provider === provider && r.ownerUserId === grantedBy);
    if (row) row.inUse = true;
  }

  return {
    providers: [...GRANTABLE_UNITS],
    given,
    received,
    members: listActiveMembers(callerId),
  };
}

const audit = (req: Request, action: 'credential_grant_created' | 'credential_grant_revoked' | 'credential_grant_declined' | 'credential_grant_accepted', metadata: Record<string, unknown>) => {
  auditLogDb.record(action, {
    userId: readCallerId(req),
    metadata,
    ipAddress: req.ip ?? null,
  });
};

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(buildOverview(readCallerId(req))));
}));

/**
 * Replaces the caller's grantee set for one provider. Ids not in the new set are
 * revoked; new ones are granted. An id that is not an active member, or the
 * caller's own, is refused as a whole — no partial application.
 */
router.put('/:provider/grantees', writeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const callerId = readCallerId(req);
  const provider = parseProvider(req.params.provider);
  const body = (req.body ?? {}) as { userIds?: unknown };
  if (!Array.isArray(body.userIds)) {
    throw new AppError('userIds must be an array.', { code: 'CREDENTIAL_GRANT_BODY_INVALID', statusCode: 400 });
  }
  const wanted = new Set(body.userIds.map(parseUserId));
  for (const id of wanted) {
    // getUserById applies BOTH activity guards (is_active AND status).
    if (id === callerId || !userDb.getUserById(id)) {
      throw new AppError('Only other active members can receive a credential grant.', {
        code: 'CREDENTIAL_GRANT_GRANTEE_INVALID',
        statusCode: 400,
        details: { userId: id },
      });
    }
  }

  // One transaction: the set is replaced whole or not at all, so a failure
  // midway cannot leave a half-applied grantee list. Audit rows are written
  // after the commit, for what actually changed.
  const changes: Array<['credential_grant_revoked' | 'credential_grant_created', number]> = [];
  getConnection().transaction(() => {
    const current = new Set(
      credentialGrantsDb.listByOwner(callerId).filter((r) => r.provider === provider).map((r) => r.granteeUserId),
    );
    for (const id of current) {
      if (!wanted.has(id) && credentialGrantsDb.revoke(callerId, id, provider)) {
        changes.push(['credential_grant_revoked', id]);
      }
    }
    for (const id of wanted) {
      if (!current.has(id) && credentialGrantsDb.grant(callerId, id, provider)) {
        changes.push(['credential_grant_created', id]);
      }
    }
  })();
  for (const [action, id] of changes) {
    audit(req, action, { provider, granteeUserId: id });
  }

  res.json(createApiSuccessResponse(buildOverview(callerId)));
}));

router.delete('/:provider/grantees/:userId', writeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const callerId = readCallerId(req);
  const provider = parseProvider(req.params.provider);
  const granteeId = parseUserId(req.params.userId);
  if (credentialGrantsDb.revoke(callerId, granteeId, provider)) {
    audit(req, 'credential_grant_revoked', { provider, granteeUserId: granteeId });
  }
  res.json(createApiSuccessResponse(buildOverview(callerId)));
}));

/**
 * Grantee-side choice for one provider: `ownerUserId` names the grant to run
 * on (every other grant for that provider is declined so exactly one is
 * usable), `null` declines them all and returns the caller to their own
 * credential. Naming an owner who has not offered a grant is a 404 — a grantee
 * cannot conjure access.
 */
router.put('/:provider/use', writeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const callerId = readCallerId(req);
  const provider = parseProvider(req.params.provider);
  const body = (req.body ?? {}) as { ownerUserId?: unknown };
  const chosen = body.ownerUserId === null || body.ownerUserId === undefined
    ? null
    : parseUserId(body.ownerUserId);

  const offered = credentialGrantsDb.listByGrantee(callerId).filter((r) => r.provider === provider);
  if (chosen !== null && !offered.some((r) => r.ownerUserId === chosen)) {
    throw new AppError('No credential grant from that member exists for this provider.', {
      code: 'CREDENTIAL_GRANT_NOT_FOUND',
      statusCode: 404,
    });
  }

  for (const row of offered) {
    const shouldDecline = chosen === null || row.ownerUserId !== chosen;
    const wasDeclined = row.declinedAt !== null;
    if (shouldDecline !== wasDeclined
      && credentialGrantsDb.setDeclined(row.ownerUserId, callerId, provider, shouldDecline)) {
      audit(
        req,
        shouldDecline ? 'credential_grant_declined' : 'credential_grant_accepted',
        { provider, ownerUserId: row.ownerUserId },
      );
    }
  }

  res.json(createApiSuccessResponse(buildOverview(callerId)));
}));

export default router;
