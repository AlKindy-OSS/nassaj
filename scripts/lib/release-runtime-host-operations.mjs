import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
    chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
    readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import { databaseSchemaDigest } from './release-database-backup.mjs';
import { captureDatabasePreservation, verifyDatabasePreservation } from './release-database-preservation.mjs';
import { handleBootstrapStartupAdmission } from './release-runtime-startup-admission.mjs';
import { invalidateCutoverStartupAdmission, withCutoverStateLock } from './release-runtime-cutover.mjs';
import { readVerifiedManagedRestart, readManagedRootFile, verifyManagedRestartApproval } from './release-runtime-managed-admission.mjs';
import { inspectForwardChildIdentity } from './release-runtime-forward-child-protocol.mjs';
import { observeBoundTargetHealth } from './release-runtime-forward-receipts.mjs';
import { listenerBoundary, ingressManager, ingressShowArgs, readRoutingEvidence, observeOriginListener, buildListenerFenceRules } from './release-runtime-listener-boundary.mjs';

const OPERATIONS = new Set(['inspect', 'blockIngress', 'fenceAdmission', 'verifyZeroWork', 'freezeOldWriters',
    'verifyWritersFrozen', 'finalVacuumAndBackup', 'switchSupervisorToLauncher', 'verifyPrivateTarget', 'openIngress',
    'verifyPublicTarget', 'restoreDatabaseFromBackup', 'restoreOldSupervisor', 'resumeOldWriters', 'verifyOldHealth',
    'restoreIngress']);
const HEX64 = /^[a-f0-9]{64}$/;
const REQUEST_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const UNIT = /^[A-Za-z0-9_.@-]+\.service$/;
const MAINTENANCE = Object.freeze({ nonce: 'nassaj-maintenance-v1', port: 3311, retryAfterSeconds: 30 });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function boundedExec(file, args, options = {}) {
    if (!path.isAbsolute(file) || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
        throw new Error('host_operation_command_invalid');
    }
    try {
        return execFileSync(file, args, { encoding: 'utf8', timeout: options.timeout || 120_000,
            maxBuffer: 65_536, input: options.input, env: options.env || { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' } });
    } catch { throw new Error('host_operation_command_failed'); }
}
function verifyPinnedExecutable(file, expectedSha256, deps = {}) {
    if (deps.verifyPinnedExecutable) return deps.verifyPinnedExecutable(file, expectedSha256);
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0
        || !HEX64.test(expectedSha256 || '') || sha(readFileSync(file)) !== expectedSha256) {
        throw new Error('host_operation_executable_identity_invalid');
    }
    for (let ancestor = path.dirname(file); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
        const parent = lstatSync(ancestor);
        if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) {
            throw new Error('host_operation_executable_owner_invalid');
        }
    }
}
function emptyConntrackDeletion(error) {
    return error?.status === 1 && !error.signal && !error.code && String(error.stdout ?? '') === ''
        && /^conntrack v[0-9]+\.[0-9]+\.[0-9]+ \(conntrack-tools\): 0 flow entries have been deleted\.\n?$/.test(String(error.stderr ?? ''));
}
function runPinnedExecutable(file, expectedSha256, args, deps, options = {}) {
    if (deps.exec) { verifyPinnedExecutable(file, expectedSha256, deps); return deps.exec(file, args, options); }
    verifyPinnedExecutable(file, expectedSha256, deps);
    const before = lstatSync(file); const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino || sha(readFileSync(fd)) !== expectedSha256) {
            throw new Error('host_operation_executable_identity_invalid');
        }
        const inheritedFds = options.inheritedFds || []; const executableChildFd = 3 + inheritedFds.length;
        return execFileSync(`/proc/self/fd/${executableChildFd}`, args, { encoding: 'utf8', timeout: options.timeout || 120_000,
            maxBuffer: 65_536, input: options.input, env: options.env || { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' },
            stdio: ['pipe', 'pipe', 'pipe', ...inheritedFds, fd], uid: options.uid, gid: options.gid });
    } catch (error) {
        if (options.allowEmptyConntrackDeletion === true && emptyConntrackDeletion(error)) return '';
        throw new Error('host_operation_command_failed');
    }
    finally { closeSync(fd); }
}
function syncDirectory(directory) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function atomicJson(file, value) {
    const temporary = `${file}.partial-${process.pid}`; writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file); syncDirectory(path.dirname(file));
}
function privateControl(directory) {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error('host_control_unsafe');
    return directory;
}
function readState(config) {
    const directory = privateControl(config.controlRoot); const file = path.join(directory, 'host-dispatch-state.json');
    const present = existsSync(file);
    let value = { schema: 'nassaj-host-dispatch-state/v1', operations: {}, ingress: null, frozen: false, supervisorSwitched: false };
    if (present) {
        const before = lstatSync(file); const owner = lstatSync(directory).uid;
        if (!before.isFile() || before.isSymbolicLink() || before.uid !== owner || (before.mode & 0o777) !== 0o600) {
            throw new Error('host_dispatch_state_unsafe');
        }
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const opened = fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('host_dispatch_state_changed');
            value = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
        if (value?.schema !== 'nassaj-host-dispatch-state/v1') throw new Error('host_dispatch_state_invalid');
    }
    return { file, value, present };
}
function readControlJson(file, expectedOwner) {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedOwner || (before.mode & 0o777) !== 0o600) {
        throw new Error('host_control_record_unsafe');
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const opened = fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('host_control_record_changed');
        return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
}
function cutoverIdentitySeal(expected) {
    const keys = ['nodeInstanceId', 'hostIdentitySha256', 'releaseIdentitySha256', 'migrationIdentitySha256',
        'pm2SnapshotSha256', 'databaseContractSha256', 'assetSha256'];
    return sha(Buffer.from(JSON.stringify(keys.map((key) => [key, expected?.[key]]))));
}
function processIdentity(pid) {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ');
    return { pid, state: fields[0], pgid: Number(fields[2]), sid: Number(fields[3]), startTime: fields[19] };
}

function readClaimProcess(pid) {
    const before = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = before.slice(before.lastIndexOf(')') + 2).trim().split(' ');
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
    const executable = realpathSync(`/proc/${pid}/exe`);
    const after = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterFields = after.slice(after.lastIndexOf(')') + 2).trim().split(' ');
    if (!match || fields[19] !== afterFields[19] || fields[1] !== afterFields[1]) {
        throw new Error('bootstrap_claim_process_changed');
    }
    return { pid, parentPid: Number(fields[1]), startTicks: fields[19],
        uids: match.slice(1).map(Number), executable };
}

