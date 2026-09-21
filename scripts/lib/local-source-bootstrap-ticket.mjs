/** Short-lived release-to-local-main authority; immutable candidates never carry reusable activation authority. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { canonicalTripleJson as canonical } from './oid-triple-target.mjs';

const HASH = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}$/;
const MATERIAL = ['installation', 'event', 'approval', 'previous', 'supervisor', 'database', 'mode', 'baseline', 'executor'];
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = reason => { throw new Error(`bootstrap_ticket_${reason}`); };
function check(value, reason) { if (!value) fail(reason); }
function keys(value, expected) {
    check(value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).sort().join(',') === [...expected].sort().join(','), 'schema');
}
function hashes(value, names) { for (const name of names) check(HASH.test(value[name] || ''), 'digest'); }

/** /proc/uptime is Linux CLOCK_BOOTTIME, including suspend; wall time grants no authority. */
export function bootstrapClock() {
    const uptime = fs.readFileSync('/proc/uptime', 'utf8').match(/^([0-9]+)\.([0-9]{2}) /);
    check(uptime, 'clock_unknown');
    const milliseconds = Number(uptime[1]) * 1000 + Number(uptime[2]) * 10;
    check(Number.isSafeInteger(milliseconds), 'clock_unknown');
    return { bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), milliseconds };
}
function validateMaterial(material) {
    keys(material, MATERIAL);
    const { installation: install, event, approval, previous, supervisor, database, mode, baseline, executor } = material;
    keys(install, ['root', 'commonGit', 'hostname', 'serviceUid']);
    check([install.root, install.commonGit].every(value => typeof value === 'string' && path.isAbsolute(value)
        && path.resolve(value) === value) && typeof install.hostname === 'string' && install.hostname.length > 0
        && Number.isSafeInteger(install.serviceUid) && install.serviceUid >= 0, 'installation');
    keys(event, ['sequence', 'group', 'oid', 'targetDigest', 'manifestSha256']);
    check(Number.isSafeInteger(event.sequence) && event.sequence > 0 && event.group === `event-${String(event.sequence).padStart(16, '0')}`
        && OID.test(event.oid || ''), 'event'); hashes(event, ['targetDigest', 'manifestSha256']);
    keys(approval, ['ownerId', 'receiptSha256']);
    check(typeof approval.ownerId === 'string' && /^[1-9][0-9]*$/.test(approval.ownerId), 'owner'); hashes(approval, ['receiptSha256']);
    keys(previous, ['pid', 'ppid', 'startTicks', 'clientBuildId', 'serverBuildId', 'controlManifestSha256',
        'clientTreeSha256', 'serverTreeSha256', 'nodeModulesTreeSha256']);
    check([previous.pid, previous.ppid].every(pid => Number.isSafeInteger(pid) && pid > 1)
        && /^[1-9][0-9]*$/.test(previous.startTicks || ''), 'process');
    hashes(previous, ['clientBuildId', 'serverBuildId', 'controlManifestSha256', 'clientTreeSha256', 'serverTreeSha256', 'nodeModulesTreeSha256']);
    keys(supervisor, ['pid', 'startTicks', 'observerSha256', 'slotSha256', 'environmentSha256', 'dumpSha256']);
    check(supervisor.pid === previous.ppid && /^[1-9][0-9]*$/.test(supervisor.startTicks || ''), 'supervisor');
    hashes(supervisor, ['observerSha256', 'slotSha256', 'environmentSha256', 'dumpSha256']);
    keys(database, ['path', 'dev', 'ino']);
    check(typeof database.path === 'string' && path.isAbsolute(database.path) && path.resolve(database.path) === database.path
        && ['dev', 'ino'].every(key => typeof database[key] === 'string' && /^[0-9]+$/.test(database[key])), 'database');
    keys(mode, ['original', 'proposed', 'originalEnvSha256', 'proposalEnvSha256']);
    check(mode.original === 'release' && mode.proposed === 'local-main', 'mode'); hashes(mode, ['originalEnvSha256', 'proposalEnvSha256']);
    keys(baseline, ['attestationSha256', 'rehearsalSha256']); hashes(baseline, ['attestationSha256', 'rehearsalSha256']);
    keys(executor, ['codeClosureSha256', 'transactionNonce']); hashes(executor, ['codeClosureSha256', 'transactionNonce']);
}
/** Create a new ticket after independent material capture; this neither approves nor activates anything. */
export function createBootstrapTicket(material, { clock = bootstrapClock(), ttlMs = 300000 } = {}) {
    validateMaterial(material);
    check(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 300000 && Number.isSafeInteger(clock.milliseconds)
        && clock.milliseconds >= 0 && /^[a-f0-9-]{36}$/.test(clock.bootId || ''), 'clock');
    return { schema: 'nassaj-local-main-bootstrap-ticket/v2', nonce: randomBytes(32).toString('hex'),
        bootId: clock.bootId, issuedBootMs: clock.milliseconds, expiresBootMs: clock.milliseconds + ttlMs,
        material: structuredClone(material) };
}
/** Compare every bound fact to a fresh independently inspected material set before any effect. */
export function verifyBootstrapTicket(ticket, expected, clock = bootstrapClock()) {
    keys(ticket, ['schema', 'nonce', 'bootId', 'issuedBootMs', 'expiresBootMs', 'material']);
    check(ticket.schema === 'nassaj-local-main-bootstrap-ticket/v2' && HASH.test(ticket.nonce || '')
        && /^[a-f0-9-]{36}$/.test(ticket.bootId || ''), 'schema');
    validateMaterial(ticket.material); validateMaterial(expected);
    check(canonical(ticket.material) === canonical(expected), 'material_changed');
    check(ticket.bootId === clock.bootId && Number.isSafeInteger(clock.milliseconds)
        && Number.isSafeInteger(ticket.issuedBootMs) && Number.isSafeInteger(ticket.expiresBootMs)
        && ticket.issuedBootMs >= 0 && ticket.expiresBootMs > ticket.issuedBootMs
        && ticket.expiresBootMs - ticket.issuedBootMs <= 300000 && clock.milliseconds >= ticket.issuedBootMs
        && clock.milliseconds < ticket.expiresBootMs, 'expired_or_rebooted');
    return sha(canonical(ticket));
}
function checkedClaimDirectory(ticket) {
    const root = ticket.material.installation.commonGit;
    const directory = path.join(root, 'nassaj-oid-recovery', ticket.material.executor.transactionNonce);
    for (const file of [root, path.dirname(directory), directory]) {
        const stat = fs.lstatSync(file);
        check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(file) === file
            && stat.uid === process.getuid() && !(stat.mode & 0o022), 'claim_directory');
    }
    return directory;
}
/** Consume a nonce exclusively under the caller's existing admission/activity/publisher fences. */
export function consumeBootstrapTicket(ticket, expected, executorOwner, clock = bootstrapClock()) {
    const ticketSha256 = verifyBootstrapTicket(ticket, expected, clock);
    check(executorOwner?.pid === process.pid && executorOwner.bootId === clock.bootId
        && /^[1-9][0-9]*$/.test(executorOwner.startTime || ''), 'claim_owner');
    const processStat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    check(processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === executorOwner.startTime
        && expected.installation.serviceUid === process.getuid(), 'claim_owner');
    const directory = checkedClaimDirectory(ticket), basename = `bootstrap-claim-${ticket.nonce}.json`, file = path.join(directory, basename);
    const claim = { schema: 'nassaj-local-main-bootstrap-claim/v1', state: 'claimed_pre_effect', ticketSha256,
        nonce: ticket.nonce, transactionNonce: expected.executor.transactionNonce, owner: executorOwner, targetDigest: expected.event.targetDigest,
        approvalSha256: expected.approval.receiptSha256, executorCodeClosureSha256: expected.executor.codeClosureSha256 };
    const bytes = Buffer.from(`${canonical(claim)}\n`);
    const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
        const held = fs.fstatSync(parent), named = fs.lstatSync(checkedClaimDirectory(ticket));
        check(held.dev === named.dev && held.ino === named.ino, 'claim_directory');
        const fd = fs.openSync(`/proc/self/fd/${parent}/${basename}`,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.fsyncSync(parent);
        const after = fs.lstatSync(checkedClaimDirectory(ticket));
        check(held.dev === after.dev && held.ino === after.ino, 'claim_directory');
    } finally { fs.closeSync(parent); }
    return { file, sha256: sha(bytes), claim };
}

