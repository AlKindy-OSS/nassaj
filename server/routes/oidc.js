/**
 * OIDC Relying Party routes (P-IDP-3, ADR-046).
 *
 * Mounted under /api/auth/oidc by routes/auth.js. Implements the
 * authorization-code + PKCE (S256) flow against the OpenID Provider configured
 * in the SSO settings rows (ADR-194 D3; never OIDC_* env). The client is
 * public (PKCE only) or confidential (client_secret_basic / _post, the secret
 * decrypted only for the token request). Issuer, client id, redirect URI and
 * the pinned authorization, token and JWKS endpoints all come from the row.
 *
 * Browser-facing (front channel):
 *   GET    /login            → 302 to the IdP authorization endpoint
 *   GET    /callback         → 302 to /auth/oidc/return?oidc_code=<code>
 *                               (login refusals: ?error=<oidc_* code>; an unknown or
 *                               expired state: ?error=invalid_state / transaction_expired)
 *   POST   /exchange          → { token, userId }  (SPA trades code for JWT)
 *                               MULTI_ACCOUNT_SWITCHING: { wallet, csrfToken } and a
 *                               new device cookie instead (ADR-163 amendment 1, A-1)
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
 *     an unknown subject is refused with oidc_not_linked unless the active SSO
 *     config enables JIT (default off) with a tenant restriction, in which case
 *     a verified mapped role that passes that restriction creates an SSO-only
 *     account. A subject is never linked to an existing account by e-mail or
 *     username; a username clash is refused with oidc_account_exists.
 *   - The minted JWT NEVER appears in a redirect URL. /callback stashes it in a
 *     1-minute one-time code store and redirects with only an opaque code, which
 *     the SPA immediately redeems at /exchange.
 *   - Only the pinned endpoints are used at runtime, through pinnedFetchJson
 *     (DNS pinning, the D7 address matrix, no redirects, size and time caps).
 *     A discovery refresh only detects drift; drift persists
 *     runtime_fault = discovery_endpoint_changed and SSO becomes unavailable.
 *   - Callback order (ADR-194 D2): consume the PKCE entry first (also on
 *     ?error=), select the verifier by the entry's binding (draft for `test`,
 *     active config otherwise), then RFC 9207 on the selected config. A `test`
 *     entry ends in completeTestSignIn and never reaches a session, link,
 *     role, attestation, provisioning or grant write.
 *   - Version fence (D9): the privileged writes run in one immediate
 *     transaction with the version check; the one-time code or step-up grant
 *     is dropped when the version moved after it was minted.
 *   - The owner signs in locally only (I6): an owner identity is refused in
 *     the login and self-link branches, and back-channel logout never
 *     revokes an owner.
 *   - id_token and logout_token signatures and registered OIDC claims are
 *     verified before any identity lookup or revocation side effect.
 *   - Roles (ADR-194 D4/D5): the verified id_token claim at the active config's
 *     role claim path is mapped by its rules on every login; owner is
 *     local-only. The tenant restriction (claim, or role grant scope) applies
 *     to EVERY sign-in, self-link and step-up, not only to JIT creation.
 *     T-1939: no recognized role → 403 oidc_not_authorized (never a downgrade);
 *     a successful login stamps user_identities.last_attested_at.
 *
 * Gated by the SSO state model (services/sso-config.service.js, ADR-194 D1):
 * the start routes answer 501 unless ssoLoginAvailable(); the callback checks
 * it only for non-test purposes; the back channel answers while the policy is
 * enforced, with 503 + Retry-After when it cannot verify, so an IdP
 * withdrawal is retried instead of dropped.
 */

import crypto from 'crypto';

import express from 'express';

import * as authMiddleware from '../middleware/auth.js';
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
import { isTrustedOrigin, multiAccountSwitchingEnabled } from '../utils/trusted-origin.js';
import { clearPasswordChangeCookie, issueDeviceSession } from '../modules/account-wallet/issue-device-session.js';
import { userSsoAttestationFresh } from '../services/sso-attestation.js';
import { oidcPkceStore } from '../services/oidc-pkce.store.js';
import { oidcCodeStore } from '../services/oidc-code.store.js';
import { reconcileLocalRole, syncExternalRole } from '../services/external-role-mapper.js';
import { safeOauthError } from '../modules/net/pinned-fetch.js';
import { ssoLoginAvailable } from '../services/sso-config.service.js';
import {
  activeSsoClient,
  activeVersionStillIs,
  backchannelSsoVerifier,
  currentActiveVersion,
  draftSsoClient,
  draftTestBinding,
  runUnderVersionFence,
  SSO_FENCE_REFUSED,
} from '../services/sso-oidc-runtime.service.js';
import { evaluateSsoClaims, MAPPING_UNAVAILABLE_REASON } from '../services/sso-role-mapping.js';
import { completeTestSignIn, recordTestFailure } from '../services/sso-test-signin.service.js';
import { planJitProvision, provisionSsoUser } from '../services/oidc-jit-provision.js';
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
import { idTokenAuthTimeMs } from '../services/oidc-verifier.service.js';

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

// Owner SSO settings tab (S7); test sign-in outcomes return here with the
// one-time display id (`ssoTest`) or a fixed refusal code (`ssoTestError`).
const SETTINGS_SSO_PATH = '/?settings=sso';
const OWNER_LOCAL_ONLY = 'owner_must_sign_in_locally';

// ---------------------------------------------------------------------------
// Config helpers (ADR-194: the SSO configuration rows, never OIDC_* env)
// ---------------------------------------------------------------------------

