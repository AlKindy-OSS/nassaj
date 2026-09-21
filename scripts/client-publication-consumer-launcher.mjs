#!/usr/bin/env node
/** Built-ins-only boot gate: verify the installed closure before executing any consumer module. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function pinned(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 ** 2) throw new Error('client_consumer_boot_file_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
        if (stat.ino !== before.ino || stat.dev !== before.dev || before.size !== after.size || before.ctimeMs !== after.ctimeMs) throw new Error('client_consumer_boot_file_changed');
        return bytes;
    } finally { fs.closeSync(fd); }
}

/** Validate exact installed files and their manifest binding without importing source/candidate code. */
export function verifyClientPublicationConsumerBundle(root, retained = false) {
    root = fs.realpathSync(root);
    const artifact = retained ? root : path.join(root, 'dist-server'), bundle = path.join(artifact, 'UPDATE_RUNTIME_BUNDLE');
    if (fs.realpathSync(artifact) !== artifact || fs.realpathSync(bundle) !== bundle) throw new Error('client_consumer_boot_root_unsafe');
    const control = JSON.parse(pinned(path.join(artifact, 'OID_CONTROL_MANIFEST.json')));
    const manifest = JSON.parse(pinned(path.join(artifact, 'UPDATE_RUNTIME_MANIFEST.json')));
    if (control.capabilities?.clientPublicationV1 !== 'nassaj-dev-client-publication/v1' || manifest.schemaVersion !== 2
        || manifest.buildIdMode !== 'path-mode-size-content-sha256' || manifest.buildId !== control.updateRuntimeBuildId
        || !/^[a-f0-9]{64}$/.test(manifest.buildId || '') || !Array.isArray(manifest.files) || manifest.files.length > 10000) throw new Error('client_consumer_boot_manifest_invalid');
    const pending = [''], records = [];
    while (pending.length) {
        const directory = pending.pop();
        for (const name of fs.readdirSync(path.join(bundle, directory)).sort()) {
            const relative = directory ? `${directory}/${name}` : name, file = path.join(bundle, relative), stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) throw new Error('client_consumer_boot_alias');
            if (stat.isDirectory()) { pending.push(relative); continue; }
            const bytes = pinned(file);
            records.push({ path: relative, mode: stat.mode & 0o777, size: bytes.length, sha256: sha(bytes) });
            if (records.length > manifest.files.length) throw new Error('client_consumer_boot_extra_file');
        }
    }
    records.sort((a, b) => a.path.localeCompare(b.path));
    const declared = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
    if (JSON.stringify(records) !== JSON.stringify(declared)) throw new Error('client_consumer_boot_closure_changed');
    const hash = createHash('sha256');
    for (const record of manifest.files) hash.update(record.path).update('\0').update(String(record.mode)).update('\0').update(String(record.size)).update('\0').update(record.sha256).update('\0');
    if (hash.digest('hex') !== manifest.buildId) throw new Error('client_consumer_boot_identity_changed');
    const entry = 'scripts/preview-oid-consumer.mjs';
    for (const required of [entry, 'scripts/lib/client-publication-executor.mjs', 'scripts/lib/client-publication-isolation.mjs', 'scripts/client-build-atomic.mjs']) {
        if (!manifest.entries.includes(required) || !records.some(record => record.path === required)) throw new Error('client_consumer_boot_required_module_missing');
    }
    return { root, entry: path.join(bundle, entry), buildId: manifest.buildId, manifest, records };
}

function stableDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error('client_consumer_retained_root_unsafe');
}

function durableFile(file, bytes, mode) {
    const fd = fs.openSync(file, 'wx', mode);
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Capture the validated closure at a write-once digest path, immune to later live-directory exchanges. */
export function retainClientPublicationConsumerBundle(root, hooks = {}) {
    const verified = verifyClientPublicationConsumerBundle(root), source = path.join(verified.root, 'dist-server');
    const parent = path.join(verified.root, '.nassaj-local-preview/client-consumer-runtimes');
    stableDirectory(parent);
    const destination = path.join(parent, verified.buildId);
    if (!fs.existsSync(destination)) {
        const staging = path.join(parent, `.${verified.buildId}-${randomUUID()}`);
        stableDirectory(staging);
        hooks.afterVerify?.();
        for (const record of verified.records) {
            const target = path.join(staging, 'UPDATE_RUNTIME_BUNDLE', record.path), bytes = pinned(path.join(source, 'UPDATE_RUNTIME_BUNDLE', record.path));
            if (sha(bytes) !== record.sha256 || bytes.length !== record.size) throw new Error('client_consumer_capture_changed');
            stableDirectory(path.dirname(target)); durableFile(target, bytes, record.mode);
        }
        for (const name of ['OID_CONTROL_MANIFEST.json', 'UPDATE_RUNTIME_MANIFEST.json', 'UPDATE_RUNTIME_CAPABILITY.json']) durableFile(path.join(staging, name), pinned(path.join(source, name)), 0o444);
        // Reuse the built-ins-only verifier through a temporary root layout without importing bytes.
        verifyRetainedClientPublicationConsumerBundle(staging, verified.buildId);
        const directories = [staging];
        for (let index = 0; index < directories.length; index++) for (const entry of fs.readdirSync(directories[index], { withFileTypes: true })) {
            if (entry.isDirectory()) directories.push(path.join(directories[index], entry.name));
        }
        for (const directory of directories.reverse()) {
            const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        fs.renameSync(staging, destination);
        const parentFd = fs.openSync(parent, 'r'); try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    }
    verifyRetainedClientPublicationConsumerBundle(destination, verified.buildId);
    return { root: verified.root, buildId: verified.buildId, runtimeRoot: destination,
        entry: path.join(destination, 'UPDATE_RUNTIME_BUNDLE/scripts/preview-oid-consumer.mjs') };
}

/** Validate a retained immutable snapshot using the same exact closure and original control binding. */
export function verifyRetainedClientPublicationConsumerBundle(runtimeRoot, expectedBuildId) {
    const verified = verifyClientPublicationConsumerBundle(runtimeRoot, true);
    if (verified.buildId !== expectedBuildId) throw new Error('client_consumer_retained_identity_mismatch');
    return verified;
}

/** Launch only the verified installed entry, forwarding shutdown to the owned child. */
export async function launchClientPublicationConsumer(root, args = []) {
    if (args.some(argument => argument === '--repo' || argument.startsWith('--repo='))) throw new Error('client_consumer_root_override_refused');
    const installed = retainClientPublicationConsumerBundle(root);
    const child = spawn(process.execPath, [installed.entry, '--repo', installed.root, ...args], { cwd: installed.root, stdio: 'inherit', env: process.env });
    const terminate = signal => child.kill(signal);
    const onTerm = () => terminate('SIGTERM'), onInt = () => terminate('SIGINT');
    process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
    try { return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); }
    finally { process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    launchClientPublicationConsumer(process.cwd(), process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`${error.message}\n`); process.exitCode = 1;
    });
}
