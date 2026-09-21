/** Trusted readers bind live process, baseline receipts and current serving lineage. */
import fs from 'node:fs';
import path from 'node:path';
import { validateOidPairTerminal } from '../oid-control-capsule.mjs';
import { verifyUpdateRuntimeBundle } from './update-runtime-bundle.mjs';
import { randomUUID } from 'node:crypto';
import { gitControlPath } from '../git-control-root.mjs';
import { readPublicationControlJson } from './client-publication-policy.mjs';
import { clientPublicationDigest as digest, readClientPublicationFile, validateClientAssetManifest } from './client-publication-artifacts.mjs';
import { validateClientPublicationJournal } from './client-publication-journal.mjs';
import { readPreviewLedger, recordClientServingLineage } from '../local-preview-ledger.mjs';
const RUNTIME = 'nassaj-client-publication-runtime-v1.json';
const SERVING = 'nassaj-client-publication-serving-v1.json';
const fail = code => { throw new Error(code); };

/** A full receipt and the still-loaded process must corroborate every authority claim. */
export function readClientPublicationRuntime(root) {
    const binding = readPublicationControlJson(gitControlPath(root, RUNTIME));
    if (binding.schema !== 'nassaj-client-publication-runtime/v1') fail('client_publication_runtime_invalid');
    const identity = binding.serverIdentity;
    if (!Number.isSafeInteger(identity?.pid) || identity.pid < 1 || !/^\d+$/.test(identity.startTime || '')) fail('client_publication_process_invalid');
    const processStat = fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
    if (processStat.slice(processStat.lastIndexOf(')') + 2).split(/\s+/)[19] !== identity.startTime) fail('client_publication_process_changed');
    const manifestBytes = readClientPublicationFile(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'));
    if (digest(manifestBytes) !== identity.controlManifestDigest || digest(manifestBytes) !== binding.installedControlDigest) fail('client_publication_loaded_control_changed');
    const manifest = JSON.parse(manifestBytes);
    if (manifest.oid !== identity.sourceOid || manifest.serverBuildId !== identity.buildId
        || manifest.capabilities?.clientPublicationV1 !== 'nassaj-dev-client-publication/v1') fail('client_publication_loaded_control_unqualified');
    const nonce = binding.fullReceipt?.transactionNonce;
    if (!/^[a-f0-9]{64}$/.test(nonce || '')) fail('client_publication_full_receipt_invalid');
    const proofFile = gitControlPath(root, `nassaj-oid-pair-serving-${nonce}.json`);
    const proof = readPublicationControlJson(proofFile);
    if (digest(readClientPublicationFile(proofFile)) !== binding.baseReceiptDigest || proof.outcome !== 'served'
        || proof.serverBuildId !== identity.buildId
        || proof.nodeModulesTreeSha256 !== binding.dependencyIdentity) fail('client_publication_full_receipt_invalid');
    if (Object.hasOwn(binding, 'processReceipt')) verifyRollbackProcessReceipt(root, binding, proof);
    else if (proof.pid !== identity.pid || proof.startTime !== identity.startTime) fail('client_publication_full_receipt_invalid');
    const bundle = verifyUpdateRuntimeBundle(path.join(root, 'dist-server'));
    if (bundle.manifest.buildId !== binding.updateRuntimeBuildId) fail('client_publication_loaded_bundle_changed');
    return binding;
}

function originalProcessBinding(binding, original) {
    const { processReceipt, ...rest } = binding;
    return { ...rest, serverIdentity: { ...rest.serverIdentity, pid: original.serverIdentity.pid, startTime: original.serverIdentity.startTime } };
}

function verifyRollbackSnapshot(root, binding, transaction) {
    const previous = transaction.pair.previous, snapshot = previous.clientPublication;
    if (snapshot?.schema !== 'nassaj-client-publication-previous/v1') fail('client_publication_rollback_snapshot_invalid');
    const { snapshotDigest, ...captured } = snapshot;
    if (digest(captured) !== snapshotDigest) fail('client_publication_rollback_snapshot_changed');
    const immutable = readPublicationControlJson(gitControlPath(root, `nassaj-client-publication-baseline-${binding.baseReceiptDigest}.json`));
    if (immutable.schema !== 'nassaj-client-publication-baseline/v1' || !immutable.binding
        || digest(originalProcessBinding(binding, immutable.binding)) !== digest(immutable.binding)
        || digest(originalProcessBinding(snapshot.binding, immutable.binding)) !== digest(immutable.binding)) fail('client_publication_rollback_authority_changed');
    verifyServingPointer(root, snapshot.serving);
    if (snapshot.serving.baseReceiptDigest !== binding.baseReceiptDigest || snapshot.serving.buildId !== previous.clientBuildId
        || snapshot.serving.sourceOid !== previous.clientOid || previous.serverBuildId !== binding.serverIdentity.buildId
        || previous.controlManifestSha256 !== binding.installedControlDigest
        || previous.nodeModulesTreeSha256 !== binding.dependencyIdentity) fail('client_publication_rollback_previous_changed');
    return snapshot;
}

function verifyRollbackHttp(root, transaction, receipt, snapshot) {
    const previous = transaction.pair.previous, http = receipt.http;
    if (receipt.serverOid !== snapshot.binding.baselineOid || receipt.clientBuildIdServed !== previous.clientBuildId
        || receipt.oidNodeModulesTreeSha256 !== previous.nodeModulesTreeSha256 || receipt.oidPairTargetDigest !== transaction.pair.targetDigest
        || http?.schema !== 'nassaj-client-http-serving/v1' || !Array.isArray(http.files) || http.files.length !== 2) fail('client_publication_rollback_http_invalid');
    const generation = snapshot.serving.generationId;
    if (!/^[a-f0-9]{64}$/.test(generation || '')) fail('client_publication_rollback_generation_invalid');
    const archive = path.join(root, '.nassaj-local-preview/client-assets/generations', generation);
    validateClientAssetManifest(archive, { manifestDigest: snapshot.serving.assetManifestDigest, buildId: previous.clientBuildId, sourceOid: previous.clientOid }, () => {});
    for (const name of ['index.html', 'version.json']) {
        const observed = http.files.find(entry => entry.path === name);
        if (observed?.status !== 200 || observed.sha256 !== digest(readClientPublicationFile(path.join(archive, name)))) fail('client_publication_rollback_http_changed');
    }
}

/** Verify typed PRE_CANDIDATE rollback authority; corrupt process receipts never fall back to the original PID. */
function verifyRollbackProcessReceipt(root, binding, fullProof) {
    const link = binding.processReceipt;
    if (link?.schema !== 'nassaj-client-publication-process-receipt/v1' || !Number.isSafeInteger(link.sequence) || link.sequence < 1
        || ['transactionNonce', 'receiptDigest', 'journalDigest'].some(key => !/^[a-f0-9]{64}$/.test(link[key] || ''))) fail('client_publication_process_receipt_invalid');
    const journalFile = gitControlPath(root, `nassaj-oid-control-transaction-${link.sequence}-${link.transactionNonce}.json`);
    const transaction = readPublicationControlJson(journalFile);
    if (digest(readClientPublicationFile(journalFile)) !== link.journalDigest || transaction.sequence !== link.sequence
        || transaction.transactionNonce !== link.transactionNonce || transaction.state !== 'pair_rolled_back'
        || transaction.schema !== 'nassaj-oid-control-transaction/v2' || transaction.pair?.databaseState !== 'PRE_CANDIDATE'
        || transaction.pair?.target?.schema !== 'nassaj-oid-triple-target/v2' || !validateOidPairTerminal(root, transaction)) fail('client_publication_rollback_terminal_invalid');
    const receiptFile = gitControlPath(root, `nassaj-oid-pair-receipt-${link.transactionNonce}.json`), receipt = readPublicationControlJson(receiptFile);
    if (digest(readClientPublicationFile(receiptFile)) !== link.receiptDigest || link.receiptDigest !== transaction.pair.receiptSha256
        || receipt.transactionNonce !== link.transactionNonce || receipt.pid !== binding.serverIdentity.pid || receipt.startTime !== binding.serverIdentity.startTime
        || receipt.serverBuildId !== binding.serverIdentity.buildId || receipt.nodeModulesTreeSha256 !== binding.dependencyIdentity
        || fullProof.serverBuildId !== binding.serverIdentity.buildId) fail('client_publication_rollback_process_changed');
    const snapshot = verifyRollbackSnapshot(root, binding, transaction);
    verifyRollbackHttp(root, transaction, receipt, snapshot);
    // This is historical process authority. The client executor separately proves
    // live layout, HTTP bytes and lineage CAS, including exchange → pointer gaps.
    // Requiring dist to match the old pointer here would reject that transaction.
}

/** Read the durable lineage and verify its immutable full or client receipt before use. */
export function readClientPublicationServing(root) {
    return verifyServingPointer(root, readPublicationControlJson(gitControlPath(root, SERVING)));
}

function verifyServingPointer(root, value) {
    if (value.schema !== 'nassaj-client-publication-serving/v1' || !['full', 'client'].includes(value.kind) || !/^[a-f0-9]{64}$/.test(value.baseReceiptDigest || '')) fail('client_publication_serving_invalid');
    if (value.kind === 'full') {
        const file = gitControlPath(root, `nassaj-client-publication-baseline-${value.baseReceiptDigest}.json`);
        if (digest(readClientPublicationFile(file)) !== value.receiptDigest) fail('client_publication_baseline_changed');
        const snapshot = readPublicationControlJson(file), baseline = snapshot.binding;
        if (snapshot.schema !== 'nassaj-client-publication-baseline/v1' || !baseline || !snapshot.lineage
            || Object.entries(snapshot.lineage).some(([key, expected]) => value[key] !== expected)) fail('client_publication_baseline_pointer_changed');
        if (baseline.baseReceiptDigest !== value.baseReceiptDigest || baseline.baselineOid !== value.sourceOid) fail('client_publication_baseline_pointer_changed');
        const full = readPublicationControlJson(gitControlPath(root, `nassaj-oid-pair-serving-${baseline.fullReceipt?.transactionNonce}.json`));
        if (full.clientBuildId !== value.buildId || !baseline.clientIdentity
            || ['sourceOid', 'buildId', 'assetManifestDigest', 'generationId'].some(key => value[key] !== baseline.clientIdentity[key])) fail('client_publication_baseline_pointer_changed');
    } else {
        const journalFile = gitControlPath(root, `nassaj-oid-control-transaction-${value.sequence}-${value.transactionNonce}.json`);
        const checked = validateClientPublicationJournal(root, { file: journalFile, value: readPublicationControlJson(journalFile) });
        if (!checked.terminal || checked.receiptDigest !== value.receiptDigest) fail('client_publication_serving_receipt_changed');
        const selected = checked.receipt.outcome === 'served' ? checked.intent.targetClientIdentity : checked.intent.previousClientIdentity;
        if (value.baseReceiptDigest !== checked.intent.baseReceiptDigest || value.sourceOid !== selected.sourceOid
            || value.buildId !== selected.buildId || value.assetManifestDigest !== selected.assetManifestDigest) fail('client_publication_serving_pointer_changed');
    }
    return value;
}

function replace(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`, fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** CAS lineage after a verified terminal result; caller holds event EX, ledger has its own short lock. */
export function recordClientPublicationServing(root, outcome, { expectedParentReceiptDigest }) {
    const current = readClientPublicationServing(root), intent = outcome.intent ?? outcome.receipt?.intent;
    const file = gitControlPath(root, `nassaj-oid-control-transaction-${intent.sequence}-${intent.transactionNonce}.json`);
    const checked = validateClientPublicationJournal(root, { file, value: readPublicationControlJson(file) });
    if (!checked.terminal || checked.receiptDigest !== outcome.receiptDigest) fail('client_publication_serving_receipt_invalid');
    if (current.receiptDigest !== expectedParentReceiptDigest && current.receiptDigest !== outcome.receiptDigest) fail('client_publication_serving_lineage_conflict');
    const sealed = validateClientAssetManifest(path.join(root, 'dist'), {}, () => {});
    const selected = checked.receipt.outcome === 'served' ? intent.targetClientIdentity : intent.previousClientIdentity;
    if (sealed.manifestDigest !== selected.assetManifestDigest || sealed.treeDigest !== selected.treeDigest) fail('client_publication_serving_layout_changed');
    const value = { schema: 'nassaj-client-publication-serving/v1', receiptDigest: checked.receiptDigest,
        baseReceiptDigest: intent.baseReceiptDigest, sourceOid: selected.sourceOid, buildId: selected.buildId,
        assetManifestDigest: selected.assetManifestDigest, generationId: sealed.manifest.generationId,
        kind: 'client', transactionNonce: intent.transactionNonce, sequence: intent.sequence };
    const ledger = readPreviewLedger(root).clientPublicationServing;
    if (ledger?.receiptDigest !== value.receiptDigest) recordClientServingLineage(root, { ...value, expectedReceiptDigest: ledger?.receiptDigest ?? null });
    replace(gitControlPath(root, SERVING), value);
    return value;
}