/** The active row's issuer (identities are keyed by it), or null while SSO is unavailable. */
function activeIssuer() {
  return activeSsoClient()?.issuer ?? null;
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
 * API key they hold is deleted. A back-channel logout is included on purpose:
 * The identity provider sends one when it deactivates a user, and it cannot be told apart
 * from an ordinary sign-out (coordinator decision, T-1946 round 2). The T-1946
 * attestation window covers only the quiet case (no sign-in for N days), where
 * keys are kept and revive on the next SSO sign-in. The owner (local
 * break-glass) is never governed by the IdP. Audited with a count only; a
 * failure is logged and never blocks the caller's own response.
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

/**
 * T-1939: an SSO login whose attestation carries no recognized project role is
 * refused — never downgraded. The grant withdrawal also ends the member's
 * existing tokens and live work; the local account itself is left enabled and
 * unchanged, so re-granting the role in the IdP restores access. Callers run
 * it inside the version fence (ADR-194 D9), and never for an owner (owners
 * are refused before any mapping, I6).
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
 * under `state` with the purpose binding, and returns the IdP authorization
 * URL — or null when the bounded PKCE store is full (the caller answers 503).
 * Every endpoint, the redirect URI and the scope come from the selected
 * config row (ADR-194 D3); an active-config entry also binds its version
 * (D9). Before using the pinned authorization endpoint the active verifier
 * checks for discovery drift (throws discovery_endpoint_changed).
 */
async function beginAuthorization(res, client, binding, extraParams = {}) {
  if (client.slot === 'active') await client.verifier.checkDiscoveryDrift();
  const authorizationEndpoint = await client.verifier.authorizationEndpoint();

  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken();
  const transaction = randomToken();
  const fullBinding = client.slot === 'active' ? { ...binding, configVersion: client.version } : binding;
  if (!oidcPkceStore.store(state, { nonce, codeVerifier, browserTransaction: transaction, ...fullBinding })) {
    logOidcFailure('pkce_store_full');
    return null;
  }
  res.cookie(BROWSER_TRANSACTION_COOKIE, transaction, {
    ...BROWSER_TRANSACTION_COOKIE_OPTIONS,
    maxAge: 10 * 60_000,
  });
  setNoStore(res);

  const authUrl = new URL(authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.clientId);
  authUrl.searchParams.set('redirect_uri', client.redirectUri);
  authUrl.searchParams.set('scope', client.scope);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', codeChallengeFor(codeVerifier));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  for (const [name, value] of Object.entries(extraParams)) {
    authUrl.searchParams.set(name, value);
  }
  return authUrl.toString();
}

/**
 * Service half of POST /api/settings/sso/draft/test-login/start (the owner
 * route is S4): a `test` PKCE entry bound to the owner, the draft hash and the
 * draft_version, against the draft's pinned endpoints. Does not require
 * ssoLoginAvailable(). Returns `{ authorizationUrl }` or `{ refusal }`.
 * @param {import('express').Response} res
 * @param {number} ownerUserId
 */
export async function beginTestAuthorization(res, ownerUserId) {
  const binding = draftTestBinding();
  if (binding.refusal) return { refusal: binding.refusal };
  const testEntry = { purpose: 'test', ownerUserId, configHash: binding.configHash, draftVersion: binding.draftVersion };
  const draft = draftSsoClient(testEntry);
  if (draft.refusal) return { refusal: draft.refusal };
  const authorizationUrl = await beginAuthorization(res, draft.client, testEntry);
  return authorizationUrl ? { authorizationUrl } : { refusal: 'temporarily_unavailable' };
}

const SAME_SITE_FETCH = new Set(['same-origin', 'none']);

/**
 * Wallet mode (ADR-163 amendment 1, B-1529 gate L2): a primary SSO login may
 * replace this browser's device session, so it must start from the app itself
 * or a typed URL. A navigation the browser marks cross-site or same-site
 * (Sec-Fetch-Site) is refused before any transaction cookie or state exists.
 * A browser that sends no Sec-Fetch-Site is not refused here.
 */
function crossSiteLoginStart(req) {
  if (!multiAccountSwitchingEnabled()) return false;
  const site = req.get('sec-fetch-site');
  return typeof site === 'string' && !SAME_SITE_FETCH.has(site);
}

// Kicks off the authorization-code + PKCE flow and redirects the browser to
// the IdP. Always a 'login' transaction: it can never link an identity.
router.get('/login', oidcLoginLimiter, async (req, res) => {
  const client = ssoLoginAvailable() ? activeSsoClient() : null;
  if (!client) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }
  if (crossSiteLoginStart(req)) {
    logOidcFailure('login_not_initiated');
    return redirectLoginRefusal(res, 'oidc_login_not_initiated');
  }
  try {
    const authorizationUrl = await beginAuthorization(res, client, { purpose: 'login' });
    if (!authorizationUrl) {
      return res.status(503).json({ error: 'Identity provider temporarily unavailable' });
    }
    return res.redirect(authorizationUrl);
  } catch {
    logOidcFailure('login_unavailable');
    return res.status(502).json({ error: 'Identity provider unavailable' });
  }
});

/**
 * Mints the JWT, parks it behind a one-minute one-time code bound to this
 * browser transaction, and redirects to the SPA return page (never the JWT).
 * In wallet mode no JWT is minted: the code carries `{ userId, configVersion }`
 * and /exchange issues the device session (ADR-163 amendment 1, A-1).
 * ADR-194 D9: after the code is stored the active version is read again; if
 * an apply landed meanwhile the code is dropped and the login refused.
 */
