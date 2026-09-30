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
 *                               (login refusals: ?error=<oidc_* code>; an unknown or
 *                               expired state: ?error=invalid_state / transaction_expired)
 *   POST   /exchange          → { token, userId }  (SPA trades code for JWT)
 *
 * IdP-facing (back channel):
 *   POST   /backchannel-logout   { logout_token } → 200  (revokes the user's tokens)
 *
 * Member self-link (authenticated, any role; T-1939 slice 5):
 *   GET    /link/self             → { linked, ssoStepUp }  (own account only)
 *   POST   /link/self/start       { currentPassword } → { authorizationUrl }
 *   The IdP returns to the same /callback; the PKCE entry's purpose ('link')
 *   routes it to the link branch, which attaches the verified subject to the
 *   account that started it and to no other. A 'link' transaction never logs
 *   anyone in by subject, and a 'login' transaction never links.
 *
 * Member step-up (authenticated SSO-linked member; T-1939 slice 6B):
 *   POST   /step-up/start         → { authorizationUrl }  (counts against the
 *                                   shared stepup:<id> quota; prompt=login,
 *                                   max_age=0)
 *   The IdP returns to the same /callback; a 'step_up' transaction re-checks
 *   auth_time freshness, that the verified subject is linked to the SAME
 *   member, and that a recognized role is still granted, stamps the
 *   attestation, and redirects to /auth/oidc/return?oidc_step_up=<grant>
 *   (refusals: ?oidc_step_up_error=<code>). The grant is a one-time, 60 s
 *   token bound to the member, the audience and this browser transaction; it
 *   is redeemed as step-up evidence at POST /api/connectors/owner-session/step-up.
 *   A 'step_up' transaction never signs anyone in, and a 'login' never
 *   yields a grant.
 *
 * Identity unlinking (authenticated, owner only; B-1410):
 *   DELETE /link/self        { currentPassword } → 200  (owner's own links)
 *   DELETE /link/:userId     → 200  (strictly lower-ranked target only)
 *   There is no admin link route: an IdP subject is never attached to an
 *   account by someone else (account-takeover vector). Members cannot unlink
 *   themselves: a linked member is SSO-only (T-1939 slice 2), and a JIT
 *   account (slice 4) has no local credential at all, so removing the link
 *   would lock them out. Unlinking stays an owner action; unlinking a JIT
 *   account leaves one that cannot sign in, which the response states.
 *
 * Design notes:
 *   - Just-in-time accounts (T-1939 slice 4, services/oidc-jit-provision.js):
 *     an unknown subject is refused with oidc_not_linked unless OIDC_JIT_ENABLED
 *     is 'true' (default off), in which case a verified known project role
 *     granted by an OIDC_ALLOWED_ORG_IDS organization creates an SSO-only
 *     account. A subject is never linked to an existing account by e-mail or
 *     username; a username clash is refused with oidc_account_exists.
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
 *     When OIDC_ALLOWED_ORG_IDS is set, only grants of those organizations
 *     count on EVERY sign-in and self-link, not only for JIT creation.
 *     T-1939: no recognized role → 403 oidc_not_authorized (never a downgrade);
 *     a successful login stamps user_identities.last_attested_at.
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
import { verifyPassword } from '../services/password.service.js';
import { revokeUserIdentity } from '../modules/account-wallet/user-identity-revocation.js';
import {
  isRoleDowngrade,
  revocationForRoleChange,
  SSO_ROLE_WITHDRAWN_REVOCATION,
} from '../modules/account-wallet/user-realtime-revocation.js';
import {
  apiKeysDb,
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
  mapExternalRoles,
  NO_RECOGNIZED_ROLE_REASON,
  reconcileLocalRole,
  ROLES_CLAIM_ABSENT_REASON,
  syncExternalRole,
} from '../services/external-role-mapper.js';
import { oidcEnabled, roleProjectId } from '../services/oidc-config.js';
import {
  allowedOrgIds,
  planJitProvision,
  provisionSsoUser,
  ssoRoleNames,
} from '../services/oidc-jit-provision.js';
import {
  isUniqueConflict,
  linkIdentityWithAttestation,
  notifyOwnerOfSsoEvent,
  selfLinkAuthTimeFailure,
} from '../services/oidc-self-link.js';
import { isSsoOnlyPasswordHash } from '../services/sso-only-password.js';
import { requiresSsoLogin } from '../services/sso-only-policy.js';
import { consumeStepUpAttempt } from '../services/step-up-quota.js';
import {
  BROWSER_TRANSACTION_COOKIE,
  BROWSER_TRANSACTION_COOKIE_OPTIONS,
  readBrowserTransaction,
} from '../services/oidc-browser-transaction.js';
import { stepUpAuthTimeFailure } from '../services/oidc-step-up.js';
import { oidcStepUpGrantStore } from '../services/oidc-step-up-grant.store.js';
import {
  createOidcVerifier,
  idTokenAuthTimeMs,
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
const MAX_SUBJECT_LENGTH = 255;
const NO_STORE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  pragma: 'no-cache',
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

/** Stamps one link's SSO attestation; false when the write threw or hit no row. */
function stampAttestation(identityId, userId) {
  try {
    return userIdentitiesDb.markAttested(identityId, userId, Date.now()) === true;
  } catch {
    return false;
  }
}

function setNoStore(res) {
  res.set(NO_STORE_HEADERS);
}

function stampSessionsRevoked(userId) {
  getConnection()
    .prepare('UPDATE users SET password_changed_at = ? WHERE id = ?')
    .run(Date.now(), userId);
}

function revokeUserSessions(userId) {
  stampSessionsRevoked(userId);
  invalidateRefreshCache(userId);
}

/**
 * T-1939 slice 3: the IdP withdrew a member's grant or signed them out, so every
 * API key they hold is deleted — keys are long-lived bearer credentials that
 * never pass through the SSO attestation window. The owner (local break-glass)
 * is never governed by the IdP. Audited with a count only; a failure is logged
 * and never blocks the caller's own response.
 */
function revokeApiKeysForSsoWithdrawal(userId, trigger) {
  try {
    if (userDb.getRawById(userId)?.role === 'owner') return;
    const count = apiKeysDb.revokeAllForUser(userId);
    if (count > 0) {
      auditLogDb.record('api_keys_revoked_sso', { userId, metadata: { trigger, count } });
    }
  } catch {
    logOidcFailure('api_key_revocation_failed');
  }
}

/** Denial reason when every recognized role came from a non-allowed organization. */
const ORG_NOT_ALLOWED_REASON = 'org_not_allowed';

/**
 * Audit reason for a sign-in or self-link that ssoRoleNames left without a
 * recognized role: claim absent, a recognized role granted only by
 * organizations outside OIDC_ALLOWED_ORG_IDS, or no recognized role at all.
 */
function noRoleReason(claims, projectId) {
  if (!hasZitadelRolesClaim(claims, projectId)) return ROLES_CLAIM_ABSENT_REASON;
  if (allowedOrgIds().size > 0 && mapExternalRoles(extractZitadelRoleNames(claims, projectId)) !== null) {
    return ORG_NOT_ALLOWED_REASON;
  }
  return NO_RECOGNIZED_ROLE_REASON;
}

/**
 * T-1939: an SSO login whose attestation carries no recognized project role is
 * refused — never downgraded. For a non-owner the grant withdrawal also ends
 * existing tokens and live work; the local account itself is left enabled and
 * unchanged, so re-granting the role in the IdP restores access. An owner is
 * local-only (never governed by SSO), so its other sessions are untouched.
 */
function denyLoginWithoutRole(req, user, reason) {
  auditLogDb.record('oidc_access_denied_no_role', {
    userId: user.id,
    metadata: { provider: 'oidc', reason },
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });
  if (user.role === 'owner') return;
  revokeUserSessions(user.id);
  revokeApiKeysForSsoWithdrawal(user.id, 'oidc_not_authorized');
  try {
    revokeUserIdentity(user.id, SSO_ROLE_WITHDRAWN_REVOCATION);
  } catch {
    logOidcFailure('role_withdrawn_revocation_failed');
  }
}

// ---------------------------------------------------------------------------
// Browser front channel
// ---------------------------------------------------------------------------

/**
 * Mints state/nonce/verifier and the browser-transaction cookie, stashes them
 * under `state` with the given purpose binding, and returns the IdP
 * authorization URL — or null when the bounded PKCE store is full (the caller
 * answers 503). `extraParams` adds authorization parameters (self-link forces
 * a fresh IdP sign-in with prompt=login&max_age=0). Throws when discovery or
 * the redirect configuration is unavailable.
 */
async function beginAuthorization(res, binding, extraParams = {}) {
  const discovery = await getVerifier().getDiscovery();

  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken();
  const transaction = randomToken();
  const codeChallenge = codeChallengeFor(codeVerifier);

  if (!oidcPkceStore.store(state, { nonce, codeVerifier, browserTransaction: transaction, ...binding })) {
    logOidcFailure('pkce_store_full');
    return null;
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
  for (const [name, value] of Object.entries(extraParams)) {
    authUrl.searchParams.set(name, value);
  }
  return authUrl.toString();
}

// Kicks off the authorization-code + PKCE flow and redirects the browser to
// the IdP. Always a 'login' transaction: it can never link an identity.
router.get('/login', oidcLoginLimiter, async (req, res) => {
  if (!oidcEnabled()) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }
  try {
    const authorizationUrl = await beginAuthorization(res, { purpose: 'login' });
    if (!authorizationUrl) {
      return res.status(503).json({ error: 'Identity provider temporarily unavailable' });
    }
    return res.redirect(authorizationUrl);
  } catch (error) {
    logOidcFailure('login_unavailable');
    return res.status(502).json({ error: 'Identity provider unavailable' });
  }
});

/**
 * Mints the JWT, parks it behind a one-minute one-time code bound to this
 * browser transaction, and redirects to the SPA return page (never the JWT).
 */
function handOffSession(req, res, user, transaction) {
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
}

/**
 * Sends the browser to the SPA return page with a login refusal code, which
 * the page names in Arabic/English (T-1939 slice 4). Only a fixed code from
 * this module ever travels in the URL — no subject, username or detail.
 */
function redirectLoginRefusal(res, errorCode) {
  setNoStore(res);
  return res.redirect(`${RETURN_PATH}?error=${encodeURIComponent(errorCode)}`);
}

/**
 * Alerts every active owner about a member SSO event (push when enabled) and
 * audits it with ids only. Best effort: never blocks the sign-in.
 */
function alertOwners(req, kind, subjectUserId) {
  let ownerIds = [];
  try {
    ownerIds = userDb.listActiveOwnerIds();
  } catch {
    logOidcFailure('owner_alert_lookup_failed');
  }
  for (const ownerId of ownerIds) {
    void notifyOwnerOfSsoEvent(ownerId, kind, subjectUserId);
  }
  auditLogDb.record('oidc_owner_alerted', {
    userId: subjectUserId,
    metadata: { provider: 'oidc', kind, ownerCount: ownerIds.length },
    ...auditContext(req),
  });
}

function recordProvisionRefused(req, reason) {
  auditLogDb.record('oidc_provision_refused', {
    userId: null,
    metadata: { provider: 'oidc', reason },
    ...auditContext(req),
  });
}

// Refusal code sent to the return page for each JIT decision that is not 'ready'.
const JIT_REFUSAL_ERRORS = Object.freeze({
  disabled: 'oidc_not_linked',
  allowlist_missing: 'oidc_not_linked',
  no_role: 'oidc_not_authorized',
  org_not_allowed: 'oidc_not_authorized',
});

/**
 * Login branch for a subject with no link (T-1939 slice 4): JIT-creates an
 * SSO-only account when every gate in services/oidc-jit-provision.js holds,
 * otherwise refuses. Never looks up or links an existing account.
 */
function signInUnknownSubject(req, res, { claims, subject, transaction }) {
  const nowMs = Date.now();
  const plan = planJitProvision({ claims, subject, projectId: roleProjectId(), nowMs });
  if (plan.outcome === 'capped') {
    auditLogDb.record('oidc_provision_capped', {
      userId: null, metadata: { provider: 'oidc' }, ...auditContext(req),
    });
    return redirectLoginRefusal(res, 'rate_limited');
  }
  if (plan.outcome !== 'ready') {
    if (plan.outcome === 'allowlist_missing') logOidcFailure('jit_allowlist_missing');
    if (plan.outcome !== 'disabled') recordProvisionRefused(req, plan.outcome);
    return redirectLoginRefusal(res, JIT_REFUSAL_ERRORS[plan.outcome]);
  }

  let created;
  try {
    created = provisionSsoUser({
      username: plan.username, role: plan.role, issuer: issuerUrl(), subject, nowMs,
    });
  } catch (error) {
    // A concurrent first sign-in of the same subject won the UNIQUE link;
    // retrying signs in to that account. Anything else is a write failure.
    recordProvisionRefused(req, isUniqueConflict(error) ? 'link_conflict' : 'write_failed');
    logOidcFailure('jit_provision_failed');
    return redirectLoginRefusal(res, 'temporarily_unavailable');
  }
  if (!created.created) {
    // Accepted disclosure: oidc_account_exists (vs oidc_not_linked) tells the
    // caller the derived username exists. Only a holder of a recognized role
    // granted by an allowed organization ever reaches this branch.
    recordProvisionRefused(req, created.reason);
    return redirectLoginRefusal(res, 'oidc_account_exists');
  }

  auditLogDb.record('oidc_user_provisioned', {
    userId: created.userId,
    metadata: { provider: 'oidc', identityId: created.identityId, role: plan.role },
    ...auditContext(req),
  });
  alertOwners(req, 'user_provisioned', created.userId);
  const user = userDb.getUserById(created.userId);
  if (!user) {
    return res.status(401).json({ error: 'Linked account is unavailable' });
  }
  return handOffSession(req, res, user, transaction);
}

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
  const transaction = readBrowserTransaction(req);
  if (typeof code !== 'string' || code.length === 0 || code.length > 4096) {
    // No code: the member cancelled at the IdP (?error=) or the reply is
    // malformed. The transaction is dead either way; a step-up still returns
    // to the SPA with a fixed code so its dialog learns the outcome.
    const { entry: abandoned, stalePurpose } = oidcPkceStore.consumeWithOutcome(state, transaction);
    if (abandoned?.purpose === 'step_up') {
      const cancelled = typeof req.query.error === 'string';
      recordStepUpFailure(req, abandoned.userId, cancelled ? 'provider_denied' : 'code_missing');
      return redirectStepUpRefusal(res, cancelled ? 'provider_denied' : 'temporarily_unavailable');
    }
    if (!abandoned) return redirectUnusableState(res, stalePurpose);
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  // Single-use consume: an expired or replayed state fails here, and the
  // browser returns to the SPA (never a raw JSON page).
  const { entry, stalePurpose } = oidcPkceStore.consumeWithOutcome(state, transaction);
  if (!entry) {
    return redirectUnusableState(res, stalePurpose);
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
      if (entry.purpose === 'step_up') {
        recordStepUpFailure(req, entry.userId, 'subject_missing');
        return redirectStepUpRefusal(res, 'temporarily_unavailable');
      }
      return res.status(401).json({ error: 'id_token missing subject' });
    }

    // T-1939 slice 5: the stored purpose alone decides the branch. A 'link'
    // transaction only ever links the account that started it; anything that
    // is not an explicit 'login' is refused rather than treated as one.
    if (entry.purpose === 'link') {
      return completeSelfLink(req, res, { entry, claims, subject, transaction });
    }
    if (entry.purpose === 'step_up') {
      return completeStepUp(req, res, { entry, claims, subject, transaction });
    }
    if (entry.purpose !== 'login') {
      return res.status(400).json({ error: 'Invalid or expired state' });
    }

    // An unknown subject is refused unless JIT creation is on and every one
    // of its gates holds (T-1939 slice 4).
    const identity = userIdentitiesDb.findByIssuerAndSubject(issuerUrl(), subject);
    if (!identity) {
      return signInUnknownSubject(req, res, { claims, subject, transaction });
    }
    // T-1939 slice 5: a legacy account holding two links for this issuer
    // blocked the UNIQUE(user_id, issuer) index; it stays out of SSO until the
    // owner removes the extra links (never auto-merged).
    if (userIdentitiesDb.countForUserAndIssuer(identity.user_id, issuerUrl()) > 1) {
      auditLogDb.record('oidc_login_blocked_duplicate_links', {
        userId: identity.user_id,
        metadata: { provider: 'oidc' },
        ...auditContext(req),
      });
      return res.status(409).json({
        error: 'oidc_duplicate_links',
        message: 'This account has more than one SSO link; ask the owner to remove the extra links',
      });
    }

    // getUserById returns only active (is_active=1, status='active') users.
    const linkedUser = userDb.getUserById(identity.user_id);
    if (!linkedUser) {
      return res.status(401).json({ error: 'Linked account is unavailable' });
    }
    // ADR-064/069: the verified role claim is an attestation; the shared mapper
    // decides the local role (never owner, never demotes an owner). Roles are read
    // ONLY from the project-scoped claim and, when OIDC_ALLOWED_ORG_IDS is set,
    // only from grants of allowed organizations. T-1939: no recognized role →
    // refused.
    const configuredProjectId = roleProjectId();
    const user = syncExternalRole({
      user: linkedUser,
      externalRoles: ssoRoleNames(claims, configuredProjectId),
      provider: 'oidc',
    }, { userDb, auditLogDb, onRoleApplied: revokeLiveAccessOnSsoRoleChange });
    if (user === null) {
      denyLoginWithoutRole(req, linkedUser, noRoleReason(claims, configuredProjectId));
      return redirectLoginRefusal(res, 'oidc_not_authorized');
    }
    if (!user) {
      return res.status(401).json({ error: 'Linked account is unavailable' });
    }

    // Stamp the attestation BEFORE any credential exists: a token minted for an
    // unstamped link would be refused as stale on first use (T-1939 slice 3).
    if (!stampAttestation(identity.id, user.id)) {
      logOidcFailure('attestation_stamp_failed');
      return res.status(500).json({ error: 'Sign-in could not be completed' });
    }

    return handOffSession(req, res, user, transaction);
  } catch (error) {
    logOidcFailure('callback_rejected');
    if (entry.purpose === 'step_up' && !res.headersSent) {
      recordStepUpFailure(req, entry.userId, 'provider_exchange_failed');
      return redirectStepUpRefusal(res, 'temporarily_unavailable');
    }
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
  const transaction = readBrowserTransaction(req);
  const redeemed = oidcCodeStore.consume(code, transaction);
  res.clearCookie(BROWSER_TRANSACTION_COOKIE, BROWSER_TRANSACTION_COOKIE_OPTIONS);
  if (!redeemed) {
    return res.status(401).json({ error: 'Invalid or expired code' });
  }
  return res.json({ token: redeemed.token, userId: redeemed.userId });
});

// ---------------------------------------------------------------------------
// Member self-link (T-1939 slice 5)
// ---------------------------------------------------------------------------

// Guards the password check on self-link start: per account, not per IP, and
// mounted BEFORE the argon2 verification so a guesser pays nothing.
const oidcSelfLinkLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 5,
  message: 'Too many attempts, please try again later',
  code: 'oidc_self_link_rate_limited',
  key: (req) => `oidc-self-link:${req.user?.id ?? 'none'}`,
});

