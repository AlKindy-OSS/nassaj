/**
 * WebAuthn (passkey) routes (B-PK-3 / B-PK-4).
 *
 * Mounted under /api/auth/webauthn by routes/auth.js.
 *
 * Authenticated credential management:
 *   POST   /step-up/options        { audience } → PublicKeyCredentialRequestOptionsJSON
 *                                    (only the caller's step-up-eligible passkeys, UV required)
 *   POST   /register/options       { stepUp } → PublicKeyCredentialCreationOptionsJSON
 *                                    stepUp = { method:'password', password }
 *                                           | { method:'passkey', response } (answer to a
 *                                             step-up/options challenge, audience
 *                                             'passkey_registration')
 *                                    (B-1407: a bare JWT can no longer enroll a passkey)
 *                                    Both step-up routes: 20 requests / min / user.
 *   POST   /register/verify        { response, name? } → { success, credential }
 *   GET    /credentials            → { credentials: [...] } (never public_key)
 *   PATCH  /credentials/:id        { name } → { success }
 *   DELETE /credentials/:id        → { success }
 *
 * Public passkey login (rate-limited like /login):
 *   POST   /login/options          → PublicKeyCredentialRequestOptionsJSON
 *   POST   /login/verify           { response } → { success, user, token }
 *                                    (same contract as POST /api/auth/login; a
 *                                    connector recent-auth session is minted only
 *                                    for a step-up-eligible passkey with UV).
 *                                    MULTI_ACCOUNT_SWITCHING: a trusted Origin is
 *                                    required and the answer is
 *                                    { success, user, wallet, csrfToken } with a new
 *                                    device cookie (ADR-163 amendment 1, D3); an
 *                                    account that must change its password is
 *                                    refused 403 password_change_required.
 *
 * Example:
 *   curl -X POST https://host/api/auth/webauthn/register/options \
 *     -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
 *     -d '{"stepUp":{"method":"password","password":"..."}}'
 */

import express from 'express';

import * as authMiddleware from '../middleware/auth.js';
import { authenticateToken, generateToken } from '../middleware/auth.js';
import { createKeyedLimiter } from '../middleware/keyed-limiter.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { auditLogDb, userDb, webauthnCredentialsDb } from '../modules/database/index.js';
import { clientIp } from '../utils/client-ip.js';
import { isTrustedOrigin, multiAccountSwitchingEnabled } from '../utils/trusted-origin.js';
import { clearPasswordChangeCookie, issueDeviceSession } from '../modules/account-wallet/issue-device-session.js';
import { recordConnectorOwnerAuthentication } from '../modules/connectors/connector-owner-auth-session.js';
import {
  WebAuthnError,
  createAuthenticationOptions,
  createRegistrationOptions,
  createStepUpOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../services/webauthn.service.js';
import { refuseLocalCredential, requiresSsoLogin } from '../services/sso-only-policy.js';
import { STEP_UP_AUDIENCES, StepUpError, verifyStepUpEvidence } from '../services/step-up.service.js';

const MAX_CREDENTIAL_NAME_LENGTH = 64;

const router = express.Router();

// Same brute-force posture as POST /api/auth/login (m-RATELIMIT):
// 10 attempts / 15 min / IP on the public login pair.
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 10,
  message: 'Too many attempts, please try again later',
});

// Per-user cap on the two step-up entry points. Refusals that happen before
// the service's stepup:<id> counter (step_up_required, invalid shapes) would
// otherwise let a JWT holder flood audit_log with denial rows.
const stepUpRouteLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  key: (req) => `webauthn-step-up-route:${req.user.id}`,
  message: 'Too many verification attempts, please try again later',
  code: 'step_up_rate_limited',
});

// One step_up_rate_limited audit row per user per step-up window (15 min,
// matching the service limiter); repeats inside the window are not recorded.
const rateLimitedAuditGate = createKeyedLimiter({ windowMs: 15 * 60_000, max: 1 });

