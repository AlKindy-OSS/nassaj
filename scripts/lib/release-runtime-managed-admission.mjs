/** Pure root-private managed restart authority verification; no host effects or process launch imports. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
export const managedCanonical = value => Array.isArray(value) ? `[${value.map(managedCanonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${managedCanonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const canonical = managedCanonical;
const sha = value => createHash('sha256').update(value).digest('hex');
function deny(reason) { throw Error(`managed_restart_${reason}`); }
function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')) deny('fields_invalid');
}
/** Verify a fresh explicit owner signature against independently loaded committed state and private config. */
export function verifyManagedRestartApproval(config, approval, operationId, commitReceiptSha256, publicKeyPem, now = Date.now()) {
    exact(approval, 'schema,action,scope,target,ownerId,nonce,issuedAt,expiresAt,signature');
    const { signature, ...payload } = approval;
    const identity = config.bootstrapClaim.identity;
    const target = { schema: 'nassaj-managed-restart-approval-target/v1', operationId,
        nodeInstanceId: config.expected.nodeInstanceId, generationId: config.expected.generationId,
        releaseIdentitySha256: config.expected.releaseIdentitySha256, databaseContractSha256: config.expected.databaseContractSha256,
        startupClosureSha256: identity.startupClosureSha256, commitReceiptSha256,
        ownerApprovalKeySha256: config.expected.ownerApprovalKeySha256, expectedSha256: sha(canonical(config.expected)),
        managedConfigurationSha256: sha(canonical(config.managedRestart)) };
    if (!ID.test(operationId || '') || !HEX.test(commitReceiptSha256 || '')
        || Object.entries(target).some(([key, value]) => key.endsWith('Sha256') && !HEX.test(value || ''))
        || canonical(payload.target) !== canonical(target) || payload.schema !== 'nassaj-owner-managed-restart-approval/v1'
        || payload.action !== 'restartCommittedGeneration' || payload.scope !== 'same-generation-managed-restart/v1'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(payload.ownerId || '') || !/^[a-f0-9]{48}$/.test(payload.nonce || '')
        || !Number.isSafeInteger(now) || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
        || payload.issuedAt < 0 || payload.issuedAt > now || payload.expiresAt <= now
        || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > 300000
        || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) deny('approval_invalid');
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || sha(key.export({ type: 'spki', format: 'der' })) !== target.ownerApprovalKeySha256
        || !verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'base64url'))) deny('signature_invalid');
    return Object.freeze({ approvalSha256: sha(canonical(approval)), targetSha256: sha(canonical(target)),
        acceptedAt: now, operationId });
}

