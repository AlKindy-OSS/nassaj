import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { inspectForwardChildIdentity } from './lib/release-runtime-forward-child-protocol.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test, { after } from 'node:test';
import { validatedPm2FrameLength, verifyPm2ConnectedPeer, verifyPinnedPm2PeerCredentials, capturePm2PeerCredentialReader } from './lib/pm2-readonly-observer.mjs';
import { canonicalForwardValue } from './lib/release-runtime-forward-child-protocol.mjs';
import { makeShortSocketDir } from './lib/short-socket-dir.mjs';
const source = path.resolve('scripts/vendor/pm2-codec');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = ['amp-message/Readme.md', 'amp-message/index.js', 'amp-message/package.json', 'amp/Readme.md',
    'amp/index.js', 'amp/lib/decode.js', 'amp/lib/encode.js', 'amp/lib/stream.js', 'amp/package.json'].sort();
// Server wire and observer use separate copies of the reviewed official intake, never mutable global packages.
const wireRoot = fs.mkdtempSync(path.resolve('.artifacts/pm2-wire-'));
const wireModules = path.join(wireRoot, 'node_modules');
for (const file of relative) { fs.mkdirSync(path.dirname(path.join(wireModules, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(wireModules, file)); }
const codecEntry = path.join(wireModules, 'amp-message/index.js');
const Message = createRequire(codecEntry)(codecEntry);
after(() => fs.rmSync(wireRoot, { recursive: true, force: true }));

const entry = () => ({ pm_id: 3, name: 'fixture', pid: 123,
    pm2_env: { name: 'fixture', namespace: 'fixture-ns', status: 'online', pm_exec_path: '/fixture/app.js', pm_cwd: '/fixture',
        exec_interpreter: '/usr/bin/node', exec_mode: 'fork_mode', autorestart: true, watch: false, SECRET: 'never-expose-token', env: { TOKEN: 'hidden' } } });
async function fixture(t, reply = (frame, socket) => socket.write(new Message([{ args: [[entry()]] }, frame[1]]).toBuffer())) {
    const root = fs.mkdtempSync(path.resolve('.artifacts/pm2-rpc-')); const codecRoot = path.join(root, 'node_modules');
    // Root-owned ancestry is a declared fixture seam; codec leaf bytes, resolution and wire remain real.
    const lstat = fs.lstatSync.bind(fs);
    t.mock.method(fs, 'lstatSync', (file, options) => { const value = lstat(file, options);
        if (typeof file === 'string' && !file.startsWith(root) && value.isDirectory()) value.mode &= ~0o022; return value; });
    const files = relative.map(file => { const bytes = fs.readFileSync(path.join(source, file)); const target = path.join(codecRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 }); fs.writeFileSync(target, bytes, { mode: 0o644 });
        return { path: file, sha256: sha(bytes) }; });
    const scriptRoot = path.join(root, 'scripts/lib'); fs.mkdirSync(scriptRoot, { recursive: true });
    for (const name of ['pm2-readonly-observer.mjs', 'pm2-existing-transport.mjs', 'pm2-typed-mutation.mjs', 'release-runtime-forward-child-protocol.mjs'])
        fs.copyFileSync(path.resolve('scripts/lib', name), path.join(scriptRoot, name));
    const { observePinnedPm2Runtime: observe } = await import(path.join(scriptRoot, 'pm2-readonly-observer.mjs'));
    let connections = 0, requestBytes = 0; const peers = new Set();
    const server = net.createServer(socket => {
        connections++; peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {});
        let buffer = Buffer.alloc(0);
        socket.on('data', bytes => { requestBytes += bytes.length; buffer = Buffer.concat([buffer, bytes]); if (!validatedPm2FrameLength(buffer)) return;
            const frame = new Message(buffer).args;
            assert.deepEqual(frame[0], { type: 'call', method: 'getMonitorData', args: [{}] }); assert.match(frame[1], /^[a-f0-9]{32}$/);
            reply(frame, socket);
        });
    });
    const socketRoot = makeShortSocketDir('pm2-rpc-', 'rpc.sock'); const socketPath = path.join(socketRoot, 'rpc.sock');
    t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(socketRoot, { recursive: true, force: true }); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const settings = { socketPath, codec: { root: codecRoot, files }, codecClosureSha256: sha(canonicalForwardValue(files)),
        daemon: { pid: 123, startTicks: '456', bootId: 'fixture', uid: process.getuid(), exeSha256: '1'.repeat(64) }, socketIdentity: { inode: '789' } };
    let inspected = 0; let proved = 0;
    const deps = { ownerUid: process.getuid(), peerCredentials: async () => {}, kernelSnapshot: () => { inspected++; return { daemon: settings.daemon, socket: settings.socketIdentity }; },
        peerProof: async (_settings, socket) => { assert.equal(socket.destroyed, false); proved++; } };
    return { root, settings, deps, peers, server, observe, requestBytes: () => requestBytes, counts: () => ({ connections, inspected, proved }) };
}
test('official getMonitorData wire, exact local codec pins, namespace projection and no environment leakage', async t => {
    const f = await fixture(t); const result = await f.observe(f.settings, f.deps);
    assert.equal(result.state, 'observed'); assert.equal(result.entries[0].namespace, 'fixture-ns');
    assert.equal(JSON.stringify(result).includes('SECRET'), false); assert.equal(JSON.stringify(result).includes('hidden'), false);
    assert.equal(JSON.stringify(result).includes('never-expose'), false); assert.deepEqual(f.counts(), { connections: 1, inspected: 3, proved: 1 });
});
test('official reply may split across both header and body boundaries', async t => {
    const f = await fixture(t, (frame, socket) => { const bytes = new Message([{ args: [[entry()]] }, frame[1]]).toBuffer();
        socket.write(bytes.subarray(0, 2)); setImmediate(() => { socket.write(bytes.subarray(2, 8)); setImmediate(() => socket.write(bytes.subarray(8))); }); });
    assert.equal((await f.observe(f.settings, f.deps)).entries.length, 1);
});
test('malformed header, zero/oversized lengths, extra frames, wrong ID and RPC stack fail without leaking response', async t => {
    const cases = { header: () => Buffer.from([0x22]), zero: () => Buffer.from([0x12, 0, 0, 0, 0]),
        oversized: () => Buffer.from([0x12, 0xff, 0xff, 0xff, 0xff]),
        extra: frame => Buffer.concat([new Message([{ args: [[]] }, frame[1]]).toBuffer(), Buffer.from([0x12])]),
        wrong_id: () => new Message([{ args: [[]] }, 'wrong']).toBuffer(),
        rpc_error: frame => new Message([{ error: 'never-expose-token', stack: 'hidden-stack' }, frame[1]]).toBuffer() };
    for (const [name, bytes] of Object.entries(cases)) await t.test(name, async t => {
        const f = await fixture(t, (frame, socket) => socket.write(bytes(frame)));
        await assert.rejects(f.observe(f.settings, f.deps), error => /^pm2_observation_unknown:[a-z_]+$/.test(error.message));
        assert.equal(f.counts().connections, 1);
    });
});
test('extra frame while connected peer evidence is awaited still fails', async t => {
    const f = await fixture(t, (frame, socket) => { socket.write(new Message([{ args: [[]] }, frame[1]]).toBuffer()); setImmediate(() => socket.write(Buffer.from([0x12]))); });
    f.deps.peerProof = async () => new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(f.observe(f.settings, f.deps), /extra_frame/);
});
test('closed fixture daemon connection cannot be reconnected or become an empty observation', async t => {
    const f = await fixture(t, (_frame, socket) => socket.destroy());
    await assert.rejects(f.observe(f.settings, f.deps), /connection_closed/);
    assert.equal(f.counts().connections, 1);
});
test('kernel identity swap and unproved peer deny after actual wire response', async t => {
    for (const kind of ['swap', 'peer']) await t.test(kind, async t => {
        const f = await fixture(t); let calls = 0;
        if (kind === 'swap') f.deps.kernelSnapshot = () => ({ daemon: { pid: ++calls }, socket: {} });
        else f.deps.peerProof = async () => { throw Error('do not print private socket detail'); };
        await assert.rejects(f.observe(f.settings, f.deps), /pm2_observation_unknown:(kernel_changed|unavailable)/);
    });
});
test('changed codec bytes, missing file and package-local resolution drift reject before connecting', async t => {
    for (const change of ['bytes', 'missing', 'resolution']) await t.test(change, async t => {
        const f = await fixture(t); const file = path.join(f.settings.codec.root, 'amp/lib/decode.js');
        if (change === 'bytes') fs.appendFileSync(file, '// drift');
        if (change === 'missing') fs.unlinkSync(file);
        if (change === 'resolution') { const nested = path.join(f.settings.codec.root, 'amp-message/node_modules/amp'); fs.mkdirSync(nested, { recursive: true }); fs.writeFileSync(path.join(nested, 'index.js'), 'throw Error("must not import")'); }
        await assert.rejects(f.observe(f.settings, f.deps), /pm2_observation_unknown/); assert.equal(f.counts().connections, 0);
    });
});
test('duplicate PM2 ids fail but equal names in separate namespaces remain distinguishable', async t => {
    for (const duplicate of [true, false]) await t.test(String(duplicate), async t => {
        const f = await fixture(t, (frame, socket) => { const other = entry(); other.pm2_env.namespace = 'other'; if (!duplicate) other.pm_id = 4;
            socket.write(new Message([{ args: [[entry(), other]] }, frame[1]]).toBuffer()); });
        if (duplicate) await assert.rejects(f.observe(f.settings, f.deps), /entry_invalid/);
        else assert.equal((await f.observe(f.settings, f.deps)).entries.length, 2);
    });
});
test('connected inode proof requires both directions and unambiguous daemon FD ownership', () => {
    const output = 'u_str ESTAB 0 0 * 101 * 202 users:(("node",pid=1,fd=4))\nu_str ESTAB 0 0 * 202 * 101 users:(("node",pid=2,fd=5))\n';
    assert.equal(verifyPm2ConnectedPeer(output, '101', ['202']), '202');
    assert.throws(() => verifyPm2ConnectedPeer(output, '101', ['999']), /peer_unproven/);
    assert.throws(() => verifyPm2ConnectedPeer(output + output, '101', ['202']), /peer_unproven/);
    assert.throws(() => verifyPm2ConnectedPeer(output.split('\n')[0], '101', ['202']), /peer_ambiguous/);
});