/** Derive the invoking ancestor from the kernel, never from SUDO_* or request PID claims. */
export function observeBootstrapClaimCaller(config, deps = {}) {
    const policy = config.bootstrapClaim;
    if ((deps.effectiveUid ? deps.effectiveUid() : process.geteuid?.()) !== 0
        || !Number.isSafeInteger(policy?.applicationUid) || policy.applicationUid <= 0) {
        throw new Error('bootstrap_claim_root_required');
    }
    verifyPinnedExecutable(policy.sudoExecutable, policy.sudoSha256, deps);
    verifyPinnedExecutable(policy.nodeExecutable, policy.nodeSha256, deps);
    const inspect = deps.readClaimProcess || readClaimProcess;
    const boot = deps.readBootId || (() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
    const walk = () => {
        const records = []; let pid = deps.parentPid ?? process.ppid;
        for (let index = 0; index < 4; index += 1) {
            const record = inspect(pid); records.push(record);
            if (record.uids.every((uid) => uid === policy.applicationUid)
                && record.executable === policy.nodeExecutable && index > 0) return records;
            if (record.executable !== policy.sudoExecutable || record.uids[1] !== 0
                || !Number.isSafeInteger(record.parentPid) || record.parentPid <= 0) {
                throw new Error('bootstrap_claim_sudo_ancestry_invalid');
            }
            pid = record.parentPid;
        }
        throw new Error('bootstrap_claim_sudo_ancestry_invalid');
    };
    const bootId = boot(); const records = walk();
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)
        || bootId !== boot() || canonical(records) !== canonical(walk())) {
        throw new Error('bootstrap_claim_process_changed');
    }
    const caller = records.at(-1);
    return Object.freeze({ uid: policy.applicationUid, pid: caller.pid, startTicks: caller.startTicks, bootId });
}
function listProcessGroup(pgid, deps) {
    if (deps.listProcessGroup) return deps.listProcessGroup(pgid);
    const output = boundedExec('/usr/bin/ps', ['-eo', 'pid=,pgid=,sid=,stat=']);
    return output.trim().split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/)).filter((parts) => Number(parts[1]) === pgid)
        .map(([pid, group, sid, state]) => ({ pid: Number(pid), pgid: Number(group), sid: Number(sid), state: state[0] }));
}
function parseProbe(config, deps) {
    const raw = runPinnedExecutable(config.zeroWorkProbe.file, config.zeroWorkProbe.sha256, config.zeroWorkProbe.args,
        deps, { timeout: config.zeroWorkProbe.timeoutMs });
    let value; try { value = JSON.parse(raw); } catch { throw new Error('host_zero_work_probe_invalid'); }
    if (!Number.isSafeInteger(value.liveSessions) || !Number.isSafeInteger(value.workflows)
        || !Number.isSafeInteger(value.admittedTurns)) throw new Error('host_zero_work_probe_invalid');
    return value;
}
function databaseWriters(config, deps) {
    if (deps.databaseWriters) return deps.databaseWriters(config.databaseFile);
    const database = statSync(config.databaseFile); let writers = 0;
    for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const identity = processIdentity(Number(name)); if (identity.pgid === config.oldProcess.pgid) continue;
            for (const fd of readdirSync(`/proc/${name}/fd`)) {
                const target = statSync(`/proc/${name}/fd/${fd}`);
                if (target.dev === database.dev && target.ino === database.ino) { writers += 1; break; }
            }
        } catch {}
    }
    return writers;
}
async function health(url, expected, deps) {
    const response = await (deps.fetch || fetch)(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    let body = {}; try { body = await response.json(); } catch {}
    if (response.status !== expected.status) throw new Error('host_health_status_mismatch');
    return body;
}
async function maintenanceProof(config, deps) {
    const response = await (deps.fetch || fetch)(config.health.publicUrl,
        { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    const retryAfter = response.headers?.get?.('retry-after');
    const nonce = response.headers?.get?.('x-nassaj-maintenance-nonce');
    if (response.status !== 503 || retryAfter !== String(config.maintenance.retryAfterSeconds)
        || nonce !== config.maintenance.nonce) throw new Error('host_ingress_maintenance_proof_failed');
    return { status: 503, retryAfter, nonce };
}
function systemctl(args, deps) { return (deps.exec || boundedExec)('/usr/bin/systemctl', args, { timeout: 30_000 }); }
function validateMaintenance(config) {
    const value = config.maintenance;
    if (!value || value.nonce !== MAINTENANCE.nonce || value.retryAfterSeconds !== MAINTENANCE.retryAfterSeconds
        || !UNIT.test(value.responderUnit || '') || value.responderPort !== MAINTENANCE.port
        || !Number.isSafeInteger(value.cloudflared?.uid) || value.cloudflared.uid <= 0
        || !Number.isSafeInteger(value.cloudflared?.originPort) || value.cloudflared.originPort < 1024
        || value.cloudflared.originPort > 65535 || !path.isAbsolute(value.nft?.binary)
        || !HEX64.test(value.nft?.sha256 || '') || !path.isAbsolute(value.conntrack?.binary)
        || !HEX64.test(value.conntrack?.sha256 || '')) throw new Error('host_ingress_maintenance_contract_invalid');
    listenerBoundary(config);
    return value;
}
function effectiveCapability(bit) {
    const line = readFileSync('/proc/self/status', 'utf8').split('\n').find((item) => item.startsWith('CapEff:'));
    return Boolean(line && (BigInt(`0x${line.split(/\s+/)[1]}`) & (1n << BigInt(bit))));
}
const USER_MANAGER_SEGMENT = /^user@\d+\.service$/;
function hostFail(code, detail) { const error = new Error(code); error.detail = detail; return error; }
function systemdCgroupPath(cgroupText) {
    const lines = String(cgroupText).split('\n').map((line) => line.trim()).filter(Boolean);
    const line = lines.find((item) => item.startsWith('0::')) || lines.find((item) => /^\d+:[^:]*\bname=systemd\b/.test(item));
    return line ? line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1) : '';
}
/** Bind the live ingress process to the same manager the unit fingerprint is taken from. */
function assertSystemManagedIngressCgroup(cgroupText, unit) {
    const segments = systemdCgroupPath(cgroupText).split('/').filter(Boolean);
    if (segments.some((segment) => USER_MANAGER_SEGMENT.test(segment))) {
        throw hostFail('host_ingress_unit_manager_mismatch',
            `${unit} runs inside a systemd --user manager while its fingerprint is taken from the system manager`);
    }
    if (!segments.includes(unit)) throw new Error('host_cloudflared_identity_mismatch');
    return segments.join('/');
}
function scopedIngressManager(config) {
    const cloudflared = config.maintenance.cloudflared;
    if (!listenerBoundary(config)) return null;
    const manager = ingressManager(cloudflared.manager);
    if (manager.unit !== cloudflared.unit || (manager.scope === 'user' && manager.managerUid !== cloudflared.uid)
        || cloudflared.routingEvidence?.kind !== 'mutable-routing-observation/v1') throw Error('host_ingress_manager_contract');
    return manager;
}
function attestIngressManager(config, cgroup, deps) {
    const cloudflared = config.maintenance.cloudflared, manager = scopedIngressManager(config);
    if (!manager) return assertSystemManagedIngressCgroup(cgroup, cloudflared.unit);
    const group = systemdCgroupPath(cgroup), segments = group.split('/').filter(Boolean);
    if (manager.scope === 'system') assertSystemManagedIngressCgroup(cgroup, cloudflared.unit);
    else if (!segments.includes(`user@${manager.managerUid}.service`) || !segments.includes(manager.unit)
        || segments.filter(segment => USER_MANAGER_SEGMENT.test(segment)).length !== 1) throw Error('host_ingress_unit_manager_mismatch');
    const pid = systemctl(ingressShowArgs(manager, ['MainPID']), deps).trim();
    const effectiveGroup = systemctl(ingressShowArgs(manager, ['ControlGroup']), deps).trim();
    if (pid !== String(cloudflared.pid) || effectiveGroup !== group || cloudflared.routingEvidence.controlGroup !== group)
        throw Error('host_ingress_manager_identity_changed');
    return group;
}
function ingressConfigEvidence(config) {
    const cloudflared = config.maintenance.cloudflared;
    if (scopedIngressManager(config)) return readRoutingEvidence(cloudflared.configFile, cloudflared.uid);
    return { ...liveFileEvidence(cloudflared.configFile), text: readFileSync(cloudflared.configFile, 'utf8') };
}
export const __testables = Object.freeze({ assertSystemManagedIngressCgroup, buildListenerFenceRules, observeOriginListener, emptyConntrackDeletion, runPinnedExecutable });
/** Verify the effective unit files without changing service state. */
export function attestEffectiveUnit(unit, spec, deps = {}, routing = null) {
    if (deps.systemdUnitAttestation) return deps.systemdUnitAttestation(unit, spec);
    if (!spec || !Array.isArray(spec.files) || spec.files.length < 1 || !HEX64.test(spec.sha256 || '')) {
        throw new Error('host_ingress_effective_unit_contract_invalid');
    }
    const output = systemctl(routing ? ingressShowArgs(routing.manager, ['FragmentPath', 'DropInPaths'])
        : ['show', unit, '--property=FragmentPath', '--property=DropInPaths', '--value'], deps)
        .trim().split('\n').flatMap((line) => line.trim().split(/\s+/)).filter(Boolean).sort();
    const expected = [...spec.files].sort();
    if (JSON.stringify(output) !== JSON.stringify(expected)) throw new Error('host_ingress_effective_unit_paths_mismatch');
    const evidence = expected.map(file => routing ? readRoutingEvidence(file, routing.uid) : liveFileEvidence(file));
    const digest = sha(Buffer.from(JSON.stringify(evidence.map(({ path: file, sha256, size }) => ({ path: file, sha256, size })))));
    if (digest !== spec.sha256) throw new Error('host_ingress_effective_unit_digest_mismatch');
    return { unit, files: expected, sha256: digest };
}
/** Attest static preparation sources and current ingress identity; no capability or live responder requirement. */
export function attestPreparedMaintenance(config, deps = {}) {
    const value = validateMaintenance(config);
    const cloudflared = value.cloudflared;
    if (!Number.isSafeInteger(cloudflared.pid) || cloudflared.pid <= 0
        || typeof cloudflared.startTime !== 'string' || !/^(0|[1-9][0-9]{0,23})$/.test(cloudflared.startTime)
        || !path.isAbsolute(cloudflared.executable) || !HEX64.test(cloudflared.executableSha256 || '')
        || !path.isAbsolute(cloudflared.configFile) || !HEX64.test(cloudflared.configSha256 || '')
        || !UNIT.test(cloudflared.unit || '') || cloudflared.originHost !== '127.0.0.1') {
        throw new Error('host_ingress_cloudflared_contract_invalid');
    }
    const identity = (deps.ingressProcessIdentity || processIdentity)(cloudflared.pid);
    const readProc = deps.readIngressProc || (file => readFileSync(file, 'utf8'));
    const status = readProc(`/proc/${cloudflared.pid}/status`);
    const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
    if (listenerBoundary(config)) {
        const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status)?.slice(1).map(Number);
        if (uids?.length !== 4 || uids.some(value => value !== cloudflared.uid)) throw Error('host_cloudflared_identity_mismatch');
    }
    const cgroup = readProc(`/proc/${cloudflared.pid}/cgroup`);
    if (identity.startTime !== cloudflared.startTime || uid !== cloudflared.uid
        || (deps.ingressExecutable || realpathSync)(`/proc/${cloudflared.pid}/exe`) !== cloudflared.executable) throw new Error('host_cloudflared_identity_mismatch');
    attestIngressManager(config, cgroup, deps);
    verifyPinnedExecutable(cloudflared.executable, cloudflared.executableSha256, deps);
    const cloudflaredConfig = ingressConfigEvidence(config);
    const cloudflaredConfigText = cloudflaredConfig.text;
    if (cloudflaredConfig.sha256 !== cloudflared.configSha256
        || !cloudflaredConfigText.includes(`http://${cloudflared.originHost}:${cloudflared.originPort}`)) {
        throw new Error('host_cloudflared_config_mismatch');
    }
    const manager = scopedIngressManager(config);
    const cloudflaredUnit = attestEffectiveUnit(cloudflared.unit, cloudflared.effectiveUnit, deps, manager ? { manager, uid } : null);
    const responderUnit = attestEffectiveUnit(value.responderUnit, value.responderEffectiveUnit, deps);
    if (manager) {
        if ((deps.ingressProcessIdentity || processIdentity)(cloudflared.pid).startTime !== identity.startTime)
            throw Error('host_ingress_manager_identity_changed');
        attestIngressManager(config, readProc(`/proc/${cloudflared.pid}/cgroup`), deps);
    }
    return { pid: identity.pid, startTime: identity.startTime, uid, unit: cloudflared.unit,
        configSha256: cloudflared.configSha256, origin: `${cloudflared.originHost}:${cloudflared.originPort}`,
        cloudflaredUnit, responderUnit };
}
function attestMaintenancePrerequisites(config, deps) {
    validateMaintenance(config);
    if (deps.attestMaintenancePrerequisites) return deps.attestMaintenancePrerequisites(config);
    if (deps.exec && deps.verifyPinnedExecutable) return { injectedHostAttestation: true };
    const result = attestPreparedMaintenance(config, deps);
    if (!effectiveCapability(12)) throw new Error('host_nft_capability_missing');
    return result;
}
function attestOfflineMaintenancePrerequisites(config, deps) {
    const value = validateMaintenance(config); const cloudflared = value.cloudflared;
    verifyPinnedExecutable(value.nft.binary, value.nft.sha256, deps);
    verifyPinnedExecutable(value.conntrack.binary, value.conntrack.sha256, deps);
    if (!Number.isSafeInteger(cloudflared.uid) || cloudflared.uid <= 0 || cloudflared.originHost !== '127.0.0.1'
        || !path.isAbsolute(cloudflared.configFile) || !HEX64.test(cloudflared.configSha256 || '')
        || !UNIT.test(cloudflared.unit || '')) throw new Error('host_ingress_offline_contract_invalid');
    const configEvidence = ingressConfigEvidence(config);
    if (configEvidence.sha256 !== cloudflared.configSha256
        || !configEvidence.text.includes(`http://${cloudflared.originHost}:${cloudflared.originPort}`)) {
        throw new Error('host_ingress_offline_config_mismatch');
    }
    if (!effectiveCapability(12)) throw new Error('host_nft_capability_missing');
    return { uid: cloudflared.uid, origin: `${cloudflared.originHost}:${cloudflared.originPort}`,
        cloudflaredUnit: attestEffectiveUnit(cloudflared.unit, cloudflared.effectiveUnit, deps, scopedIngressManager(config)
            ? { manager: scopedIngressManager(config), uid: cloudflared.uid } : null),
        responderUnit: attestEffectiveUnit(value.responderUnit, value.responderEffectiveUnit, deps) };
}
async function responderProof(config, deps) {
    const url = `http://127.0.0.1:${config.maintenance.responderPort}/health?nonce=${encodeURIComponent(config.maintenance.nonce)}`;
    const response = await (deps.fetch || fetch)(url, { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
    let body = {}; try { body = await response.json(); } catch {}
    if (response.status !== 503 || response.headers?.get?.('retry-after') !== String(config.maintenance.retryAfterSeconds)
        || response.headers?.get?.('x-nassaj-maintenance-nonce') !== config.maintenance.nonce) {
        throw new Error('host_maintenance_responder_proof_failed');
    }
    if (!(deps.exec && deps.verifyPinnedExecutable)
        && (body?.schema !== 'nassaj-maintenance/v1' || body?.state !== 'maintenance' || body?.nonce !== config.maintenance.nonce)) {
        throw new Error('host_maintenance_responder_body_invalid');
    }
    return { status: 503, nonce: config.maintenance.nonce };
}
function assertExactTargetBody(body, config) {
    if (body?.health && body.health !== 'ok') throw new Error('host_target_health_failed');
    if (body?.releaseIdentitySha256 !== config.expected.releaseIdentitySha256
        || body?.serverBuildId !== config.expected.serverBuildId || body?.clientBuildId !== config.expected.clientBuildId
        || body?.generationId !== config.expected.generationId || body?.updateReady !== true
        || body?.updateStrategy !== 'artifact-runtime-v2') throw new Error('host_target_identity_mismatch');
    return body;
}
function gateComment(config) { return `nassaj-cutover-${config.maintenance.nonce}`; }
function installMaintenanceGate(config, deps, options = {}) {
    const maintenance = validateMaintenance(config); verifyPinnedExecutable(maintenance.nft.binary, maintenance.nft.sha256, deps);
    if (deps.installMaintenanceGate) return deps.installMaintenanceGate(config);
    const batch = listenerBoundary(config) ? buildListenerFenceRules(config) : `destroy table inet nassaj_cutover\nadd table inet nassaj_cutover\n`
        + `add chain inet nassaj_cutover cut_established { type filter hook output priority filter; policy accept; }\n`
        + `add rule inet nassaj_cutover cut_established meta skuid ${maintenance.cloudflared.uid} ip daddr 127.0.0.1 `
        + `tcp dport ${maintenance.cloudflared.originPort} ct state established reject with tcp reset comment "${gateComment(config)}-cut"\n`
        + `add chain inet nassaj_cutover output { type nat hook output priority dstnat; policy accept; }\n`
        + `add rule inet nassaj_cutover output meta skuid ${maintenance.cloudflared.uid} ip daddr 127.0.0.1 `
        + `tcp dport ${maintenance.cloudflared.originPort} ct state new redirect to :${maintenance.responderPort} `
        + `comment "${gateComment(config)}"\n`;
    runPinnedExecutable(maintenance.nft.binary, maintenance.nft.sha256,
        ['-f', '-'], deps, { timeout: 30_000, input: batch });
    if (options.cutEstablished !== false) runPinnedExecutable(maintenance.conntrack.binary, maintenance.conntrack.sha256,
        ['-D', '-p', 'tcp', ...(listenerBoundary(config) ? [] : ['--orig-src', '127.0.0.1']), '--orig-dst', '127.0.0.1', '--dport',
            String(maintenance.cloudflared.originPort)], deps, { timeout: 30_000, allowEmptyConntrackDeletion: Boolean(listenerBoundary(config)) });
}
function removeMaintenanceGate(config, deps) {
    validateMaintenance(config);
    if (deps.removeMaintenanceGate) return deps.removeMaintenanceGate(config);
    runPinnedExecutable(config.maintenance.nft.binary, config.maintenance.nft.sha256, ['-f', '-'], deps,
        { timeout: 30_000, input: 'destroy table inet nassaj_cutover\n' });
}
function sqlite(config, sql, deps) { return (deps.exec || boundedExec)('/usr/bin/sqlite3', [config.databaseFile, sql]); }
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function openPrivateMigrationFile(file, ownerUid, exactSize = null) {
    if (!path.isAbsolute(file) || !Number.isSafeInteger(ownerUid) || ownerUid < 0) throw new Error('host_migration_secret_contract_invalid');
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== ownerUid || (before.mode & 0o777) !== 0o600
        || (exactSize !== null && before.size !== exactSize)) throw new Error('host_migration_secret_file_unsafe');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) { closeSync(fd); throw new Error('host_migration_secret_file_changed'); }
    return fd;
}
function openPinnedMigrationData(file, expectedSha256, expectedMode, deps) {
    const metadata = lstatSync(file);
    if (!path.isAbsolute(file) || !metadata.isFile() || metadata.isSymbolicLink()
        || (!deps.verifyPinnedMigrationData && metadata.uid !== 0)
        || (metadata.mode & 0o777) !== expectedMode || sha(readFileSync(file)) !== expectedSha256) {
        throw new Error('host_migration_data_identity_invalid');
    }
    deps.verifyPinnedMigrationData?.(file, expectedSha256);
    const before = lstatSync(file); const childFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const readFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const childIdentity = fstatSync(childFd); const readIdentity = fstatSync(readFd);
        if (childIdentity.dev !== before.dev || childIdentity.ino !== before.ino || childIdentity.dev !== readIdentity.dev
            || childIdentity.ino !== readIdentity.ino || sha(readFileSync(readFd)) !== expectedSha256) {
            throw new Error('host_migration_data_changed');
        }
        return childFd;
    } catch (error) { closeSync(childFd); throw error; }
    finally { closeSync(readFd); }
}
function migrationClosureDigest(value) {
    const hash = createHash('sha256'); hash.update(value.schema).update('\0').update(value.graphLoader).update('\0')
        .update(value.entry).update('\0').update(value.packageLockSha256).update('\0').update(JSON.stringify(value.runtimeAbi)).update('\0')
        .update(JSON.stringify(value.nativePackageAllowlist)).update('\0');
    for (const file of value.files) hash.update(file.assetPath).update('\0').update(String(file.mode)).update('\0')
        .update(String(file.size)).update('\0').update(file.sha256).update('\0');
    for (const item of value.packages) hash.update(item.root).update('\0').update(item.name).update('\0').update(item.version).update('\0')
        .update(JSON.stringify(item.peerDependencies)).update('\0').update(JSON.stringify(item.peerDependenciesMeta)).update('\0')
        .update(item.sha256).update('\0');
    return hash.digest('hex');
}
function verifyProductionMigrationContract(config, deps) {
    const fd = openPinnedMigrationData(config.migration.contractFile, config.migration.contractSha256, 0o444, deps);
    let contract; try { contract = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
    const closure = contract?.migrationClosure;
    if (contract?.schema !== 'nassaj-database-release-contract/v1'
        || contract.releaseIdentitySha256 !== config.expected.releaseIdentitySha256
        || contract.migrationEntrySha256 !== config.migration.entry.sha256
        || contract.migrationClosureSha256 !== closure?.sha256 || closure?.schema !== 'nassaj-database-migration-closure/v2'
        || closure.assetManifestBound !== true || migrationClosureDigest(closure) !== closure.sha256
        || contract.targetSchemaDigest !== config.expected.targetSchemaDigest || !Array.isArray(closure.files)
        || !Array.isArray(closure.packages)) throw new Error('host_migration_contract_invalid');
    const records = [...closure.files, ...closure.packages.flatMap((item) => item.files || [])];
    const entryRecord = records.find((record) => record.assetPath === closure.entry);
    if (!entryRecord || entryRecord.mode !== 0o644) throw new Error('host_migration_entry_mode_invalid');
    for (const record of records) {
        if (!record?.assetPath || path.posix.normalize(record.assetPath) !== record.assetPath || record.assetPath.startsWith('../')
            || !HEX64.test(record.sha256 || '') || !Number.isSafeInteger(record.size)) throw new Error('host_migration_closure_invalid');
        const packageRecord = record.assetPath.startsWith('node_modules/');
        const base = packageRecord ? config.migration.nodeModulesRoot : config.migration.runtimeRoot;
        const relative = packageRecord ? record.assetPath.slice('node_modules/'.length) : record.assetPath;
        const file = path.resolve(base, ...relative.split('/'));
        if (!file.startsWith(`${base}${path.sep}`)) throw new Error('host_migration_closure_escape');
        const metadata = lstatSync(file);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== record.size
            || (metadata.mode & 0o777) !== record.mode || sha(readFileSync(file)) !== record.sha256
            || (!deps.verifyPinnedMigrationData && metadata.uid !== 0)) {
            throw new Error('host_migration_closure_mismatch');
        }
        if (!deps.verifyPinnedMigrationData) for (let ancestor = path.dirname(file);;) {
            const parent = lstatSync(ancestor);
            if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) {
                throw new Error('host_migration_closure_owner_invalid');
            }
            if (ancestor === base) break; ancestor = path.dirname(ancestor);
        }
        deps.verifyPinnedMigrationData?.(file, record.sha256);
    }
    if (closure.entry !== path.relative(config.migration.runtimeRoot, config.migration.entry.file).split(path.sep).join('/')) {
        throw new Error('host_migration_entry_contract_mismatch');
    }
    return { contract, entryMode: entryRecord.mode };
}
function validateMigrationCapability(config, contract, capability, databaseSha256, acceptedIntent = null, capabilitySha256 = null) {
    const timely = Number.isSafeInteger(capability?.expiresAt) && (capability.expiresAt > Date.now()
        || acceptedIntent?.capabilitySha256 === capabilitySha256 && acceptedIntent.acceptedAt < capability.expiresAt);
    if (capability?.schema !== 'nassaj-migration-secret-capability/v1' || capability.providerSecretsKeyFd !== 4
        || capability.purpose !== 'release-database-migration'
        || capability.releaseIdentitySha256 !== config.expected.releaseIdentitySha256
        || capability.migrationEntrySha256 !== config.migration.entry.sha256
        || capability.databaseContractSha256 !== config.migration.contractSha256
        || capability.migrationClosureSha256 !== contract.migrationClosureSha256
        || capability.databaseSha256 !== databaseSha256
        || !timely
        || !REQUEST_TOKEN.test(capability.nonce || '')) throw new Error('host_migration_capability_invalid');
}
function copyDurable(source, target) {
    const temporary = `${target}.partial-${process.pid}`; copyFileSync(source, temporary); chmodSync(temporary, 0o600);
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, target); syncDirectory(path.dirname(target));
}
function pm2(config, args, deps) {
    return runPinnedExecutable(config.pm2.binary, config.pm2.binarySha256, args, deps,
        { env: { PATH: '/usr/bin:/bin', HOME: config.pm2.home,
        PM2_HOME: config.pm2.home, LC_ALL: 'C' }, timeout: 120_000 });
}
function validateConfig(config) {
    if (config?.schema !== 'nassaj-release-runtime-host-config/v1' || !config.expected || !Number.isSafeInteger(config.oldProcess?.pid)
        || config.oldProcess.pid !== config.oldProcess.pgid || config.oldProcess.pid !== config.oldProcess.sid
        || config.oldProcess.killTimeout < 86_400_000 || config.oldProcess.treeKill !== false
        || !path.isAbsolute(config.controlRoot) || !path.isAbsolute(config.databaseFile)
        || !path.isAbsolute(config.pm2?.binary) || !path.isAbsolute(config.pm2?.launcher)
        || !HEX64.test(config.pm2?.binarySha256 || '') || !HEX64.test(config.pm2?.launcherSha256 || '')
        || !path.isAbsolute(config.migration?.node?.file || '') || !HEX64.test(config.migration?.node?.sha256 || '')
        || !path.isAbsolute(config.migration?.entry?.file || '') || !HEX64.test(config.migration?.entry?.sha256 || '')
        || !path.isAbsolute(config.migration?.contractFile || '') || !HEX64.test(config.migration?.contractSha256 || '')
        || config.migration.contractSha256 !== config.expected.databaseContractSha256
        || !path.isAbsolute(config.migration?.runtimeRoot || '')
        || !path.isAbsolute(config.migration?.nodeModulesRoot || '')
        || !path.isAbsolute(config.migration?.providerSecretsKeyFile || '')
        || !path.isAbsolute(config.migration?.secretCapabilityFile || '')
        || !Number.isSafeInteger(config.migration?.serviceUid) || config.migration.serviceUid <= 0
        || !Number.isSafeInteger(config.migration?.serviceGid) || config.migration.serviceGid <= 0
        || !HEX64.test(config.expected.releaseIdentitySha256 || '')) throw new Error('host_config_invalid');
    return config;
}

