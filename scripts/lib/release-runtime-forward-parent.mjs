/** Asynchronous root parent for the fixed forward child. No authority callback comes from a request. */
import { assertForwardResolvedSupervisorHistory } from './release-runtime-forward-supervisor.mjs';
import { spawn } from 'node:child_process';
import { createPublicKey, verify, createHash, randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readForwardChildMaterial, readPinnedForwardRecord } from '../release-runtime-forward-child.mjs';
import { withCutoverStateLock } from './release-runtime-cutover.mjs';
import { assertForwardFrameKeys, assertForwardServiceIdentity, canonicalForwardValue, forwardValueSha256,
    inspectForwardChildIdentity } from './release-runtime-forward-child-protocol.mjs';
import { readForwardRootRecord, verifyForwardRetirement } from './release-runtime-forward-retirement.mjs';

function requireValue(ok, reason) { if (!ok) throw Error(`forward_parent_${reason}`); }
function persist(file, value) {
    const temporary = `${file}.partial-${randomUUID()}`; const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file); const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function operatorLock(config) {
    const lock = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.lock'));
    const current = inspectForwardChildIdentity(process.pid);
    requireValue(lock.schema === 'nassaj-cutover-lock/v1' && lock.pid === current.pid && lock.startTime === current.startTicks, 'operator_lock_missing');
    return lock;
}
/** Verify the original owner signature and immutable acceptance time against the root transaction. */
export function verifyForwardOwner(config, journal) {
    const approval = readForwardRootRecord(config.bootstrapClaim.approvalFile); const { signature, ...payload } = approval;
    const keyFile = config.bootstrapClaim.ownerApprovalPublicKeyFile; const info = fs.lstatSync(keyFile);
    requireValue(info.uid === 0 && info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o022) && fs.realpathSync(keyFile) === keyFile, 'key_unsafe');
    const key = createPublicKey(fs.readFileSync(keyFile)); const keySha = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    requireValue(key.asymmetricKeyType === 'ed25519' && keySha === config.expected.ownerApprovalKeySha256
        && payload.action === 'release-runtime-first-cutover' && payload.schema === 'nassaj-owner-cutover-approval/v1'
        && payload.expectedSha256 === forwardValueSha256(config.expected)
        && forwardValueSha256(payload.startupAdmission) === forwardValueSha256(config.bootstrapClaim.identity)
        && verify(null, Buffer.from(canonicalForwardValue(payload)), key, Buffer.from(signature, 'base64url'))
        && journal.approvalSha256 === forwardValueSha256(approval) && Number.isSafeInteger(journal.approvalAcceptedAt)
        && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt)
        && payload.expiresAt > payload.issuedAt && payload.expiresAt - payload.issuedAt <= 300000
        && journal.approvalAcceptedAt >= payload.issuedAt && journal.approvalAcceptedAt < payload.expiresAt
        && journal.approvalAcceptedAt <= Date.now(), 'owner_approval_invalid');
}
function assertPrestartAuthority(config, journal) {
    const state = readForwardRootRecord(path.join(config.controlRoot, 'startup-admission.json'));
    const host = readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json'));
    requireValue(state.state === 'switching' && state.generationEpoch === journal.forwardAdmission?.generationEpoch
        && state.revision === journal.forwardAdmission.revision && forwardValueSha256(state) === journal.forwardAdmission.sha256
        && host.gateActive === true && !state.lastClaim && !state.managedOperationId
        && !['revocation', 'transitionReason', 'potentiallyRunningClaim'].some(key => Object.hasOwn(state, key))
        && !journal.initialStartWindow && !journal.initialTargetProcess && !journal.targetSlotBinding, 'prestart_authority_lost');
}
function observationLease(config, material, states = ['prepared']) {
    const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json'));
    verifyForwardOwner(config, journal); assertPrestartAuthority(config, journal);
    const lease = journal.forwardObservationReconciliation;
    assertForwardResolvedSupervisorHistory(journal);
    requireValue(lease.hostStateSha256 === forwardValueSha256(readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json'))), 'observation_host_changed');
    const actual = inspectForwardChildIdentity(process.pid);
    const now = Math.floor(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000);
    readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.lock'));
    const lockSha = forwardValueSha256(fs.readFileSync(path.join(config.controlRoot, 'first-cutover.lock')).toString('base64'));
    requireValue(material.purpose === 'observe-target' && material.observationAuthority?.authority === 'reconcile-observation'
        && lease?.schema === 'nassaj-forward-observation-reconciliation/v1' && states.includes(lease.state)
        && lease.nonce === material.attemptNonce && lease.owner.pid === actual.pid && lease.owner.startTicks === actual.startTicks
        && lease.owner.bootId === actual.bootId && actual.uids.every(uid => uid === 0) && now < lease.expiresAtBootMs
        && lease.abandonedLockSha256 === lockSha && lease.originalOperatorSha256 === forwardValueSha256(journal.operator)
        && lease.originalIntentSha256 === forwardValueSha256(journal.forwardMigrationIntent)
        && lease.migrationResultSha256 === forwardValueSha256(journal.forwardMigrationResult)
        && lease.expectedTargetSha256 === forwardValueSha256(material.contract.target), 'observation_lease_invalid');
    return journal;
}
function loadIntent(config, material) {
    const journal = material.observationAuthority ? observationLease(config, material) : readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json'));
    if (!material.observationAuthority) operatorLock(config); verifyForwardOwner(config, journal); assertPrestartAuthority(config, journal);
    requireValue(journal.state === 'running' && journal.phase === (material.purpose === 'observe-target' ? 'migration_observed' : 'migration_intent')
        && forwardValueSha256(journal.expected) === forwardValueSha256(config.expected)
        && forwardValueSha256(journal.forwardMigrationIntent) === material.originalIntentSha256
        && (material.observationAuthority ? journal.forwardObservationReconciliation.state === 'prepared' : material.purpose === 'observe-target' ? (!journal.forwardObservationAuthorization
            && journal.forwardObservationIntent?.attemptNonce === material.attemptNonce
            && journal.forwardObservationIntent.migrationResultSha256 === forwardValueSha256(journal.forwardMigrationResult))
            : !journal.forwardChildAuthorization), 'intent_changed_or_consumed');
    return journal;
}
function databaseOwnership(material) {
    for (const file of [material.request.database.realpath, `${material.request.database.realpath}-wal`, `${material.request.database.realpath}-shm`]) {
        let info; try { info = fs.lstatSync(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT' && file !== material.request.database.realpath) continue; throw error; }
        requireValue(info.isFile() && !info.isSymbolicLink() && fs.realpathSync(file) === file
            && info.uid === BigInt(material.serviceIdentity.uid) && info.gid === BigInt(material.serviceIdentity.gid), 'database_ownership_mismatch');
        if (file === material.request.database.realpath) requireValue(String(info.dev) === material.request.database.device
            && String(info.ino) === material.request.database.inode, 'database_identity_mismatch');
    }
}
function childReady(frame, material, child) {
    assertForwardFrameKeys(frame, 'schema,transactionId,attemptNonce,challenge,pid,startTicks,bootId,uid,gid,supplementaryGids,requestSha256,migrationClosureSha256' + (material.purpose === 'observe-target' ? ',observationAuthority' : ''));
    const actual = inspectForwardChildIdentity(child.pid); assertForwardServiceIdentity(actual, material.serviceIdentity);
    requireValue(frame.schema === (material.purpose === 'observe-target' ? 'nassaj-forward-observation-ready/v1' : 'nassaj-forward-child-ready/v1') && /^[a-f0-9]{64}$/.test(frame.challenge)
        && actual.parentPid === process.pid && frame.pid === actual.pid && frame.startTicks === actual.startTicks && frame.bootId === actual.bootId
        && frame.uid === material.serviceIdentity.uid && frame.gid === material.serviceIdentity.gid
        && canonicalForwardValue(frame.supplementaryGids) === canonicalForwardValue(actual.supplementaryGids)
        && ['transactionId', 'attemptNonce', 'requestSha256', 'migrationClosureSha256'].every(key => frame[key] === material[key])
        && (material.purpose !== 'observe-target' || forwardValueSha256(frame.observationAuthority) === forwardValueSha256(material.observationAuthority)), 'child_binding_invalid');
    return actual;
}
async function authorize(config, material, child, frame, deps = {}) {
    childReady(frame, material, child); const before = loadIntent(config, material); const proof = await verifyForwardRetirement(config, before, deps.retirement);
    if (material.observationAuthority) requireValue(forwardValueSha256(proof) === before.forwardObservationReconciliation.inhibitorProofSha256, 'observation_inhibitors_changed');
    return withCutoverStateLock(config.controlRoot, () => {
        const journal = loadIntent(config, material); childReady(frame, material, child);
        requireValue(forwardValueSha256(journal) === forwardValueSha256(before), 'journal_changed');
        const revision = journal.revision + 1; requireValue(Number.isSafeInteger(revision), 'revision_invalid');
        const { schema: _schema, ...bindings } = frame;
        const permit = { schema: material.purpose === 'observe-target' ? 'nassaj-forward-observation-permit/v1' : 'nassaj-forward-child-permit/v1', decision: 'authorized', ...bindings, revision,
            databaseContractSha256: material.databaseContractSha256, originalIntentSha256: material.originalIntentSha256,
            resumeOriginalIntent: false };
        const authorization = { ...permit, challengeSha256: forwardValueSha256(frame.challenge) };
        persist(path.join(config.controlRoot, 'first-cutover.json'), material.observationAuthority
            ? { ...journal, revision, forwardObservationReconciliation: { ...journal.forwardObservationReconciliation, state: 'child_authorized',
                child: { pid: frame.pid, startTicks: frame.startTicks, bootId: frame.bootId }, authorization } }
            : material.purpose === 'observe-target'
            ? { ...journal, revision, forwardObservationAuthorization: authorization }
            : { ...journal, revision, phase: 'migration_child_authorized', forwardChildAuthorization: authorization });
        return permit;
    });
}
function validateResult(frame, ready, material) {
    assertForwardFrameKeys(frame, 'schema,transactionId,attemptNonce,challenge,pid,startTicks,bootId,requestSha256,result' + (material.purpose === 'observe-target' ? ',observationAuthority' : ''));
    requireValue(frame.schema === (material.purpose === 'observe-target' ? 'nassaj-forward-observation-result/v1' : 'nassaj-forward-child-result/v1')
        && ['transactionId', 'attemptNonce', 'challenge', 'pid', 'startTicks', 'bootId', 'requestSha256'].every(key => frame[key] === ready[key]), 'result_identity');
    if (material.purpose === 'observe-target') requireValue(forwardValueSha256(frame.observationAuthority) === forwardValueSha256(material.observationAuthority), 'observation_result_authority');
    const result = frame.result;
    if (material.purpose === 'observe-target') {
        assertForwardFrameKeys(result, 'schema,transactionId,databaseContractSha256,database,observedTarget');
        requireValue(result.schema === 'nassaj-compatible-forward-target-observation/v1'
            && result.transactionId === material.transactionId && result.databaseContractSha256 === material.databaseContractSha256
            && forwardValueSha256(result.database) === forwardValueSha256(material.request.database)
            && forwardValueSha256(result.observedTarget) === forwardValueSha256(material.contract.target), 'observation_result_invalid');
        return;
    }
    assertForwardFrameKeys(result, 'schema,transactionId,databaseContractSha256,observedBefore,observedAfter,outcome');
    requireValue(result.schema === 'nassaj-compatible-forward-migration-result/v1' && result.transactionId === material.transactionId
        && result.databaseContractSha256 === material.databaseContractSha256 && result.outcome === 'applied'
        && forwardValueSha256(result.observedBefore) === forwardValueSha256(material.contract.source)
        && forwardValueSha256(result.observedAfter) === forwardValueSha256(material.contract.target), 'result_invalid');
}
/** Produce the first migration intent from verified retirement and immutable request/contract material. */
export async function prepareForwardMigrationIntent(config, deps = {}) {
    requireValue(process.geteuid?.() === 0, 'root_required'); operatorLock(config);
    const file = path.join(config.controlRoot, 'first-cutover.json'); const before = readForwardRootRecord(file);
    verifyForwardOwner(config, before); assertPrestartAuthority(config, before);
    requireValue(before.state === 'running' && before.phase === 'retirement_verified' && !before.forwardMigrationIntent
        && !before.forwardChildAuthorization && forwardValueSha256(before.expected) === forwardValueSha256(config.expected), 'retirement_phase_invalid');
    await verifyForwardRetirement(config, before, deps.retirement);
    const settings = config.forwardMigration; const identity = config.bootstrapClaim.identity;
    const request = readPinnedForwardRecord(settings.request); const contract = readPinnedForwardRecord(settings.contract);
    assertForwardFrameKeys(request, 'schema,transactionId,releaseIdentitySha256,databaseContractSha256,database,expectedPhase');
    assertForwardFrameKeys(request.database, 'realpath,device,inode');
    requireValue(request.schema === 'nassaj-compatible-forward-request/v1' && request.expectedPhase === 'migration'
        && request.transactionId === before.transactionId && request.releaseIdentitySha256 === identity.releaseIdentitySha256
        && request.databaseContractSha256 === identity.databaseContractSha256
        && forwardValueSha256(contract) === identity.databaseContractSha256
        && request.database.realpath === config.databaseFile && request.database.device === identity.databaseDev
        && request.database.inode === identity.databaseIno && contract.schema === 'nassaj-database-release-contract/v2'
        && /^[a-f0-9]{64}$/.test(contract.migrationClosureSha256 || '')
        && settings.closure.sha256 === config.expected.forwardExecutableClosureSha256, 'migration_material_invalid');
    const intent = { schema: 'nassaj-forward-migration-intent/v1', transactionId: before.transactionId,
        attemptNonce: randomBytes(32).toString('hex'), requestSha256: forwardValueSha256(request),
        databaseContractSha256: identity.databaseContractSha256, migrationClosureSha256: contract.migrationClosureSha256,
        rootExecutableClosureSha256: settings.closure.sha256, retirementReceiptSha256: before.forwardRetirement.factsSha256 };
    return withCutoverStateLock(config.controlRoot, () => {
        operatorLock(config); const current = readForwardRootRecord(file); verifyForwardOwner(config, current); assertPrestartAuthority(config, current);
        requireValue(forwardValueSha256(current) === forwardValueSha256(before), 'retirement_changed');
        const revision = current.revision + 1; requireValue(Number.isSafeInteger(revision), 'revision_invalid');
        const next = { ...current, phase: 'migration_intent', revision, forwardMigrationIntent: intent };
        persist(file, next); return next;
    });
}

/** Consume a fresh migration intent once; an ambiguous/lost reply leaves it consumed for governed recovery. */
export async function runForwardMigrationChild(config, purpose = 'migration', deps = {}) {
    requireValue(process.geteuid?.() === 0, 'root_required');
    const material = readForwardChildMaterial(purpose);
    requireValue(material.configurationSha256 === forwardValueSha256(config), 'configuration_changed');
    const initial = loadIntent(config, material); await verifyForwardRetirement(config, initial, deps.retirement); databaseOwnership(material);
    const child = spawn(material.node, [material.wrapper, ...(purpose === 'observe-target' ? ['--observe-target'] : [])], { cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    let ready = null; let result = null; let buffer = ''; let diagnostics = 0; let timer; let stopTimer; let authorization; let failure = null; let normalExit = false;
    try {
        await new Promise((resolve, reject) => {
            const fail = error => {
                if (failure) return; failure = error; child.kill('SIGTERM');
                stopTimer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
            };
            timer = setTimeout(() => fail(Error('forward_parent_handshake_timeout')), 10000);
            child.on('error', error => { if (!child.pid) reject(error); else fail(error); });
            for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { diagnostics += bytes.length; if (diagnostics > 65536) fail(Error('forward_parent_diagnostics_large')); });
            let authorizing = false;
            child.stdio[4].on('data', async bytes => {
                if (failure) return;
                try {
                    requireValue(!authorizing, 'frame_before_permit');
                    buffer += bytes.toString('utf8'); requireValue(Buffer.byteLength(buffer) <= 16384, 'frame_large');
                    const newline = buffer.indexOf('\n'); if (newline < 0) return;
                    requireValue(newline === buffer.length - 1, 'frame_trailing');
                    const frame = JSON.parse(buffer.slice(0, -1)); buffer = '';
                    if (!ready) {
                        authorizing = true; ready = frame; authorization = await authorize(config, material, child, frame, deps);
                        requireValue(!failure, 'authorization_timed_out'); authorizing = false;
                        clearTimeout(timer); timer = setTimeout(() => fail(Error('forward_parent_migration_timeout')), purpose === 'observe-target' ? 10000 : 300000);
                        child.stdio[3].end(`${JSON.stringify(authorization)}\n`);
                    } else { requireValue(!result, 'duplicate_result'); validateResult(frame, ready, material); result = frame; }
                } catch (error) { fail(error); }
            });
            child.on('close', (code, signal) => {
                if (failure) reject(failure);
                else if (code !== 0 || signal || !result || buffer) reject(Error('forward_parent_child_exit_uncertain')); else resolve();
            });
        });
        normalExit = true;
        const current = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json'));
        const proof = await verifyForwardRetirement(config, current, deps.retirement);
        if (material.observationAuthority) requireValue(forwardValueSha256(proof) === current.forwardObservationReconciliation.inhibitorProofSha256, 'observation_inhibitors_changed');
        databaseOwnership(material);
        if (material.observationAuthority) observationLease(config, material, ['child_authorized']); else operatorLock(config);
        return withCutoverStateLock(config.controlRoot, () => {
            const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json'));
            assertPrestartAuthority(config, journal);
            if (material.observationAuthority) observationLease(config, material, ['child_authorized']);
            const currentAuthorization = material.observationAuthority ? journal.forwardObservationReconciliation.authorization
                : purpose === 'observe-target' ? journal.forwardObservationAuthorization : journal.forwardChildAuthorization;
            requireValue(journal.phase === (purpose === 'observe-target' ? 'migration_observed' : 'migration_child_authorized') && currentAuthorization?.challenge === ready.challenge
                && journal.revision === authorization.revision && forwardValueSha256(journal) === forwardValueSha256(current), 'completion_changed');
            const observed = material.observationAuthority ? { ...journal, revision: journal.revision + 1,
                forwardObservationReconciliation: { ...journal.forwardObservationReconciliation, state: 'observed', result, resultSha256: forwardValueSha256(result) } }
                : purpose === 'observe-target' ? { ...journal, revision: journal.revision + 1, forwardTargetObservation: result }
                : { ...journal, revision: journal.revision + 1, phase: 'migration_observed', forwardMigrationResult: result };
            persist(path.join(config.controlRoot, 'first-cutover.json'), observed); return observed;
        });
    } catch (error) {
        if (normalExit && result && material.observationAuthority) recordObservationDiagnostic(config, material, result);
        throw error;
    } finally { clearTimeout(timer); clearTimeout(stopTimer); for (const stream of [child.stdout, child.stderr, child.stdio[3], child.stdio[4]]) stream.destroy(); }
}

function recordObservationDiagnostic(config, material, result) {
    withCutoverStateLock(config.controlRoot, () => {
        const file = path.join(config.controlRoot, 'first-cutover.json'); const journal = readForwardRootRecord(file);
        const lease = journal.forwardObservationReconciliation;
        // A stale child may record evidence only against its unchanged consumed lease, never a new owner/nonce.
        if (lease?.state !== 'child_authorized' || lease.nonce !== material.attemptNonce
            || lease.authorization?.challenge !== result.challenge || lease.child?.pid !== result.pid
            || lease.child.startTicks !== result.startTicks || lease.child.bootId !== result.bootId || lease.diagnostic) return;
        proveObservationProcessDead(lease.child);
        const diagnostic = { schema: 'nassaj-forward-observation-diagnostic/v1', decision: 'diagnosis_only',
            nonce: lease.nonce, result, resultSha256: forwardValueSha256(result) };
        persist(file, { ...journal, revision: journal.revision + 1,
            forwardObservationReconciliation: { ...lease, diagnostic } });
    });
}

/** Re-observe a completed migration in a new service child; the original A result is immutable. */
export async function observeForwardTargetForResume(config, deps = {}) {
    requireValue(process.geteuid?.() === 0, 'root_required'); operatorLock(config);
    const file = path.join(config.controlRoot, 'first-cutover.json'); const before = readForwardRootRecord(file);
    verifyForwardOwner(config, before); assertPrestartAuthority(config, before);
    requireValue(before.state === 'running' && before.phase === 'migration_observed'
        && !before.forwardObservationIntent && !before.forwardObservationAuthorization && !before.forwardTargetObservation
        && forwardValueSha256(before.expected) === forwardValueSha256(config.expected), 'observation_phase_invalid');
    const request = readPinnedForwardRecord(config.forwardMigration.request);
    const contract = readPinnedForwardRecord(config.forwardMigration.contract);
    const material = { purpose: 'migration', transactionId: before.transactionId,
        databaseContractSha256: forwardValueSha256(contract), contract };
    requireValue(request.transactionId === before.transactionId && request.databaseContractSha256 === material.databaseContractSha256
        && forwardValueSha256(request) === before.forwardMigrationIntent?.requestSha256
        && before.forwardChildAuthorization?.originalIntentSha256 === forwardValueSha256(before.forwardMigrationIntent), 'observation_original_intent');
    validateResult(before.forwardMigrationResult, before.forwardChildAuthorization, material);
    await verifyForwardRetirement(config, before, deps.retirement);
    withCutoverStateLock(config.controlRoot, () => {
        operatorLock(config); const current = readForwardRootRecord(file); assertPrestartAuthority(config, current);
        requireValue(forwardValueSha256(current) === forwardValueSha256(before), 'observation_cas');
        const intent = { schema: 'nassaj-forward-target-observation-intent/v1', transactionId: before.transactionId,
            attemptNonce: randomBytes(32).toString('hex'), originalIntentSha256: forwardValueSha256(before.forwardMigrationIntent),
            migrationResultSha256: forwardValueSha256(before.forwardMigrationResult) };
        persist(file, { ...current, revision: current.revision + 1, forwardObservationIntent: intent });
    });
    return runForwardMigrationChild(config, 'observe-target', deps);
}
function proveObservationProcessDead(identity) {
    requireValue(identity && Number.isSafeInteger(identity.pid) && typeof identity.startTicks === 'string'
        && typeof identity.bootId === 'string', 'observation_death_missing');
    try { const actual = inspectForwardChildIdentity(identity.pid);
        requireValue(actual.bootId === identity.bootId && actual.startTicks !== identity.startTicks, 'observation_process_alive_or_unknown'); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
}
function partialObservationReceipt(config, journal, pending) {
    let receipt = journal.forwardObservationReconciliation;
    if (forwardValueSha256(receipt) !== pending.observation.receiptSha256) {
        const matches = journal.forwardObservationReconciliationHistory?.filter(item => item.nonce === pending.observation.nonce
            && item.sha256 === pending.observation.receiptSha256);
        requireValue(matches?.length === 1 && matches[0].tombstone === `forward-observation-${pending.observation.receiptSha256}.json`,
            'observation_partial_receipt_missing');
        receipt = readForwardRootRecord(path.join(config.controlRoot, matches[0].tombstone));
    }
    requireValue(forwardValueSha256(receipt) === pending.observation.receiptSha256 && receipt.state === 'observed'
        && receipt.nonce === pending.observation.nonce && receipt.operationId === journal.transactionId
        && forwardValueSha256(receipt.owner) === forwardValueSha256(pending.operator)
        && receipt.abandonedLockSha256 === pending.priorLockSha256
        && receipt.originalOperatorSha256 === forwardValueSha256(journal.operator)
        && receipt.originalIntentSha256 === forwardValueSha256(journal.forwardMigrationIntent)
        && receipt.migrationResultSha256 === forwardValueSha256(journal.forwardMigrationResult)
        && receipt.resultSha256 === forwardValueSha256(receipt.result), 'observation_partial_receipt');
    const request = readPinnedForwardRecord(config.forwardMigration.request);
    const contract = readPinnedForwardRecord(config.forwardMigration.contract);
    const authority = { purpose: 'observe-target', authority: 'reconcile-observation', nonce: receipt.nonce, owner: receipt.owner,
        abandonedLockSha256: receipt.abandonedLockSha256, originalIntentSha256: receipt.originalIntentSha256,
        migrationResultSha256: receipt.migrationResultSha256, expectedTargetSha256: receipt.expectedTargetSha256,
        expiresAtBootMs: receipt.expiresAtBootMs };
    requireValue(receipt.authorization?.attemptNonce === receipt.nonce
        && forwardValueSha256(receipt.authorization.observationAuthority) === forwardValueSha256(authority)
        && ['pid', 'startTicks', 'bootId'].every(key => receipt.child?.[key] === receipt.authorization[key]), 'observation_partial_child');
    validateResult(receipt.result, receipt.authorization, { purpose: 'observe-target', transactionId: journal.transactionId,
        observationAuthority: authority, databaseContractSha256: forwardValueSha256(contract), request, contract });
    proveObservationProcessDead(pending.operator); proveObservationProcessDead(receipt.child);
}
function assertPartialObservationTransfer(config, journal, pending, lockBytes) {
    const chain = []; const nonces = new Set(); const receipts = new Set();
    for (let item = pending; item; item = item.previousIntent) {
        requireValue(chain.length < 8 && item.phase === 'intent' && item.eligiblePhase === 'migration_observed'
            && /^[a-f0-9]{64}$/.test(item.observation?.receiptSha256) && /^[a-f0-9]{64}$/.test(item.observation?.nonce)
            && /^[a-f0-9]{64}$/.test(item.priorLockSha256)
            && item.tombstone === `forward-lock-tombstone-${item.priorLockSha256}.json`
            && !nonces.has(item.observation.nonce) && !receipts.has(item.observation.receiptSha256), 'observation_partial_chain');
        nonces.add(item.observation.nonce); receipts.add(item.observation.receiptSha256); chain.unshift(item);
    }
    let previousBytes; let previousReplacement;
    for (const item of chain) {
        const file = path.join(config.controlRoot, item.tombstone);
        const prior = readForwardRootRecord(file); const bytes = fs.readFileSync(file);
        assertForwardFrameKeys(prior, 'schema,pid,startTime');
        requireValue(prior.schema === 'nassaj-cutover-lock/v1'
            && forwardValueSha256(bytes.toString('base64')) === item.priorLockSha256, 'observation_partial_tombstone');
        if (previousBytes) requireValue(bytes.equals(previousBytes) || bytes.equals(previousReplacement), 'observation_partial_chain_link');
        else requireValue(prior.pid === journal.operator.pid && prior.startTime === journal.operator.startTicks, 'observation_partial_origin');
        partialObservationReceipt(config, journal, item);
        previousBytes = bytes;
        previousReplacement = Buffer.from(JSON.stringify({ schema: 'nassaj-cutover-lock/v1', pid: item.operator.pid,
            startTime: item.operator.startTicks }));
    }
    requireValue(lockBytes.equals(previousBytes) || lockBytes.equals(previousReplacement), 'observation_partial_lock');
    const lock = JSON.parse(lockBytes);
    const owners = [journal.operator, ...chain.map(item => item.operator)];
    const owner = owners.find(item => item.pid === lock.pid && item.startTicks === lock.startTime);
    requireValue(owner, 'observation_partial_owner');
    return owner;
}
/** Verify the complete bounded abandoned execution-lock chain without acquiring or changing it. */
export function assertForwardAbandonedObservationLock(config, journal, lockBytes) {
    const lock = JSON.parse(lockBytes); assertForwardFrameKeys(lock, 'schema,pid,startTime');
    requireValue(lock.schema === 'nassaj-cutover-lock/v1', 'observation_lock_schema');
    proveObservationProcessDead(journal.operator);
    const pending = journal.forwardLockReconciliation?.phase === 'intent' ? journal.forwardLockReconciliation : null;
    if (pending) return assertPartialObservationTransfer(config, journal, pending, lockBytes);
    requireValue(lock.pid === journal.operator.pid && lock.startTime === journal.operator.startTicks, 'observation_old_owner');
    return journal.operator;
}
/** Prepare one bounded diagnostic lease while preserving the abandoned execution lock byte-for-byte. */
export async function prepareForwardObservationReconciliation(config, operationId, deps = {}) {
    requireValue(process.geteuid?.() === 0, 'root_required');
    const file = path.join(config.controlRoot, 'first-cutover.json'); const before = readForwardRootRecord(file);
    verifyForwardOwner(config, before); assertPrestartAuthority(config, before);
    assertForwardResolvedSupervisorHistory(before);
    const hostStateSha256 = forwardValueSha256(readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json')));
    requireValue(before.transactionId === operationId && before.phase === 'migration_observed' && before.state === 'running'
        && forwardValueSha256(before.expected) === forwardValueSha256(config.expected)
        && !before.forwardObservationIntent && !before.forwardObservationAuthorization && !before.forwardTargetObservation,
    'observation_reconciliation_phase');
    const lockFile = path.join(config.controlRoot, 'first-cutover.lock'); readForwardRootRecord(lockFile);
    const lockBytes = fs.readFileSync(lockFile); const lockSha = forwardValueSha256(lockBytes.toString('base64'));
    assertForwardAbandonedObservationLock(config, before, lockBytes);
    for (const attempt of before.forwardSupervisorAttempts || []) proveObservationProcessDead(attempt.worker);
    proveObservationProcessDead(before.forwardChildAuthorization);
    const previous = before.forwardObservationReconciliation;
    if (previous) { proveObservationProcessDead(previous.owner); if (previous.child) proveObservationProcessDead(previous.child);
        requireValue(previous.state === 'prepared' || previous.child, 'observation_child_missing'); }
    const history = before.forwardObservationReconciliationHistory || [];
    requireValue(Array.isArray(history) && history.length + (previous ? 1 : 0) < 8, 'observation_budget');
    const request = readPinnedForwardRecord(config.forwardMigration.request); const contract = readPinnedForwardRecord(config.forwardMigration.contract);
    requireValue(forwardValueSha256(request) === before.forwardMigrationIntent?.requestSha256
        && request.databaseContractSha256 === forwardValueSha256(contract)
        && before.forwardChildAuthorization.originalIntentSha256 === forwardValueSha256(before.forwardMigrationIntent), 'observation_original_intent');
    validateResult(before.forwardMigrationResult, before.forwardChildAuthorization, { purpose: 'migration', transactionId: operationId,
        databaseContractSha256: forwardValueSha256(contract), contract });
    const proof = await verifyForwardRetirement(config, before, deps.retirement);
    return withCutoverStateLock(config.controlRoot, () => {
        const current = readForwardRootRecord(file); assertPrestartAuthority(config, current);
        assertForwardResolvedSupervisorHistory(current);
        requireValue(forwardValueSha256(current) === forwardValueSha256(before) && fs.readFileSync(lockFile).equals(lockBytes)
            && hostStateSha256 === forwardValueSha256(readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json'))), 'observation_prepare_cas');
        assertForwardAbandonedObservationLock(config, current, lockBytes);
        if (previous) { proveObservationProcessDead(previous.owner); if (previous.child) proveObservationProcessDead(previous.child); }
        const actual = inspectForwardChildIdentity(process.pid);
        const owner = { pid: actual.pid, startTicks: actual.startTicks, bootId: actual.bootId };
        const now = Math.floor(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000);
        const lease = { schema: 'nassaj-forward-observation-reconciliation/v1', operationId, nonce: randomBytes(32).toString('hex'),
            state: 'prepared', owner, abandonedLockSha256: lockSha, originalOperatorSha256: forwardValueSha256(current.operator),
            originalIntentSha256: forwardValueSha256(current.forwardMigrationIntent), migrationResultSha256: forwardValueSha256(current.forwardMigrationResult),
            expectedTargetSha256: forwardValueSha256(contract.target), inhibitorProofSha256: forwardValueSha256(proof),
            revision: current.revision + 1, hostStateSha256, expiresAtBootMs: now + 30000 };
        let records = history;
        if (previous) {
            const tombstone = path.join(config.controlRoot, `forward-observation-${forwardValueSha256(previous)}.json`);
            const bytes = JSON.stringify(previous); let fd;
            try { fd = fs.openSync(tombstone, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
            catch (error) { if (error.code !== 'EEXIST' || fs.readFileSync(tombstone, 'utf8') !== bytes) throw error; }
            finally { if (fd !== undefined) fs.closeSync(fd); }
            const directory = fs.openSync(config.controlRoot, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
            records = [...history, { nonce: previous.nonce, tombstone: path.basename(tombstone), sha256: forwardValueSha256(previous) }];
        }
        const next = { ...current, revision: lease.revision, forwardObservationReconciliation: lease, forwardObservationReconciliationHistory: records };
        persist(file, next); return lease;
    });
}
