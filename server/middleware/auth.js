import jwt from 'jsonwebtoken';

import { userDb, appConfigDb, auditLogDb } from '../modules/database/index.js';
import { IS_PLATFORM } from '../constants/config.js';
import { clientIp } from '../utils/client-ip.js';

import { recordAuthRejection } from './auth-rejection-audit.js';

/**
 * Best-effort UNVERIFIED decode of a JWT for diagnostics only (T-182). Used on
 * the rejection path to recover the claimed userId for correlation when the
 * token cannot be verified (expired/forged). SECURITY: the result is untrusted —
 * we take ONLY the numeric userId, never username/role, never the token itself,
 * and the caller flags it metadata.unverified=true. Returns null on any failure.
 */
function decodeUnverifiedUserId(token) {
  try {
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === 'object' && typeof decoded.userId === 'number') {
      return decoded.userId;
    }
    return null;
  } catch {
    return null;
  }
}

// JWT secret: prefer an explicit env var (recommended, kept in .env with chmod 600).
// Fall back to a per-install secret persisted in app_config so OSS installs work
// out of the box. A short, weak JWT_SECRET is rejected to avoid trivial forgery.
function resolveJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters');
    }
    return fromEnv;
  }
  return appConfigDb.getOrCreateJwtSecret();
}

const JWT_SECRET = resolveJwtSecret();
const TOKEN_TTL = '7d';

// ---------------------------------------------------------------------------
// SEC-PLATFORM-AUTH — platform-mode boot guard (B-186, sibling of B-5/T-50)
// ---------------------------------------------------------------------------
//
// `IS_PLATFORM` does not "authenticate differently": it DISABLES authentication.
// Both authenticateToken and authenticateWebSocket short-circuit to
// `userDb.getFirstUser()` — the oldest active account, i.e. the OWNER on every
// real install — for EVERY request, including requests carrying no token at all.
// Consequences, all silent:
//   - `requireRole('owner')` passes for an anonymous caller, so owner-only RCE
//     class routes (POST /api/system/pending/:id/execute → runs the approved
//     server action / safe-restart; POST /api/system/update) become reachable by
//     anyone who can open a TCP connection to the port;
//   - project/session isolation collapses onto one identity;
//   - the operator's single Claude subscription is silently shared (B-5).
//
// The existing B-5 guard (services/platform-isolation-guard.service.js) only
// covers the SUBSCRIPTION-sharing facet, and only when >1 active user exists —
// a one-owner install passes it while still serving unauthenticated owner
// access. This guard closes the authentication facet, and it lives here, at the
// module that implements the bypass, so no boot path can import the bypass
// without passing the check (index.js imports this module at load time, long
// before the listener opens; a throw here aborts boot exactly like the weak
// JWT_SECRET check above).
//
// Policy: FAIL-CLOSED. Turning the flag on requires BOTH
//   1. an explicit acknowledgement env var naming the danger, and
//   2. a loopback bind (HOST), because there is no safe public bind for a mode
//      that has no authentication. A public deployment must terminate TLS/auth
//      in a reverse proxy on loopback.
// There is deliberately no override for (2): "platform mode on a public
// interface" IS the vulnerability, not a configuration nuance.
const PLATFORM_ACK_ENV = 'PLATFORM_MODE_UNAUTHENTICATED_ACK';
const PLATFORM_ACK_VALUE = 'i-accept-every-request-runs-as-the-first-user';

// Hosts that keep the socket off the network. `HOST` unset is NOT loopback:
// server/index.js defaults it to 0.0.0.0 (all interfaces), so an operator who
// merely flips VITE_IS_PLATFORM without touching HOST must be refused.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']);

/** Thrown when platform mode is enabled without the fail-closed preconditions. */
class PlatformAuthBypassError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlatformAuthBypassError';
  }
}

/**
 * Refuses to load (⇒ refuses to boot) when platform mode is enabled without the
 * explicit acknowledgement and a loopback bind. No-op in every other case.
 *
 * Dependencies are injected for testability; production uses the live flag and
 * process.env.
 *
 * @param {object} [deps]
 * @param {boolean} [deps.isPlatform] platform-mode flag
 * @param {Record<string, string|undefined>} [deps.env] environment to inspect
 * @returns {void}
 */
