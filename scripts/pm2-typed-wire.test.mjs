import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { forwardValueSha256 as sha, canonicalForwardValue } from './lib/release-runtime-forward-child-protocol.mjs';
import { createHash } from 'node:crypto';
import { validatedPm2FrameLength } from './lib/pm2-readonly-observer.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const FIXTURE_FILE_MODE = 0o644;
const FIXTURE_DIRECTORY_MODE = 0o755;
function fixtureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: FIXTURE_DIRECTORY_MODE });
    fs.chmodSync(directory, FIXTURE_DIRECTORY_MODE);
}
function fixtureFile(file, contents) {
    fs.writeFileSync(file, contents, { mode: FIXTURE_FILE_MODE });
    fs.chmodSync(file, FIXTURE_FILE_MODE);
}
function fixtureCopy(source, destination) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, FIXTURE_FILE_MODE);
}
const files = ['amp-message/Readme.md', 'amp-message/index.js', 'amp-message/package.json', 'amp/Readme.md',
    'amp/index.js', 'amp/lib/decode.js', 'amp/lib/encode.js', 'amp/lib/stream.js', 'amp/package.json'].sort();
const descriptor = { name: 'fixture', namespace: 'isolated', pm_exec_path: '/fixture/app', pm_cwd: '/fixture', exec_interpreter: '/usr/bin/node',
    exec_mode: 'fork_mode', uid: process.getuid(), gid: process.getgid(), pm_out_log_path: '/fixture/out', pm_err_log_path: '/fixture/err', pm_pid_path: '/fixture/pid',
    status: 'stopped', autostart: true, autorestart: false, watch: false, pmx: false, vizion: false, wait_ready: false,
    restart_time: 0, unstable_restarts: 0, prev_restart_delay: 0, env: { FIXTURE_SECRET: 'must-not-appear-in-result' } };