// Answers 501 before authentication, exactly like the other OIDC routes.
function requireOidcEnabled(req, res, next) {
  if (!oidcEnabled()) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }
  return next();
}

function recordSelfLinkFailure(req, userId, reason) {
  auditLogDb.record('oidc_identity_self_link_failed', {
    userId: userId ?? null,
    metadata: { reason },
    ...auditContext(req),
  });
}

/**
 * Verifies the caller's own current password for self-link start. Returns
 * null on success, else the refusal to send. The body never carries a session
 * rejection shape: a wrong password is `current_password_incorrect` (see
 * SESSION_REJECTION_CODES in src/utils/api.js), so a typo never signs out.
 */
async function selfLinkPasswordRefusal(req, currentPassword) {
  const account = userDb.getRawById(req.user.id);
  if (!account || !userDb.getUserById(req.user.id)) {
    recordSelfLinkFailure(req, req.user.id, 'account_unavailable');
    return { status: 403, body: { error: 'Account unavailable', code: 'account_unavailable' } };
  }
  if (account.must_change_password === 1) {
    recordSelfLinkFailure(req, req.user.id, 'password_change_required');
    return {
      status: 403,
      body: { error: 'Change your password first', code: 'password_change_required' },
    };
  }
  const isValid = typeof account.password_hash === 'string'
    && await verifyPassword(account.password_hash, currentPassword);
  if (!isValid) {
    recordSelfLinkFailure(req, req.user.id, 'bad_current_password');
    return {
      status: 401,
      body: { error: 'Current password is incorrect', code: 'current_password_incorrect' },
    };
  }
  return null;
}