const PREVIOUS_KEYS = ['oid','clientOid','serverBuildId','clientBuildId','controlManifestSha256','serverInputManifestSha256',
    'serverProvenanceSha256','clientProvenanceSha256','clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256',
    'dependencyLegacyActualSha256','nodeBinarySha256','nodeVersion','nodeModuleAbi','pm2PackageTreeSha256',
    'safeRestartSha256','admissionImplementationSha256','mode'];
const REHEARSAL_KEYS = ['schema','reportSha256','evidenceIndexSha256','harnessClosureSha256',
    'verifierClosureSha256','previousMaterialSha256','executorClosureSha256'];

/** Validate byte-bound material only; review and authenticated approval remain separate mandatory authority. */
export function validateBootstrapQualificationMaterial(qualification, actual, manifest) {
    keys(qualification, ['schema','installation','previous','exceptions','rehearsal','review']);
    check(qualification.schema === 'nassaj-bootstrap-previous-qualification/v1', 'qualification_schema');
    keys(qualification.installation, ['root','commonGit','hostname','serviceUid']);
    keys(qualification.previous, PREVIOUS_KEYS);
    const previous = qualification.previous;
    for (const key of PREVIOUS_KEYS.filter(key => key.endsWith('Sha256') || key.endsWith('BuildId'))) hashes(previous,[key]);
    check(OID.test(previous.oid || '') && OID.test(previous.clientOid || '') && previous.mode === 'release'
        && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(previous.nodeVersion || '') && /^[0-9]+$/.test(previous.nodeModuleAbi || ''), 'qualification_previous');
    check(canonical(qualification.installation) === canonical(actual.installation)
        && canonical(previous) === canonical(actual.previous), 'qualification_material_changed');
    check(Array.isArray(qualification.exceptions) && qualification.exceptions.length <= 1
        && HASH.test(manifest.runtimeDependenciesSha256 || ''), 'qualification_exception');
    const mismatch = manifest.runtimeDependenciesSha256 !== previous.dependencyLegacyActualSha256;
    check(qualification.exceptions.length === Number(mismatch), 'qualification_exception');
    if (mismatch) {
        const exception=qualification.exceptions[0];
        keys(exception,['kind','manifestSha256','expectedLegacySha256','actualLegacySha256']);
        check(exception.kind === 'dependency-seal-mismatch' && exception.manifestSha256 === previous.controlManifestSha256
            && exception.expectedLegacySha256 === manifest.runtimeDependenciesSha256
            && exception.actualLegacySha256 === previous.dependencyLegacyActualSha256, 'qualification_exception');
    }
    keys(qualification.rehearsal, REHEARSAL_KEYS);
    check(qualification.rehearsal.schema === 'nassaj-bootstrap-previous-rehearsal/v1', 'qualification_rehearsal');
    hashes(qualification.rehearsal, REHEARSAL_KEYS.filter(key => key !== 'schema'));
    keys(qualification.review, ['receiptSha256']); hashes(qualification.review,['receiptSha256']);
    const material={installation:qualification.installation,previous,exceptions:qualification.exceptions};
    check(qualification.rehearsal.previousMaterialSha256 === sha(canonical(material)), 'qualification_material_digest');
    return { previous: structuredClone(previous), exceptions: structuredClone(qualification.exceptions),
        previousMaterialSha256: sha(canonical(material)), qualificationSha256: sha(canonical(qualification)) };
}

