/** Root-owned forward health observations. Network/process waits never hold the short state lock. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withCutoverStateLock } from './release-runtime-cutover.mjs';
import { listenerBoundary, observeOriginListener } from './release-runtime-listener-boundary.mjs';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const identityKeys = ['nodeInstanceId', 'generationId', 'releaseIdentitySha256', 'startupClosureSha256',
    'databaseContractSha256', 'databaseDev', 'databaseIno', 'startupPolicyId', 'startupAdmissionPolicy'];
function requireValue(ok, reason) { if (!ok) throw Error(`forward_receipt_${reason}`); }
function rootRecord(file) {
    const before = fs.lstatSync(file);
    requireValue(fs.realpathSync(file) === file && before.isFile() && !before.isSymbolicLink()
        && before.uid === 0 && (before.mode & 0o777) === 0o600 && before.size > 0 && before.size <= 256 * 1024, 'record_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const current = fs.fstatSync(fd); requireValue(['dev', 'ino', 'uid', 'mode', 'size'].every(key => current[key] === before[key]), 'record_changed');
        return JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
}
function durableRecord(file, record) {
    const temporary = `${file}.partial-${randomUUID()}`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function snapshot(config, visibility, read) {
    const journal = read(path.join(config.controlRoot, 'first-cutover.json'));
    const state = read(path.join(config.controlRoot, 'startup-admission.json'));
    const host = read(path.join(config.controlRoot, 'host-dispatch-state.json'));
    const claim = journal.startupClaim; const security = state.securityStartup;
    requireValue(config.bootstrapClaim && journal.state === 'running' && state.state === 'switching'
        && hash(journal.expected) === hash(config.expected) && claim?.state === 'consumed' && claim.mode === 'cutover'
        && claim.authorityId === journal.transactionId && claim.generationEpoch === state.generationEpoch
        && claim.claimId === state.lastClaim?.claimId && security?.claimId === claim.claimId
        && security.generationEpoch === claim.generationEpoch && security.decision === 'security_startup_authorized'
        && !state.transitionReason && !state.potentiallyRunningClaim && !state.revocation
        && identityKeys.every(key => state.identity[key] === config.bootstrapClaim.identity[key]), 'claim_invalid');
    requireValue(!['migrationIntent', 'oldDeleteIntent', 'oldKilledForRollback', 'oldRestartedFresh'].some(key => Object.hasOwn(host, key))
        && !host.frozen && !host.supervisorSwitched && host.gateInstallIntent?.transactionId === journal.transactionId, 'legacy_intent');
    requireValue(visibility === 'private' ? journal.phase === 'startup_security_authorized' && host.gateActive === true
        : journal.phase === 'ingress_opened' && host.gateActive === false && !!host.publicBoundaryOpened, 'phase_invalid');
    return { journal, state, host, claim, digest: hash({ journal, state, host }) };
}
function processIdentity(pid) {
    const before = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = before.slice(before.lastIndexOf(')') + 2).trim().split(' ');
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status)?.slice(1).map(Number);
    const executable = fs.realpathSync(`/proc/${pid}/exe`);
    const after = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    requireValue(fields[19] === after.slice(after.lastIndexOf(')') + 2).trim().split(' ')[19], 'process_changed');
    return { pid, startTicks: fields[19], uids, executable, bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}
function checkProcess(config, claim, inspect) {
    const process = inspect(claim.pid);
    requireValue(process.pid === claim.pid && process.startTicks === claim.startTicks && process.bootId === claim.bootId
        && process.executable === config.bootstrapClaim.nodeExecutable && process.uids?.length === 4
        && process.uids.every(uid => uid === claim.uid && uid === config.bootstrapClaim.applicationUid), 'process_mismatch');
}
function assertListenerOwned(config, claim) {
    if (listenerBoundary(config)) return observeOriginListener(config, claim);
    const endpoint = new URL(config.health.privateUrl);
    requireValue(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && !!endpoint.port, 'private_endpoint_invalid');
    const port = Number(endpoint.port).toString(16).toUpperCase().padStart(4, '0');
    const listeners = fs.readFileSync(`/proc/${claim.pid}/net/tcp`, 'utf8').trim().split('\n').slice(1)
        .map(line => line.trim().split(/\s+/)).filter(fields => fields[3] === '0A' && fields[1].endsWith(`:${port}`));
    requireValue(listeners.length > 0 && listeners.every(fields => ['0100007F', '00000000'].includes(fields[1].split(':')[0])), 'listener_missing');
    const sockets = new Set(fs.readdirSync(`/proc/${claim.pid}/fd`).map(fd => {
        try { return fs.readlinkSync(`/proc/${claim.pid}/fd/${fd}`); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    }));
    requireValue(listeners.every(fields => sockets.has(`socket:[${fields[9]}]`)), 'listener_owner_mismatch');
}
async function fetchHealth(url, fetcher, timeoutMs = 10_000) {
    requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000, 'timeout_invalid');
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' });
    requireValue(response.status === 200, 'http_status');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; requireValue(size <= 65_536, 'http_body_large'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function checkHealth(body, config, claim) {
    requireValue(body.status === 'ok' && body.privateSecurityReady === true && body.normalAdmissionReady === false
        && body.startupPhase === 'security_startup_authorized'
        && ['claimId', 'generationEpoch', 'pid', 'startTicks', 'bootId'].every(key => body[key] === claim[key])
        && ['releaseIdentitySha256', 'generationId', 'serverBuildId', 'clientBuildId'].every(key => body[key] === config.expected[key]), 'health_identity');
}
/** Observe a supplied root-loaded claim through its real process, owned listener and exact HTTP bindings. */
export async function observeBoundTargetHealth(config, claim, visibility, deps = {}) {
    requireValue((deps.effectiveUid || (() => process.geteuid?.()))() === 0, 'root_required');
    requireValue(['private', 'public'].includes(visibility), 'visibility_invalid');
    const inspect = deps.inspectProcess || processIdentity;
    const checkListener = deps.assertListenerOwned || assertListenerOwned;
    checkProcess(config, claim, inspect); checkListener(config, claim);
    const body = await fetchHealth(config.health[`${visibility}Url`], deps.fetch || fetch, deps.healthTimeoutMs);
    checkHealth(body, config, claim); checkProcess(config, claim, inspect); checkListener(config, claim);
    return Object.freeze({ body: Object.freeze(body), observedAt: Date.now() });
}
/** Observe actual target health and process, then CAS/fsync its bound receipt; does not open ingress or grant startup. */
export async function recordForwardTargetHealth(config, visibility, deps = {}) {
    requireValue((deps.effectiveUid || (() => process.geteuid?.()))() === 0, 'root_required');
    requireValue(['private', 'public'].includes(visibility), 'visibility_invalid');
    const read = deps.readRootRecord || rootRecord; const inspect = deps.inspectProcess || processIdentity;
    const before = withCutoverStateLock(config.controlRoot, () => snapshot(config, visibility, read));
    const observation = await observeBoundTargetHealth(config, before.claim, visibility, deps);
    return withCutoverStateLock(config.controlRoot, () => {
        const current = snapshot(config, visibility, read); requireValue(current.digest === before.digest, 'state_changed');
        checkProcess(config, current.claim, inspect);
        const receipt = { schema: 'nassaj-compatible-forward-health/v1', visibility, httpStatus: 200, health: 'ok',
            transactionId: current.journal.transactionId, claimId: current.claim.claimId,
            process: Object.fromEntries(['uid', 'pid', 'startTicks', 'bootId'].map(key => [key, current.claim[key]])),
            ...current.state.identity, serverBuildId: config.expected.serverBuildId, clientBuildId: config.expected.clientBuildId, observedAt: observation.observedAt };
        durableRecord(path.join(config.controlRoot, 'first-cutover.json'), { ...current.journal,
            phase: visibility === 'private' ? 'target_verified' : 'public_verified',
            forwardReceipts: { ...current.journal.forwardReceipts, [visibility]: receipt } });
        return receipt;
    });
}
