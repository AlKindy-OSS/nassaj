/**
 * WebAuthn (passkey) routes (B-PK-3 / B-PK-4).
 *
 * Mounted under /api/auth/webauthn by routes/auth.js.
 *
 * Authenticated credential management:
 *   POST   /register/options       → PublicKeyCredentialCreationOptionsJSON
 *   POST   /register/verify        { response, name? } → { success, credential }
 *   GET    /credentials            → { credentials: [...] } (never public_key)
 *   PATCH  /credentials/:id        { name } → { success }
 *   DELETE /credentials/:id        → { success }
 *
 * Public passkey login (rate-limited like /login):
 *   POST   /login/options          → PublicKeyCredentialRequestOptionsJSON
 *   POST   /login/verify           { response } → { success, user, token }
 *                                    (same contract as POST /api/auth/login)
 */

import express from 'express';

import { authenticateToken, generateToken } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { auditLogDb, userDb, webauthnCredentialsDb } from '../modules/database/index.js';
import { clientIp } from '../utils/client-ip.js';
import {
  WebAuthnError,
  createAuthenticationOptions,
  createRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../services/webauthn.service.js';

const MAX_CREDENTIAL_NAME_LENGTH = 64;

const router = express.Router();

// Same brute-force posture as POST /api/auth/login (m-RATELIMIT):
// 10 attempts / 15 min / IP on the public login pair.
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 10,
  message: 'Too many attempts, please try again later',
});

/** Maps service errors to HTTP; anything unexpected becomes a logged 500. */
function handleError(res, error, context) {
  if (error instanceof WebAuthnError) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(`WebAuthn ${context} error:`, error?.message);
  return res.status(500).json({ error: 'Internal server error' });
}

// ---------------------------------------------------------------------------
// Registration + credential management (authenticated)
// ---------------------------------------------------------------------------

router.post('/register/options', authenticateToken, async (req, res) => {
  try {
    const options = await createRegistrationOptions(req.user);
    res.json(options);
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

// Verifies the assertion and issues a JWT with the same contract as /login.
router.post('/login/verify', loginLimiter, async (req, res) => {
  try {
    const { response } = req.body ?? {};
    if (!response || typeof response !== 'object') {
      return res.status(400).json({ error: 'An authentication response is required' });
    }

    const { user, credentialId } = await verifyAuthentication(response);

    const token = generateToken(user);
    userDb.updateLastLogin(user.id);
    auditLogDb.record('login_success', {
      userId: user.id,
      metadata: { method: 'passkey', credentialId },
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    res.json({
      success: true,
      user: { id: user.id, username: user.username, role: user.role },
      token,
    });
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