function handOffSession(req, res, user, transaction, configVersion) {
  const walletMode = multiAccountSwitchingEnabled();
  const grant = walletMode ? { configVersion } : { token: generateToken(user) };
  const oneTimeCode = randomToken();
  if (!oidcCodeStore.store(oneTimeCode, { ...grant, userId: user.id, browserTransaction: transaction })) {
    logOidcFailure('code_store_full');
    return res.status(503).json({ error: 'Identity provider temporarily unavailable' });
  }
  if (!activeVersionStillIs(configVersion)) {
    oidcCodeStore.discard(oneTimeCode);
    return redirectLoginRefusal(res, 'oidc_config_changed');
  }

  // Wallet mode records the login at /exchange, after the device is issued.
  if (!walletMode) recordOidcLogin(req, user.id);
  setNoStore(res);
  return res.redirect(`${RETURN_PATH}?oidc_code=${encodeURIComponent(oneTimeCode)}`);
}

/** Last-login and the oidc_login audit for a session that was actually handed out. */
function recordOidcLogin(req, userId) {
  userDb.updateLastLogin(userId);
  auditLogDb.record('oidc_login', {
    userId,
    metadata: { provider: 'oidc' },
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });
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
 * ADR-194 I6: an IdP identity bound to an owner never signs in or links; the
 * owner signs in locally only. Audited (purpose only); nothing else is written.
 */
function refuseOwnerIdentity(req, res, userId, purpose) {
  auditLogDb.record('oidc_owner_sign_in_refused', {
    userId, metadata: { provider: 'oidc', purpose }, ...auditContext(req),
  });
  return redirectLoginRefusal(res, OWNER_LOCAL_ONLY);
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
  tenant_restriction_missing: 'oidc_not_linked',
  no_role: 'oidc_not_authorized',
  tenant_not_allowed: 'oidc_not_authorized',
  email_unverified: 'oidc_not_authorized',
  claim_too_large: 'oidc_not_authorized',
});

/** The JIT write inside the version fence; SSO_FENCE_REFUSED when the config moved. */
function provisionFenced(entry, plan, { client, subject, nowMs }) {
  return runUnderVersionFence(entry.configVersion, () => provisionSsoUser({
    username: plan.username, role: plan.role, issuer: client.issuer, subject, nowMs,
  }));
}

/**
 * Login branch for a subject with no link (T-1939 slice 4): JIT-creates an
 * SSO-only account when every gate in services/oidc-jit-provision.js holds,
 * otherwise refuses. Never looks up or links an existing account.
 */
function signInUnknownSubject(req, res, { entry, claims, subject, transaction, client }) {
  const nowMs = Date.now();
  const plan = planJitProvision({ claims, subject, nowMs });
  if (plan.outcome === 'capped') {
    auditLogDb.record('oidc_provision_capped', {
      userId: null, metadata: { provider: 'oidc' }, ...auditContext(req),
    });
    return redirectLoginRefusal(res, 'rate_limited');
  }
  if (plan.outcome !== 'ready') {
    if (plan.outcome === 'tenant_restriction_missing') logOidcFailure('jit_tenant_restriction_missing');
    if (plan.outcome !== 'disabled') recordProvisionRefused(req, plan.outcome);
    return redirectLoginRefusal(res, JIT_REFUSAL_ERRORS[plan.outcome]);
  }

  let created;
  try {
    created = provisionFenced(entry, plan, { client, subject, nowMs });
  } catch (error) {
    // A concurrent first sign-in of the same subject won the UNIQUE link;
    // retrying signs in to that account. Anything else is a write failure.
    recordProvisionRefused(req, isUniqueConflict(error) ? 'link_conflict' : 'write_failed');
    logOidcFailure('jit_provision_failed');
    return redirectLoginRefusal(res, 'temporarily_unavailable');
  }
  if (created === SSO_FENCE_REFUSED) return redirectLoginRefusal(res, 'oidc_config_changed');
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
  return handOffSession(req, res, user, transaction, entry.configVersion);
}

/**
 * Inside the version fence: the role sync, the denial revocation and the
 * attestation stamp for an existing link (ADR-194 D9). Returns
 * `{ user }`, `{ refusal }` or `{ status, error }`.
 */
function applyLoginDecision(req, { linkedUser, identity, decision }) {
  const user = syncExternalRole({
    user: linkedUser,
    mappedRole: decision.role,
    provider: 'oidc',
  }, { userDb, auditLogDb, onRoleApplied: revokeLiveAccessOnSsoRoleChange });
  if (user === null) {
    denyLoginWithoutRole(req, linkedUser, decision.reason);
    return { refusal: 'oidc_not_authorized' };
  }
  if (!user) return { status: 401, error: 'Linked account is unavailable' };
  // Stamp the attestation BEFORE any credential exists: a token minted for an
  // unstamped link would be refused as stale on first use (T-1939 slice 3).
  if (!stampAttestation(identity.id, user.id)) {
    logOidcFailure('attestation_stamp_failed');
    return { status: 500, error: 'Sign-in could not be completed' };
  }
  return { user };
}

/**
 * Existing-link checks before any write: duplicates, active account, owner
 * (I6). Returns the linked user, or null after answering the request.
 */
function linkedLoginPrecheck(req, res, { identity, issuer }) {
  // T-1939 slice 5: a legacy account holding two links for this issuer
  // blocked the UNIQUE(user_id, issuer) index; it stays out of SSO until the
  // owner removes the extra links (never auto-merged).
  if (userIdentitiesDb.countForUserAndIssuer(identity.user_id, issuer) > 1) {
    auditLogDb.record('oidc_login_blocked_duplicate_links', {
      userId: identity.user_id, metadata: { provider: 'oidc' }, ...auditContext(req),
    });
    res.status(409).json({
      error: 'oidc_duplicate_links',
      message: 'This account has more than one SSO link; ask the owner to remove the extra links',
    });
    return null;
  }
  // getUserById returns only active (is_active=1, status='active') users.
  const linkedUser = userDb.getUserById(identity.user_id);
  if (!linkedUser) {
    res.status(401).json({ error: 'Linked account is unavailable' });
    return null;
  }
  if (linkedUser.role === 'owner') {
    refuseOwnerIdentity(req, res, linkedUser.id, 'login');
    return null;
  }
  return linkedUser;
}