async function kernelFixture(t, mode = 'reply') {
    const f = await fixture(t);
    // Replace only the fixture listener with a separate real process; no host daemon is contacted.
    await new Promise(resolve => f.server.close(resolve));
    const code = `const net=require('node:net'); const Message=require(${JSON.stringify(codecEntry)});
        const server=net.createServer(socket=>{socket.on('error',()=>{});socket.on('data',bytes=>{
            if(process.argv[2]==='quiet')return; if(process.argv[2]==='die'){process.exit(0);return;}
            const frame=new Message(bytes).args;
            if(process.argv[2]==='swap'){require('node:fs').unlinkSync(process.argv[1]);net.createServer(()=>{}).listen(process.argv[1]);}
            socket.write(new Message([{args:[[${JSON.stringify(entry())}]]},frame[1]]).toBuffer());
        });});server.listen(process.argv[1],()=>process.stdout.write('ready\\n'));`;
    const child = spawn(process.execPath, ['--no-deprecation', '-e', code, f.settings.socketPath, mode], {
        cwd: f.root, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let diagnostics = '';
    child.stderr.on('data', bytes => { diagnostics += bytes; });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('fixture start timeout')), 3000);
        child.stdout.on('data', bytes => { output += bytes; if (output === 'ready\n') { clearTimeout(timer); resolve(); } });
        child.on('exit', () => { clearTimeout(timer); reject(Error('fixture exited before ready')); }); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'close'); }
        assert.equal(diagnostics, ''); });
    const identity = inspectForwardChildIdentity(child.pid); const stat = fs.lstatSync(f.settings.socketPath, { bigint: true });
    const row = fs.readFileSync(`/proc/${child.pid}/net/unix`, 'utf8').split('\n').map(line => line.trim().split(/\s+/))
        .find(parts => parts[7] === f.settings.socketPath && parts[3] === '00010000');
    f.settings.daemon = { pid: child.pid, startTicks: identity.startTicks, bootId: identity.bootId,
        uid: process.getuid(), exeSha256: sha(fs.readFileSync(process.execPath)) };
    f.settings.socketIdentity = { device: String(stat.dev), inode: String(stat.ino), uid: Number(stat.uid),
        networkNamespace: fs.readlinkSync(`/proc/${child.pid}/ns/net`), listenerInode: row[6] };
    f.settings.ss = { path: '/usr/bin/ss', sha256: sha(fs.readFileSync('/usr/bin/ss')) };
    f.settings.peerCredentialReader = peerCredentialReader();
    return { ...f, child, deps: { ownerUid: process.getuid() } };
}
test('default kernel observer proves separate fixture daemon and real connected peer using pinned ss', async t => {
    const f = await kernelFixture(t); const result = await f.observe(f.settings, f.deps);
    assert.equal(result.daemon.pid, f.child.pid); assert.equal(result.entries[0].name, 'fixture');
});
test('real daemon death before and after connect cannot trigger a reconnect or create a replacement socket', async t => {
    for (const when of ['before', 'after']) await t.test(when, async t => {
        const f = await kernelFixture(t, 'die');
        if (when === 'before') { f.child.kill('SIGTERM'); await once(f.child, 'close'); }
        await assert.rejects(f.observe(f.settings, f.deps), /pm2_observation_unknown/);
        if (f.child.exitCode === null && f.child.signalCode === null) await once(f.child, 'close');
        assert.equal(f.child.exitCode !== null || f.child.signalCode !== null, true);
    });
});
test('real silent daemon exhausts the overall five-second deadline and closes the observation connection', async t => {
    const f = await kernelFixture(t, 'quiet'); const before = Date.now();
    await assert.rejects(f.observe(f.settings, f.deps), /deadline/);
    assert.ok(Date.now() - before >= 4800); assert.ok(Date.now() - before < 6000);
});

