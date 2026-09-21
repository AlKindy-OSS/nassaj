/**
 * agy-onboarding.service — per-user agy (antigravity) credential connection check.
 *
 * Mirror of claude-onboarding.service for the agy provider (ADR-023): the
 * onboarding UI needs to show whether the CURRENT user has authenticated THEIR
 * OWN agy subscription inside their isolated config dir, without ever exposing
 * the token itself.
 *
 * agy resolves its store under ~/.gemini/antigravity-cli relative to HOME; under
 * isolation resolveProviderEnv overrides HOME to the per-user root, so the user's
 * token lives at:
 *   ~/.nassaj-users/<userId>/.gemini/antigravity-cli/antigravity-oauth-token
 *
 * "Connected" is decided ONLY by that isolated file — never the operator's global
 * ~/.gemini/antigravity-cli token. Reading the operator file here would make every
 * user look connected and defeat the per-user signal (the exact pitfall ADR-023
 * calls out for claude). The owner's isolated file is a symlink back to the
 * operator token (provision-user-dirs), so the owner legitimately reads as
 * connected through their own dir.
 *
 * The agy token is JSON: { token: { access_token, refresh_token, expiry, ... },
 * auth_method }. A present non-empty access_token counts as connected. An expired
 * access_token still counts as connected WHEN a refresh_token is present, because
 * agy refreshes silently without a re-login; only an expired token with no
 * refresh path is treated as not connected.
 *
 * The token value is never returned — only a boolean.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { userConfigDir } from './provision-user-dirs.js';

/** Relative path of the agy token inside a user's isolated config root. */
const AGY_TOKEN_RELATIVE = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');

/** Trimmed string if non-empty, else null. */
function nonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Plain object or null. */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * True if the parsed agy token represents an authenticated session: a non-empty
 * access_token that is either unexpired, or refreshable (refresh_token present).
 */
function isAuthenticatedToken(parsed) {
  const root = asObject(parsed);
  const token = asObject(root?.token);
  if (!token) {
    return false;
  }
  const accessToken = nonEmptyString(token.access_token);
  if (!accessToken) {
    return false;
  }
  // A refresh_token means agy can silently re-mint an expired access token, so
  // the user is still connected regardless of the access token's expiry.
  if (nonEmptyString(token.refresh_token)) {
    return true;
  }
  // No refresh path: honor the expiry (RFC3339 string). Unparseable/absent expiry
  // is treated as still valid (presence of a credential).
  const expiry = nonEmptyString(token.expiry);
  if (!expiry) {
    return true;
  }
  const expiryMs = Date.parse(expiry);
  if (Number.isNaN(expiryMs)) {
    return true;
  }
  return Date.now() < expiryMs;
}

/**
 * Reports whether `userId` has authenticated an agy credential in their isolated
 * config dir. Reads ONLY the user's isolated token — never the operator global.
 *
 * @param {string|number} userId authenticated user id
 * @returns {Promise<{ connected: boolean, provider: 'agy' }>}
 */
export async function getAgyConnectionStatus(userId) {
  const tokenPath = userConfigDir(userId, AGY_TOKEN_RELATIVE);
  let connected = false;
  try {
    const content = await readFile(tokenPath, 'utf8');
    connected = isAuthenticatedToken(JSON.parse(content));
  } catch {
    // Missing / unreadable / malformed token → not connected.
    connected = false;
  }
  return { connected, provider: 'agy' };
}