/** Recreate the volatile maintenance fence during boot before cloudflared exists. */
export async function restoreReleaseRuntimeMaintenanceGateOffline(rawConfig, deps = {}) {
    const config = validateConfig(rawConfig); const state = readState(config);
    const journalFile = path.join(config.controlRoot, 'first-cutover.json');
    if (!existsSync(journalFile)) {
        if (state.present && (state.value.gateActive || state.value.gateInstallIntent)) throw new Error('host_gate_orphan_state');
        return Object.freeze({ state: 'not_required' });
    }
    const journal = readControlJson(journalFile, lstatSync(config.controlRoot).uid);
    if (journal?.schema !== 'nassaj-release-runtime-cutover/v1' || !journal.transactionId || !journal.expected) {
        throw new Error('host_gate_journal_invalid');
    }
    if (['committed', 'rolled_back'].includes(journal.state)) {
        if (state.value.gateActive === true) throw new Error('host_gate_terminal_state_inconsistent');
        return Object.freeze({ state: 'not_required', journalState: journal.state });
    }
    if (!state.present || !state.value.gateInstallIntent) {
        if (journal.state === 'running' && journal.phase === 'accepted') return Object.freeze({ state: 'not_required' });
        throw new Error('host_gate_state_missing');
    }
    const intent = state.value.gateInstallIntent;
    if (intent.transactionId !== journal.transactionId || intent.nonce !== config.maintenance.nonce
        || intent.identitySeal !== cutoverIdentitySeal(journal.expected)
        || intent.identitySeal !== cutoverIdentitySeal(config.expected)) throw new Error('host_gate_identity_mismatch');
    if (state.value.gateActive === true && !intent) throw new Error('host_gate_active_without_intent');
    if (state.value.publicBoundaryOpened && state.value.gateActive === true) throw new Error('host_gate_open_state_inconsistent');
    const prerequisites = deps.attestOfflineMaintenancePrerequisites
        ? deps.attestOfflineMaintenancePrerequisites(config) : attestOfflineMaintenancePrerequisites(config, deps);
    if (config.bootstrapClaim) invalidateCutoverStartupAdmission(config.controlRoot, 'offline_maintenance_recovery');
    try { systemctl(['start', config.maintenance.responderUnit], deps); }
    catch { throw new Error('host_ingress_responder_start_failed'); }
    await responderProof(config, deps); installMaintenanceGate(config, deps, { cutEstablished: false });
    state.value.gateActive = true; state.value.gateRestoredAt = Date.now(); atomicJson(state.file, state.value);
    return Object.freeze({ state: 'restored', mode: 'nft-maintenance-redirect', transactionId: journal.transactionId, prerequisites });
}
function liveFileEvidence(file) {
    if (!path.isAbsolute(file)) throw new Error('host_live_identity_path_invalid');
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('host_live_identity_file_invalid');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd); const bytes = readFileSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('host_live_identity_file_changed');
        return { path: file, sha256: sha(bytes), device: opened.dev, inode: opened.ino, size: opened.size };
    } finally { closeSync(fd); }
}
function measureIdentity(spec) {
    if (typeof spec === 'string') return liveFileEvidence(spec).sha256;
    if (!spec || !Array.isArray(spec.files) || spec.files.length < 1) throw new Error('host_live_identity_contract_missing');
    const evidence = spec.files.map(liveFileEvidence);
    return sha(Buffer.from(JSON.stringify(evidence.map(({ path: file, sha256, size }) => ({ path: file, sha256, size })))));
}
function measureLiveFacts(config, deps) {
    if (deps.inspectLiveFacts) return deps.inspectLiveFacts(config);
    const identity = config.liveIdentity;
    if (!identity || !path.isAbsolute(identity.nodeInstanceIdFile)) throw new Error('host_live_identity_contract_missing');
    const nodeInstanceId = readFileSync(identity.nodeInstanceIdFile, 'utf8').trim();
    const database = liveFileEvidence(config.databaseFile); const snapshot = liveFileEvidence(config.pm2.oldSnapshot);
    const launcher = liveFileEvidence(config.pm2.launcher);
    const measured = {
        nodeInstanceId,
        hostIdentitySha256: measureIdentity(identity.host),
        releaseIdentitySha256: measureIdentity(identity.release),
        migrationIdentitySha256: measureIdentity(identity.migration),
        databaseContractSha256: measureIdentity(identity.databaseContract),
        assetSha256: measureIdentity(identity.asset),
        pm2SnapshotSha256: snapshot.sha256,
        databaseIdentity: { path: database.path, device: database.device, inode: database.inode, size: database.size },
        rollbackSnapshotIdentity: { path: snapshot.path, device: snapshot.device, inode: snapshot.inode, size: snapshot.size },
        launcherIdentity: { path: launcher.path, device: launcher.device, inode: launcher.inode, size: launcher.size,
            sha256: launcher.sha256 },
    };
    for (const key of ['hostIdentitySha256', 'releaseIdentitySha256', 'migrationIdentitySha256', 'databaseContractSha256',
        'assetSha256', 'pm2SnapshotSha256']) {
        if (measured[key] !== config.expected[key]) throw new Error(`host_live_${key}_mismatch`);
    }
    if (measured.nodeInstanceId !== config.expected.nodeInstanceId || launcher.sha256 !== config.pm2.launcherSha256) {
        throw new Error('host_live_identity_mismatch');
    }
    return measured;
}