function assertPlatformAuthBypassSafe({ isPlatform = IS_PLATFORM, env = process.env } = {}) {
  if (!isPlatform) {
    return;
  }

  if (env[PLATFORM_ACK_ENV] !== PLATFORM_ACK_VALUE) {
    throw new PlatformAuthBypassError(
      'Refusing to boot: platform mode (VITE_IS_PLATFORM=true) disables ' +
        'authentication entirely — every request, even one with no token, is ' +
        'served as the first active user (the owner), so owner-only routes ' +
        '(e.g. POST /api/system/pending/:id/execute, POST /api/system/update) ' +
        'become reachable by anyone who can reach the port (B-186). If that is ' +
        `genuinely intended, acknowledge it explicitly: ${PLATFORM_ACK_ENV}=` +
        `${PLATFORM_ACK_VALUE}. Otherwise unset VITE_IS_PLATFORM so each user ` +
        'authenticates with their own JWT. See B-5/T-50 and memory: ' +
        'project_is_platform_shared_sub_risk.'
    );
  }

  const host = (env.HOST ?? '').trim();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new PlatformAuthBypassError(
      'Refusing to boot: platform mode is acknowledged but HOST=' +
        `${host || '<unset → 0.0.0.0>'} binds a NON-loopback interface. A mode ` +
        'with no authentication must never listen on a public interface — put ' +
        'a reverse proxy in front and set HOST=127.0.0.1 (B-186).'
    );
  }
}

// Executed at module load: index.js imports this module during boot, so an
// unsafe platform configuration aborts the process before any listener opens.
assertPlatformAuthBypassSafe();

// SEC-JWT-ALG: pin the accepted signature algorithm. `jwt.verify` without
// `algorithms` accepts whatever the TOKEN's header declares, which is the entry
// point for the classic algorithm-confusion family (and leaves the door open if
// this install ever gains an asymmetric key alongside the HMAC one). We only
// ever MINT HS256 (jwt.sign default for a string secret), so accepting only
// HS256 is exactly the current behaviour minus the attack surface.
const JWT_VERIFY_OPTIONS = Object.freeze({ algorithms: ['HS256'] });

// SEC-PWD-ROTATE: the endpoints a user under FORCED password rotation may still
// reach. Everything else is refused until they actually rotate.
// - me/password : the rotation itself (the only way out of this state)
// - logout      : must always be possible
// - me / user   : identity reads the client needs to render the rotation screen
// Exact, lowercased, query-free paths compared against req.originalUrl. Express
// matches routes case-insensitively by default, so we lowercase before
// comparing; a traversal-style path (`/api/auth/me/password/../../users`) is a
// different STRING and therefore fails this exact match — fail-closed.
const MUST_CHANGE_PASSWORD_ALLOWED_PATHS = new Set([
  '/api/auth/me/password',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/user',
]);

/** Normalizes a request path for the forced-rotation allowlist comparison. */
function normalizeRequestPath(req) {
  const raw = req.originalUrl || req.url || '';
  const withoutQuery = raw.split('?')[0].split('#')[0];
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return (trimmed || '/').toLowerCase();
}

// Refresh coalescing (B-163). Single fork-mode process (PM2 instances:1), so an
// in-process Map is authoritative for every concurrent request. Keyed by userId:
//   userId -> { token, mintedAtMs }
// A boot burst (~16 parallel requests) past half-life collapses to ONE minted
// token, so the client adopts it once and redials the WebSocket once.
const REFRESH_COALESCE_WINDOW_MS = 10_000;
const refreshedTokenCache = new Map();

function getCoalescedRefreshToken(user) {
  const nowMs = Date.now();
  const cached = refreshedTokenCache.get(user.id);
  if (cached && nowMs - cached.mintedAtMs < REFRESH_COALESCE_WINDOW_MS) {
    return { token: cached.token, minted: false };
  }
  const token = generateToken(user);
  refreshedTokenCache.set(user.id, { token, mintedAtMs: nowMs });
  if (refreshedTokenCache.size > 256) {
    for (const [id, entry] of refreshedTokenCache) {
      if (nowMs - entry.mintedAtMs >= REFRESH_COALESCE_WINDOW_MS) refreshedTokenCache.delete(id);
    }
  }
  return { token, minted: true };
}

