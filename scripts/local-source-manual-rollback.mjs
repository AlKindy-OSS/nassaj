/** Roll back one operation-bound local-source MANUAL handoff; dry-run unless --exec is explicit. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashTree } from './lib/source-update-tree-identity.mjs';
import { rollbackGenerations, validateCandidate } from './lib/source-update-activation.mjs';
import { inspectManualRecoveryRollbackState, MANUAL_ROLLBACK_ACTIVE_STATES,
    reconcileManualRecoveryRollback } from './lib/source-update-manual-rollback-db.mjs';
import { assertConfig, assertDatabaseFiles, openVerifiedRecoveryDatabase, pinnedFile, readPacket,
    recoveryDatabaseSchemaSha256 } from './local-source-recovery-operator.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = code => { throw new Error(`local_source_manual_rollback_${code}`); };
const DIRECTORIES = Object.freeze({ client: 'dist', server: 'dist-server', nodeModules: 'node_modules' });

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function guardedJson(file, { privateMode = true } = {}) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || fs.realpathSync(file) !== file || stat.size > 4 * 1024 * 1024
        || (privateMode ? (stat.mode & 0o777) !== 0o600 : Boolean(stat.mode & 0o022))) fail('unsafe_file');
    const bytes = fs.readFileSync(file);
    return { bytes, sha256: sha(bytes), value: JSON.parse(bytes) };
}

function processEnvelope(pid) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    const parentFields = fs.readFileSync(`/proc/${ppid}/stat`, 'utf8');
    return { pid, startTicks: fields[19], uid: fs.statSync(`/proc/${pid}`).uid, cwd: fs.realpathSync(`/proc/${pid}/cwd`),
        bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), ppid,
        parentStartTicks: parentFields.slice(parentFields.lastIndexOf(')') + 2).trim().split(/\s+/)[19],
        parentUid: fs.statSync(`/proc/${ppid}`).uid, parentExe: fs.realpathSync(`/proc/${ppid}/exe`) };
}

/**
 * Verify the separately owner-approved runtime rebind. The preparation PID is
 * intentionally NOT reused: this packet names the current old-code process,
 * and its digest participates in the owner acknowledgement.
 */
function readRuntimeRebinding(options, root, packet, binding) {
    const candidateRoot = path.join(root, '.git/nassaj-source-update/candidates', binding.transactionId);
    const file = path.resolve(options.runtimePacketPath || '');
    if (file !== path.join(candidateRoot, 'manual-rollback-runtime.json')) fail('runtime_packet_path');
    const record = guardedJson(file);
    if (!/^[a-f0-9]{64}$/.test(options.runtimePacketSha256 || '') || record.sha256 !== options.runtimePacketSha256) fail('runtime_packet_digest');
    const value = record.value, runtime = value.runtime;
    if (value.schema !== 'nassaj-local-source-manual-rollback-runtime/v1' || value.operation !== 'rebind-current-runtime'
        || value.root !== root || value.nodeIdentity !== os.hostname() || value.serviceUid !== process.getuid()
        || value.transactionId !== binding.transactionId || value.jobId !== binding.jobId || value.actionId !== binding.actionId
        || value.operationPacketSha256 !== options.packetSha256 || !/^[a-f0-9]{40}$/.test(value.operatorSourceOid || '') || !runtime
        || Object.keys(runtime).sort().join(',') !== ['bootId','clientBuildIdServed','cwd','databaseDev','databaseIno','parentExe',
            'parentStartTicks','parentUid','pid','ppid','serverBuildIdOnDisk','serverLoadedBuildId','serverLoadedOid','startTicks','uid']
            .sort().join(',')) fail('runtime_packet_scope');
    const dbStat = fs.lstatSync(packet.database.path);
    if (!Number.isSafeInteger(runtime.pid) || runtime.pid < 2 || !/^[1-9][0-9]*$/.test(runtime.startTicks || '')
        || runtime.uid !== process.getuid() || runtime.cwd !== root || runtime.databaseDev !== dbStat.dev
        || runtime.databaseIno !== dbStat.ino || runtime.databaseDev !== packet.database.dev
        || runtime.databaseIno !== packet.database.ino || typeof runtime.bootId !== 'string' || !runtime.bootId
        || !Number.isSafeInteger(runtime.ppid) || runtime.ppid < 2 || !/^[1-9][0-9]*$/.test(runtime.parentStartTicks || '')
        || runtime.parentUid !== process.getuid() || !path.isAbsolute(runtime.parentExe || '')) fail('runtime_packet_identity');
    return { file, sha256: record.sha256, value, runtime };
}

