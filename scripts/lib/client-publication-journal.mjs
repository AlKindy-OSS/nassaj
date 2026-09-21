/** Durable client publication intents and receipts; terminal strings never grant authority. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { clientPublicationCanonical as canonical, clientPublicationDigest as digest, readClientPublicationFile,
    validateClientAssetManifest } from './client-publication-artifacts.mjs';

export const CLIENT_PUBLICATION_JOURNAL_SCHEMA = 'nassaj-oid-client-publication/v1';
export const CLIENT_PUBLICATION_RECEIPT_SCHEMA = 'nassaj-client-publication-receipt/v1';
const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const STATES = ['prepared', 'publishing', 'verifying', 'recovery_required', 'served', 'rolled_back', 'cancelled'];
const FIELDS = ['schema', 'kind', 'transactionNonce', 'sequence', 'sourceOid', 'policyRevision', 'reservationId',
    'baseReceiptDigest', 'parentServingReceiptDigest', 'serverIdentity', 'dependencyIdentity',
    'previousClientIdentity', 'targetClientIdentity', 'candidateManifestDigest', 'compatibilityProofDigest', 'assetManifestDigest'];

function controlDirectory(root) {
    const run = spawnSync('/usr/bin/git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
    if (run.status !== 0) throw new Error('client_publication_git_control_unavailable');
    const directory = run.stdout.trim(), stat = fs.lstatSync(directory);
    if (!path.isAbsolute(directory) || !stat.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('client_publication_git_control_unsafe');
    return directory;
}

function files(root, value) {
    const directory = controlDirectory(root);
    return { directory, journal: path.join(directory, `nassaj-oid-control-transaction-${value.sequence}-${value.transactionNonce}.json`),
        intent: path.join(directory, `nassaj-oid-client-intent-${value.transactionNonce}.json`),
        receipt: path.join(directory, `nassaj-oid-client-receipt-${value.transactionNonce}.json`) };
}

function syncDirectory(directory) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function durableCreate(file, value) {
    const bytes = Buffer.from(`${canonical(value)}\n`), fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(file));
    return digest(bytes);
}

function replace(file, value) {
    const temporary = `${file}.${process.pid}.tmp`;
    try { durableCreate(temporary, value); fs.renameSync(temporary, file); syncDirectory(path.dirname(file)); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function identity(value) {
    return value && HEX40.test(value.sourceOid || '') && HEX64.test(value.buildId || '') && HEX64.test(value.treeDigest || '') && HEX64.test(value.assetManifestDigest || '');
}

/** Strict installed-executor identity used by both intent and serving proof consumers. */
export function assertClientPublicationServerIdentity(value) {
    if (!value || !HEX40.test(value.sourceOid || '') || !HEX64.test(value.buildId || '')
        || !HEX64.test(value.controlManifestDigest || '') || !Number.isSafeInteger(value.pid) || value.pid < 1
        || !/^\d+$/.test(value.startTime || '') || !HEX64.test(value.baseReceiptDigest || '')) throw new Error('client_publication_server_identity_invalid');
    return value;
}

function intentFields(value) {
    if (!value || value.schema !== CLIENT_PUBLICATION_JOURNAL_SCHEMA || value.kind !== 'client-publication'
        || !HEX64.test(value.transactionNonce || '') || !HEX40.test(value.sourceOid || '')
        || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isSafeInteger(value.policyRevision) || value.policyRevision < 1
        || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.reservationId || '') || !identity(value.previousClientIdentity) || !identity(value.targetClientIdentity)
        || value.targetClientIdentity.sourceOid !== value.sourceOid) throw new Error('client_publication_intent_invalid');
    for (const key of ['baseReceiptDigest', 'parentServingReceiptDigest', 'dependencyIdentity', 'candidateManifestDigest', 'compatibilityProofDigest', 'assetManifestDigest']) {
        if (!HEX64.test(value[key] || '')) throw new Error('client_publication_intent_digest_invalid');
    }
    assertClientPublicationServerIdentity(value.serverIdentity);
    if (value.targetClientIdentity.assetManifestDigest !== value.assetManifestDigest) throw new Error('client_publication_asset_binding_mismatch');
    if (value.serverIdentity.baseReceiptDigest !== value.baseReceiptDigest) throw new Error('client_publication_baseline_mismatch');
    return Object.fromEntries(FIELDS.map(key => [key, value[key]]));
}