/**
 * `login` branch: resolve the identity by (active issuer, subject) only, then
 * map the verified role claim with the selected config (ADR-194 D4/D5;
 * T-1939: no recognized role → refused, never a downgrade), all writes fenced.
 */
function completeLogin(req, res, context) {
  const { entry, claims, subject, transaction, client } = context;
  const identity = userIdentitiesDb.findByIssuerAndSubject(client.issuer, subject);
  if (!identity) return signInUnknownSubject(req, res, context);
  const linkedUser = linkedLoginPrecheck(req, res, { identity, issuer: client.issuer });
  if (!linkedUser) return undefined;
  const decision = evaluateSsoClaims(claims, client.mapping);
  if (decision.reason === MAPPING_UNAVAILABLE_REASON) {
    // The config went away mid-flight: refuse, but never treat it as a withdrawal.
    return redirectLoginRefusal(res, 'temporarily_unavailable');
  }
  const outcome = runUnderVersionFence(
    entry.configVersion, () => applyLoginDecision(req, { linkedUser, identity, decision }),
  );
  if (outcome === SSO_FENCE_REFUSED) return redirectLoginRefusal(res, 'oidc_config_changed');
  if (outcome.refusal) return redirectLoginRefusal(res, outcome.refusal);
  if (!outcome.user) return res.status(outcome.status).json({ error: outcome.error });
  return handOffSession(req, res, outcome.user, transaction, entry.configVersion);
}

// ---------------------------------------------------------------------------
// Callback (ADR-194 D2 order)
// ---------------------------------------------------------------------------

// Every callback answer carries no-store and no Referer (D2).
function setCallbackHeaders(res) {
  setNoStore(res);
  res.set('Referrer-Policy', 'no-referrer');
}

function redirectTestResult(res, resultId) {
  return res.redirect(`${SETTINGS_SSO_PATH}&ssoTest=${encodeURIComponent(resultId)}`);
}

function redirectTestError(res, code) {
  return res.redirect(`${SETTINGS_SSO_PATH}&ssoTestError=${encodeURIComponent(code)}`);
}

/** A `test` outcome without verified claims: one display row, then settings. */
function finishTestWithFailure(res, entry, diagnostic, oauthError) {
  try {
    const { resultId } = recordTestFailure(entry, { diagnostic, oauthError });
    return redirectTestResult(res, resultId);
  } catch {
    logOidcFailure('test_result_write_failed');
    return redirectTestError(res, 'temporarily_unavailable');
  }
}

/**
 * D2 step 2, no usable code: the member or owner cancelled at the IdP
 * (?error=) or the reply is malformed. The entry is already consumed. A test
 * stores a display result (with the filtered OAuth error); a step-up returns
 * to its dialog; anything else is a 400.
 */
function answerAbandoned(req, res, entry) {
  const cancelled = typeof req.query.error === 'string';
  if (entry.purpose === 'test') {
    const oauthError = cancelled ? safeOauthError({ error: req.query.error }) ?? undefined : undefined;
    return finishTestWithFailure(res, entry, cancelled ? 'provider_denied' : 'code_missing', oauthError);
  }
  if (entry.purpose === 'step_up') {
    recordStepUpFailure(req, entry.userId, cancelled ? 'provider_denied' : 'code_missing');
    return redirectStepUpRefusal(res, cancelled ? 'provider_denied' : 'temporarily_unavailable');
  }
  return res.status(400).json({ error: 'Missing authorization code' });
}

/** Active selection for login/link/step_up: login available here only, same version as at start. */
function selectActiveClient(entry) {
  const client = ssoLoginAvailable() ? activeSsoClient() : null;
  if (!client) return { refusal: 'sso_unavailable' };
  let version;
  try {
    version = currentActiveVersion();
  } catch {
    return { refusal: 'sso_unavailable' };
  }
  if (entry.configVersion !== version || client.version !== version) return { refusal: 'oidc_config_changed' };
  return { client };
}

/**
 * D2 step 3: the verifier is chosen by the entry's binding — the draft (hash,
 * draft_version and owner re-checked, no discovery) for `test`, the active
 * config for every other purpose.
 */
function selectCallbackClient(entry) {
  if (entry.purpose !== 'test') return selectActiveClient(entry);
  const draft = draftSsoClient(entry);
  return draft.refusal ? { refusal: draft.refusal } : { client: draft.client, draftRow: draft.draftRow };
}

/**
 * D2 step 4 (RFC 9207), on the SELECTED config: when its discovery flags
 * advertise the iss response parameter it must equal that issuer exactly; a
 * present iss must match even when not advertised.
 */
function issParameterAccepted(req, client) {
  const iss = req.query.iss;
  if (client.discoveryFlags.authorization_response_iss_parameter_supported === true) return iss === client.issuer;
  return iss === undefined || iss === client.issuer;
}

/** A refusal before any token exchange, answered on the right page for the purpose. */
function refuseCallback(req, res, entry, code) {
  if (entry.purpose === 'test') return finishTestWithFailure(res, entry, code);
  if (entry.purpose === 'step_up') {
    recordStepUpFailure(req, entry.userId, code);
    return redirectStepUpRefusal(res, code);
  }
  return redirectLoginRefusal(res, code);
}

