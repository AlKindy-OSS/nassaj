/**
 * ADR-219 P2a-min hold routes, mounted at /api/peer-relay BEHIND authenticateToken
 * (so a device-cookie mutation already passed the Origin + CSRF guard, ش-1):
 *
 *   GET  /holds?limit&before                     → { holds, count, nextCursor }  the caller's inbox
 *   GET  /sessions/:sessionId/holds?limit&before → { holds, nextCursor }         session read gate (404)
 *   POST /holds/:holdId/approve { expectedHoldVersion, expectedTextHash, expectedTargetMode }
 *        → 200 { hold, messageId } | 400 | 403 | 404 | 409 { code, hold? }
 *   POST /holds/:holdId/reject  { expectedHoldVersion, reason? (≤ 200) } → 200 { hold } | 400 | 403 | 404 | 409
 *
 * Every write runs PEER_HOLD_WRITE_GUARD first: IS_PLATFORM ⇒ 403 platform_mode;
 * any non-interactive credential (the shared allowlist) ⇒ 403
 * interactive_credential_required. Then the service recomputes the target owner
 * (403 not_target_owner) and CASes state, version, text hash and mode (409).
 * Errors carry `{ error, code }`; bodies are never logged.
 */

import express, { type NextFunction, type Request, type Response } from 'express';

import { isSessionId } from '@/shared/session-id.js';
import { isVerifiedActorKind } from '@/shared/verified-actor-kinds.js';

// eslint-disable-next-line boundaries/no-unknown -- shared HTTP rate limiter, as in the fence routes.
import { createRateLimiter } from '../../middleware/rate-limit.js';

import {
  approvePeerHold, listPeerHoldInbox, listSessionPeerHolds, rejectPeerHold, type HoldCaller, type HoldDecisionResult,
} from './peer-holds.service.js';

export type PeerHoldsRouterOptions = Readonly<{
  /** ADR-089 read gate of a session (the history gate, unchanged). */
  canReadSession: (sessionId: string, userId: number) => boolean;
  isPlatform: () => boolean;
}>;

type AuthedRequest = Request & { user?: { id?: unknown; authenticationKind?: unknown } };

function userIdOf(req: Request): number | null {
  const raw = (req as AuthedRequest).user?.id;
  const id = typeof raw === 'string' && /^\d+$/u.test(raw) ? Number(raw) : raw;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

const deny = (res: Response, status: number, code: string, error: string) => res.status(status).json({ error, code });

const ERROR_TEXT: Record<number, string> = {
  400: 'Invalid request', 403: 'Not allowed', 404: 'Hold not found', 409: 'The hold changed; refresh it',
};

function send(res: Response, result: HoldDecisionResult): void {
  if (result.status === 200) {
    res.json({ hold: result.hold, ...(result.messageId ? { messageId: result.messageId } : {}) });
    return;
  }
  res.status(result.status).json({ error: ERROR_TEXT[result.status], code: result.code, ...(result.hold ? { hold: result.hold } : {}) });
}

type GuardLocals = { peerHoldsPlatform?: boolean };

/**
 * The one gate every P2 write route runs (ش-1): IS_PLATFORM ⇒ 403 platform_mode;
 * a credential outside the shared interactive allowlist ⇒ 403
 * interactive_credential_required. The platform flag is set per request by the
 * router; when it is missing the guard refuses (fail closed).
 */
export function PEER_HOLD_WRITE_GUARD(req: Request, res: Response, next: NextFunction): void {
  if ((res.locals as GuardLocals).peerHoldsPlatform !== false) {
    deny(res, 403, 'platform_mode', 'Not available in platform mode');
    return;
  }
  if (!isVerifiedActorKind((req as AuthedRequest).user?.authenticationKind) || userIdOf(req) === null) {
    deny(res, 403, 'interactive_credential_required', 'An interactive signed-in session is required');
    return;
  }
  next();
}

const limiter = (max: number, name: string) => createRateLimiter({
  windowMs: 60_000, max, code: 'rate_limited', message: 'Too many requests, please slow down',
  key: (req: Request) => `peer-holds:${name}:${userIdOf(req) ?? 'anonymous'}`,
});

/** Builds the router; `PEER_HOLD_WRITE_GUARD` is the one gate every write route runs (guard test). */
export function createPeerHoldsRouter(options: PeerHoldsRouterOptions) {
  const router = express.Router();
  router.use((_req, res, next) => {
    (res.locals as GuardLocals).peerHoldsPlatform = options.isPlatform();
    next();
  });
  const writes = [limiter(30, 'write'), PEER_HOLD_WRITE_GUARD];
  const caller = (req: Request): HoldCaller => ({
    userId: userIdOf(req) as number, authKind: String((req as AuthedRequest).user?.authenticationKind),
  });

  router.get('/holds', limiter(120, 'read'), (req, res) => {
    const userId = userIdOf(req);
    if (userId === null) return deny(res, 401, 'AUTH_REQUIRED', 'Authentication required');
    return res.json(listPeerHoldInbox(userId, req.query.before, req.query.limit));
  });
  router.get('/sessions/:sessionId/holds', limiter(120, 'read'), (req, res) => {
    const userId = userIdOf(req);
    const sessionId = String(req.params.sessionId ?? '');
    if (userId === null) return deny(res, 401, 'AUTH_REQUIRED', 'Authentication required');
    if (!isSessionId(sessionId) || !options.canReadSession(sessionId, userId)) {
      return deny(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    }
    return res.json(listSessionPeerHolds(sessionId, req.query.before, req.query.limit));
  });
  router.post('/holds/:holdId/approve', ...writes, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    send(res, approvePeerHold({ holdId: String(req.params.holdId), caller: caller(req),
      expectedHoldVersion: body.expectedHoldVersion, expectedTextHash: body.expectedTextHash,
      expectedTargetMode: body.expectedTargetMode }));
  });
  router.post('/holds/:holdId/reject', ...writes, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    send(res, rejectPeerHold({ holdId: String(req.params.holdId), caller: caller(req),
      expectedHoldVersion: body.expectedHoldVersion, reason: body.reason }));
  });
  return router;
}