function checkedRecord(file) {
    const stat = fs.lstatSync(file);
    if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error('client_publication_record_permissions');
    return JSON.parse(readClientPublicationFile(file, 256 * 1024));
}

/** Validate immutable intent and terminal receipt before nonce or terminal exemptions. */
export function validateClientPublicationJournal(root, entry) {
    const value = entry?.value ?? entry, intent = intentFields(value), paths = files(root, value);
    if (!STATES.includes(value.state) || value.intentDigest !== digest(intent)
        || entry?.file && path.resolve(entry.file) !== paths.journal) throw new Error('client_publication_journal_invalid');
    const pinnedIntent = checkedRecord(paths.intent);
    if (canonical(pinnedIntent) !== canonical(intent)) throw new Error('client_publication_intent_changed');
    if (!['served', 'rolled_back', 'cancelled'].includes(value.state)) {
        if (value.receiptDigest !== undefined) throw new Error('client_publication_premature_receipt');
        return { terminal: false, intent, intentDigest: value.intentDigest };
    }
    const receiptBytes = readClientPublicationFile(paths.receipt, 256 * 1024), receipt = checkedRecord(paths.receipt);
    if (receipt.schema !== CLIENT_PUBLICATION_RECEIPT_SCHEMA || receipt.intentDigest !== value.intentDigest
        || receipt.outcome !== value.state || receipt.transactionNonce !== value.transactionNonce
        || digest(receiptBytes) !== value.receiptDigest || canonical(receipt.intent) !== canonical(intent)
        || !HEX64.test(receipt.servingProofDigest || '') || digest(receipt.servingProof) !== receipt.servingProofDigest) throw new Error('client_publication_receipt_invalid');
    const selected = receipt.outcome === 'served' ? intent.targetClientIdentity : intent.previousClientIdentity;
    if (canonical(receipt.servingProof.clientIdentity) !== canonical(selected)
        || canonical(receipt.servingProof.serverIdentity) !== canonical(intent.serverIdentity)
        || receipt.servingProof.parentServingReceiptDigest !== intent.parentServingReceiptDigest
        || receipt.outcome !== 'cancelled' && (!receipt.servingProof.http || receipt.servingProof.http.schema !== 'nassaj-client-http-serving/v1'
            || !Array.isArray(receipt.servingProof.http.files) || receipt.servingProof.http.files.length !== 2)
        || !Number.isSafeInteger(receipt.servingProof.observedAt) || receipt.servingProof.observedAt < 1) throw new Error('client_publication_serving_proof_invalid');
    return { terminal: true, intent, receipt, receiptDigest: value.receiptDigest };
}

/** Persist a write-once exact intent before the first publication effect; caller holds event lock. */
export function writeClientPublicationIntent(root, supplied) {
    const intent = intentFields(supplied), paths = files(root, intent);
    const value = { ...intent, state: 'prepared', intentDigest: digest(intent) };
    if (fs.existsSync(paths.journal)) {
        const existing = checkedRecord(paths.journal);
        validateClientPublicationJournal(root, { file: paths.journal, value: existing });
        if (existing.intentDigest !== value.intentDigest) throw new Error('client_publication_intent_cas_conflict');
        return existing;
    }
    try { durableCreate(paths.intent, intent); }
    catch (error) { if (error.code !== 'EEXIST' || canonical(checkedRecord(paths.intent)) !== canonical(intent)) throw error; }
    durableCreate(paths.journal, value);
    return value;
}

/** Advance under the existing event lock, comparing nonce, digest and state without blind exchanges. */
export function advanceClientPublicationJournal(root, expected, state) {
    const paths = files(root, expected), value = checkedRecord(paths.journal);
    validateClientPublicationJournal(root, { file: paths.journal, value });
    if (value.intentDigest !== expected.intentDigest || value.state !== expected.state) throw new Error('client_publication_journal_cas_conflict');
    const allowed = { prepared: ['publishing'], publishing: ['verifying', 'recovery_required'], verifying: ['recovery_required'], recovery_required: ['verifying'] };
    if (!allowed[value.state]?.includes(state)) throw new Error('client_publication_transition_invalid');
    const next = { ...value, state }; replace(paths.journal, next); return next;
}

