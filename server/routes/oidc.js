/**
 * OIDC Relying Party routes (P-IDP-3, ADR-046).
 *
 * Mounted under /api/auth/oidc by routes/auth.js. Implements the
 * authorization-code + PKCE flow against an external OpenID Provider (the
 * Mujtana team IdP, OIDC_ISSUER_URL) for an existing local user. This RP is a
 * PUBLIC client (no client_secret) and uses PKCE (S256) for the code exchange.
 *
 * Browser-facing (front channel):
 *   GET    /login            → 302 to the IdP authorization endpoint
 *   GET    /callback         → 302 to /auth/oidc/return?oidc_code=<code>
 *   GET    /exchange?code=   → { token, userId }  (SPA trades code for JWT)
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
 *   - Discovery (.well-known/openid-configuration) is fetched lazily with native
 *     fetch and cached process-wide; openid-client is intentionally not used to
 *     avoid the extra dependency for this narrow flow.
 *   - id_token / logout_token are DECODED (not cryptographically verified against
 *     the IdP JWKS) for now — see the SECURITY note on verifyIdpToken. The flow
 *     is still bound by PKCE (a stolen authorization code is useless without the
 *     code_verifier held server-side) and by state/nonce single-use checks.
 *
 * Gated by OIDC_ENABLED: every browser/IdP route returns 501 when the flag is
 * not exactly 'true'.
 */

import crypto from 'crypto';

import express from 'express';
import jwt from 'jsonwebtoken';

import { authenticateToken, generateToken, requireRole } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import {
  auditLogDb,
  getConnection,
  userDb,
  userIdentitiesDb,
} from '../modules/database/index.js';
import { clientIp } from '../utils/client-ip.js';
import { oidcPkceStore } from '../services/oidc-pkce.store.js';
import { oidcCodeStore } from '../services/oidc-code.store.js';

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

