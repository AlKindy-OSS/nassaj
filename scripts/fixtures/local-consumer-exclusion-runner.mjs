/** Isolated user-unit filesystem probe. No live unit, database or publisher is touched. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(import.meta.dirname, '../..');
const sourceUnit = path.join(project, 'scripts/systemd/nassaj-preview-oid-consumer.service');

function probeInside(config) {
    if (config.unitName && config.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.delayMs);
    const denied = file => {
        const attempts = {};
        for (const [name, flags] of [['read', 'r'], ['write', 'r+']]) {
            try { const fd = fs.openSync(file, flags); fs.closeSync(fd); attempts[name] = 'ACCESSIBLE'; }
            catch (error) { attempts[name] = error.code; }
        }
        return attempts;
    };
    const direct = Object.fromEntries(config.names.map(name => [name, denied(path.join(config.appdata, name))]));
    const aliases = { symlink: denied(path.join(config.alias, 'app.db')),
        parentProcRoot: denied(`/proc/${config.parentPid}/root${config.appdata}/app.db`),
        parentProcFd: denied(`/proc/${config.parentPid}/fd/${config.parentFd}`) };
    let futureCreate;
    try { const fd = fs.openSync(path.join(config.appdata, 'future-created-sidecar'), 'wx', 0o600); fs.closeSync(fd); futureCreate = 'ACCESSIBLE'; }
    catch (error) { futureCreate = error.code; }
    const writable = {};
    for (const name of ['cache', 'build']) {
        const file = path.join(config.directory, name, 'write-proof'); fs.writeFileSync(file, 'private-fixture', { mode: 0o600 });
        writable[name] = fs.readFileSync(file, 'utf8') === 'private-fixture';
    }
    const effective = config.unitName ? spawnSync('systemctl', ['--user', 'show', config.unitName,
        ...['InaccessiblePaths', 'ReadWritePaths', 'BindPaths', 'BindReadOnlyPaths', 'ProtectHome', 'ProtectSystem', 'NoNewPrivileges', 'InvocationID', 'ControlGroup'].map(key => `--property=${key}`)],
        { encoding: 'utf8', timeout: 5000 }) : null;
    process.stdout.write(`${JSON.stringify({ effectiveUnit: effective ? { status: effective.status, properties: effective.stdout, error: effective.stderr } : null, direct, aliases, futureCreate, writable, process: { pid: process.pid, uid: process.getuid(),
        invocationId: process.env.INVOCATION_ID || null, cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8').trim(),
        mountNamespace: fs.readlinkSync('/proc/self/ns/mnt') } })}\n`);
}

function serviceProperties(directory, appdata) {
    let service = false;
    const properties = [];
    for (const line of fs.readFileSync(sourceUnit, 'utf8').split('\n')) {
        if (line.startsWith('[')) { service = line === '[Service]'; continue; }
        if (!service || !line || line.startsWith('#')) continue;
        const [key] = line.split('=');
        if (['Type', 'ExecStart', 'WorkingDirectory', 'ReadOnlyPaths', 'Environment', 'Restart', 'TimeoutStopSec'].includes(key)) continue;
        properties.push(line.replaceAll('%h/Project/nassaj-dev', directory));
    }
    // Source read-only restrictions remain in force for their fixture equivalents.
    const readOnly = ['src', 'public', 'docs', 'shared', 'server', 'scripts', 'node_modules', 'package.json', 'package-lock.json'];
    properties.push(`WorkingDirectory=${directory}`, 'Restart=no', 'TimeoutStartSec=5s', 'TimeoutStopSec=2s', 'Environment=NODE_ENV=production TMPDIR=/var/tmp',
        `ReadOnlyPaths=${readOnly.map(name => `-${directory}/${name}`).join(' ')}`, `InaccessiblePaths=${appdata}`);
    return properties;
}

function unitObservation(unitName) {
    const show = spawnSync('systemctl', ['--user', 'show', unitName,
        ...['LoadState', 'ActiveState', 'MainPID', 'ControlGroup', 'Transient', 'WorkingDirectory', 'Description'].map(key => `--property=${key}`)],
    { encoding: 'utf8', timeout: 5000 });
    const row = Object.fromEntries(show.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (show.error || ![0, 4].includes(show.status) || !row.LoadState) throw Error('exclusion_probe_cleanup_unknown');
    const jobs = spawnSync('systemctl', ['--user', 'list-jobs', '--output=json'], { encoding: 'utf8', timeout: 5000 });
    if (jobs.status !== 0) throw Error('exclusion_probe_cleanup_jobs_unknown');
    return { ...row, pendingJobs: JSON.parse(jobs.stdout.trim() || '[]').filter(job => job.unit === `${unitName}.service`).length };
}

function cgroupEmpty(group) {
    if (!group) return true;
    if (!/^\/[A-Za-z0-9/_.:@-]+$/.test(group) || path.posix.normalize(group) !== group) throw Error('exclusion_probe_cleanup_cgroup_unknown');
    const directory = path.join('/sys/fs/cgroup', group);
    if (!fs.existsSync(directory)) return true;
    if (fs.readFileSync(path.join(directory, 'cgroup.procs'), 'utf8').trim()) return false;
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).every(entry => cgroupEmpty(`${group}/${entry.name}`));
}

function cleanupOwnedUnit(ownership) {
    const { unitName, directory, description } = ownership;
    let row = unitObservation(unitName), stopRequested = false;
    const group = row.ControlGroup;
    if (row.LoadState !== 'not-found') {
        if (row.Transient !== 'yes' || row.WorkingDirectory !== directory || row.Description !== description) throw Error('exclusion_probe_cleanup_owner_mismatch');
        if (!['inactive', 'failed'].includes(row.ActiveState) || row.MainPID !== '0' || row.pendingJobs || !cgroupEmpty(group)) {
            const stop = spawnSync('systemctl', ['--user', 'stop', unitName], { encoding: 'utf8', timeout: 5000 });
            stopRequested = true;
            if (stop.status !== 0) throw Error('exclusion_probe_cleanup_stop_unknown');
        }
        row = unitObservation(unitName);
    }
    if (!['inactive', 'failed'].includes(row.ActiveState) || row.MainPID !== '0' || row.pendingJobs
        || !cgroupEmpty(group) || !cgroupEmpty(row.ControlGroup)) throw Error('exclusion_probe_cleanup_not_quiescent');
    return { unitName, stopRequested, verifiedQuiescent: true, observation: row };
}

/** Run only against generated fixture data and report both successful exclusions and residual routes. */
export function runConsumerExclusionProbe({ delayMs = 0, clientTimeoutMs = 20000, runtimeMaxSec = 10 } = {}) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 10000 || !Number.isSafeInteger(clientTimeoutMs)
        || clientTimeoutMs < 100 || clientTimeoutMs > 20000 || !Number.isSafeInteger(runtimeMaxSec)
        || runtimeMaxSec < 1 || runtimeMaxSec > 10) throw Error('exclusion_probe_limits_invalid');
    const directory = fs.mkdtempSync(path.join(project, '.artifacts/consumer-exclusion-os-'));
    const appdata = path.join(directory, 'appdata'), alias = path.join(directory, 'alias');
    const names = ['app.db', 'app.db-wal', 'app.db-shm', 'future-sidecar'];
    let fd, ownership, report;
    try {
        for (const name of ['appdata', 'cache', 'build']) fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
        for (const name of names) fs.writeFileSync(path.join(appdata, name), 'isolated-fixture', { mode: 0o600 });
        fs.symlinkSync(appdata, alias); fd = fs.openSync(path.join(appdata, 'app.db'), 'r');
        const config = { directory, appdata, alias, names, parentPid: process.pid, parentFd: fd };
        const outside = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--inside', JSON.stringify(config)],
            { cwd: directory, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
        if (outside.status !== 0) throw new Error('exclusion_probe_positive_control_failed');
        const outsideUnit = JSON.parse(outside.stdout.trim());
        const properties = serviceProperties(directory, appdata);
        const unitName = `nassaj-consumer-exclusion-${process.pid}-${randomUUID()}`;
        ownership = { unitName, directory, description: `Nassaj consumer exclusion fixture ${unitName}` };
        properties.push(`RuntimeMaxSec=${runtimeMaxSec}s`, `Description=${ownership.description}`);
        fs.writeFileSync(path.join(directory, 'unit-owner.json'), JSON.stringify(ownership), { mode: 0o600, flag: 'wx' });
        config.delayMs = delayMs;
        config.unitName = unitName;
        const result = spawnSync('systemd-run', ['--user', '--quiet', '--wait', '--pipe', '--collect', '--service-type=exec',
            `--unit=${unitName}`, ...properties.flatMap(value => ['--property', value]),
            process.execPath, fileURLToPath(import.meta.url), '--inside', JSON.stringify(config)],
        { cwd: directory, encoding: 'utf8', timeout: clientTimeoutMs, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
        let observations = null;
        try { observations = JSON.parse(result.stdout.trim()); } catch { /* Failed namespace setup is not a passing probe. */ }
        report = { schema: 'nassaj-consumer-exclusion-probe/v1', unitName,
            sourceUnitSha256: createHash('sha256').update(fs.readFileSync(sourceUnit)).digest('hex'), nodeVersion: process.version,
            exitCode: result.status, outsideUnit, observations,
            setupError: result.error?.code || null, stderr: result.stderr.trim(), properties,
            fixtureUnchanged: names.every(name => fs.readFileSync(path.join(appdata, name), 'utf8') === 'isolated-fixture'),
            proofScope: 'Disposable user unit with reviewed service restrictions and fixture paths. No retained builder or real cache install executed.',
            inheritedFdBoundary: 'systemd-run receives pipe stdio only; no application-data descriptors are passed to the service. Arbitrary pre-opened descriptor transfer is not qualified.' };
        return report;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        // Preserve fixture evidence if systemd outcome, ownership or cgroup quiescence cannot be established.
        const cleanup = ownership ? cleanupOwnedUnit(ownership) : { verifiedQuiescent: true, unitNotCreated: true };
        fs.rmSync(directory, { recursive: true, force: true });
        if (report) report.cleanup = { ...cleanup, fixtureRemoved: true };
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] === '--inside') probeInside(JSON.parse(process.argv[3]));
    else if (process.argv[2] === '--run') process.stdout.write(`${JSON.stringify(runConsumerExclusionProbe(), null, 2)}\n`);
    else throw new Error('Explicit --run is required for the isolated unit probe.');
}
