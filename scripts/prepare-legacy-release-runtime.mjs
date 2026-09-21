#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
    chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
    readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVerifiedSqliteBackup, verifySqliteDatabase } from './lib/release-database-backup.mjs';

const HEX64 = /^[a-f0-9]{64}$/; const HEX40 = /^[a-f0-9]{40}$/;
const SCHEMA = 'nassaj-legacy-release-prepare/v1';
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function syncDirectory(directory) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ownerDirectory(directory, create = false) {
    if (create && !existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw new Error('legacy_directory_unsafe');
    return realpathSync(directory);
}
function ownerFile(file) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw new Error('legacy_file_unsafe');
    return metadata;
}
function readOwnerFile(file, requiredMode = null) {
    const before = ownerFile(file);
    if (requiredMode !== null && (before.mode & 0o777) !== requiredMode) throw new Error('legacy_file_mode_unsafe');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) throw new Error('legacy_file_changed');
        const bytes = readFileSync(fd); const after = lstatSync(file);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== opened.size) throw new Error('legacy_file_changed');
        return bytes;
    } finally { closeSync(fd); }
}
function writePrivateExact(file, bytes) {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function atomicJson(file, value) {
    const temporary = `${file}.partial-${process.pid}-${randomUUID()}`; const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file); syncDirectory(path.dirname(file));
}
function checkpoint(options, journalFile, journal, phase, facts = {}) {
    options.testHooks?.beforeCheckpoint?.(phase);
    const next = { ...journal, phase, sequence: journal.sequence + 1, facts: { ...journal.facts, ...facts } };
    atomicJson(journalFile, next); options.testHooks?.afterCheckpoint?.(phase); return next;
}
function inventoryTree(root, relative = '', output = [], copyRoot = null) {
    function walk(directory, prefix) {
        const before = lstatSync(directory);
        if (!before.isDirectory() || before.isSymbolicLink()
            || (typeof process.getuid === 'function' && before.uid !== process.getuid())) throw new Error('legacy_tree_unsafe');
        const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const opened = fstatSync(directoryFd);
        if (opened.dev !== before.dev || opened.ino !== before.ino) { closeSync(directoryFd); throw new Error('legacy_tree_changed'); }
        const anchored = `/proc/self/fd/${directoryFd}`;
        try {
            for (const entry of readdirSync(anchored, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                const itemRelative = path.posix.join(prefix, entry.name); const item = path.join(anchored, entry.name);
                const metadata = lstatSync(item);
                if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) throw new Error('legacy_tree_unsafe');
                if (itemRelative === 'objects/info/alternates') throw new Error('legacy_git_alternates_unsafe');
                if (entry.name.endsWith('.lock')) throw new Error('legacy_git_lock_unsafe');
                if (metadata.isDirectory()) {
                    if (copyRoot) mkdirSync(path.join(copyRoot, itemRelative), { mode: 0o700 });
                    walk(item, itemRelative); continue;
                }
                const bytes = readOwnerFile(item); output.push({ path: itemRelative, size: bytes.length,
                    mode: metadata.mode & 0o777, sha256: sha(bytes) });
                if (copyRoot) writePrivateExact(path.join(copyRoot, itemRelative), bytes);
            }
            const after = fstatSync(directoryFd);
            if (after.dev !== opened.dev || after.ino !== opened.ino) throw new Error('legacy_tree_changed');
        } finally { closeSync(directoryFd); }
    }
    walk(relative ? path.join(root, relative) : root, relative.split(path.sep).join('/'));
    return output;
}
function validateCommitMap(file) {
    ownerFile(file); const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.schema !== 'nassaj-legacy-commit-map/v1' || !Array.isArray(value.commits)) throw new Error('legacy_commit_map_invalid');
    for (const commit of value.commits) {
        if (!HEX40.test(commit?.commit || '') || !Array.isArray(commit.changedPaths) || commit.changedPaths.length === 0
            || commit.changedPaths.some((candidate) => typeof candidate !== 'string' || candidate.startsWith('/') || candidate.includes('..'))
            || (commit.kind === 'public_hub' && commit.changedPaths.some((candidate) => !candidate.startsWith('public/hub/')))
            || !['public_hub', 'host_local'].includes(commit.kind)) throw new Error('legacy_commit_map_invalid');
    }
    return value;
}
function contentInventory(entries) {
    return entries.map(({ path: entryPath, size, sha256 }) => ({ path: entryPath, size, sha256 }));
}
function verifyPreservedGit(gitDirectory, legacyHead, requiredCommits = []) {
    const commits = [...new Set([legacyHead, ...requiredCommits])];
    if (commits.some((commit) => !HEX40.test(commit || '')) || new Set(requiredCommits).size !== requiredCommits.length) {
        throw new Error('legacy_required_commits_invalid');
    }
    const environment = { PATH: process.env.PATH, HOME: path.dirname(gitDirectory), GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
    try {
        execFileSync('git', ['--git-dir', gitDirectory, 'fsck', '--full', '--no-dangling'], { env: environment,
            stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
        for (const commit of commits) execFileSync('git', ['--git-dir', gitDirectory, 'cat-file', '-e', `${commit}^{commit}`], {
            env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    } catch { throw new Error('legacy_git_fsck_failed'); }
    return Object.freeze({ head: legacyHead, requiredCommits: [...requiredCommits], fsck: 'full_ok' });
}

/** Prepare durable inert evidence. Git is invoked read-only for fsck/cat-file; npm, PM2 and network are never invoked. */
export function prepareLegacyMigration(options) {
    if (!path.isAbsolute(options?.legacyRoot || '') || !path.isAbsolute(options?.deployRoot || '')
        || !HEX64.test(options?.releaseIdentitySha256 || '') || !HEX40.test(options?.legacyHead || '')) throw new Error('legacy_prepare_identity_invalid');
    const legacyRoot = realpathSync(options.legacyRoot); const deployRoot = ownerDirectory(options.deployRoot);
    const control = ownerDirectory(path.join(deployRoot, 'control')); const snapshots = ownerDirectory(path.join(control, 'legacy-snapshots'), true);
    if (statSync(control).dev !== statSync(snapshots).dev) throw new Error('legacy_prepare_cross_device');
    const identity = sha(canonical({ legacyRoot, legacyHead: options.legacyHead, releaseIdentitySha256: options.releaseIdentitySha256,
        nodeInstanceId: options.nodeInstanceId }));
    const target = path.join(snapshots, identity); if (!existsSync(target)) mkdirSync(target, { mode: 0o700 });
    ownerDirectory(target); const journalFile = path.join(target, 'prepare-journal.json');
    let journal = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : { schema: SCHEMA, identity,
        state: 'preparing', phase: 'accepted', sequence: 0, facts: {} };
    if (journal.schema !== SCHEMA || journal.identity !== identity) throw new Error('legacy_prepare_journal_mismatch');
    if (!existsSync(journalFile)) atomicJson(journalFile, journal);
    const gitRoot = path.join(legacyRoot, '.git'); ownerDirectory(gitRoot);
    const gitCopy = path.join(target, 'git'); const gitInventoryFile = path.join(target, 'git-inventory.json');
    const sourceEntries = inventoryTree(gitRoot);
    if (existsSync(gitCopy)) {
        if (!existsSync(gitInventoryFile)) throw new Error('legacy_git_partial_snapshot');
        const expectedInventory = JSON.parse(readOwnerFile(gitInventoryFile, 0o600));
        const copiedEntries = inventoryTree(gitCopy);
        if (canonical(expectedInventory.entries) !== canonical(sourceEntries)
            || canonical(contentInventory(copiedEntries)) !== canonical(contentInventory(sourceEntries))
            || expectedInventory.digest !== sha(canonical(sourceEntries))) throw new Error('legacy_git_inventory_mismatch');
    } else {
        const partial = path.join(target, `git.partial-${process.pid}`);
        if (existsSync(partial)) rmSync(partial, { recursive: true });
        mkdirSync(partial, { mode: 0o700 }); inventoryTree(gitRoot, '', [], partial);
        const copiedEntries = inventoryTree(partial);
        if (canonical(contentInventory(copiedEntries)) !== canonical(contentInventory(sourceEntries))) throw new Error('legacy_git_copy_mismatch');
        options.testHooks?.afterGitCopyBeforeRescan?.();
        const sourceAfter = inventoryTree(gitRoot);
        if (canonical(sourceAfter) !== canonical(sourceEntries)) throw new Error('legacy_git_source_changed');
        renameSync(partial, gitCopy); syncDirectory(target);
        atomicJson(gitInventoryFile, { entries: sourceEntries, digest: sha(canonical(sourceEntries)) });
    }
    const gitVerification = verifyPreservedGit(gitCopy, options.legacyHead, options.requiredCommits || []);
    journal = checkpoint(options, journalFile, journal, 'git-preserved', { gitVerification });
    if ((options.requiredCommits || []).length > 0 && !options.commitMapFile) throw new Error('legacy_required_commits_need_mapping');
    const excluded = new Set(['.git', 'node_modules']); const working = [];
    for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
        if (excluded.has(entry.name)) continue;
        const item = path.join(legacyRoot, entry.name); const metadata = lstatSync(item);
        if (metadata.isSymbolicLink()) throw new Error('legacy_worktree_symlink');
        if (metadata.isFile()) { const bytes = readOwnerFile(item); working.push({ path: entry.name, size: bytes.length, sha256: sha(bytes) }); }
        else if (metadata.isDirectory()) inventoryTree(legacyRoot, entry.name, working);
    }
    working.sort((a, b) => a.path.localeCompare(b.path)); atomicJson(path.join(target, 'working-inventory.json'), { entries: working, digest: sha(canonical(working)) });
    journal = checkpoint(options, journalFile, journal, 'working-inventoried');
    const pm2 = JSON.parse(readOwnerFile(options.pm2SnapshotFile, 0o600));
    if (pm2?.schema !== 'nassaj-pm2-snapshot/v1' || typeof pm2.name !== 'string' || typeof pm2.pmExecPath !== 'string'
        || !Number.isSafeInteger(pm2.killTimeout) || pm2.killTimeout < 86_400_000) throw new Error('legacy_pm2_snapshot_invalid');
    atomicJson(path.join(target, 'pm2-snapshot.json'), pm2); journal = checkpoint(options, journalFile, journal, 'pm2-preserved');
    const configs = [];
    for (const configFile of options.configFiles || []) { const bytes = readOwnerFile(configFile, 0o600);
        const copy = path.join(target, `config-${configs.length}.bin`); if (!existsSync(copy)) writePrivateExact(copy, bytes);
        else if (!readOwnerFile(copy, 0o600).equals(bytes)) throw new Error('legacy_config_target_mismatch');
        configs.push({ ordinal: configs.length, size: bytes.length, sha256: sha(bytes) }); }
    atomicJson(path.join(target, 'config-inventory.json'), { entries: configs }); journal = checkpoint(options, journalFile, journal, 'config-preserved');
    const database = options.databaseFile; readOwnerFile(database, 0o600); const databaseTarget = path.join(target, 'database.sqlite');
    const databaseBackup = existsSync(databaseTarget) ? verifySqliteDatabase(databaseTarget)
        : createVerifiedSqliteBackup(database, databaseTarget);
    if (journal.facts.databaseBackup && canonical(journal.facts.databaseBackup) !== canonical(databaseBackup)) {
        throw new Error('legacy_database_target_mismatch');
    }
    journal = checkpoint(options, journalFile, journal, 'database-preserved', { databaseBackup });
    if (options.commitMapFile) { const mapping = validateCommitMap(options.commitMapFile);
        const mapped = mapping.commits.map((entry) => entry.commit).sort(); const required = [...(options.requiredCommits || [])].sort();
        if (canonical(mapped) !== canonical(required)) throw new Error('legacy_commit_map_required_mismatch');
        atomicJson(path.join(target, 'commit-map.json'), mapping);
        journal = checkpoint(options, journalFile, journal, 'commit-map-preserved', { commitMapSha256: sha(canonical(mapping)) }); }
    journal = { ...journal, state: 'prepared_not_activated', phase: 'prepared', sequence: journal.sequence + 1 };
    atomicJson(journalFile, journal); return Object.freeze({ state: journal.state, snapshotRoot: target, identity, journalFile });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.stderr.write('prepare-legacy-release-runtime is an imported prepare-only primitive; use the reviewed owner workflow.\n');
    process.exitCode = 64;
}