// Discovery cache: a well-known document changes rarely, so we fetch it once per
// process and reuse it. `null` means "not yet fetched"; a rejected discovery is
// not cached so a transient IdP outage can be retried on the next request.
/** @type {{ authorization_endpoint?: string, token_endpoint?: string } | null} */
let discoveryCache = null;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Feature flag — every IdP/browser route is dark unless this is exactly 'true'. */
function oidcEnabled() {
  return process.env.OIDC_ENABLED === 'true';
}

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
function redirectUri(req) {
  if (process.env.OIDC_REDIRECT_URI) {
    return process.env.OIDC_REDIRECT_URI;
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/api/auth/oidc/callback`;
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

/**
 * Loads (and caches) the IdP discovery document. Throws on a missing issuer,
 * a non-2xx response, or a document lacking the endpoints we need.
 */
async function getDiscovery() {
  if (discoveryCache) {
    return discoveryCache;
  }
  const issuer = issuerUrl();
  if (!issuer) {
    throw new Error('OIDC_ISSUER_URL is not configured');
  }
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const resp = await fetch(url, { headers: { accept: 'application/json' } });
  if (!resp.ok) {
    throw new Error(`OIDC discovery failed (${resp.status})`);
  }
  const doc = await resp.json();
  if (!doc || !doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('OIDC discovery document is missing required endpoints');
  }
  discoveryCache = doc;
  return doc;
}

/**
 * Decodes and minimally validates a JWT issued by the IdP (id_token or
 * logout_token).
 *
 * SECURITY: this performs claim validation only — it does NOT verify the RS256
 * signature against the IdP JWKS. It is therefore NOT sufficient on its own to
 * trust an arbitrary token. In this flow it is acceptable because:
 *   - The id_token is obtained over a direct server→IdP TLS POST to the token
 *     endpoint, gated by PKCE, so an attacker cannot inject one.
 *   - The subject is only ever used to look up an EXISTING local link; a forged
 *     subject that is not linked yields oidc_not_linked, never a new account.
 * A follow-up (JWKS verification) hardens the back-channel logout path, where
 * the token does arrive unauthenticated from the network. Until then we still
 * require iss to match and the token to be unexpired.
 *
 * @param {string} token
 * @returns {Record<string, unknown> | null} the decoded claims, or null if the
 *   token is unparseable, expired, or from the wrong issuer.
 */
function decodeIdpToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }
  let claims;
  try {
    claims = jwt.decode(token);
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') {
    return null;
  }
  // Issuer must be the one we trust.
  if (claims.iss !== issuerUrl()) {
    return null;
  }
  // Audience must include our client_id (mandatory per OIDC Core §3.1.3.7).
  // aud can be a string or an array of strings.
  const aud = claims.aud;
  const cid = clientId();
  const audOk = Array.isArray(aud) ? aud.includes(cid) : aud === cid;
  if (!audOk) {
    return null;
  }
  // Reject expired tokens (exp is seconds since epoch). Tokens without exp are
  // rejected too — every IdP token in this flow is expected to carry one.
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    return null;
  }
  return claims;
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
    const discovery = await getDiscovery();

    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();
    const codeChallenge = codeChallengeFor(codeVerifier);

    oidcPkceStore.store(state, { nonce, codeVerifier });

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId());
    authUrl.searchParams.set('redirect_uri', redirectUri(req));
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return res.redirect(authUrl.toString());
  } catch (error) {
    console.error('OIDC login error:', error?.message);
    return res.status(502).json({ error: 'Identity provider unavailable' });
  }
});

// IdP redirect target. Validates state, exchanges the code (PKCE), checks the
// id_token nonce/issuer, resolves the linked local user, mints a JWT, and hands
// the browser a one-time code (never the JWT) to redeem at /exchange.
router.get('/callback', oidcLoginLimiter, async (req, res) => {
  if (!oidcEnabled()) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }

  const { code, state } = req.query;
  if (typeof state !== 'string' || state.length === 0) {
    return res.status(400).json({ error: 'Missing state parameter' });
  }
  if (typeof code !== 'string' || code.length === 0) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  // Single-use consume: an expired or replayed state fails here.
  const entry = oidcPkceStore.consume(state);
  if (!entry) {
    return res.status(400).json({ error: 'Invalid or expired state' });
  }

  try {
    const discovery = await getDiscovery();

    // PKCE code exchange — public client, so code_verifier (not a secret) proves
    // possession. No Authorization header.
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(req),
      client_id: clientId(),
      code_verifier: entry.codeVerifier,
    });
    const tokenResp = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
    if (!tokenResp.ok) {
      console.error('OIDC token exchange failed:', tokenResp.status);
      return res.status(401).json({ error: 'Token exchange failed' });
    }
    const tokenSet = await tokenResp.json();
    const idToken = tokenSet?.id_token;
    const claims = decodeIdpToken(idToken);
    if (!claims) {
      return res.status(401).json({ error: 'Invalid id_token' });
    }

    // Replay defence: the nonce in the id_token must match the one we minted for
    // this exact authorization request.
    if (claims.nonce !== entry.nonce) {
      return res.status(401).json({ error: 'Nonce mismatch' });
    }

    const subject = typeof claims.sub === 'string' ? claims.sub : null;
    if (!subject) {
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
    const user = userDb.getUserById(identity.user_id);
    if (!user) {
      return res.status(401).json({ error: 'Linked account is unavailable' });
    }

    const token = generateToken(user);
    const oneTimeCode = randomToken();
    oidcCodeStore.store(oneTimeCode, { token, userId: user.id });

    userDb.updateLastLogin(user.id);
    auditLogDb.record('oidc_login', {
      userId: user.id,
      metadata: { sub: subject },
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    return res.redirect(`${RETURN_PATH}?oidc_code=${encodeURIComponent(oneTimeCode)}`);
  } catch (error) {
    console.error('OIDC callback error:', error?.message);
    return res.status(502).json({ error: 'Identity provider unavailable' });
  }
});

// SPA trades the one-time code for the actual JWT. Single-use: a code works once.
router.get('/exchange', oidcExchangeLimiter, (req, res) => {
  if (!oidcEnabled()) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }
  const { code } = req.query;
  if (typeof code !== 'string' || code.length === 0) {
    return res.status(400).json({ error: 'Missing code' });
  }
  const redeemed = oidcCodeStore.consume(code);
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
router.post('/backchannel-logout', oidcBackchannelLimiter, (req, res) => {
  if (!oidcEnabled()) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }
  // The logout_token arrives form-encoded per the OIDC back-channel spec, but
  // accept JSON too for flexibility.
  const logoutToken = req.body?.logout_token;
  const claims = decodeIdpToken(logoutToken);
  if (!claims) {
    // Malformed/expired/wrong-issuer token: acknowledge without side effects.
    return res.status(200).json({ ok: true });
  }

  // A logout_token must carry the OIDC back-channel event marker and must NOT be
  // an id_token (which would carry a nonce) — a minimal shape check.
  const hasLogoutEvent =
    claims.events &&
    typeof claims.events === 'object' &&
    'http://schemas.openid.net/event/backchannel-logout' in claims.events;
  if (!hasLogoutEvent || 'nonce' in claims) {
    return res.status(200).json({ ok: true });
  }

  const subject = typeof claims.sub === 'string' ? claims.sub : null;
  const identity = subject
    ? userIdentitiesDb.findByIssuerAndSubject(issuerUrl(), subject)
    : undefined;

  if (identity) {
    try {
      getConnection()
        .prepare('UPDATE users SET password_changed_at = ? WHERE id = ?')
        .run(Date.now(), identity.user_id);
    } catch (error) {
      console.error('OIDC backchannel revoke error:', error?.message);
    }
  }

  auditLogDb.record('oidc_backchannel_logout', {
    userId: identity?.user_id ?? null,
    metadata: { sub: subject },
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
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    return res.status(400).json({ error: 'A non-empty subject is required' });
  }

  const issuer = issuerUrl();
  if (!issuer) {
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
    console.error('OIDC link error:', error?.message);
    return res.status(409).json({ error: 'This identity is already linked' });
  }

  auditLogDb.record('oidc_identity_linked', {
    userId: req.user.id,
    metadata: { targetUserId, subject: trimmedSubject },
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

  userIdentitiesDb.unlinkAll(userId);

  auditLogDb.record('oidc_identity_unlinked', {
    userId: req.user.id,
    metadata: { targetUserId: userId },
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });

  return res.status(200).json({ message: 'Unlinked' });
});

export default router;