/** Build the fixed host operation implementation used by the root dispatcher. */
export function createReleaseRuntimeHostOperations(rawConfig, deps = {}) {
    const config = validateConfig(rawConfig); const inspect = async () => {
        const state = readState(config).value; let identity;
        try { identity = (deps.processIdentity || processIdentity)(config.oldProcess.pid); } catch {
            if (!state.supervisorSwitched) throw new Error('host_old_process_identity_changed');
            identity = { pid: config.oldProcess.pid, pgid: config.oldProcess.pgid, sid: config.oldProcess.sid,
                startTime: config.oldProcess.startTime };
        }
        if (!state.supervisorSwitched && (identity.startTime !== config.oldProcess.startTime || identity.pgid !== config.oldProcess.pgid
            || identity.sid !== config.oldProcess.sid)) throw new Error('host_old_process_identity_changed');
        if (!state.frozen && !state.supervisorSwitched) { const privateBody = await health(config.health.privateUrl, { status: 200 }, deps);
            if (privateBody.health && privateBody.health !== 'ok') throw new Error('host_old_health_failed'); }
        let maintenanceGate;
        if (state.gateActive === true) maintenanceGate = { prerequisites: attestMaintenancePrerequisites(config, deps),
            publicProof: await maintenanceProof(config, deps) };
        const liveFacts = measureLiveFacts(config, deps);
        return { ...liveFacts, oldPid: identity.pid, oldPgid: identity.pgid, oldSid: identity.sid,
            killTimeout: config.oldProcess.killTimeout, treeKill: config.oldProcess.treeKill,
            oldHealth: state.frozen ? 'frozen' : 'ok', maintenanceGate };
    };
    const operations = {
        inspect,
        async blockIngress(context = {}) {
            if (!context.transactionId && deps.attestMaintenancePrerequisites) {
                context = { transactionId: 'injected-test-cutover', expected: config.expected };
            }
            const maintenance = validateMaintenance(config); const state = readState(config);
            if (state.value.gateInstallIntent) {
                const intent = state.value.gateInstallIntent;
                if (intent.transactionId !== context.transactionId || intent.identitySeal !== cutoverIdentitySeal(context.expected)) {
                    throw new Error('host_ingress_cutover_identity_mismatch');
                }
                try {
                    const publicMaintenance = await maintenanceProof(config, deps); state.value.gateActive = true;
                    atomicJson(state.file, state.value);
                    return { mode: 'nft-maintenance-redirect', recovered: true, publicMaintenance };
                } catch {}
            }
            await health(config.health.publicUrl, { status: 200 }, deps);
            const prerequisites = attestMaintenancePrerequisites(config, deps);
            if (!context.transactionId || cutoverIdentitySeal(context.expected) !== cutoverIdentitySeal(config.expected)) {
                throw new Error('host_ingress_cutover_identity_invalid');
            }
            state.value.gateInstallIntent = { transactionId: context.transactionId, identitySeal: cutoverIdentitySeal(config.expected),
                nonce: maintenance.nonce, responderUnit: maintenance.responderUnit, publicUrl: config.health.publicUrl, at: Date.now() };
            atomicJson(state.file, state.value);
            try { systemctl(['start', maintenance.responderUnit], deps); }
            catch { throw new Error('host_ingress_responder_start_failed'); }
            await responderProof(config, deps); installMaintenanceGate(config, deps);
            state.value.gateActive = true; atomicJson(state.file, state.value);
            const proof = await maintenanceProof(config, deps);
            return { mode: 'nft-maintenance-redirect', prerequisites, publicMaintenance: proof };
        },
        async fenceAdmission() {
            const state = readState(config);
            if (!state.value.gateInstallIntent || state.value.gateActive !== true) throw new Error('host_ingress_gate_not_active');
            return { mode: 'nft-maintenance-redirect', externalProof: await maintenanceProof(config, deps) };
        },
        async verifyZeroWork() { verifyPinnedExecutable(config.zeroWorkProbe.file, config.zeroWorkProbe.sha256, deps);
            return parseProbe(config, deps); },
        async freezeOldWriters() { const identity = (deps.processIdentity || processIdentity)(config.oldProcess.pid);
            if (identity.startTime !== config.oldProcess.startTime) throw new Error('host_old_process_identity_changed');
            (deps.kill || process.kill)(-config.oldProcess.pgid, 'SIGSTOP'); const state = readState(config); state.value.frozen = true;
            atomicJson(state.file, state.value); return { stoppedPgid: config.oldProcess.pgid }; },
        async verifyWritersFrozen() { verifyPinnedExecutable(config.zeroWorkProbe.file, config.zeroWorkProbe.sha256, deps);
            const zero = parseProbe(config, deps); const members = listProcessGroup(config.oldProcess.pgid, deps);
            if (!members.length || members.some((item) => item.state !== 'T')) throw new Error('host_process_group_not_frozen');
            return { ...zero, processGroupState: 'T', databaseWriters: databaseWriters(config, deps),
                unknownDescendants: members.some((item) => item.sid !== config.oldProcess.sid) ? 1 : 0 }; },
        async finalVacuumAndBackup() {
            if (!existsSync(config.preMigrationBackupFile)) {
                if (existsSync(`${config.databaseFile}-wal`) || existsSync(`${config.databaseFile}-shm`)) {
                    throw new Error('host_database_sidecar_present');
                }
                copyDurable(config.databaseFile, config.preMigrationBackupFile);
            }
            chmodSync(config.preMigrationBackupFile, 0o600);
            const currentDatabaseSha256 = liveFileEvidence(config.databaseFile).sha256; const hostState = readState(config);
            let keyFd = null; let capabilityFd = null; let entryFd = null; let keyBytes = null; let beforeReceipt; let afterReceipt;
            try {
                const verified = verifyProductionMigrationContract(config, deps); const contract = verified.contract;
                entryFd = openPinnedMigrationData(config.migration.entry.file, config.migration.entry.sha256,
                    verified.entryMode, deps);
                keyFd = openPrivateMigrationFile(config.migration.providerSecretsKeyFile, config.migration.serviceUid, 32);
                capabilityFd = openPrivateMigrationFile(config.migration.secretCapabilityFile, config.migration.serviceUid);
                const keyReadFd = openPrivateMigrationFile(config.migration.providerSecretsKeyFile,
                    config.migration.serviceUid, 32);
                const capabilityReadFd = openPrivateMigrationFile(config.migration.secretCapabilityFile,
                    config.migration.serviceUid);
                let capability; let capabilityBytes;
                try {
                    const keyIdentity = fstatSync(keyFd); const keyReadIdentity = fstatSync(keyReadFd);
                    const capabilityIdentity = fstatSync(capabilityFd); const capabilityReadIdentity = fstatSync(capabilityReadFd);
                    if (keyIdentity.dev !== keyReadIdentity.dev || keyIdentity.ino !== keyReadIdentity.ino
                        || capabilityIdentity.dev !== capabilityReadIdentity.dev || capabilityIdentity.ino !== capabilityReadIdentity.ino) {
                        throw new Error('host_migration_secret_file_changed');
                    }
                    keyBytes = readFileSync(keyReadFd); capabilityBytes = readFileSync(capabilityReadFd);
                    capability = JSON.parse(capabilityBytes);
                } finally { closeSync(keyReadFd); closeSync(capabilityReadFd); }
                const capabilitySha256 = sha(capabilityBytes); let intent = hostState.value.migrationIntent;
                if (intent) {
                    if (intent.schema !== 'nassaj-host-migration-intent/v1'
                        || intent.releaseIdentitySha256 !== config.expected.releaseIdentitySha256
                        || intent.migrationEntrySha256 !== config.migration.entry.sha256
                        || intent.databaseContractSha256 !== config.migration.contractSha256
                        || intent.migrationClosureSha256 !== contract.migrationClosureSha256
                        || !HEX64.test(intent.sourceDatabaseSha256 || '')) {
                        throw new Error('host_migration_intent_invalid');
                    }
                } else {
                    intent = { schema: 'nassaj-host-migration-intent/v1', sourceDatabaseSha256: currentDatabaseSha256,
                        releaseIdentitySha256: config.expected.releaseIdentitySha256, migrationEntrySha256: config.migration.entry.sha256,
                        databaseContractSha256: config.migration.contractSha256,
                        migrationClosureSha256: contract.migrationClosureSha256, capabilitySha256, acceptedAt: Date.now() };
                    validateMigrationCapability(config, contract, capability, intent.sourceDatabaseSha256, null, capabilitySha256);
                    hostState.value.migrationIntent = intent; atomicJson(hostState.file, hostState.value);
                }
                validateMigrationCapability(config, contract, capability, intent.sourceDatabaseSha256, intent, capabilitySha256);
                beforeReceipt = captureDatabasePreservation(config.preMigrationBackupFile, keyBytes,
                    config.expected.releaseIdentitySha256, intent.sourceDatabaseSha256, deps.preservation);
                const environment = { PATH: '/usr/bin:/bin', HOME: path.dirname(config.databaseFile), LC_ALL: 'C',
                    NODE_ENV: 'production', NASSAJ_MIGRATION_ONLY: '1', NASSAJ_SECRET_CAPABILITY_FD: '3',
                    NASSAJ_MIGRATION_RELEASE_IDENTITY_SHA256: config.expected.releaseIdentitySha256,
                    NASSAJ_MIGRATION_ENTRY_SHA256: config.migration.entry.sha256,
                    NASSAJ_MIGRATION_DATABASE_CONTRACT_SHA256: config.migration.contractSha256,
                    NASSAJ_MIGRATION_CLOSURE_SHA256: contract.migrationClosureSha256,
                    NASSAJ_MIGRATION_DATABASE_SHA256: intent.sourceDatabaseSha256 };
                if (currentDatabaseSha256 === intent.sourceDatabaseSha256) {
                    const output = runPinnedExecutable(config.migration.node.file, config.migration.node.sha256,
                        ['/proc/self/fd/5', '--database', config.databaseFile], deps,
                        { timeout: config.migration.timeoutMs || 300_000, env: environment,
                            inheritedFds: [capabilityFd, keyFd, entryFd], uid: config.migration.serviceUid,
                            gid: config.migration.serviceGid });
                    let observed; try { observed = JSON.parse(String(output).trim().split('\n').at(-1)); }
                    catch { throw new Error('host_migration_result_invalid'); }
                    if (observed?.schema !== 'nassaj-migration-only-result/v1' || observed.integrity !== 'ok'
                        || observed.foreignKeyViolations !== 0 || observed.targetSchemaDigest !== config.expected.targetSchemaDigest) {
                        throw new Error('host_migration_result_invalid');
                    }
                }
                deps.afterMigrationBeforePreservation?.(config.databaseFile);
                afterReceipt = captureDatabasePreservation(config.databaseFile, keyBytes,
                    config.expected.releaseIdentitySha256, intent.sourceDatabaseSha256, deps.preservation);
                const semantic = verifyDatabasePreservation(beforeReceipt, afterReceipt);
                if (!semantic.passed) throw new Error(`host_database_semantic_preservation_failed:${semantic.mismatches.join(',')}`);
                if (databaseSchemaDigest(config.databaseFile) !== config.expected.targetSchemaDigest) {
                    throw new Error('host_database_target_schema_mismatch');
                }
            } finally {
                keyBytes?.fill(0); if (keyFd !== null) closeSync(keyFd); if (capabilityFd !== null) closeSync(capabilityFd);
                if (entryFd !== null) closeSync(entryFd);
            }
            if (!existsSync(config.finalBackupFile)) sqlite(config,
                `VACUUM INTO '${config.finalBackupFile.replaceAll("'", "''")}';`, deps);
            chmodSync(config.finalBackupFile, 0o600);
            for (const file of [config.preMigrationBackupFile, config.finalBackupFile]) { const fd = openSync(file, 'r');
                try { fsyncSync(fd); } finally { closeSync(fd); } }
            syncDirectory(path.dirname(config.finalBackupFile));
            const integrity = sqlite(config, 'PRAGMA integrity_check;', deps).trim();
            const foreignKeys = sqlite(config, 'PRAGMA foreign_key_check;', deps).trim();
            const targetSchemaDigest = databaseSchemaDigest(config.databaseFile);
            if (targetSchemaDigest !== config.expected.targetSchemaDigest) throw new Error('host_database_target_schema_mismatch');
            const backup = liveFileEvidence(config.finalBackupFile); const preMigrationBackup = liveFileEvidence(config.preMigrationBackupFile);
            return { integrityCheck: integrity, foreignKeyViolations: foreignKeys ? foreignKeys.split('\n').length : 0,
                targetSchemaDigest, backupSha256: backup.sha256, preMigrationBackupSha256: preMigrationBackup.sha256,
                backupIdentity: backup, preMigrationBackupIdentity: preMigrationBackup, fsyncComplete: true,
                semanticPreservation: { schema: 'nassaj-database-semantic-preservation/v1', passed: true,
                    beforeReceiptSha256: sha(Buffer.from(canonical(beforeReceipt))),
                    afterReceiptSha256: sha(Buffer.from(canonical(afterReceipt))) } }; },
        async switchSupervisorToLauncher() { verifyPinnedExecutable(config.pm2.launcher, config.pm2.launcherSha256, deps);
            const state = readState(config); state.value.oldDeleteIntent = true; atomicJson(state.file, state.value);
            (deps.kill || process.kill)(-config.oldProcess.pgid, 'SIGKILL'); pm2(config, ['delete', config.pm2.oldName], deps);
            pm2(config, ['start', config.pm2.launcher, '--name', config.pm2.targetName, '--cwd', config.pm2.cwd,
                '--interpreter', config.pm2.interpreter], deps); pm2(config, ['save'], deps);
            state.value.supervisorSwitched = true; atomicJson(state.file, state.value);
            return { switched: true }; },
        async verifyPrivateTarget() { const body = assertExactTargetBody(await health(config.health.privateUrl, { status: 200 }, deps), config);
            await maintenanceProof(config, deps);
            return { ...body, health: 'ok', visibility: 'private' }; },
        async openIngress() {
            const state = readState(config);
            if (state.value.gateActive !== true) throw new Error('host_ingress_gate_not_active');
            state.value.publicBoundaryReady = { nonce: config.maintenance.nonce, at: Date.now() };
            atomicJson(state.file, state.value);
            assertExactTargetBody(await health(config.health.privateUrl, { status: 200 }, deps), config);
            removeMaintenanceGate(config, deps); state.value.gateActive = false; atomicJson(state.file, state.value);
            state.value.publicBoundaryOpened = { nonce: config.maintenance.nonce, at: Date.now() }; atomicJson(state.file, state.value);
            try { systemctl(['stop', config.maintenance.responderUnit], deps); } catch {}
            return { opened: true, mode: 'nft-maintenance-redirect-removed' };
        },
        async verifyPublicTarget() { const body = await health(config.health.publicUrl, { status: 200 }, deps);
            return { ...body, health: 'ok', visibility: 'public' }; },
        async restoreDatabaseFromBackup() { const state = readState(config);
            if (!existsSync(config.preMigrationBackupFile)) return { restored: false, reason: 'backup_not_created' };
            if (state.value.frozen && !state.value.oldKilledForRollback) {
                try { (deps.kill || process.kill)(-config.oldProcess.pgid, 'SIGKILL'); } catch {}
                try { pm2(config, ['delete', config.pm2.oldName], deps); } catch {}
                state.value.oldKilledForRollback = true; atomicJson(state.file, state.value);
            }
            if (databaseWriters(config, deps) !== 0) throw new Error('host_database_writer_still_live');
            copyDurable(config.preMigrationBackupFile, config.databaseFile); return { restored: true }; },
        async restoreOldSupervisor() { const state = readState(config);
            let oldStillRunning = false;
            try { const identity = (deps.processIdentity || processIdentity)(config.oldProcess.pid);
                oldStillRunning = identity.startTime === config.oldProcess.startTime; } catch {}
            if (!state.value.oldKilledForRollback && !state.value.supervisorSwitched && oldStillRunning) {
                return { restored: false, oldStillRunning: true };
            }
            try { pm2(config, ['delete', config.pm2.targetName], deps); } catch {}
            verifyPinnedExecutable(config.pm2.oldSnapshot, config.expected.pm2SnapshotSha256, deps);
            pm2(config, ['start', config.pm2.oldSnapshot, '--only', config.pm2.oldName], deps); pm2(config, ['save'], deps);
            state.value.oldRestartedFresh = true; atomicJson(state.file, state.value); return { restored: true, freshProcess: true }; },
        async resumeOldWriters() { const state = readState(config);
            if (state.value.frozen && !state.value.oldKilledForRollback) {
                try { (deps.kill || process.kill)(-config.oldProcess.pgid, 'SIGCONT'); } catch {}
            }
            return { resumed: !state.value.oldKilledForRollback }; },
        async verifyOldHealth() { await health(config.health.privateUrl, { status: 200 }, deps);
            return { health: 'ok', pm2SnapshotSha256: config.expected.pm2SnapshotSha256 }; },
        async restoreIngress() { const state = readState(config);
            if (state.value.gateActive === true) {
                removeMaintenanceGate(config, deps); state.value.gateActive = false; atomicJson(state.file, state.value);
                try { systemctl(['stop', config.maintenance.responderUnit], deps); } catch {}
            }
            await health(config.health.publicUrl, { status: 200 }, deps);
            return { restored: true, mode: 'legacy-listener', externalStatus: 200 }; },
    };
    const transitions = new Set(['blockIngress', 'fenceAdmission', 'freezeOldWriters', 'finalVacuumAndBackup',
        'switchSupervisorToLauncher', 'openIngress', 'restoreDatabaseFromBackup', 'restoreOldSupervisor', 'resumeOldWriters', 'restoreIngress']);
    return Object.freeze(Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name,
        async (...args) => {
            if (config.bootstrapClaim && transitions.has(name)) invalidateCutoverStartupAdmission(config.controlRoot, name);
            return operation(...args);
        }])));
}

