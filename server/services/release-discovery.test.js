import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseDiscovery, ReleaseDiscoveryError } from './release-discovery.js';
import { normalizeGitHubRepositoryIdentity, resolveReleaseSource } from './release-source-config.js';

const source = {
    owner: 'AlKindy-OSS', repo: 'nassaj', identity: 'github.com/alkindy-oss/nassaj',
    repositoryUrl: 'https://github.com/AlKindy-OSS/nassaj',
};
const resolvedCommit = 'c'.repeat(40);
const legacyUpdateTokenKey = ['NASSAJ', 'UPDATE', 'GITHUB', 'TOKEN'].join('_');

function release(tag, overrides = {}) {
    return {
        id: 371801775, tag_name: tag, name: `Nassaj ${tag}`, body: `Notes for ${tag}`,
        html_url: `https://github.com/AlKindy-OSS/nassaj/releases/tag/${tag}`,
        published_at: '2026-08-17T10:00:00Z', draft: false, prerelease: false,
        assets: [{ id: 991, name: `nassaj-runtime-${tag}.tar.gz`, state: 'uploaded', size: 1234,
            digest: `sha256:${'b'.repeat(64)}` }], ...overrides,
    };
}
function jsonResponse(body, { status = 200 } = {}) {
    return new Response(status === 304 ? null : JSON.stringify(body), {
        status, headers: status === 304 ? {} : { 'content-type': 'application/json' },
    });
}
function governedResponse(url, body) {
    return String(url).includes('/commits/') ? jsonResponse({ sha: resolvedCommit }) : jsonResponse(body);
}

test('OSS source is immutable and legacy private settings are ignored during migration', () => {
    assert.deepEqual(resolveReleaseSource({}), source);
    assert.deepEqual(resolveReleaseSource({
        NASSAJ_RELEASE_CHANNEL: 'legacy', NASSAJ_SOURCE_REPOSITORY_URL: 'https://github.com/example/legacy-release',
        [legacyUpdateTokenKey]: 'stale-token',
    }), source);
    assert.equal(normalizeGitHubRepositoryIdentity('git@github.com:AlKindy-OSS/nassaj.git')?.identity, source.identity);
});

test('discovers only the canonical OSS release with no Authorization header', async () => {
    const calls = [];
    const discover = createReleaseDiscovery({
        env: { NASSAJ_RELEASE_CHANNEL: 'legacy', [legacyUpdateTokenKey]: 'old-token-must-not-leak' },
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), headers: options.headers });
            return governedResponse(url, release('v1.42.0.5', { html_url: 'https://evil.example/release' }));
        },
    });
    const result = await discover();
    assert.equal(result.release.version, '1.42.0.5');
    assert.equal(result.release.commit, resolvedCommit);
    assert.equal(result.release.htmlUrl, 'https://github.com/AlKindy-OSS/nassaj/releases/tag/v1.42.0.5');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(calls[1].headers.Authorization, undefined);
    assert.equal(calls[0].url, 'https://api.github.com/repos/AlKindy-OSS/nassaj/releases/latest');
});

test('fails closed on a non-immutable tag resolution and source rejection', async () => {
    const invalidCommit = createReleaseDiscovery({
        fetchImpl: async (url) => String(url).includes('/commits/') ? jsonResponse({ sha: 'main' }) : jsonResponse(release('v1.42.0.5')),
    });
    await assert.rejects(invalidCommit(), (error) => error.code === 'release_not_found');
    const rejected = createReleaseDiscovery({ fetchImpl: async () => jsonResponse({ message: 'Not Found' }, { status: 404 }) });
    await assert.rejects(rejected(), (error) => error instanceof ReleaseDiscoveryError && error.code === 'release_source_rejected');
});

test('coalesces cached requests and bounds unsafe upstream responses', async () => {
    let clock = 1_000; let calls = 0;
    const discover = createReleaseDiscovery({
        now: () => clock, ttlMs: 500,
        fetchImpl: async (url) => { calls += 1; return governedResponse(url, release('v1.42.0.5')); },
    });
    await Promise.all([discover(), discover()]);
    assert.equal(calls, 2);
    clock += 499; await discover(); assert.equal(calls, 2);
    const oversized = createReleaseDiscovery({ fetchImpl: async () => new Response('x', { status: 200, headers: { 'content-length': String(300 * 1024) } }) });
    await assert.rejects(oversized(), (error) => error instanceof ReleaseDiscoveryError && error.code === 'release_source_oversized');
});

test('bounds a stalled OSS GitHub request and sanitizes upstream display fields', async () => {
    const stalled = createReleaseDiscovery({ timeoutMs: 5, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
    await assert.rejects(stalled(), (error) => error.code === 'release_source_unavailable');
    const discover = createReleaseDiscovery({ fetchImpl: async (url) => governedResponse(url, release('v1.42.0.5', {
        name: 'x'.repeat(500), body: 'y'.repeat(40_000), html_url: 'https://evil.example/release', token: 'must-not-cross-boundary',
    })) });
    const { release: result } = await discover();
    assert.equal(result.title.length, 256); assert.equal(result.notes.length, 32 * 1024);
    assert.equal(result.htmlUrl, 'https://github.com/AlKindy-OSS/nassaj/releases/tag/v1.42.0.5');
    assert.equal('token' in result, false);
});