/** Bind a real recorded conversation approval; this verifies integrity, not the speaker's authenticity. */
export function validateBootstrapApprovalChain(ticket, review, receipt, principal, clock = bootstrapClock()) {
    verifyBootstrapTicket(ticket, ticket.material, clock);
    keys(review, ['schema','installation','operation','transactionNonce','event','baseline','executorCodeClosureSha256',
        'qaReceiptSha256','mode','validity']);
    keys(receipt, ['schema','reviewPacketSha256','transactionNonce','ownerId','source','scope','decision','recordedAt']);
    const material = ticket.material;
    check(review.schema === 'nassaj-bootstrap-owner-review/v1'
        && review.operation === 'bootstrap-release-to-local-main'
        && canonical(review.installation) === canonical(material.installation)
        && canonical(review.event) === canonical(material.event)
        && canonical(review.baseline) === canonical(material.baseline)
        && canonical(review.mode) === canonical(material.mode)
        && review.executorCodeClosureSha256 === material.executor.codeClosureSha256
        && review.transactionNonce === material.executor.transactionNonce, 'review_scope');
    keys(review.validity, ['bootId','notBeforeBootMs','notAfterBootMs','attempts']);
    check(review.validity.bootId === ticket.bootId && review.validity.attempts === 1
        && Number.isSafeInteger(review.validity.notBeforeBootMs) && review.validity.notBeforeBootMs >= 0
        && Number.isSafeInteger(review.validity.notAfterBootMs)
        && review.validity.notBeforeBootMs <= ticket.issuedBootMs
        && review.validity.notAfterBootMs >= ticket.expiresBootMs, 'review_validity');
    hashes(review, ['qaReceiptSha256']);
    check(receipt.schema === 'nassaj-bootstrap-owner-conversation-approval/v1'
        && receipt.reviewPacketSha256 === sha(canonical(review))
        && receipt.transactionNonce === review.transactionNonce && receipt.ownerId === material.approval.ownerId
        && receipt.decision === 'approve' && Number.isSafeInteger(receipt.recordedAt) && receipt.recordedAt > 0
        && canonical(receipt.scope) === canonical({ operation: review.operation, installation: review.installation })
        && sha(canonical(receipt)) === material.approval.receiptSha256, 'approval_scope');
    keys(receipt.source, ['harness','conversationId','messageId','transcriptRef','messageText','messageSha256','timestamp']);
    const source = receipt.source;
    check(['harness','conversationId','transcriptRef','messageText','timestamp'].every(key =>
        typeof source[key] === 'string' && source[key].trim().length > 0 && source[key].length <= 16384)
        && (source.messageId === null || (typeof source.messageId === 'string' && source.messageId.length > 0))
        && source.messageSha256 === sha(source.messageText), 'approval_source');
    check(principal?.id === receipt.ownerId && principal.mappedOwnerId === receipt.ownerId
        && principal.role === 'owner' && principal.is_active === 1 && principal.status === 'active', 'owner_ineligible');
    return { ownerId: receipt.ownerId, receiptSha256: material.approval.receiptSha256,
        reviewPacketSha256: receipt.reviewPacketSha256, qaReceiptSha256: review.qaReceiptSha256 };
}

