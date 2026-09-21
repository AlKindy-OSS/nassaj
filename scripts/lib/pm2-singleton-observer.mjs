/** Read-only Linux evidence collector and callback-scoped lease for one existing PM2 supervisor. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const OBSERVATION_SCHEMA = 'nassaj-pm2-singleton-observation/v1';
const LEASE_SCHEMA = 'nassaj-pm2-singleton-lease/v1';
const ACTIVE_LEASES = new WeakSet();
const LEASE_CONTEXTS = new WeakMap();
const TITLE = /^PM2 v[^:()\0]{1,64}: God Daemon \((\/[^\0]*)\)$/;
const fail = code => { throw Error(`pm2_singleton_observer_${code}`); };
const check = (value, code) => { if (!value) fail(code); };
const mode = stat => stat.mode & 0o7777;
const identity = stat => ({ dev: stat.dev, ino: stat.ino });
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameProcess = (left, right) => ['pid', 'startTicks', 'uid', 'exe', 'bootId'].every(key => left[key] === right[key]);
const read = (file, encoding = 'utf8') => fs.readFileSync(file, encoding);

function exactSettings(value) {
    const keys = ['homePath', 'expectedExecutable', 'ownerUid', 'ownerGid', 'lockPath'];
    check(value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).sort().join() === keys.sort().join(), 'settings_invalid');
    for (const key of ['homePath', 'expectedExecutable', 'lockPath']) {
        check(typeof value[key] === 'string' && path.isAbsolute(value[key])
            && value[key] === path.normalize(value[key]), 'settings_invalid');
    }
    check(Number.isSafeInteger(value.ownerUid) && value.ownerUid >= 0
        && Number.isSafeInteger(value.ownerGid) && value.ownerGid >= 0, 'settings_invalid');
    check(path.dirname(value.lockPath) === value.homePath, 'lock_location_invalid');
    return value;
}

function statDirectory(settings) {
    const stat = fs.lstatSync(settings.homePath);
    check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === settings.ownerUid
        && stat.gid === settings.ownerGid && mode(stat) === 0o700
        && fs.realpathSync(settings.homePath) === settings.homePath, 'home_unsafe');
    return { path: settings.homePath, canonicalPath: settings.homePath, uid: stat.uid,
        gid: stat.gid, mode: mode(stat), dev: stat.dev, ino: stat.ino };
}

function parseStat(bytes) {
    const tail = bytes.slice(bytes.lastIndexOf(')') + 2).trim().split(/\s+/);
    check(tail.length > 19 && !['Z', 'X'].includes(tail[0]) && /^[1-9][0-9]*$/.test(tail[19]), 'process_invalid');
    return { state: tail[0], parentPid: Number(tail[1]), startTicks: tail[19] };
}

function uidFromStatus(bytes) {
    const match = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m.exec(bytes);
    check(match && new Set(match.slice(1)).size === 1, 'process_credentials_invalid');
    return Number(match[1]);
}

function processTitle(bytes) {
    const first = bytes.split('\0', 1)[0].trim();
    const match = TITLE.exec(first);
    return match ? { title: first, homePath: path.normalize(match[1]) } : null;
}

function inspectProcess(procRoot, pid, bootId) {
    const base = path.join(procRoot, String(pid));
    const before = parseStat(read(path.join(base, 'stat')));
    const title = processTitle(read(path.join(base, 'cmdline')));
    const uid = uidFromStatus(read(path.join(base, 'status')));
    const exe = fs.realpathSync(path.join(base, 'exe'));
    const netns = fs.readlinkSync(path.join(base, 'ns/net'));
    check(/^net:\[[1-9][0-9]*\]$/.test(netns), 'process_netns_invalid');
    const after = parseStat(read(path.join(base, 'stat')));
    check(before.startTicks === after.startTicks && before.parentPid === after.parentPid, 'process_changed');
    return { title, netns, identity: { pid, startTicks: before.startTicks, uid, exe, bootId } };
}

function scanProcesses(settings, procRoot, bootId) {
    let names;
    try { names = fs.readdirSync(procRoot); } catch { fail('process_scan_incomplete'); }
    const pids = names.filter(name => /^(?:[1-9][0-9]*)$/.test(name)).map(Number).sort((a, b) => a - b);
    const inspected = [];
    for (const pid of pids) {
        try { inspected.push(inspectProcess(procRoot, pid, bootId)); }
        catch (error) {
            if (['ENOENT', 'ESRCH'].includes(error?.code)) fail('process_churn');
            fail(error?.code === 'EACCES' ? 'process_unreadable' : 'process_scan_incomplete');
        }
    }
    const candidates = inspected.filter(entry => entry.title?.homePath === settings.homePath)
        .map(entry => ({ readable: true, homePath: entry.title.homePath, identity: entry.identity }));
    return { pids, inspected, candidates };
}

function stableProcesses(settings, deps, bootId) {
    const procRoot = deps.procRoot || '/proc';
    const first = scanProcesses(settings, procRoot, bootId);
    deps.betweenScans?.();
    const second = scanProcesses(settings, procRoot, bootId);
    check(first.pids.join() === second.pids.join(), 'process_churn');
    check(JSON.stringify(first.candidates) === JSON.stringify(second.candidates), 'process_changed');
    const relevantBefore = first.inspected.filter(entry => entry.title?.homePath === settings.homePath);
    const relevantAfter = second.inspected.filter(entry => entry.title?.homePath === settings.homePath);
    check(relevantBefore.length === relevantAfter.length && relevantBefore.every((entry, index) =>
        entry.netns === relevantAfter[index].netns), 'manager_netns_changed');
    return { ...second, procRoot, managerNetns: relevantAfter[0]?.netns };
}

function openPidfile(settings) {
    const file = path.join(settings.homePath, 'pm2.pid');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd); const bytes = fs.readFileSync(fd, 'utf8'); const after = fs.fstatSync(fd);
        const current = fs.lstatSync(file);
        check(before.isFile() && before.nlink === 1 && sameFile(identity(before), identity(after))
            && sameFile(identity(before), identity(current)) && !current.isSymbolicLink(), 'pidfile_changed');
        check(before.uid === settings.ownerUid && /^[1-9][0-9]*\n?$/.test(bytes) && bytes.length <= 32, 'pidfile_invalid');
        return { state: 'present', dev: before.dev, ino: before.ino, uid: before.uid,
            mode: mode(before), pid: Number(bytes.trim()), fdDev: after.dev, fdIno: after.ino };
    } finally { fs.closeSync(fd); }
}

function unixListeners(file, wanted) {
    const found = new Map([...wanted].map(value => [value, []]));
    for (const line of read(file).split('\n').slice(1)) {
        const columns = line.trim().split(/\s+/); const socketPath = columns[7];
        if (found.has(socketPath)) found.get(socketPath).push({ flags: columns[3], type: columns[4], state: columns[5], inode: columns[6] });
    }
    for (const [socketPath, rows] of found) {
        check(rows.length === 1, rows.length ? 'socket_path_duplicate' : 'socket_listener_missing');
        check(rows[0].flags === '00010000' && rows[0].type === '0001' && rows[0].state === '01'
            && /^[1-9][0-9]*$/.test(rows[0].inode), 'socket_listener_invalid');
    }
    return found;
}

function fdSocketInodes(procRoot, pid) {
    const directory = path.join(procRoot, String(pid), 'fd'); let names;
    try { names = fs.readdirSync(directory); } catch { fail('manager_fd_unreadable'); }
    const found = [];
    for (const name of names) {
        let target;
        try { target = fs.readlinkSync(path.join(directory, name)); }
        catch (error) { if (error.code === 'ENOENT') fail('manager_fd_changed'); fail('manager_fd_unreadable'); }
        const match = /^socket:\[([1-9][0-9]*)\]$/.exec(target); if (match) found.push(match[1]);
    }
    return found;
}

function socketArtifact(settings, socketPath, row, manager, netns, procRoot) {
    const stat = fs.lstatSync(socketPath);
    check(stat.isSocket() && !stat.isSymbolicLink() && stat.uid === settings.ownerUid, 'socket_file_invalid');
    const owned = fdSocketInodes(procRoot, manager.pid).filter(value => value === row.inode);
    check(owned.length === 1, owned.length ? 'socket_fd_duplicate' : 'socket_foreign_owner');
    const current = fs.lstatSync(socketPath);
    check(sameFile(identity(stat), identity(current)), 'socket_file_changed');
    return { state: 'present', dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: mode(stat),
        peer: manager, netns };
}

function observeOnce(settings, deps = {}) {
    exactSettings(settings); const home = statDirectory(settings);
    const procRoot = deps.procRoot || '/proc';
    const bootFile = deps.bootIdPath || path.join(procRoot, 'sys/kernel/random/boot_id');
    const bootId = read(bootFile).trim();
    check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId), 'boot_id_invalid');
    const scan = stableProcesses(settings, deps, bootId);
    check(scan.candidates.length === 1, scan.candidates.length ? 'multiple_managers' : 'manager_missing');
    const manager = scan.candidates[0].identity;
    check(manager.exe === settings.expectedExecutable && manager.uid === settings.ownerUid, 'manager_identity_invalid');
    const netns = fs.readlinkSync(path.join(procRoot, String(manager.pid), 'ns/net'));
    check(netns === scan.managerNetns, 'manager_netns_changed');
    const paths = ['rpc.sock', 'pub.sock'].map(name => path.join(settings.homePath, name));
    const rows = unixListeners(path.join(procRoot, String(manager.pid), 'net/unix'), paths);
    const artifacts = paths.map(value => socketArtifact(settings, value, rows.get(value)[0], manager, netns, scan.procRoot));
    return { schema: OBSERVATION_SCHEMA, home, bootId, scanComplete: true, candidates: scan.candidates,
        pidfile: openPidfile(settings), rpc: artifacts[0], pub: artifacts[1] };
}

/** Collect two complete identical observations; no socket connection or PM2 protocol is attempted. */
export function observeStableExistingPm2(settings, deps = {}) {
    const first = observeOnce(settings, deps); deps.betweenObservations?.(); const second = observeOnce(settings, deps);
    check(JSON.stringify(first) === JSON.stringify(second), 'observation_drift');
    return Object.freeze({ initial: first, rescan: second });
}