test('actual socket replacement and invalid pinned ss refuse evidence without peer callbacks', async t => {
    for (const mode of ['swap', 'reader']) await t.test(mode, async t => {
        const f = await kernelFixture(t, mode === 'swap' ? 'swap' : 'reply');
        if (mode === 'reader') f.settings.ss.sha256 = 'f'.repeat(64);
        await assert.rejects(f.observe(f.settings, f.deps), /pm2_observation_unknown/);
    });
});
test('codec symlink and a changed cached closure cannot be accepted even with updated caller hashes', async t => {
    for (const mode of ['symlink', 'cache']) await t.test(mode, async t => {
        const f = await fixture(t); const file = path.join(f.settings.codec.root, 'amp/lib/decode.js');
        if (mode === 'cache') await f.observe(f.settings, f.deps);
        if (mode === 'symlink') { fs.renameSync(file, `${file}.real`); fs.symlinkSync(`${file}.real`, file); }
        else { fs.appendFileSync(file, '\n// changed bytes'); f.settings.codec.files.find(item => item.path === 'amp/lib/decode.js').sha256 = sha(fs.readFileSync(file));
            f.settings.codecClosureSha256 = sha(canonicalForwardValue(f.settings.codec.files)); }
        await assert.rejects(f.observe(f.settings, f.deps), /pm2_observation_unknown/);
    });
});

