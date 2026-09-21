#!/usr/bin/env node
/**
 * Create the local release fixture for the update laboratory (WI-0 / ADR-156).
 *
 * Builds a BARE repository under `.artifacts/update-lab/fixture/` that holds the
 * current tree at a chosen base commit plus one synthetic four-part release
 * commit (default `9.0.0.1`) carrying a matching `package.json` version and a
 * `v<version>` tag. Nothing is pushed anywhere: the bare repo is produced with a
 * hard-linked local clone and the release commit is written with git plumbing,
 * so the live working copy is never checked out, modified, or given a remote.
 *
 * Usage:
 *   node scripts/update-lab/create-fixture-repo.mjs [--base <rev>] [--version 9.0.0.1] [--force]
 *   node scripts/update-lab/create-fixture-repo.mjs --append --version 9.0.0.2
 *   node scripts/update-lab/create-fixture-repo.mjs --append --version 9.0.0.2 --gitlink-op add
 */
import fs from 'node:fs';
import path from 'node:path';

import {
    FIXTURE_META, FIXTURE_REPO, FIXTURE_ROOT, LAB_REMOTE_URL, REPO_ROOT,
    assertLabSafety, fail, git, log, mustGit, parseArgs, readJson, writeJson, writeSshShim,
} from './lab-common.mjs';

const GITLINK_DEFAULT_PATH = 'plugins/starter';
/** A release-owned path used by S2 (untracked collision inside the changed set). */
const RELEASE_NOTE_PATH = 'docs/update-lab-release-note.md';
const IDENTITY = {
    GIT_AUTHOR_NAME: 'Nassaj Update Lab',
    GIT_AUTHOR_EMAIL: 'update-lab@localhost',
    GIT_COMMITTER_NAME: 'Nassaj Update Lab',
    GIT_COMMITTER_EMAIL: 'update-lab@localhost',
};

const FOUR_PART = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Read one blob from a commit in the given repository. */
function showBlob(repo, commit, file) {
    const result = git(['show', `${commit}:${file}`], repo);
    return result.code === 0 ? result.stdout : null;
}

/** Write a blob into the object database and return its id. */
function hashObject(repo, content) {
    const result = git(['hash-object', '-w', '--stdin'], repo, { input: content });
    if (result.code !== 0) fail(`hash-object failed: ${result.stderr}`);
    return result.stdout.trim();
}

/** Re-serialize a JSON manifest with a new version, preserving key order. */
function withVersion(text, version, isLock) {
    const parsed = JSON.parse(text);
    parsed.version = version;
    if (isLock && parsed.packages && parsed.packages['']) parsed.packages[''].version = version;
    return `${JSON.stringify(parsed, null, 2)}\n`;
}