/**
 * Drops a user's coalesced refresh token (B-165).
 *
 * The cache holds, for up to REFRESH_COALESCE_WINDOW_MS, a token minted with the
 * PREVIOUS `pwd_iat`. After a password change/reset that token is already dead
 * (pwd_iat < password_changed_at), so handing it out in `X-Refreshed-Token`
 * would push the client to adopt a token the very next request rejects with 401
 * — a self-inflicted logout / WebSocket bounce. Password-mutating routes call
 * this so the next refresh mints against the new stamp.
 *
 * @param {number} userId
 * @returns {void}
 */
function invalidateRefreshCache(userId) {
  refreshedTokenCache.delete(userId);
}

// ---------------------------------------------------------------------------
// SEC-REFRESH-GRACE — narrow renewal window for a just-expired token (B-154)
// ---------------------------------------------------------------------------
//
// Tokens live TOKEN_TTL (7d). A user who is away longer than that returns to a
// hard logout even though nothing is wrong with their account — the last
// remaining forced-logout case after B-131. POST /api/auth/refresh may therefore
// accept a token that is expired but only RECENTLY so, within a strict window.
//
// This deliberately extends the effective lifetime of a bearer credential, so:
//   - it applies to the refresh endpoint ONLY (never to authenticateToken or the
//     WebSocket verifier — an expired token authorizes nothing by itself);
//   - the window is short by default and HARD-CAPPED; a larger configured value
//     is clamped, never honoured;
//   - every other check still runs at the call site (user active, pwd_iat, and
//     forced rotation), and the grace path is separately rate-limited + audited.
const REFRESH_GRACE_DEFAULT_HOURS = 24;
const REFRESH_GRACE_MAX_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Resolves the grace window in ms from `AUTH_REFRESH_GRACE_HOURS`.
 * Unset → default. Invalid/negative → default. Above the cap → clamped to the
 * cap (loudly). `0` is honoured and disables the grace path entirely.
 *
 * @param {string|undefined} raw
 * @returns {number} window in milliseconds
 */
