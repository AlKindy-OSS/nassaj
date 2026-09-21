import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_PUBLIC_RELEASE_REPOSITORY_URL,
    normalizeGitHubRepositoryIdentity,
    resolveReleaseSource,
} from './release-source-config.js';

test('normalizeGitHubRepositoryIdentity rejects dot-only and leading-dot segments (ت2)', () => {
    for (const value of [
        'https://github.com/./nassaj',
        'https://github.com/AlKindy-OSS/..',
        'https://github.com/../nassaj',
        'https://github.com/AlKindy-OSS/.hidden',
        'git@github.com:./nassaj',
        'git@github.com:owner/..',
        'https://github.com/-owner/nassaj',
    ]) {
        assert.equal(normalizeGitHubRepositoryIdentity(value), null, `expected null for ${value}`);
    }
    // Legitimate names with interior dots/dashes still resolve.
    assert.equal(normalizeGitHubRepositoryIdentity('https://github.com/your-org/nassaj-dev.io')?.identity,
        'github.com/your-org/nassaj-dev.io');
});

test('an unset or empty NASSAJ_RELEASE_SOURCE falls back to the public OSS repository (T-1563)', () => {
    const parsed = normalizeGitHubRepositoryIdentity(DEFAULT_PUBLIC_RELEASE_REPOSITORY_URL);
    for (const env of [{}, { NASSAJ_RELEASE_SOURCE: '' }, { NASSAJ_RELEASE_SOURCE: '   ' }]) {
        const resolved = resolveReleaseSource(env);
        assert.equal(resolved.repositoryUrl, DEFAULT_PUBLIC_RELEASE_REPOSITORY_URL);
        assert.equal(resolved.identity, parsed.identity);
    }
});

test('a configured credential-free GitHub fork becomes the trusted release source (T-1563)', () => {
    const https = resolveReleaseSource({ NASSAJ_RELEASE_SOURCE: 'https://github.com/your-org/nassaj-dev' });
    assert.equal(https.owner, 'your-org');
    assert.equal(https.repo, 'nassaj-dev');
    assert.equal(https.identity, 'github.com/your-org/nassaj-dev');
    assert.equal(https.repositoryUrl, 'https://github.com/your-org/nassaj-dev');

    const ssh = resolveReleaseSource({ NASSAJ_RELEASE_SOURCE: '  git@github.com:your-org/nassaj-dev.git  ' });
    assert.equal(ssh.identity, 'github.com/your-org/nassaj-dev');
    assert.equal(ssh.repositoryUrl, 'git@github.com:your-org/nassaj-dev.git');
});

test('a bare remote name or embedded credential fails closed as invalid_release_source (T-1563)', () => {
    for (const value of [
        'origin',
        'upstream',
        'https://user:token@github.com/your-org/nassaj-dev',
        'https://gitlab.com/your-org/nassaj-dev',
        'https://github.com/your-org',
        'not a url',
    ]) {
        assert.throws(() => resolveReleaseSource({ NASSAJ_RELEASE_SOURCE: value }),
            /invalid_release_source/, `expected rejection for ${value}`);
    }
});