/** Read bounded private journal bytes before any parsing or digest computation. */
export function readBootstrapPrivateFile(file) {
    check(typeof file === 'string' && path.isAbsolute(file) && fs.realpathSync(file) === file, 'file_path');
    const named = fs.lstatSync(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd);
        check(before.isFile() && before.nlink === 1 && before.uid === process.getuid()
            && (before.mode & 0o777) === 0o600 && before.size <= 4 * 1024 * 1024
            && before.dev === named.dev && before.ino === named.ino, 'file_metadata');
        const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(file);
        check(before.size === after.size && before.ctimeMs === after.ctimeMs
            && current.dev === before.dev && current.ino === before.ino && current.ctimeMs === before.ctimeMs, 'file_changed');
        return bytes;
    } finally { fs.closeSync(fd); }
}

/** Verify immutable authority bytes against an independently supplied digest. */
export function readBootstrapPinnedFile(file, expectedSha256) {
    const bytes = readBootstrapPrivateFile(file);
    check(HASH.test(expectedSha256 || '') && sha(bytes) === expectedSha256, 'file_changed');
    return bytes;
}

/** Establish the exact journal binding; callers must still prove locks and independently inspect live facts. */
export function bootstrapJournalBinding(ticket, consumed) {
    // Structural validation only: an already claimed recovery is not a new activation.
    verifyBootstrapTicket(ticket, ticket.material, { bootId: ticket.bootId, milliseconds: ticket.issuedBootMs });
    const material = ticket.material, claim = consumed?.claim;
    keys(claim, ['schema','state','ticketSha256','nonce','transactionNonce','owner','targetDigest','approvalSha256','executorCodeClosureSha256']);
    keys(claim.owner, ['pid','bootId','startTime']);
    check(Number.isSafeInteger(claim.owner.pid) && claim.owner.pid > 1 && claim.owner.bootId === ticket.bootId
        && /^[1-9][0-9]*$/.test(claim.owner.startTime || ''), 'claim_owner');
    check(claim.schema === 'nassaj-local-main-bootstrap-claim/v1' && claim.state === 'claimed_pre_effect'
        && claim.ticketSha256 === sha(canonical(ticket)) && claim.nonce === ticket.nonce
        && claim.transactionNonce === material.executor.transactionNonce && claim.targetDigest === material.event.targetDigest
        && claim.approvalSha256 === material.approval.receiptSha256
        && claim.executorCodeClosureSha256 === material.executor.codeClosureSha256
        && consumed.sha256 === sha(`${canonical(claim)}\n`), 'claim_binding');
    return { schema: 'nassaj-local-main-bootstrap-transaction/v1', ticketSha256: claim.ticketSha256,
        claimSha256: consumed.sha256, qualificationSha256: material.baseline.attestationSha256,
        executorCodeClosureSha256: material.executor.codeClosureSha256, manifestSha256: material.event.manifestSha256 };
}

/** Recovery reads a spent claim; it never consumes again and expiry cannot revoke an in-flight recovery. */
export function verifyBootstrapJournalBinding(transaction, record, claimBytes, codeClosureSha256) {
    const ticket = record?.bootstrap?.ticket;
    check(ticket && transaction?.schema === 'nassaj-oid-control-transaction/v2', 'journal_missing');
    const claim = JSON.parse(claimBytes), binding = bootstrapJournalBinding(ticket, { claim, sha256: sha(claimBytes) });
    check(canonical(transaction.bootstrap) === canonical(binding)
        && binding.executorCodeClosureSha256 === codeClosureSha256
        && transaction.transactionNonce === ticket.material.executor.transactionNonce
        && record.transactionNonce === transaction.transactionNonce && record.actionId === transaction.actionId
        && transaction.sequence === ticket.material.event.sequence && transaction.oid === ticket.material.event.oid
        && transaction.pair?.targetDigest === ticket.material.event.targetDigest
        && record.pair?.targetDigest === transaction.pair.targetDigest
        && record.repoRoot === ticket.material.installation.root, 'journal_binding');
    return { binding, ticket, claim };
}

const REHEARSAL_CHECKS = ['loaded_identity','admission_exclusion','old_stop','old_restart_under_gate',
    'pid_and_peer_races','crash_after_stop','crash_after_mode','crash_after_exchange','candidate_start_unknown','evidence_negative'];

