// upgrade-path-trees.mjs — the installed release trees the upgrade-path gate runs (B-1584).
//
// A tree is trusted only when its tracked content is proven to be the declared
// commit: a git checkout must sit at that HEAD with a clean status; a tree
// materialised by `git archive` (no .git) must carry a marker binding it to the
// commit and its tree OID, and every tracked file is re-hashed as a git blob
// against the commit before each use. Cache directories must be private
// (owned by the current user, mode 0700, not a symlink).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { git } from './upgrade-path-gate-git.mjs';

export const TREE_MARKER = '.nassaj-upgrade-path-tree.json';
const MARKER_SCHEMA = 'nassaj-upgrade-path-tree/v1';

/** Refuse a directory that is a symlink, foreign-owned or not mode 0700. */
export function assertPrivateDirectory(directory) {
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        || (metadata.mode & 0o777) !== 0o700) {
        throw new Error(`upgrade-path gate: ${directory} must be a real directory owned by you with mode 0700`);
    }
}

/** Create `directory` (0700) when absent, then require it to be private. */
export function ensurePrivateDirectory(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(directory);
    return directory;
}

/** The git blob OID of one working-tree entry (regular file or symlink). */
function blobOid(file, mode) {
    const content = mode === '120000' ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** Throw unless every tracked entry of `commit` exists in `root` with identical bytes. */
export function verifyTreeContent({ root, sourceRepo, commit }) {
    const listing = git(sourceRepo, ['ls-tree', '-r', '-z', '--full-tree', commit], { trim: false });
    for (const record of listing.split('\0').filter(Boolean)) {
        const [meta, relative] = record.split('\t');
        const [mode, type, oid] = meta.split(' ');
        if (type !== 'blob') continue;
        const file = path.join(root, relative);
        let actual = null;
        try { actual = blobOid(file, mode); } catch { actual = null; }
        if (actual !== oid) throw new Error(`upgrade-path gate: ${root} differs from ${commit} at ${relative}`);
    }
}

/** Bind an archive tree to its commit (written only after its content is verified). */
function writeTreeMarker({ root, sourceRepo, commit }) {
    verifyTreeContent({ root, sourceRepo, commit });
    const marker = { schema: MARKER_SCHEMA, commit, tree: git(sourceRepo, ['rev-parse', `${commit}^{tree}`]) };
    writeFileSync(path.join(root, TREE_MARKER), `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: 'wx' });
}

/**
 * Prove `root` is `commit` before the gate runs code from it.
 * @returns {'git-checkout'|'archive'} how the identity was proven
 */
export function verifyTreeRoot({ root, sourceRepo, commit }) {
    if (existsSync(path.join(root, '.git'))) {
        const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
        if (head !== commit) throw new Error(`upgrade-path gate: ${root} is at ${head}, not ${commit}`);
        const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
        if (status) throw new Error(`upgrade-path gate: ${root} has local changes:\n${status.split('\n').slice(0, 5).join('\n')}`);
        return 'git-checkout';
    }
    let marker = null;
    try { marker = JSON.parse(readFileSync(path.join(root, TREE_MARKER), 'utf8')); } catch { marker = null; }
    if (marker?.schema !== MARKER_SCHEMA || marker.commit !== commit
        || marker.tree !== git(sourceRepo, ['rev-parse', `${commit}^{tree}`])) {
        throw new Error(`upgrade-path gate: ${root} is neither a clean checkout nor a marked tree of ${commit}`);
    }
    verifyTreeContent({ root, sourceRepo, commit });
    return 'archive';
}

/** Materialise one commit as an installed, marked tree (git archive + npm ci), cached by commit. */
export function installedTree({ sourceRepo, commit, treesRoot }) {
    ensurePrivateDirectory(treesRoot);
    const target = path.join(treesRoot, commit);
    if (existsSync(path.join(target, TREE_MARKER))) {
        verifyTreeRoot({ root: target, sourceRepo, commit });
        return target;
    }
    const staging = `${target}.staging`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    const archive = spawnSync('bash', ['-o', 'pipefail', '-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'archive',
        sourceRepo, commit, staging], { stdio: 'inherit' });
    if (archive.status !== 0) throw new Error(`upgrade-path gate: could not materialise ${commit}`);
    const install = spawnSync('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'],
        { cwd: staging, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, HUSKY: '0' } });
    if (install.status !== 0) throw new Error(`upgrade-path gate: npm ci failed for ${commit}`);
    writeTreeMarker({ root: staging, sourceRepo, commit });
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return target;
}
