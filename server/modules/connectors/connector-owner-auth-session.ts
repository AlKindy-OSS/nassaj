import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type express from 'express';

import { RECENT_AUTH_MAX_AGE_MS } from './connector-auth-security.js';
import {
  connectorCsrfCookieNameFor,
  connectorRecentAuthCookieNameFor,
  connectorRecentAuthCookieValue,
} from './connector-owner-operation-gate.js';

export type AuthMethod = 'password' | 'webauthn' | 'oidc';

/** Outcome of minting a recent-auth session: 'ok' only when both cookies were set. */
export type ConnectorOwnerAuthenticationResult = 'ok' | 'unavailable';

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

type CookiePlan = Readonly<{
  recentName: string;
  csrfName: string;
  recent: Readonly<{ httpOnly: true; sameSite: 'strict'; secure: boolean; path: '/' }>;
  csrf: Readonly<{ httpOnly: false; sameSite: 'strict'; secure: boolean; path: '/api/connectors' }>;
}>;

/** Every cookie attribute derived from the live origin, or null when none is configured. */
const cookiePlan = (origin: string | null): CookiePlan | null => {
  const recentName = connectorRecentAuthCookieNameFor(origin);
  const csrfName = connectorCsrfCookieNameFor(origin);
  if (!origin || !recentName || !csrfName) return null;
  const secure = new URL(origin).protocol === 'https:';
  return Object.freeze({
    recentName,
    csrfName,
    recent: Object.freeze({ httpOnly: true as const, sameSite: 'strict' as const, secure, path: '/' as const }),
    csrf: Object.freeze({ httpOnly: false as const, sameSite: 'strict' as const, secure,
      path: '/api/connectors' as const }),
  });
};

const assertToken = (token: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('connector_owner_session_token_invalid');
  return token;
};

const clearCookies = (res: CookieResponse, plan: CookiePlan | null): void => {
  if (!plan) return;
  res.clearCookie(plan.recentName, plan.recent);
  res.clearCookie(plan.csrfName, plan.csrf);
};

const safeOrigin = (resolveOrigin: () => string | null): string | null => {
  try { return resolveOrigin() ?? null; } catch { return null; }
};

/**
 * Live recent-auth origin source (T-1939 6B): the persisted installation
 * origin; the environment proposal ONLY when no origin is persisted (the
 * pre-origin bootstrap); null (fail closed) when the persisted origin cannot
 * be read. A throw — e.g. connector_origin_database_tampered — must never
 * fall back to the environment value.
 */
export const createRecentAuthOriginSource = (deps: Readonly<{
  readPersisted: () => string | null;
  readProposal: () => string | null;
}>) => (): string | null => {
  let persisted: string | null;
  try { persisted = deps.readPersisted() ?? null; } catch { return null; }
  if (persisted !== null) return persisted;
  return safeOrigin(deps.readProposal);
};

/**
 * Creates the narrow adapter used only after a verified login or step-up.
 * `resolveOrigin` is read per call, so an origin set after boot takes effect
 * without a restart; with no origin nothing is written and nothing is set.
 */
export const createConnectorOwnerAuthSessionAdapter = (deps: Readonly<{
  repository: SessionWriter;
  installationId: string;
  resolveOrigin: () => string | null;
  executeWrite?: (effect: () => void) => boolean;
  now?: () => number;
  randomToken?: () => string;
  randomCsrfToken?: () => string;
  sessionId?: () => string;
}>) => ({
  resolveOrigin: (): string | null => safeOrigin(deps.resolveOrigin),

  record(res: CookieResponse, userId: number, authMethod: AuthMethod): void {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('connector_owner_session_invalid');
    // Cookie attributes first: an unconfigured origin must not leave a
    // session row behind that no browser can ever present.
    const plan = cookiePlan(safeOrigin(deps.resolveOrigin));
    if (!plan) throw new Error('connector_owner_session_origin_unavailable');
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
    res.cookie(plan.recentName, token, { ...plan.recent, maxAge: RECENT_AUTH_MAX_AGE_MS });
    res.cookie(plan.csrfName, csrfToken, { ...plan.csrf, maxAge: RECENT_AUTH_MAX_AGE_MS });
  },

  revoke(req: express.Request, res: CookieResponse, userId: number): boolean {
    const plan = cookiePlan(safeOrigin(deps.resolveOrigin));
    const token = plan ? connectorRecentAuthCookieValue(req, safeOrigin(deps.resolveOrigin)) : null;
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
    clearCookies(res, plan);
    return revoked;
  },
});

let productionAdapter: ReturnType<typeof createConnectorOwnerAuthSessionAdapter> | null = null;

/**
 * Installed once, synchronously, by the connector substrate composition root
 * at boot. It is the only configure point (a second writer would race it).
 */
export const configureConnectorOwnerAuthSessionProduction = (deps: Readonly<{
  repository: SessionWriter; installationId: string; resolveOrigin: () => string | null;
  executeWrite: (effect: () => void) => boolean;
}>): void => {
  productionAdapter = createConnectorOwnerAuthSessionAdapter(deps);
};

/** True once the substrate composition installed the adapter (it can mint sessions). */
export const connectorOwnerSessionAvailable = (): boolean => productionAdapter !== null;

/** Live origin the recent-auth cookies are issued for, or null when unconfigured. */
export const connectorOwnerSessionOrigin = (): string | null => productionAdapter?.resolveOrigin() ?? null;

/**
 * Records verifier-time auth_time and rotates every older session for this
 * user/install. Returns 'ok' only when the row was written AND both cookies
 * were set; every failure (no adapter, no origin, fence refused) is
 * 'unavailable' so callers never report a session that does not exist.
 */
export const recordConnectorOwnerAuthentication = (
  res: CookieResponse,
  userId: number,
  authMethod: AuthMethod,
): ConnectorOwnerAuthenticationResult => {
  if (!productionAdapter) return 'unavailable';
  try { productionAdapter.record(res, userId, authMethod); return 'ok'; }
  catch { return 'unavailable'; }
};

/** Revokes the exact presented recent-auth session, then clears both cookies. */
export const clearConnectorOwnerAuthentication = (
  req: express.Request,
  res: CookieResponse,
  userId: number,
): void => {
  if (!productionAdapter) return;
  try { productionAdapter.revoke(req, res, userId); } catch { /* main logout remains available */ }
};