function rehearsalIdentity(value, previous) {
    keys(value, ['pid','startTicks','oid','serverBuildId','clientBuildId','nodeBinarySha256',
        'clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256','mode']);
    check(Number.isSafeInteger(value.pid) && value.pid > 0 && /^[1-9][0-9]*$/.test(value.startTicks || ''), 'rehearsal_process');
    for (const key of Object.keys(value).filter(key => !['pid','startTicks'].includes(key))) {
        check(value[key] === previous[key], 'rehearsal_loaded_identity');
    }
}

function noActivationEffects(value) {
    keys(value, ['stopRequests','exchangeRequests','startRequests','databaseRestores']);
    check(Object.values(value).every(count => count === 0), 'rehearsal_unexpected_effect');
}

function previousReturnObserved(value, initial, final, databaseIdentity) {
    keys(value, ['gateClosed','newWriterStatus','databaseBefore','databaseAfter','usersBeforeSha256','usersAfterSha256',
        'targetStartRequests','databaseRestores','childReceipt']);
    for (const database of [value.databaseBefore, value.databaseAfter]) {
        keys(database, ['path','dev','ino']);
        check(path.isAbsolute(database.path) && ['dev','ino'].every(key => /^[0-9]+$/.test(database[key])), 'rehearsal_database');
    }
    check(value.gateClosed === true && value.newWriterStatus === 503 && value.targetStartRequests === 0
        && value.databaseRestores === 0 && canonical(value.databaseBefore) === canonical(value.databaseAfter)
        && canonical(value.databaseBefore) === canonical(databaseIdentity)
        && HASH.test(value.usersBeforeSha256 || '') && value.usersBeforeSha256 === value.usersAfterSha256
        && (initial.pid !== final.pid || initial.startTicks !== final.startTicks), 'rehearsal_previous_return');
    const child = value.childReceipt;
    check(child?.schema === 'nassaj-oid-triple-bootstrap/v2' && child.rollback === true
        && child.pid === final.pid && child.startTime === final.startTicks
        && child.serverBuildId === final.serverBuildId && child.clientBuildId === final.clientBuildId
        && child.nodeModulesTreeSha256 === final.nodeModulesTreeSha256, 'rehearsal_previous_receipt');
}

function checkRehearsalCase(entry, previous, bindings, databaseIdentity) {
    keys(entry, ['schema','name','previousMaterialSha256','executorClosureSha256','initial','final','observations',
        'injectedPhase','attempt','journalEvidence','receiptEvidence','executionEvidence']);
    check(entry.schema === 'nassaj-bootstrap-observed-case/v1' && REHEARSAL_CHECKS.includes(entry.name)
        && entry.previousMaterialSha256 === bindings.previousMaterialSha256
        && entry.executorClosureSha256 === bindings.executorClosureSha256, 'rehearsal_case_binding');
    rehearsalIdentity(entry.initial, previous);
    if (entry.name !== 'candidate_start_unknown') rehearsalIdentity(entry.final, previous);
    const observed = entry.observations;
    if (entry.name === 'loaded_identity') {
        keys(observed, ['loadedArtifactLinkageSha256','healthServerBuildId','healthClientBuildId','processExecutableSha256']);
        check(observed.loadedArtifactLinkageSha256 === previous.serverInputManifestSha256
            && observed.healthServerBuildId === previous.serverBuildId && observed.healthClientBuildId === previous.clientBuildId
            && observed.processExecutableSha256 === previous.nodeBinarySha256, 'rehearsal_loaded_linkage');
    } else if (entry.name === 'admission_exclusion') {
        keys(observed, ['existingWriterCount','outcome','newWriterStatus','gateClosed','effects']);
        check(Number.isSafeInteger(observed.existingWriterCount) && observed.existingWriterCount > 0
            && observed.outcome === 'deferred' && observed.newWriterStatus === 503 && observed.gateClosed === true, 'rehearsal_admission');
        noActivationEffects(observed.effects);
    } else if (entry.name === 'old_stop') {
        keys(observed, ['method','sameFdPeerPid','expectedDaemonPid','oldProcessDead','remainingWriterPids','firstExchangeAfterDeath']);
        check(observed.method === 'stopProcessId' && Number.isSafeInteger(observed.expectedDaemonPid) && observed.expectedDaemonPid > 0
            && observed.sameFdPeerPid === observed.expectedDaemonPid && observed.oldProcessDead === true
            && canonical(observed.remainingWriterPids) === '[]' && observed.firstExchangeAfterDeath === true, 'rehearsal_stop');
    } else if (entry.name === 'old_restart_under_gate' || entry.name.startsWith('crash_after_')) {
        if (entry.name.startsWith('crash_after_')) {
            keys(observed, ['crashBoundary','journalState','recovery']);
            const phases = { crash_after_stop: 'triple_old_stopped', crash_after_mode: 'bootstrap_mode_verified', crash_after_exchange: 'triple_exchanged' };
            check(observed.crashBoundary === entry.name && observed.journalState === phases[entry.name], 'rehearsal_crash');
            previousReturnObserved(observed.recovery, entry.initial, entry.final, databaseIdentity);
        } else previousReturnObserved(observed, entry.initial, entry.final, databaseIdentity);
    } else if (entry.name === 'candidate_start_unknown') {
        keys(observed, ['journalState','databaseState','gateClosed','replayedRequests','rollbackRequests','databaseRestores']);
        check(entry.final === null && observed.journalState === 'manual_recovery_required' && observed.databaseState === 'UNKNOWN'
            && observed.gateClosed === true && observed.replayedRequests === 0 && observed.rollbackRequests === 0
            && observed.databaseRestores === 0, 'rehearsal_unknown');
    } else checkRehearsalRefusals(entry.name, observed);
}

