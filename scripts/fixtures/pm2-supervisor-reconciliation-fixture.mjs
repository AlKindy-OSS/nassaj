/** Private, synthetic PM2 behavior lab. Never an executor for host reconciliation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RECONCILIATION_SERVICES } from '../lib/pm2-supervisor-reconciliation-contract.mjs';

const SELF = fileURLToPath(import.meta.url);
const NODE = '/usr/bin/node';
const PYTHON = '/usr/bin/python3';
const PM2 = '/usr/lib/node_modules/pm2';
const HOST_HOME = path.join(os.userInfo().homedir, '.pm2');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600, flag: 'wx' });

function identity(pid) {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { pid, startTicks: fields[19], parentPid: Number(fields[1]) };
}

function sentinel() {
    return ['pm2.pid', 'rpc.sock', 'pub.sock', 'dump.pm2', 'dump.pm2.bak', 'module_conf.json'].map(name => {
        const filename = path.join(HOST_HOME, name);
        try {
            const stat = fs.lstatSync(filename);
            assert.ok(!stat.isSymbolicLink(), 'host sentinel symlink');
            return { name, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid,
                hash: stat.isFile() ? sha(fs.readFileSync(filename)) : null,
                process: name === 'pm2.pid' ? identity(Number(fs.readFileSync(filename, 'utf8'))) : null };
        } catch (error) {
            if (error.code === 'ENOENT') return { name, absent: true };
            throw error;
        }
    });
}

/** Require a fresh, owned directory and a PM2_HOME strictly inside that directory. */
export function validatePrivateHome(root, home) {
    assert.match(root, /^\/var\/tmp\/pm2-rec-[A-Za-z0-9]+$/);
    assert.equal(fs.realpathSync(root), root);
    assert.equal(home, path.join(root, 'home/.pm2'));
    assert.notEqual(home, HOST_HOME);
    for (const directory of [root, path.join(root, 'home'), home, path.join(root, 'tmp')]) {
        const stat = fs.lstatSync(directory);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
        assert.equal(stat.uid, process.getuid());
        assert.equal(stat.mode & 0o777, 0o700);
        assert.equal(fs.realpathSync(directory), directory);
    }
}

function environment(root) {
    return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: path.join(root, 'home'),
        PM2_HOME: path.join(root, 'home/.pm2'), TMPDIR: path.join(root, 'tmp'),
        PM2_SILENT: 'true', PM2_DISABLE_VERSION_CHECK: 'true' };
}

// The guardian owns all fixture descendants, including children orphaned by daemon exit.
// It never signals a PID supplied by the worker or read from a PM2 pidfile.
const GUARDIAN = String.raw`
import ctypes, json, os, pathlib, signal, subprocess, sys, time
root, worker, mode = sys.argv[1:]
assert pathlib.Path(root).resolve() == pathlib.Path(root)
assert os.environ['PM2_HOME'] == root + '/home/.pm2'
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
cancel_signal = None
def request_cancel(number, frame):
    global cancel_signal
    if cancel_signal is None: cancel_signal = number
signal.signal(signal.SIGTERM, request_cancel)
signal.signal(signal.SIGINT, request_cancel)
def pin(pid):
    fields = dict(line.split(':', 1) for line in pathlib.Path('/proc/%s/status'%pid).read_text().splitlines() if ':' in line)
    assert int(fields['PPid']) == os.getpid()
    assert list(map(int, fields['Uid'].split())) == [os.getuid()] * 4
    raw = pathlib.Path('/proc/%s/stat'%pid).read_text()
    return raw[raw.rfind(')')+2:].split()[19]
def cleanup():
    killed = []
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        children = pathlib.Path('/proc/self/task/%s/children'%os.getpid()).read_text().split()
        for value in children:
            pid = int(value)
            try:
                before = pin(pid)
                fd = os.pidfd_open(pid)
                try:
                    assert pin(pid) == before
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                    killed.append({'pid': pid, 'startTicks': before})
                finally: os.close(fd)
            except (FileNotFoundError, ProcessLookupError): pass
        try:
            while os.waitpid(-1, os.WNOHANG)[0]: pass
        except ChildProcessError: return killed
        time.sleep(.01)
    raise RuntimeError('owned_children_remain')
def wait_worker(child):
    deadline = time.monotonic() + (4 if mode == 'timeout' else 65)
    while cancel_signal is None and time.monotonic() < deadline:
        try:
            result['workerExit'] = child.wait(timeout=.1)
            return
        except subprocess.TimeoutExpired: pass
    result['timedOut'] = cancel_signal is None
result = {'allChildrenReaped': False, 'timedOut': False, 'guardianPid': os.getpid()}
try:
    with open(root+'/worker.stdout', 'w') as out, open(root+'/worker.stderr', 'w') as err:
        child = subprocess.Popen(['/usr/bin/node', worker, '--worker', root, mode], cwd=root, env=dict(os.environ), stdout=out, stderr=err)
        result['worker'] = {'pid': child.pid, 'startTicks': pin(child.pid)}
        wait_worker(child)
finally:
    result['terminated'] = cleanup()
    result['allChildrenReaped'] = True
    sockets = [line for line in pathlib.Path('/proc/net/unix').read_text().splitlines() if root+'/' in line]
    assert not sockets, 'owned_kernel_sockets_remain'
    result['kernelSocketsAbsent'] = True
    for name in ['rpc.sock', 'pub.sock']:
        filename = pathlib.Path(root+'/home/.pm2') / name
        if filename.exists(): filename.unlink()
    result['socketPathsAbsent'] = True
    result['cancelSignal'] = cancel_signal
    pathlib.Path(root+'/guardian.json').write_text(json.dumps(result))
`;