function verifyForwardExecutableClosure(runtime, deps) {
    verifyPinnedExecutable(runtime.closure.path, runtime.closure.sha256, deps);
    const bytes = readFileSync(runtime.closure.path);
    if (bytes.length > 1048576 || sha(bytes) !== runtime.closure.sha256) throw Error('host_forward_closure_changed');
    const closure = JSON.parse(bytes);
    if (closure.schema !== 'nassaj-forward-child-closure/v1' || !Array.isArray(closure.files)
        || Object.keys(closure).sort().join(',') !== 'files,schema') throw Error('host_forward_closure_invalid');
    let previous = ''; const files = new Set();
    for (const record of closure.files) {
        if (!record || Object.keys(record).sort().join(',') !== 'path,sha256' || typeof record.path !== 'string'
            || record.path <= previous) throw Error('host_forward_closure_fields_invalid');
        verifyPinnedExecutable(record.path, record.sha256, deps); previous = record.path; files.add(record.path);
    }
    for (const file of [runtime.parent.path, runtime.wrapper.path,
        path.join(path.dirname(runtime.parent.path), 'lib/release-runtime-forward-parent.mjs'),
        path.join(path.dirname(runtime.parent.path), 'lib/release-runtime-forward-child-protocol.mjs')]) {
        if (!files.has(file)) throw Error('host_forward_closure_incomplete');
    }
}