function verifyRehearsalTrace(entry, evidence, used, previous) {
    const read = reference => {
        keys(reference, ['path','sha256']);
        check(typeof reference.path === 'string' && evidence.has(reference.path) && !used.has(reference.path)
            && reference.sha256 === sha(evidence.get(reference.path)), 'rehearsal_trace');
        used.add(reference.path); return JSON.parse(evidence.get(reference.path));
    };
    const journal = read(entry.journalEvidence), receipt = read(entry.receiptEvidence), execution = read(entry.executionEvidence);
    verifyRehearsalExecution(entry, execution);
    check(canonical(receipt) === canonical(entry.observations), 'rehearsal_receipt');
    check(entry.injectedPhase === entry.name, 'rehearsal_injection');
    const states = { old_stop: 'triple_old_stopped', old_restart_under_gate: 'pair_rolled_back',
        crash_after_stop: 'triple_old_stopped', crash_after_mode: 'bootstrap_mode_verified',
        crash_after_exchange: 'triple_exchanged', candidate_start_unknown: 'manual_recovery_required' };
    if (states[entry.name]) {
        keys(entry.attempt, ['transactionNonce','actionId']);
        check(HASH.test(entry.attempt.transactionNonce || '') && /^[a-f0-9-]{36}$/.test(entry.attempt.actionId || '')
            && journal.transactionNonce === entry.attempt.transactionNonce && journal.actionId === entry.attempt.actionId, 'rehearsal_attempt');
        check(journal?.schema === 'nassaj-oid-control-transaction/v2' && journal.state === states[entry.name]
            && journal.pair?.databaseState === (entry.name === 'candidate_start_unknown' ? 'UNKNOWN' : 'PRE_CANDIDATE'), 'rehearsal_journal');
        for (const key of ['clientBuildId','serverBuildId','clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256','controlManifestSha256']) {
            check(journal.pair.previous?.[key] === previous[key], 'rehearsal_journal_previous');
        }
        const runtime = journal.pair.previous?.runtime;
        check(runtime?.pid === entry.initial.pid && runtime.startTime === entry.initial.startTicks
            && runtime.oid === entry.initial.oid && runtime.serverBuildId === entry.initial.serverBuildId
            && runtime.clientBuildId === entry.initial.clientBuildId, 'rehearsal_journal_runtime');
    } else {
        check(entry.attempt === null, 'rehearsal_pre_effect_attempt');
        keys(journal, ['schema','operation','errorCode']);
        check(journal.schema === 'nassaj-bootstrap-file-observation/v1' && journal.operation === 'lstat'
            && journal.errorCode === 'ENOENT', 'rehearsal_pre_effect_journal');
    }
}

function verifyRehearsalExecution(entry, execution) {
    keys(execution, ['schema','case','command','exitCode','signal','injectedPhase']);
    check(execution.schema === 'nassaj-bootstrap-execution-observation/v1' && execution.case === entry.name
        && execution.injectedPhase === entry.injectedPhase && Array.isArray(execution.command)
        && execution.command.length >= 2 && execution.command.length <= 32
        && execution.command.every(value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value))
        && path.isAbsolute(execution.command[0]), 'rehearsal_command');
    if (entry.name.startsWith('crash_after_')) {
        check(execution.exitCode === null && execution.signal === 'SIGKILL', 'rehearsal_crash_exit');
    } else check(execution.exitCode === 0 && execution.signal === null, 'rehearsal_command_exit');
}

function checkRehearsalRefusals(name, observed) {
    const required = name === 'pid_and_peer_races' ? ['stale-pid','wrong-peer']
        : ['mutated-tree','wrong-report','wrong-approval','wrong-closure','unlisted-exception','missing-evidence','false-loaded-identity'];
    keys(observed, ['refusals']);
    check(Array.isArray(observed.refusals) && canonical(observed.refusals.map(value => value.reason).sort()) === canonical(required.sort()), 'rehearsal_refusals');
    for (const refusal of observed.refusals) {
        keys(refusal, ['reason','observedMismatch','effects']);
        check(typeof refusal.observedMismatch === 'string' && refusal.observedMismatch.length > 0, 'rehearsal_mismatch');
        noActivationEffects(refusal.effects);
    }
}