function safeLock(settings, create) {
    statDirectory(settings);
    const flags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (create ? fs.constants.O_CREAT : 0);
    const fd = fs.openSync(settings.lockPath, flags, 0o600);
    try {
        const stat = fs.fstatSync(fd); const current = fs.lstatSync(settings.lockPath);
        check(stat.isFile() && stat.nlink === 1 && stat.uid === settings.ownerUid && stat.gid === settings.ownerGid
            && mode(stat) === 0o600 && sameFile(identity(stat), identity(current)), 'lock_unsafe');
        return { fd, stat };
    } catch (error) { fs.closeSync(fd); throw error; }
}

function childIdentity(pid, procRoot = '/proc') {
    const bootId = read(path.join(procRoot, 'sys/kernel/random/boot_id')).trim();
    const inspected = inspectProcess(procRoot, pid, bootId).identity;
    return inspected;
}

function contender(settings) {
    const opened = safeLock(settings, false);
    try {
        return spawnSync('/usr/bin/flock', ['-x', '-n', '-E', '75', '-F', '/proc/self/fd/3', '/usr/bin/true'], {
            stdio: ['ignore', 'ignore', 'ignore', opened.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, timeout: 2000,
        }).status;
    } finally { fs.closeSync(opened.fd); }
}

async function waitLine(stream, timeoutMs) {
    let timer;
    try {
        return await Promise.race([once(stream, 'data').then(([bytes]) => bytes.toString('utf8').trim()),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error('lease_timeout')), timeoutMs); })]);
    } finally { clearTimeout(timer); }
}