function assertRuntime(root, database, rebinding, binding, health, expected) {
    const current = rebinding.runtime;
    if (!health || health.status !== 'ok' || !Number.isSafeInteger(health.pid) || health.pid < 2
        || !/^[1-9][0-9]*$/.test(health.serverProcessStartTicks || '')) fail(`runtime_${expected.label}_changed`);
    const observed = processEnvelope(health.pid);
    if (health.pid !== current.pid || health.serverProcessStartTicks !== current.startTicks
        || Object.entries({ startTicks: current.startTicks, uid: current.uid, cwd: current.cwd, bootId: current.bootId,
            ppid: current.ppid, parentStartTicks: current.parentStartTicks, parentUid: current.parentUid, parentExe: current.parentExe })
            .some(([key, value]) => observed[key] !== value) || current.cwd !== root) {
        fail(expected.label === 'target' ? 'runtime_packet_identity' : `runtime_${expected.label}_changed`);
    }
    if (health.serverLoadedOid !== binding.previousRuntime.oid || health.serverLoadedBuildId !== binding.previousRuntime.serverBuildId
        || health.clientBuildIdServed !== expected.clientBuildId || health.serverBuildIdOnDisk !== expected.serverBuildId
        || health.updateMode !== 'release') fail(`runtime_${expected.label}_changed`);
    const dbStat = fs.lstatSync(database.path);
    if (dbStat.dev !== current.databaseDev || dbStat.ino !== current.databaseIno) fail('runtime_database_changed');
    const held = fs.readdirSync(`/proc/${health.pid}/fd`).some(name => {
        try { const stat = fs.statSync(`/proc/${health.pid}/fd/${name}`); return stat.dev === dbStat.dev && stat.ino === dbStat.ino; }
        catch { return false; }
    });
    if (!held) fail('database_not_held');
}

function healthExpectation(context) {
    const choose = (name, liveDirectory, targetBuildId, previousBuildId) => {
        const tree = hashTree(liveDirectory), target = context.manifest.trees[name], previous = context.binding.previousRuntime.actualTrees[name];
        if (same(tree, target)) return { buildId: targetBuildId, position: 'target' };
        if (same(tree, previous)) return { buildId: previousBuildId, position: 'previous' };
        fail(`${name}_generation_changed`);
    };
    const client = choose('client', context.validation.live.client, context.registration.expectedClientBuildId,
        context.binding.previousRuntime.clientBuildId);
    const server = choose('server', context.validation.live.server, context.registration.expectedServerBuildId,
        context.binding.previousRuntime.serverBuildId);
    return { clientBuildId: client.buildId, serverBuildId: server.buildId,
        label: client.position === server.position ? client.position : 'resume' };
}

async function readPrivateHealth(packet, injected) {
    if (injected.readHealth) return injected.readHealth(packet.privateHealthUrl);
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/health$/.test(packet.privateHealthUrl || '')) fail('health_url');
    const response = await fetch(packet.privateHealthUrl, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Cache-Control': 'no-cache' } });
    if (!response.ok) fail('health_unavailable');
    return response.json();
}

function observePreRollbackRuntime(root, packet, binding, registration, health) {
    if (!health || !Number.isSafeInteger(health.pid) || health.pid < 2 || !/^[1-9][0-9]*$/.test(health.serverProcessStartTicks || '')) fail('runtime_observation');
    const envelope = processEnvelope(health.pid);
    const runtime = { ...envelope,
        databaseDev: fs.lstatSync(packet.database.path).dev, databaseIno: fs.lstatSync(packet.database.path).ino,
        serverLoadedOid: health.serverLoadedOid, serverLoadedBuildId: health.serverLoadedBuildId,
        clientBuildIdServed: health.clientBuildIdServed, serverBuildIdOnDisk: health.serverBuildIdOnDisk };
    const rebinding = { runtime };
    assertRuntimeRebindingClaims(rebinding, binding, registration);
    assertRuntime(root, packet.database, rebinding, binding, health, { label: 'target',
        clientBuildId: registration.expectedClientBuildId, serverBuildId: registration.expectedServerBuildId });
    return runtime;
}

