import express from 'express';
import { Octokit } from '@octokit/rest';
import { githubTokensDb } from '../modules/database/index.js';

const router = express.Router();

/**
 * Resolve the GitHub token to use for a request.
 *
 * - When `tokenId` is provided, the specific stored token for the user is used.
 * - Otherwise the user's most recent active token is used.
 *
 * The raw token value is never returned to the caller; it is only handed to
 * Octokit for the upstream GitHub request.
 *
 * @param {number} userId
 * @param {string|undefined} tokenId
 * @returns {string|null} the raw token value, or null when none is configured
 */
function resolveGithubToken(userId, tokenId) {
  const isScalarTokenId =
    typeof tokenId === 'string' || typeof tokenId === 'number';

  if (
    isScalarTokenId &&
    tokenId !== undefined &&
    tokenId !== null &&
    String(tokenId).trim() !== ''
  ) {
    const parsedId = Number.parseInt(String(tokenId), 10);
    if (Number.isNaN(parsedId)) {
      return null;
    }
    const row = githubTokensDb.getGithubTokenById(userId, parsedId);
    return row ? row.github_token : null;
  }

  return githubTokensDb.getActiveGithubToken(userId);
}

/**
 * GET /api/github/repos
 *
 * Lists the repositories accessible to the authenticated user's stored GitHub
 * token. Used by the project-creation wizard to let users pick a repository to
 * clone instead of pasting a URL manually.
 *
 * Query params:
 *   - tokenId (optional): id of a specific stored GitHub token credential.
 *
 * Response shape (safe, no token leakage):
 *   { repositories: Array<{
 *       name, fullName, cloneUrl, private, defaultBranch, updatedAt
 *   }> }
 *
 * Error codes returned to the client:
 *   - no_token        (404): no GitHub token configured for this user.
 *   - invalid_token   (401): GitHub rejected the token (revoked / wrong scope).
 *   - github_error    (502): unexpected upstream GitHub failure.
 */
router.get('/repos', async (req, res) => {
  const userId = req.user.id;
  const { tokenId } = req.query;

  const token = resolveGithubToken(userId, tokenId);

  if (!token) {
    return res.status(404).json({
      code: 'no_token',
      error: 'No GitHub token configured',
    });
  }

  try {
    const octokit = new Octokit({ auth: token });

    const response = await octokit.repos.listForAuthenticatedUser({
      sort: 'updated',
      per_page: 100,
      visibility: 'all',
    });

    const repositories = (response.data || []).map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      private: Boolean(repo.private),
      defaultBranch: repo.default_branch || null,
      updatedAt: repo.updated_at || null,
    }));

    return res.json({ repositories });
  } catch (error) {
    const status = error?.status || error?.response?.status;

    if (status === 401) {
      return res.status(401).json({
        code: 'invalid_token',
        error: 'GitHub rejected the token. It may be revoked or missing the "repo" scope.',
      });
    }

    if (status === 403) {
      return res.status(403).json({
        code: 'forbidden',
        error: 'GitHub denied access. The token may lack the required scope or hit a rate limit.',
      });
    }

    console.error('Failed to list GitHub repositories:', {
      status: error?.status,
      message: error?.message,
    });
    return res.status(502).json({
      code: 'github_error',
      error: 'Failed to fetch repositories from GitHub. Please try again.',
    });
  }
});

export default router;
