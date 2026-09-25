import type { Database } from 'better-sqlite3';
import type { Request, Response } from 'express';

import { createReviewTransactionInvocation, readReviewEffectOutcome, type ReviewTransactionInvocation,
  assertReviewSession, assertReviewToken } from '../database/index.js';

type Captured = Readonly<{ userId: number }>;
type Enrollment = { db: Database; request: Request; response: Response; principal: Captured; method: 'GET' | 'PATCH';
  invocation: ReviewTransactionInvocation; currentIdentity: () => boolean; currentProject: () => boolean; sendDenial: (code: FenceCode) => void };
type FenceCode = 'identity_changed' | 'project_access_changed';
const enrolled = new WeakMap<Request, WeakMap<Response, Enrollment>>();

/** One canonical matcher for the eventual pre-parser and authenticated C4 composition; no OPTIONS interception. */
export function matchC4ReviewRequest(req: Pick<Request, 'method' | 'originalUrl'>): { sessionId: string; agentId?: string } | null {
  const route = req.originalUrl.split('?', 1)[0];
  const match = /^\/api\/providers\/sessions\/([^/]+)\/agent-reviews(?:\/([^/]+))?$/.exec(route);
  if (!match || !((req.method === 'GET' && !match[2]) || (req.method === 'PATCH' && match[2]))) return null;
  try {
    const sessionId = decodeURIComponent(match[1]); assertReviewSession(sessionId);
    if (encodeURIComponent(sessionId) !== match[1]) return null;
    if (!match[2]) return { sessionId };
    const agentId = decodeURIComponent(match[2]); assertReviewToken(agentId, 'agent');
    return encodeURIComponent(agentId) === match[2] ? { sessionId, agentId } : null;
  } catch { return null; }
}

function currentIdentity(entry: Enrollment): boolean {
  try {
    return (entry.request as Request & { authenticatedPrincipal?: unknown }).authenticatedPrincipal === entry.principal
      && entry.currentIdentity() === true;
  } catch { return false; }
}

function currentProject(entry: Enrollment): boolean {
  try { return entry.currentProject() === true; } catch { return false; }
}

/** Production C4 auth composition only; no request fields or response payloads can enroll themselves. */
export function enrollC4ReviewResponse(req: Request, res: Response, authority: {
  db: Database; principal: Captured; currentIdentity: () => boolean; currentProject: () => boolean;
}): void {
  if (req.res !== res || res.req !== req || !matchC4ReviewRequest(req) || enrolled.get(req)?.has(res)) throw new Error('c4_enrollment_invalid');
  const method = req.method as 'GET' | 'PATCH';
  const binding = { db: authority.db, request: req, response: res, principal: authority.principal, method };
  const invocation = createReviewTransactionInvocation(binding);
  const originalJson = res.json; const originalSend = res.send;
  let serializerScope: { bytes: string } | null = null;
  const entry: Enrollment = { ...binding, invocation, currentIdentity: authority.currentIdentity,
    currentProject: authority.currentProject, sendDenial: requestedCode => {
      if (res.headersSent) { res.destroy(); return; }
      const code: FenceCode = currentIdentity(entry) ? requestedCode : 'identity_changed';
      const outcome = readReviewEffectOutcome(invocation, binding);
      const bytes = JSON.stringify({ error: { code, notStarted: outcome.notStarted, effectState: outcome.effectState } });
      const scope = { bytes }; serializerScope = scope;
      try {
        res.status(409).set('Cache-Control', 'no-store').type('application/json'); res.removeHeader('Content-Length');
        if (serializerScope === scope && serializerScope.bytes === bytes) originalSend.call(res, bytes);
      } finally { serializerScope = null; }
    } };
  const replies = enrolled.get(req) ?? new WeakMap<Response, Enrollment>(); replies.set(res, entry); enrolled.set(req, replies);
  const mayDisclose = (): boolean => {
    if (!currentIdentity(entry)) { entry.sendDenial('identity_changed'); return false; }
    if (!currentProject(entry)) { entry.sendDenial('project_access_changed'); return false; }
    return true;
  };
  res.json = function (body) { if (mayDisclose()) return originalJson.call(this, body); return this; };
  res.send = function (body) { if (mayDisclose()) return originalSend.call(this, body); return this; };
}

/** C4 service obtains only this enrolled request/response's opaque invocation, never a caller-supplied tag. */
export function c4ReviewInvocation(req: Request, res: Response): ReviewTransactionInvocation {
  const entry = enrolled.get(req)?.get(res);
  if (!entry) throw new Error('c4_enrollment_required');
  return entry.invocation;
}

/** Request a fixed auth-owned fence denial. Caller supplies no body, effect claim or bypass state. */
export function denyC4ReviewResponse(req: Request, res: Response, code: FenceCode): void {
  const entry = enrolled.get(req)?.get(res);
  if (!entry || (code !== 'identity_changed' && code !== 'project_access_changed')) throw new Error('c4_enrollment_required');
  entry.sendDenial(code);
}
