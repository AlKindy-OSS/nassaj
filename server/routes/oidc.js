/**
 * OIDC Relying Party routes (P-IDP-3, ADR-046).
 *
 * Mounted under /api/auth/oidc by routes/auth.js. Implements the
 * authorization-code + PKCE flow against an external OpenID Provider (the
 * configured external IdP (`OIDC_ISSUER_URL`) for an existing local user. This RP is a
 * PUBLIC client (no client_secret) and uses PKCE (S256) for the code exchange.
 *
 * Browser-facing (front channel):
 *   GET    /login            → 302 to the IdP authorization endpoint
 *   GET    /callback         → 302 to /auth/oidc/return?oidc_code=<code>
 *   POST   /exchange          → { token, userId }  (SPA trades code for JWT)
 *
 * IdP-facing (back channel):
 *   POST   /backchannel-logout   { logout_token } → 200  (revokes the user's tokens)
 *
 * Admin (authenticated, admin/owner):
 *   POST   /link             { targetUserId, subject } → 200
 *   DELETE /link/:userId     → 200
 *
 * Design notes:
 *   - No auto-provision (C-2): /callback only logs in an already-linked user; it
 *     never creates an account. An unknown subject returns oidc_not_linked.
 *   - The minted JWT NEVER appears in a redirect URL. /callback stashes it in a
 *     1-minute one-time code store and redirects with only an opaque code, which
 *     the SPA immediately redeems at /exchange.
 *   - Discovery and JWKS are fetched over exact HTTPS URLs with bounded,
 *     no-redirect requests and short process-local caches.
 *   - id_token and logout_token signatures and registered OIDC claims are
 *     verified before any identity lookup or revocation side effect.
 *   - Roles (ADR-064/069): the verified Zitadel PROJECT-SCOPED roles claim is
 *     mapped by the shared external-role mapper on every login; owner is
 *     local-only. The generic cross-project roles claim is never trusted.
 *
 * Gated by oidcEnabled() (services/oidc-config.js): every browser/IdP route
 * returns 501 unless OIDC_ENABLED is exactly 'true' AND OIDC_ROLE_PROJECT_ID is a
 * valid project id (fail-closed — an unscoped role config disables OIDC).
 */

import crypto from 'crypto';

import express from 'express';

import {
  authenticateToken,
  generateToken,
  invalidateRefreshCache,
  requireRole,
} from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { revokeUserIdentity } from '../modules/account-wallet/user-identity-revocation.js';
import {
  isRoleDowngrade,
  revocationForRoleChange,
} from '../modules/account-wallet/user-realtime-revocation.js';
import {
  auditLogDb,
  getConnection,
  userDb,
  userIdentitiesDb,
} from '../modules/database/index.js';
import { clientIp } from '../utils/client-ip.js';
import { oidcPkceStore } from '../services/oidc-pkce.store.js';
import { oidcCodeStore } from '../services/oidc-code.store.js';
import {
  extractZitadelRoleNames,
  hasZitadelRolesClaim,
  syncExternalRole,
} from '../services/external-role-mapper.js';
import { oidcEnabled, roleProjectId } from '../services/oidc-config.js';
import {
  createOidcVerifier,
  parseExactHttpsIssuer,
} from '../services/oidc-verifier.service.js';

/**
 * B-1327 (qa M1): an SSO attestation that demotes a user (e.g. admin → user)
 * stops the turns launched under the old role and refreshes the user's live
 * connections, exactly like an owner-side downgrade. A promotion changes
 * nothing live. A failure is logged and never blocks the login.
 */
function revokeLiveAccessOnSsoRoleChange({ userId, from, to }) {
  if (!isRoleDowngrade(from, to)) return;
  try {
    revokeUserIdentity(userId, revocationForRoleChange(from, to));
  } catch {
    // Stable code only: this route never logs raw provider or error detail.
    logOidcFailure('role_change_revocation_failed');
  }
}

const router = express.Router();

// Rate limiters: tighter on the unauthenticated IdP-facing paths to prevent
// /login→IdP-flood and /exchange brute-force (10 reqs/min), and lighter on
// the back-channel logout (IdP-to-server — 30/min to allow burst during
// mass-logout events without opening a write-flood vector).
const oidcLoginLimiter = createRateLimiter({ windowMs: 60_000, max: 10,
  message: 'Too many OIDC login attempts, please try again later' });
