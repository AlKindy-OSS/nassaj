/** Composition-only TCP substitute; Unix inode/ss evidence is covered by pm2-readonly-observer.test.mjs. */
import fs from 'node:fs';
import { inspectForwardChildIdentity } from './scripts/lib/release-runtime-forward-child-protocol.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('./facade-map.json', import.meta.url)));
const loopback = port => `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
/**
 * Inode of the daemon-side half of this loopback connection, read from /proc/net/tcp.
 * A connection still in the accept queue reports inode 0, so wait (bounded) for the accept.
 */
async function serverSideInode(socket) {
    const local = loopback(fixture.pm2Port), remote = loopback(socket.localPort);
    for (const until = Date.now() + 2000; ; await new Promise(resolve => setTimeout(resolve, 10))) {
        const rows = fs.readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
            .filter(fields => fields[1] === local && fields[2] === remote);
        if (rows.length !== 1 || rows[0][3] !== '01') throw Error('fixture endpoint peer changed');
        if (rows[0][9] !== '0') return rows[0][9];
        if (Date.now() > until) throw Error('fixture endpoint not accepted');
    }
}
export function fixturePm2Dependencies(settings) {
    if (settings.socketPath !== fixture.pm2SocketLocator || settings.socketIdentity.port !== fixture.pm2Port) throw Error('fixture endpoint changed');
    const inspect = () => {
        const actual = inspectForwardChildIdentity(settings.daemon.pid);
        if (actual.startTicks !== settings.daemon.startTicks || actual.bootId !== settings.daemon.bootId
            || !actual.uids.every(uid => uid === settings.daemon.uid)) throw Error('fixture daemon identity changed');
        return { daemon: settings.daemon, socket: settings.socketIdentity };
    };
    const endpoint = socket => {
        if (socket.destroyed || socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== fixture.pm2Port
            || socket.localAddress !== '127.0.0.1') throw Error('fixture endpoint peer changed');
    };
    // SO_PEERCRED has no TCP equivalent: prove instead that the pinned daemon holds the peer socket.
    const peerCredentials = async (_settings, socket) => {
        endpoint(socket);
        const before = inspectForwardChildIdentity(settings.daemon.pid); inspect();
        const inode = await serverSideInode(socket);
        const owned = fs.readdirSync(`/proc/${settings.daemon.pid}/fd`).some(fd => {
            try { return fs.readlinkSync(`/proc/${settings.daemon.pid}/fd/${fd}`) === `socket:[${inode}]`; } catch { return false; }
        });
        if (!owned) throw Error('fixture peer credentials mismatch');
        const after = inspectForwardChildIdentity(settings.daemon.pid);
        if (JSON.stringify(after) !== JSON.stringify(before)) throw Error('fixture daemon identity changed');
        endpoint(socket);
        return Object.freeze({ pid: settings.daemon.pid, uid: after.uids[0], gid: after.gids[0], inode: Number(inode) });
    };
    return { kernelSnapshot: inspect, peerCredentials, peerProof: async (_settings, socket) => { inspect(); endpoint(socket); } };
}
