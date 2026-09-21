/** Scoped routing observations and the root-owned, loopback-only maintenance boundary. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const LISTENER_BOUNDARY_MODE = 'local-origin-listener/v1';
const fail = reason => { throw Error(`host_ingress_${reason}`); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);

/** Validate the explicit manager, binding a user-manager name to its actual account UID. */
export function ingressManager(manager, read = file => fs.readFileSync(file, 'utf8')) {
    if (!manager || Object.keys(manager).sort().join(',') !== 'managerUid,scope,unit,user'
        || !/^[A-Za-z0-9_.@-]+\.service$/.test(manager.unit || '')) fail('manager_contract');
    if (manager.scope === 'system' && manager.user === null && manager.managerUid === 0) return manager;
    if (manager.scope !== 'user' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(manager.user || '')
        || !Number.isSafeInteger(manager.managerUid) || manager.managerUid <= 0) fail('manager_contract');
    const rows = read('/etc/passwd').split('\n').map(row => row.split(':')).filter(row => row[0] === manager.user);
    if (rows.length !== 1 || Number(rows[0][2]) !== manager.managerUid) fail('manager_account_mismatch');
    return manager;
}

/** Produce fixed systemctl show argv; absence of a user manager never falls back to system. */
export function ingressShowArgs(manager, properties) {
    return [...(manager.scope === 'user' ? ['--user', `--machine=${manager.user}@.host`] : []),
        'show', manager.unit, ...properties.map(name => `--property=${name}`), '--value'];
}

/** Observe bounded mutable routing data, never executable/root-authority material. */
export function readRoutingEvidence(file, uid) {
    if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || !Number.isSafeInteger(uid) || uid < 0) fail('routing_path');
    const parents = [];
    for (let parent = path.dirname(file);; parent = path.dirname(parent)) {
        const info = fs.lstatSync(parent);
        if (!info.isDirectory() || info.isSymbolicLink() || ![0, uid].includes(info.uid)
            || (info.uid === 0 ? info.mode & 0o022 : info.mode & 0o1000)) fail('routing_ancestor');
        parents.push([parent, info]); if (parent === path.dirname(parent)) break;
    }
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || ![0, uid].includes(before.uid)
        || before.mode & 0o022 || before.size < 1 || before.size > 262144) fail('routing_file');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        if (!same(before, fs.fstatSync(fd))) fail('routing_changed');
        const bytes = Buffer.alloc(before.size + 1); let size = 0, count;
        while ((count = fs.readSync(fd, bytes, size, bytes.length - size, null)) > 0) { size += count; if (size > before.size) fail('routing_changed'); }
        if (size !== before.size || !same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(file))
            || fs.realpathSync(file) !== file || parents.some(([parent, info]) => !same(info, fs.lstatSync(parent)))) fail('routing_changed');
        const data = bytes.subarray(0, size);
        return { path: file, sha256: sha(data), size, text: data.toString('utf8') };
    } finally { fs.closeSync(fd); }
}

/** Validate the bounded listener contract without deriving coverage from routing YAML or UID. */
export function listenerBoundary(config) {
    const value = config.maintenance?.boundary;
    if (value === undefined) return null;
    if (!value || Object.keys(value).sort().join(',') !== 'mode,originHost,originPort'
        || value.mode !== LISTENER_BOUNDARY_MODE || value.originHost !== '127.0.0.1'
        || !Number.isSafeInteger(value.originPort) || value.originPort < 1024 || value.originPort > 65535
        || value.originPort === config.maintenance.responderPort) fail('listener_contract');
    const endpoint = new URL(config.health.privateUrl);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== value.originHost || Number(endpoint.port) !== value.originPort
        || config.maintenance.cloudflared.originHost !== value.originHost || config.maintenance.cloudflared.originPort !== value.originPort)
        fail('listener_endpoint_mismatch');
    const target = config.forwardActivation?.supervisorPlan?.mutation?.targetDescriptor;
    if (target && (target.env?.HOST !== value.originHost || String(target.env?.PORT) !== String(value.originPort))) fail('listener_target_policy');
    return value;
}

