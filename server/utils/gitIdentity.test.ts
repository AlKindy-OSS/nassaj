/**
 * gitIdentity.test.ts — per-user git authorship & push-credential helpers
 * (B-MU-UX-GIT-ID). Focuses on buildTokenPushUrl, the security-critical seam
 * that decides whether (and how) a GitHub token is embedded into a transient
 * push URL. Verifies it injects only into plain https github.com remotes and
 * falls back (null) for everything else, so a token never leaks into an SSH
 * remote, another host, or an already-credentialed URL.
 *
 * Runner: Node built-in test runner (node:test + node:assert) via tsx.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTokenPushUrl, buildGitAuthorEnv, getUserGithubToken } from './gitIdentity.js';

const TOKEN = 'ghp_exampletoken1234567890';

describe('buildTokenPushUrl', () => {
  it('embeds the token into a plain https github.com remote', () => {
    assert.equal(
      buildTokenPushUrl('https://github.com/owner/repo.git', TOKEN),
      `https://${TOKEN}@github.com/owner/repo.git`
    );
  });

  it('embeds the token into an https github.com remote without .git suffix', () => {
    assert.equal(
      buildTokenPushUrl('https://github.com/owner/repo', TOKEN),
      `https://${TOKEN}@github.com/owner/repo`
    );
  });

  it('trims surrounding whitespace before injecting', () => {
    assert.equal(
      buildTokenPushUrl('  https://github.com/owner/repo.git\n', TOKEN),
      `https://${TOKEN}@github.com/owner/repo.git`
    );
  });

  it('returns null when there is no token (fall back to shared remote)', () => {
    assert.equal(buildTokenPushUrl('https://github.com/owner/repo.git', null), null);
    assert.equal(buildTokenPushUrl('https://github.com/owner/repo.git', ''), null);
  });

  it('returns null when there is no remote url', () => {
    assert.equal(buildTokenPushUrl(null, TOKEN), null);
    assert.equal(buildTokenPushUrl('', TOKEN), null);
  });

  it('returns null for SSH remotes (no token leak into ssh)', () => {
    assert.equal(buildTokenPushUrl('git@github.com:owner/repo.git', TOKEN), null);
    assert.equal(buildTokenPushUrl('ssh://git@github.com/owner/repo.git', TOKEN), null);
  });

  it('returns null for non-github https hosts (no token leak to other hosts)', () => {
    assert.equal(buildTokenPushUrl('https://gitlab.com/owner/repo.git', TOKEN), null);
    assert.equal(buildTokenPushUrl('https://example.com/owner/repo.git', TOKEN), null);
  });

  it('returns null for a remote that already embeds credentials (no double-inject)', () => {
    assert.equal(
      buildTokenPushUrl('https://someone@github.com/owner/repo.git', TOKEN),
      null
    );
  });

  it('does not match http (non-tls) github urls', () => {
    assert.equal(buildTokenPushUrl('http://github.com/owner/repo.git', TOKEN), null);
  });
});

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