/** Observe the actual selected tree; proof inputs cannot substitute for filesystem evidence. */
export function proveClientPublicationServing(root, intent, outcome, actualServerIdentity, parentServingReceiptDigest, http) {
    if (!['served', 'rolled_back', 'cancelled'].includes(outcome)) throw new Error('client_publication_outcome_invalid');
    const selected = outcome === 'served' ? intent.targetClientIdentity : intent.previousClientIdentity;
    const directory = path.join(root, 'dist'), provenance = JSON.parse(readClientPublicationFile(path.join(directory, 'BUILD_PROVENANCE.json')));
    const tree = validateClientAssetManifest(directory, { sourceOid: selected.sourceOid, buildId: selected.buildId, manifestDigest: selected.assetManifestDigest }, () => {});
    if (provenance.commit !== selected.sourceOid || provenance.buildId !== selected.buildId || tree.treeDigest !== selected.treeDigest
        || canonical(actualServerIdentity) !== canonical(intent.serverIdentity)
        || parentServingReceiptDigest !== intent.parentServingReceiptDigest) throw new Error('client_publication_serving_cas_conflict');
    if (outcome !== 'cancelled') {
        if (http?.schema !== 'nassaj-client-http-serving/v1' || !Array.isArray(http.files) || http.files.length !== 2) throw new Error('client_publication_http_proof_required');
        for (const name of ['index.html', 'version.json']) {
            const evidence = http.files.find(file => file.path === name);
            if (evidence?.status !== 200 || evidence.sha256 !== digest(readClientPublicationFile(path.join(directory, name)))) throw new Error('client_publication_http_proof_mismatch');
        }
    }
    return { clientIdentity: selected, serverIdentity: actualServerIdentity, parentServingReceiptDigest, observedAt: Date.now(), ...(http ? { http } : {}) };
}

/** Write the verified result before terminal journal replacement; caller owns event lock and serving CAS. */
export function writeClientPublicationOutcome(root, expected, options) {
    const paths = files(root, expected), value = checkedRecord(paths.journal);
    const checked = validateClientPublicationJournal(root, { file: paths.journal, value });
    if (value.intentDigest !== expected.intentDigest) throw new Error('client_publication_outcome_cas_conflict');
    if (checked.terminal) {
        if (checked.receipt.outcome !== options.outcome) throw new Error('client_publication_outcome_conflict');
        return checked;
    }
    if (value.state !== expected.state || !(options.outcome === 'cancelled' ? value.state === 'prepared' : ['verifying', 'recovery_required'].includes(value.state))) throw new Error('client_publication_outcome_not_ready');
    const servingProof = proveClientPublicationServing(root, checked.intent, options.outcome, options.actualServerIdentity, options.parentServingReceiptDigest, options.servingEvidence);
    let receipt = { schema: CLIENT_PUBLICATION_RECEIPT_SCHEMA, transactionNonce: value.transactionNonce, intent: checked.intent,
        intentDigest: value.intentDigest, outcome: options.outcome, servingProof, servingProofDigest: digest(servingProof) };
    try { durableCreate(paths.receipt, receipt); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = checkedRecord(paths.receipt);
        if (existing.intentDigest !== receipt.intentDigest || existing.outcome !== receipt.outcome) throw new Error('client_publication_receipt_conflict');
        receipt = existing;
    }
    const next = { ...value, state: options.outcome, receiptDigest: digest(readClientPublicationFile(paths.receipt)) };
    const verified = validateClientPublicationJournal(root, { file: paths.journal, value: next });
    replace(paths.journal, next);
    return verified;
}

/** Read a time-invariant, verified receipt for lineage; live-state checks are separate. */
export function readClientPublicationReceipt(root, expected) {
    const paths = files(root, expected), value = checkedRecord(paths.journal), result = validateClientPublicationJournal(root, { file: paths.journal, value });
    if (!result.terminal || expected.receiptDigest && result.receiptDigest !== expected.receiptDigest) throw new Error('client_publication_receipt_unavailable');
    return result;
}