// Whether the caller's own account holds an SSO link (drives the profile UI).
// `ssoStepUp` is the exact predicate POST /step-up/start admits on (the
// SSO-only policy), so the client never has to infer the step-up method.
router.get('/link/self', requireOidcEnabled, authenticateToken, (req, res) => {
  setNoStore(res);
  return res.json({
    linked: userIdentitiesDb.countForUserAndIssuer(req.user.id, issuerUrl()) > 0,
    ssoStepUp: requiresSsoLogin(userDb.getUserById(req.user.id)),
  });
});

// Starts a self-link for the caller's OWN account. Password first (rate limited
// per account), then a 'link' PKCE transaction bound to this user id and this
// browser, with prompt=login&max_age=0 so the IdP must re-authenticate.
router.post(
  '/link/self/start',
  requireOidcEnabled,
  authenticateToken,
  oidcSelfLinkLimiter,
  async (req, res) => {
    setNoStore(res);
    const { currentPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || currentPassword.length === 0 || currentPassword.length > 1024) {
      return res.status(400).json({ error: 'Current password is required', code: 'current_password_required' });
    }
    const refusal = await selfLinkPasswordRefusal(req, currentPassword);
    if (refusal) {
      return res.status(refusal.status).json(refusal.body);
    }
    if (userIdentitiesDb.countForUserAndIssuer(req.user.id, issuerUrl()) > 0) {
      return res.status(409).json({ error: 'Account is already linked', code: 'already_linked' });
    }
    try {
      const authorizationUrl = await beginAuthorization(
        res,
        { purpose: 'link', userId: req.user.id, requestedAtMs: Date.now() },
        { prompt: 'login', max_age: '0' },
      );
      if (!authorizationUrl) {
        return res.status(503).json({ error: 'Identity provider temporarily unavailable' });
      }
      return res.json({ authorizationUrl });
    } catch {
      logOidcFailure('self_link_unavailable');
      return res.status(502).json({ error: 'Identity provider unavailable' });
    }
  },
);

