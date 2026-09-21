/** Fixed root-configured kernel mutex. The retained parent FD owns the flock open-file-description. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { types } from 'node:util';
import { readInstalledHostConfiguration } from './release-runtime-installed-config.mjs';

class AcquisitionBusy extends Error { constructor() { super('cutover_state_busy'); } }
/** Distinguish clean pre-callback contention from arbitrary callback/helper error text. */
export function isCutoverStateAcquisitionBusy(error) { return error instanceof AcquisitionBusy; }
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equalIdentity = (a, b) => ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'].every(key => a[key] === b[key]);
function requireValue(value, reason) { if (!value) throw Error(`cutover_state_${reason}`); }
function trustedAncestors(file) {
    for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
        const info = fs.lstatSync(directory);
        requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022), 'ancestor_unsafe');
        requireValue(fs.realpathSync(directory) === directory, 'ancestor_changed');
        if (directory === '/') return;
    }
}
function checkedFile(file, mode, executable = false) {
    trustedAncestors(file);
    const info = fs.lstatSync(file);
    requireValue(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && info.nlink === 1
        && (executable ? !(info.mode & 0o022) && !!(info.mode & 0o111) : (info.mode & 0o777) === mode)
        && fs.realpathSync(file) === file, 'file_unsafe');
    return info;
}
function readVerified(file, privateMode, executable = false) {
    const before = checkedFile(file, privateMode, executable);
    requireValue(before.size > 0 && before.size <= (executable ? 16 * 1024 * 1024 : 262144), 'file_size');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd); requireValue(equalIdentity(before, opened) && before.size === opened.size, 'file_changed');
        const bytes = fs.readFileSync(fd);
        requireValue(bytes.length === before.size && equalIdentity(before, checkedFile(file, privateMode, executable)), 'file_changed');
        return { info: before, sha256: digest(bytes), bytes };
    } finally { fs.closeSync(fd); }
}
function authority(controlRoot) {
    requireValue(process.geteuid?.() === 0, 'root_required');
    const config = readInstalledHostConfiguration(); const value = config.value;
    const policy = value.stateLock;
    requireValue(value.schema === 'nassaj-release-runtime-host-config/v1'
        && value.controlRoot === controlRoot && path.resolve(controlRoot) === controlRoot
        && policy?.schema === 'nassaj-cutover-state-lock/v2'
        && Object.keys(policy).sort().join(',') === 'flock,schema'
        && Object.keys(policy.flock || {}).sort().join(',') === 'path,sha256'
        && policy.flock.path === '/usr/bin/flock' && /^[a-f0-9]{64}$/.test(policy.flock.sha256), 'configuration_invalid');
    trustedAncestors(path.join(controlRoot, 'entry'));
    const control = fs.lstatSync(controlRoot);
    requireValue(control.isDirectory() && control.uid === 0 && (control.mode & 0o777) === 0o700
        && fs.realpathSync(controlRoot) === controlRoot, 'control_unsafe');
    const executable = readVerified(policy.flock.path, null, true);
    requireValue(executable.sha256 === policy.flock.sha256, 'executable_mismatch');
    return { config, control, executable, policy };
}
function refuseLegacy(controlRoot) {
    try { fs.lstatSync(path.join(controlRoot, 'first-cutover-state.lock')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw Error('cutover_state_legacy_reconciliation_required');
}
function verifyCurrent(controlRoot, original, file, fd, identity) {
    const current = authority(controlRoot);
    requireValue(current.config.sha256 === original.config.sha256 && equalIdentity(current.config.info, original.config.info)
        && equalIdentity(current.control, original.control) && current.executable.sha256 === original.executable.sha256
        && equalIdentity(current.executable.info, original.executable.info), 'authority_changed');
    refuseLegacy(controlRoot);
    requireValue(equalIdentity(identity, fs.fstatSync(fd)) && equalIdentity(identity, checkedFile(file, 0o600)), 'mutex_replaced');
}
/** Execute a synchronous root state mutation under the permanent kernel lock; never retry or remove it. */
export function withVerifiedCutoverStateMutex(controlRoot, mutate) {
    requireValue(typeof mutate === 'function' && !types.isAsyncFunction(mutate), 'callback_must_be_sync');
    const original = authority(controlRoot); refuseLegacy(controlRoot);
    const file = path.join(controlRoot, 'first-cutover-state.flock');
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
        const identity = fs.fstatSync(fd);
        requireValue(identity.size === 0 && equalIdentity(identity, checkedFile(file, 0o600)), 'mutex_unsafe');
        fs.fsyncSync(fd);
        const directory = fs.openSync(controlRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try { requireValue(equalIdentity(original.control, fs.fstatSync(directory)), 'control_changed'); fs.fsyncSync(directory); }
        finally { fs.closeSync(directory); }
        verifyCurrent(controlRoot, original, file, fd, identity);
        const acquired = spawnSync(original.policy.flock.path, ['-x', '-w', '2', '-E', '75', '3'], {
            stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 65536,
            env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' },
        });
        requireValue(!acquired.error && !acquired.signal && [0, 75].includes(acquired.status), 'helper_failed');
        verifyCurrent(controlRoot, original, file, fd, identity);
        if (acquired.status === 75) throw new AcquisitionBusy();
        const result = mutate();
        requireValue(!result || typeof result.then !== 'function', 'callback_must_be_sync');
        return result;
    } finally { fs.closeSync(fd); }
}