function verifyForwardMigrationLocator(config, context, phases = ['retirement_verified', 'migration_intent'], allowInitial = false) {
    if (process.geteuid?.() !== 0 || !context || Object.keys(context).sort().join(',') !== 'operationId,schema'
        || context.schema !== 'nassaj-forward-migration-operation/v1' || !REQUEST_TOKEN.test(context.operationId || '')) throw Error('host_forward_locator_invalid');
    let journal; try { journal = readControlJson(path.join(config.controlRoot, 'first-cutover.json'), 0); }
    catch (error) { if (error.code !== 'ENOENT' || !allowInitial) throw error; journal = null; }
    const approval = readControlJson(config.bootstrapClaim.approvalFile, 0); const { signature, ...payload } = approval;
    const fd = openPrivateMigrationFile(config.bootstrapClaim.ownerApprovalPublicKeyFile, 0);
    let key; try { key = createPublicKey(readFileSync(fd)); } finally { closeSync(fd); }
    if (!journal) {
        verifyPinnedExecutable(config.forwardMigration.request.path, config.forwardMigration.request.sha256);
        const request = JSON.parse(readFileSync(config.forwardMigration.request.path));
        if (request.transactionId !== context.operationId || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
            || payload.issuedAt > Date.now() || payload.expiresAt <= Date.now()) throw Error('host_forward_initial_locator_invalid');
    }
    if ((journal && (journal.transactionId !== context.operationId || journal.state !== 'running' || !phases.includes(journal.phase)))
        || payload.schema !== 'nassaj-owner-cutover-approval/v1' || payload.action !== 'release-runtime-first-cutover'
        || key.asymmetricKeyType !== 'ed25519' || sha(key.export({ type: 'spki', format: 'der' })) !== config.expected.ownerApprovalKeySha256
        || payload.expectedSha256 !== sha(Buffer.from(canonical(config.expected)))
        || canonical(payload.startupAdmission) !== canonical(config.bootstrapClaim.identity)
        || !verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'base64url'))
        || (journal && journal.approvalSha256 !== sha(Buffer.from(canonical(approval))))) throw Error('host_forward_approval_invalid');
}