/**
 * Checks that must all pass before a self-link writes anything: a fresh IdP
 * sign-in (auth_time), a still-active account, a recognized project role, and
 * a subject/issuer pair not yet linked. Returns null, or the refusal to send
 * (reason is audited; ids only, never the subject).
 */
function selfLinkRefusal({ entry, claims, subject, nowMs }) {
  const authFailure = selfLinkAuthTimeFailure({
    authTimeMs: idTokenAuthTimeMs(claims),
    requestedAtMs: entry.requestedAtMs,
    nowMs,
  });
  if (authFailure) {
    return { status: 401, reason: authFailure, error: 'oidc_reauth_required',
      message: 'Sign in again at the identity provider to link this account' };
  }
  const user = userDb.getUserById(entry.userId);
  if (!user) {
    return { status: 401, reason: 'account_unavailable', error: 'account_unavailable',
      message: 'Linked account is unavailable' };
  }
  const projectId = roleProjectId();
  if (reconcileLocalRole(user.role, ssoRoleNames(claims, projectId)).role === null) {
    return { status: 403,
      reason: noRoleReason(claims, projectId),
      error: 'oidc_not_authorized', message: 'This identity has no role on this nassaj project' };
  }
  const existing = userIdentitiesDb.findByIssuerAndSubject(issuerUrl(), subject);
  if (existing) {
    return { status: 409, reason: 'subject_taken', error: 'oidc_subject_taken',
      message: 'This identity is already linked to a nassaj account' };
  }
  if (userIdentitiesDb.countForUserAndIssuer(entry.userId, issuerUrl()) > 0) {
    return { status: 409, reason: 'already_linked', error: 'already_linked',
      message: 'This account is already linked' };
  }
  return { user };
}

