import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type express from 'express';

import { executeConnectorPolicyV2SynchronousWrite } from './connector-substrate-only.production.js';

export type ConnectorOwnerOperation =
  | 'upsert_byo'
  | 'register_dcr'
  | 'upsert_shared_api_key'
  | 'disable'
  | 'upsert_personal_api_key'
  | 'revoke_personal_grant'
  | 'oauth_start'
  | 'oauth_refresh'
  | 'oauth_revoke';

const AUTHORIZED = Symbol('authorized-connector-owner-operation');
/** Plain-HTTP (loopback development) name; never accepted under an https origin. */
const LEGACY_COOKIE_NAME = 'nassaj_connector_recent_auth';
/** HTTPS name: the __Host- prefix forbids Domain, forces Secure and Path=/. */
const HOST_COOKIE_NAME = '__Host-nassaj_connector_recent_auth';
/** Plain-HTTP (loopback development) CSRF cookie name. */
const LEGACY_CSRF_COOKIE_NAME = 'nassaj_connector_csrf';
/** HTTPS CSRF cookie name: __Secure- keeps a non-Secure sibling from planting a duplicate. */
const SECURE_CSRF_COOKIE_NAME = '__Secure-nassaj_connector_csrf';
const OPERATION_TTL_MS = 30_000;

type OperationRepository = Readonly<{
  readOwnerAuthSession(input: Readonly<{
    sessionTokenHash: string; installationId: string; userId: number; nowMs: number;
  }>): Readonly<{ sessionId: string; csrfTokenHash: string; authTime: number; expiresAt: number }> | null;
  issueOwnerOperation(input: Readonly<{
    sessionId: string; requestId: string; nonceHash: string;
    installationId: string; userId: number; operation: ConnectorOwnerOperation;
    nowMs: number; ttlMs: number;
  }>): Readonly<{ sessionId: string; authTime: number; expiresAt: number }> | null;
  consumeOwnerOperation(input: Readonly<{
    nonceHash: string; requestId: string; sessionId: string; installationId: string;
    userId: number; operation: ConnectorOwnerOperation; nowMs: number;
  }>): boolean;
}>;

type OperationConsumerRepository = Pick<OperationRepository, 'consumeOwnerOperation'>;

export type AuthorizedOwnerOperation = Readonly<{
  requestId: string;
  sessionId: string;
  installationId: string;
  userId: number;
  operation: ConnectorOwnerOperation;
  expiresAt: number;
  nonce: string;
  [AUTHORIZED]: true;
}>;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Reads one 64-hex cookie. A name that appears more than once is ambiguous
 * (e.g. a sibling-subdomain cookie shadowing ours), so it resolves to null.
 */
const cookieValue = (req: express.Request, cookieName: string | null): string | null => {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || cookieName === null) return null;
  let found: string | null = null;
  let seen = 0;
  for (const pair of raw.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name !== cookieName) continue;
    seen += 1;
    found = rest.join('=');
  }
  return seen === 1 && found !== null && /^[a-f0-9]{64}$/u.test(found) ? found : null;
};

/**
 * Recent-auth cookie name for the installation origin: `__Host-` under https,
 * the legacy name only for plain-http loopback development, null when no
 * origin is configured (nothing can be read or set).
 */
export const connectorRecentAuthCookieNameFor = (origin: string | null): string | null => {
  if (!origin) return null;
  try {
    return new URL(origin).protocol === 'https:' ? HOST_COOKIE_NAME : LEGACY_COOKIE_NAME;
  } catch {
    return null;
  }
};

/** CSRF double-submit cookie name for the origin, with the same scheme rule as the recent-auth cookie. */
export const connectorCsrfCookieNameFor = (origin: string | null): string | null => {
  const recentName = connectorRecentAuthCookieNameFor(origin);
  if (recentName === null) return null;
  return recentName === HOST_COOKIE_NAME ? SECURE_CSRF_COOKIE_NAME : LEGACY_CSRF_COOKIE_NAME;
};

/** Live origin source for a gate: a fixed string (tests) or a per-request resolver. */
export type ConnectorOriginSource = string | (() => string | null);

const resolveOriginSource = (source: ConnectorOriginSource): string | null => {
  if (typeof source === 'string') return source || null;
  try { return source() ?? null; } catch { return null; }
};

