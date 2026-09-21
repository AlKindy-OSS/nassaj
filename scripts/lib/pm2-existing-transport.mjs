/** Existing-socket transport shared by the root adapter and sealed service-owner capsule; Node built-ins only. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { inspectForwardChildIdentity, canonicalForwardValue } from './release-runtime-forward-child-protocol.mjs';
const CAP = 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const hash = value => createHash('sha256').update(value).digest('hex');
function unknown(reason) { return Error(`pm2_observation_unknown:${reason}`); }
function check(ok, reason) { if (!ok) throw unknown(reason); }
function remaining(deadline) { const value = Math.floor(deadline - performance.now()); check(value > 0, 'deadline'); return value; }
export function pinPm2RuntimeFile(file, expected, ownerUid, deadline, cap = CAP, allowEmpty = false) {
    remaining(deadline); check(path.isAbsolute(file) && fs.realpathSync(file) === file, 'pin_path');
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
        const stat = fs.lstatSync(parent); check(stat.isDirectory() && !stat.isSymbolicLink()
            && [0, ownerUid].includes(stat.uid) && !(stat.mode & 0o022), 'pin_ancestor');
        if (parent === path.dirname(parent)) break;
    }
    const before = fs.lstatSync(file); check(before.isFile() && before.uid === ownerUid && !(before.mode & 0o022)
        && (before.size > 0 || allowEmpty) && before.size <= cap && HEX.test(expected || ''), 'pin_metadata');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd); check(['dev', 'ino', 'mode', 'uid', 'size'].every(key => before[key] === opened[key]), 'pin_race');
        const bytes = fs.readFileSync(fd); check(hash(bytes) === expected, 'pin_digest'); remaining(deadline); return bytes;
    } finally { fs.closeSync(fd); }
}
/** Validate exactly one AMP v1/two-argument frame before invoking the official decoder. */
export function validatedPm2FrameLength(bytes) {
    check(Buffer.isBuffer(bytes) && bytes.length <= CAP, 'frame_limit');
    if (!bytes.length) return null;
    check(bytes[0] === 0x12, 'frame_header'); let offset = 1;
    for (let argument = 0; argument < 2; argument++) {
        if (bytes.length < offset + 4) return null;
        const length = bytes.readUInt32BE(offset); offset += 4;
        check(length > 0 && length <= CAP - offset, 'frame_length'); offset += length;
        if (bytes.length < offset) return null;
    }
    check(bytes.length === offset, 'extra_frame'); return offset;
}
function socketInode(pid, fd) {
    const value = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[([0-9]+)\]$/);
    check(value, 'socket_fd'); return value[1];
}
function processSockets(pid) {
    return fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
        try { const value = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[([0-9]+)\]$/); return value ? [value[1]] : []; }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    });
}
function kernelSnapshot(settings, deadline) {
    remaining(deadline); const expected = settings.daemon; const identity = settings.socketIdentity;
    const daemon = inspectForwardChildIdentity(expected.pid);
    check(daemon.startTicks === expected.startTicks && daemon.bootId === expected.bootId && daemon.uids.every(uid => uid === expected.uid), 'daemon_identity');
    check(hash(fs.readFileSync(`/proc/${daemon.pid}/exe`)) === expected.exeSha256, 'daemon_executable');
    const info = fs.lstatSync(settings.socketPath, { bigint: true });
    check(info.isSocket() && !info.isSymbolicLink() && fs.realpathSync(settings.socketPath) === settings.socketPath
        && String(info.dev) === identity.device && String(info.ino) === identity.inode && Number(info.uid) === identity.uid, 'socket_identity');
    const namespace = fs.readlinkSync(`/proc/${daemon.pid}/ns/net`);
    check(namespace === identity.networkNamespace && fs.readlinkSync('/proc/self/ns/net') === namespace, 'socket_namespace');
    const listeners = fs.readFileSync(`/proc/${daemon.pid}/net/unix`, 'utf8').split('\n').slice(1).map(line => line.trim().split(/\s+/))
        .filter(parts => parts.length === 8 && parts[7] === settings.socketPath && parts[3] === '00010000' && parts[4] === '0001');
    check(listeners.length === 1 && listeners[0][6] === identity.listenerInode && processSockets(daemon.pid).includes(identity.listenerInode), 'listener_owner');
    const again = inspectForwardChildIdentity(expected.pid);
    check(again.startTicks === daemon.startTicks && again.bootId === daemon.bootId && again.uids.every(uid => uid === expected.uid), 'daemon_changed');
    remaining(deadline); return { daemon: expected, socket: identity };
}
/** Correlate both connected inode directions; ambiguous or incomplete ss output is never ownership proof. */
export function verifyPm2ConnectedPeer(output, clientInode, daemonSockets) {
    check(typeof output === 'string' && Buffer.byteLength(output) <= CAP && DECIMAL.test(clientInode), 'peer_output');
    const rows = output.split('\n').flatMap(line => {
        const match = line.match(/^u_str\s+ESTAB\s+\d+\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)(?:\s+.*)?$/);
        return match ? [{ local: match[1], peer: match[2] }] : [];
    });
    const local = rows.filter(row => row.local === clientInode);
    check(local.length === 1 && local[0].peer !== '0' && daemonSockets.includes(local[0].peer), 'peer_unproven');
    const peer = rows.filter(row => row.local === local[0].peer);
    check(peer.length === 1 && peer[0].peer === clientInode, 'peer_ambiguous');
    return local[0].peer;
}
const PYTHON_PATH = '/usr/bin/python3.13';
const PYTHON_STDLIB = '/usr/lib/python3.13';
const PYTHON_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
const PYTHON_IMPORTS = 'import json,socket,struct,os,sys\n';
const PYTHON_MAPS = 'sorted({line.split(maxsplit=5)[5].strip() for line in open("/proc/self/maps") if len(line.split(maxsplit=5))==6 and line.split(maxsplit=5)[5].startswith("/")})';
// Fixed source is part of this module's reviewed closure; no caller-provided Python is accepted.
const PEER_CREDENTIAL_PROBE = PYTHON_IMPORTS + `s=socket.socket(fileno=3)
try:
 if s.family != socket.AF_UNIX or s.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE) != socket.SOCK_STREAM: raise ValueError("socket_type")
 pid,uid,gid=struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
 print(json.dumps({"pid":pid,"uid":uid,"gid":gid,"inode":os.readlink("/proc/self/fd/3"),"maps":${PYTHON_MAPS},"searchPath":sys.path}))
finally:
 s.close()
`;
function rootRuntimeFile(file, deadline) {
    remaining(deadline);
    const real = fs.realpathSync(file), before = fs.lstatSync(real);
    check(before.isFile() && before.uid === 0 && !(before.mode & 0o022) && before.size <= 128 * CAP, 'python_runtime_file');
    const bytes = fs.readFileSync(real);
    const sha256 = hash(bytes);
    pinPm2RuntimeFile(real, sha256, 0, deadline, 128 * CAP, true);
    return { path: file, realpath: real, sha256 };
}
function pythonStandardLibraryDigest(deadline) {
    const entries = [];
    function visit(directory) {
        remaining(deadline);
        const st = fs.lstatSync(directory);
        check(st.isDirectory() && st.uid === 0 && !(st.mode & 0o022), 'python_runtime_directory');
        for (const name of fs.readdirSync(directory).sort()) {
            const file = path.join(directory, name), stat = fs.lstatSync(file);
            check(stat.uid === 0 && (stat.isSymbolicLink() || !(stat.mode & 0o022)), 'python_runtime_metadata');
            if (stat.isDirectory()) { entries.push({ path: file, type: 'directory' }); visit(file); }
            else if (stat.isSymbolicLink()) entries.push({ path: file, type: 'link', target: fs.readlinkSync(file),
                resolved: fs.existsSync(file) ? rootRuntimeFile(file, deadline) : null });
            else entries.push(rootRuntimeFile(file, deadline));
        }
    }
    visit(PYTHON_STDLIB);
    return hash(canonicalForwardValue(entries));
}
function pythonRuntimeInventory(maps, searchPath, deadline) {
    check(canonicalForwardValue(searchPath) === canonicalForwardValue(['/usr/lib/python313.zip', PYTHON_STDLIB,
        path.join(PYTHON_STDLIB, 'lib-dynload')]), 'python_search_path');
    check(Array.isArray(maps) && maps.length > 1 && maps.length <= 64 && maps.includes(PYTHON_PATH)
        && maps.some(file => /\/ld-linux[^/]*\.so(?:\.[0-9]+)*$/.test(file)), 'python_runtime_maps');
    for (const file of ['/usr/lib/python313.zip', '/etc/ld.so.preload']) {
        try { fs.lstatSync(file); throw unknown('python_runtime_unexpected_search'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const files = [...new Set([...maps, '/etc/ld.so.cache'])].sort().map(file => {
        check(typeof file === 'string' && path.isAbsolute(file) && !file.includes('..'), 'python_runtime_path');
        return rootRuntimeFile(file, deadline);
    });
    return { schema: 'nassaj-pm2-python-runtime/v1', maps, searchPath, files,
        stdlibSha256: pythonStandardLibraryDigest(deadline), probeSha256: hash(PEER_CREDENTIAL_PROBE) };
}
/** Prepare a read-only root-owned Python runtime inventory; this does not contact PM2. */
export function capturePm2PeerCredentialReader() {
    const deadline = performance.now() + 5000;
    const interpreter = rootRuntimeFile(PYTHON_PATH, deadline);
    const source = PYTHON_IMPORTS + `print(json.dumps({"maps":${PYTHON_MAPS},"searchPath":sys.path}))`;
    const value = JSON.parse(execFileSync(PYTHON_PATH, ['-I', '-S', '-B', '-c', source], {
        env: PYTHON_ENV, encoding: 'utf8', timeout: remaining(deadline), maxBuffer: 4096,
    }));
    return { path: PYTHON_PATH, sha256: interpreter.sha256,
        runtime: pythonRuntimeInventory(value.maps, value.searchPath, deadline) };
}
function verifyPythonRuntime(reader, deadline) {
    check(reader?.path === PYTHON_PATH && reader.runtime?.schema === 'nassaj-pm2-python-runtime/v1', 'peer_credentials_reader');
    pinPm2RuntimeFile(reader.path, reader.sha256, 0, deadline, 32 * CAP);
    const current = pythonRuntimeInventory(reader.runtime.maps, reader.runtime.searchPath, deadline);
    check(canonicalForwardValue(current) === canonicalForwardValue(reader.runtime), 'python_runtime_changed');
}
function credentialProbe(reader, fd, deadline) {
    return new Promise((resolve, reject) => {
        const timeout = remaining(deadline);
        const child = spawn(reader.path, ['-I', '-S', '-B', '-c', PEER_CREDENTIAL_PROBE], {
            stdio: ['ignore', 'pipe', 'ignore', fd], env: PYTHON_ENV,
        });
        let output = Buffer.alloc(0), failure = null;
        const fail = reason => { failure ||= unknown(reason); child.kill('SIGKILL'); };
        const timer = setTimeout(() => fail('peer_credentials_deadline'), timeout);
        child.once('error', () => { failure ||= unknown('peer_credentials_unavailable'); });
        child.stdout.on('data', bytes => {
            if (failure) return;
            if (output.length + bytes.length > 1024) return fail('peer_credentials_output');
            output = Buffer.concat([output, bytes]);
        });
        child.once('close', code => {
            clearTimeout(timer);
            if (failure || code !== 0) return reject(failure || unknown('peer_credentials_failed'));
            try { resolve(JSON.parse(output.toString('utf8'))); } catch { reject(unknown('peer_credentials_output')); }
        });
    });
}
/** Verify SO_PEERCRED on the same inherited RPC FD, without opening a second connection. */
export async function verifyPinnedPm2PeerCredentials(settings, socket, deadline) {
    const reader = settings.peerCredentialReader;
    verifyPythonRuntime(reader, deadline);
    const fd = socket._handle?.fd;
    check(Number.isInteger(fd) && fd >= 0 && !socket.destroyed, 'connection_closed');
    const inode = socketInode(process.pid, fd);
    const before = inspectForwardChildIdentity(settings.daemon.pid);
    check(before.startTicks === settings.daemon.startTicks && before.bootId === settings.daemon.bootId
        && before.uids.every(uid => uid === settings.daemon.uid), 'peer_credentials_identity');
    const value = await credentialProbe(reader, fd, deadline);
    check(!socket.destroyed && socket._handle?.fd === fd && socketInode(process.pid, fd) === inode, 'connection_changed');
    check(value.pid === settings.daemon.pid && value.uid === settings.daemon.uid
        && before.gids.every(gid => gid === value.gid) && value.inode === `socket:[${inode}]`, 'peer_credentials_mismatch');
    const after = inspectForwardChildIdentity(settings.daemon.pid);
    check(canonicalForwardValue(after) === canonicalForwardValue(before), 'peer_credentials_changed');
    check(canonicalForwardValue(value.maps) === canonicalForwardValue(reader.runtime.maps)
        && canonicalForwardValue(value.searchPath) === canonicalForwardValue(reader.runtime.searchPath), 'python_runtime_changed');
    verifyPythonRuntime(reader, deadline);
    remaining(deadline);
    return Object.freeze({ pid: value.pid, uid: value.uid, gid: value.gid, inode });
}
async function peerProof(settings, socket, deadline) {
    const binary = settings.ss; check(binary?.path === '/usr/bin/ss', 'peer_reader');
    pinPm2RuntimeFile(binary.path, binary.sha256, 0, deadline, 16 * CAP);
    const fd = socket._handle?.fd; check(Number.isInteger(fd) && fd >= 0 && !socket.destroyed, 'connection_closed');
    const inode = socketInode(process.pid, fd);
    const output = await new Promise((resolve, reject) => execFile(binary.path, ['-xnpH'], {
        encoding: 'utf8', timeout: remaining(deadline), maxBuffer: CAP, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' },
    }, (error, stdout) => error ? reject(unknown('peer_reader_failed')) : resolve(stdout)));
    check(!socket.destroyed && socketInode(process.pid, fd) === inode, 'connection_changed');
    verifyPm2ConnectedPeer(output, inode, processSockets(settings.daemon.pid)); remaining(deadline);
}
function boundedText(value, key, max = 4096) { check(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value), key); return value; }
function projection(entries) {
    check(Array.isArray(entries), 'reply_array'); const identifiers = new Set();
    return entries.map(entry => {
        const env = entry?.pm2_env; check(env && Number.isSafeInteger(entry.pm_id) && entry.pm_id >= 0 && !identifiers.has(entry.pm_id)
            && Number.isSafeInteger(entry.pid) && entry.pid >= 0 && typeof env.autorestart === 'boolean' && typeof env.watch === 'boolean', 'entry_invalid');
        identifiers.add(entry.pm_id);
        const value = { pmId: entry.pm_id, name: boundedText(entry.name ?? env.name, 'entry_name', 256),
            namespace: boundedText(env.namespace, 'entry_namespace', 256), pid: entry.pid, status: boundedText(env.status, 'entry_status', 64),
            execPath: boundedText(env.pm_exec_path, 'entry_path'), cwd: boundedText(env.pm_cwd, 'entry_cwd'),
            interpreter: boundedText(env.exec_interpreter, 'entry_interpreter'), execMode: boundedText(env.exec_mode, 'entry_mode', 64),
            autorestart: env.autorestart, watch: env.watch };
        return Object.freeze({ ...value, entrySha256: hash(canonicalForwardValue(value)) });
    }).sort((a, b) => a.pmId - b.pmId);
}
/** One bounded getMonitorData request. Fixture seams replace kernel evidence only, never codec/wire parsing. */
export async function runExistingPm2Observation(settings, deps = {}, mutation = null) {
    const deadline = deps.deadline ?? performance.now() + 5000; let socket; let timer;
    try {
        check(path.isAbsolute(settings.socketPath || '') && settings.socketPath.length < 104 && !/\s/.test(settings.socketPath), 'socket_path');
        const Message = deps.Message; check(typeof Message === 'function', 'codec_missing');
        const inspect = deps.kernelSnapshot || kernelSnapshot; const peer = deps.peerProof || peerProof;
        const credentials = deps.peerCredentials || verifyPinnedPm2PeerCredentials;
        const before = inspect(settings, deadline); const requestId = randomBytes(16).toString('hex');
        return await new Promise((resolve, reject) => {
            let bytes = Buffer.alloc(0); let processing = false; let failed = false;
            const fail = error => { failed = true; socket?.destroy(); reject(error); };
            timer = setTimeout(() => fail(unknown('deadline')), remaining(deadline));
            socket = net.createConnection({ path: settings.socketPath });
            socket.on('error', () => fail(unknown('connection_error')));
            socket.on('end', () => fail(unknown('connection_closed')));
            socket.on('connect', async () => {
                try {
                    await credentials(settings, socket, deadline);
                    check(!failed && !socket.destroyed, 'connection_closed');
                    check(canonicalForwardValue(inspect(settings, deadline)) === canonicalForwardValue(before), 'kernel_changed');
                    remaining(deadline);
                    socket.write(new Message([{ type: 'call', method: 'getMonitorData', args: [{}] }, requestId]).toBuffer());
                } catch (error) { fail(error); }
            });
            socket.on('data', async chunk => {
                try {
                    check(bytes.length + chunk.length <= CAP, 'frame_limit'); bytes = Buffer.concat([bytes, chunk]);
                    if (validatedPm2FrameLength(bytes) === null || processing) return; processing = true;
                    const decoded = new Message(bytes).args;
                    check(Array.isArray(decoded) && decoded.length === 2 && decoded[1] === requestId, 'reply_id');
                    check(decoded[0] && Object.keys(decoded[0]).join(',') === 'args' && Array.isArray(decoded[0].args)
                        && decoded[0].args.length === 1, 'rpc_error');
                    const entries = projection(decoded[0].args[0]);
                    await credentials(settings, socket, deadline);
                    await peer(settings, socket, deadline, deps.ownerUid ?? 0);
                    check(canonicalForwardValue(inspect(settings, deadline)) === canonicalForwardValue(before), 'kernel_changed');
                    await new Promise(resolve => setImmediate(resolve));
                    check(!failed && !socket.destroyed, 'connection_closed'); remaining(deadline); validatedPm2FrameLength(bytes);
                    const observed = Object.freeze({ state: 'observed', ...before, entries: Object.freeze(entries),
                        observationSha256: hash(canonicalForwardValue({ ...before, entries })) });
                    if (!mutation) return resolve(observed);
                    socket.removeAllListeners('data');
                    const unexpectedData = () => fail(unknown('unexpected_frame'));
                    socket.on('data', unexpectedData);
                    const result = await mutation({ unexpectedData, raw: decoded[0].args[0], observed, socket, Message, deadline, inspect, peer: async (...args) => {
                        await credentials(args[0], args[1], args[2]); return peer(...args);
                    } });
                    check(!failed, 'connection_closed'); resolve(result);
                } catch (error) { fail(error); }
            });
        });
    } catch (error) {
        if (/^pm2_observation_unknown:[a-z_]+$/.test(error?.message || '')) throw error;
        throw unknown('unavailable');
    } finally { clearTimeout(timer); socket?.destroy(); }
}


/** Send one internally derived typed frame on the observed connection; no reconnect or retry. */
export function sendPinnedPm2TypedFrame(socket, Message, plan, deadline) {
    return new Promise((resolve, reject) => {
        let bytes = Buffer.alloc(0); let done = false;
        const finish = (error, value) => {
            if (done) return; done = true; clearTimeout(timer);
            socket.off('data', read); socket.off('error', failed); socket.off('end', failed);
            error ? reject(error) : resolve(value);
        };
        const failed = () => finish(unknown('mutation_effect_unknown'));
        const timer = setTimeout(failed, remaining(deadline));
        const read = chunk => {
            try {
                check(bytes.length + chunk.length <= CAP, 'frame_limit'); bytes = Buffer.concat([bytes, chunk]);
                if (validatedPm2FrameLength(bytes) === null) return;
                const decoded = new Message(bytes).args;
                check(Array.isArray(decoded) && decoded.length === 2 && decoded[1] === plan.intent.requestId, 'reply_id');
                check(decoded[0] && Object.keys(decoded[0]).join(',') === 'args' && Array.isArray(decoded[0].args)
                    && decoded[0].args.length === 1, 'rpc_error');
                const result = decoded[0].args[0]; check(result && typeof result === 'object' && !result.error, 'mutation_result');
                setImmediate(() => { try { validatedPm2FrameLength(bytes); finish(null, result); } catch { failed(); } });
            } catch { failed(); }
        };
        socket.on('data', read); socket.once('error', failed); socket.once('end', failed);
        try { socket.write(new Message([{ type: 'call', method: plan.method, args: [plan.payload] }, plan.intent.requestId]).toBuffer()); }
        catch { failed(); }
    });
}
