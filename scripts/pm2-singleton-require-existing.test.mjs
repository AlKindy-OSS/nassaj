import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test, { after } from 'node:test';
import { once } from 'node:events';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Message from './vendor/pm2-codec/amp-message/index.js';
import { requireExistingPm2 } from './pm2-singleton-require-existing.mjs';
import { observeStableExistingPm2, withPm2SingletonLease } from './lib/pm2-singleton-observer.mjs';
import { createPm2SingletonAttempt } from './lib/pm2-singleton-guard.mjs';
import { validatedPm2FrameLength } from './lib/pm2-existing-transport.mjs';
import { observePinnedPm2UnderLease, restartPinnedPm2UnderLease } from './lib/pm2-singleton-existing-transport.mjs';

const HOST_HOME = path.join(os.userInfo().homedir, '.pm2');
const NODE = fs.realpathSync('/usr/bin/node');
const BOOT = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

function sentinel() {
    return ['pm2.pid', 'rpc.sock', 'pub.sock', 'dump.pm2'].map(name => {
        const file = path.join(HOST_HOME, name);
        try { const stat = fs.lstatSync(file, { bigint: true });
            const digest = stat.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '-';
            return `${name}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${digest}`; }
        catch (error) { if (error.code === 'ENOENT') return `${name}:absent`; throw error; }
    });
}
const hostBefore = sentinel();
after(() => assert.deepEqual(sentinel(), hostBefore));

function statLine(startTicks = '12345') {
    return `400 (PM2 synthetic) S 1 ${Array(17).fill('0').join(' ')} ${startTicks}\n`;
}

async function listen(file) {
    const server = net.createServer(); server.listen(file); await once(server, 'listening'); fs.chmodSync(file, 0o600); return server;
}

function unixRow(inode, file) {
    return `0000000000000000: 00000002 00000000 00010000 0001 01 ${inode} ${file}`;
}

async function fixture(t) {
    const root = fs.mkdtempSync('/var/tmp/pm2-singleton-preflight-'); fs.chmodSync(root, 0o700);
    const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 });
    const rpcPath = path.join(home, 'rpc.sock'), pubPath = path.join(home, 'pub.sock');
    const rpc = await listen(rpcPath), pub = await listen(pubPath);
    const proc = path.join(root, 'proc'), manager = path.join(proc, '400');
    for (const directory of ['sys/kernel/random', '400/fd', '400/ns', '400/net']) fs.mkdirSync(path.join(proc, directory), { recursive: true });
    fs.writeFileSync(path.join(proc, 'sys/kernel/random/boot_id'), `${BOOT}\n`);
    fs.writeFileSync(path.join(manager, 'stat'), statLine());
    fs.writeFileSync(path.join(manager, 'status'), `Name:\tPM2\nUid:\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\n`);
    fs.writeFileSync(path.join(manager, 'cmdline'), `PM2 v7.0.1: God Daemon (${home})\0padding`);
    fs.symlinkSync(NODE, path.join(manager, 'exe')); fs.symlinkSync('net:[333]', path.join(manager, 'ns/net'));
    fs.symlinkSync('socket:[901]', path.join(manager, 'fd/3')); fs.symlinkSync('socket:[902]', path.join(manager, 'fd/4'));
    fs.writeFileSync(path.join(home, 'pm2.pid'), '400\n', { mode: 0o600 });
    const header = 'Num RefCount Protocol Flags Type St Inode Path';
    fs.writeFileSync(path.join(manager, 'net/unix'), `${header}\n${unixRow(901, rpcPath)}\n${unixRow(902, pubPath)}\n`);
    const settings = { homePath: home, expectedExecutable: NODE, ownerUid: process.getuid(), ownerGid: process.getgid(),
        lockPath: path.join(home, 'nassaj-pm2-singleton.lock') };
    t.after(async () => { await Promise.all([new Promise(resolve => rpc.close(resolve)), new Promise(resolve => pub.close(resolve))]);
        fs.rmSync(root, { recursive: true, force: true }); });
    return { root, home, proc, manager, rpc, pub, rpcPath, pubPath, settings,
        deps: { procRoot: proc, leaseProcRoot: '/proc' } };
}

