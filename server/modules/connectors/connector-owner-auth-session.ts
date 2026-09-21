import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type express from 'express';

import { isProviderAuthRegistryEnabled } from '../../../shared/connector-auth-registry.js';

import { RECENT_AUTH_MAX_AGE_MS } from './connector-auth-security.js';
import {
  connectorCsrfCookieName,
  connectorRecentAuthCookieName,
  connectorRecentAuthCookieValue,
} from './connector-owner-operation-gate.js';

type AuthMethod = 'password' | 'webauthn';

type SessionWriter = Readonly<{
  recordOwnerAuthSession(input: Readonly<{
    sessionId: string; installationId: string; sessionTokenHash: string; csrfTokenHash: string;
    userId: number; authMethod: AuthMethod; authTimeMs: number; expiresAtMs: number;
  }>): void;
  revokeOwnerAuthSession(input: Readonly<{
    sessionTokenHash: string; installationId: string; userId: number; nowMs: number;
  }>): boolean;
  revokeOwnerAuthSessions(input: Readonly<{
    installationId: string; userId: number; nowMs: number;
  }>): number;
}>;

type CookieResponse = Pick<express.Response, 'cookie' | 'clearCookie'>;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const cookieOptions = (origin: string, httpOnly: boolean, path: string) => Object.freeze({
  httpOnly,
  sameSite: 'strict' as const,
  secure: new URL(origin).protocol === 'https:',
  path,
});

const recentCookieOptions = (origin: string) => cookieOptions(origin, true, '/');
const csrfCookieOptions = (origin: string) => cookieOptions(origin, false, '/api/connectors');

const assertToken = (token: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('connector_owner_session_token_invalid');
  return token;
};

const clearCookies = (res: CookieResponse, origin: string): void => {
  res.clearCookie(connectorRecentAuthCookieName, recentCookieOptions(origin));
  res.clearCookie(connectorCsrfCookieName, csrfCookieOptions(origin));
};

/** Creates the narrow adapter used only after a verified login. */
export const createConnectorOwnerAuthSessionAdapter = (deps: Readonly<{
  repository: SessionWriter;
  installationId: string;
  canonicalOrigin: string;
  executeWrite?: (effect: () => void) => boolean;
  now?: () => number;
  randomToken?: () => string;
  randomCsrfToken?: () => string;
  sessionId?: () => string;
}>) => ({
  record(res: CookieResponse, userId: number, authMethod: AuthMethod): void {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('connector_owner_session_invalid');
    const authTimeMs = deps.now?.() ?? Date.now();
    const token = assertToken(deps.randomToken?.() ?? randomBytes(32).toString('hex'));
    const csrfToken = assertToken(deps.randomCsrfToken?.() ?? randomBytes(32).toString('hex'));
    const executed = (deps.executeWrite ?? (effect => { effect(); return true; }))(() => {
      deps.repository.revokeOwnerAuthSessions({
        installationId: deps.installationId, userId, nowMs: authTimeMs,
      });
      deps.repository.recordOwnerAuthSession({
        sessionId: deps.sessionId?.() ?? randomUUID(),
        installationId: deps.installationId,
        sessionTokenHash: sha256(token),
        csrfTokenHash: sha256(csrfToken),
        userId,
        authMethod,
        authTimeMs,
        expiresAtMs: authTimeMs + RECENT_AUTH_MAX_AGE_MS,
      });
    });
    if (!executed) throw new Error('connector_owner_session_write_fence_unavailable');
    res.cookie(connectorRecentAuthCookieName, token, {
      ...recentCookieOptions(deps.canonicalOrigin), maxAge: RECENT_AUTH_MAX_AGE_MS,
    });
    res.cookie(connectorCsrfCookieName, csrfToken, {
      ...csrfCookieOptions(deps.canonicalOrigin), maxAge: RECENT_AUTH_MAX_AGE_MS,
    });
  },

  revoke(req: express.Request, res: CookieResponse, userId: number): boolean {
    const token = connectorRecentAuthCookieValue(req);
    let revoked = false;
    if (token !== null && Number.isSafeInteger(userId) && userId > 0) {
      const executed = (deps.executeWrite ?? (effect => { effect(); return true; }))(() => {
        revoked = deps.repository.revokeOwnerAuthSession({
          sessionTokenHash: sha256(token), installationId: deps.installationId,
          userId, nowMs: deps.now?.() ?? Date.now(),
        });
      });
      if (!executed) throw new Error('connector_owner_session_write_fence_unavailable');
    }
    clearCookies(res, deps.canonicalOrigin);
    return revoked;
  },
});

let productionAdapter: ReturnType<typeof createConnectorOwnerAuthSessionAdapter> | null = null;

/** Installed synchronously by the connector production composition root at boot. */
export const configureConnectorOwnerAuthSessionProduction = (deps: Readonly<{
  repository: SessionWriter; installationId: string; canonicalOrigin: string;
  executeWrite: (effect: () => void) => boolean;
}>): void => {
  productionAdapter = createConnectorOwnerAuthSessionAdapter(deps);
};

const production = () => {
  if (!productionAdapter) throw new Error('connector_owner_session_adapter_unavailable');
  return productionAdapter;
};

/** Records verifier-time auth_time and rotates every older session for this owner/install. */
export const recordConnectorOwnerAuthentication = (
  res: CookieResponse,
  userId: number,
  authMethod: AuthMethod,
): boolean => {
  if (!productionAdapter && !isProviderAuthRegistryEnabled(process.env)) return false;
  try { production().record(res, userId, authMethod); return true; }
  catch { return false; }
};

/** Revokes the exact presented recent-auth session, then clears both cookies. */
export const clearConnectorOwnerAuthentication = (
  req: express.Request,
  res: CookieResponse,
  userId: number,
): void => {
  if (!productionAdapter && !isProviderAuthRegistryEnabled(process.env)) return;
  try { production().revoke(req, res, userId); } catch { /* main logout remains available */ }
};
