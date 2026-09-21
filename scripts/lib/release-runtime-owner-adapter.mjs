import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync,
    renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HEX64 = /^[a-f0-9]{64}$/;
const OPERATIONS = Object.freeze(['inspect', 'blockIngress', 'fenceAdmission', 'verifyZeroWork', 'freezeOldWriters',
    'verifyWritersFrozen', 'finalVacuumAndBackup', 'switchSupervisorToLauncher', 'verifyPrivateTarget', 'openIngress',
    'verifyPublicTarget', 'restoreDatabaseFromBackup', 'restoreOldSupervisor', 'resumeOldWriters', 'verifyOldHealth',
    'restoreIngress']);

function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

/** Sign one cutover receipt from a root/control-plane-only PKCS8 descriptor. */
export function signOwnerCutoverApproval(payload, privateKeyDescriptor) {
    const metadata = fstatSync(privateKeyDescriptor);
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o400 || metadata.size > 16_384) {
        throw new Error('owner_cutover_signing_key_unsafe');
    }
    const bytes = readFileSync(privateKeyDescriptor);
    try {
        const key = createPrivateKey(bytes); const signature = sign(null, Buffer.from(canonical(payload)), key).toString('base64url');
        return Object.freeze({ ...payload, signature });
    } finally { bytes.fill(0); }
}

/** Root adapter writes the signed receipt atomically for the root operator that consumes it. */
export function writeOwnerCutoverApproval(file, signedApproval) {
    if (typeof process.geteuid !== 'function' || process.geteuid() !== 0 || !path.isAbsolute(file)) {
        throw new Error('owner_cutover_receipt_authority_invalid');
    }
    const temporary = `${file}.partial-${process.pid}`; const fd = openSync(temporary, 'wx', 0o600);
    try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, `${JSON.stringify(signedApproval)}\n`); fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, file); const directoryFd = openSync(path.dirname(file), 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

function verifyDispatcher(file, expectedSha256) {
    if (!path.isAbsolute(file) || !HEX64.test(expectedSha256 || '')) throw new Error('host_dispatcher_identity_invalid');
    for (let ancestor = path.dirname(file); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
        const parent = lstatSync(ancestor);
        if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) {
            throw new Error('host_dispatcher_ancestor_unsafe');
        }
    }
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0
        || (metadata.mode & 0o111) === 0 || realpathSync(file) !== file) throw new Error('host_dispatcher_unsafe');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); const opened = fstatSync(fd); const bytes = readFileSync(fd);
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.mode !== metadata.mode
        || sha(bytes) !== expectedSha256) { closeSync(fd); throw new Error('host_dispatcher_digest_mismatch'); }
    return fd;
}

function dispatch(dispatcherPath, dispatcherSha256, operation, context) {
    return new Promise((resolve, reject) => {
        const dispatcherFd = verifyDispatcher(dispatcherPath, dispatcherSha256);
        const child = spawn('/proc/self/fd/3', [operation], { stdio: ['pipe', 'pipe', 'pipe', dispatcherFd], env: { PATH: '/usr/bin:/bin',
            HOME: '/nonexistent', LC_ALL: 'C' } });
        const stdout = []; const stderr = []; let bytes = 0;
        const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000); timeout.unref();
        const collect = (target) => (chunk) => { bytes += chunk.length; if (bytes > 65_536) child.kill('SIGKILL'); else target.push(chunk); };
        child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
        child.once('error', () => reject(new Error(`host_dispatch_${operation}_failed`)));
        child.once('close', (code) => {
            clearTimeout(timeout); closeSync(dispatcherFd);
            if (code !== 0 || bytes > 65_536) return reject(new Error(`host_dispatch_${operation}_failed`));
            try { resolve(JSON.parse(Buffer.concat(stdout).toString('utf8'))); }
            catch { reject(new Error(`host_dispatch_${operation}_result_invalid`)); }
        });
        child.stdin.end(`${JSON.stringify(context)}\n`);
    });
}

/**
 * Bind the generic state machine to one separately installed root-owned fixed
 * dispatcher. The dispatcher accepts only the operation token; no command,
 * path, URL, environment or PM2 argument is supplied by the service worker.
 */
export function createStaticHostOperations(options) {
    const dispatcher = realpathSync(options.dispatcher); const dispatcherFd = verifyDispatcher(dispatcher, options.dispatcherSha256);
    closeSync(dispatcherFd);
    return Object.freeze(Object.fromEntries(OPERATIONS.map((operation) => [operation,
        async (context = {}) => dispatch(dispatcher, options.dispatcherSha256, operation, context)])));
}
