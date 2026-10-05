/**
 * T-1910 S4 routes (mounted at /api/sessions behind authenticateToken):
 *
 *   GET  /api/sessions/:sessionId/permission-fence              → fence view for the chat card
 *   POST /api/sessions/:sessionId/permission-fence/acknowledge  → "continue here"
 *
 * The project is resolved from the session ROW, never from request input, through the same
 * findOwningProject the read gate uses (subdirectories, symlinks, realpath); an ambiguous owner
 * refuses. Reading needs the shared session read gate (404 otherwise, non-disclosing);
 * acknowledging additionally needs a verified actor (authenticationKind 'session' or
 * 'device_session'; platform_unverified and others are 403, so the journal never records a
 * false actor) and isProjectWritableByUser on the owning project (403). Only a fence scoped to
 * exactly this session is liftable here; every other scope stays owner-only via Settings >
 * System. Proof, CAS and the audited journal live in the execution-permissions service (see
 * its docstring for the refusal reasons and the qa M6 residual: tag-dropping descendants such
 * as a tmux server, systemd-run, env -i, docker, ssh, pm2, at/cron or sudo escape the scan).
 *
 * Rate limits (qa M3): per user first; the per-session and global buckets are charged only
 * after access resolved and the writer check passed, so 404/403 probes cannot exhaust them.
 */

import express, { type NextFunction, type Request, type Response } from 'express';

import { auditLogDb, findOwningProject, getConnection, projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  SessionFenceRefusal,
  acknowledgeSessionFence,
  describeSessionFence,
  type ContainmentDependencies,
} from '@/modules/execution-permissions/index.js';
import { isSessionAccessibleByUser } from '@/modules/providers/services/sessions.service.js';

// eslint-disable-next-line boundaries/no-unknown -- shared HTTP rate limiter, as in connectors.
import { createRateLimiter } from '../../middleware/rate-limit.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/u;
const VERIFIED_ACTOR_KINDS = new Set(['session', 'device_session']);

export type DecisionOwnerNotice = Readonly<{ ownerUserId: number; sessionId: string; operationId: string }>;

export type SessionPermissionFenceRouterOptions = Readonly<{
  /** Push to the decision owner when someone else lifted their fence; must not throw. */
  notifyDecisionOwner?: (notice: DecisionOwnerNotice) => void;
  /** Host process proof (createHostContainment at the composition root). */
  containment: ContainmentDependencies;
  limits?: Readonly<{ readPerUser?: number; ackPerUser?: number; ackPerSession?: number; ackGlobal?: number }>;
}>;

type AuthenticatedRequest = Request & {
  user?: { id?: number | string; deviceSessionId?: unknown; authenticationKind?: unknown };
};

const userIdOf = (req: Request): number | null => {
  const raw = (req as AuthenticatedRequest).user?.id;
  const id = typeof raw === 'string' && /^\d+$/u.test(raw) ? Number(raw) : raw;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
};

const deviceSessionIdOf = (req: Request): string | null => {
  const raw = (req as AuthenticatedRequest).user?.deviceSessionId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

type Access = Readonly<{ sessionId: string; userId: number; canWrite: boolean }>;

/** Writer bit from the project that OWNS the session path; ambiguity or no owner is false. */
const canWriteSession = (projectPath: string | null | undefined, userId: number): boolean => {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return false;
  try {
    const owner = findOwningProject(projectPath);
    return owner !== null && projectsDb.isProjectWritableByUser(owner.project_id, userId);
  } catch {
    return false;
  }
};

/** Read gate (404, non-disclosing) + writer bit from the session row's own project. */
const resolveAccess = (req: Request, res: Response): Access | null => {
  const userId = userIdOf(req);
  if (userId === null) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return null;
  }
  const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
  const session = SESSION_ID_PATTERN.test(sessionId) ? sessionsDb.getSessionById(sessionId) : null;
  if (!session || !isSessionAccessibleByUser(sessionId, session.project_path, userId, 'read')) {
    res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
    return null;
  }
  return { sessionId, userId, canWrite: canWriteSession(session.project_path, userId) };
};

type AccessLocals = { fenceAccess?: Access };