async function wireFixture(t, mode) {
    const targetDescriptor = structuredClone(descriptor);
    if (mode === 'target-uid-mismatch') targetDescriptor.uid = process.getuid() === 1000 ? 1001 : 1000;
    // startProcessId below returns this process; its real kernel UID must match the positive target.
    const kernelUids = fs.readFileSync('/proc/self/status', 'utf8').match(/^Uid:\s+(.+)$/m)[1].trim().split(/\s+/).map(Number);
    assert.equal(kernelUids.length, 4); assert.ok(kernelUids.every(uid => uid === process.getuid()));
    fs.mkdirSync(path.resolve('.artifacts'), { recursive: true });
    const root = fs.mkdtempSync(path.resolve('.artifacts/typed-wire-')); fs.chmodSync(root, FIXTURE_DIRECTORY_MODE); const peers = new Set(); let child;
    const codecRoot = path.join(root, 'node_modules'); const pins = [];
    for (const file of files) { const target = path.join(codecRoot, file); fixtureDirectory(path.dirname(target));
        const bytes = fs.readFileSync(path.resolve('scripts/vendor/pm2-codec', file)); fixtureFile(target, bytes); pins.push({ path: file, sha256: hash(bytes) }); }
    fixtureDirectory(path.join(root, 'scripts/lib'));
    for (const name of ['pm2-readonly-observer.mjs', 'pm2-existing-transport.mjs', 'pm2-typed-mutation.mjs', 'release-runtime-forward-child-protocol.mjs'])
        fixtureCopy(path.resolve('scripts/lib', name), path.join(root, 'scripts/lib', name));
    const codecFile = path.join(codecRoot, 'amp-message/index.js'); const Message = createRequire(codecFile)(codecFile);
    // Kernel evidence is already a seam; loopback transport preserves actual codec/ACK checks in B899.
    const socketPath = '/fixture/rpc.sock'; let entries = []; let connections = 0; let mutations = 0; let durable = false;
    const trace = []; const server = net.createServer(socket => {
        peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
        const connection = ++connections; let buffer = Buffer.alloc(0);
        socket.on('data', bytes => {
            buffer = Buffer.concat([buffer, bytes]); if (!validatedPm2FrameLength(buffer)) return;
            const [request, id] = new Message(buffer).args; buffer = Buffer.alloc(0); trace.push({ connection, method: request.method });
            if (request.method === 'getMonitorData') { socket.write(new Message([{ args: [entries] }, id]).toBuffer());
                if (mode === 'extra-during-ack') setTimeout(() => { if (!socket.destroyed) socket.write(Buffer.from([0x12])); }, 10); return; }
            assert.ok(['prepare', 'startProcessId'].includes(request.method)); assert.equal(durable, true); mutations++;
            if (request.method === 'startProcessId') {
                assert.equal(request.args[0], 44); assert.ok(fs.existsSync(path.join(root, 'result-configure-target-stopped.json')));
                const env = entries[0].pm2_env; Object.assign(env, env.env); env.status = 'online'; env.created_at = Date.now(); env.pm_uptime = Date.now();
                env.axm_actions = []; env.axm_monitor = {}; env.axm_options = {}; env.axm_dynamic = {}; env.version = '9.8.7';
                entries[0].pid = process.pid;
                return socket.write(new Message([{ args: [{ pm2_env: env, process: { pid: process.pid } }] }, id]).toBuffer());
            }
            const env = structuredClone(request.args[0]); env.pm_id = 44; env.vizion_running = false; env.env.unique_id = '12345678-1234-4234-8234-123456789abc';
            entries = [{ pm_id: 44, pid: 0, name: env.name, pm2_env: env }];
            if (mode === 'lost-reply') return socket.destroy();
            socket.write(new Message([{ args: [[{ pm2_env: env, process: {} }]] }, id]).toBuffer());
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const wirePort = server.address().port;
    t.after(async () => { child?.kill('SIGKILL'); for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const settings = { socketPath, daemon: { pid: 123, startTicks: '1', bootId: 'fixture', uid: process.getuid(), exeSha256: 'a'.repeat(64) },
        socketIdentity: { inode: '2' }, codec: { root: codecRoot, files: pins }, codecClosureSha256: sha(pins) };
    const material = { slot: { baseline: { env: { unique_id: '87654321-4321-4321-8321-123456789abc' } } }, observer: settings, attemptNonce: 'b'.repeat(64), targetDescriptor, metadata: { version: '9.8.7', nodeVersion: process.versions.node }, permitChannel: { requestFd: 5, responseFd: 6 } };
    const request = { operationId: 'wire-operation', attemptId: 'wire-attempt', step: 'configure-target-stopped',
        expectedSlotDigest: sha({ absent: true, name: descriptor.name, namespace: descriptor.namespace }) };
    fixtureFile(path.join(root, 'input.json'), JSON.stringify({ material, request, mode, wirePort }));
    fixtureFile(path.join(root, 'worker.mjs'), `import fs from 'node:fs';import net from 'node:net';import {performance} from 'node:perf_hooks';
const input=JSON.parse(fs.readFileSync(new URL('./input.json',import.meta.url)));
const connect=net.createConnection;net.createConnection=(options,...args)=>connect.call(net,options?.path===input.material.observer.socketPath?{host:'127.0.0.1',port:input.wirePort}:options,...args);
let bootReads=0,monoReads=0,expired=false;const read=fs.readFileSync.bind(fs),hr=process.hrtime.bigint.bind(process.hrtime),now=performance.now.bind(performance);
fs.readFileSync=(file,...args)=>{if(file==='/proc/sys/kernel/random/boot_id'){bootReads++;if(input.mode==='clock-deadline-before')expired=true;}return read(file,...args);};
Object.defineProperty(performance,'now',{value:()=>now()+(expired?6000:0),configurable:true});
process.hrtime.bigint=()=>{monoReads++;if(input.mode==='clock-gap'&&monoReads===2){const until=now()+8;while(now()<until){}}if(input.mode==='clock-exhaust-before'||(input.mode==='clock-exhaust-after'&&bootReads>=3))return BigInt(monoReads)*2000000n;return hr();};
const original=fs.lstatSync.bind(fs);fs.lstatSync=(file,...args)=>{const value=original(file,...args);if(value.isDirectory()){value.mode&=~0o022;value.uid=process.getuid();}return value;};
const {executePinnedPm2Step}=await import('./scripts/lib/pm2-readonly-observer.mjs');
const {acknowledgePm2StepResult,closePm2PermitChannel}=await import('./scripts/lib/pm2-typed-mutation.mjs');
const {forwardValueSha256:sha}=await import('./scripts/lib/release-runtime-forward-child-protocol.mjs');
let peers=0;const deps={ownerUid:process.getuid(),peerCredentials:async()=>{},kernelSnapshot:()=>({daemon:input.material.observer.daemon,socket:input.material.observer.socketIdentity}),peerProof:async()=>{if(input.mode==='peer-change'&&++peers===3)throw Error('peerchanged');}};
try{let result=await executePinnedPm2Step(input.request,input.material,deps);await acknowledgePm2StepResult(input.material,result);
if(['multi-step','uuid-drift','target-uid-mismatch'].includes(input.mode)){result=await executePinnedPm2Step({...input.request,step:'start-target',expectedSlotDigest:sha(input.material.slot.baseline)},input.material,deps);await acknowledgePm2StepResult(input.material,result);}
closePm2PermitChannel(input.material);process.stdout.write(JSON.stringify(result));process.exit(0);}catch(error){process.stdout.write(JSON.stringify({error:error.message}));process.exit(7);}`);
    child = spawn(process.execPath, [path.join(root, 'worker.mjs')], { cwd: root, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'pipe', 'pipe'] });
    let output = ''; let stderr = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => stderr += bytes);
    let intentBuffer = ''; child.stdio[5].on('data', bytes => {
        intentBuffer += bytes; if (!intentBuffer.endsWith('\n')) return;
        const intent = JSON.parse(intentBuffer); intentBuffer = '';
        if (intent.schema === 'nassaj-pm2-step-result/v1') {
            if (mode === 'uuid-drift' && intent.step === 'configure-target-stopped') entries[0].pm2_env.env.unique_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
            const file = path.join(root, `result-${intent.step}.json`); const fd = fs.openSync(file, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify(intent)); fs.fsyncSync(fd); fs.closeSync(fd);
            const directory = fs.openSync(root, 'r'); fs.fsyncSync(directory); fs.closeSync(directory);
            child.stdio[6].write(JSON.stringify({ schema: 'nassaj-pm2-step-ack/v1', operationId: intent.operationId, attemptId: intent.attemptId,
                attemptNonce: intent.attemptNonce, step: intent.step, requestId: intent.requestId, resultSha256: sha(intent), decision: 'recorded', revision: 2 }) + '\n'); return;
        }
        assert.equal(intent.payloadDigest, sha(intent.step === 'start-target' ? 44 : targetDescriptor)); assert.equal(intent.attemptNonce, material.attemptNonce);
        const file = path.join(root, `durable-intent-${intent.step}.json`); const fd = fs.openSync(file, 'wx', 0o600);
        fs.writeFileSync(fd, canonicalForwardValue(intent)); fs.fsyncSync(fd); fs.closeSync(fd);
        const directory = fs.openSync(root, 'r'); fs.fsyncSync(directory); fs.closeSync(directory); durable = true;
        const ack = { ...intent, schema: 'nassaj-pm2-execution-ack/v1', decision: 'authorized', revision: 1 };
        if (mode === 'stale-ack') ack.attemptId = 'stale';
        if (mode === 'extra-during-ack') setTimeout(() => { if (!child.stdio[6].destroyed) child.stdio[6].write(JSON.stringify(ack) + '\n', () => {}); }, 40);
        else child.stdio[6].write(JSON.stringify(ack) + '\n');
    });
    const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('fixturetimeout')); }, 8000);
        child.on('close', code => { clearTimeout(timer); resolve(code); }); });
    assert.equal(stderr, ''); assert.equal(output.includes('must-not-appear'), false);
    return { code, result: JSON.parse(output), mutations, connections, trace, durable, kernelUids, targetUid: targetDescriptor.uid };
}
test('actual mutation wire waits for durable pipe ACK and uses monitor connection for prepare', async t => {
    const result = await wireFixture(t, 'success'); assert.equal(result.code, 0); assert.equal(result.mutations, 1);
    assert.deepEqual(result.trace, [{ connection: 1, method: 'getMonitorData' }, { connection: 1, method: 'prepare' }, { connection: 2, method: 'getMonitorData' }]);
    assert.equal(result.result.targetSlotBinding.allocatedPmId, 44); assert.equal(result.result.dispatchState, 'observed');
});
for (const mode of ['stale-ack', 'peer-change', 'lost-reply', 'extra-during-ack']) test(`${mode} refuses success without reconnecting or repeating a mutation`, async t => {
    const result = await wireFixture(t, mode); assert.equal(result.code, 7); assert.equal(result.result.error, 'pm2_mutation_unknown:effect_unproven');
    assert.equal(result.connections, 1); assert.equal(result.mutations, mode === 'lost-reply' ? 1 : 0);
});