function durableExclusiveJson(file, value) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    if (fs.existsSync(file)) {
        const existing = guardedJson(file);
        if (!existing.bytes.equals(bytes)) fail('runtime_packet_collision');
        return { file, sha256: existing.sha256, reused: true };
    }
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return { file, sha256: sha(bytes), reused: false };
}

function assertJournal(journal, binding, registration, manifestSha256) {
    if (journal.value.schema !== 'nassaj-source-update-maintenance/v1'
        || journal.value.checksum !== sha(canonical(Object.fromEntries(Object.entries(journal.value).filter(([key]) => key !== 'checksum'))))) fail('journal_checksum');
    if (journal.value.state === 'OPEN') {
        if (journal.value.gateClosed || journal.value.phase !== null || journal.value.transactionId !== null
            || journal.value.identity !== null || journal.value.databaseState !== 'PRE_CANDIDATE'
            || journal.value.recovery !== 'ROLLED_BACK') fail('terminal_journal_changed');
        return 'terminal';
    }
    if (journal.value.state !== 'MANUAL' || journal.value.phase !== 'RESTARTING_HANDOFF' || journal.value.gateClosed !== true
        || journal.value.databaseState !== 'UNKNOWN' || journal.value.recoveryError !== 'update_database_state_unknown'
        || journal.value.owner !== null || journal.value.transactionId !== binding.transactionId
        || journal.value.identity?.expectedVersion !== registration.version
        || journal.value.identity?.originalHead !== registration.sourceOid
        || journal.value.identity?.targetCommit !== registration.sourceOid
        || journal.value.identity?.manifestSha256 !== manifestSha256) fail('journal_changed');
    return 'manual';
}

function readRegistration(db, packetSha256, binding) {
    const first = db.prepare('SELECT facts_json,facts_sha256 FROM source_update_receipts WHERE job_id=? AND sequence=1').get(binding.jobId);
    if (!first || sha(first.facts_json) !== first.facts_sha256) fail('registration_receipt_changed');
    const facts = JSON.parse(first.facts_json), { code, ...registration } = facts;
    if (code !== 'prepared_local_source_recovery' || registration.operationPacketSha256 !== packetSha256
        || registration.jobId !== binding.jobId || registration.actionId !== binding.actionId
        || registration.transactionId !== binding.transactionId || registration.ownerId !== binding.ownerId
        || !same(registration.operationBinding, binding)) fail('registration_changed');
    return registration;
}

function assertRuntimeRebindingClaims(rebinding, binding, registration) {
    const runtime = rebinding.runtime;
    if (runtime.serverLoadedOid !== binding.previousRuntime.oid
        || runtime.serverLoadedBuildId !== binding.previousRuntime.serverBuildId
        || runtime.clientBuildIdServed !== registration.expectedClientBuildId
        || runtime.serverBuildIdOnDisk !== registration.expectedServerBuildId) fail('runtime_packet_claims');
}

/** Pin a clean tracked checkout descended from the originally registered source. */
function assertOperatorSource(root, sourceOid, expectedOperatorSourceOid) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[a-f0-9]{40}$/.test(head)
        || (expectedOperatorSourceOid !== undefined && head !== expectedOperatorSourceOid)) fail('source_head_changed');
    const tracked = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (tracked !== '') fail('source_tracked_dirty');
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', sourceOid, head], {
            cwd: root, stdio: ['ignore', 'ignore', 'ignore'],
        });
    } catch { fail('source_not_descendant'); }
    return head;
}

