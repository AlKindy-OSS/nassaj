/** Test-only root credential/host-metadata seam for the isolated facade process tree. */
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const mapFile = new URL('./facade-map.json', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
if (fixture.tlsCaFile) tls.setDefaultCACertificates([fs.readFileSync(fixture.tlsCaFile, 'utf8')]);
const fixed = '/etc/nassaj/release-runtime-host.json';
const original = { lstat: fs.lstatSync, fstat: fs.fstatSync, open: fs.openSync,
    fsync: fs.fsyncSync, realpath: fs.realpathSync, read: fs.readFileSync, readdir: fs.readdirSync, stat: fs.statSync };
const uid = process.getuid(), gid = process.getgid();
const groups = [...new Set(process.getgroups())].sort((a, b) => a - b); let dropped = false;
const operatorRoot = '/usr/local/lib/nassaj-release-operator';
const inodes = new Set(); const map = file => file === fixed ? fixture.configFile : file === '/etc/nassaj' ? fixture.control
    : file === '/etc/nassaj/release-host-support-attestation.json' ? `${fixture.control}/release-host-support-attestation.json`
    : file === '/etc/nassaj/startup-admission-client.json' ? `${fixture.control}/descriptor.json`
    : fixture.installedOperatorRoot && typeof file === 'string' && (file === operatorRoot || file.startsWith(`${operatorRoot}/`))
        ? `${fixture.installedOperatorRoot}${file.slice(operatorRoot.length)}` : file;
fs.lstatSync = (file, ...args) => {
    const value = original.lstat(map(file), ...args);
    if (!String(file).startsWith(fixture.databaseRoot)) {
        value.uid = typeof value.uid === 'bigint' ? 0n : 0;
        if (value.isDirectory()) value.mode = typeof value.mode === 'bigint' ? value.mode & ~18n : value.mode & ~18;
        inodes.add(String(value.ino));
    }
    return value;
};
fs.fstatSync = (...args) => {
    const value = original.fstat(...args); let file = '';
    try { file = fs.readlinkSync(`/proc/self/fd/${args[0]}`); } catch {}
    if (inodes.has(String(value.ino)) || (file.startsWith('/') && !file.startsWith(fixture.databaseRoot)))
        value.uid = typeof value.uid === 'bigint' ? 0n : 0;
    return value;
};
fs.openSync = (file, ...args) => original.open(map(file), ...args);
fs.realpathSync = (file, ...args) => map(file) !== file ? (original.realpath(map(file), ...args), file) : original.realpath(file, ...args);
fs.readFileSync = (file, ...args) => {
    const value = original.read(map(file), ...args); const match = typeof file === 'string' && /^\/proc\/(self|\d+)\/status$/.exec(file);
    if (!match) return value;
    let text = value.toString().replace(/^Groups:.*$/m, 'Groups:\t' + groups.join(' '));
    const pid = match[1] === 'self' ? process.pid : Number(match[1]);
    let argv = []; try { argv = original.read(`/proc/${pid}/cmdline`).toString().split('\0'); } catch {}
    // Only the actual operator facade, never its service worker or target, is mapped to root.
    if (argv[1] === fixture.parent && !argv.includes('--supervisor-child')) text = text.replace(/^Uid:.*$/m, 'Uid:\t0\t0\t0\t0');
    return Buffer.isBuffer(value) ? Buffer.from(text) : text;
};
// Crash seam only after the production directory fsync has completed its migration result.
fs.fsyncSync = fd => {
    const result = original.fsync(fd);
    if (fixture.crashPhase && process.argv[1] === fixture.parent && process.argv.length === 2) {
        let current; try { current = JSON.parse(original.read(`${fixture.control}/first-cutover.json`)); } catch {}
        if (current?.phase === fixture.crashPhase && fs.readlinkSync(`/proc/self/fd/${fd}`) === fixture.control)
            process.kill(process.pid, 'SIGKILL');
    }
    return result;
};
// PID 1 is the isolation launcher, created before the fixture DB and unable to own its handle.
// Foreign processes on a shared host are equally outside this fixture's view: their FD tables are
// unreadable, and a 0700 fixture database owned by this user cannot be held by them. Restrict the
// scan to the processes the fixture can actually observe; every one of those stays real.
const inspectable = pid => {
    let descriptors;
    try { descriptors = original.readdir(`/proc/${pid}/fd`); } catch (error) { return error.code === 'ENOENT'; }
    for (const descriptor of descriptors) {
        try { original.stat(`/proc/${pid}/fd/${descriptor}`); }
        catch (error) { if (error.code !== 'ENOENT') return false; }
    }
    return true;
};
fs.readdirSync = (directory, ...args) => {
    const result = original.readdir(directory, ...args);
    if (directory !== '/proc') return result;
    return result.filter(value => /^\d+$/.test(value) ? value !== '1' && inspectable(value) : true);
};
process.getuid = () => dropped ? uid : 0; process.geteuid = () => dropped ? uid : 0;
process.setgroups = value => { if (JSON.stringify(value) !== JSON.stringify(groups)) throw Error('fixture groups'); };
process.setgid = value => { if (value !== gid) throw Error('fixture gid'); };
process.setuid = value => { if (value !== uid) throw Error('fixture uid'); dropped = true; };
const connect = net.createConnection;
net.createConnection = (options, ...args) => options?.path === fixture.pm2SocketLocator
    ? connect({ host: '127.0.0.1', port: fixture.pm2Port }, ...args) : connect(options, ...args);
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, ...args) => execFileSync(file === '/usr/bin/systemctl' && fixture.systemctl ? fixture.systemctl : file, ...args);
// The producer pins systemctl itself; only this fixture's fixed unit transport is substituted.
const execFile = childProcess.execFile;
childProcess.execFile = (file, ...args) => {
    if (Array.isArray(args[0])) args[0] = args[0].map(value => typeof value === 'string' && value.startsWith(`${operatorRoot}/`) ? map(value) : value);
    return execFile(file === '/usr/bin/systemctl' && fixture.systemctl ? fixture.systemctl : file, ...args);
};
// Observe the selected real helper; startup/PM2 work is outside its acquisition interval.
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = (file, ...args) => {
    const selectedParent = fixture.contentionStage === 'target_verified' && process.argv[1] === fixture.parent
        && globalThis.fixtureContentionWaiter === 'target_verified';
    const observed = file === '/usr/bin/flock' && (selectedParent
        || (fixture.contentionStage === 'gate' && process.argv[2] === 'openFirstForwardGate'));
    if (!observed) return spawnSync(file, ...args);
    if (JSON.stringify(args[0]) !== JSON.stringify(['-x', '-w', '2', '-E', '75', '3'])) throw Error('fixture_unexpected_flock');
    const beforeDelay = process.hrtime.bigint();
    if (selectedParent) {
        delete globalThis.fixtureContentionWaiter;
        // Deterministic scheduling latency before the real helper starts, never an acquisition-time override.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, fixture.contentionWaiterDelayMs);
    }
    const started = process.hrtime.bigint(); let result;
    try { result = spawnSync(file, ...args); return result; }
    finally {
        const done = `${fixture.contentionEvidence}.waiter-done`;
        fs.writeFileSync(`${done}.partial`, JSON.stringify({ pid: process.pid, beforeDelayNs: String(beforeDelay), startedNs: String(started),
            finishedNs: String(process.hrtime.bigint()), status: result?.status, signal: result?.signal, error: result?.error?.code,
        }), { mode: 0o600 });
        fs.renameSync(`${done}.partial`, done);
    }
};
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => { const child = spawn(...args); child.stderr?.on('data', bytes => fs.appendFileSync(fixture.childDiagnostics, bytes)); return child; };
syncBuiltinESMExports();