test('preflight admits one stable existing manager and releases its callback lease', async t => {
    const value = await fixture(t); const result = await requireExistingPm2(value.settings, value.deps);
    assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), 'net:[333]', 'fixture must exercise observer/manager netns mismatch');
    assert.equal(result.schema, 'nassaj-pm2-singleton-preflight-result/v1');
    assert.equal(result.action, 'use-existing'); assert.equal(result.supervisor.pid, 400);
    assert.throws(() => createPm2SingletonAttempt(result, '00000000-0000-0000-0000-000000000001', {}),
        /decision_provenance_invalid/);
    assert.equal(fs.statSync(value.settings.lockPath).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(value.settings.lockPath), true, 'permanent lock inode must remain');
});

test('process churn, unreadable evidence, duplicate paths and foreign listener FDs fail closed', async t => {
    await t.test('pid churn', async t => {
        const value = await fixture(t); let changed = false;
        assert.throws(() => observeStableExistingPm2(value.settings, { ...value.deps, betweenScans() {
            if (changed) return; changed = true; fs.mkdirSync(path.join(value.proc, '401'));
        } }), /process_churn/);
    });
    await t.test('unreadable process', async t => {
        const value = await fixture(t); fs.chmodSync(path.join(value.manager, 'status'), 0o000);
        assert.throws(() => observeStableExistingPm2(value.settings, value.deps), /process_(?:unreadable|scan_incomplete)/);
    });
    await t.test('duplicate socket path', async t => {
        const value = await fixture(t); const file = path.join(value.manager, 'net/unix');
        fs.appendFileSync(file, `${unixRow(999, value.rpcPath)}\n`);
        assert.throws(() => observeStableExistingPm2(value.settings, value.deps), /socket_path_duplicate/);
    });
    await t.test('foreign listener fd', async t => {
        const value = await fixture(t); fs.unlinkSync(path.join(value.manager, 'fd/3'));
        fs.symlinkSync('socket:[999]', path.join(value.manager, 'fd/3'));
        assert.throws(() => observeStableExistingPm2(value.settings, value.deps), /socket_foreign_owner/);
    });
    await t.test('manager netns drift', async t => {
        const value = await fixture(t); let changed = false;
        assert.throws(() => observeStableExistingPm2(value.settings, { ...value.deps, betweenScans() {
            if (changed) return; changed = true; fs.unlinkSync(path.join(value.manager, 'ns/net'));
            fs.symlinkSync('net:[444]', path.join(value.manager, 'ns/net'));
        } }), /manager_netns_changed/);
    });
});

test('pidfile symlinks and identity replacement are rejected without following them', async t => {
    const value = await fixture(t), pidfile = path.join(value.home, 'pm2.pid'), target = path.join(value.root, 'foreign-pid');
    fs.writeFileSync(target, '400\n'); fs.unlinkSync(pidfile); fs.symlinkSync(target, pidfile);
    assert.throws(() => observeStableExistingPm2(value.settings, value.deps), /ELOOP|pidfile/);
    assert.equal(fs.readFileSync(target, 'utf8'), '400\n');
});

test('lease rejects lock replacement and holder death, then reaps the holder', async t => {
    await t.test('replacement', async t => {
        const value = await fixture(t);
        await assert.rejects(withPm2SingletonLease(value.settings, async () => {
            fs.renameSync(value.settings.lockPath, `${value.settings.lockPath}.old`);
            fs.writeFileSync(value.settings.lockPath, '', { mode: 0o600 });
        }), /lock_replaced/);
    });
    await t.test('holder death', async t => {
        const value = await fixture(t); let holder;
        await assert.rejects(withPm2SingletonLease(value.settings, async lease => {
            holder = lease.owner.pid; process.kill(holder, 'SIGKILL'); await new Promise(resolve => setTimeout(resolve, 25));
        }), /holder_died|ENOENT/);
        assert.equal(fs.existsSync(`/proc/${holder}`), false);
    });
});

test('flock -F actual lock descriptor is discovered instead of assuming inherited fd 3', async t => {
    const value = await fixture(t);
    await withPm2SingletonLease(value.settings, async lease => {
        const base = `/proc/${lease.owner.pid}/fdinfo`;
        const locked = fs.readdirSync(base).filter(name => fs.readFileSync(path.join(base, name), 'utf8').includes('FLOCK'));
        assert.equal(locked.length, 1); assert.notEqual(locked[0], '3');
    });
});

