import type { Database } from 'better-sqlite3';
import express, { type Request, type Response, type RequestHandler } from 'express';
import jwt from 'jsonwebtoken';

import { enrollC4ReviewResponse, matchC4ReviewRequest, enforceCookieMutationGuard } from '../account-wallet/index.js';
import { AgentReviewReadonlyAuthRepository, type ReviewAuthUser, deviceAccountSessionsDb, DEVICE_COOKIE, getConnection } from '../database/index.js';
import { createAuthenticatedLaunchActor } from '../execution-permissions/index.js';

import { createAgentReviewRouter } from './agent-review.routes.js';
import { AgentReviewHttpAuthority, type ReviewAccessSeams } from './services/agent-review-http-authority.js';

type AuthRequest = Request & { user: ReviewAuthUser & { authenticationKind: string; authorizationGeneration: number; authenticationCredentialId?: string;
  deviceSessionId?: string; slotId?: string; deviceGeneration?: number };
  authenticatedPrincipal: Readonly<{ userId: number }>; assertCurrentIdentity: () => boolean;
  devicePrincipal?: NonNullable<ReturnType<typeof deviceAccountSessionsDb.resolve>>['principal'] };
type Options = { db: Database; jwtSecret: string; deviceEnabled: boolean; accessSeams?: ReviewAccessSeams; userRateLimit: RequestHandler };

function reject(res: Response, status = 401, code = 'authentication_required'): void {
  res.status(status).set('Cache-Control', 'no-store').json({ error: { code } });
}

function carriers(req: Request): { bearer?: string; device?: string } | null {
  const headers = ['authorization', 'cookie', 'x-api-key', 'x-csrf-token'];
  if (headers.some(header => req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === header).length > 1)) return null;
  if (['token', 'ticket', 'access_token'].some(key => Object.hasOwn(req.query, key))) return null;
  const authorization = req.get('authorization');
  if (authorization && !/^Bearer [^\s,]+$/.test(authorization)) return null;
  const cookies = String(req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${DEVICE_COOKIE}=`));
  if (cookies.length > 1 || (cookies.length && authorization)) return null;
  try { return { ...(authorization ? { bearer: authorization.slice(7) } : {}),
    ...(cookies.length ? { device: decodeURIComponent(cookies[0].slice(DEVICE_COOKIE.length + 1)) } : {}) }; }
  catch { return null; }
}

function attach(req: AuthRequest, user: ReviewAuthUser, kind: 'session' | 'ck', current: () => boolean): void {
  req.user = { ...user, authenticationKind: kind, authorizationGeneration: user.authorization_generation,
    ...(kind === 'ck' ? { authenticationCredentialId: `api-key:${user.api_key_id}` } : {}) };
  req.authenticatedPrincipal = kind === 'ck' ? createAuthenticatedLaunchActor(req.user)
    : Object.freeze({ kind: 'jwt', userId: user.id, authorizationGeneration: user.authorization_generation });
  req.assertCurrentIdentity = current;
}

function authenticateBearer(req: AuthRequest, bearer: string, repository: AgentReviewReadonlyAuthRepository, secret: string): boolean {
  if (bearer.startsWith('ck_')) {
    const user = repository.key(bearer); if (!user) return false;
    attach(req, user, 'ck', () => repository.current(user.id, user.authorization_generation, user.password_changed_at, user));
    return true;
  }
  const decoded = jwt.verify(bearer, secret, { algorithms: ['HS256'] });
  if (typeof decoded !== 'object' || Object.hasOwn(decoded, 'purpose') || !Number.isSafeInteger(decoded.exp)
    || !Number.isSafeInteger(decoded.auth_gen) || !Number.isSafeInteger(decoded.pwd_iat)) return false;
  const user = repository.user(decoded.userId);
  if (!user || decoded.auth_gen !== user.authorization_generation || decoded.pwd_iat < user.password_changed_at) return false;
  attach(req, user, 'session', () => repository.current(user.id, user.authorization_generation, user.password_changed_at));
  return true;
}

function authenticateDevice(req: AuthRequest, secret: string, repository: AgentReviewReadonlyAuthRepository): boolean {
  const resolved = deviceAccountSessionsDb.resolve(secret); if (!resolved?.wallet.activeSlotId) return false;
  const user = repository.user(resolved.principal.userId); if (!user) return false;
  const principal = Object.freeze({ ...resolved.principal }); req.devicePrincipal = principal;
  req.user = { ...user, authenticationKind: 'device_session', authorizationGeneration: principal.authorizationGeneration,
    deviceSessionId: principal.deviceSessionId, slotId: principal.slotId, deviceGeneration: principal.generation };
  req.authenticatedPrincipal = Object.freeze({ kind: 'device_session', userId: principal.userId,
    authorizationGeneration: principal.authorizationGeneration, deviceSessionId: principal.deviceSessionId,
    slotId: principal.slotId, deviceGeneration: principal.generation });
  req.assertCurrentIdentity = () => deviceAccountSessionsDb.isPrincipalCurrent(principal);
  return true;
}

/**
 * Dormant C4-only readonly authentication + ledger/router composition, after the installation API_KEY gate.
 * The caller supplies the already-resolved secret. No refresh, audit, CK last_used or secret bootstrap occurs here.
 * The request-boundary factory supplies parsing and IP limits; application mounting is separately admitted.
 */
export function createAgentReviewAuthComposition(options: Options): express.Router {
  if (typeof options.jwtSecret !== 'string' || options.jwtSecret.length < 32) throw new Error('c4_preloaded_secret_required');
  const { db, jwtSecret, deviceEnabled, accessSeams } = options;
  const repository = new AgentReviewReadonlyAuthRepository(db);
  const authority = new AgentReviewHttpAuthority(db, accessSeams);
  const router = express.Router(); const endpoints = createAgentReviewRouter(db, accessSeams, true);
  router.use((request, res, next) => {
    const match = matchC4ReviewRequest(request); if (!match) { next(); return; }
    const req = request as AuthRequest;
    try {
      if (getConnection() !== db) { reject(res, 503, 'review_unavailable'); return; }
      const credential = carriers(req); if (!credential) { reject(res, 400, 'ambiguous_authentication'); return; }
      const valid = credential.bearer ? authenticateBearer(req, credential.bearer, repository, jwtSecret)
        : !!(credential.device && deviceEnabled && authenticateDevice(req, credential.device, repository));
      if (!valid) { reject(res); return; }
      if (req.devicePrincipal && !enforceCookieMutationGuard(req, res, jwtSecret)) return;
      const captured = authority.capture(req, match.sessionId, req.method === 'GET' ? 'read' : 'write');
      const capturedIdentity = req.assertCurrentIdentity;
      enrollC4ReviewResponse(req, res, { db, principal: req.authenticatedPrincipal,
        currentIdentity: () => getConnection() === db && capturedIdentity() === true,
        currentProject: () => captured.assertCurrent() === true });
      options.userRateLimit(req, res, () => {
        // Existing router paths are relative to /api/providers; preserve originalUrl for CSRF and matching.
        const url = req.url; req.url = req.url.slice('/api/providers'.length);
        endpoints(req, res, error => {
          req.url = url;
          if (error) reject(res, 503, 'review_unavailable');
          else if (!res.headersSent) reject(res, 404, 'review_not_found');
        });
      });
    } catch { if (!res.headersSent) reject(res); }
  });
  return router;
}