let capturedReader;
function peerCredentialReader() {
    capturedReader ||= capturePm2PeerCredentialReader();
    return structuredClone(capturedReader);
}
test('SO_PEERCRED proves the actual RPC connection using its inherited FD', async t => {
    const f = await kernelFixture(t);
    f.settings.peerCredentialReader = peerCredentialReader();
    const result = await f.observe(f.settings, f.deps);
    assert.equal(result.daemon.pid, f.child.pid);
    assert.equal(result.entries[0].name, 'fixture');
});
test('SO_PEERCRED refuses an unrelated live PID even with correct start identity', async t => {
    const f = await kernelFixture(t);
    const socket = net.createConnection(f.settings.socketPath); t.after(() => socket.destroy());
    await once(socket, 'connect');
    const identity = inspectForwardChildIdentity(process.pid);
    const settings = { ...f.settings, peerCredentialReader: peerCredentialReader(),
        daemon: { pid: process.pid, startTicks: identity.startTicks, bootId: identity.bootId, uid: process.getuid() } };
    await assert.rejects(verifyPinnedPm2PeerCredentials(settings, socket, performance.now() + 5000), /peer_credentials_mismatch/);
});
test('SO_PEERCRED rejects changed interpreter bytes and a closed original connection', async t => {
    const f = await kernelFixture(t);
    const socket = net.createConnection(f.settings.socketPath); t.after(() => socket.destroy());
    await once(socket, 'connect');
    const settings = { ...f.settings, peerCredentialReader: peerCredentialReader() };
    await assert.rejects(verifyPinnedPm2PeerCredentials({ ...settings,
        peerCredentialReader: { ...settings.peerCredentialReader, sha256: 'f'.repeat(64) } }, socket,
    performance.now() + 5000), /pin_digest/);
    socket.destroy();
    await assert.rejects(verifyPinnedPm2PeerCredentials(settings, socket, performance.now() + 5000), /connection_closed/);
});
test('SO_PEERCRED verifier cannot accept a recycled or closed FD while its probe runs', async t => {
    const f = await kernelFixture(t);
    const socket = net.createConnection(f.settings.socketPath); t.after(() => socket.destroy());
    await once(socket, 'connect');
    const promise = verifyPinnedPm2PeerCredentials({ ...f.settings, peerCredentialReader: peerCredentialReader() },
        socket, performance.now() + 5000);
    socket.destroy();
    await assert.rejects(promise, /connection_changed/);
});

