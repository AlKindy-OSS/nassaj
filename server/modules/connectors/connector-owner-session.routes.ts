/**
 * Connector recent-auth step-up (T-1939 slice 6B).
 *
 *   POST /api/connectors/owner-session/step-up   { stepUp: <evidence> } → 204
 *
 * Any active, authenticated member may mint a ten-minute recent-auth session
 * here; which operations it unlocks (owner-only vs member) stays with the
 * per-operation gates. Evidence is verified by the shared step-up verifier
 * under the `connector_owner` audience:
 *   { method: 'password', password } | { method: 'passkey', response }
 *   | { method: 'oidc_grant', grant }   (SSO-linked members; see routes/oidc.js)
 *
 * Order: session adapter installed (else 503 CONNECTOR_RECENT_AUTH_UNAVAILABLE)
 * → live origin configured (else 503 …_ORIGIN_UNCONFIGURED) → exact Origin
 * (else 403) → evidence → session row + both cookies. 204 is returned only
 * when both cookies were actually set; otherwise 503, never a session that
 * does not exist. Audit rows carry ids and the evidence method only; a
 * repeated verifier rate-limit refusal is audited once per window.
 */

import express from 'express';

import type { AuthMethod, ConnectorOwnerAuthenticationResult } from './connector-owner-auth-session.js';

type StepUpVerdict = Readonly<{ authMethod: AuthMethod; authTimeMs: number }>;
type CookieResponse = Pick<express.Response, 'cookie' | 'clearCookie'>;

/** The verifier's client-safe refusal (services/step-up.service.js StepUpError). */
export type StepUpRefusal = Readonly<{
  code: string; status: number; message: string; reason?: string; retryAfterSeconds?: number;
}>;

export type ConnectorOwnerSessionDependencies = Readonly<{
  resolveOrigin: () => string | null;
  verifyEvidence: (req: express.Request, user: { id: number }, audience: 'connector_owner',
    evidence: unknown) => Promise<StepUpVerdict>;
  record: (res: CookieResponse, userId: number, authMethod: AuthMethod) => ConnectorOwnerAuthenticationResult;
  audit: (event: 'connector_step_up_success' | 'connector_step_up_failure', data: Readonly<{
    userId: number; metadata: Readonly<Record<string, string>>; ipAddress: string | null;
    userAgent: string | null;
  }>) => void;
  /** Narrows a thrown value to the verifier's refusal type (instanceof in production). */
  asStepUpRefusal: (error: unknown) => StepUpRefusal | null;
  /** Clears the OIDC browser-transaction cookie once a grant was presented. */
  clearOidcTransaction: (res: express.Response) => void;
  routeLimiter?: express.RequestHandler;
  /** False until the substrate installed the session adapter (default: available). */
  isAvailable?: () => boolean;
  /** True when a step_up_rate_limited refusal for this user should be audited now. */
  auditRateLimited?: (userId: number) => boolean;
  /** Operational log for an unexpected verifier failure; receives only the error name/code. */
  logVerifierError?: (detail: Readonly<{ name: string; code?: string }>) => void;
}>;

const EVIDENCE_METHODS = new Set(['password', 'passkey', 'oidc_grant']);

/** Evidence method for audit metadata only — never the evidence itself. */
const evidenceMethod = (evidence: unknown): string => {
  const method = (evidence as { method?: unknown } | null)?.method;
  return typeof method === 'string' && EVIDENCE_METHODS.has(method) ? method : 'none';
};

const callerId = (req: express.Request): number | null => {
  const user = (req as express.Request & { user?: { id?: number; userId?: number } }).user;
  const id = user?.id ?? user?.userId;
  return Number.isSafeInteger(id) && Number(id) > 0 ? Number(id) : null;
};

const safeOrigin = (resolve: () => string | null): string | null => {
  try { return resolve() ?? null; } catch { return null; }
};

/** Name and string code of an unexpected error — never its message or any evidence. */
const errorShape = (error: unknown): { name: string; code?: string } => {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(code) ? { name, code } : { name };
};

const defaultLogVerifierError = (detail: Readonly<{ name: string; code?: string }>): void => {
  console.error('connector step-up verifier error', detail);
};

/** Builds the step-up router; production wiring is the default export. */
export const createConnectorOwnerSessionRoutes = (deps: ConnectorOwnerSessionDependencies): express.Router => {
  const routes = express.Router();
  const passThrough: express.RequestHandler = (_req, _res, next) => next();

  routes.post('/step-up', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (callerId(req) === null) {
      res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      return;
    }
    (deps.routeLimiter ?? passThrough)(req, res, next);
  }, async (req, res) => {
    const userId = callerId(req) as number;
    if (deps.isAvailable && !deps.isAvailable()) {
      res.status(503).json({ error: 'Recent authentication is unavailable.',
        code: 'CONNECTOR_RECENT_AUTH_UNAVAILABLE' });
      return;
    }
    const origin = safeOrigin(deps.resolveOrigin);
    if (origin === null) {
      res.status(503).json({ error: 'Connector origin is not configured.',
        code: 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED' });
      return;
    }
    if (req.get('origin') !== origin) {
      res.status(403).json({ error: 'Request origin was rejected.', code: 'CONNECTOR_ORIGIN_REJECTED' });
      return;
    }
    const evidence = (req.body as { stepUp?: unknown } | undefined)?.stepUp;
    const method = evidenceMethod(evidence);
    const context = { ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
    const fail = (reason: string) => deps.audit('connector_step_up_failure', {
      userId, metadata: { method, reason }, ...context });

    let verdict: StepUpVerdict;
    try {
      verdict = await deps.verifyEvidence(req, { id: userId }, 'connector_owner', evidence);
    } catch (error) {
      if (method === 'oidc_grant') deps.clearOidcTransaction(res);
      const refusal = deps.asStepUpRefusal(error);
      if (!refusal) {
        (deps.logVerifierError ?? defaultLogVerifierError)(errorShape(error));
        fail('verifier_error');
        res.status(500).json({ error: 'Verification failed.', code: 'step_up_unavailable' });
        return;
      }
      if (refusal.code !== 'step_up_rate_limited' || (deps.auditRateLimited?.(userId) ?? true)) {
        fail(refusal.reason ?? refusal.code);
      }
      if (refusal.retryAfterSeconds) res.set('Retry-After', String(refusal.retryAfterSeconds));
      res.status(refusal.status).json({ error: refusal.message, code: refusal.code });
      return;
    }
    // A presented grant is single use; the transaction cookie is not reused.
    if (method === 'oidc_grant') deps.clearOidcTransaction(res);

    if (deps.record(res, userId, verdict.authMethod) !== 'ok') {
      fail('session_unavailable');
      res.status(503).json({ error: 'Recent authentication is unavailable.',
        code: 'CONNECTOR_RECENT_AUTH_UNAVAILABLE' });
      return;
    }
    deps.audit('connector_step_up_success', { userId, metadata: { method }, ...context });
    res.status(204).end();
  });
  return routes;
};