/**
 * Origin source for a composed connector runtime: its live resolver when the
 * production composition wired one (read per request, so PUT /origin applies
 * without a restart), else the fixed origin a test runtime carries.
 */
export const runtimeOriginSource = (runtime: Readonly<{
  canonicalOrigin: string; resolveOrigin?: () => string | null;
}>): ConnectorOriginSource => runtime.resolveOrigin ?? runtime.canonicalOrigin;

const originUnconfigured = (res: express.Response): void => {
  res.status(503).json({ error: 'Connector origin is not configured.',
    code: 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED' });
};

const hashesMatch = (rawToken: string, expectedHash: string): boolean => {
  if (!/^[a-f0-9]{64}$/u.test(rawToken) || !/^[a-f0-9]{64}$/u.test(expectedHash)) return false;
  const actual = Buffer.from(sha256(rawToken), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const capability = (input: Omit<AuthorizedOwnerOperation, typeof AUTHORIZED>): AuthorizedOwnerOperation => {
  const value = { ...input } as AuthorizedOwnerOperation;
  Object.defineProperty(value, AUTHORIZED, { value: true, enumerable: false });
  return Object.freeze(value);
};

type AuthedRequest = express.Request & { user?: { id?: number; userId?: number; role?: string } };

const ownerIdentity = (req: express.Request): number | null => {
  const user = (req as AuthedRequest).user;
  const userId = user?.id ?? user?.userId;
  return user?.role === 'owner' && Number.isSafeInteger(userId) && Number(userId) > 0
    ? Number(userId) : null;
};

const authenticatedIdentity = (req: express.Request): number | null => {
  const user = (req as AuthedRequest).user;
  const userId = user?.id ?? user?.userId;
  return Number.isSafeInteger(userId) && Number(userId) > 0 ? Number(userId) : null;
};

const recentSession = (
  req: express.Request,
  repository: Pick<OperationRepository, 'readOwnerAuthSession'>,
  installationId: string,
  nowMs: number,
  origin: string | null,
  resolvedUserId?: number | null,
) => {
  const userId = resolvedUserId === undefined ? ownerIdentity(req) : resolvedUserId;
  const token = cookieValue(req, connectorRecentAuthCookieNameFor(origin));
  if (userId === null || !token) return null;
  const session = repository.readOwnerAuthSession({
    sessionTokenHash: sha256(token), installationId, userId, nowMs,
  });
  return session ? { userId, session } : null;
};

/**
 * Resolves the public double-submit token only when both cookies still belong
 * to the caller's current server-side recent-auth session. Pure read.
 */
export const validatedConnectorCsrfToken = (
  req: express.Request,
  repository: Pick<OperationRepository, 'readOwnerAuthSession'>,
  installationId: string,
  userId: number,
  origin: string | null,
  nowMs = Date.now(),
): string | null => {
  const recent = recentSession(req, repository, installationId, nowMs, origin, userId);
  const csrfToken = cookieValue(req, connectorCsrfCookieNameFor(origin));
  return recent && csrfToken && hashesMatch(csrfToken, recent.session.csrfTokenHash)
    ? csrfToken
    : null;
};

/** Read-only owner gate. It performs no nonce issuance and does not require Origin. */
export const createConnectorOwnerReadGate = (deps: Readonly<{
  repository: Pick<OperationRepository, 'readOwnerAuthSession'>;
  installationId: string;
  canonicalOrigin: ConnectorOriginSource;
  now?: () => number;
}>): express.RequestHandler => (req, res, next) => {
  if (ownerIdentity(req) === null) {
    res.status(403).json({ error: 'Owner permission required.', code: 'CONNECTOR_OWNER_REQUIRED' });
    return;
  }
  const origin = resolveOriginSource(deps.canonicalOrigin);
  if (origin === null) {
    originUnconfigured(res);
    return;
  }
  if (!recentSession(req, deps.repository, deps.installationId, deps.now?.() ?? Date.now(), origin)) {
    res.status(403).json({ error: 'Recent authentication required.', code: 'CONNECTOR_RECENT_AUTH_REQUIRED' });
    return;
  }
  next();
};

/** Per-request gate: resolves the server session and issues one operation-bound nonce. */
export const createConnectorOwnerOperationGate = (deps: Readonly<{
  repository: OperationRepository;
  installationId: string;
  canonicalOrigin: ConnectorOriginSource;
  operation: ConnectorOwnerOperation;
  ownerOnly?: boolean;
  now?: () => number;
}>): express.RequestHandler => (req, res, next) => {
  const userId = deps.ownerOnly === false ? authenticatedIdentity(req) : ownerIdentity(req);
  if (userId === null) {
    res.status(403).json({ error: 'Owner permission required.', code: 'CONNECTOR_OWNER_REQUIRED' });
    return;
  }
  const origin = resolveOriginSource(deps.canonicalOrigin);
  if (origin === null) {
    originUnconfigured(res);
    return;
  }
  if (req.get('origin') !== origin) {
    res.status(403).json({ error: 'Request origin was rejected.', code: 'CONNECTOR_ORIGIN_REJECTED' });
    return;
  }
  const nowMs = deps.now?.() ?? Date.now();
  const recent = recentSession(req, deps.repository, deps.installationId, nowMs, origin, userId);
  if (!recent) {
    res.status(403).json({ error: 'Recent authentication required.', code: 'CONNECTOR_RECENT_AUTH_REQUIRED' });
    return;
  }
  const csrfToken = req.get('x-csrf-token');
  if (typeof csrfToken !== 'string' || !hashesMatch(csrfToken, recent.session.csrfTokenHash)) {
    res.status(403).json({ error: 'CSRF validation failed.', code: 'CONNECTOR_CSRF_REJECTED' });
    return;
  }
  const requestId = randomUUID();
  const nonce = randomBytes(32).toString('hex');
  const issued = executeConnectorPolicyV2SynchronousWrite(() => deps.repository.issueOwnerOperation({
    sessionId: recent.session.sessionId, requestId, nonceHash: sha256(nonce),
    installationId: deps.installationId, userId, operation: deps.operation,
    nowMs, ttlMs: OPERATION_TTL_MS,
  }));
  if (!issued) {
    res.status(403).json({ error: 'Recent authentication required.', code: 'CONNECTOR_RECENT_AUTH_REQUIRED' });
    return;
  }
  res.locals.authorizedConnectorOwnerOperation = capability({
    requestId, sessionId: issued.sessionId, installationId: deps.installationId,
    userId, operation: deps.operation, expiresAt: issued.expiresAt, nonce,
  });
  next();
};

/** Reads only middleware-minted opaque authority from response locals. */
export const authorizedOwnerOperation = (res: express.Response): AuthorizedOwnerOperation => {
  const value = res.locals.authorizedConnectorOwnerOperation as AuthorizedOwnerOperation | undefined;
  if (!value || value[AUTHORIZED] !== true) throw new Error('connector_owner_operation_missing');
  return value;
};

/** Single-use final gate called by the service immediately before its mutation. */
export const consumeAuthorizedOwnerOperation = (
  authority: AuthorizedOwnerOperation,
  expected: ConnectorOwnerOperation,
  deps: Readonly<{ repository: OperationConsumerRepository; installationId: string; now?: () => number }>,
): void => {
  const nowMs = deps.now?.() ?? Date.now();
  if (!authority || authority[AUTHORIZED] !== true || authority.operation !== expected
    || authority.installationId !== deps.installationId || nowMs >= authority.expiresAt) {
    throw new Error('connector_owner_operation_invalid');
  }
  const consumed = executeConnectorPolicyV2SynchronousWrite(() => deps.repository.consumeOwnerOperation({
    nonceHash: sha256(authority.nonce), requestId: authority.requestId,
    sessionId: authority.sessionId, installationId: authority.installationId,
    userId: authority.userId, operation: authority.operation, nowMs,
  }));
  if (!consumed) throw new Error('connector_owner_operation_invalid');
};

export const connectorLegacyRecentAuthCookieName = LEGACY_COOKIE_NAME;
export const connectorHostRecentAuthCookieName = HOST_COOKIE_NAME;
export const connectorLegacyCsrfCookieName = LEGACY_CSRF_COOKIE_NAME;
export const connectorSecureCsrfCookieName = SECURE_CSRF_COOKIE_NAME;
/** The caller's recent-auth token under the cookie name `origin` dictates. */
export const connectorRecentAuthCookieValue = (req: express.Request, origin: string | null): string | null =>
  cookieValue(req, connectorRecentAuthCookieNameFor(origin));
