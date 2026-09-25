import express, { type RequestHandler } from 'express';

import { matchC4ReviewRequest } from '../modules/account-wallet/index.js';
import { createAgentReviewAuthComposition } from '../modules/providers/agent-review-auth-composition.js';

import { createGlobalBodyParsers } from './global-body-limits.js';
import { createRateLimiter } from './rate-limit.js';

/**
 * Dormant production stack: beforeGlobal replaces the position before index.js global parsers (1150),
 * globalParsers replaces both existing parser instances; authenticatedRoutes belongs after the global
 * installation-key gate (1481) and before broad provider authentication (1652). No live mount here.
 * Limits are process-local fixed 60s windows; admission requires single-process deployment.
 */
export function createC4ReviewHttpStack(options: Omit<Parameters<typeof createAgentReviewAuthComposition>[0], 'userRateLimit'>): {
  beforeGlobal: RequestHandler; globalParsers: RequestHandler[]; authenticatedRoutes: express.Router;
} {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 120, code: 'review_rate_limited' });
  const json = express.json({ limit: 65_536, strict: true, inflate: false, type: 'application/json' });
  const beforeGlobal: RequestHandler = (req, res, next) => {
    if (!matchC4ReviewRequest(req)) { next(); return; }
    limiter(req, res, () => {
      const encoding = req.headers['content-encoding'];
      if (encoding !== undefined && encoding !== 'identity') { res.status(415).json({ error: { code: 'unsupported_encoding' } }); return; }
      if (req.method === 'GET') {
        if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
          res.status(400).json({ error: { code: 'unexpected_body' } }); return;
        }
        next(); return;
      }
      if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') { res.status(415).json({ error: { code: 'unsupported_media_type' } }); return; }
      json(req, res, error => {
        if (!error) { next(); return; }
        const status = error.status === 413 ? 413 : error.status === 415 ? 415 : 400;
        res.status(status).json({ error: { code: status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_encoding' : 'invalid_json' } });
      });
    });
  };
  const globalParsers: RequestHandler[] = createGlobalBodyParsers().map(parser => (req, res, next) => {
    if (matchC4ReviewRequest(req)) next(); else parser(req, res, next);
  });
  const key = (req: express.Request): string => String((req as express.Request & { authenticatedPrincipal: { userId: number } }).authenticatedPrincipal.userId);
  const getLimit = createRateLimiter({ windowMs: 60_000, max: 120, key, code: 'review_rate_limited' });
  const patchLimit = createRateLimiter({ windowMs: 60_000, max: 30, key, code: 'review_rate_limited' });
  const userRateLimit: RequestHandler = (req, res, next) => (req.method === 'GET' ? getLimit : patchLimit)(req, res, next);
  return { beforeGlobal, globalParsers, authenticatedRoutes: createAgentReviewAuthComposition({ ...options, userRateLimit }) };
}
