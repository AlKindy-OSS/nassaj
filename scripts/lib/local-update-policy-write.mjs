/** Governed CAS writes for the existing local-update policy control record. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { commonGitDir, gitControlPath } from '../git-control-root.mjs';
import { withPreviewEventMutationLock } from '../local-preview-ledger.mjs';
import { readPublicationControlJson, clientPublicationPolicyEnabled } from './client-publication-policy.mjs';
import { canonicalTripleJson } from './oid-triple-target.mjs';
import { LOCAL_UPDATE_POLICY_FILE, readLocalUpdatePolicy, localUpdatePolicyInstallation,
    assertLocalUpdatePolicyCapability as capabilityInput } from './local-update-policy.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => createHash('sha256').update(canonicalTripleJson(value)).digest('hex');
const receiptName = key => `nassaj-local-update-policy-receipt-${key}.json`;
function readControl(root, name) {
    try { return readPublicationControlJson(gitControlPath(root, name)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writePinned(root, name, value, exclusive = false) {
    const directory = commonGitDir(root);
    const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(dir), base = `/proc/self/fd/${dir}`;
    try {
        if (stat.uid !== process.getuid() || (stat.mode & 0o022)) fail('local_update_policy_control_permissions');
        const temporary = `${name}.tmp-${randomUUID()}`;
        const file = exclusive ? name : temporary;
        const fd = fs.openSync(path.join(base, file), fs.constants.O_WRONLY | fs.constants.O_CREAT
            | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, `${canonicalTripleJson(value)}\n`); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        if (!exclusive) fs.renameSync(path.join(base, temporary), path.join(base, name));
        fs.fsyncSync(dir);
    } finally { fs.closeSync(dir); }
}

function mutationInput(input) {
    if (!Number.isSafeInteger(input.ownerId) || input.ownerId < 1
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
        || !['disabled', 'dev-full-auto'].includes(input.mode)
        || typeof input.idempotencyKey !== 'string' || !/^[\x21-\x7e]{16,200}$/.test(input.idempotencyKey)) {
        fail('local_update_policy_invalid_request');
    }
}

/** CAS policy changes and immutable receipts share the executor's event serialization boundary. */
export async function writeLocalUpdatePolicy(root, input) {
    mutationInput(input);
    return withPreviewEventMutationLock(root, () => {
        const current = readLocalUpdatePolicy(root), scope = localUpdatePolicyInstallation(root);
        const request = { mode: input.mode, expectedRevision: input.expectedRevision, ownerId: input.ownerId, ...scope };
        const key = digest([input.ownerId, input.idempotencyKey]), fingerprint = digest(request);
        let receipt = readControl(root, receiptName(key));
        if (receipt && receipt.requestFingerprint !== fingerprint) fail('local_update_policy_idempotency_conflict');
        if (receipt && current.receiptKey === key && current.receiptDigest === digest(receipt)) return current;
        if (current.revision !== input.expectedRevision) fail('local_update_policy_revision_conflict');
        const capability = input.mode === 'dev-full-auto' ? capabilityInput(input) : null;
        if (input.mode === 'dev-full-auto' && clientPublicationPolicyEnabled(root)) fail('local_update_policy_client_conflict');
        if (!receipt) {
            const policy = { schema: 'nassaj-local-update-policy/v1', ...scope, mode: input.mode,
                revision: current.revision + 1, ownerId: input.ownerId, changedAt: Date.now() };
            receipt = { schema: 'nassaj-local-update-policy-receipt/v1', requestFingerprint: fingerprint,
                previousDigest: digest(current), policy, capability };
            writePinned(root, receiptName(key), receipt, true);
        }
        if (receipt.previousDigest !== digest(current)) fail('local_update_policy_previous_changed');
        const next = { ...receipt.policy, receiptKey: key, receiptDigest: digest(receipt) };
        writePinned(root, LOCAL_UPDATE_POLICY_FILE, next);
        return next;
    });
}