function validateFiles(context) {
    const { root, packet, binding, registration, candidateRoot, operatorSourceOid } = context;
    if (binding.previousSourceOid !== registration.sourceOid) fail('source_registration_changed');
    const observedOperatorSourceOid = assertOperatorSource(root, registration.sourceOid, operatorSourceOid);
    assertConfig(root, packet);
    for (const name of ['local-recovery-mode-intent.json', 'local-recovery-original.env']) {
        if (fs.existsSync(path.join(candidateRoot, name))) fail('mode_effect_present');
    }
    const manifest = JSON.parse(pinnedFile(registration.manifestPath, registration.manifestSha256));
    if (!same(manifest.operationBinding, binding) || registration.manifestSha256 !== packet.manifestSha256) fail('manifest_changed');
    const actionPath = path.join(candidateRoot, 'activation-action.json');
    const actionRecord = guardedJson(actionPath), action = actionRecord.value;
    if (sha(JSON.stringify(action)) !== registration.activationIdentitySha256 || action.transactionId !== binding.transactionId
        || action.manifestPath !== registration.manifestPath || action.manifestSha256 !== registration.manifestSha256
        || action.originalHead !== registration.sourceOid || action.targetCommit !== registration.sourceOid
        || action.expectedServerBuildId !== registration.expectedServerBuildId) fail('action_changed');
    const validation = validateCandidate({ projectRoot: root, candidateRoot, transactionId: binding.transactionId,
        releaseCommit: registration.sourceOid, version: registration.version, manifestPath: registration.manifestPath,
        manifestSha256: registration.manifestSha256 });
    const activation = guardedJson(path.join(candidateRoot, 'activation-receipt.json'));
    if (activation.value.schemaVersion !== 1 || activation.value.txId !== binding.transactionId
        || !['exchanged', 'rolled_back'].includes(activation.value.state)) fail('activation_receipt_changed');
    for (const name of Object.keys(DIRECTORIES)) {
        if (!same(activation.value.previous?.[name], binding.previousRuntime.actualTrees[name])
            || !same(activation.value.steps?.[name]?.previous, binding.previousRuntime.actualTrees[name])) fail('previous_tree_changed');
    }
    return { action, manifest, validation, activation, operatorSourceOid: observedOperatorSourceOid };
}

function acquireLock(file) {
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
            || fs.realpathSync(file) !== file) fail('lock_unsafe');
        execFileSync('/usr/bin/flock', ['-x', '-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
        return fd;
    } catch (error) { fs.closeSync(fd); if (String(error?.message || '').startsWith('local_source_')) throw error; return fail('lock_contended'); }
}

/**
 * Exclusive admission + activity locks are the source-update writer fence for
 * every observation and effect below. They do not fence PM2 or arbitrary host
 * processes, so /proc, health and the DB inode are re-attested at each phase.
 */
async function withLocks(controlRoot, operation) {
    const admission = acquireLock(path.join(controlRoot, 'admission.lock'));
    let activity;
    try { activity = acquireLock(path.join(controlRoot, 'activity.lock')); return await operation(); }
    finally { if (activity !== undefined) fs.closeSync(activity); fs.closeSync(admission); }
}