function holderLockIdentity(pid, expected, procRoot = '/proc') {
    const base = path.join(procRoot, String(pid)); const matches = [];
    for (const name of fs.readdirSync(path.join(base, 'fdinfo'))) {
        let stat; let info;
        try { stat = fs.statSync(path.join(base, 'fd', name)); info = read(path.join(base, 'fdinfo', name)); }
        catch (error) { if (error.code === 'ENOENT') fail('holder_fd_changed'); throw error; }
        const locked = new RegExp(`^lock:\\s+\\d+: FLOCK\\s+ADVISORY\\s+WRITE\\s+${pid}\\s+\\S+:${expected.ino}\\s+0 EOF$`, 'm').test(info);
        if (locked && sameFile(identity(stat), identity(expected))) matches.push({ fd: Number(name), dev: stat.dev, ino: stat.ino });
    }
    check(matches.length === 1, matches.length ? 'holder_lock_duplicate' : 'holder_lock_unproven');
    return matches[0];
}

/** Prove that this exact in-memory lease is still callback-scoped and kernel-held. */
export function assertHeldPm2SingletonLease(heldLease) {
    const context = heldLease && typeof heldLease === 'object' ? LEASE_CONTEXTS.get(heldLease) : null;
    check(ACTIVE_LEASES.has(heldLease) && context
        && context.child.exitCode === null && context.child.signalCode === null, 'lease_capability_invalid');
    try {
        check(sameProcess(childIdentity(context.child.pid, context.procRoot), context.owner), 'holder_identity_changed');
        const current = holderLockIdentity(context.child.pid, context.opened.stat, context.procRoot);
        check(current.fd === context.holderLock.fd && sameFile(current, context.holderLock), 'holder_fd_changed');
        check(sameFile(identity(fs.lstatSync(context.settings.lockPath)), identity(context.opened.stat)), 'lock_replaced');
        check(contender(context.settings) === 75, 'lease_lost');
    } catch { fail('lease_capability_invalid'); }
    return true;
}

