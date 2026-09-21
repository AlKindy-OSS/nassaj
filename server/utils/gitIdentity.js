/**
 * Per-user git identity & push-credential helpers (B-MU-UX-GIT-ID).
 *
 * The nassaj workspace is shared by design (brothers, full trust), but commit
 * AUTHORSHIP and push CREDENTIALS must be attributed per user so each one's work
 * is recorded under his own name and (optionally) pushed via his own GitHub
 * token. These helpers inject that identity TRANSIENTLY — never via
 * `git config --global` and never persisted into `.git/config` — so saving one
 * user's identity can't clobber another's.
 *
 * Fallback contract (attribution, not isolation):
 *   - No stored git_name/git_email  -> {} (commit falls back to system/global config).
 *   - No active GitHub token         -> null (push falls back to the shared remote).
 *   - origin not an https github URL -> null (skip token injection, push as-is).
 */

import { userDb, githubTokensDb } from '../modules/database/index.js';

/**
 * Builds the GIT_AUTHOR_ / GIT_COMMITTER_ env overrides for a user's commit,
 * read strictly from the stored per-user identity (never from request input).
 *
 * Returns an empty object when the user has no stored identity, so the caller
 * can spread it into the spawn env and transparently fall back to the system
 * git config (current behavior) without blocking the commit.
 *
 * @param {number|string|null|undefined} userId authenticated user id
 * @returns {{GIT_AUTHOR_NAME?:string,GIT_AUTHOR_EMAIL?:string,GIT_COMMITTER_NAME?:string,GIT_COMMITTER_EMAIL?:string}}
 */
export function buildGitAuthorEnv(userId) {
  if (userId === null || userId === undefined || userId === '') {
    return {};
  }

  let gitConfig;
  try {
    gitConfig = userDb.getGitConfig(Number(userId));
  } catch {
    return {};
  }

  const name = gitConfig?.git_name?.trim();
  const email = gitConfig?.git_email?.trim();

  // Require BOTH name and email to override identity; a partial identity would
  // produce a malformed/confusing author, so fall back to system config instead.
  if (!name || !email) {
    return {};
  }

  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * Returns the requesting user's active GitHub token, or null when none is
 * stored (caller falls back to the shared push credentials). Read strictly from
 * the per-user store keyed by the authenticated user id.
 *
 * @param {number|string|null|undefined} userId authenticated user id
 * @returns {string|null}
 */
export function getUserGithubToken(userId) {
  if (userId === null || userId === undefined || userId === '') {
    return null;
  }
  try {
    return githubTokensDb.getActiveGithubToken(Number(userId));
  } catch {
    return null;
  }
}

/**
 * Builds a token-authenticated https URL for a push, mirroring the existing
 * clone approach (`https://<token>@github.com/<owner>/<repo>.git`).
 *
 * Returns null — so the caller skips token injection and uses the stored remote
 * unchanged — when there is no token, or when the remote is not an https
 * github.com URL (SSH remotes, other hosts, agy/placeholder repos, missing
 * origin). The token is used only to build a transient URL passed directly to
 * `git push`; it is NEVER written into `.git/config` and NEVER logged.
 *
 * @param {string|null|undefined} remoteUrl resolved URL of the current remote
 * @param {string|null|undefined} token user's active GitHub token
 * @returns {string|null} token-embedded https URL, or null to fall back
 */
export function buildTokenPushUrl(remoteUrl, token) {
  if (!token || !remoteUrl) {
    return null;
  }

  const url = remoteUrl.trim();

  // Only inject into plain https github.com remotes. Anything else (SSH,
  // git://, other hosts, or a URL that already embeds credentials) is left
  // untouched so we never corrupt the remote or leak a token into a non-github
  // host.
  if (!/^https:\/\/github\.com\//i.test(url)) {
    return null;
  }
  if (url.includes('@github.com')) {
    // Remote already carries credentials — don't double-inject.
    return null;
  }

  return url.replace(/^https:\/\/github\.com\//i, `https://${token}@github.com/`);
}