/** Read a canonical root-private regular file without following the leaf. */
export function readManagedRootFile(file, ownerUid = 0) {
    if (!path.isAbsolute(file || '') || fs.realpathSync(file) !== file) deny('record_path_unsafe');
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
        const info = fs.lstatSync(parent);
        if (!info.isDirectory() || info.isSymbolicLink() || ![0, ownerUid].includes(info.uid) || (info.mode & 0o022)) deny('record_ancestor_unsafe');
        if (parent === path.dirname(parent)) break;
    }
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== ownerUid || (before.mode & 0o777) !== 0o600
        || before.size < 1 || before.size > 262144) deny('record_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const opened = fs.fstatSync(fd);
        if (['dev', 'ino', 'size', 'mode', 'uid'].some(key => opened[key] !== before[key])) deny('record_changed');
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}
function originalAuthority(config, journal, grant, read, uid, keyPem) {
    if (journal.state !== 'committed' || journal.phase !== 'committed' || grant.state !== 'active'
        || grant.authorityId !== journal.transactionId || grant.commitReceiptSha256 !== sha(canonical(journal))
        || grant.activationClaimSha256 !== sha(canonical(journal.startupClaim))
        || canonical(journal.expected) !== canonical(config.expected)
        || canonical(grant.identity) !== canonical(config.bootstrapClaim.identity)) deny('original_grant_invalid');
    const approval = JSON.parse(read(config.bootstrapClaim.approvalFile, uid)); const { signature, ...payload } = approval;
    const key = createPublicKey(keyPem);
    if (payload.schema !== 'nassaj-owner-cutover-approval/v1' || payload.action !== 'release-runtime-first-cutover'
        || payload.expectedSha256 !== sha(canonical(config.expected)) || canonical(payload.startupAdmission) !== canonical(grant.identity)
        || grant.approvalSha256 !== sha(canonical(approval)) || journal.approvalSha256 !== grant.approvalSha256
        || !Number.isSafeInteger(journal.approvalAcceptedAt) || journal.approvalAcceptedAt < payload.issuedAt
        || journal.approvalAcceptedAt >= payload.expiresAt || typeof signature !== 'string'
        || !verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'base64url'))) deny('original_approval_invalid');
}
/** Revalidate the same durably accepted signed operation; elapsed TTL cannot mint or refresh authority. */
function readVerifiedManagedRecord(config, operationId, deps, terminal) {
    const read = deps.readRootFile || readManagedRootFile; const uid = deps.ownerUid ?? 0; const now = deps.now?.() ?? Date.now();
    if (!ID.test(operationId || '')) deny('operation_invalid');
    const journal = JSON.parse(read(path.join(config.controlRoot, terminal ? `managed-restart-terminal-${operationId}.json` : 'managed-restart.json'), uid));
    const state = JSON.parse(read(path.join(config.controlRoot, 'startup-admission.json'), uid));
    const first = JSON.parse(read(path.join(config.controlRoot, 'first-cutover.json'), uid));
    if (journal.schema !== 'nassaj-managed-restart/v1' || journal.operationId !== operationId || !ID.test(operationId || '')
        || !Number.isSafeInteger(journal.revision) || journal.revision < 1 || !Number.isSafeInteger(journal.approvalAcceptedAt)
        || journal.approvalAcceptedAt > now || journal.originalGrantSha256 !== sha(canonical(journal.originalGrant))
        || journal.originalGrant?.managedOperationId || journal.originalGrant?.revocation
        || !Number.isSafeInteger(state.revision) || state.revision < journal.originalGrant.revision
        || !Number.isSafeInteger(state.generationEpoch) || state.generationEpoch < journal.originalGrant.generationEpoch
        || !['prepared','deferred_after_begin','ingress_closed','restart_execution_intent','replacement_claim_pending','replacement_claimed',
            'security_startup_authorized','private_verified','ingress_opened','public_verified','committed','manual_recovery'].includes(journal.phase)
        || state.revocation || journal.revocation
        || state.authorityId !== journal.originalGrant.authorityId || canonical(state.identity) !== canonical(journal.originalGrant.identity)
        || (terminal ? (journal.phase !== 'committed' || state.managedCommittedOperationId !== operationId || state.managedCommitSha256 !== sha(canonical(journal)))
            : (state.managedOperationId !== operationId && !(['prepared','manual_recovery'].includes(journal.phase) && canonical(state) === canonical(journal.originalGrant))
            && !(journal.phase === 'committed' && state.state === 'active' && state.managedCommitSha256 === sha(canonical(journal)))))) deny('journal_authority_invalid');
    const approvalFile = path.join(config.controlRoot, 'managed-restart-approval.json');
    if (config.managedRestart.approvalFile !== approvalFile) deny('approval_path_invalid');
    const approval = terminal ? journal.approval : JSON.parse(read(approvalFile, uid));
    if (!approval || canonical(approval) !== canonical(journal.approval)) deny('embedded_approval_changed');
    const keyPem = read(config.bootstrapClaim.ownerApprovalPublicKeyFile, uid);
    const verified = verifyManagedRestartApproval(config, approval, operationId, journal.originalGrant.managedCommitSha256 || journal.originalGrant.commitReceiptSha256, keyPem, journal.approvalAcceptedAt);
    if (verified.approvalSha256 !== journal.approvalSha256 || approval.nonce !== journal.approvalNonce) deny('accepted_approval_changed');
    originalAuthority(config, first, journal.originalGrant, read, uid, keyPem);
    return Object.freeze(journal);
}

/** Independently read a pinned executable through a no-follow descriptor; parent directories must be canonical and protected. */
export function verifyManagedRestartExecutable(file, expectedSha256) {
    if (!path.isAbsolute(file || '') || !HEX.test(expectedSha256 || '') || fs.realpathSync(file) !== file) deny('pin_path_invalid');
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
        const info = fs.lstatSync(parent);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) deny('pin_ancestor_unsafe');
        if (parent === path.dirname(parent)) break;
    }
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || (before.mode & 0o022)
        || before.size < 1 || before.size > 256 * 1024 * 1024) deny('pin_file_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd);
        if (['dev', 'ino', 'size', 'mode', 'uid'].some(key => opened[key] !== before[key])
            || sha(fs.readFileSync(fd)) !== expectedSha256) deny('pin_changed');
    } finally { fs.closeSync(fd); }
}

/** Verify the current in-progress pointer and its presently installed approval. */
export function readVerifiedManagedRestart(config, operationId, deps = {}) {
    return readVerifiedManagedRecord(config, operationId, deps, false);
}
/** Verify exactly the terminal selected by current active state, never scan or restore older history. */
export function readVerifiedManagedTerminal(config, operationId, deps = {}) {
    return readVerifiedManagedRecord(config, operationId, deps, true);
}