/** D2 step 5: drift check (active only), code exchange and id_token verification. */
async function exchangeAndVerify(client, entry, code) {
  if (client.slot === 'active') await client.verifier.checkDiscoveryDrift();
  const tokenSet = await client.verifier.exchangeAuthorizationCode({
    code, redirectUri: client.redirectUri, codeVerifier: entry.codeVerifier,
  });
  return client.verifier.verifyIdToken(tokenSet?.id_token, entry.nonce);
}

function answerExchangeFailure(req, res, entry, error) {
  logOidcFailure('callback_rejected');
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'callback_rejected';
  if (entry.purpose === 'test') return finishTestWithFailure(res, entry, code, error?.oauthError);
  if (code === 'discovery_endpoint_changed') return refuseCallback(req, res, entry, 'sso_unavailable');
  if (entry.purpose === 'step_up') {
    recordStepUpFailure(req, entry.userId, 'provider_exchange_failed');
    return redirectStepUpRefusal(res, 'temporarily_unavailable');
  }
  return res.status(502).json({ error: 'Identity provider unavailable' });
}

/** D2 step 6, `test`: terminal; nothing but the display row and the apply proof is written. */
function finishTestSignIn(res, entry, claims, draftRow) {
  try {
    const { resultId } = completeTestSignIn(entry, claims, { draftRow });
    return redirectTestResult(res, resultId);
  } catch {
    logOidcFailure('test_result_write_failed');
    return redirectTestError(res, 'temporarily_unavailable');
  }
}

/** D2 steps 6–7 for login/link/step_up: the stored purpose alone decides the branch. */
function branchOnPurpose(req, res, context) {
  const { entry, claims } = context;
  const subject = typeof claims.sub === 'string' ? claims.sub : null;
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    if (entry.purpose === 'step_up') {
      recordStepUpFailure(req, entry.userId, 'subject_missing');
      return redirectStepUpRefusal(res, 'temporarily_unavailable');
    }
    return res.status(401).json({ error: 'id_token missing subject' });
  }
  const withSubject = { ...context, subject };
  if (entry.purpose === 'link') return completeSelfLink(req, res, withSubject);
  if (entry.purpose === 'step_up') return completeStepUp(req, res, withSubject);
  if (entry.purpose === 'login') return completeLogin(req, res, withSubject);
  return res.status(400).json({ error: 'Invalid or expired state' });
}

// IdP redirect target, in the ADR-194 D2 order: shapes, consume the PKCE entry
// (also on ?error=), select the verifier by binding, RFC 9207 on the selected
// config, exchange and verify, then branch on the stored purpose.
router.get('/callback', oidcLoginLimiter, async (req, res) => {
  setCallbackHeaders(res);
  const { code, state } = req.query;
  if (typeof state !== 'string' || state.length === 0 || state.length > 256) {
    // B-1066: a browser lands here from the IdP, so answer on the return page.
    return redirectLoginRefusal(res, 'invalid_state');
  }
  const transaction = readBrowserTransaction(req);
  const { entry, stalePurpose } = oidcPkceStore.consumeWithOutcome(state, transaction);
  if (!entry) return redirectUnusableState(res, stalePurpose);
  if (typeof code !== 'string' || code.length === 0 || code.length > 4096) return answerAbandoned(req, res, entry);

  const selection = selectCallbackClient(entry);
  if (selection.refusal) return refuseCallback(req, res, entry, selection.refusal);
  if (!issParameterAccepted(req, selection.client)) return refuseCallback(req, res, entry, 'iss_mismatch');

  let claims;
  try {
    claims = await exchangeAndVerify(selection.client, entry, code);
  } catch (error) {
    return answerExchangeFailure(req, res, entry, error);
  }
  if (entry.purpose === 'test') return finishTestSignIn(res, entry, claims, selection.draftRow);
  try {
    return branchOnPurpose(req, res, { entry, claims, transaction, client: selection.client });
  } catch {
    logOidcFailure('callback_rejected');
    if (res.headersSent) return undefined;
    if (entry.purpose === 'step_up') return redirectStepUpRefusal(res, 'temporarily_unavailable');
    return redirectLoginRefusal(res, 'server_error');
  }
});

const INVALID_CODE = Object.freeze({ error: 'Invalid or expired code' });

/**
 * Wallet-mode redemption (ADR-163 amendment 1, A-1): the version, the member's
 * SSO attestation and the account are re-checked at redemption, then a NEW
 * device session replaces whatever device the browser presented (D3/C1).
 */
