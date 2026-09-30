export const CONNECTOR_PUBLIC_ORIGIN_ENV = 'NASSAJ_PUBLIC_ORIGIN';
export const CONNECTOR_OAUTH_CALLBACK_PATH = '/connectors/oauth/callback';
/**
 * Single source of the connector recent-auth window (T-1939 6B): the session
 * row, both cookies, and every consumer gate use this one value.
 */
export const RECENT_AUTH_MAX_AGE_MS = 10 * 60 * 1_000;

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