const oidcExchangeLimiter = createRateLimiter({ windowMs: 60_000, max: 20,
  message: 'Too many code exchange attempts, please try again later' });
const oidcBackchannelLimiter = createRateLimiter({ windowMs: 60_000, max: 30,
  message: 'Too many logout notifications, please try again later' });

// Front-channel page the SPA serves to redeem the one-time code (must match the
// client route). Only an opaque code travels here — never the JWT.
const RETURN_PATH = '/auth/oidc/return';
const BROWSER_TRANSACTION_COOKIE = '__Host-oidc-txn';
const MAX_SUBJECT_LENGTH = 255;
const NO_STORE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  pragma: 'no-cache',
});
const BROWSER_TRANSACTION_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
});

/** @type {{ key: string, verifier: ReturnType<typeof createOidcVerifier> } | null} */
let verifierCache = null;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** The trusted issuer this RP accepts identities from (must equal id_token.iss). */
function issuerUrl() {
  return process.env.OIDC_ISSUER_URL || '';
}

/** The registered public client id. */
function clientId() {
  return process.env.OIDC_CLIENT_ID || '';
}

/**
 * The redirect_uri presented to the IdP. Prefer an explicit OIDC_REDIRECT_URI
 * (recommended — it must byte-for-byte match what is registered at the IdP).
 * Otherwise derive it from the forwarded request: this app sits behind a
 * Cloudflare tunnel that sets X-Forwarded-Proto / X-Forwarded-Host, so we honour
 * those before falling back to the raw request host.
 */