/** Owner linked their own account: WARN log, dedicated audit row, direct alert. */
function flagOwnerAccountLinked(req, ownerId) {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'oidc', code: 'owner_account_self_linked' })}\n`);
  auditLogDb.record('oidc_owner_account_linked', {
    userId: ownerId,
    metadata: { provider: 'oidc' },
    ...auditContext(req),
  });
  void notifyOwnerOfSsoEvent(ownerId, 'owner_account_linked', ownerId);
}

/**
 * Callback branch for a 'link' transaction: links the verified subject to the
 * account that started the transaction (entry.userId) — never to anyone else
 * and never by looking the subject up — then signs that account in through the
 * ordinary one-time-code hand-off.
 */
function completeSelfLink(req, res, { entry, claims, subject, transaction }) {
  const nowMs = Date.now();
  const checked = selfLinkRefusal({ entry, claims, subject, nowMs });
  if (!checked.user) {
    recordSelfLinkFailure(req, entry.userId, checked.reason);
    return res.status(checked.status).json({ error: checked.error, message: checked.message });
  }

  let identityId;
  try {
    identityId = linkIdentityWithAttestation({
      userId: entry.userId, issuer: issuerUrl(), subject, attestedAtMs: nowMs,
    });
  } catch (error) {
    const conflict = isUniqueConflict(error);
    recordSelfLinkFailure(req, entry.userId, conflict ? 'link_conflict' : 'link_failed');
    if (conflict) {
      return res.status(409).json({ error: 'oidc_subject_taken', message: 'This identity is already linked' });
    }
    logOidcFailure('self_link_write_failed');
    return res.status(500).json({ error: 'Linking could not be completed' });
  }

  // Same mapper as login: the attested role becomes the local role (never
  // owner, never demotes an owner). The role was checked above.
  const user = syncExternalRole({
    user: checked.user,
    externalRoles: ssoRoleNames(claims, roleProjectId()),
    provider: 'oidc',
  }, { userDb, auditLogDb, onRoleApplied: revokeLiveAccessOnSsoRoleChange });

  auditLogDb.record('oidc_identity_self_linked', {
    userId: entry.userId,
    metadata: { provider: 'oidc', identityId },
    ...auditContext(req),
  });
  if (checked.user.role === 'owner') {
    flagOwnerAccountLinked(req, entry.userId);
  } else {
    alertOwners(req, 'member_linked', entry.userId);
  }
  if (!user) {
    return res.status(401).json({ error: 'Linked account is unavailable' });
  }
  return handOffSession(req, res, user, transaction);
}

// ---------------------------------------------------------------------------
// Member step-up (T-1939 slice 6B)
// ---------------------------------------------------------------------------

const STEP_UP_AUDIENCE = 'connector_owner';

function recordStepUpFailure(req, userId, reason) {
  auditLogDb.record('oidc_step_up_failed', {
    userId: userId ?? null,
    metadata: { provider: 'oidc', reason },
    ...auditContext(req),
  });
}

// Step-up redirects carry a one-time grant or a fixed code in the query: no
// caching and no Referer leak of the return URL.
function setStepUpRedirectHeaders(res) {
  setNoStore(res);
  res.set('Referrer-Policy', 'no-referrer');
}

// Refusals travel as a fixed code only, like login refusals.
function redirectStepUpRefusal(res, errorCode) {
  setStepUpRedirectHeaders(res);
  return res.redirect(`${RETURN_PATH}?oidc_step_up_error=${encodeURIComponent(errorCode)}`);
}

/**
 * Callback answer for a state that is unknown, expired, or bound to another
 * browser (the in-memory PKCE store also forgets everything on restart). A
 * step-up whose transaction was still known returns to the step-up dialog as
 * oidc_reauth_required; everything else returns to the sign-in page with a
 * fixed code it already renders. Nothing about the state is echoed.
 */
function redirectUnusableState(res, stalePurpose) {
  if (stalePurpose === 'step_up') return redirectStepUpRefusal(res, 'oidc_reauth_required');
  return redirectLoginRefusal(res, stalePurpose ? 'transaction_expired' : 'invalid_state');
}

/**
 * Why the caller cannot start an IdP step-up, or null. Only an active
 * SSO-linked member (the accounts refused a local step-up) may start one.
 */
function stepUpStartRefusal(userId) {
  const user = userDb.getUserById(userId);
  if (!user) {
    return { status: 401, body: { error: 'Verification failed', code: 'step_up_failed' } };
  }
  if (!requiresSsoLogin(user)) {
    return { status: 409, body: { error: 'Use your password or passkey to confirm', code: 'sso_step_up_not_applicable' } };
  }
  const currentIssuerLinks = userIdentitiesDb.countForUserAndIssuer(userId, issuerUrl());
  if (currentIssuerLinks === 0) {
    // SSO-only (a link under a previous issuer) but nothing the current IdP
    // can prove: refused up front with its own code, not after an IdP trip.
    return { status: 409, body: { error: 'SSO link belongs to a previous identity provider', code: 'oidc_issuer_changed' } };
  }
  if (currentIssuerLinks > 1) {
    return { status: 409, body: { error: 'oidc_duplicate_links', code: 'oidc_duplicate_links' } };
  }
  return null;
}

const STEP_UP_UNAVAILABLE = Object.freeze({
  error: 'Verification temporarily unavailable', code: 'temporarily_unavailable',
});

/**
 * Local admission for an IdP step-up: eligibility, then one attempt on the
 * shared per-user step-up quota. Returns the refusal to send, or null.
 */
function stepUpStartAdmission(req) {
  const refusal = stepUpStartRefusal(req.user.id);
  if (refusal) {
    recordStepUpFailure(req, req.user.id, refusal.body.code);
    return refusal;
  }
  const verdict = consumeStepUpAttempt(req.user.id);
  if (!verdict.allowed) {
    recordStepUpFailure(req, req.user.id, 'rate_limited');
    return {
      status: 429,
      retryAfterSeconds: verdict.retryAfterSeconds,
      body: { error: 'Too many verification attempts, please try again later', code: 'step_up_rate_limited' },
    };
  }
  return null;
}

// Starts an IdP re-authentication for the caller's own step-up. Counted on the
// shared per-user step-up quota BEFORE any IdP discovery. Every failure
// answers with a coded body; nothing is left hanging.
router.post('/step-up/start', requireOidcEnabled, authenticateToken, async (req, res) => {
  setNoStore(res);
  try {
    const refusal = stepUpStartAdmission(req);
    if (refusal) {
      if (refusal.retryAfterSeconds) res.set('Retry-After', String(refusal.retryAfterSeconds));
      return res.status(refusal.status).json(refusal.body);
    }
  } catch {
    logOidcFailure('step_up_start_unavailable');
    return res.status(503).json(STEP_UP_UNAVAILABLE);
  }
  try {
    const authorizationUrl = await beginAuthorization(
      res,
      { purpose: 'step_up', userId: req.user.id, audience: STEP_UP_AUDIENCE, requestedAtMs: Date.now() },
      { prompt: 'login', max_age: '0' },
    );
    if (!authorizationUrl) {
      return res.status(503).json(STEP_UP_UNAVAILABLE);
    }
    auditLogDb.record('oidc_step_up_started', {
      userId: req.user.id, metadata: { provider: 'oidc', audience: STEP_UP_AUDIENCE }, ...auditContext(req),
    });
    return res.json({ authorizationUrl });
  } catch {
    logOidcFailure('step_up_unavailable');
    if (res.headersSent) return undefined;
    return res.status(502).json({ error: 'Identity provider unavailable', code: 'temporarily_unavailable' });
  }
});

/**
 * Checks that must pass before a step-up grant: fresh auth_time, the verified
 * subject linked to the SAME member (single link), and an active account.
 * Returns the identity and user, or { reason, error } to refuse.
 */
function stepUpRefusal({ entry, subject, claims, nowMs }) {
  const authFailure = stepUpAuthTimeFailure({
    authTimeMs: idTokenAuthTimeMs(claims), requestedAtMs: entry.requestedAtMs, nowMs,
  });
  if (authFailure) return { reason: authFailure, error: 'oidc_reauth_required' };
  const identity = userIdentitiesDb.findByIssuerAndSubject(issuerUrl(), subject);
  if (!identity || identity.user_id !== entry.userId) {
    return { reason: 'identity_mismatch', error: 'oidc_step_up_identity_mismatch' };
  }
  if (userIdentitiesDb.countForUserAndIssuer(entry.userId, issuerUrl()) > 1) {
    return { reason: 'duplicate_links', error: 'oidc_duplicate_links' };
  }
  const linkedUser = userDb.getUserById(entry.userId);
  if (!linkedUser) return { reason: 'account_unavailable', error: 'account_unavailable' };
  return { identity, linkedUser };
}

/**
 * Callback branch for a 'step_up' transaction: never signs anyone in. The
 * attested role goes through the same mapper as login (no recognized role →
 * refused and access withdrawn, exactly as a login would), the attestation is
 * stamped, and a one-time grant bound to member + audience + this browser
 * transaction is handed to the SPA return page.
 */
function completeStepUp(req, res, { entry, claims, subject, transaction }) {
  const checked = stepUpRefusal({ entry, subject, claims, nowMs: Date.now() });
  if (!checked.linkedUser) {
    recordStepUpFailure(req, entry.userId, checked.reason);
    return redirectStepUpRefusal(res, checked.error);
  }
  const projectId = roleProjectId();
  const user = syncExternalRole({
    user: checked.linkedUser,
    externalRoles: ssoRoleNames(claims, projectId),
    provider: 'oidc',
  }, { userDb, auditLogDb, onRoleApplied: revokeLiveAccessOnSsoRoleChange });
  if (user === null) {
    const reason = noRoleReason(claims, projectId);
    denyLoginWithoutRole(req, checked.linkedUser, reason);
    recordStepUpFailure(req, entry.userId, reason);
    return redirectStepUpRefusal(res, 'oidc_not_authorized');
  }
  if (!user || !stampAttestation(checked.identity.id, entry.userId)) {
    recordStepUpFailure(req, entry.userId, 'attestation_failed');
    return redirectStepUpRefusal(res, 'temporarily_unavailable');
  }
  const grant = oidcStepUpGrantStore.issue({
    userId: entry.userId, audience: entry.audience, browserTransaction: transaction,
  });
  if (!grant) {
    logOidcFailure('step_up_grant_store_full');
    recordStepUpFailure(req, entry.userId, 'grant_unavailable');
    return redirectStepUpRefusal(res, 'temporarily_unavailable');
  }
  auditLogDb.record('oidc_step_up_verified', {
    userId: entry.userId, metadata: { provider: 'oidc', audience: entry.audience }, ...auditContext(req),
  });
  setStepUpRedirectHeaders(res);
  return res.redirect(`${RETURN_PATH}?oidc_step_up=${encodeURIComponent(grant)}`);
}

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
    revokeApiKeysForSsoWithdrawal(identity.user_id, 'backchannel_logout');
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
// Identity unlinking (authenticated). There is deliberately NO admin "link"
// route (B-1410): an administrator attaching an IdP subject they control to
// another account — the owner included — is an account takeover with a JWT
// alone. Linking will only ever be done by the member themself.
// ---------------------------------------------------------------------------

// Target roles an owner may unlink: strictly lower rank only (same fail-closed
// allowlist shape as RESETTABLE_TARGET_ROLES in routes/auth.js). Owner→owner is
// refused; owner→self goes through DELETE /link/self with a password.
const UNLINKABLE_TARGET_ROLES = Object.freeze({
  owner: new Set(['admin', 'user']),
});

// Unlinking ends every live session of the account. Running turns are left
// alone (they may be the account holder's own work); shells and terminals end,
// and every socket reconnects against the bumped password stamp.
const IDENTITY_UNLINK_REVOCATION = Object.freeze({
  abortReason: null,
  endInteractiveSessions: true,
});

// Guards the password check on self-unlink: per account, not per IP.
const oidcSelfUnlinkLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 5,
  message: 'Too many attempts, please try again later',
  code: 'oidc_self_unlink_rate_limited',
  key: (req) => `oidc-self-unlink:${req.user?.id ?? 'none'}`,
});

function auditContext(req) {
  return { ipAddress: clientIp(req), userAgent: req.headers['user-agent'] ?? null };
}

/**
 * Removes every IdP link of `userId` and bumps its password stamp in ONE
 * transaction: a failed unlink leaves the sessions untouched, and a failed
 * stamp leaves the links in place. Throws on failure.
 */
function unlinkAndRevokeSessions(userId) {
  getConnection().transaction(() => {
    userIdentitiesDb.unlinkAll(userId);
    stampSessionsRevoked(userId);
  })();
  invalidateRefreshCache(userId);
}

/**
 * B-1327 pattern: the database change already committed, so cutting the live
 * WS/SSE/turns is best effort — a failure is logged and never blocks the audit
 * record or the response.
 */
function revokeLiveAccessAfterUnlink(userId) {
  try {
    revokeUserIdentity(userId, IDENTITY_UNLINK_REVOCATION);
  } catch {
    logOidcFailure('unlink_live_revocation_failed');
  }
}

// Owner self-unlink (B-1410 C1): removes a link planted on the owner account.
// Declared before /link/:userId so "self" is never parsed as a user id.
router.delete(
  '/link/self',
  authenticateToken,
  requireRole('owner'),
  oidcSelfUnlinkLimiter,
  async (req, res) => {
    const { currentPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      return res.status(400).json({ error: 'Current password is required' });
    }

    const account = userDb.getRawById(req.user.id);
    // An SSO-only account has no local credential to prove; unlinking itself
    // would leave it unable to sign in at all (T-1939 slice 4).
    if (isSsoOnlyPasswordHash(account?.password_hash)) {
      auditLogDb.record('oidc_identity_self_unlink_failed', {
        userId: req.user.id,
        metadata: { reason: 'sso_only_account' },
        ...auditContext(req),
      });
      return res.status(409).json({
        error: 'This account signs in only through SSO and cannot remove its link',
        code: 'sso_only_account',
      });
    }
    const isValid = typeof account?.password_hash === 'string'
      && await verifyPassword(account.password_hash, currentPassword);
    if (!isValid) {
      // Never log the password — the reason code only.
      auditLogDb.record('oidc_identity_self_unlink_failed', {
        userId: req.user.id,
        metadata: { reason: account ? 'bad_current_password' : 'user_not_found' },
        ...auditContext(req),
      });
      // `code` is required: a code-less 401 is the auth middleware's own shape
      // for "your nassaj session is invalid" (see SESSION_REJECTION_CODES in
      // src/utils/api.js), and without it a wrong-password typo here would
      // sign the owner out of their whole session instead of just failing the
      // unlink attempt.
      return res
        .status(401)
        .json({ error: 'Current password is incorrect', code: 'current_password_incorrect' });
    }

    try {
      unlinkAndRevokeSessions(req.user.id);
    } catch {
      logOidcFailure('identity_self_unlink_failed');
      auditLogDb.record('oidc_identity_self_unlink_failed', {
        userId: req.user.id,
        metadata: { reason: 'unlink_failed' },
        ...auditContext(req),
      });
      return res.status(500).json({ error: 'Unable to unlink identity' });
    }
    revokeLiveAccessAfterUnlink(req.user.id);

    auditLogDb.record('oidc_identity_self_unlinked', {
      userId: req.user.id,
      metadata: { provider: 'oidc' },
      ...auditContext(req),
    });
    return res.status(200).json({ message: 'Unlinked' });
  },
);

// Removes ALL IdP links of a strictly lower-ranked user (owner only).
router.delete('/link/:userId', authenticateToken, requireRole('owner'), (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'A valid userId is required' });
  }

  // Existence first, so an unknown id is a 404, never a rank decision.
  const target = userDb.getRawById(userId);
  if (!target) {
    return res.status(404).json({ error: 'Target user not found' });
  }

  const callerOutranksTarget = userId !== req.user.id
    && UNLINKABLE_TARGET_ROLES[req.user.role]?.has(target.role) === true;
  if (!callerOutranksTarget) {
    auditLogDb.record('insufficient_role', {
      userId: req.user.id,
      metadata: {
        required: 'strictly_higher_than_target',
        actual: req.user.role ?? null,
        targetUserId: userId,
        targetRole: target.role ?? null,
        context: 'oidc_unlink',
      },
      ...auditContext(req),
    });
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  try {
    unlinkAndRevokeSessions(userId);
  } catch {
    logOidcFailure('identity_unlink_failed');
    return res.status(500).json({ error: 'Unable to unlink identity' });
  }
  revokeLiveAccessAfterUnlink(userId);

  // A JIT account has no local credential: once unlinked it cannot sign in
  // until it is linked again or the owner resets its password (T-1939 slice 4).
  const ssoOnlyAccount = isSsoOnlyPasswordHash(target.password_hash);
  auditLogDb.record('oidc_identity_unlinked', {
    userId: req.user.id,
    metadata: { targetUserId: userId, ...(ssoOnlyAccount ? { ssoOnlyAccount: true } : {}) },
    ...auditContext(req),
  });

  if (ssoOnlyAccount) {
    return res.status(200).json({
      message: 'Unlinked',
      note: 'sso_only_account_cannot_sign_in',
      detail: 'This account has no password; it cannot sign in until you reset its password',
    });
  }
  return res.status(200).json({ message: 'Unlinked' });
});

export default router;