/** Hold the permanent kernel lease only for the callback, proving contention and release around it. */
export async function withPm2SingletonLease(settings, callback, deps = {}) {
    exactSettings(settings); check(typeof callback === 'function', 'callback_invalid');
    const readyDelay = deps.holderReadyDelayMs ?? 0;
    check(Number.isSafeInteger(readyDelay) && readyDelay >= 0 && readyDelay <= 5000, 'holder_delay_invalid');
    const originalHome = statDirectory(settings); const opened = safeLock(settings, true);
    const holderProgram = `setTimeout(()=>{process.stdout.write('ready\\n');process.stdin.resume()},${readyDelay})`;
    let child; let leaseError;
    try {
        child = spawn('/usr/bin/flock', ['-x', '-n', '-E', '75', '-F', '/proc/self/fd/3', '/usr/bin/node', '-e', holderProgram], {
            stdio: ['pipe', 'pipe', 'ignore', opened.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        });
        check(await waitLine(child.stdout, deps.timeoutMs || 2000) === 'ready', 'holder_handshake_invalid');
        const leaseProcRoot = deps.leaseProcRoot || '/proc';
        const owner = childIdentity(child.pid, leaseProcRoot);
        const holderLock = holderLockIdentity(child.pid, opened.stat, leaseProcRoot);
        check(contender(settings) === 75, 'lease_not_exclusive');
        const lease = Object.freeze({ schema: LEASE_SCHEMA, held: true, exclusive: true, verified: true,
            homeDev: statDirectory(settings).dev, homeIno: statDirectory(settings).ino, owner });
        ACTIVE_LEASES.add(lease);
        LEASE_CONTEXTS.set(lease, { child, procRoot: leaseProcRoot, owner, opened, holderLock, settings });
        let result;
        try { result = await callback(lease); }
        finally { ACTIVE_LEASES.delete(lease); LEASE_CONTEXTS.delete(lease); }
        check(child.exitCode === null, 'holder_died');
        let currentOwner;
        try { currentOwner = childIdentity(child.pid, leaseProcRoot); } catch { fail('holder_died'); }
        check(sameProcess(currentOwner, owner), 'holder_identity_changed');
        const currentHome = statDirectory(settings);
        check(sameFile(originalHome, currentHome) && originalHome.uid === currentHome.uid
            && originalHome.gid === currentHome.gid && originalHome.mode === currentHome.mode, 'home_changed');
        check(sameFile(identity(fs.lstatSync(settings.lockPath)), identity(opened.stat)), 'lock_replaced');
        const currentHolderLock = holderLockIdentity(child.pid, opened.stat, leaseProcRoot);
        check(holderLock.fd === currentHolderLock.fd && sameFile(holderLock, currentHolderLock), 'holder_fd_changed');
        check(contender(settings) === 75, 'lease_lost');
        return result;
    } catch (error) { leaseError = error; throw error; }
    finally {
        child?.stdin.end();
        if (child && child.exitCode === null && child.signalCode === null) await once(child, 'exit').catch(() => {});
        fs.closeSync(opened.fd);
        try { check(contender(settings) === 0, 'lease_not_released'); }
        catch (error) { if (!leaseError) throw error; }
    }
}
