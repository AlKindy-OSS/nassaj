/**
 * ADR-216 §6 fixtures: real git repositories under /var/tmp and a GitHub-shaped
 * remote served by a fake ssh transport.
 *
 * The ADR text suggests `url.<file>.insteadOf`, but `git remote get-url`
 * EXPANDS insteadOf, so `verifyReleaseRemote` would then see the file URL and
 * refuse `unsafe_remote` (§4.3 relies on exactly that expansion). Instead the
 * remote stays `git@github.com:test/repo.git` and `GIT_SSH_COMMAND` points at a
 * script that serves the bare repository: production code is unchanged (the
 * governed env composes an existing GIT_SSH_COMMAND, ADR-156 H5), and the same
 * env reaches child processes (doctor CLI, concurrency tests).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const TEMP = process.env.NASSAJ_TEST_TMP || '/var/tmp';
export const GITHUB_REMOTE = 'git@github.com:test/repo.git';
export const VERSION = '9.1.0.1';
export const TAG = `v${VERSION}`;
export const NEXT_VERSION = '9.1.0.2';

const IDENTITY = {
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};

/** Run git synchronously in `cwd` with a fixed identity and no system/global config. */
export function git(cwd, args, extraEnv = {}) {
    return execFileSync('git', args, {
        cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

export function tryGit(cwd, args) {
    try { return { ok: true, stdout: git(cwd, args) }; } catch (error) { return { ok: false, stdout: '', status: error.status }; }
}

/** A throwaway directory under /var/tmp, removed after the test. */
export function scratch(t, prefix) {
    const root = fs.mkdtempSync(path.join(TEMP, `nassaj-attach-${prefix}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function commitFile(work, file, content, message) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
    git(work, ['add', '--', file]);
    git(work, ['commit', '-q', '-m', message]);
    return git(work, ['rev-parse', 'HEAD']);
}

function writeVersion(work, version) {
    return commitFile(work, 'package.json', `${JSON.stringify({ name: 'nassaj', version }, null, 2)}\n`, `release ${version}`);
}

/**
 * A bare "remote" with an annotated release tag on main plus two later commits.
 * `topology: 'merge'` adds a merge into main whose second parent branched
 * BEFORE the tag (fact 2's size caveat); `'side'` puts the tag on a side branch
 * that main never merges; `lightweight` makes the tag lightweight.
 */
export function createRemote(root, { topology = 'linear', lightweight = false, extraTags = [] } = {}) {
    const work = path.join(root, 'author');
    const bare = path.join(root, 'remote.git');
    fs.mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    commitFile(work, 'README.md', 'root\n', 'root');
    if (topology === 'merge') {
        git(work, ['checkout', '-q', '-b', 'old-side']);
        commitFile(work, 'side/a.txt', 'a\n', 'side a');
        commitFile(work, 'side/b.txt', 'b\n', 'side b');
        git(work, ['checkout', '-q', 'main']);
    }
    let tagCommit;
    if (topology === 'side') {
        writeVersion(work, '9.0.0.9');
        git(work, ['checkout', '-q', '-b', 'side']);
        tagCommit = writeVersion(work, VERSION);
        git(work, ['checkout', '-q', 'main']);
    } else {
        tagCommit = writeVersion(work, VERSION);
    }
    git(work, lightweight ? ['tag', TAG, tagCommit] : ['tag', '-a', TAG, '-m', TAG, tagCommit]);
    commitFile(work, 'later/one.txt', '1\n', 'later one');
    if (topology === 'merge') git(work, ['merge', '-q', '--no-ff', '-m', 'merge old side', 'old-side']);
    const next = writeVersion(work, NEXT_VERSION);
    git(work, ['tag', '-a', `v${NEXT_VERSION}`, '-m', `v${NEXT_VERSION}`, next]);
    for (const extra of extraTags) git(work, ['tag', '-a', extra, '-m', extra, tagCommit]);
    git(root, ['clone', '-q', '--bare', work, bare]);
    return { work, bare, tagCommit, nextCommit: next, mainTip: git(bare, ['rev-parse', 'refs/heads/main']) };
}

/** A linear remote with a fresh root and tags on main (the sanitized public export, test 13). */
export function createPublicExportRemote(root) {
    return createRemote(root, { topology: 'linear' });
}

/**
 * The fake ssh: serves `git-upload-pack` from `FAKE_SSH_REPO`, optionally after
 * `FAKE_SSH_DELAY` seconds; refuses anything else (no push, no shell).
 */
export function writeFakeSsh(root) {
    const script = path.join(root, 'fake-ssh');
    fs.writeFileSync(script, [
        '#!/bin/sh',
        'for last; do :; done',
        'case "$last" in',
        '  git-upload-pack*) ;;',
        '  *) exit 1 ;;',
        'esac',
        '[ -n "$FAKE_SSH_DELAY" ] && sleep "$FAKE_SSH_DELAY"',
        'exec git-upload-pack "$FAKE_SSH_REPO"',
        '',
    ].join('\n'), { mode: 0o755 });
    return script;
}

/** The environment that routes `git@github.com:test/repo.git` to the bare repo. */
export function remoteEnv(root, bare, { delaySeconds = 0, base = process.env } = {}) {
    const env = {
        ...base, ...IDENTITY, GIT_SSH_COMMAND: writeFakeSsh(root), FAKE_SSH_REPO: bare,
        NASSAJ_RELEASE_SOURCE: GITHUB_REMOTE,
    };
    if (delaySeconds) env.FAKE_SSH_DELAY = String(delaySeconds);
    else delete env.FAKE_SSH_DELAY;
    delete env.NASSAJ_UPDATE_BRANCH;
    delete env.NASSAJ_UPDATE_REMOTE;
    delete env.NASSAJ_UPDATE_CONTROL_ROOT;
    delete env.NASSAJ_UPDATE_CAPABILITY_FILE;
    return env;
}

/** Node "Fedora": `clone --branch vX --depth 1`, remote re-pointed at the GitHub URL. */
export function cloneFedora(root, bare, { name = 'node' } = {}) {
    const node = path.join(root, name);
    git(root, ['clone', '-q', '--branch', TAG, '--depth', '1', `file://${bare}`, node]);
    git(node, ['remote', 'set-url', 'origin', GITHUB_REMOTE]);
    return node;
}

/** Full clone of main reset to the tag commit, tracking origin/main (the fixed install, §3.6). */
export function cloneAttached(root, bare, { name = 'node', at = TAG } = {}) {
    const node = path.join(root, name);
    git(root, ['clone', '-q', '--branch', 'main', '--single-branch', `file://${bare}`, node]);
    git(node, ['fetch', '-q', 'origin', 'refs/tags/*:refs/tags/*']);
    git(node, ['reset', '-q', '--hard', at]);
    git(node, ['remote', 'set-url', 'origin', GITHUB_REMOTE]);
    return node;
}

/** Everything an attach could change: every ref, .git/config, HEAD and .git/shallow. */
export function refSnapshot(node) {
    const gitDir = path.join(node, '.git');
    const read = (file) => { try { return fs.readFileSync(path.join(gitDir, file), 'utf8'); } catch { return null; } };
    return {
        refs: git(node, ['for-each-ref', '--format=%(refname) %(objectname)']),
        config: read('config'),
        head: read('HEAD'),
        shallow: read('shallow'),
    };
}

/** Work-tree mtimes of every tracked file (attach must not touch them). */
export function worktreeMtimes(node) {
    return Object.fromEntries(git(node, ['ls-files', '-z']).split('\0').filter(Boolean)
        .map((file) => [file, fs.statSync(path.join(node, file)).mtimeMs]));
}

/** A quiescence reader for an idle node (overridable per test). */
export function idleQuiescence(overrides = {}) {
    return async () => ({ journal: null, unfinishedJobs: false, prestageState: null, ...overrides });
}