/** POST gate: verified actor, readable session, writer; stores the access for the handler. */
const requireWriterAccess = (req: Request, res: Response, next: NextFunction): void => {
  const kind = (req as AuthenticatedRequest).user?.authenticationKind;
  if (typeof kind !== 'string' || !VERIFIED_ACTOR_KINDS.has(kind)) {
    res.status(403).json({ error: 'A verified user session is required', code: 'unverified_actor' });
    return;
  }
  const access = resolveAccess(req, res);
  if (!access) return;
  if (!access.canWrite) {
    res.status(403).json({ error: 'Write access to the session is required', code: 'not_writer' });
    return;
  }
  (res.locals as AccessLocals).fenceAccess = access;
  next();
};

const limiter = (max: number, key: (req: Request) => string) => createRateLimiter({
  windowMs: 60_000, max, key, code: 'rate_limited', message: 'Too many requests, please slow down',
});
const userKey = (req: Request): string => `user:${userIdOf(req) ?? 'anonymous'}`;
const sessionKey = (req: Request): string => `session:${String(req.params.sessionId ?? '').slice(0, 128)}`;

/** Builds the router; options are composition-root seams (notifier, limits, test containment). */
export function createSessionPermissionFenceRouter(options: SessionPermissionFenceRouterOptions) {
  const router = express.Router();
  const { containment } = options;
  const readPerUser = limiter(options.limits?.readPerUser ?? 60, userKey);
  const ackPerUser = limiter(options.limits?.ackPerUser ?? 5, userKey);
  const ackPerSession = limiter(options.limits?.ackPerSession ?? 10, sessionKey);
  const ackGlobal = limiter(options.limits?.ackGlobal ?? 30, () => 'global');

  router.get('/:sessionId/permission-fence', readPerUser, (req: Request, res: Response) => {
    try {
      const access = resolveAccess(req, res);
      if (!access) return undefined;
      return res.json(describeSessionFence(getConnection(), {
        sessionId: access.sessionId, requesterUserId: access.userId, canWrite: access.canWrite,
      }, containment));
    } catch (error) {
      console.error('[permission-fence] session fence read failed', { error: (error as Error).message });
      return res.status(500).json({ error: 'Failed to read the session fence', code: 'fence_read_failed' });
    }
  });

  router.post('/:sessionId/permission-fence/acknowledge', ackPerUser, requireWriterAccess, ackPerSession, ackGlobal,
    (req: Request, res: Response) => {
      const access = (res.locals as AccessLocals).fenceAccess as Access;
      try {
        const deviceSessionId = deviceSessionIdOf(req);
        const outcome = acknowledgeSessionFence(getConnection(), {
          sessionId: access.sessionId, actorUserId: access.userId, actorDeviceSessionId: deviceSessionId,
        }, containment);
        if (!outcome.lifted) return res.json({ lifted: false, reason: outcome.reason });
        const notifyOwner = outcome.decisionOwnerUserId !== null && outcome.decisionOwnerUserId !== access.userId;
        let ownerNotificationAttempted = false;
        if (notifyOwner && options.notifyDecisionOwner) {
          ownerNotificationAttempted = true;
          try {
            options.notifyDecisionOwner({
              ownerUserId: outcome.decisionOwnerUserId as number, sessionId: access.sessionId, operationId: outcome.operationId,
            });
          } catch (error) {
            console.error('[permission-fence] owner notification failed', { error: (error as Error).message });
          }
        }
        auditLogDb.record('permission_fence_acknowledged', {
          userId: access.userId,
          metadata: {
            operationId: outcome.operationId,
            sessionId: access.sessionId,
            actorUserId: access.userId,
            actorDeviceSessionId: deviceSessionId,
            decisionOwnerUserId: outcome.decisionOwnerUserId,
            ownerNotificationRequired: notifyOwner,
            ownerNotificationAttempted,
            completionAuditRecorded: outcome.completionAuditRecorded,
            acknowledgementIsProof: false,
          },
        });
        return res.json({ lifted: true });
      } catch (error) {
        if (error instanceof SessionFenceRefusal) return res.status(409).json({ lifted: false, reason: error.reason });
        console.error('[permission-fence] session fence acknowledgement failed', { error: (error as Error).message });
        return res.status(500).json({ error: 'Failed to acknowledge the session fence', code: 'acknowledge_failed' });
      }
    });

  return router;
}