function main() {
    const { options } = parseArgs(process.argv.slice(2));
    assertLabSafety();
    const version = typeof options.version === 'string' ? options.version : '9.0.0.1';
    if (!FOUR_PART.test(version)) fail(`--version must be a canonical four-part Nassaj release, got ${version}`);
    const tag = `v${version}`;
    const append = options.append === true;

    if (!append) {
        if (fs.existsSync(FIXTURE_ROOT) && options.force !== true) {
            fail(`${FIXTURE_ROOT} already exists; pass --force to recreate or --append to add a release`);
        }
        fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
        fs.mkdirSync(FIXTURE_ROOT, { recursive: true, mode: 0o700 });
        log(`cloning a hard-linked bare fixture from ${REPO_ROOT}`);
        mustGit(['clone', '--bare', '--local', '--quiet', REPO_ROOT, FIXTURE_REPO], REPO_ROOT);
        // Keep only `main`: the laboratory must never offer a real release tag.
        const refs = mustGit(['for-each-ref', '--format=%(refname)'], FIXTURE_REPO).split('\n').filter(Boolean);
        for (const ref of refs) {
            if (ref === 'refs/heads/main') continue;
            git(['update-ref', '-d', ref], FIXTURE_REPO);
        }
        mustGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], FIXTURE_REPO);
    }
    if (!fs.existsSync(FIXTURE_REPO)) fail(`${FIXTURE_REPO} does not exist; run without --append first`);

    // Resolve the base commit inside the fixture (it already carries the history).
    const requestedBase = typeof options.base === 'string' ? options.base : null;
    if (requestedBase && !append) {
        const resolved = mustGit(['rev-parse', '--verify', `${requestedBase}^{commit}`], REPO_ROOT);
        if (git(['cat-file', '-e', `${resolved}^{commit}`], FIXTURE_REPO).code !== 0) {
            fail(`--base ${requestedBase} (${resolved}) is not in the fixture's object store`);
        }
        // An older base, a local commit under test (`--base HEAD` from a
        // worktree), or one whose branch diverged after `main` moved on — any
        // commit that shares history with main. Never an unrelated history.
        // The fixture's main is reset to it just below, so divergence is harmless.
        if (git(['merge-base', resolved, 'refs/heads/main'], FIXTURE_REPO).code !== 0) {
            fail(`--base ${requestedBase} shares no history with main`);
        }
        mustGit(['update-ref', 'refs/heads/main', resolved], FIXTURE_REPO);
    }
    const baseCommit = mustGit(['rev-parse', '--verify', 'refs/heads/main^{commit}'], FIXTURE_REPO);
    if (git(['rev-parse', '--verify', `refs/tags/${tag}`], FIXTURE_REPO).code === 0) {
        fail(`tag ${tag} already exists in the fixture`);
    }

    // Build the release tree with plumbing: no checkout, no working copy.
    const indexFile = path.join(FIXTURE_ROOT, 'lab-index');
    fs.rmSync(indexFile, { force: true });
    const plumbingEnv = { GIT_INDEX_FILE: indexFile, ...IDENTITY };
    mustGit(['read-tree', baseCommit], FIXTURE_REPO, { env: plumbingEnv });

    const manifestText = showBlob(FIXTURE_REPO, baseCommit, 'package.json');
    if (!manifestText) fail('the base commit has no package.json');
    const baseVersion = JSON.parse(manifestText).version;
    const entries = [['package.json', hashObject(FIXTURE_REPO, withVersion(manifestText, version, false))]];
    const lockText = showBlob(FIXTURE_REPO, baseCommit, 'package-lock.json');
    if (lockText) entries.push(['package-lock.json', hashObject(FIXTURE_REPO, withVersion(lockText, version, true))]);
    // A release-owned path that the node does NOT have yet: S2 plants an
    // untracked file at exactly this path to test the "collision inside the
    // changed paths" blocker, and S1 plants one anywhere else.
    entries.push([RELEASE_NOTE_PATH, hashObject(FIXTURE_REPO, `# update-lab release ${version}\n\nSynthetic release note written by scripts/update-lab/create-fixture-repo.mjs.\n`)]);
    for (const [file, blob] of entries) {
        mustGit(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], FIXTURE_REPO, { env: plumbingEnv });
    }

    // Optional gitlink mutation for S6 (the B-1054 submodule family).
    const gitlinkPath = typeof options['gitlink-path'] === 'string' ? options['gitlink-path'] : GITLINK_DEFAULT_PATH;
    const gitlinkOp = typeof options['gitlink-op'] === 'string' ? options['gitlink-op'] : null;
    if (gitlinkOp === 'add') {
        const oid = typeof options['gitlink-oid'] === 'string' ? options['gitlink-oid'] : baseCommit;
        mustGit(['update-index', '--add', '--cacheinfo', `160000,${oid},${gitlinkPath}`], FIXTURE_REPO, { env: plumbingEnv });
    } else if (gitlinkOp === 'remove') {
        mustGit(['update-index', '--force-remove', gitlinkPath], FIXTURE_REPO, { env: plumbingEnv });
    } else if (gitlinkOp) {
        fail(`--gitlink-op must be add or remove, got ${gitlinkOp}`);
    }

    const tree = mustGit(['write-tree'], FIXTURE_REPO, { env: plumbingEnv });
    const message = `chore(release): update-lab fixture ${version}${gitlinkOp ? ` (gitlink ${gitlinkOp} ${gitlinkPath})` : ''}`;
    const releaseCommit = mustGit(['commit-tree', tree, '-p', baseCommit, '-m', message], FIXTURE_REPO, { env: plumbingEnv });
    mustGit(['update-ref', 'refs/heads/main', releaseCommit, baseCommit], FIXTURE_REPO, { env: plumbingEnv });
    // ANNOTATED on purpose: git-tag-release-discovery.js:64-80 only accepts a
    // tag proved annotated by its peeled `refs/tags/<tag>^{}` ls-remote line, so
    // a lightweight tag makes the job fail with `release_not_found`.
    mustGit(['tag', '-a', '-m', message, tag, releaseCommit], FIXTURE_REPO, { env: plumbingEnv });
    fs.rmSync(indexFile, { force: true });

    writeSshShim(FIXTURE_REPO);
    const previous = readJson(FIXTURE_META, null);
    const releases = [...(previous?.releases || []), { version, tag, releaseCommit, baseCommit, gitlinkOp, gitlinkPath: gitlinkOp ? gitlinkPath : null }];
    writeJson(FIXTURE_META, {
        schema: 'nassaj-update-lab-fixture/v1',
        createdAt: previous?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceRepo: REPO_ROOT,
        bareRepo: FIXTURE_REPO,
        remoteUrl: LAB_REMOTE_URL,
        baseCommit: previous?.baseCommit || baseCommit,
        baseVersion: previous?.baseVersion || baseVersion,
        latest: { version, tag, releaseCommit },
        releaseNotePath: RELEASE_NOTE_PATH,
        changedPaths: ['package.json', ...(lockText ? ['package-lock.json'] : []), RELEASE_NOTE_PATH],
        releases,
    });

    log(`fixture ready: ${FIXTURE_REPO}`);
    log(`  base   ${previous?.baseCommit || baseCommit} (package.json ${previous?.baseVersion || baseVersion})`);
    log(`  release ${releaseCommit} tagged ${tag} (package.json ${version})`);
    log(`  metadata ${FIXTURE_META}`);
}

main();
