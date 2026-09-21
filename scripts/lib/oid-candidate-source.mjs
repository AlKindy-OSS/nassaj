/** Immutable local-OID source copies; no Git checkout, index or worktree mutation. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Read the immutable Git blob inventory for one exact main OID. */
export function readOidSourceInventory(root, sourceOid) {
    if (!/^[a-f0-9]{40}$/.test(sourceOid || '')) fail('local_update_invalid_oid');
    const main = execFileSync('git', ['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: root, encoding: 'utf8' }).trim();
    if (main !== sourceOid) fail('local_update_target_changed');
    return execFileSync('git', ['ls-tree', '-r', '-z', sourceOid], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        .split('\0').filter(Boolean).map(record => {
            const match = record.match(/^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/);
            if (!match || match[3].split('/').some(part => !part || part === '.' || part === '..')
                || path.isAbsolute(match[3])) fail('local_update_unsupported_source_entry');
            return { mode: match[1], blob: match[2], name: match[3] };
        });
}

/** Verify the canonical linked-worktree metadata and both reciprocal pointers, without changing Git state. */
export function verifyOidLinkedWorktree(sourceRoot, commonDir, sourceOid) {
    const git = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim();
    const privateFile = file => {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o002
            || fs.realpathSync(file) !== file) fail('local_update_unsafe_git_metadata');
        return fs.readFileSync(file, 'utf8').trim();
    };
    const gitDir = git(['rev-parse', '--absolute-git-dir']);
    if (path.dirname(gitDir) !== path.join(commonDir, 'worktrees') || fs.realpathSync(gitDir) !== gitDir
        || git(['rev-parse', '--show-toplevel']) !== sourceRoot
        || git(['rev-parse', '--path-format=absolute', '--git-common-dir']) !== commonDir
        || git(['rev-parse', 'HEAD']) !== sourceOid || git(['rev-parse', '--symbolic-full-name', 'HEAD']) !== 'HEAD'
        || privateFile(path.join(sourceRoot, '.git')) !== `gitdir: ${gitDir}`
        || privateFile(path.join(gitDir, 'gitdir')) !== path.join(sourceRoot, '.git')
        || path.resolve(gitDir, privateFile(path.join(gitDir, 'commondir'))) !== commonDir) fail('local_update_worktree_binding_changed');
    return { gitDir, commonDir, sourceRoot, commit: sourceOid };
}

/** Verify all source blobs, including package/lock bytes, without consulting a mutable worktree. */
export function verifyOidSourceInventory(sourceRoot, sourceOid, inventory, { allowNodeModules = false, allowGitMetadata = false } = {}) {
    if (fs.realpathSync(sourceRoot) !== path.resolve(sourceRoot)) fail('local_update_unsafe_source');
    verifySourceMembership(sourceRoot, inventory, allowNodeModules, allowGitMetadata);
    for (const item of inventory) {
        const file = path.join(sourceRoot, item.name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
            || fs.realpathSync(file) !== file || Boolean(stat.mode & 0o111) !== (item.mode === '100755')) fail('local_update_source_changed');
        const bytes = fs.readFileSync(file);
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (blob !== item.blob) fail('local_update_source_changed');
    }
    return { kind: 'git-blob-inventory', commit: sourceOid, clean: true, files: inventory.length };
}

function verifySourceMembership(sourceRoot, inventory, allowNodeModules, allowGitMetadata) {
    const files = new Set(inventory.map(item => item.name)), directories = new Set();
    for (const name of files) {
        let parent = path.posix.dirname(name);
        while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
    }
    function walk(directory, prefix = '') {
        for (const name of fs.readdirSync(directory)) {
            const relative = `${prefix}${name}`, file = path.join(directory, name), stat = fs.lstatSync(file);
            if (allowGitMetadata && relative === '.git') {
                if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(file) !== file) fail('local_update_unsafe_git_metadata');
                continue;
            }
            if (allowNodeModules && relative === 'node_modules') {
                if (!stat.isDirectory() || fs.realpathSync(file) !== file) fail('local_update_unsafe_dependencies');
                continue;
            }
            if (stat.isDirectory() && directories.has(relative)) walk(file, `${relative}/`);
            else if (!stat.isFile() || !files.has(relative)) fail('local_update_unexpected_source_entry');
        }
    }
    walk(sourceRoot);
}

/** Copy verified immutable snapshot bytes to a private, writable lifecycle workspace. */
export function copyOidBuildSource(snapshot, sourceRoot, sourceOid, inventory) {
    verifyOidSourceInventory(snapshot, sourceOid, inventory);
    fs.mkdirSync(sourceRoot, { mode: 0o700 });
    for (const item of inventory) {
        const destination = path.join(sourceRoot, item.name);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(snapshot, item.name), destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, item.mode === '100755' ? 0o755 : 0o644);
    }
    return verifyOidSourceInventory(sourceRoot, sourceOid, inventory);
}
