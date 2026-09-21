import { createHash, randomUUID } from 'node:crypto';
import {
    closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync,
    renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { withVerifiedCutoverStateMutex } from './release-runtime-state-mutex.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/;
const JOURNAL_SCHEMA = 'nassaj-release-runtime-cutover/v1';
const PHASES = Object.freeze(['accepted', 'ingress_blocked', 'admission_fenced', 'zero_work_verified', 'writers_frozen',
    'final_backup_verified', 'service_switched', 'target_verified', 'ingress_opening', 'ingress_opened', 'public_verified', 'committed']);
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function syncDirectory(directory) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function privateDirectory(directory) {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw new Error('cutover_control_unsafe');
    return directory;
}
function readPrivate(file) {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > 256 * 1024 || (before.mode & 0o777) !== 0o600
        || (typeof process.getuid === 'function' && before.uid !== process.getuid())) throw new Error('cutover_file_unsafe');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const opened = fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('cutover_file_changed');
        return readFileSync(fd); } finally { closeSync(fd); }
}
function atomicJson(file, value) {
    const temporary = `${file}.partial-${process.pid}-${randomUUID()}`; const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file); syncDirectory(path.dirname(file));
}
function processStartTime(pid) {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8').trim(); return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
}
function acquireLock(control) {
    const file = path.join(control, 'first-cutover.lock');
    if (existsSync(file)) {
        const lock = JSON.parse(readPrivate(file)); let alive = false;
        try { alive = processStartTime(lock.pid) === lock.startTime; } catch {}
        if (alive) throw new Error('cutover_already_running'); unlinkSync(file);
    }
    const value = { schema: 'nassaj-cutover-lock/v1', pid: process.pid, startTime: processStartTime(process.pid) };
    const fd = openSync(file, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(control); return { release() { try { unlinkSync(file); syncDirectory(control); } catch {} } };
}
function validateExpected(expected) {
    const hashes = ['hostIdentitySha256', 'releaseIdentitySha256', 'migrationIdentitySha256', 'pm2SnapshotSha256',
        'databaseContractSha256', 'assetSha256', 'ownerApprovalKeySha256'];
    if (!INSTANCE.test(expected?.nodeInstanceId || '') || !INSTANCE.test(expected?.generationId || '')
        || !HEX64.test(expected?.targetSchemaDigest || '') || !HEX64.test(expected?.serverBuildId || '')
        || !HEX64.test(expected?.clientBuildId || '')
        || hashes.some((key) => !HEX64.test(expected?.[key] || ''))) {
        throw new Error('cutover_expected_identity_invalid');
    }
    return expected;
}
function assertRecoverySupported() {
    throw new Error('cutover_recovery_contract_unsupported');
}

function invalidateAdmissionUnderLock(control, reason) {
    const file = path.join(control, 'startup-admission.json');
    if (!existsSync(file)) return;
    const current = JSON.parse(readPrivate(file));
    if (current.schema !== 'nassaj-startup-admission/v1'
        || !Number.isSafeInteger(current.revision) || current.revision < 0 || current.revision >= Number.MAX_SAFE_INTEGER
        || !Number.isSafeInteger(current.generationEpoch) || current.generationEpoch < 0 || current.generationEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new Error('cutover_startup_admission_invalid');
    }
    atomicJson(file, { ...current, state: 'switching', revision: current.revision + 1,
        generationEpoch: current.generationEpoch + 1, offer: null, transitionReason: reason,
        potentiallyRunningClaim: current.lastClaim || current.potentiallyRunningClaim || null });
}

/** Disable future admission durably before a root transition can perform its first effect. */
export function invalidateCutoverStartupAdmission(control, reason) {
    return withCutoverStateLock(control, () => invalidateAdmissionUnderLock(control, reason));
}

/** Serialize synchronous mutations with the fixed root-configured kernel mutex (ADR143/B936). */
export function withCutoverStateLock(controlRoot, mutate) {
    return withVerifiedCutoverStateMutex(controlRoot, mutate);
}

/** Consume only a current pending claim. This primitive never performs host or database effects. */
export function consumeCutoverBootstrapClaim(options) {
    const { controlRoot, expected, request, observeCaller, verifyAuthority } = options;
    validateExpected(expected);
    if (!request || !HEX64.test(request.challenge || '') || !HEX64.test(request.startupClosureSha256 || '')
        || !INSTANCE.test(request.transactionId || '') || !INSTANCE.test(request.attemptNonce || '')
        || !Number.isSafeInteger(request.pid) || request.pid <= 0 || !/^[0-9]{1,24}$/.test(request.startTicks || '')
        || !/^[a-f0-9-]{36}$/.test(request.bootId || '') || typeof verifyAuthority !== 'function') {
        throw new Error('cutover_bootstrap_request_invalid');
    }
    return withCutoverStateLock(controlRoot, () => {
        const file = path.join(controlRoot, 'first-cutover.json');
        const journal = JSON.parse(readPrivate(file));
        if (verifyAuthority(journal) !== true) throw new Error('cutover_bootstrap_authority_denied');
        const caller = observeCaller();
        const pending = journal.startupClaim;
        if (journal.schema !== JOURNAL_SCHEMA || journal.state !== 'running'
            || journal.phase !== 'startup_claim_pending' || canonical(journal.expected) !== canonical(expected)
            || journal.transactionId !== request.transactionId || journal.revision !== request.expectedRevision
            || !Number.isSafeInteger(journal.revision) || journal.revision < 0 || journal.revision >= Number.MAX_SAFE_INTEGER
            || pending?.state !== 'pending' || pending.attemptNonce !== request.attemptNonce
            || pending.startupClosureSha256 !== request.startupClosureSha256
            || request.releaseIdentitySha256 !== expected.releaseIdentitySha256
            || pending.startupPolicyId !== 'existing-security-state/v1'
            || !Number.isSafeInteger(pending.databaseDev) || !Number.isSafeInteger(pending.databaseIno)
            || pending.databaseDev < 0 || pending.databaseIno <= 0
            || !Number.isSafeInteger(caller.uid) || caller.uid <= 0
            || caller.pid !== request.pid || caller.startTicks !== request.startTicks || caller.bootId !== request.bootId) {
            throw new Error('cutover_bootstrap_claim_denied');
        }
        if (canonical(observeCaller()) !== canonical(caller)) throw new Error('cutover_bootstrap_caller_changed');
        const response = { schema: 'nassaj-bootstrap-claim-response/v1', decision: 'claimed',
            transactionId: journal.transactionId, attemptNonce: pending.attemptNonce, claimId: randomUUID(),
            revision: journal.revision + 1, challenge: request.challenge,
            uid: caller.uid, pid: caller.pid, startTicks: caller.startTicks, bootId: caller.bootId,
            releaseIdentitySha256: expected.releaseIdentitySha256, startupClosureSha256: pending.startupClosureSha256,
            databaseContractSha256: expected.databaseContractSha256, databaseDev: pending.databaseDev,
            databaseIno: pending.databaseIno, startupPolicyId: pending.startupPolicyId };
        const { challenge, ...receipt } = response;
        atomicJson(file, { ...journal, phase: 'startup_claimed', revision: response.revision,
            startupClaim: { ...pending, ...receipt, state: 'consumed',
                challengeSha256: createHash('sha256').update(challenge).digest('hex') } });
        return Object.freeze(response);
    });
}
function containCutoverUncertainty(journalFile, journal, reason) {
    const publicWritesPossible = journal.publicOpeningIntent === true
        || PHASES.indexOf(journal.phase) >= PHASES.indexOf('ingress_opening');
    const blocked = { ...journal, state: 'manual_recovery',
        rollbackBlocked: publicWritesPossible ? 'post_public_writes_possible' : 'cutover_recovery_contract_unsupported',
        reason: String(reason?.message || reason) };
    atomicJson(journalFile, blocked);
    return blocked;
}

/** Refuse planning until the complete writer-fence and recovery contract exists. */
export async function planReleaseRuntimeCutover() {
    assertRecoverySupported();
}

/** Contain interrupted legacy transactions; never start or resume host operations. */
export async function executeReleaseRuntimeCutover(options) {
    const expected = validateExpected(options.expected);
    const control = privateDirectory(options.controlRoot);
    const journalFile = path.join(control, 'first-cutover.json');
    if (!existsSync(journalFile)) assertRecoverySupported();
    const lock = acquireLock(control);
    try {
        return withCutoverStateLock(control, () => {
            const journal = JSON.parse(readPrivate(journalFile));
            if (journal.schema !== JOURNAL_SCHEMA || canonical(journal.expected) !== canonical(expected)) {
                throw new Error('cutover_journal_identity_mismatch');
            }
            if (['committed', 'rolled_back', 'manual_recovery'].includes(journal.state)) return journal;
            invalidateAdmissionUnderLock(control, 'manual_recovery');
            return containCutoverUncertainty(journalFile, journal, 'cutover_recovery_contract_unsupported');
        });
    } finally { lock.release(); }
}
