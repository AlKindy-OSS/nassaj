import { createHash, timingSafeEqual } from 'node:crypto';

import type express from 'express';

export const CONNECTOR_PUBLIC_ORIGIN_ENV = 'NASSAJ_PUBLIC_ORIGIN';
export const CONNECTOR_OAUTH_CALLBACK_PATH = '/connectors/oauth/callback';
export const RECENT_AUTH_MAX_AGE_MS = 5 * 60 * 1_000;

type TrustedEnvironment = Readonly<Record<string, string | undefined>>;

const loopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

/**
 * Reads the deployment origin from trusted process configuration only.
 * Request Host and forwarding headers are deliberately not accepted inputs.
 */
export const canonicalConnectorPublicOrigin = (
  env: TrustedEnvironment = process.env,
): string => {
  const raw = env[CONNECTOR_PUBLIC_ORIGIN_ENV]?.trim();
  if (!raw) throw new Error(`${CONNECTOR_PUBLIC_ORIGIN_ENV} is required`);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${CONNECTOR_PUBLIC_ORIGIN_ENV} must be an absolute URL`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${CONNECTOR_PUBLIC_ORIGIN_ENV} must contain only an origin`);
  }
  if (parsed.pathname !== '/' || !parsed.hostname) {
    throw new Error(`${CONNECTOR_PUBLIC_ORIGIN_ENV} must not contain a path`);
  }
  const developmentLoopback = env.NODE_ENV === 'development'
    && parsed.protocol === 'http:'
    && loopbackHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && !developmentLoopback) {
    throw new Error(`${CONNECTOR_PUBLIC_ORIGIN_ENV} must use HTTPS`);
  }
  return parsed.origin;
};

/** Fixed callback derived from the canonical trusted origin. */
export const connectorOAuthCallbackUrl = (
  env: TrustedEnvironment = process.env,
): string => `${canonicalConnectorPublicOrigin(env)}${CONNECTOR_OAUTH_CALLBACK_PATH}`;

export type ConnectorAuthBootstrapCapability = Readonly<{
  installationId: string;
  canonicalOrigin: string;
}>;

/** Validates an injected read-only bootstrap capability without persisting it. */
export const validateConnectorAuthBootstrapCapability = (
  candidate: unknown,
  env: TrustedEnvironment = process.env,
): ConnectorAuthBootstrapCapability | null => {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const raw = candidate as Record<string, unknown>;
  if (typeof raw.installationId !== 'string'
    || !/^[a-zA-Z0-9._-]{16,128}$/u.test(raw.installationId)
    || typeof raw.canonicalOrigin !== 'string') return null;
  try {
    const configuredOrigin = canonicalConnectorPublicOrigin(env);
    const injectedOrigin = canonicalConnectorPublicOrigin({
      ...env,
      [CONNECTOR_PUBLIC_ORIGIN_ENV]: raw.canonicalOrigin,
    });
    if (injectedOrigin !== configuredOrigin || raw.canonicalOrigin !== injectedOrigin) return null;
    return Object.freeze({ installationId: raw.installationId, canonicalOrigin: injectedOrigin });
  } catch {
    return null;
  }
};

export type RecentAuthSession = Readonly<{
  userId: number;
  /** Milliseconds since epoch, stamped by the server after password/WebAuthn. */
  authTime: number;
  authMethod: 'password' | 'webauthn';
  csrfTokenHash: string;
  cookieSameSite: 'strict';
}>;

export type RecentAuthSessionReader = (
  req: express.Request,
) => RecentAuthSession | null | Promise<RecentAuthSession | null>;

type AuthedRequest = express.Request & {
  user?: { id?: number; userId?: number; role?: string; iat?: number; auth_time?: number };
};

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

const validCsrf = (rawToken: unknown, expectedHex: string): boolean => {
  if (typeof rawToken !== 'string'
    || rawToken.length < 32
    || rawToken.length > 512
    || !/^[a-f0-9]{64}$/iu.test(expectedHex)) return false;
  const actual = sha256(rawToken);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/**
 * Owner-only step-up gate for future connector-app writes. It trusts only the
 * injected server-side session reader; JWT `iat`/`auth_time` claims are ignored.
 */
export const createRequireRecentConnectorOwner = (
  readSession: RecentAuthSessionReader | undefined,
  options: Readonly<{
    env?: TrustedEnvironment;
    now?: () => number;
  }> = {},
): express.RequestHandler => {
  if (typeof readSession !== 'function') {
    throw new Error('Connector recent-auth server-session adapter is unavailable');
  }
  return async (req, res, next) => {
    const user = (req as AuthedRequest).user;
    if (user?.role !== 'owner') {
      res.status(403).json({ error: 'Owner permission required.', code: 'CONNECTOR_OWNER_REQUIRED' });
      return;
    }

    let origin: string;
    try {
      origin = canonicalConnectorPublicOrigin(options.env);
    } catch {
      res.status(503).json({ error: 'Connector authentication is not configured.', code: 'CONNECTOR_AUTH_NOT_CONFIGURED' });
      return;
    }
    if (req.get('origin') !== origin) {
      res.status(403).json({ error: 'Request origin was rejected.', code: 'CONNECTOR_ORIGIN_REJECTED' });
      return;
    }

    let session: RecentAuthSession | null;
    try {
      session = await readSession(req);
    } catch {
      res.status(503).json({ error: 'Recent authentication is unavailable.', code: 'CONNECTOR_RECENT_AUTH_UNAVAILABLE' });
      return;
    }
    const userId = user.id ?? user.userId;
    const now = options.now?.() ?? Date.now();
    const recent = session !== null
      && Number.isSafeInteger(userId)
      && session.userId === userId
      && session.cookieSameSite === 'strict'
      && (session.authMethod === 'password' || session.authMethod === 'webauthn')
      && Number.isFinite(session.authTime)
      && session.authTime <= now
      && now - session.authTime <= RECENT_AUTH_MAX_AGE_MS
      && validCsrf(req.get('x-csrf-token'), session.csrfTokenHash);
    if (!recent) {
      res.status(403).json({ error: 'Recent authentication required.', code: 'CONNECTOR_RECENT_AUTH_REQUIRED' });
      return;
    }
    next();
  };
};