test('one actual worker persists prepare result ACK before sending start on the derived slot', async t => {
    const result = await wireFixture(t, 'multi-step'); assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.mutations, 2);
    assert.deepEqual(result.trace.map(item => [item.connection, item.method]), [[1, 'getMonitorData'], [1, 'prepare'], [2, 'getMonitorData'],
        [3, 'getMonitorData'], [3, 'startProcessId'], [4, 'getMonitorData']]);
    assert.equal(result.result.step, 'start-target');
    assert.ok(result.kernelUids.every(uid => uid === result.targetUid));
});

test('started target with a different real kernel UID is rejected without replaying either mutation', async t => {
    const result = await wireFixture(t, 'target-uid-mismatch');
    assert.ok(result.kernelUids.every(uid => uid !== result.targetUid));
    assert.equal(result.code, 7); assert.equal(result.result.error, 'pm2_mutation_unknown:effect_unproven');
    assert.equal(result.mutations, 2); assert.equal(result.connections, 4); assert.equal(result.durable, true);
    assert.deepEqual(result.trace.map(item => item.method), ['getMonitorData', 'prepare', 'getMonitorData',
        'getMonitorData', 'startProcessId', 'getMonitorData']);
});

test('prepared slot pins its new UUID and rejects drift before start bytes', async t => {
    const result = await wireFixture(t, 'uuid-drift'); assert.equal(result.code, 7);
    assert.equal(result.mutations, 1); assert.equal(result.trace.some(item => item.method === 'startProcessId'), false);
});

for (const mode of ['clock-exhaust-before', 'clock-deadline-before', 'clock-exhaust-after']) test(`${mode} preserves effect count and refuses success`, async t => {
    const result = await wireFixture(t, mode);
    assert.equal(result.code, 7); assert.equal(result.result.error, 'pm2_mutation_unknown:effect_unproven');
    assert.equal(result.mutations, mode === 'clock-exhaust-after' ? 1 : 0);
    assert.equal(result.trace.filter(entry => entry.method === 'prepare').length, result.mutations);
});
test('8 ms acquisition interruption retries clock reads without replaying the mutation', async t => {
    const result = await wireFixture(t, 'clock-gap');
    assert.equal(result.code, 0); assert.equal(result.mutations, 1);
});