function redeemIntoDeviceSession(req, res, redeemed) {
  if (!redeemed || redeemed.token !== null) return res.status(401).json(INVALID_CODE);
  if (!activeVersionStillIs(redeemed.configVersion)) {
    return res.status(409).json({ error: 'SSO configuration changed', code: 'oidc_config_changed' });
  }
  const user = userDb.getUserById(redeemed.userId);
  if (!user || !userSsoAttestationFresh(user)) return res.status(401).json(INVALID_CODE);
  const issued = issueDeviceSession(req, res, user, authMiddleware.JWT_SECRET);
  if (!issued.ok) {
    auditLogDb.record('login_failure', {
      userId: user.id,
      metadata: { method: 'oidc', reason: issued.code },
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return res.status(401).json(INVALID_CODE);
  }
  recordOidcLogin(req, user.id);
  return res.json({ wallet: issued.wallet, csrfToken: issued.csrfToken });
}

// SPA trades the one-time code for the actual JWT (or, in wallet mode, a device
// session). It must prove it is the browser that started the authorization
// transaction by presenting the secure transaction cookie. The one-time code
// remains single-use.
router.post('/exchange', oidcExchangeLimiter, (req, res) => {
  setNoStore(res);
  if (!ssoLoginAvailable()) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }
  const walletMode = multiAccountSwitchingEnabled();
  if (walletMode && !isTrustedOrigin(req)) {
    return res.status(403).json({ error: 'Request rejected', code: 'origin_rejected' });
  }
  const { code } = req.body ?? {};
  if (typeof code !== 'string' || code.length === 0 || code.length > 256) {
    return res.status(400).json({ error: 'Missing code' });
  }
  const transaction = readBrowserTransaction(req);
  const redeemed = oidcCodeStore.consume(code, transaction);
  res.clearCookie(BROWSER_TRANSACTION_COOKIE, BROWSER_TRANSACTION_COOKIE_OPTIONS);
  if (walletMode) return redeemIntoDeviceSession(req, res, redeemed);
  if (!redeemed?.token) {
    return res.status(401).json(INVALID_CODE);
  }
  // W1: a leftover forced-change cookie must not outrank the new Bearer.
  clearPasswordChangeCookie(res);
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
function requireSsoLoginAvailable(req, res, next) {
  if (!ssoLoginAvailable()) {
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
router.get('/link/self', requireSsoLoginAvailable, authenticateToken, (req, res) => {
  setNoStore(res);
  const issuer = activeIssuer();
  return res.json({
    linked: issuer !== null && userIdentitiesDb.countForUserAndIssuer(req.user.id, issuer) > 0,
    ssoStepUp: requiresSsoLogin(userDb.getUserById(req.user.id)),
  });
});

/** ADR-194 I6: an owner signs in locally only, so it may not start a self-link. */
function ownerSelfLinkRefusal(req) {
  if (userDb.getUserById(req.user.id)?.role !== 'owner') return null;
  recordSelfLinkFailure(req, req.user.id, OWNER_LOCAL_ONLY);
  return { status: 403, body: { error: 'The owner signs in locally only', code: OWNER_LOCAL_ONLY } };
}

// Starts a self-link for the caller's OWN account. Owners are refused; then the
// password (rate limited per account), then a 'link' PKCE transaction bound to
// this user id, this browser and the active config version, with
// prompt=login&max_age=0 so the IdP must re-authenticate.
router.post(
  '/link/self/start',
  requireSsoLoginAvailable,
  authenticateToken,
  oidcSelfLinkLimiter,
  async (req, res) => {
    setNoStore(res);
    const { currentPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || currentPassword.length === 0 || currentPassword.length > 1024) {
      return res.status(400).json({ error: 'Current password is required', code: 'current_password_required' });
    }
    const refusal = ownerSelfLinkRefusal(req) ?? await selfLinkPasswordRefusal(req, currentPassword);
    if (refusal) {
      return res.status(refusal.status).json(refusal.body);
    }
    const client = activeSsoClient();
    if (!client) return res.status(503).json({ error: 'Identity provider temporarily unavailable' });
    if (userIdentitiesDb.countForUserAndIssuer(req.user.id, client.issuer) > 0) {
      return res.status(409).json({ error: 'Account is already linked', code: 'already_linked' });
    }
    try {
      const authorizationUrl = await beginAuthorization(
        res,
        client,
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
 * sign-in (auth_time), a still-active non-owner account, a recognized role
 * under the selected config, and a subject/issuer pair not yet linked.
 * Returns `{ user, decision }`, or the refusal to send (reason is audited;
 * ids only, never the subject).
 */
function selfLinkRefusal({ entry, claims, subject, nowMs, client }) {
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
  if (user.role === 'owner') return { owner: true };
  const decision = evaluateSsoClaims(claims, client.mapping);
  if (decision.reason === MAPPING_UNAVAILABLE_REASON) {
    return { status: 503, reason: decision.reason, error: 'temporarily_unavailable',
      message: 'SSO is temporarily unavailable' };
  }
  if (reconcileLocalRole(user.role, decision.role).role === null) {
    return { status: 403,
      reason: decision.reason,
      error: 'oidc_not_authorized', message: 'This identity has no role on this nassaj project' };
  }
  if (userIdentitiesDb.findByIssuerAndSubject(client.issuer, subject)) {
    return { status: 409, reason: 'subject_taken', error: 'oidc_subject_taken',
      message: 'This identity is already linked to a nassaj account' };
  }
  if (userIdentitiesDb.countForUserAndIssuer(entry.userId, client.issuer) > 0) {
    return { status: 409, reason: 'already_linked', error: 'already_linked',
      message: 'This account is already linked' };
  }
  return { user, decision };
}

/** Inside the version fence: the link insert with its attestation, then the role sync. */
function writeSelfLink(entry, checked, { client, subject, nowMs }) {
  const identityId = linkIdentityWithAttestation({
    userId: entry.userId, issuer: client.issuer, subject, attestedAtMs: nowMs,
  });
  // Same mapper as login: the attested role becomes the local role (never
  // owner, never demotes an owner). The role was checked above.
  const user = syncExternalRole({
    user: checked.user,
    mappedRole: checked.decision.role,
    provider: 'oidc',
  }, { userDb, auditLogDb, onRoleApplied: revokeLiveAccessOnSsoRoleChange });
  return { identityId, user };
}

function answerSelfLinkWriteFailure(req, res, entry, error) {
  const conflict = isUniqueConflict(error);
  recordSelfLinkFailure(req, entry.userId, conflict ? 'link_conflict' : 'link_failed');
  if (conflict) {
    return res.status(409).json({ error: 'oidc_subject_taken', message: 'This identity is already linked' });
  }
  logOidcFailure('self_link_write_failed');
  return res.status(500).json({ error: 'Linking could not be completed' });
}

/**
 * Callback branch for a 'link' transaction: links the verified subject to the
 * account that started the transaction (entry.userId) — never to anyone else
 * and never by looking the subject up — then signs that account in through the
 * ordinary one-time-code hand-off. An owner is refused (I6); every write runs
 * inside the version fence (D9).
 */
function completeSelfLink(req, res, { entry, claims, subject, transaction, client }) {
  const nowMs = Date.now();
  const checked = selfLinkRefusal({ entry, claims, subject, nowMs, client });
  if (checked.owner) return refuseOwnerIdentity(req, res, entry.userId, 'link');
  if (!checked.user) {
    recordSelfLinkFailure(req, entry.userId, checked.reason);
    return res.status(checked.status).json({ error: checked.error, message: checked.message });
  }

  let written;
  try {
    written = runUnderVersionFence(entry.configVersion, () => writeSelfLink(entry, checked, { client, subject, nowMs }));
  } catch (error) {
    return answerSelfLinkWriteFailure(req, res, entry, error);
  }
  if (written === SSO_FENCE_REFUSED) return redirectLoginRefusal(res, 'oidc_config_changed');

  auditLogDb.record('oidc_identity_self_linked', {
    userId: entry.userId,
    metadata: { provider: 'oidc', identityId: written.identityId },
    ...auditContext(req),
  });
  alertOwners(req, 'member_linked', entry.userId);
  if (!written.user) {
    return res.status(401).json({ error: 'Linked account is unavailable' });
  }
  return handOffSession(req, res, written.user, transaction, entry.configVersion);
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
  if (stalePurpose === 'test') return redirectTestError(res, 'transaction_expired');
  return redirectLoginRefusal(res, stalePurpose ? 'transaction_expired' : 'invalid_state');
}

/**
 * Why the caller cannot start an IdP step-up, or null. Only an active
 * SSO-linked member (the accounts refused a local step-up) may start one.
 */
function stepUpStartRefusal(userId, issuer) {
  const user = userDb.getUserById(userId);
  if (!user) {
    return { status: 401, body: { error: 'Verification failed', code: 'step_up_failed' } };
  }
  if (!requiresSsoLogin(user)) {
    return { status: 409, body: { error: 'Use your password or passkey to confirm', code: 'sso_step_up_not_applicable' } };
  }
  const currentIssuerLinks = userIdentitiesDb.countForUserAndIssuer(userId, issuer);
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
function stepUpStartAdmission(req, client) {
  const refusal = stepUpStartRefusal(req.user.id, client.issuer);
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
router.post('/step-up/start', requireSsoLoginAvailable, authenticateToken, async (req, res) => {
  setNoStore(res);
  const client = activeSsoClient();
  if (!client) return res.status(503).json(STEP_UP_UNAVAILABLE);
  try {
    const refusal = stepUpStartAdmission(req, client);
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
      client,
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
function stepUpRefusal({ entry, subject, claims, nowMs, issuer }) {
  const authFailure = stepUpAuthTimeFailure({
    authTimeMs: idTokenAuthTimeMs(claims), requestedAtMs: entry.requestedAtMs, nowMs,
  });
  if (authFailure) return { reason: authFailure, error: 'oidc_reauth_required' };
  const identity = userIdentitiesDb.findByIssuerAndSubject(issuer, subject);
  if (!identity || identity.user_id !== entry.userId) {
    return { reason: 'identity_mismatch', error: 'oidc_step_up_identity_mismatch' };
  }
  if (userIdentitiesDb.countForUserAndIssuer(entry.userId, issuer) > 1) {
    return { reason: 'duplicate_links', error: 'oidc_duplicate_links' };
  }
  const linkedUser = userDb.getUserById(entry.userId);
  if (!linkedUser) return { reason: 'account_unavailable', error: 'account_unavailable' };
  // ADR-194 I6: the owner is local-only; an IdP step-up never vouches for it.
  if (linkedUser.role === 'owner') return { reason: OWNER_LOCAL_ONLY, error: OWNER_LOCAL_ONLY };
  return { identity, linkedUser };
}

/**
 * Inside the version fence (ADR-194 D9): role sync, the denial revocation,
 * the attestation stamp and the grant issuance. Returns `{ grant }` or
 * `{ refusal, reason }`.
 */
function writeStepUp(req, { entry, checked, decision, transaction }) {
  const user = syncExternalRole({
    user: checked.linkedUser,
    mappedRole: decision.role,
    provider: 'oidc',
  }, { userDb, auditLogDb, onRoleApplied: revokeLiveAccessOnSsoRoleChange });
  if (user === null) {
    denyLoginWithoutRole(req, checked.linkedUser, decision.reason);
    return { refusal: 'oidc_not_authorized', reason: decision.reason };
  }
  if (!user || !stampAttestation(checked.identity.id, entry.userId)) {
    return { refusal: 'temporarily_unavailable', reason: 'attestation_failed' };
  }
  const grant = oidcStepUpGrantStore.issue({
    userId: entry.userId, audience: entry.audience, browserTransaction: transaction,
  });
  if (!grant) {
    logOidcFailure('step_up_grant_store_full');
    return { refusal: 'temporarily_unavailable', reason: 'grant_unavailable' };
  }
  return { grant };
}

function refuseStepUp(req, res, entry, reason, code) {
  recordStepUpFailure(req, entry.userId, reason);
  return redirectStepUpRefusal(res, code);
}

/**
 * Callback branch for a 'step_up' transaction: never signs anyone in. The
 * attested role goes through the same mapper as login (no recognized role →
 * refused and access withdrawn, exactly as a login would), the attestation is
 * stamped, and a one-time grant bound to member + audience + this browser
 * transaction is handed to the SPA return page. The grant is revoked when the
 * active config changed after it was issued.
 */
function completeStepUp(req, res, { entry, claims, subject, transaction, client }) {
  const checked = stepUpRefusal({ entry, subject, claims, nowMs: Date.now(), issuer: client.issuer });
  if (!checked.linkedUser) return refuseStepUp(req, res, entry, checked.reason, checked.error);
  const decision = evaluateSsoClaims(claims, client.mapping);
  if (decision.reason === MAPPING_UNAVAILABLE_REASON) {
    return refuseStepUp(req, res, entry, decision.reason, 'temporarily_unavailable');
  }
  const outcome = runUnderVersionFence(
    entry.configVersion, () => writeStepUp(req, { entry, checked, decision, transaction }),
  );
  if (outcome === SSO_FENCE_REFUSED) return refuseStepUp(req, res, entry, 'oidc_config_changed', 'oidc_config_changed');
  if (outcome.refusal) return refuseStepUp(req, res, entry, outcome.reason, outcome.refusal);
  if (!activeVersionStillIs(entry.configVersion)) {
    oidcStepUpGrantStore.revoke(outcome.grant);
    return refuseStepUp(req, res, entry, 'oidc_config_changed', 'oidc_config_changed');
  }
  auditLogDb.record('oidc_step_up_verified', {
    userId: entry.userId, metadata: { provider: 'oidc', audience: entry.audience }, ...auditContext(req),
  });
  setStepUpRedirectHeaders(res);
  return res.redirect(`${RETURN_PATH}?oidc_step_up=${encodeURIComponent(outcome.grant)}`);
}

// ---------------------------------------------------------------------------
// IdP back channel
// ---------------------------------------------------------------------------

/** Seconds an IdP waits before retrying a logout we could not verify (D1). */
const BACKCHANNEL_RETRY_AFTER_SECONDS = 300;

/**
 * Revokes a verified logout's subject unless it is unknown (200 no-op) or
 * linked to an owner (D6: owner sessions and keys are never revoked by the
 * IdP). Returns the affected user id, or null.
 */
function revokeForLogout(issuer, claims) {
  const subject = typeof claims.sub === 'string' ? claims.sub : null;
  const identity = subject ? userIdentitiesDb.findByIssuerAndSubject(issuer, subject) : undefined;
  if (!identity) return null;
  if (userDb.getRawById(identity.user_id)?.role === 'owner') return null;
  try {
    revokeUserSessions(identity.user_id);
  } catch {
    logOidcFailure('logout_revoke_failed');
  }
  revokeApiKeysForSsoWithdrawal(identity.user_id, 'backchannel_logout');
  return identity.user_id;
}

// OIDC back-channel logout (ADR-194 D1/D6). The IdP POSTs a logout_token,
// verified with the config row's issuer, client id and PINNED jwks_uri (also
// in broken states; never a fresh discovery), or for legacy env with
// discovery under the `public` policy. Revocation advances
// password_changed_at (the pwd_iat mechanism authenticateToken checks). A
// verified or rejected token answers 200 and never reveals whether the
// subject mapped; nothing verifiable while enforced answers 503 + Retry-After.
router.post('/backchannel-logout', oidcBackchannelLimiter, async (req, res) => {
  let selection;
  try {
    selection = backchannelSsoVerifier();
  } catch {
    selection = { status: 503 };
  }
  if (selection.status === 501) {
    return res.status(501).json({ error: 'OIDC is not enabled' });
  }
  if (!selection.verifier) {
    logOidcFailure('logout_verifier_unavailable');
    return res.status(503).set('Retry-After', String(BACKCHANNEL_RETRY_AFTER_SECONDS))
      .json({ error: 'SSO temporarily unavailable' });
  }
  // The logout_token arrives form-encoded per the OIDC back-channel spec, but
  // accept JSON too for flexibility.
  let claims;
  try {
    claims = await selection.verifier.verifyLogoutToken(req.body?.logout_token);
  } catch {
    logOidcFailure('logout_token_rejected');
    return res.status(200).json({ ok: true });
  }

  const revokedUserId = revokeForLogout(selection.issuer, claims);
  auditLogDb.record('oidc_backchannel_logout', {
    userId: revokedUserId,
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
 * stamp leaves the links in place. With `revokeApiKeys` the account's API keys
 * are deleted in the same transaction (T-1946): an unlinked member is no longer
 * governed by the SSO attestation window, so a surviving key would outlive the
 * SSO grant it was minted under. Returns how many keys were deleted; throws on
 * failure.
 * @param {number} userId
 * @param {{ revokeApiKeys?: boolean }} [options]
 * @returns {number}
 */
function unlinkAndRevokeSessions(userId, { revokeApiKeys = false } = {}) {
  let revokedKeys = 0;
  getConnection().transaction(() => {
    userIdentitiesDb.unlinkAll(userId);
    stampSessionsRevoked(userId);
    if (revokeApiKeys) revokedKeys = apiKeysDb.revokeAllForUser(userId);
  })();
  invalidateRefreshCache(userId);
  return revokedKeys;
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

  let revokedKeys = 0;
  try {
    revokedKeys = unlinkAndRevokeSessions(userId, { revokeApiKeys: true });
  } catch {
    logOidcFailure('identity_unlink_failed');
    return res.status(500).json({ error: 'Unable to unlink identity' });
  }
  revokeLiveAccessAfterUnlink(userId);
  if (revokedKeys > 0) {
    auditLogDb.record('api_keys_revoked_sso', {
      userId, metadata: { trigger: 'identity_unlinked', count: revokedKeys },
    });
  }

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