test('lease acquisition timeout reaps the delayed fixed holder and leaves no lock owner', async t => {
    const value = await fixture(t);
    await assert.rejects(withPm2SingletonLease(value.settings, async () => {}, {
        holderReadyDelayMs: 200, timeoutMs: 5,
    }), /lease_timeout/);
    const result = await withPm2SingletonLease(value.settings, async lease => lease.held);
    assert.equal(result, true);
});

test('invalid lock validation closes every opened descriptor', async t => {
    const value = await fixture(t); fs.writeFileSync(value.settings.lockPath, '', { mode: 0o644 });
    const before = fs.readdirSync('/proc/self/fd').length;
    for (let index = 0; index < 40; index++) {
        await assert.rejects(withPm2SingletonLease(value.settings, async () => {}), /lock_unsafe/);
    }
    assert.equal(fs.readdirSync('/proc/self/fd').length, before);
});

test('CLI refuses missing arguments and any allow-create vocabulary without host changes', () => {
    const script = path.resolve('scripts/pm2-singleton-require-existing.mjs');
    const missing = spawnSync(NODE, [script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    assert.equal(missing.status, 1); assert.match(missing.stderr, /arguments_invalid/);
    const create = spawnSync(NODE, [script, '--mode', 'allow-create'], {
        encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    });
    assert.equal(create.status, 1); assert.match(create.stderr, /arguments_invalid/);
    assert.deepEqual(sentinel(), hostBefore);
});

function pm2Slot(environment = { PATH: '/usr/bin:/bin', PRIVATE: 'fixture-secret' }) {
    return { name: 'fixture', pm_id: 3, pid: 900, pm2_env: { name: 'fixture', namespace: 'fixture-ns', status: 'online',
        pm_exec_path: '/fixture/app.js', pm_cwd: '/fixture', exec_interpreter: '/usr/bin/node', exec_mode: 'fork_mode',
        autorestart: true, watch: false, ...environment, env: { ...environment } } };
}

function attachTransport(value, t, behavior = 'success') {
    const slot = pm2Slot(), rows = [slot], requests = [], sockets = new Set(); let received = 0; let holderToKill = null;
    value.rpc.on('connection', socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let bytes = Buffer.alloc(0);
        socket.on('data', chunk => {
            received += chunk.length; bytes = Buffer.concat([bytes, chunk]); if (!validatedPm2FrameLength(bytes)) return;
            const [request, id] = new Message(bytes).args; bytes = Buffer.alloc(0); requests.push(request);
            if (request.method === 'getMonitorData') {
                socket.write(new Message([{ args: [rows] }, id]).toBuffer()); return;
            }
            assert.equal(request.method, 'restartProcessId');
            Object.assign(slot.pm2_env.env, request.args[0].env); Object.assign(slot.pm2_env, request.args[0].env);
            if (behavior === 'disconnect') { socket.destroy(); return; }
            const reply = new Message([{ args: [[slot]] }, behavior === 'wrong-id' ? 'wrong' : id]).toBuffer();
            if (behavior === 'truncated') { socket.write(reply.subarray(0, 7)); socket.end(); return; }
            if (behavior === 'lose-lease') process.kill(holderToKill, 'SIGKILL');
            socket.write(reply);
        });
    });
    t.after(() => { for (const socket of sockets) socket.destroy(); });
    const snapshot = Object.freeze({ daemon: { pid: 400 }, socket: { inode: '901' } });
    const deps = { Message, kernelSnapshot: () => snapshot, peerCredentials: async () => {}, peerProof: async () => {},
        deadline: performance.now() + 4000 };
    const settings = { socketPath: value.rpcPath };
    const request = { schema: 'nassaj-pm2-restart-existing-request/v1', pmId: 3, name: 'fixture', namespace: 'fixture-ns',
        expectedEnvironment: { ...slot.pm2_env.env }, nextEnvironment: { ...slot.pm2_env.env,
            NASSAJ_UPDATE_MODE: 'local-main', NASSAJ_PREVIEW_TRANSACTION_NONCE: 'a'.repeat(64),
            NASSAJ_PREVIEW_BOOT_NONCE: 'b'.repeat(64) } };
    return { settings, deps, request, requests, rows, slot, received: () => received,
        setHolder(pid) { holderToKill = pid; } };
}

test('lease capability is forged-proof, expires after callback and gates read-only observation', async t => {
    const value = await fixture(t), wire = attachTransport(value, t); let expired;
    await assert.rejects(observePinnedPm2UnderLease(wire.settings, {}, wire.deps), /lease_capability_invalid/);
    assert.equal(wire.received(), 0);
    await withPm2SingletonLease(value.settings, async lease => {
        expired = lease; const observed = await observePinnedPm2UnderLease(wire.settings, lease, wire.deps);
        assert.equal(observed.state, 'observed'); assert.equal(observed.entries[0].pmId, 3);
    });
    await assert.rejects(observePinnedPm2UnderLease(wire.settings, expired, wire.deps), /lease_capability_invalid/);
});

test('lost lease before dispatch sends zero bytes', async t => {
    const value = await fixture(t), wire = attachTransport(value, t);
    await assert.rejects(withPm2SingletonLease(value.settings, async lease => {
        process.kill(lease.owner.pid, 'SIGKILL'); await new Promise(resolve => setTimeout(resolve, 15));
        await observePinnedPm2UnderLease(wire.settings, lease, wire.deps);
    }), /lease_capability_invalid|holder_died/);
    assert.equal(wire.received(), 0);
});

test('lease loss after socket open but before getMonitorData dispatch sends zero bytes', async t => {
    const value = await fixture(t), wire = attachTransport(value, t); let boundaryError;
    await assert.rejects(withPm2SingletonLease(value.settings, async lease => {
        const deps = { ...wire.deps, async peerCredentials() {
            process.kill(lease.owner.pid, 'SIGKILL'); await new Promise(resolve => setTimeout(resolve, 15));
        } };
        try { await observePinnedPm2UnderLease(wire.settings, lease, deps); }
        catch (error) { boundaryError = error.message; }
    }), /holder_died/);
    assert.match(boundaryError, /pm2_observation_unknown:unavailable/); assert.equal(wire.received(), 0);
});

test('fixed restart matches slot and both environment copies and returns acknowledgement only', async t => {
    const value = await fixture(t), wire = attachTransport(value, t);
    const result = await withPm2SingletonLease(value.settings, lease =>
        restartPinnedPm2UnderLease(wire.settings, lease, wire.request, wire.deps));
    assert.deepEqual(result, { schema: 'nassaj-pm2-restart-ack/v1', state: 'acknowledged', pmId: 3,
        name: 'fixture', namespace: 'fixture-ns' });
    assert.equal(Object.hasOwn(result, 'healthy'), false); assert.equal(Object.hasOwn(result, 'status'), false);
    assert.deepEqual(wire.requests.map(request => request.method), ['getMonitorData', 'restartProcessId']);
    assert.deepEqual(Object.keys(wire.requests[1].args[0].env).sort(),
        ['NASSAJ_PREVIEW_BOOT_NONCE', 'NASSAJ_PREVIEW_TRANSACTION_NONCE', 'NASSAJ_UPDATE_MODE']);
});

test('same process name in another namespace does not make the exact slot ambiguous', async t => {
    const value = await fixture(t), wire = attachTransport(value, t), other = pm2Slot();
    other.pm_id = 4; other.pm2_env.namespace = 'other-ns'; wire.rows.push(other);
    const result = await withPm2SingletonLease(value.settings, lease =>
        restartPinnedPm2UnderLease(wire.settings, lease, wire.request, wire.deps));
    assert.equal(result.pmId, 3);
    assert.equal(wire.requests.filter(item => item.method === 'restartProcessId').length, 1);
});

test('conflicting exact id and exact name plus namespace reject before restart dispatch', async t => {
    const value = await fixture(t), wire = attachTransport(value, t), idMatch = pm2Slot();
    wire.slot.pm_id = 4; idMatch.name = 'other'; idMatch.pm2_env.name = 'other';
    idMatch.pm2_env.namespace = 'other-ns'; wire.rows.push(idMatch);
    await assert.rejects(withPm2SingletonLease(value.settings, lease =>
        restartPinnedPm2UnderLease(wire.settings, lease, wire.request, wire.deps)), /restart_slot_conflict/);
    assert.deepEqual(wire.requests.map(item => item.method), ['getMonitorData']);
});

test('unchanged non-string environment values survive canonical comparison', async t => {
    const value = await fixture(t), wire = attachTransport(value, t);
    const unchanged = { OBJECT: { nested: true }, COUNT: 3, FLAG: false, LIST: ['x'] };
    Object.assign(wire.slot.pm2_env.env, structuredClone(unchanged));
    Object.assign(wire.slot.pm2_env, structuredClone(unchanged));
    Object.assign(wire.request.expectedEnvironment, structuredClone(unchanged));
    Object.assign(wire.request.nextEnvironment, structuredClone(unchanged));
    await withPm2SingletonLease(value.settings, lease =>
        restartPinnedPm2UnderLease(wire.settings, lease, wire.request, wire.deps));
    assert.deepEqual(Object.keys(wire.requests[1].args[0].env).sort(),
        ['NASSAJ_PREVIEW_BOOT_NONCE', 'NASSAJ_PREVIEW_TRANSACTION_NONCE', 'NASSAJ_UPDATE_MODE']);
});

test('flat-only transition environment rejects before restart dispatch', async t => {
    const value = await fixture(t), wire = attachTransport(value, t);
    wire.slot.pm2_env.NASSAJ_UPDATE_MODE = 'release';
    await assert.rejects(withPm2SingletonLease(value.settings, lease =>
        restartPinnedPm2UnderLease(wire.settings, lease, wire.request, wire.deps)), /restart_environment_shadow/);
    assert.deepEqual(wire.requests.map(item => item.method), ['getMonitorData']);
});

test('nested-only transition environment rejects before restart dispatch', async t => {
    const value = await fixture(t), wire = attachTransport(value, t);
    wire.slot.pm2_env.env.NASSAJ_UPDATE_MODE = 'release';
    await assert.rejects(withPm2SingletonLease(value.settings, lease =>
        restartPinnedPm2UnderLease(wire.settings, lease, wire.request, wire.deps)), /restart_environment_shadow/);
    assert.deepEqual(wire.requests.map(item => item.method), ['getMonitorData']);
});

test('method injection and forbidden environment delta reject before any socket byte', async t => {
    for (const mutate of [request => { request.method = 'save'; }, request => { request.method = 'dumpProcessList'; },
        request => { request.nextEnvironment.NEW_SECRET = 'forbidden'; }]) await t.test('reject', async t => {
        const value = await fixture(t), wire = attachTransport(value, t), request = structuredClone(wire.request); mutate(request);
        await assert.rejects(withPm2SingletonLease(value.settings, lease =>
            restartPinnedPm2UnderLease(wire.settings, lease, request, wire.deps)));
        assert.equal(wire.received(), 0); assert.equal(wire.requests.length, 0);
    });
});

for (const behavior of ['truncated', 'wrong-id', 'disconnect']) {
    test(`${behavior} after restart write is UNKNOWN and cannot retry on the same lease`, async t => {
        const value = await fixture(t), wire = attachTransport(value, t, behavior);
        await withPm2SingletonLease(value.settings, async lease => {
            await assert.rejects(restartPinnedPm2UnderLease(wire.settings, lease, wire.request, wire.deps), /restart_effect_unknown/);
            await assert.rejects(restartPinnedPm2UnderLease(wire.settings, lease, wire.request, wire.deps), /restart_already_attempted/);
        });
        assert.equal(wire.requests.filter(request => request.method === 'restartProcessId').length, 1);
    });
}

test('lease loss after a valid restart response is UNKNOWN', async t => {
    const value = await fixture(t), wire = attachTransport(value, t, 'lose-lease'); let observed;
    await assert.rejects(withPm2SingletonLease(value.settings, async lease => {
        wire.setHolder(lease.owner.pid);
        try { await restartPinnedPm2UnderLease(wire.settings, lease, wire.request, wire.deps); }
        catch (error) { observed = error.message; }
    }), /holder_died|ENOENT/);
    assert.equal(observed, 'pm2_observation_unknown:restart_effect_unknown');
});