/** Maps service errors to HTTP; anything unexpected becomes a logged 500. */
function handleError(res, error, context) {
  if (error instanceof WebAuthnError) {
    return res.status(error.status).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
  console.error(`WebAuthn ${context} error:`, error?.message);
  return res.status(500).json({ error: 'Internal server error' });
}

// ---------------------------------------------------------------------------
// Registration + credential management (authenticated)
// ---------------------------------------------------------------------------

/** Answers a step-up refusal: coded (never a bare 401), no-store, Retry-After on 429. */
function sendStepUpError(res, error) {
  if (error.retryAfterSeconds) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  return res.status(error.status).set('Cache-Control', 'no-store')
    .json({ error: error.message, code: error.code });
}

/** Evidence method for audit metadata only — never the evidence itself. */
function evidenceMethod(evidence) {
  const method = evidence && typeof evidence === 'object' ? evidence.method : undefined;
  return method === 'password' || method === 'passkey' ? method : 'none';
}

/** Audits a refused enrollment; a repeated rate-limit refusal is not re-recorded. */
function recordRegistrationDenied(req, evidence, error) {
  if (error.code === 'step_up_rate_limited'
    && !rateLimitedAuditGate.hit(`rate-limited-audit:${req.user.id}`).allowed) {
    return;
  }
  auditLogDb.record('passkey_registration_denied', {
    userId: req.user.id,
    metadata: { method: evidenceMethod(evidence), code: error.code },
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });
}

// Issues a step-up challenge for the caller's eligible passkeys. One pending
// step-up per user: a new request replaces the previous challenge.
router.post('/step-up/options', authenticateToken, stepUpRouteLimiter, async (req, res) => {
  try {
    const { audience } = req.body ?? {};
    if (typeof audience !== 'string' || !STEP_UP_AUDIENCES.includes(audience)) {
      return res.status(400).json({ error: 'Invalid verification request', code: 'step_up_invalid_request' });
    }
    const user = userDb.getUserById(req.user.id);
    if (!user) {
      return res.status(401).json({ error: 'Verification failed', code: 'step_up_failed' });
    }
    if (requiresSsoLogin(user)) {
      return sendStepUpError(res, new StepUpError('sso_step_up_required'));
    }
    res.set('Cache-Control', 'no-store').json(await createStepUpOptions(user, audience));
  } catch (error) {
    handleError(res, error, 'step-up/options');
  }
});

// B-1407: enrolling a passkey needs a fresh step-up proof, not just the JWT.
router.post('/register/options', authenticateToken, stepUpRouteLimiter, async (req, res) => {
  const evidence = req.body?.stepUp;
  try {
    await verifyStepUpEvidence(req, req.user, 'passkey_registration', evidence);
  } catch (error) {
    if (!(error instanceof StepUpError)) {
      return handleError(res, error, 'register/options step-up');
    }
    recordRegistrationDenied(req, evidence, error);
    return sendStepUpError(res, error);
  }
  try {
    const options = await createRegistrationOptions(req.user);
    res.set('Cache-Control', 'no-store').json(options);
  } catch (error) {
    handleError(res, error, 'register/options');
  }
});

router.post('/register/verify', authenticateToken, async (req, res) => {
  try {
    const { response, name } = req.body ?? {};
    if (!response || typeof response !== 'object') {
      return res.status(400).json({ error: 'A registration response is required' });
    }

    let credentialName = null;
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Invalid passkey name' });
      }
      credentialName = name.trim().slice(0, MAX_CREDENTIAL_NAME_LENGTH);
    }

    const credential = await verifyRegistration(req.user, response, credentialName);

    auditLogDb.record('passkey_registered', {
      userId: req.user.id,
      metadata: { credentialId: credential.id, deviceType: credential.device_type ?? null },
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    res.status(201).json({ success: true, credential });
  } catch (error) {
    handleError(res, error, 'register/verify');
  }
});

// Lists the user's passkeys (summaries only — public_key never leaves the
// repository). Bounded per-user set; no pagination needed.
router.get('/credentials', authenticateToken, (req, res) => {
  try {
    res.json({ credentials: webauthnCredentialsDb.listByUserId(req.user.id) });
  } catch (error) {
    handleError(res, error, 'credentials list');
  }
});

// Rename own passkey. Ownership enforced in the repository (user_id filter).
router.patch('/credentials/:id', authenticateToken, (req, res) => {
  try {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'A non-empty name is required' });
    }

    const renamed = webauthnCredentialsDb.rename(
      req.params.id,
      req.user.id,
      name.trim().slice(0, MAX_CREDENTIAL_NAME_LENGTH)
    );
    if (!renamed) {
      return res.status(404).json({ error: 'Passkey not found' });
    }
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'credential rename');
  }
});

