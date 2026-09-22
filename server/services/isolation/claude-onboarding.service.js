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
 * True if the user's isolated settings.json declares a FULL Anthropic API
 * key/token in its `env` block. Missing/unreadable settings → false.
 *
 * B-1260: a real `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is a complete
 * credential and counts as connected. The inference-only `CLAUDE_CODE_OAUTH_TOKEN`
 * (a `claude setup-token` result, B-1075) is DELIBERATELY excluded here — it is a
 * partial link, reported through `hasSettingsSetupTokenOnly` as "incomplete"
 * rather than folded into "connected".
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
      || nonEmptyString(env.ANTHROPIC_AUTH_TOKEN),
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
/**
 * B-1260 — the scopes a FULL Claude subscription link carries. A stored `scopes`
 * array that is present but omits the profile scope is an inference-only link.
 * Mirror of FULL_LINK_PROFILE_SCOPES in claude-auth.provider.ts.
 */
const FULL_LINK_PROFILE_SCOPES = ['profile', 'user:profile'];

/**
 * Classifies a `.credentials.json` claudeAiOauth block into a link quality —
 * the JS mirror of `classifyOauthLink` in claude-auth.provider.ts, kept in
 * parity by claude-onboarding.test.ts + claude-auth.provider.test.ts.
 *
 * @param {Record<string, unknown>|null} oauth
 * @param {number} now
 * @returns {'none'|'expired'|'incomplete'|'linked'}
 */
function classifyOauthLink(oauth, now) {
  const accessToken = nonEmptyString(oauth?.accessToken);
  if (!accessToken) return 'none';

  // الفحصُ الصريح للنوع مقصود: `!expiresAt` كان يقرأ الختم الصفري «بلا انتهاء».
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
  const linkExpiresAt = typeof oauth?.refreshTokenExpiresAt === 'number'
    ? oauth.refreshTokenExpiresAt
    : undefined;
  const refreshToken = nonEmptyString(oauth?.refreshToken);

  const accessAlive = expiresAt === undefined || now < expiresAt;
  const refreshAlive = Boolean(refreshToken)
    && (linkExpiresAt === undefined || now < linkExpiresAt);

  if (!accessAlive && !refreshAlive) return 'expired';
  // B-1260: بلا توكن تحديث لا يُنعَش الاعتماد فينكسر — ربطٌ ناقص لا كامل.
  if (!refreshToken) return 'incomplete';

  const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes : null;
  if (scopes) {
    const hasProfile = scopes.some(
      (s) => typeof s === 'string' && FULL_LINK_PROFILE_SCOPES.includes(s),
    );
    if (!hasProfile) return 'incomplete';
  }

  return 'linked';
}

/**
 * The OAuth link quality inside the user's isolated `.credentials.json`
 * ('none' when missing/unreadable). See classifyOauthLink.
 *
 * @param {string} claudeDir
 * @returns {Promise<'none'|'expired'|'incomplete'|'linked'>}
 */
async function oauthLinkQuality(claudeDir) {
  try {
    const content = await readFile(path.join(claudeDir, '.credentials.json'), 'utf8');
    const creds = asObject(JSON.parse(content));
    const oauth = asObject(creds?.claudeAiOauth);
    return classifyOauthLink(oauth, Date.now());
  } catch {
    return 'none';
  }
}

/**
 * True if the user's isolated settings.json carries the inference-only
 * `CLAUDE_CODE_OAUTH_TOKEN` (setup-token) and NO full API key. B-1260: this
 * works for a turn but is a PARTIAL link (no usage/profile), so the card shows
 * "incomplete link" rather than plain "connected".
 */
async function hasSettingsSetupTokenOnly(claudeDir) {
  try {
    const content = await readFile(path.join(claudeDir, 'settings.json'), 'utf8');
    const settings = asObject(JSON.parse(content));
    const env = asObject(settings?.env);
    if (!env) return false;
    const hasApiKey = nonEmptyString(env.ANTHROPIC_API_KEY)
      || nonEmptyString(env.ANTHROPIC_AUTH_TOKEN);
    return !hasApiKey && Boolean(nonEmptyString(env.CLAUDE_CODE_OAUTH_TOKEN));
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
 * B-1260: distinguishes a FULL link (`connected: true`) from a PARTIAL one
 * (`connected: false, incompleteLink: true`) — an inference-only setup-token, or
 * a `.credentials.json` with no refresh token (or inference-only scopes). The
 * card then shows "incomplete link — re-link" instead of a false "connected".
 *
 * @param {string|number} userId authenticated user id
 * @param {{ isolated?: boolean }} [options] test seam for the sharing policy
 * @returns {Promise<{ connected: boolean, incompleteLink: boolean, provider: 'claude' }>}
 */
export async function getClaudeConnectionStatus(userId, options = {}) {
  const isolated = options.isolated ?? isProviderIsolated('claude');
  const claudeDir = resolveClaudeStatusDir(userId, isolated);

  const fullApiKey = await hasSettingsCredential(claudeDir);
  const oauthQuality = await oauthLinkQuality(claudeDir);
  if (fullApiKey || oauthQuality === 'linked') {
    return { connected: true, incompleteLink: false, provider: 'claude' };
  }

  const setupTokenOnly = await hasSettingsSetupTokenOnly(claudeDir);
  if (oauthQuality === 'incomplete' || setupTokenOnly) {
    return { connected: false, incompleteLink: true, provider: 'claude' };
  }

  return { connected: false, incompleteLink: false, provider: 'claude' };
}