/** Validate structured observations, never textual PASS; independent execution and QA remain external evidence authority. */
export function verifyBootstrapRehearsalObservations(report, qualification, evidence) {
    keys(report, ['schema','checkSet','previousMaterialSha256','executorClosureSha256','harnessClosureSha256',
        'verifierClosureSha256','evidenceIndexSha256','cases','appDataGuard']);
    check(report.schema === 'nassaj-bootstrap-rehearsal-report/v1' && report.checkSet === 'actual-old-bootstrap-checks/v1', 'report_schema');
    for (const key of ['previousMaterialSha256','executorClosureSha256','harnessClosureSha256','verifierClosureSha256','evidenceIndexSha256']) {
        check(report[key] === qualification.rehearsal[key], 'report_binding');
    }
    check(Array.isArray(report.cases) && canonical(report.cases.map(value => value.name).sort()) === canonical([...REHEARSAL_CHECKS].sort()), 'report_checks');
    keys(report.appDataGuard, ['evidencePath']);
    check(evidence.has(report.appDataGuard.evidencePath), 'appdata_evidence');
    const boundary = JSON.parse(evidence.get(report.appDataGuard.evidencePath));
    const appDataGuard = verifyBootstrapAppDataBoundary(boundary, qualification);
    const metadata = fs.lstatSync(boundary.databasePath);
    const databaseIdentity = { path: boundary.databasePath, dev: String(metadata.dev), ino: String(metadata.ino) };
    const used = new Set([report.appDataGuard.evidencePath]);
    for (const item of report.cases) {
        keys(item, ['name','evidencePath']);
        check(typeof item.evidencePath === 'string' && evidence.has(item.evidencePath) && !used.has(item.evidencePath), 'report_evidence');
        const observed = JSON.parse(evidence.get(item.evidencePath));
        check(observed.name === item.name, 'report_evidence');
        checkRehearsalCase(observed, qualification.previous, report, databaseIdentity);
        used.add(item.evidencePath);
        verifyRehearsalTrace(observed, evidence, used, qualification.previous);
    }
    verifyBootstrapHarnessClosure(evidence, qualification.rehearsal.harnessClosureSha256, used);
    check(used.size === evidence.size, 'evidence_unused');
    return { used, appDataGuard, databasePath: boundary.databasePath };
}

function verifyBootstrapHarnessClosure(evidence, expected, used) {
    const name = 'harness-closure.json'; check(evidence.has(name) && !used.has(name), 'harness_closure_missing');
    const bytes = evidence.get(name), closure = JSON.parse(bytes);
    check(sha(bytes) === expected, 'harness_closure_digest'); used.add(name);
    keys(closure, ['schema','entrypoint','files']);
    check(closure.schema === 'nassaj-bootstrap-rehearsal-harness/v1' && Array.isArray(closure.files)
        && closure.files.length > 0 && closure.files.length <= 64, 'harness_closure_schema');
    const files = new Set();
    for (const item of closure.files) {
        keys(item, ['path','mode','size','sha256']);
        check(typeof item.path === 'string' && /\.(?:mjs|py|sh|json)$/.test(item.path)
            && !files.has(item.path) && !used.has(item.path) && evidence.has(item.path)
            && item.mode === 0o600 && item.size === evidence.get(item.path).length
            && item.sha256 === sha(evidence.get(item.path)), 'harness_closure_file');
        files.add(item.path); used.add(item.path);
    }
    check(files.has(closure.entrypoint) && /\.(?:mjs|py|sh)$/.test(closure.entrypoint), 'harness_entrypoint');
}

/** Check the reviewed dedicated-directory statement against current canonical filesystem identity. */
export function verifyBootstrapAppDataBoundary(boundary, qualification) {
    keys(boundary, ['schema','directory','dev','ino','databasePath','purpose']);
    check(boundary.schema === 'nassaj-bootstrap-appdata-boundary/v1' && boundary.purpose === 'exclusive-application-data'
        && path.isAbsolute(boundary.directory) && path.isAbsolute(boundary.databasePath)
        && path.dirname(boundary.databasePath) === boundary.directory
        && boundary.directory !== '/' && !['/home','/var','/var/lib','/tmp','/var/tmp'].includes(boundary.directory), 'appdata_boundary');
    for (const protectedPath of [qualification.installation.root, qualification.installation.commonGit]) {
        check(protectedPath !== boundary.directory && !protectedPath.startsWith(`${boundary.directory}/`), 'appdata_shared_directory');
    }
    const metadata = fs.lstatSync(boundary.directory), database = fs.lstatSync(boundary.databasePath);
    check(metadata.isDirectory() && !metadata.isSymbolicLink() && fs.realpathSync(boundary.directory) === boundary.directory
        && metadata.uid === qualification.installation.serviceUid && (metadata.mode & 0o777) === 0o700
        && String(metadata.dev) === boundary.dev && String(metadata.ino) === boundary.ino
        && database.isFile() && !database.isSymbolicLink() && fs.realpathSync(boundary.databasePath) === boundary.databasePath
        && database.uid === metadata.uid && database.nlink === 1 && (database.mode & 0o777) === 0o600, 'appdata_identity');
    return { directory: boundary.directory, dev: boundary.dev, ino: boundary.ino, dedicated: true,
        attestationSha256: sha(canonical(qualification)) };
}

