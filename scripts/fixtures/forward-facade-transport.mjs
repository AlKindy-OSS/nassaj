/** Composition-only TCP substitute; Unix inode/ss evidence is covered by pm2-readonly-observer.test.mjs. */
import fs from 'node:fs';
import { inspectForwardChildIdentity } from './scripts/lib/release-runtime-forward-child-protocol.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('./facade-map.json', import.meta.url)));
export function fixturePm2Dependencies(settings) {
    if (settings.socketPath !== fixture.pm2SocketLocator || settings.socketIdentity.port !== fixture.pm2Port) throw Error('fixture endpoint changed');
    const inspect = () => {
        const actual = inspectForwardChildIdentity(settings.daemon.pid);
        if (actual.startTicks !== settings.daemon.startTicks || actual.bootId !== settings.daemon.bootId
            || !actual.uids.every(uid => uid === settings.daemon.uid)) throw Error('fixture daemon identity changed');
        return { daemon: settings.daemon, socket: settings.socketIdentity };
    };
    return { kernelSnapshot: inspect, peerProof: async (_settings, socket) => {
        inspect();
        if (socket.destroyed || socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== fixture.pm2Port
            || socket.localAddress !== '127.0.0.1') throw Error('fixture endpoint peer changed');
    } };
}