function durableJournalOpen(file, expected) {
    const current = guardedJson(file);
    if (current.sha256 !== expected.sha256 || current.value.sequence !== expected.value.sequence) fail('journal_cas');
    const now = Date.now(), metrics = current.value.metrics && typeof current.value.metrics === 'object' ? current.value.metrics : {};
    const next = { ...current.value, state: 'OPEN', gateClosed: false, phase: null, databaseState: 'PRE_CANDIDATE',
        recovery: 'ROLLED_BACK', recoveryError: null, transactionId: null, identity: null, owner: null,
        metrics: { ...metrics, downtimeMs: Number.isSafeInteger(metrics.closedAtMs) ? Math.max(0, now - metrics.closedAtMs) : null,
            interventionsRequired: (Number.isSafeInteger(metrics.interventionsRequired) ? metrics.interventionsRequired : 0) + 1,
            automaticRepairs: Number.isSafeInteger(metrics.automaticRepairs) ? metrics.automaticRepairs : 0,
            intervention: 'human', reachedManual: true },
        sequence: current.value.sequence + 1, updatedAt: new Date(now).toISOString() };
    delete next.degraded; delete next.exitPath; delete next.reopenRefusedReason;
    next.checksum = sha(canonical(Object.fromEntries(Object.entries(next).filter(([key]) => key !== 'checksum'))));
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`, fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return next;
}

function removeHandoff(file, binding) {
    if (!fs.existsSync(file)) return false;
    const handoff = guardedJson(file);
    if (handoff.value.schema !== 'nassaj-source-update-bootstrap/v1' || handoff.value.transactionId !== binding.transactionId) fail('handoff_changed');
    fs.unlinkSync(file);
    const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return true;
}

function defaultRepository() {
    return { inspect: inspectManualRecoveryRollbackState, reconcile: reconcileManualRecoveryRollback,
        activeStates: MANUAL_ROLLBACK_ACTIVE_STATES };
}

function assertTerminalDatabase(db, binding, packetSha256, runtimePacketSha256, ownerAck) {
    const job = db.prepare('SELECT state,auto_activate,transaction_id,activation_identity_sha256 FROM source_update_jobs WHERE id=?').get(binding.jobId);
    const action = db.prepare('SELECT status,error,source_update_job_id,source_update_transaction_id FROM pending_server_actions WHERE id=?').get(binding.actionId);
    const receipts = db.prepare("SELECT facts_json,facts_sha256 FROM source_update_receipts WHERE job_id=? AND phase='rolled_back' AND kind='recovery'").all(binding.jobId);
    if (job?.state !== 'rolled_back' || job.auto_activate !== 1 || job.transaction_id !== binding.transactionId
        || action?.status !== 'superseded' || action.error !== 'local_source_manual_rollback'
        || action.source_update_job_id !== binding.jobId || action.source_update_transaction_id !== binding.transactionId
        || receipts.length !== 1 || sha(receipts[0].facts_json) !== receipts[0].facts_sha256) fail('terminal_database_changed');
    const facts = JSON.parse(receipts[0].facts_json);
    if (facts.code !== 'local_source_manual_rollback' || facts.jobId !== binding.jobId || facts.actionId !== binding.actionId
        || facts.transactionId !== binding.transactionId || facts.operationPacketSha256 !== packetSha256
        || facts.runtimePacketSha256 !== runtimePacketSha256
        || facts.ownerAck !== ownerAck) fail('terminal_receipt_changed');
}

/** Observe the fenced current process and durably create the only accepted runtime-rebinding packet. */
export async function prepareRuntimeRebinding(options, injected = {}) {
    const packetContext = readPacket(options), { root, packet, packetSha256 } = packetContext;
    const binding = packet.operationBinding, controlRoot = path.join(root, '.git/nassaj-source-update');
    return withLocks(controlRoot, async () => {
        readPacket(options); assertDatabaseFiles(packet.database);
        const db = openVerifiedRecoveryDatabase(packet.database);
        let registration;
        try { registration = readRegistration(db, packetSha256, binding); } finally { db.close(); }
        const candidateRoot = path.dirname(registration.manifestPath);
        const base = { root, packet, packetSha256, binding, registration, candidateRoot };
        const files = validateFiles(base), journal = guardedJson(path.join(controlRoot, 'journal.json'));
        if (assertJournal(journal, binding, registration, registration.manifestSha256) !== 'manual'
            || files.activation.value.state !== 'exchanged'
            || !Object.values(files.activation.value.steps).every(step => step.state === 'exchanged')) fail('runtime_prepare_state');
        const context = { ...base, ...files, journal, journalState: 'manual' };
        if (healthExpectation(context).label !== 'target') fail('runtime_prepare_generations');
        const repository = injected.repository || defaultRepository();
        if (typeof repository.inspect !== 'function' || !Array.isArray(repository.activeStates)) fail('repository_contract');
        const preflightDb = openVerifiedRecoveryDatabase(packet.database);
        try {
            if (repository.inspect(preflightDb, registration, repository.activeStates).state !== 'ready') fail('runtime_prepare_database');
        } finally { preflightDb.close(); }
        const health = await readPrivateHealth(packet, injected);
        const runtime = observePreRollbackRuntime(root, packet, binding, registration, health);
        assertOperatorSource(root, registration.sourceOid, files.operatorSourceOid);
        const value = { schema: 'nassaj-local-source-manual-rollback-runtime/v1', operation: 'rebind-current-runtime',
            root, nodeIdentity: os.hostname(), serviceUid: process.getuid(), transactionId: binding.transactionId,
            jobId: binding.jobId, actionId: binding.actionId, operationPacketSha256: packetSha256,
            operatorSourceOid: files.operatorSourceOid, runtime };
        const result = durableExclusiveJson(path.join(candidateRoot, 'manual-rollback-runtime.json'), value);
        return { ...result, transactionId: binding.transactionId,
            ownerAck: `rollback:${binding.transactionId}:${packetSha256}:${result.sha256}` };
    });
}

/** Inspect or execute a crash-idempotent rollback. No source, database restore, mode change, or restart is performed. */
export async function manualRollback(options, injected = {}) {
    const packetContext = readPacket(options), { root, packet, packetSha256 } = packetContext;
    const binding = packet.operationBinding, rebinding = readRuntimeRebinding(options, root, packet, binding);
    const expectedAck = `rollback:${binding.transactionId}:${packetSha256}:${rebinding.sha256}`;
    if (options.exec === true && options.ownerAck !== expectedAck) fail('owner_ack_required');
    const controlRoot = path.join(root, '.git/nassaj-source-update');
    return withLocks(controlRoot, async () => {
        readPacket(options);
        if (readRuntimeRebinding(options, root, packet, binding).sha256 !== rebinding.sha256) fail('runtime_packet_changed');
        assertDatabaseFiles(packet.database);
        const db = openVerifiedRecoveryDatabase(packet.database);
        let registration;
        try { registration = readRegistration(db, packetSha256, binding); }
        finally { db.close(); }
        assertRuntimeRebindingClaims(rebinding, binding, registration);
        const candidateRoot = path.dirname(registration.manifestPath);
        const base = { root, packet, packetSha256, binding, registration, candidateRoot,
            operatorSourceOid: rebinding.value.operatorSourceOid };
        const files = validateFiles(base), journal = guardedJson(path.join(controlRoot, 'journal.json'));
        const journalState = assertJournal(journal, binding, registration, registration.manifestSha256);
        const context = { ...base, ...files, journal, journalState, rebinding };
        const health = await readPrivateHealth(packet, injected);
        const initialHealthExpectation = healthExpectation(context);
        const freshExchange = files.activation.value.state === 'exchanged'
            && Object.values(files.activation.value.steps).every(step => step.state === 'exchanged');
        if (freshExchange && initialHealthExpectation.label !== 'target') fail('pre_generations_changed');
        assertRuntime(root, packet.database, rebinding, binding, health, initialHealthExpectation);
        const repository = injected.repository || defaultRepository();
        if (typeof repository.inspect !== 'function' || typeof repository.reconcile !== 'function'
            || !Array.isArray(repository.activeStates)) fail('repository_contract');
        const preflightDb = openVerifiedRecoveryDatabase(packet.database);
        let databaseState;
        try { databaseState = repository.inspect(preflightDb, registration, repository.activeStates).state; } finally { preflightDb.close(); }
        if (journalState === 'terminal' && databaseState !== 'settled') fail('journal_database_disagree');
        if (journalState === 'terminal') {
            if (fs.existsSync(path.join(controlRoot, 'bootstrap-handoff.json'))) fail('terminal_handoff_present');
            const terminalDb = openVerifiedRecoveryDatabase(packet.database);
            try { assertTerminalDatabase(terminalDb, binding, packetSha256, rebinding.sha256, expectedAck); } finally { terminalDb.close(); }
        }
        const stages = ['physical_rollback', 'database_cas', 'handoff_removed', 'open'];
        if (options.exec !== true) return { dryRun: true, transactionId: binding.transactionId,
            jobId: binding.jobId, actionId: binding.actionId, ownerAck: expectedAck, stages };
        if (journalState === 'terminal') {
            return { dryRun: false, reused: true, transactionId: binding.transactionId,
                jobId: binding.jobId, actionId: binding.actionId, stages };
        }
        if (context.activation.value.state !== 'rolled_back') rollbackGenerations(context.validation, { exchange: injected.exchange,
            afterExchange: injected.afterExchange, afterStep: injected.afterStep });
        injected.afterStage?.('physical_rollback');
        const rolled = validateFiles(context);
        if (rolled.activation.value.state !== 'rolled_back') fail('rollback_receipt_missing');
        for (const [name, directory] of Object.entries(DIRECTORIES)) {
            if (!same(hashTree(path.join(root, directory)), binding.previousRuntime.actualTrees[name])) fail('rollback_tree_changed');
        }
        const postCasHealth = await readPrivateHealth(packet, injected);
        const previousHealth = { label: 'previous', clientBuildId: binding.previousRuntime.clientBuildId,
            serverBuildId: binding.previousRuntime.serverBuildId };
        assertRuntime(root, packet.database, rebinding, binding, postCasHealth, previousHealth);
        const evidenceSha256 = sha(JSON.stringify({ packetSha256, runtimePacketSha256: rebinding.sha256, journalSha256: journal.sha256,
            activationReceiptSha256: rolled.activation.sha256, previousTrees: binding.previousRuntime.actualTrees,
            runtime: { pid: postCasHealth.pid, startTicks: postCasHealth.serverProcessStartTicks, oid: postCasHealth.serverLoadedOid,
                serverBuildId: postCasHealth.serverLoadedBuildId, clientBuildId: postCasHealth.clientBuildIdServed,
                serverBuildIdOnDisk: postCasHealth.serverBuildIdOnDisk } }));
        const mutationDb = openVerifiedRecoveryDatabase(packet.database);
        let dbResult;
        try {
            dbResult = repository.reconcile(mutationDb, { registration, operationPacketSha256: packetSha256,
                runtimePacketSha256: rebinding.sha256,
                ownerAck: options.ownerAck, evidenceSha256 }, repository.activeStates, () => {
                assertDatabaseFiles(packet.database);
                if (recoveryDatabaseSchemaSha256(mutationDb) !== packet.database.schemaSha256) fail('database_schema_changed');
                const current = guardedJson(path.join(controlRoot, 'journal.json'));
                if (current.sha256 !== journal.sha256) fail('journal_cas');
                assertRuntime(root, packet.database, rebinding, binding, postCasHealth, previousHealth);
                validateFiles(context);
            });
        } finally { mutationDb.close(); }
        injected.afterStage?.('database_cas');
        removeHandoff(path.join(controlRoot, 'bootstrap-handoff.json'), binding);
        injected.afterStage?.('handoff_removed');
        injected.afterStage?.('before_open');
        const finalHealth = await readPrivateHealth(packet, injected);
        assertRuntime(root, packet.database, rebinding, binding, finalHealth, previousHealth);
        validateFiles(context);
        const finalDb = openVerifiedRecoveryDatabase(packet.database);
        try {
            if (repository.inspect(finalDb, registration, repository.activeStates).state !== 'settled') fail('database_not_settled');
            assertTerminalDatabase(finalDb, binding, packetSha256, rebinding.sha256, expectedAck);
        } finally { finalDb.close(); }
        durableJournalOpen(path.join(controlRoot, 'journal.json'), journal);
        return { dryRun: false, reused: dbResult.reused, transactionId: binding.transactionId,
            jobId: binding.jobId, actionId: binding.actionId, stages };
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void (async () => {
        const args = process.argv.slice(2), value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
        try {
            const common = { root: value('--root'), packetPath: value('--packet'), packetSha256: value('--packet-sha256') };
            const result = args.includes('--prepare-runtime') ? await prepareRuntimeRebinding(common) : await manualRollback({ ...common,
                runtimePacketPath: value('--runtime-packet'), runtimePacketSha256: value('--runtime-packet-sha256'),
                ownerAck: value('--owner-ack'), exec: args.includes('--exec') });
            process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
        } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
    })();
}