function socketRows(read, port) {
    const suffix = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
    return ['tcp', 'tcp6'].flatMap(family => read(`/proc/self/net/${family}`).trim().split('\n').slice(1)
        .map(row => row.trim().split(/\s+/)).filter(row => row[3] === '0A' && row[1].endsWith(suffix))
        .map(row => ({ family, address: row[1].split(':')[0], inode: row[9], uid: Number(row[7]) })));
}

/** Bind exactly one IPv4 loopback socket to the reviewed process; reject every sibling on the port. */
export function observeOriginListener(config, claim, deps = {}) {
    const boundary = listenerBoundary(config); if (!boundary) return null;
    if (!Number.isSafeInteger(claim?.pid) || claim.pid <= 0 || !Number.isSafeInteger(claim.uid)
        || !/^[0-9]+$/.test(claim.startTicks || '')) fail('listener_process_contract');
    const read = deps.read || (file => fs.readFileSync(file, 'utf8'));
    const link = deps.readlink || fs.readlinkSync, directory = deps.readdir || fs.readdirSync;
    const stat = read(`/proc/${claim.pid}/stat`);
    const ticks = value => value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(read(`/proc/${claim.pid}/status`))?.slice(1).map(Number);
    if ((claim.bootId && read('/proc/sys/kernel/random/boot_id').trim() !== claim.bootId)
        || ticks(stat) !== claim.startTicks || uids?.length !== 4 || uids.some(uid => uid !== claim.uid)
        || link(`/proc/${claim.pid}/ns/net`) !== link('/proc/self/ns/net')) fail('listener_process_mismatch');
    const rows = socketRows(read, boundary.originPort);
    if (rows.length !== 1 || rows[0].family !== 'tcp' || rows[0].address !== '0100007F'
        || rows[0].uid !== claim.uid || !/^[1-9][0-9]*$/.test(rows[0].inode)) fail('listener_topology');
    const sockets = directory(`/proc/${claim.pid}/fd`).map(fd => {
        try { return link(`/proc/${claim.pid}/fd/${fd}`); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    });
    if (!sockets.includes(`socket:[${rows[0].inode}]`)) fail('listener_owner');
    if (ticks(read(`/proc/${claim.pid}/stat`)) !== claim.startTicks
        || link(`/proc/${claim.pid}/ns/net`) !== link('/proc/self/ns/net') || JSON.stringify(socketRows(read, boundary.originPort)) !== JSON.stringify(rows)) fail('listener_changed');
    return { ...rows[0], pid: claim.pid, startTicks: claim.startTicks, originPort: boundary.originPort };
}

/** Build only the dedicated Nassaj table: any non-root connector is fenced, root private probes remain possible. */
export function buildListenerFenceRules(config) {
    const boundary = listenerBoundary(config); if (!boundary) fail('listener_contract');
    const port = boundary.originPort, responder = config.maintenance.responderPort;
    if (responder !== 3311) fail('listener_responder');
    return 'destroy table inet nassaj_cutover\nadd table inet nassaj_cutover\n'
        + 'add chain inet nassaj_cutover cut_established { type filter hook output priority filter; policy accept; }\n'
        + `add rule inet nassaj_cutover cut_established meta skuid != 0 fib daddr type local meta nfproto ipv4 tcp dport ${port} ct state established reject with tcp reset\n`
        + `add rule inet nassaj_cutover cut_established meta skuid != 0 fib daddr type local meta nfproto ipv6 tcp dport ${port} reject with tcp reset\n`
        + 'add chain inet nassaj_cutover input { type filter hook input priority filter; policy accept; }\n'
        + `add rule inet nassaj_cutover input iifname != "lo" tcp dport ${port} reject with tcp reset\n`
        + 'add chain inet nassaj_cutover output { type nat hook output priority dstnat; policy accept; }\n'
        + `add rule inet nassaj_cutover output meta skuid != 0 fib daddr type local meta nfproto ipv4 tcp dport ${port} redirect to :${responder}\n`;
}
