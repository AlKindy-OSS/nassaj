/**
 * gitIdentity.test.ts — per-user git authorship & push-credential helpers
 * (B-MU-UX-GIT-ID). Pushes authenticate through an ephemeral askpass helper
 * (server/routes/agent.js), so no helper here embeds a token into a URL.
 *
 * Runner: Node built-in test runner (node:test + node:assert) via tsx.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGitAuthorEnv, getUserGithubToken } from './gitIdentity.js';


describe('buildGitAuthorEnv / getUserGithubToken — null user fallback', () => {
  it('returns an empty object for a null/undefined/empty user (no identity override)', () => {
    assert.deepEqual(buildGitAuthorEnv(null), {});
    assert.deepEqual(buildGitAuthorEnv(undefined), {});
    assert.deepEqual(buildGitAuthorEnv(''), {});
  });

  it('returns null token for a null/undefined/empty user (shared push)', () => {
    assert.equal(getUserGithubToken(null), null);
    assert.equal(getUserGithubToken(undefined), null);
    assert.equal(getUserGithubToken(''), null);
  });
});
