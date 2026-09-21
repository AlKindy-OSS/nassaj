/** Resolve durable Git control state without assuming `.git` is a directory. */
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SAFE_CONTROL_NAME = /^nassaj-[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;

/**
 * Return the repository's real shared Git directory.
 *
 * A linked worktree intentionally has a regular `.git` *file*.  We accept that
 * Git-supported shape, but reject a symlinked entry or common directory so a
 * control-state filename can never be redirected outside Git's own directory.
 */
export function commonGitDir(root) {
    const repository = realpathSync(path.resolve(root));
    const gitEntry = path.join(repository, '.git');
    const entry = lstatSync(gitEntry);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error('git_control_entry_unsafe');
    }
    const result = spawnSync('git', [
        'rev-parse', '--path-format=absolute', '--git-common-dir',
    ], { cwd: repository, encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) throw new Error('git_control_common_dir_unresolved');
    const reported = String(result.stdout || '').trim();
    if (!path.isAbsolute(reported)) throw new Error('git_control_common_dir_not_absolute');
    const metadata = lstatSync(reported);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('git_control_common_dir_unsafe');
    const resolved = realpathSync(reported);
    if (resolved !== path.resolve(reported)) throw new Error('git_control_common_dir_redirected');
    return resolved;
}

/** Backwards-readable name for the durable, shared Git control directory. */
export const gitControlRoot = commonGitDir;

/** Resolve one flat, validated control filename beneath the shared Git dir. */
export function gitControlPath(root, name) {
    if (!SAFE_CONTROL_NAME.test(name) || name.includes('..')) throw new Error('git_control_filename_unsafe');
    const directory = commonGitDir(root);
    const file = path.join(directory, name);
    if (path.dirname(file) !== directory) throw new Error('git_control_path_escapes_common_dir');
    return file;
}
