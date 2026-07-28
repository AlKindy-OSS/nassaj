/**
 * claude-onboarding.service — per-user Claude credential connection check.
 *
 * Supports B-MU-ONBOARD: the onboarding UI needs to show whether the current
 * user has registered THEIR OWN Claude subscription inside their isolated
 * config dir (~/.nassaj-users/<userId>/.claude), without ever exposing the
 * token itself.
 *
 * "Connected" mirrors the credential-priority chain Claude Code itself uses
 * (claude-auth.provider.ts:106-129), restricted to artifacts that live INSIDE
 * the user's isolated dir — i.e. evidence the user registered a credential:
 *   1. settings.json `env.ANTHROPIC_API_KEY` / `env.ANTHROPIC_AUTH_TOKEN`
 *      (a configured API key counts as connected), OR
 *   2. .credentials.json with a non-expired OAuth access token (the artifact a
 *      `claude /login` writes).
 *
 * Process-level ANTHROPIC_* env vars are intentionally NOT consulted here: a
 * global operator token would make every user look "connected" and defeats the
 * per-user onboarding signal (and ADR-023 confirms no such global var exists in
 * the live env). Only the user's own isolated files decide.
 *
 * The token value is never returned — only a boolean.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { userConfigDir } from './provision-user-dirs.js';

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
 * True if the user's isolated settings.json declares an Anthropic key/token in
 * its `env` block. Missing/unreadable settings → false (not connected).
 */
async function hasSettingsCredential(claudeDir) {
  try {
    const content = await readFile(path.join(claudeDir, 'settings.json'), 'utf8');
    const settings = asObject(JSON.parse(content));
    const env = asObject(settings?.env);
    if (!env) {
      return false;
    }
    return Boolean(nonEmptyString(env.ANTHROPIC_API_KEY) || nonEmptyString(env.ANTHROPIC_AUTH_TOKEN));
  } catch {
    return false;
  }
}

/**
 * True if the user's isolated .credentials.json holds a non-expired OAuth
 * access token. Missing/unreadable/expired → false.
 */
async function hasOauthCredential(claudeDir) {
  try {
    const content = await readFile(path.join(claudeDir, '.credentials.json'), 'utf8');
    const creds = asObject(JSON.parse(content));
    const oauth = asObject(creds?.claudeAiOauth);
    const accessToken = nonEmptyString(oauth?.accessToken);
    if (!accessToken) {
      return false;
    }
    const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
    return !expiresAt || Date.now() < expiresAt;
  } catch {
    return false;
  }
}

/**
 * Reports whether `userId` has registered a Claude credential in their isolated
 * config dir.
 *
 * @param {string|number} userId authenticated user id
 * @returns {Promise<{ connected: boolean, provider: 'claude' }>}
 */
export async function getClaudeConnectionStatus(userId) {
  const claudeDir = userConfigDir(userId, '.claude');

  const connected =
    (await hasSettingsCredential(claudeDir)) || (await hasOauthCredential(claudeDir));

  return { connected, provider: 'claude' };
}
