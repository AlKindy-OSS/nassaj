/**
 * Primary-login device-session issuance (ADR-163 amendment 1, D3: C1, M6, M8).
 *
 * The password, passkey and OIDC exchange routes call issueDeviceSession in
 * place of minting a JWT when MULTI_ACCOUNT_SWITCHING is on. It replaces only
 * the issuance step: each route keeps its own credential checks, forced
 * password-change branch, connector owner session, audit and last-login write.
 *
 * Every successful issuance also clears the forced-password-change cookie.
 * Every primary login gets a NEW device secret; the device session named by
 * the request cookie (if any) is revoked with its slots in the same
 * transaction, and its live connections are closed after the commit. Joining
 * an existing wallet happens only through the explicit add-account routes.
 */
import crypto from 'node:crypto';

// Namespace import: tests replace the database module with partial mocks.
import * as databaseModule from '../database/index.js';
// eslint-disable-next-line boundaries/no-unknown -- ADR-163 amendment 1: the single trusted-origin source.
import { isTrustedOrigin } from '../../utils/trusted-origin.js';

import { connectionRevocationRegistry } from './connection-revocation-registry.js';

const CSRF_TTL_MS = 15 * 60_000;
const FALLBACK_DEVICE_COOKIE = '__Host-nassaj_device';
/** Purpose-limited forced-password-change session (middleware/auth.js). */
export const PASSWORD_CHANGE_COOKIE = '__Host-nassaj_password_change';
const FALLBACK_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE_ATTRIBUTES = Object.freeze({
  secure: true, httpOnly: true, sameSite: 'lax', path: '/',
});

const deviceCookieName = () => databaseModule.DEVICE_COOKIE ?? FALLBACK_DEVICE_COOKIE;

/**
 * Signs a wallet CSRF token bound to one device session, generation and action.
 * @returns {string} `<expiry>.<signature>`
 */
export function csrfFor(secret, sessionId, generation, action, expiry) {
  const signature = crypto.createHmac('sha256', secret)
    .update(`${sessionId}:${generation}:${action}:${expiry}`)
    .digest('base64url');
  return `${expiry}.${signature}`;
}

/**
 * Drops a leftover forced-password-change cookie. Every sign-in that answers a new
 * credential calls this, so a half-finished change cannot outrank it (W1).
 */
export function clearPasswordChangeCookie(res) {
  res.clearCookie(PASSWORD_CHANGE_COOKIE, DEVICE_COOKIE_ATTRIBUTES);
}

/** Cookie attributes for a device secret that expires at `expiresAt` (ms epoch). */
export function deviceCookieOptions(expiresAt, now = Date.now()) {
  return { ...DEVICE_COOKIE_ATTRIBUTES, maxAge: Math.max(0, expiresAt - now) };
}

/** The device secret presented by the request, or null when absent or undecodable. */
export function readDeviceCookie(req) {
  const name = deviceCookieName();
  const match = String(req.headers?.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

/**
 * Sliding renewal after a successful REST resolve (M6). Best effort: a failed
 * or lost conditional UPDATE never fails the request; on success the same
 * secret is re-issued with the new Max-Age.
 */
export function renewDeviceCookie(res, secret, deviceSessionId) {
  try {
    const expiresAt = databaseModule.deviceAccountSessionsDb.slideExpiry(deviceSessionId);
    if (expiresAt !== null) res.cookie(deviceCookieName(), secret, deviceCookieOptions(expiresAt));
  } catch (error) {
    console.warn('[device-session] renewal skipped', { reason: error?.name ?? 'error' });
  }
}

function rotateOrRefuse(priorSecret, userId) {
  const ttlMs = databaseModule.DEVICE_IDLE_TTL_MS ?? FALLBACK_IDLE_TTL_MS;
  try {
    return databaseModule.deviceAccountSessionsDb.rotateDevice(priorSecret, userId, ttlMs);
  } catch (error) {
    if (error instanceof databaseModule.WalletConflictError && error.code === 'account_ineligible') {
      return null;
    }
    throw error;
  }
}

/**
 * Issues a fresh device session for an authenticated primary login.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ id: number }} user account that just proved its credential
 * @param {string} csrfSecret HMAC key for the returned wallet CSRF token
 * @returns {{ ok: true, wallet: object, csrfToken: string }
 *   | { ok: false, code: 'origin_rejected' | 'account_ineligible' }}
 */
export function issueDeviceSession(req, res, user, csrfSecret) {
  if (!isTrustedOrigin(req)) return { ok: false, code: 'origin_rejected' };
  const issued = rotateOrRefuse(readDeviceCookie(req), user.id);
  if (!issued) return { ok: false, code: 'account_ineligible' };
  if (issued.revokedDeviceSessionId) {
    connectionRevocationRegistry.revokeDevice(issued.revokedDeviceSessionId);
  }
  res.cookie(deviceCookieName(), issued.secret, deviceCookieOptions(issued.expiresAt));
  // A half-finished forced change of another account must not outrank the new
  // device identity on this browser (authenticatePasswordChange prefers it).
  clearPasswordChangeCookie(res);
  const { deviceSessionId, generation } = issued.principal;
  return {
    ok: true,
    wallet: issued.wallet,
    csrfToken: csrfFor(csrfSecret, deviceSessionId, generation, 'switch', Date.now() + CSRF_TTL_MS),
  };
}
