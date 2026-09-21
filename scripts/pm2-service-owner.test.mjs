import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';
import test from 'node:test';
import Message from './vendor/pm2-codec/amp-message/index.js';
import { capturePm2PeerCredentialReader, validatedPm2FrameLength } from './lib/pm2-existing-transport.mjs';
import { inspectForwardChildIdentity, canonicalForwardValue as canonical } from './lib/release-runtime-forward-child-protocol.mjs';
import { verifyOidCapsuleModuleClosure } from './server-build-atomic.mjs';
import { makeShortSocketDir } from './lib/short-socket-dir.mjs';
const sha = value => createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : canonical(value)).digest('hex');
const bundle = buildSync({ entryPoints: ['scripts/lib/pm2-service-owner.mjs'], bundle: true, write: false,
    format: 'esm', platform: 'node', packages: 'external', alias: { amp: path.resolve('scripts/vendor/pm2-codec/amp/index.js'),
        util: path.resolve('scripts/lib/pm2-codec-builtins.mjs'), stream: path.resolve('scripts/lib/pm2-codec-builtins.mjs') } }).outputFiles[0].contents;
verifyOidCapsuleModuleClosure(Buffer.from(bundle));
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`);
const reader = capturePm2PeerCredentialReader();
async function fixture(t, loseReply = false) {
    const directory = makeShortSocketDir('service-pm2-', 'rpc.sock');
    const socketPath = path.join(directory, 'rpc.sock'), peers = new Set(), mutations = [], requests = [];
    const app = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await once(app, 'spawn');
    const previous = inspectForwardChildIdentity(app.pid), daemon = inspectForwardChildIdentity(process.pid);
    const env = { PATH: '/usr/bin:/bin', PRIVATE_TOKEN: 'never-log-this',
        NASSAJ_PREVIEW_TRANSACTION_NONCE: 'a'.repeat(64), NASSAJ_PREVIEW_BOOT_NONCE: 'b'.repeat(64) };
    const slot = { name: 'fixture', pm_id: 3, pid: app.pid, pm2_env: { name: 'fixture', namespace: 'fixture',
        status: 'online', pm_exec_path: '/fixture/index.js', pm_cwd: '/fixture', exec_interpreter: '/usr/bin/node',
        exec_mode: 'fork_mode', args: [], autorestart: true, watch: false, kill_timeout: '86400000', treekill: false, ...env, env } };
    const server = net.createServer(socket => {
        peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {});
        let bytes = Buffer.alloc(0);
        socket.on('data', async chunk => {
            bytes = Buffer.concat([bytes, chunk]); if (!validatedPm2FrameLength(bytes)) return;
            const [request, id] = new Message(bytes).args; bytes = Buffer.alloc(0);
            requests.push(request);
            if (request.method === 'getMonitorData') return socket.write(new Message([{ args: [[slot]] }, id]).toBuffer());
            mutations.push(request);
            if (request.method === 'stopProcessId') {
                const stopped = once(app, 'close'); app.kill('SIGTERM'); await stopped;
                slot.pid = 0; slot.pm2_env.status = 'stopped';
            }
            if (request.method === 'restartProcessId') { Object.assign(slot.pm2_env.env, request.args[0].env); Object.assign(slot.pm2_env, request.args[0].env); }
            if (loseReply) return socket.destroy();
            socket.write(new Message([{ args: [[slot]] }, id]).toBuffer());
        });
    });
    await new Promise(resolve => server.listen(socketPath, resolve));
    t.after(async () => {
        for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve));
        if (app.exitCode === null && app.signalCode === null) { const ended = once(app, 'close'); app.kill('SIGTERM'); await ended; }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const stat = fs.lstatSync(socketPath, { bigint: true });
    const row = fs.readFileSync('/proc/net/unix', 'utf8').split('\n').map(line => line.trim().split(/\s+/))
        .find(value => value[7] === socketPath && value[3] === '00010000');
    const observer = { socketPath, daemon: { pid: process.pid, startTicks: daemon.startTicks, bootId: daemon.bootId,
        uid: process.getuid(), exeSha256: sha(fs.readFileSync(process.execPath)) },
        socketIdentity: { device: String(stat.dev), inode: String(stat.ino), uid: process.getuid(), listenerInode: row[6],
            networkNamespace: fs.readlinkSync('/proc/self/ns/net') }, ss: { path: '/usr/bin/ss', sha256: sha(fs.readFileSync('/usr/bin/ss')) }, peerCredentialReader: reader };
    const authority = { schema: 'nassaj-pm2-service-owner/v1', observer, pmId: 3, name: 'fixture', namespace: 'fixture',
        controlsSha256: sha(api.serviceOwnerSlotControls(slot)), environmentSha256: sha(env),
        previous: { pid: app.pid, startTicks: previous.startTicks } };
    const intents = new Set(), unknown = [];
    const hooks = { authorize(intent) { assert.equal(intents.has(intent.step), false, 'replay refused'); intents.add(intent.step); },
        unknown(value) { unknown.push(value); } };
    return { authority, hooks, slot, mutations, requests, unknown };
}
test('sealed service-owner transport stops one child and starts stopped slot without adding MODE', async t => {
    const f = await fixture(t);
    await api.executeServiceOwnerPm2Step(f.authority, 'stop-old', f.hooks);
    assert.equal(f.slot.pid, 0); assert.equal(f.mutations.length, 1);
    const nextEnvironment = { ...f.slot.pm2_env.env, NASSAJ_PREVIEW_TRANSACTION_NONCE: 'c'.repeat(64), NASSAJ_PREVIEW_BOOT_NONCE: 'd'.repeat(64) };
    await api.executeServiceOwnerPm2Step({ ...f.authority, nextEnvironment }, 'start-stopped', f.hooks);
    assert.equal(f.mutations.length, 2);
    assert.deepEqual(Object.keys(f.mutations[1].args[0].env).sort(), ['NASSAJ_PREVIEW_BOOT_NONCE', 'NASSAJ_PREVIEW_TRANSACTION_NONCE']);
    assert.equal(Object.hasOwn(f.slot.pm2_env.env, 'NASSAJ_UPDATE_MODE'), false);
    assert.equal(f.slot.pm2_env.env.PRIVATE_TOKEN, 'never-log-this');
});
test('missing lease, changed controls and extra environment key cannot send a mutation', async t => {
    const f = await fixture(t);
    await assert.rejects(api.executeServiceOwnerPm2Step(f.authority, 'stop-old', { ...f.hooks,
        authorize() { throw Error('missing_claim'); } }), /pm2_observation_unknown/);
    await assert.rejects(api.executeServiceOwnerPm2Step({ ...f.authority, controlsSha256: 'f'.repeat(64) }, 'stop-old', f.hooks), /pm2_observation_unknown/);
    assert.equal(f.mutations.length, 0);
    f.slot.pm2_env.node_args=['--require','/foreign.js'];
    await assert.rejects(api.executeServiceOwnerPm2Step(f.authority,'stop-old',f.hooks),/pm2_observation_unknown/);
    delete f.slot.pm2_env.node_args;
    f.slot.pm2_env.NASSAJ_PREVIEW_BOOT_NONCE='f'.repeat(64);
    await assert.rejects(api.executeServiceOwnerPm2Step(f.authority,'stop-old',f.hooks),/pm2_observation_unknown/);
    f.slot.pm2_env.NASSAJ_PREVIEW_BOOT_NONCE=f.slot.pm2_env.env.NASSAJ_PREVIEW_BOOT_NONCE;
    assert.equal(f.mutations.length,0);
    await api.executeServiceOwnerPm2Step(f.authority, 'stop-old', f.hooks);
    await assert.rejects(api.executeServiceOwnerPm2Step({ ...f.authority, nextEnvironment: { ...f.slot.pm2_env.env,
        NODE_OPTIONS: '--inspect' } }, 'start-stopped', f.hooks), /pm2_observation_unknown/);
    assert.equal(f.mutations.length, 1);
});
test('lost effect reply records UNKNOWN exactly once and cannot replay stop', async t => {
    const f = await fixture(t, true);
    await assert.rejects(api.executeServiceOwnerPm2Step(f.authority, 'stop-old', f.hooks), /pm2_observation_unknown/);
    assert.equal(f.mutations.length, 1); assert.equal(f.unknown.length, 1);
    await assert.rejects(api.executeServiceOwnerPm2Step(f.authority, 'stop-old', f.hooks), /pm2_observation_unknown/);
    assert.equal(f.mutations.length, 1);
});
test('default credentials without a sealed runtime send zero RPC bytes', async t => {
    const f = await fixture(t); delete f.authority.observer.peerCredentialReader;
    await assert.rejects(api.executeServiceOwnerPm2Step(f.authority, 'stop-old', f.hooks), /peer_credentials_reader/);
    assert.equal(f.mutations.length, 0); assert.equal(f.requests.length, 0);
});

test('stopped-slot start permits only absent MODE and bootstrap nonce additions after authorize precedes mutation', async t => {
    const f = await fixture(t);
    for (const key of ['NASSAJ_PREVIEW_TRANSACTION_NONCE','NASSAJ_PREVIEW_BOOT_NONCE']) {
        delete f.slot.pm2_env.env[key]; delete f.slot.pm2_env[key];
    }
    f.authority.environmentSha256 = sha(f.slot.pm2_env.env);
    await api.executeServiceOwnerPm2Step(f.authority, 'stop-old', f.hooks);
    const nextEnvironment = { ...f.slot.pm2_env.env, NASSAJ_UPDATE_MODE: 'local-main',
        NASSAJ_PREVIEW_TRANSACTION_NONCE: 'c'.repeat(64), NASSAJ_PREVIEW_BOOT_NONCE: 'd'.repeat(64) };
    for (const mutate of [value => delete value.PATH, value => value.PATH = '/untrusted',
        value => value.NEW_SECRET = 'forbidden', value => value.NASSAJ_UPDATE_MODE = 'unknown',
        value => value.NASSAJ_PREVIEW_BOOT_NONCE = 'malformed']) {
        const changed = { ...nextEnvironment }; mutate(changed);
        await assert.rejects(api.executeServiceOwnerPm2Step({ ...f.authority, nextEnvironment: changed }, 'start-stopped', f.hooks), /pm2_observation_unknown/);
        assert.equal(f.mutations.length, 1);
    }
    const authorize = f.hooks.authorize;
    await api.executeServiceOwnerPm2Step({ ...f.authority, nextEnvironment }, 'start-stopped', {
        ...f.hooks, authorize(intent) { assert.equal(f.mutations.length, 1); authorize(intent); },
    });
    assert.equal(f.mutations.length, 2);
    assert.deepEqual(f.mutations[1].args[0].env, { NASSAJ_UPDATE_MODE: 'local-main',
        NASSAJ_PREVIEW_TRANSACTION_NONCE: 'c'.repeat(64), NASSAJ_PREVIEW_BOOT_NONCE: 'd'.repeat(64) });
    assert.equal(f.slot.pm2_env.env.PRIVATE_TOKEN, 'never-log-this');
});
