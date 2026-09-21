import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import test from 'node:test';

import {
    createGitTagReleaseDiscovery, selectLatestAnnotatedReleaseTag,
} from './git-tag-release-discovery.js';

const sha = (n) => String(n).repeat(40).slice(0, 40);

test('selects the latest annotated four-part tag and ignores the rest (T-1569)', () => {
    const stdout = [
        `${sha('a')}\trefs/tags/v1.46.0.9`,
        `${sha('b')}\trefs/tags/v1.46.0.9^{}`,        // annotated
        `${sha('c')}\trefs/tags/v1.47.0.0`,
        `${sha('d')}\trefs/tags/v1.47.0.0^{}`,        // annotated, latest
        `${sha('e')}\trefs/tags/v1.47.0.1`,            // lightweight (no ^{}), ignored
        `${sha('f')}\trefs/tags/v1.48.0`,              // three-part, ignored
        `${sha('0')}\trefs/tags/v1.48.0^{}`,
        `${sha('9')}\trefs/tags/not-a-version^{}`,     // malformed, ignored
        'garbage line',
    ].join('\n');
    const latest = selectLatestAnnotatedReleaseTag(stdout);
    assert.deepEqual(latest, { version: '1.47.0.0', commit: sha('d') });
    assert.equal(selectLatestAnnotatedReleaseTag(''), null);
    // Only-lightweight tags yield nothing.
    assert.equal(selectLatestAnnotatedReleaseTag(`${sha('a')}\trefs/tags/v1.47.0.0`), null);
});

test('discovery returns the latest tag, caches, and maps errors (T-1569)', async () => {
    let calls = 0;
    const stdout = `${sha('a')}\trefs/tags/v1.47.0.2\n${sha('b')}\trefs/tags/v1.47.0.2^{}\n`;
    const discover = createGitTagReleaseDiscovery({
        appRoot: '/opt/nassaj',
        env: { NASSAJ_RELEASE_SOURCE: 'https://github.com/your-org/nassaj-dev' },
        lsRemote: async () => { calls += 1; return { ok: true, stdout }; },
    });
    const { release } = await discover();
    assert.equal(release.version, '1.47.0.2');
    assert.equal(release.tagName, 'v1.47.0.2');
    assert.equal(release.commit, sha('b'));
    assert.equal(release.assetId, null);
    assert.equal(release.htmlUrl, 'https://github.com/your-org/nassaj-dev/releases/tag/v1.47.0.2');
    await discover();
    assert.equal(calls, 1, 'a fresh result is cached');
});

test('an unavailable remote and an empty tag set fail closed with actionable codes (T-1569)', async () => {
    const unavailable = createGitTagReleaseDiscovery({ appRoot: '/opt/nassaj', lsRemote: async () => ({ ok: false }) });
    await assert.rejects(unavailable(), (error) => error.code === 'release_source_unavailable');

    const empty = createGitTagReleaseDiscovery({
        appRoot: '/opt/nassaj',
        env: { NASSAJ_RELEASE_SOURCE: 'https://github.com/your-org/nassaj-dev' },
        lsRemote: async () => ({ ok: true, stdout: '' }),
    });
    await assert.rejects(empty(), (error) => (
        error.code === 'release_not_found'
        && error.message.includes('github.com/your-org/nassaj-dev')
        && error.message.includes('NASSAJ_RELEASE_SOURCE')
    ));
});

test('an invalid update remote name is rejected at construction (T-1569)', () => {
    assert.throws(() => createGitTagReleaseDiscovery({ appRoot: '/opt/nassaj', remote: 'bad name; rm -rf' }),
        /invalid_update_remote/);
});

test('discovers the latest annotated tag from a real remote via the node git credentials (T-1569)', (t) => {
    const root = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-gittag-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.git');
    const work = path.join(root, 'work');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@x', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@x' };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env });
    execFileSync('git', ['init', '-q', '--bare', source], { env });
    git(root, 'clone', '-q', source, work);
    fs.writeFileSync(path.join(work, 'f'), 'x');
    git(work, 'add', 'f');
    git(work, 'commit', '-qm', 'init');
    git(work, 'tag', '-a', 'v1.46.0.9', '-m', 'r');
    git(work, 'tag', '-a', 'v1.47.0.0', '-m', 'r');
    git(work, 'tag', 'v1.47.0.1');                    // lightweight — must be ignored
    git(work, 'tag', '-a', 'v1.48.0', '-m', 'r');     // three-part — must be ignored
    git(work, 'push', '-q', '--tags', 'origin', 'HEAD');
    const expectedCommit = git(work, 'rev-parse', 'HEAD^{commit}').toString().trim();

    const discover = createGitTagReleaseDiscovery({ appRoot: work, remote: 'origin', env });
    return discover().then(({ release }) => {
        assert.equal(release.version, '1.47.0.0');
        assert.equal(release.commit, expectedCommit);
    });
});