test('SO_PEERCRED requires the captured startTicks and an unexpired overall deadline', async t => {
    const f = await kernelFixture(t);
    const socket = net.createConnection(f.settings.socketPath); t.after(() => socket.destroy());
    await once(socket, 'connect');
    const settings = { ...f.settings, peerCredentialReader: peerCredentialReader() };
    await assert.rejects(verifyPinnedPm2PeerCredentials({ ...settings,
        daemon: { ...settings.daemon, startTicks: '0' } }, socket, performance.now() + 5000), /peer_credentials_identity/);
    await assert.rejects(verifyPinnedPm2PeerCredentials(settings, socket, performance.now() - 1), /deadline/);
});

test('mandatory peer and runtime closure refuse before the first actual observer RPC byte', async t => {
    for (const mode of ['missing', 'stdlib', 'maps', 'wrong_peer']) await t.test(mode, async t => {
        const f = await fixture(t);
        delete f.deps.peerCredentials;
        const pid = mode === 'wrong_peer' ? process.ppid : process.pid;
        const identity = inspectForwardChildIdentity(pid);
        f.settings.daemon = { pid, startTicks: identity.startTicks, bootId: identity.bootId, uid: process.getuid() };
        if (mode !== 'missing') f.settings.peerCredentialReader = peerCredentialReader();
        if (mode === 'stdlib') f.settings.peerCredentialReader.runtime.stdlibSha256 = 'f'.repeat(64);
        if (mode === 'maps') f.settings.peerCredentialReader.runtime.files[0].sha256 = 'f'.repeat(64);
        await assert.rejects(f.observe(f.settings, f.deps), /pm2_observation_unknown/);
        assert.equal(f.requestBytes(), 0);
    });
});