const SERVICE = String.raw`
const fs = require('node:fs'), http = require('node:http');
const name = process.env.FIXTURE_NAME;
if (process.env.FIXTURE_FAIL === 'yes') process.exit(37);
const server = http.createServer((req,res) => res.end(JSON.stringify({name,pid:process.pid})));
server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(process.env.FIXTURE_READY, JSON.stringify({pid:process.pid,port:server.address().port,name}));
});
process.on('SIGINT', () => {
    fs.writeFileSync(process.env.FIXTURE_SIGNAL, JSON.stringify({pid:process.pid,at:Date.now()}));
    if (process.env.FIXTURE_STUBBORN !== 'yes') server.close(() => process.exit(0));
});
`;

async function until(check, label, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await delay(25);
    }
    throw new Error(`fixture_timeout:${label}`);
}

function cli(root, args) {
    validatePrivateHome(root, process.env.PM2_HOME);
    const result = spawnSync(NODE, [path.join(PM2, 'bin/pm2'), ...args], {
        cwd: root, env: environment(root), timeout: 8000, encoding: 'utf8', maxBuffer: 2 ** 20,
    });
    assert.equal(result.error, undefined, `private CLI failed: ${result.error}`);
    assert.equal(result.status, 0, `private CLI ${args[0]}: ${result.stderr}`);
    return result.stdout;
}

async function daemon(root) {
    const child = spawn(NODE, [path.join(PM2, 'lib/Daemon.js'), 'fixture-padding-' + 'x'.repeat(160)], {
        cwd: root, env: environment(root), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('daemon_readiness_timeout')), 5000);
        child.once('error', reject);
        child.once('exit', () => { clearTimeout(timer); reject(Error('daemon_early_exit')); });
        child.once('message', message => {
            clearTimeout(timer);
            try { assert.equal(message.online, true); assert.equal(message.pid, child.pid); resolve(); }
            catch (error) { reject(error); }
        });
    });
    child.disconnect();
    return child;
}