// Remove own passkey. Ownership enforced in the repository (user_id filter).
router.delete('/credentials/:id', authenticateToken, (req, res) => {
  try {
    const deleted = webauthnCredentialsDb.deleteByIdForUser(req.params.id, req.user.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Passkey not found' });
    }

    auditLogDb.record('passkey_removed', {
      userId: req.user.id,
      metadata: { credentialId: req.params.id },
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'credential delete');
  }
});

// ---------------------------------------------------------------------------
// Passkey login (public, rate-limited) — B-PK-4
// ---------------------------------------------------------------------------

// Anonymous options for discoverable credentials: no username is asked for and
// no credential list is revealed (allowCredentials stays empty).
router.post('/login/options', loginLimiter, async (req, res) => {
  try {
    const options = await createAuthenticationOptions();
    res.json(options);
  } catch (error) {
    handleError(res, error, 'login/options');
  }
});

/** Wallet-mode refusal before any assertion work: same contract as POST /login. */
function refuseUntrustedOrigin(req, res) {
  if (!multiAccountSwitchingEnabled() || isTrustedOrigin(req)) return false;
  res.status(403).set('Cache-Control', 'no-store').json({
    error: 'Request rejected', code: 'origin_rejected',
  });
  return true;
}

/**
 * Wallet mode only: a device slot cannot hold an account under forced password
 * rotation, and a passkey cannot perform that rotation, so the member is sent
 * to the password sign-in, which owns the rotation flow.
 */
function refusePendingPasswordChange(req, res, user) {
  if (!multiAccountSwitchingEnabled() || user.must_change_password !== 1) return false;
  auditLogDb.record('login_failure', {
    userId: user.id,
    metadata: { method: 'passkey', reason: 'password_change_required' },
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });
  res.status(403).set('Cache-Control', 'no-store').json({
    error: 'Sign in with your password to change it', code: 'password_change_required',
  });
  return true;
}

/**
 * Wallet mode: issues the device session BEFORE the connector owner session,
 * last-login and success audit. On failure it audits, answers 401 and returns
 * null, so none of those side effects happen.
 */
function issuePasskeyDevice(req, res, user) {
  const issued = issueDeviceSession(req, res, user, authMiddleware.JWT_SECRET);
  if (issued.ok) return issued;
  auditLogDb.record('login_failure', {
    userId: user.id,
    metadata: { method: 'passkey', reason: issued.code },
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });
  res.status(401).json({ error: 'Passkey sign-in failed' });
  return null;
}

/** Answers a verified passkey login: the issued device session, or a legacy JWT. */
function answerPasskeyLogin(res, user, issued) {
  const publicUser = { id: user.id, username: user.username, role: user.role };
  if (!issued) {
    // W1: a leftover forced-change cookie must not outrank the new Bearer.
    clearPasswordChangeCookie(res);
    return res.json({ success: true, user: publicUser, token: generateToken(user) });
  }
  return res.set('Cache-Control', 'no-store').json({
    success: true, user: publicUser, wallet: issued.wallet, csrfToken: issued.csrfToken,
  });
}

// Verifies the assertion and issues a JWT with the same contract as /login.
router.post('/login/verify', loginLimiter, async (req, res) => {
  try {
    if (refuseUntrustedOrigin(req, res)) return;
    const { response } = req.body ?? {};
    if (!response || typeof response !== 'object') {
      return res.status(400).json({ error: 'An authentication response is required' });
    }

    const { user, credentialId, userVerified, stepUpEligible } = await verifyAuthentication(response);
    // T-1939: a linked non-owner signs in through the IdP only. Checked after
    // the assertion verified, so nothing is revealed to a non-holder.
    if (requiresSsoLogin(user)) {
      return refuseLocalCredential(res, {
        userId: user.id,
        entry: 'passkey_login',
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
    }
    if (refusePendingPasswordChange(req, res, user)) return;
    const walletMode = multiAccountSwitchingEnabled();
    const issued = walletMode ? issuePasskeyDevice(req, res, user) : null;
    if (walletMode && !issued) return;

    // B-1407: only a passkey enrolled under the hardened ceremony, used with
    // user verification, may stand in for the owner's recent authentication.
    // A legacy passkey still signs in, without a connector owner session.
    const mintsConnectorSession = userVerified === true && stepUpEligible === true;
    if (mintsConnectorSession) {
      recordConnectorOwnerAuthentication(res, user.id, 'webauthn');
    }
    userDb.updateLastLogin(user.id);
    auditLogDb.record('login_success', {
      userId: user.id,
      metadata: { method: 'passkey', credentialId, connectorSession: mintsConnectorSession },
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    return answerPasskeyLogin(res, user, issued);
  } catch (error) {
    if (error instanceof WebAuthnError) {
      auditLogDb.record('login_failure', {
        userId: error.userId ?? null,
        metadata: { method: 'passkey', reason: error.reason ?? 'webauthn_error' },
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
    }
    handleError(res, error, 'login/verify');
  }
});

export default router;
