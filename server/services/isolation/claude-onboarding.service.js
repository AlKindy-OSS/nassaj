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
import os from 'node:os';
import path from 'node:path';

import { isProviderIsolated } from '../provider-sharing.js';

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
 *
 * Mirrors claude-auth.provider.ts: any of `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` (the key a
 * `claude setup-token` result is stored under, B-1075) counts as connected.
 */
async function hasSettingsCredential(claudeDir) {
  try {
    const content = await readFile(path.join(claudeDir, 'settings.json'), 'utf8');
    const settings = asObject(JSON.parse(content));
    const env = asObject(settings?.env);
    if (!env) {
      return false;
    }
    return Boolean(
      nonEmptyString(env.ANTHROPIC_API_KEY)
      || nonEmptyString(env.ANTHROPIC_AUTH_TOKEN)
      || nonEmptyString(env.CLAUDE_CODE_OAUTH_TOKEN),
    );
  } catch {
    return false;
  }
}

/**
 * True if the user's isolated .credentials.json holds a LIVE OAuth link.
 * Missing/unreadable → false.
 *
 * B-586: مرآةُ الحكم في `claude-auth.provider.ts` — والمكوّن يجمع الساقين بـ`OR`،
 * فلو حكمت إحداهما بقاعدةٍ غير قاعدة الأخرى لناقضت البطاقةُ نفسها: شارةٌ تقول
 * «متصل» ودعوةٌ تحتها تقول «اربط اشتراكك». وهو ما وقع فعلاً حين صُحّح الأصلُ
 * وحده: بقيت هذه الساق تَقتل على الميقات المنقضي بينما كفّ الأصلُ عن ذلك.
 *
 * فالقاعدةُ واحدة: طريقان يُبقيان الاعتماد حيّاً — توكنُ وصولٍ لم ينتهِ، أو
 * توكنُ تحديثٍ لم يمضِ ميقاتُه — والموتُ انقطاعُهما معاً. والميقاتُ المنقضي
 * وحده لا يقتل: الـCLI لا يستعمله بوّابةً، ودورُ العضو يعمل حتى ينفد الوصول.
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
    // الفحصُ الصريح للنوع مقصود: `!expiresAt` كان يقرأ الختم الصفري «بلا انتهاء».
    const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
    const linkExpiresAt = typeof oauth?.refreshTokenExpiresAt === 'number'
      ? oauth.refreshTokenExpiresAt
      : undefined;
    const refreshToken = nonEmptyString(oauth?.refreshToken);
    const now = Date.now();

    const accessAlive = expiresAt === undefined || now < expiresAt;
    const refreshAlive = Boolean(refreshToken)
      && (linkExpiresAt === undefined || now < linkExpiresAt);

    return accessAlive || refreshAlive;
  } catch {
    return false;
  }
}

/**
 * The Claude config dir this user's spawns actually read (B-1087). Mirrors
 * `resolveConfigDir` in claude-auth.provider.ts: under the 'isolated' policy it
 * is the user's own `~/.nassaj-users/<id>/.claude`; under 'shared' every spawn
 * (including the in-app `claude setup-token` terminal) runs on the operator's
 * dir, so the card must look there too or it contradicts a login that just
 * succeeded in front of the user.
 *
 * @param {string|number} userId authenticated user id
 * @param {boolean} isolated whether the Claude credential policy is 'isolated'
 * @returns {string} absolute config dir
 */
export function resolveClaudeStatusDir(userId, isolated) {
  if (isolated) {
    return userConfigDir(userId, '.claude');
  }
  const operatorDir = nonEmptyString(process.env.CLAUDE_CONFIG_DIR);
  return operatorDir ?? path.join(os.homedir(), '.claude');
}

/**
 * Reports whether `userId` has registered a Claude credential in the config dir
 * their spawns resolve to (isolated dir, or the operator's under 'shared').
 *
 * @param {string|number} userId authenticated user id
 * @param {{ isolated?: boolean }} [options] test seam for the sharing policy
 * @returns {Promise<{ connected: boolean, provider: 'claude' }>}
 */
export async function getClaudeConnectionStatus(userId, options = {}) {
  const isolated = options.isolated ?? isProviderIsolated('claude');
  const claudeDir = resolveClaudeStatusDir(userId, isolated);
  const connected =
    (await hasSettingsCredential(claudeDir)) || (await hasOauthCredential(claudeDir));
  return { connected, provider: 'claude' };
}