function peers(root) {
    const source = 'import socket,struct,json,sys\nr=[]\nfor p in sys.argv[1:]:\n s=socket.socket(socket.AF_UNIX);s.connect(p);r.append(struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[0]);s.close()\nprint(json.dumps(r))';
    const result = spawnSync(PYTHON, ['-I', '-S', '-c', source,
        path.join(process.env.PM2_HOME, 'rpc.sock'), path.join(process.env.PM2_HOME, 'pub.sock')], {
        env: environment(root), encoding: 'utf8', timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

function definitions(root, failing = false) {
    return RECONCILIATION_SERVICES.map((name, index) => ({
        name, script: path.join(root, 'service.cjs'), cwd: root, interpreter: NODE,
        watch: false, autorestart: false, kill_timeout: 180, treekill: false,
        env: { FIXTURE_NAME: name, FIXTURE_READY: path.join(root, `${name}.ready`),
            FIXTURE_SIGNAL: path.join(root, `${name}.signal`), FIXTURE_STUBBORN: index === 0 ? 'yes' : 'no',
            FIXTURE_FAIL: failing && index === 5 ? 'yes' : 'no' },
    }));
}

async function healthy(root, names) {
    const entries = await Promise.all(names.map(async name => {
        const filename = path.join(root, `${name}.ready`);
        await until(() => fs.existsSync(filename), name);
        const ready = json(filename);
        const response = await fetch(`http://127.0.0.1:${ready.port}`, { signal: AbortSignal.timeout(1500) });
        assert.deepEqual(await response.json(), { name, pid: ready.pid });
        return { ...ready, identity: identity(ready.pid) };
    }));
    assert.equal(new Set(entries.map(entry => entry.port)).size, names.length);
    return entries;
}

async function stopDaemon(child) {
    const before = identity(child.pid);
    assert.equal(before.parentPid, process.pid);
    const started = Date.now();
    child.kill('SIGTERM');
    await until(() => child.exitCode !== null || child.signalCode !== null, 'daemon_stop');
    return { ...before, elapsedMs: Date.now() - started, exitCode: child.exitCode, signal: child.signalCode };
}

async function splitAndStopDuplicate(root, dump) {
    // Explicit fault injection, not a claim about how the production incident began.
    for (const name of ['rpc.sock', 'pub.sock', 'pm2.pid']) fs.unlinkSync(path.join(process.env.PM2_HOME, name));
    const duplicate = await daemon(root);
    assert.deepEqual(peers(root), [duplicate.pid, duplicate.pid]);
    assert.equal(Number(fs.readFileSync(path.join(process.env.PM2_HOME, 'pm2.pid'))), duplicate.pid);
    await healthy(root, RECONCILIATION_SERVICES);
    const isolated = { ...definitions(root)[1], name: 'duplicate-synthetic', env: {
        FIXTURE_NAME: 'duplicate-synthetic', FIXTURE_READY: path.join(root, 'duplicate-synthetic.ready'),
        FIXTURE_SIGNAL: path.join(root, 'duplicate-synthetic.signal'),
    } };
    const duplicateConfig = path.join(root, 'duplicate.json');
    write(duplicateConfig, { apps: [isolated] });
    cli(root, ['start', duplicateConfig]);
    const duplicateServices = await healthy(root, ['duplicate-synthetic']);
    const duplicateStop = await stopDaemon(duplicate);
    const overwritten = json(dump);
    assert.deepEqual(overwritten.map(entry => entry.name), ['duplicate-synthetic']);
    await healthy(root, RECONCILIATION_SERVICES);
    return { duplicate: duplicate.pid, duplicateStop, duplicateServices,
        duplicateStopDumpNames: overwritten.map(entry => entry.name) };
}

async function partialStart(root) {
    // Fresh synthetic start intentionally fails one service: a successful CLI is not health proof.
    for (const name of RECONCILIATION_SERVICES) fs.unlinkSync(path.join(root, `${name}.ready`));
    const replacement = await daemon(root);
    const partialConfig = path.join(root, 'partial.json');
    write(partialConfig, { apps: definitions(root, true) });
    cli(root, ['start', partialConfig]);
    const partialHealthy = await healthy(root, RECONCILIATION_SERVICES.slice(0, 5));
    await until(() => JSON.parse(cli(root, ['jlist'])).some(row => row.name === 'nassaj-dev'
        && row.pm2_env.status === 'stopped'), 'partial_start');
    await stopDaemon(replacement);
    return { requested: 6, healthy: partialHealthy.length, failed: 'nassaj-dev' };
}

async function scenario(root, mode) {
    validatePrivateHome(root, process.env.PM2_HOME);
    assert.deepEqual(fs.readdirSync(process.env.PM2_HOME), []);
    fs.writeFileSync(path.join(root, 'service.cjs'), SERVICE, { mode: 0o600, flag: 'wx' });
    const original = await daemon(root);
    if (mode === 'timeout') await new Promise(() => {});
    if (mode === 'after-start-failure') throw Error('injected_worker_failure');
    const config = path.join(root, 'ecosystem.json');
    write(config, { apps: definitions(root) });
    cli(root, ['start', config]);
    const services = await healthy(root, RECONCILIATION_SERVICES);
    assert.ok(services.every(service => service.identity.parentPid === original.pid));
    if (mode === 'external-timeout') {
        write(path.join(root, 'external-timeout-ready.json'), { daemon: identity(original.pid), services });
        await new Promise(() => {});
    }
    assert.deepEqual(peers(root), [original.pid, original.pid]);
    cli(root, ['save']);
    const dump = path.join(process.env.PM2_HOME, 'dump.pm2');
    const originalDump = fs.readFileSync(dump);
    assert.equal(JSON.parse(originalDump).length, 6);
    const split = await splitAndStopDuplicate(root, dump);
    const originalStop = await stopDaemon(original);
    assert.ok(originalStop.elapsedMs >= 180, 'stop completed before configured timeout');
    assert.ok(fs.existsSync(path.join(root, `${RECONCILIATION_SERVICES[0]}.signal`)));
    assert.equal(json(dump).length, 6);
    for (const entry of [...services, ...split.duplicateServices]) {
        assert.ok(!fs.existsSync(`/proc/${entry.pid}`), 'stopped app still exists');
    }
    const partial = await partialStart(root);
    return { schema: 'nassaj-private-pm2-reconciliation-lab/v1', contractCommit: '24fc2b6ca',
        scope: 'synthetic-behavior-only-not-host-reconciliation-qualification',
        pm2Version: json(path.join(PM2, 'package.json')).version, services, original: original.pid,
        duplicate: split.duplicate, peerMovedToDuplicate: true, originalRemainedHealthy: true,
        faultInjection: 'unlink-private-control-paths-then-explicit-second-daemon',
        originalDumpSha256: sha(originalDump), duplicateStopDumpNames: split.duplicateStopDumpNames,
        duplicateStop: split.duplicateStop, originalStop, partialStart: partial,
        contractImplications: ['DUPLICATE_STOP_INTENT: signal can overwrite dump',
            'ALL_STOPPED: observe descendants and listeners, not just daemon exit',
            'VERIFYING: successful start command does not imply VERIFIED'] };
}

/** Run one bounded private lab and return evidence only after guardian cleanup and sentinel verification. */
export function runPrivatePm2Fixture(mode = 'complete') {
    assert.ok(['complete', 'after-start-failure', 'timeout', 'external-timeout'].includes(mode));
    assert.notEqual(process.getuid(), 0, 'root is not supported');
    for (const filename of [NODE, PYTHON, path.join(PM2, 'lib/Daemon.js'), path.join(PM2, 'bin/pm2')]) {
        const stat = fs.statSync(filename);
        assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o022, 0);
    }
    const before = sentinel();
    const root = fs.mkdtempSync('/var/tmp/pm2-rec-');
    for (const relative of ['home', 'home/.pm2', 'tmp']) fs.mkdirSync(path.join(root, relative), { mode: 0o700 });
    validatePrivateHome(root, path.join(root, 'home/.pm2'));
    const child = spawnSync(PYTHON, ['-I', '-S', '-B', '-c', GUARDIAN, root, SELF, mode], {
        cwd: root, env: environment(root), encoding: 'utf8',
        timeout: mode === 'external-timeout' ? 2500 : 80000, killSignal: 'SIGTERM', maxBuffer: 2 ** 20,
    });
    // On guardian failure preserve the exact directory; never delete unknown live owners.
    assert.equal(child.status, 0, `guardian failed; preserved ${root}: ${child.stderr}`);
    const guardian = json(path.join(root, 'guardian.json'));
    assert.equal(guardian.allChildrenReaped, true);
    assert.equal(guardian.kernelSocketsAbsent, true);
    assert.equal(guardian.socketPathsAbsent, true);
    assert.ok(!fs.existsSync(`/proc/${guardian.guardianPid}`), 'guardian still exists');
    assert.ok(!fs.existsSync(`/proc/${guardian.worker.pid}`), 'worker still exists');
    assert.deepEqual(sentinel(), before, `host sentinel changed; preserved ${root}`);
    const cancellation = mode === 'external-timeout' ? verifyExternalCancellation(root, child, guardian) : null;
    const evidence = mode === 'complete' && guardian.workerExit === 0 ? json(path.join(root, 'evidence.json')) : null;
    const error = fs.readFileSync(path.join(root, 'worker.stderr'), 'utf8');
    assert.ok(mode !== 'complete' || evidence, `worker failed; preserved ${root}: ${error}`);
    fs.rmSync(root, { recursive: true });
    return { mode, evidence, guardian, cancellation,
        hostSentinelUnchanged: true, temporaryDirectoryRemoved: !fs.existsSync(root) };
}

function verifyExternalCancellation(root, child, guardian) {
    assert.equal(child.error?.code, 'ETIMEDOUT');
    assert.equal(guardian.cancelSignal, 15);
    assert.equal(guardian.timedOut, false, 'internal timeout cannot substitute for external cancellation');
    const ready = json(path.join(root, 'external-timeout-ready.json'));
    assert.equal(ready.services.length, 6);
    for (const entry of [ready.daemon, ...ready.services]) {
        assert.ok(!fs.existsSync(`/proc/${entry.pid}`), `private descendant remains: ${entry.pid}`);
    }
    return { externalTimeout: true, guardianExited: true, workerExited: true,
        daemonExited: true, servicesExited: ready.services.length };
}

if (process.argv[1] === SELF && process.argv[2] === '--worker') {
    try { write(path.join(process.argv[3], 'evidence.json'), await scenario(process.argv[3], process.argv[4])); }
    catch (error) { console.error(error); process.exitCode = 1; }
    // The guardian is responsible for reaping children even if the worker fails mid-scenario.
    process.exit(process.exitCode || 0);
}