function redirectUri() {
  const raw = process.env.OIDC_REDIRECT_URI;
  if (typeof raw !== 'string' || raw.length === 0 || raw !== raw.trim()) {
    throw new Error('invalid_redirect_config');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('invalid_redirect_config');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.toString() !== raw
  ) {
    throw new Error('invalid_redirect_config');
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Crypto / discovery helpers
// ---------------------------------------------------------------------------

/** 32 random bytes, base64url — used for state, nonce, code_verifier, and codes. */
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** PKCE S256 challenge: base64url(SHA-256(code_verifier)). */
function codeChallengeFor(codeVerifier) {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

function getVerifier() {
  const issuer = parseExactHttpsIssuer(issuerUrl());
  const configuredClientId = clientId();
  const key = `${issuer}\0${configuredClientId}`;
  if (!verifierCache || verifierCache.key !== key) {
    verifierCache = {
      key,
      verifier: createOidcVerifier({ issuer, clientId: configuredClientId }),
    };
  }
  return verifierCache.verifier;
}

function logOidcFailure(code) {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'oidc', code })}\n`);
}

function browserTransaction(req) {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 4096) {
    return null;
  }
  const prefix = `${BROWSER_TRANSACTION_COOKIE}=`;
  for (const part of cookieHeader.split(';')) {
    const candidate = part.trim();
    if (candidate.startsWith(prefix)) {
      const value = candidate.slice(prefix.length);
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

function setNoStore(res) {
  res.set(NO_STORE_HEADERS);
}

function revokeUserSessions(userId) {
  getConnection()
    .prepare('UPDATE users SET password_changed_at = ? WHERE id = ?')
    .run(Date.now(), userId);
  invalidateRefreshCache(userId);
}

// ---------------------------------------------------------------------------
// Browser front channel
// ---------------------------------------------------------------------------

// Kicks off the authorization-code + PKCE flow: mints state/nonce/verifier,
// stashes them under `state`, and redirects the browser to the IdP.
router.get('/login', oidcLoginLimiter, async (req, res) => {
  if (!oidcEnabled()) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }
  try {
    const discovery = await getVerifier().getDiscovery();

    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();
    const transaction = randomToken();
    const codeChallenge = codeChallengeFor(codeVerifier);

    if (!oidcPkceStore.store(state, { nonce, codeVerifier, browserTransaction: transaction })) {
      logOidcFailure('pkce_store_full');
      return res.status(503).json({ error: 'Identity provider temporarily unavailable' });
    }
    res.cookie(BROWSER_TRANSACTION_COOKIE, transaction, {
      ...BROWSER_TRANSACTION_COOKIE_OPTIONS,
      maxAge: 10 * 60_000,
    });
    setNoStore(res);

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId());
    authUrl.searchParams.set('redirect_uri', redirectUri());
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return res.redirect(authUrl.toString());
  } catch (error) {
    logOidcFailure('login_unavailable');
    return res.status(502).json({ error: 'Identity provider unavailable' });
  }
});

// IdP redirect target. Validates state, exchanges the code (PKCE), checks the
// id_token nonce/issuer, resolves the linked local user, mints a JWT, and hands
// the browser a one-time code (never the JWT) to redeem at /exchange.
router.get('/callback', oidcLoginLimiter, async (req, res) => {
  setNoStore(res);
  if (!oidcEnabled()) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }

  const { code, state } = req.query;
  if (typeof state !== 'string' || state.length === 0 || state.length > 256) {
    return res.status(400).json({ error: 'Missing state parameter' });
  }
  if (typeof code !== 'string' || code.length === 0 || code.length > 4096) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  // Single-use consume: an expired or replayed state fails here.
  const transaction = browserTransaction(req);
  const entry = oidcPkceStore.consume(state, transaction);
  if (!entry) {
    return res.status(400).json({ error: 'Invalid or expired state' });
  }

  try {
    const verifier = getVerifier();

    // PKCE code exchange — public client, so code_verifier (not a secret) proves
    // possession. No Authorization header.
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: clientId(),
      code_verifier: entry.codeVerifier,
    });
    const tokenSet = await verifier.exchangeAuthorizationCode(body);
    const idToken = tokenSet?.id_token;
    const claims = await verifier.verifyIdToken(idToken, entry.nonce);

    const subject = typeof claims.sub === 'string' ? claims.sub : null;
    if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
      return res.status(401).json({ error: 'id_token missing subject' });
    }

    // No auto-provision (C-2): the identity must already be linked to a local
    // user. An unknown subject is a deliberate dead end.
    const identity = userIdentitiesDb.findByIssuerAndSubject(issuerUrl(), subject);
    if (!identity) {
      return res.status(401).json({
        error: 'oidc_not_linked',
        message: 'No nassaj account linked to this identity',
      });
    }

    // getUserById returns only active (is_active=1, status='active') users.
    const linkedUser = userDb.getUserById(identity.user_id);
    // ADR-064/069: the verified role claim is an attestation; the shared mapper
    // decides the local role (never owner, never demotes an owner). Roles are read
    // ONLY from the project-scoped claim; claimPresent lets a demotion caused by a
    // missing claim be audited distinctly from an unrecognized-role demotion.
    const configuredProjectId = roleProjectId();
    const user = linkedUser && syncExternalRole({
      user: linkedUser,
      externalRoles: extractZitadelRoleNames(claims, configuredProjectId),
      provider: 'oidc',
      claimPresent: hasZitadelRolesClaim(claims, configuredProjectId),
    }, { userDb, auditLogDb, onRoleApplied: revokeLiveAccessOnSsoRoleChange });
    if (!user) {
      return res.status(401).json({ error: 'Linked account is unavailable' });
    }

    const token = generateToken(user);
    const oneTimeCode = randomToken();
    if (!oidcCodeStore.store(oneTimeCode, { token, userId: user.id, browserTransaction: transaction })) {
      logOidcFailure('code_store_full');
      return res.status(503).json({ error: 'Identity provider temporarily unavailable' });
    }

    userDb.updateLastLogin(user.id);
    auditLogDb.record('oidc_login', {
      userId: user.id,
      metadata: { provider: 'oidc' },
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    setNoStore(res);
    return res.redirect(`${RETURN_PATH}?oidc_code=${encodeURIComponent(oneTimeCode)}`);
  } catch (error) {
    logOidcFailure('callback_rejected');
    return res.status(502).json({ error: 'Identity provider unavailable' });
  }
});

// SPA trades the one-time code for the actual JWT. It must prove it is the
// browser that started the authorization transaction by presenting the secure
// transaction cookie. The one-time code remains single-use.
router.post('/exchange', oidcExchangeLimiter, (req, res) => {
  setNoStore(res);
  if (!oidcEnabled()) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }
  const { code } = req.body ?? {};
  if (typeof code !== 'string' || code.length === 0 || code.length > 256) {
    return res.status(400).json({ error: 'Missing code' });
  }
  const transaction = browserTransaction(req);
  const redeemed = oidcCodeStore.consume(code, transaction);
  res.clearCookie(BROWSER_TRANSACTION_COOKIE, BROWSER_TRANSACTION_COOKIE_OPTIONS);
  if (!redeemed) {
    return res.status(401).json({ error: 'Invalid or expired code' });
  }
  return res.json({ token: redeemed.token, userId: redeemed.userId });
});

// ---------------------------------------------------------------------------
// IdP back channel
// ---------------------------------------------------------------------------

// OIDC back-channel logout. The IdP POSTs a logout_token; we revoke every JWT
// for the mapped local user by advancing password_changed_at (the same pwd_iat
// mechanism authenticateToken uses to reject stale tokens). Always returns 200
// per the spec (the IdP does not act on our error body), but never reveals
// whether the subject mapped to an account.
router.post('/backchannel-logout', oidcBackchannelLimiter, async (req, res) => {
  if (!oidcEnabled()) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }
  // The logout_token arrives form-encoded per the OIDC back-channel spec, but
  // accept JSON too for flexibility.
  let claims;
  try {
    claims = await getVerifier().verifyLogoutToken(req.body?.logout_token);
  } catch {
    logOidcFailure('logout_token_rejected');
    return res.status(200).json({ ok: true });
  }

  const subject = typeof claims.sub === 'string' ? claims.sub : null;
  const identity = subject
    ? userIdentitiesDb.findByIssuerAndSubject(issuerUrl(), subject)
    : undefined;

  if (identity) {
    try {
      revokeUserSessions(identity.user_id);
    } catch (error) {
      logOidcFailure('logout_revoke_failed');
    }
  }

  auditLogDb.record('oidc_backchannel_logout', {
    userId: identity?.user_id ?? null,
    metadata: { provider: 'oidc' },
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });

  return res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin identity management (authenticated, admin/owner)
// ---------------------------------------------------------------------------

// Links an existing local user to an IdP subject. The issuer is fixed to the
// configured OIDC_ISSUER_URL (an admin cannot link against an arbitrary issuer).
router.post('/link', authenticateToken, requireRole('admin', 'owner'), (req, res) => {
  const { targetUserId, subject } = req.body ?? {};
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'A valid targetUserId is required' });
  }
  if (
    typeof subject !== 'string'
    || subject.trim().length === 0
    || subject.trim().length > MAX_SUBJECT_LENGTH
  ) {
    return res.status(400).json({ error: 'A non-empty subject is required' });
  }

  let issuer;
  try {
    issuer = parseExactHttpsIssuer(issuerUrl());
  } catch {
    return res.status(500).json({ error: 'OIDC_ISSUER_URL is not configured' });
  }

  const trimmedSubject = subject.trim();

  // The (issuer, subject) pair is unique: refuse if already mapped (to this or
  // any other user) so a subject is never silently re-pointed.
  const existing = userIdentitiesDb.findByIssuerAndSubject(issuer, trimmedSubject);
  if (existing) {
    return res.status(409).json({ error: 'This identity is already linked' });
  }

  // Guard the FK: linking a non-existent user would otherwise fail opaquely.
  const target = userDb.getRawById(targetUserId);
  if (!target) {
    return res.status(404).json({ error: 'Target user not found' });
  }

  try {
    userIdentitiesDb.link(targetUserId, issuer, trimmedSubject);
  } catch (error) {
    // Concurrent insert racing the uniqueness check → conflict.
    logOidcFailure('identity_link_conflict');
    return res.status(409).json({ error: 'This identity is already linked' });
  }

  auditLogDb.record('oidc_identity_linked', {
    userId: req.user.id,
    metadata: { targetUserId, provider: 'oidc' },
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });

  return res.status(200).json({ message: 'Linked' });
});

// Removes ALL IdP links for the given user (admin unlink).
router.delete('/link/:userId', authenticateToken, requireRole('admin', 'owner'), (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'A valid userId is required' });
  }

  try {
    revokeUserSessions(userId);
    userIdentitiesDb.unlinkAll(userId);
  } catch {
    logOidcFailure('identity_unlink_failed');
    return res.status(500).json({ error: 'Unable to unlink identity' });
  }

  auditLogDb.record('oidc_identity_unlinked', {
    userId: req.user.id,
    metadata: { targetUserId: userId },
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });

  return res.status(200).json({ message: 'Unlinked' });
});

export default router;