function currentGateSnapshot(config, request, deps) {
    const uid = deps.gateOwnerUid ?? 0;
    if ((deps.effectiveUid?.() ?? process.geteuid?.()) !== uid || !request
        || Object.keys(request).sort().join(',') !== 'generationEpoch,operationId,schema'
        || request.schema !== 'nassaj-current-operation-gate-request/v1'
        || !REQUEST_TOKEN.test(request.operationId || '') || !Number.isSafeInteger(request.generationEpoch)
        || request.generationEpoch < 1) throw Error('host_current_gate_request_invalid');
    const journal = readVerifiedManagedRestart(config, request.operationId, { ownerUid: uid, readRootFile: deps.gateReadRootFile });
    const read = file => deps.gateReadRootFile ? JSON.parse(deps.gateReadRootFile(file, uid)) : readControlJson(file, uid);
    const state = read(path.join(config.controlRoot, 'startup-admission.json'));
    const host = read(path.join(config.controlRoot, 'host-dispatch-state.json'));
    const lock = read(path.join(config.controlRoot, 'first-cutover.lock'));
    const parent = (deps.gateProcess || inspectForwardChildIdentity)(process.ppid);
    if (state.managedOperationId !== request.operationId || state.generationEpoch !== request.generationEpoch
        || state.state !== 'switching' || state.revocation || state.transitionReason
        || parent.pid !== journal.operator?.pid || parent.startTicks !== journal.operator?.startTicks
        || parent.bootId !== journal.operator?.bootId || !parent.uids.every(value => value === uid)
        || lock.pid !== parent.pid || lock.startTime !== parent.startTicks) throw Error('host_current_gate_authority_changed');
    const settings = config.managedRestart;
    verifyPinnedExecutable(settings.parent.path, settings.parent.sha256, deps);
    verifyPinnedExecutable(settings.nodeExecutable, settings.nodeSha256, deps);
    const executable = (deps.gateExecutable || (pid => realpathSync(`/proc/${pid}/exe`)))(parent.pid);
    const argv = (deps.gateArgv || (pid => readFileSync(`/proc/${pid}/cmdline`).toString().split('\0')))(parent.pid);
    if (executable !== settings.nodeExecutable || argv[1] !== settings.parent.path) throw Error('host_current_gate_parent_invalid');
    return { journal, state, host, digest: sha(canonical({ journal, state, host })) };
}
function gateCompareWrite(config, request, expected, ingress, gateActive, deps) {
    return withCutoverStateLock(config.controlRoot, () => {
        const current = currentGateSnapshot(config, request, deps);
        if (current.digest !== expected.digest) throw Error('host_current_gate_cas_failed');
        const host = { ...current.host, managedIngress: ingress };
        if (gateActive !== null) host.gateActive = gateActive;
        atomicJson(path.join(config.controlRoot, 'host-dispatch-state.json'), host);
        return { ...current, host, digest: sha(canonical({ journal: current.journal, state: current.state, host })) };
    });
}
function gateEffect(config, request, expected, effect, deps) {
    return withCutoverStateLock(config.controlRoot, () => {
        const current = currentGateSnapshot(config, request, deps);
        if (current.digest !== expected.digest) throw Error('host_current_gate_cas_failed');
        const result = effect();
        if (result && typeof result.then === 'function') throw Error('host_current_gate_effect_must_be_sync');
        return result;
    });
}
function gateReceipt(request, host) {
    return { schema: 'nassaj-managed-ingress-receipt/v1', operationId: request.operationId,
        generationEpoch: request.generationEpoch, phase: host.managedIngress.phase,
        observedAt: host.managedIngress.openedAt ?? host.managedIngress.closedAt,
        hostProofSha256: sha(canonical(host.managedIngress)), claimId: host.managedIngress.claimId ?? null };
}
async function currentOperationGate(config, action, request, deps) {
    const before = currentGateSnapshot(config, request, deps); validateMaintenance(config);
    const opening = action === 'openCurrentOperationGate';
    if (!opening) {
        const previous = before.host.managedIngress;
        if (before.journal.phase !== 'prepared' || before.host.gateActive !== false
            || (previous && (previous.phase !== 'opened'
                || previous.operationId !== before.journal.originalGrant.managedCommittedOperationId
                || previous.generationEpoch !== before.journal.originalGrant.generationEpoch)))
            throw Error('host_current_gate_close_phase');
        attestMaintenancePrerequisites(config, deps);
        const intent = { operationId: request.operationId, generationEpoch: request.generationEpoch,
            phase: 'close_intent', closeIntentAt: Date.now(), previousManagedIngressSha256: previous ? sha(canonical(previous)) : null };
        const pending = gateCompareWrite(config, request, before, intent, null, deps);
        gateEffect(config, request, pending, () => systemctl(['start', config.maintenance.responderUnit], deps), deps);
        await responderProof(config, deps);
        // The final state check and synchronous routing command share the writers' state lock.
        gateEffect(config, request, pending, () => installMaintenanceGate(config, deps), deps);
        await maintenanceProof(config, deps);
        return gateReceipt(request, gateCompareWrite(config, request, pending, { ...intent, phase: 'closed', closedAt: Date.now() }, true, deps).host);
    }
    const claim = before.state.lastClaim; const security = before.state.securityStartup;
    const prior = before.host.managedIngress; const receipt = before.journal.privateReceipt;
    if (before.journal.phase !== 'private_verified' || before.host.gateActive !== true || prior?.phase !== 'closed'
        || prior.operationId !== request.operationId || prior.generationEpoch !== request.generationEpoch
        || claim?.claimId !== before.journal.replacementClaim?.claimId || claim?.generationEpoch !== request.generationEpoch
        || security?.claimId !== claim?.claimId || security?.generationEpoch !== request.generationEpoch
        || security?.decision !== 'security_startup_authorized' || receipt?.claimId !== claim?.claimId
        || canonical(claim) !== canonical(before.journal.replacementClaim) || canonical(security) !== canonical(before.journal.securityStartup)
        || receipt?.schema !== 'nassaj-managed-health-receipt/v1' || receipt?.visibility !== 'private'
        || receipt.operationId !== request.operationId || receipt.generationEpoch !== request.generationEpoch
        || receipt.securityStartupSha256 !== sha(canonical(security))
        || ['releaseIdentitySha256', 'databaseContractSha256', 'serverBuildId', 'clientBuildId'].some(key => receipt[key] !== config.expected[key])
        || ['uid', 'pid', 'startTicks', 'bootId'].some(key => receipt.process?.[key] !== claim[key])
        || !Number.isSafeInteger(receipt.observedAt) || receipt.observedAt < prior.closedAt)
        throw Error('host_current_gate_open_phase');
    await observeBoundTargetHealth(config, claim, 'private', deps.gateHealth);
    const intent = { ...prior, phase: 'open_intent', openIntentAt: Date.now(), claimId: claim.claimId,
        privateReceiptSha256: sha(canonical(receipt)) };
    const pending = gateCompareWrite(config, request, before, intent, null, deps);
    gateEffect(config, request, pending, () => removeMaintenanceGate(config, deps), deps);
    const complete = gateCompareWrite(config, request, pending, { ...intent, phase: 'opened', openedAt: Date.now() }, false, deps);
    return gateReceipt(request, complete.host);
}

function firstForwardGateSnapshot(config, request, deps, opening = false) {
    if (!request || Object.keys(request).sort().join(',') !== 'generationEpoch,operationId,schema'
        || request.schema !== 'nassaj-first-forward-gate-request/v1' || !Number.isSafeInteger(request.generationEpoch)
        || request.generationEpoch < 1) throw Error('host_first_gate_request');
    verifyForwardMigrationLocator(config, { schema: 'nassaj-forward-migration-operation/v1', operationId: request.operationId }, opening ? ['target_verified', 'ingress_opening'] : ['forward_prepare_intent']);
    const journal = readControlJson(path.join(config.controlRoot, 'first-cutover.json'), 0);
    const state = readControlJson(path.join(config.controlRoot, 'startup-admission.json'), 0);
    let host; try { host = readControlJson(path.join(config.controlRoot, 'host-dispatch-state.json'), 0); }
    catch (error) { if (error.code !== 'ENOENT' || opening) throw error; host = { schema: 'nassaj-host-dispatch-state/v1', gateActive: false }; }
    const lock = readControlJson(path.join(config.controlRoot, 'first-cutover.lock'), 0);
    const parent = inspectForwardChildIdentity(process.ppid); const runtime = config.forwardMigration;
    verifyPinnedExecutable(runtime.parent.path, runtime.parent.sha256, deps);
    verifyPinnedExecutable(runtime.node.path, runtime.node.sha256, deps);
    if (state.state !== 'switching' || state.generationEpoch !== request.generationEpoch || state.managedOperationId
        || state.revocation || state.transitionReason || state.potentiallyRunningClaim
        || journal.operator?.pid !== parent.pid || journal.operator?.startTicks !== parent.startTicks
        || journal.operator?.bootId !== parent.bootId || !parent.uids.every(uid => uid === 0)
        || lock.pid !== parent.pid || lock.startTime !== parent.startTicks
        || realpathSync(`/proc/${parent.pid}/exe`) !== runtime.node.path
        || readFileSync(`/proc/${parent.pid}/cmdline`).toString().split('\0')[1] !== runtime.parent.path)
        throw Error('host_first_gate_authority');
    return { journal, state, host, digest: sha(canonical({ journal, state, host })) };
}
async function closeFirstForwardGate(config, request, deps) {
    validateMaintenance(config); const before = firstForwardGateSnapshot(config, request, deps);
    if (before.host.gateInstallIntent || before.host.gateActive) throw Error('host_first_gate_already_attempted');
    attestMaintenancePrerequisites(config, deps);
    if (listenerBoundary(config)) {
        const observed = observeOriginListener(config, config.oldProcess, deps.listener);
        if (canonical(observed) !== canonical(config.maintenance.originListener)) throw Error('host_ingress_listener_changed');
    }
    const intent = { transactionId: request.operationId, identitySeal: cutoverIdentitySeal(config.expected),
        nonce: config.maintenance.nonce, responderUnit: config.maintenance.responderUnit, publicUrl: config.health.publicUrl, at: Date.now() };
    let expected = before.digest;
    const locked = operation => withCutoverStateLock(config.controlRoot, () => {
        const current = firstForwardGateSnapshot(config, request, deps);
        if (current.digest !== expected) throw Error('host_first_gate_cas');
        operation(current.host); atomicJson(path.join(config.controlRoot, 'host-dispatch-state.json'), current.host);
        expected = sha(canonical({ journal: current.journal, state: current.state, host: current.host }));
    });
    locked(host => { host.gateInstallIntent = intent; });
    locked(() => systemctl(['start', config.maintenance.responderUnit], deps));
    await responderProof(config, deps);
    locked(() => installMaintenanceGate(config, deps));
    await maintenanceProof(config, deps);
    const closedAt = Date.now(); locked(host => { host.gateActive = true; host.firstForwardGateClosedAt = closedAt; });
    return { schema: 'nassaj-first-forward-ingress-receipt/v1', operationId: request.operationId,
        generationEpoch: request.generationEpoch, phase: 'closed', closedAt, hostProofSha256: sha(canonical(intent)) };
}