function resolveRefreshGraceMs(raw = process.env.AUTH_REFRESH_GRACE_HOURS) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return REFRESH_GRACE_DEFAULT_HOURS * HOUR_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[auth] ignoring invalid AUTH_REFRESH_GRACE_HOURS=${raw}; using ${REFRESH_GRACE_DEFAULT_HOURS}h`
    );
    return REFRESH_GRACE_DEFAULT_HOURS * HOUR_MS;
  }
  if (parsed > REFRESH_GRACE_MAX_HOURS) {
    console.warn(
      `[auth] AUTH_REFRESH_GRACE_HOURS=${parsed} exceeds the ${REFRESH_GRACE_MAX_HOURS}h cap; clamping`
    );
    return REFRESH_GRACE_MAX_HOURS * HOUR_MS;
  }
  return parsed * HOUR_MS;
}

const REFRESH_GRACE_MS = resolveRefreshGraceMs();

/**
 * Verifies a token's SIGNATURE while tolerating a recent expiry (B-154).
 *
 * Signature, algorithm pin and claim shape are enforced exactly as on the normal
 * path; only the `exp` deadline is relaxed, and only inside `graceMs`. A token
 * with no numeric `exp` is refused (fail-closed: a non-expiring bearer token is
 * never acceptable here).
 *
 * @param {string} token
 * @param {object} [options]
 * @param {number} [options.nowMs]   clock injection for tests
 * @param {number} [options.graceMs] window override for tests
 * @returns {{ok: true, decoded: object, expired: boolean, expiredForMs: number}
 *          |{ok: false, reason: 'invalid'|'no_exp'|'expired_beyond_grace'}}
 */
function verifyTokenAllowingRecentExpiry(
  token,
  { nowMs = Date.now(), graceMs = REFRESH_GRACE_MS } = {}
) {
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, { ...JWT_VERIFY_OPTIONS, ignoreExpiration: true });
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!decoded || typeof decoded !== 'object' || typeof decoded.exp !== 'number') {
    return { ok: false, reason: 'no_exp' };
  }
  const expMs = decoded.exp * 1000;
  if (nowMs <= expMs) {
    return { ok: true, decoded, expired: false, expiredForMs: 0 };
  }
  const expiredForMs = nowMs - expMs;
  if (expiredForMs > graceMs) {
    return { ok: false, reason: 'expired_beyond_grace' };
  }
  return { ok: true, decoded, expired: true, expiredForMs };
}

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode: use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also accept the token via query param, but ONLY for EventSource/SSE requests
  // — the sole legitimate case, since EventSource cannot set an Authorization
  // header. Those requests are identifiable by their spec-mandated
  // `Accept: text/event-stream`. Refusing a query token everywhere else (B-160)
  // keeps JWTs out of ordinary request URLs, where they leak into browser
  // history, referrers and logs, and where (pre-B-158) a `?token=` on a
  // byte-serving route could ride a top-level navigation into a stored-XSS. This
  // does NOT affect authenticated media preview: ImageViewer /
  // CodeEditorMediaPreview send the token in the Authorization header (XHR+blob),
  // not the query string. The WebSocket path authenticates separately and is
  // unaffected.
  if (!token && req.query.token) {
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/event-stream')) {
      token = req.query.token;
    }
  }

  const ip = clientIp(req);
  const ua = req.headers['user-agent'] ?? null;

  if (!token) {
    // Noisy reason → aggregated (qa-critic ح-2/ح-3). No token to decode.
    recordAuthRejection({ reason: 'no_token', transport: 'rest', ipAddress: ip, userAgent: ua });
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTIONS);

    // Verify user still exists, is active, and is not disabled (stateless: a
    // single id lookup, not a server-side session record).
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      recordAuthRejection({
        reason: 'user_missing',
        transport: 'rest',
        // The token's signature is valid, but no such user exists (deleted /
        // never existed), so the id cannot populate the audit FK column.
        userId: typeof decoded.userId === 'number' ? decoded.userId : null,
        ipAddress: ip,
        userAgent: ua,
        unverified: true,
      });
      return res.status(401).json({ error: 'Invalid token. User not found or disabled.' });
    }

    // Reject tokens minted before the user's last password change (logout-all on
    // password change / admin reset). pwd_iat and password_changed_at are ms epochs.
    if (user.password_changed_at && decoded.pwd_iat < user.password_changed_at) {
      recordAuthRejection({
        reason: 'pwd_iat_stale',
        transport: 'rest',
        userId: user.id,
        ipAddress: ip,
        userAgent: ua,
      });
      return res.status(401).json({ error: 'Token invalidated' });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one.
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const { token: newToken, minted } = getCoalescedRefreshToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
        // Record the implicit (header-driven) refresh — distinct from the
        // explicit POST /api/auth/refresh, which logs its own row (T-182). Only
        // the request that actually minted logs, so a boot burst of parallel
        // refreshes collapses to a single audit row (B-163).
        if (minted) {
          auditLogDb.record('token_refresh', {
            userId: user.id,
            ipAddress: ip,
            userAgent: ua,
            metadata: { via: 'header' },
          });
        }
      }
    }

    req.user = user;
    // Surface forced-rotation state to downstream handlers/clients (set after an
    // admin reset; cleared once the user changes their password).
    if (user.must_change_password === 1) {
      req.user.mustChangePassword = true;

      // SEC-PWD-ROTATE — ENFORCEMENT (this flag used to be advisory only).
      //
      // `resetPassword` sets must_change_password = 1 and routes/auth.js says
      // "The target must change it on next use", but NOTHING on the server ever
      // acted on it: the flag was merely surfaced to the client (GET /user), so
      // hiding the rest of the app behind a rotation screen was pure client-side
      // UX. Anyone holding the admin-issued TEMPORARY password could log in and
      // drive every API indefinitely — including /api/agent — without ever
      // rotating it. Since that temp password is handed over out-of-band and is
      // often reused/shared, it must be a single-purpose credential.
      //
      // Now every route except the rotation/identity/logout allowlist is refused
      // with 403 until the password is actually changed (changePassword clears
      // the flag, so the very next request passes normally).
      const requestPath = normalizeRequestPath(req);
      if (!MUST_CHANGE_PASSWORD_ALLOWED_PATHS.has(requestPath)) {
        console.warn(
          `[auth] blocked user ${user.id}: password rotation required (path=${requestPath})`
        );
        return res.status(403).json({
          error: 'Password change required',
          code: 'password_change_required',
        });
      }
    }
    next();
  } catch (err) {
    // Do not log token contents. Classify the failure from err.name and recover
    // the claimed userId via an UNVERIFIED decode for correlation only (T-182).
    let reason = 'verify_error';
    if (err && err.name === 'TokenExpiredError') {
      reason = 'expired';
    } else if (err && err.name === 'JsonWebTokenError') {
      reason = 'bad_signature';
    }
    recordAuthRejection({
      reason,
      transport: 'rest',
      userId: decodeUnverifiedUserId(token),
      ipAddress: ip,
      userAgent: ua,
      unverified: true,
    });
    // Generic message; 401 for expired/forged.
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Role hierarchy (owner ⊇ admin ⊇ user). Higher rank = more privilege. This is
// the single source of truth for role ordering; requireRole matches an explicit
// set, roleSatisfies compares against a minimum.
const ROLE_RANK = Object.freeze({ user: 1, admin: 2, owner: 3 });

/**
 * True when `role` meets or exceeds `minRole` in the hierarchy owner>admin>user.
 * FAIL-CLOSED: an unknown/missing role ranks 0 (denied); an unknown/missing
 * minRole requires an impossibly high rank (denied). Pure — no request state —
 * so it is reusable for per-action authorization (ADR-066, T-947) where the
 * required role is defined per allowlist entry (server-actions.js minRole).
 *
 * @param {unknown} role     the caller's role (req.user.role)
 * @param {unknown} minRole  the least-privileged role permitted
 * @returns {boolean}
 */
const roleSatisfies = (role, minRole) => {
  const have = ROLE_RANK[role] ?? 0;
  const need = ROLE_RANK[minRole] ?? Number.POSITIVE_INFINITY;
  return have >= need;
};

/**
 * Express middleware factory enforcing that req.user.role is in `allowedRoles`.
 * Must run after authenticateToken. Returns 403 on insufficient role.
 */
const requireRole = (...allowedRoles) => (req, res, next) => {
  const role = req.user?.role;
  if (!role || !allowedRoles.includes(role)) {
    auditLogDb.record('insufficient_role', {
      userId: req.user?.id ?? null,
      metadata: { required: allowedRoles, actual: role ?? null },
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

// Generate JWT token (stateless — carries id, username, role, pwd_iat).
// pwd_iat pins the token to the password version at issue time (ms epoch); a
// later password change advances password_changed_at and invalidates this token.
//
// B-164: the missing-stamp fallback used to be `|| Date.now()`, which was wrong
// twice over. (1) It stamped the token with a value NEWER than any future
// password change could plausibly precede — actually it made the token look
// current, so the row's real password history was ignored. (2) Being a
// MILLISECOND clock read, it made every single mint a byte-different token even
// within the same second — the amplifier that turned the B-163 refresh burst
// hysterical. Falling back to 0 instead is both deterministic (identical payload
// ⇒ identical token) and strictly safer: the moment the row gains a
// password_changed_at stamp, every 0-stamped token is invalidated. With
// createUser now stamping at insert and the migration healing legacy NULLs, this
// fallback is only reachable for a partial user object.
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      role: user.role,
      pwd_iat: user.password_changed_at ?? 0,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username, role: user.role };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    // SEC-JWT-ALG: same algorithm pin as the REST verifier.
    const decoded = jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTIONS);
    // Verify user actually exists/active in DB (matches REST authenticateToken).
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    // Reject tokens minted before the user's last password change (logout-all on
    // password change / admin reset) — matches REST authenticateToken so a live
    // WebSocket cannot outlive a password change to its TTL.
    if (user.password_changed_at && decoded.pwd_iat < user.password_changed_at) {
      return null;
    }
    return { id: user.id, userId: user.id, username: user.username, role: user.role };
  } catch {
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  requireRole,
  roleSatisfies,
  generateToken,
  authenticateWebSocket,
  invalidateRefreshCache,
  verifyTokenAllowingRecentExpiry,
  resolveRefreshGraceMs,
  assertPlatformAuthBypassSafe,
  PlatformAuthBypassError,
  PLATFORM_ACK_ENV,
  PLATFORM_ACK_VALUE,
  REFRESH_GRACE_MS,
  REFRESH_GRACE_MAX_HOURS,
  JWT_SECRET,
};
