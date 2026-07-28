import type { IncomingMessage } from 'node:http';

import jwt from 'jsonwebtoken';
import type { VerifyClientCallbackSync } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

/**
 * Cross-boundary collaborators are INJECTED, never imported across the module
 * boundary (eslint-plugin-boundaries). The composition root (server/index.js)
 * wires the concrete middleware/util implementations here:
 *
 *  - `jwtSecret`     — the same secret the REST verifier uses, supplied so the
 *                      LOCAL rejection classifier can verify the token's
 *                      signature/expiry. Never used to mint or trust a token;
 *                      authentication itself stays in `authenticateWebSocket`.
 *  - `recordRejection` — the shared auth_rejected recorder (noise policy lives
 *                      in middleware/auth-rejection-audit).
 *  - `clientIp`      — the loopback-guarded client IP resolver (ADR-040).
 */
type AuthRejectionRecord = {
  reason: string;
  transport: 'rest' | 'ws';
  userId?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  unverified?: boolean;
};

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  authenticateWebSocket: (token: string | null) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null;
  jwtSecret: string;
  recordRejection: (record: AuthRejectionRecord) => void;
  clientIp: (req: IncomingMessage | null | undefined) => string | null;
};

/**
 * Classifies why a websocket token failed, mirroring the REST authenticateToken
 * policy (T-182). LOCAL to this verifier so authenticateWebSocket's exported
 * signature is unchanged (architect decision). Returns the normalized reason and
 * the claimed userId from an UNVERIFIED decode (diagnostic only — never trusted).
 *
 * SECURITY: only the numeric userId is taken from the unverified decode; the
 * token is never logged and no username/role is read from it.
 */
function classifyWsRejection(
  token: string | null,
  jwtSecret: string
): {
  reason: string;
  userId: number | null;
} {
  if (!token) {
    return { reason: 'no_token', userId: null };
  }

  // Recover the claimed userId without trusting it (diagnostic correlation only).
  let unverifiedUserId: number | null = null;
  try {
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === 'object' && typeof decoded.userId === 'number') {
      unverifiedUserId = decoded.userId;
    }
  } catch {
    unverifiedUserId = null;
  }

  try {
    // SEC-JWT-ALG: pin HS256, mirroring middleware/auth.js. Without it, verify
    // trusts the algorithm declared in the token header. This classifier only
    // labels a rejection, but an unpinned verify here could label a forged token
    // 'user_missing' instead of 'bad_signature' and mislead the audit trail.
    jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    // Signature/expiry valid but authenticateWebSocket still returned null →
    // the user no longer exists / is disabled (matches REST user_missing).
    return { reason: 'user_missing', userId: unverifiedUserId };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TokenExpiredError') {
      return { reason: 'expired', userId: unverifiedUserId };
    }
    if (name === 'JsonWebTokenError') {
      return { reason: 'bad_signature', userId: unverifiedUserId };
    }
    return { reason: 'verify_error', userId: unverifiedUserId };
  }
}

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradeUrl = new URL(request.url ?? '/', 'http://localhost');
  const loggedUrl = new URL(upgradeUrl);
  if (loggedUrl.searchParams.has('token')) {
    loggedUrl.searchParams.set('token', 'REDACTED');
  }

  console.log('WebSocket connection attempt to:', `${loggedUrl.pathname}${loggedUrl.search}`);

  // Platform mode: use the first DB user and skip token checks.
  if (dependencies.isPlatform) {
    const user = dependencies.authenticateWebSocket(null);
    if (!user) {
      console.log('[WARN] Platform mode: No user found in database');
      return false;
    }

    request.user = user;
    console.log('[OK] Platform mode WebSocket authenticated for user:', user.username);
    return true;
  }

  // OSS mode: read JWT from query string first, then Authorization header.
  const token =
    upgradeUrl.searchParams.get('token') ??
    request.headers.authorization?.split(' ')[1] ??
    null;

  const user = dependencies.authenticateWebSocket(token);
  if (!user) {
    console.log('[WARN] WebSocket authentication failed');
    // Audit the rejection on the WS upgrade path with the same noise policy as
    // REST (no_token/expired aggregated; rare reasons recorded immediately).
    // IP from clientIp on the upgrade request (loopback guard on remoteAddress).
    const { reason, userId } = classifyWsRejection(token, dependencies.jwtSecret);
    dependencies.recordRejection({
      reason,
      transport: 'ws',
      userId,
      ipAddress: dependencies.clientIp(request),
      userAgent: request.headers['user-agent'] ?? null,
      unverified: true,
    });
    return false;
  }

  request.user = user;
  console.log('[OK] WebSocket authenticated for user:', user.username);
  return true;
}