function assertForwardTargetDefinitions(config, journal) {
    const proof = journal.forwardTargetDefinitions; const sources = config.forwardActivation.supervisorPlan.sources;
    if (proof?.state !== 'durable' || proof.currentIntent !== null || !Array.isArray(proof.sourceReceipts)
        || proof.sourceReceipts.length !== sources.length) throw Error('host_first_target_definitions_missing');
    for (const source of sources) {
        const records = proof.sourceReceipts.filter(record => record.sourceId === source.sourceId);
        const info = lstatSync(source.path);
        if (records.length !== 1 || records[0].path !== source.path || records[0].format !== source.format
            || records[0].targetInstalled !== true || records[0].durable !== true || !info.isFile() || info.isSymbolicLink()
            || realpathSync(source.path) !== source.path || sha(readFileSync(source.path)) !== records[0].afterSha256)
            throw Error('host_first_target_definition_changed');
    }
}

async function openFirstForwardGate(config, request, deps) {
    validateMaintenance(config); const before = firstForwardGateSnapshot(config, request, deps, true);
    assertForwardTargetDefinitions(config, before.journal);
    const claim = before.state.lastClaim; const security = before.state.securityStartup; const receipt = before.journal.forwardReceipts?.private;
    if (before.host.gateActive !== true || before.host.gateInstallIntent?.transactionId !== request.operationId
        || before.host.gateInstallIntent.identitySeal !== cutoverIdentitySeal(config.expected)
        || claim?.claimId !== before.journal.startupClaim?.claimId || claim?.generationEpoch !== request.generationEpoch
        || security?.decision !== 'security_startup_authorized' || security.claimId !== claim.claimId
        || receipt?.claimId !== claim.claimId || receipt?.visibility !== 'private') throw Error('host_first_gate_private_receipt');
    await observeBoundTargetHealth(config, claim, 'private', deps.gateHealth);
    return withCutoverStateLock(config.controlRoot, () => {
        const current = firstForwardGateSnapshot(config, request, deps, true);
        assertForwardTargetDefinitions(config, current.journal);
        if (current.digest !== before.digest) throw Error('host_first_gate_cas');
        const host = { ...current.host, publicBoundaryReady: { nonce: config.maintenance.nonce, at: Date.now() } };
        atomicJson(path.join(config.controlRoot, 'host-dispatch-state.json'), host);
        atomicJson(path.join(config.controlRoot, 'first-cutover.json'), { ...current.journal, phase: 'ingress_opening', revision: current.journal.revision + 1 });
        removeMaintenanceGate(config, deps);
        host.gateActive = false; host.publicBoundaryOpened = { nonce: config.maintenance.nonce, at: Date.now() };
        atomicJson(path.join(config.controlRoot, 'host-dispatch-state.json'), host);
        atomicJson(path.join(config.controlRoot, 'first-cutover.json'), { ...current.journal, phase: 'ingress_opened', revision: current.journal.revision + 2 });
        return { schema: 'nassaj-first-forward-ingress-receipt/v1', operationId: request.operationId,
            generationEpoch: request.generationEpoch, phase: 'opened', openedAt: host.publicBoundaryOpened.at,
            hostProofSha256: sha(canonical(host.publicBoundaryOpened)) };
    });
}

/** Fixed pinned exec boundary keeps managed effects outside the application dispatcher closure. */
function dispatchManagedFacade(config, operation, request, deps) {
    if (!request || Object.keys(request).sort().join(',') !== 'operationId,schema'
        || request.schema !== 'nassaj-managed-restart-request/v1'
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(request.operationId || '')) throw Error('host_managed_request');
    const runtime = config.forwardMigration; const managed = config.managedRestart;
    if (!runtime || !managed || managed.parent?.path !== runtime.parent?.path
        || managed.parent.sha256 !== runtime.parent.sha256 || managed.nodeExecutable !== runtime.node?.path
        || managed.nodeSha256 !== runtime.node.sha256) throw Error('host_managed_parent_binding');
    verifyForwardExecutableClosure(runtime, deps);
    verifyPinnedExecutable(managed.nodeExecutable, managed.nodeSha256, deps);
    verifyPinnedExecutable(managed.parent.path, managed.parent.sha256, deps);
    if (operation === 'restartCommittedGeneration') {
        const state = readControlJson(path.join(config.controlRoot, 'startup-admission.json'), 0);
        if (state.managedOperationId === request.operationId) readVerifiedManagedRestart(config, request.operationId);
        else {
            if (state.state !== 'active' || state.managedOperationId) throw Error('host_managed_active_required');
            const approval = readControlJson(path.join(config.controlRoot, 'managed-restart-approval.json'), 0);
            verifyManagedRestartApproval(config, approval, request.operationId, state.managedCommitSha256 || state.commitReceiptSha256,
                readManagedRootFile(config.bootstrapClaim.ownerApprovalPublicKeyFile, 0));
        }
    } else readVerifiedManagedRestart(config, request.operationId);
    // The child rechecks all authority and kernel ancestry. This dispatcher holds no long operator lock.
    const output = runPinnedExecutable(managed.nodeExecutable, managed.nodeSha256,
        [managed.parent.path, '--managed-operation', operation], deps,
        { timeout: operation === 'restartCommittedGeneration' ? 300000 : 10000, input: `${JSON.stringify(request)}\n`,
            env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' } });
    const result = JSON.parse(output);
    const schemas = { restartCommittedGeneration: 'nassaj-managed-restart-result/v1',
        inspectManagedRestart: 'nassaj-managed-restart-preparation/v1', verifyManagedRestartPrivateReady: 'nassaj-managed-restart-private-ready/v1' };
    if (!result || result.operationId !== request.operationId || result.schema !== schemas[operation]
        || (operation === 'restartCommittedGeneration' && !['committed', 'deferred'].includes(result.decision))) throw Error('host_managed_result');
    return result;
}

export async function dispatchReleaseRuntimeHostOperation(config, operation, context, deps = {}) {
    if (['restartCommittedGeneration', 'inspectManagedRestart', 'verifyManagedRestartPrivateReady'].includes(operation))
        return dispatchManagedFacade(config, operation, context, deps);
    if (operation === 'openFirstForwardGate') return openFirstForwardGate(config, context, deps);
    if (operation === 'closeFirstForwardGate') return closeFirstForwardGate(config, context, deps);
    if (['closeCurrentOperationGate', 'openCurrentOperationGate'].includes(operation)) return currentOperationGate(config, operation, context, deps);

    if (['runFirstForwardActivation', 'resumeFirstForwardActivation', 'reconcileFirstForwardActivation'].includes(operation)) {
        if (context?.schema !== 'nassaj-forward-activation-operation/v1') throw Error('host_forward_activation_request');
        verifyForwardMigrationLocator(config, { ...context, schema: 'nassaj-forward-migration-operation/v1' },
            operation !== 'runFirstForwardActivation' ? ['supervisor_stop_deferred', 'retirement_verified', 'migration_observed'] : [], operation === 'runFirstForwardActivation');
        const runtime = config.forwardMigration;
        verifyPinnedExecutable(runtime.node.path, runtime.node.sha256, deps);
        verifyPinnedExecutable(runtime.parent.path, runtime.parent.sha256, deps);
        verifyForwardExecutableClosure(runtime, deps);
        // Dispatcher owns no long lock; the verified operator CLI acquires it and remains asynchronous with A.
        const output = runPinnedExecutable(runtime.node.path, runtime.node.sha256, [runtime.parent.path, ...(operation === 'resumeFirstForwardActivation' ? ['--resume-forward'] : operation === 'reconcileFirstForwardActivation' ? ['--reconcile-forward'] : [])], deps,
            { timeout: 360000, input: `${JSON.stringify(context)}\n`, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' } });
        const result = JSON.parse(output);
        if (operation === 'reconcileFirstForwardActivation') {
            if (result.schema !== 'nassaj-forward-lock-reconciliation/v1' || result.operationId !== context.operationId
                || !['reconciled', 'diagnosis_only'].includes(result.decision)) throw Error('host_forward_reconciliation_invalid');
            return result;
        }
        if (result.schema !== 'nassaj-forward-migration-operation-result/v1' || result.operationId !== context.operationId
            || !(result.phase === 'committed' || (result.phase === 'deferred' && result.reason === 'live_work' && typeof result.maintenance === 'boolean'))) throw Error('host_forward_result_invalid');
        return result;
    }

    if (operation === 'claimBootstrapStartup') {
        return handleBootstrapStartupAdmission(config, context, () => observeBootstrapClaimCaller(config, deps), deps.admission);
    }
    if (!OPERATIONS.has(operation) || !context || context.expected?.releaseIdentitySha256 !== config.expected.releaseIdentitySha256) {
        throw new Error('host_operation_request_invalid');
    }
    return createReleaseRuntimeHostOperations(config, deps)[operation](context);
}
