import type { Database } from 'better-sqlite3';
import express, { type Request, type Response, type NextFunction } from 'express';

import { denyC4ReviewResponse } from '../account-wallet/index.js';
import { AgentReviewError } from '../database/index.js';

import type { ReviewAccessSeams } from './services/agent-review-http-authority.js';
import { AgentReviewHttpService } from './services/agent-review-http.service.js';

const CONFLICTS = new Set(['unavailable', 'stale_generation', 'stale_revision', 'invalid_transition', 'immutable_source',
  'idempotency_conflict', 'identity_changed', 'project_access_changed']);

/** Bounded error projection; no SQL details and no mutation retry on a busy connection. */
function reviewError(error: unknown, _req: Request, res: Response, _next: NextFunction, enrolled: boolean): void {
  const raw = (error as { code?: unknown })?.code;
  if (typeof raw === 'string' && (raw === 'SQLITE_BUSY' || raw.startsWith('SQLITE_BUSY_'))) {
    res.status(409).json({ error: { code: 'review_conflict' } }); return;
  }
  const code = error instanceof AgentReviewError ? error.code : raw === 'SESSION_NOT_FOUND' ? 'session_not_found' : 'review_unavailable';
  const status = CONFLICTS.has(code) ? 409 : code === 'forbidden' ? 403 : code === 'session_not_found' ? 404 : code === 'invalid_input' ? 400 : 503;
  const lateFence = code === 'identity_changed' || code === 'project_access_changed';
  if (lateFence && enrolled) { denyC4ReviewResponse(_req, res, code as 'identity_changed' | 'project_access_changed'); return; }
  res.status(status).json({ error: { code, ...(lateFence ? { notStarted: !res.locals.reviewCommitted,
    ...(res.locals.reviewCommitted ? { effectState: 'outcome_unknown' } : {}) } : {}) } });
}

/** Construct dormant endpoints for the existing provider mount; this factory does not register or activate them. */
export function createAgentReviewRouter(db: Database, seams?: ReviewAccessSeams, enrolled = false): express.Router {
  const router = express.Router(); const service = new AgentReviewHttpService(db, seams);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/sessions/:sessionId/agent-reviews', async (req, res, next) => {
    try { const reply = await service.get(req); reply.assertCurrent(); res.json(reply.data); } catch (error) { next(error); }
  });
  router.patch('/sessions/:sessionId/agent-reviews/:agentId', async (req, res, next) => {
    try { const reply = await service.patch(req, enrolled ? res : undefined); res.locals.reviewCommitted = true; reply.assertCurrent(); res.json(reply.data); } catch (error) { next(error); }
  });
  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => reviewError(error, req, res, next, enrolled));
  return router;
}