function readQualificationEvidenceIndex(directory, index) {
    keys(index, ['schema','files']);
    check(index.schema === 'nassaj-bootstrap-evidence-index/v1' && Array.isArray(index.files)
        && index.files.length > 0 && index.files.length <= 128, 'evidence_index');
    const files = new Map(); let total = 0;
    for (const item of index.files) {
        keys(item, ['path','size','sha256']);
        check(typeof item.path === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(item.path)
            && !files.has(item.path) && !['qualification.json','report.json','evidence-index.json','qa-review.json'].includes(item.path)
            && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 4 * 1024 * 1024, 'evidence_entry');
        total += item.size; check(total <= 16 * 1024 * 1024, 'evidence_limit');
        const bytes = readBootstrapPinnedFile(path.join(directory, item.path), item.sha256);
        check(bytes.length === item.size, 'evidence_size'); files.set(item.path, bytes);
    }
    const expected = [...files.keys(), 'qualification.json','report.json','evidence-index.json','qa-review.json'].sort();
    check(canonical(fs.readdirSync(directory).sort()) === canonical(expected), 'evidence_unlisted');
    return files;
}

/** Verify the closed evidence package against independently captured previous material and the actual executor code. */
export function inspectBootstrapQualification({ installation, actualPrevious, liveManifest, executorCodeClosureSha256,
    verifierClosureSha256, qualificationReference }) {
    keys(qualificationReference, ['directory','sha256']);
    const directory = qualificationReference.directory, metadata = fs.lstatSync(directory);
    check(path.isAbsolute(directory) && fs.realpathSync(directory) === directory && metadata.isDirectory()
        && !metadata.isSymbolicLink() && metadata.uid === process.getuid() && (metadata.mode & 0o777) === 0o700, 'evidence_directory');
    const qualificationBytes = readBootstrapPinnedFile(path.join(directory, 'qualification.json'), qualificationReference.sha256);
    const qualification = JSON.parse(qualificationBytes);
    const material = validateBootstrapQualificationMaterial(qualification, { installation, previous: actualPrevious }, liveManifest);
    check(material.qualificationSha256 === qualificationReference.sha256
        && qualification.rehearsal.executorClosureSha256 === executorCodeClosureSha256
        && qualification.rehearsal.verifierClosureSha256 === verifierClosureSha256, 'qualification_closure');
    const read = (name, digest) => JSON.parse(readBootstrapPinnedFile(path.join(directory, name), digest));
    const report = read('report.json', qualification.rehearsal.reportSha256);
    const index = read('evidence-index.json', qualification.rehearsal.evidenceIndexSha256);
    const evidence = readQualificationEvidenceIndex(directory, index);
    const result = verifyBootstrapRehearsalObservations(report, qualification, evidence);
    verifyBootstrapIndependentReview(read('qa-review.json', qualification.review.receiptSha256), qualification);
    return { ...material, reportSha256: qualification.rehearsal.reportSha256, reviewReceiptSha256: qualification.review.receiptSha256,
        executorCodeClosureSha256, appDataGuard: result.appDataGuard, databasePath: result.databasePath, evidence };
}

function verifyBootstrapIndependentReview(review, qualification) {
    keys(review, ['schema','decision','checkSet','previousMaterialSha256','reportSha256','evidenceIndexSha256',
        'harnessClosureSha256','verifierClosureSha256','executorClosureSha256','reviewer','source']);
    check(review.schema === 'nassaj-bootstrap-independent-review/v1' && review.decision === 'accept'
        && review.checkSet === 'actual-old-bootstrap-checks/v1', 'qualification_review');
    for (const key of REHEARSAL_KEYS.filter(key => key !== 'schema')) {
        check(review[key] === qualification.rehearsal[key], 'qualification_review_binding');
    }
    keys(review.reviewer, ['identity','role']);
    check(typeof review.reviewer.identity === 'string' && review.reviewer.identity.length > 0
        && review.reviewer.role === 'independent-qa', 'qualification_reviewer');
    keys(review.source, ['harness','conversationId','transcriptRef','messageSha256']);
    check(['harness','conversationId','transcriptRef'].every(key => typeof review.source[key] === 'string' && review.source[key].length > 0)
        && HASH.test(review.source.messageSha256 || ''), 'qualification_review_source');
}
