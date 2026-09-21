/** Produce installation-bound full baselines only from a verified full-update serving receipt. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateClientPublicationJournal } from './client-publication-journal.mjs';
import { spawnSync } from 'node:child_process';
import { clientPublicationCanonical as canonical, clientPublicationDigest as digest, readClientPublicationFile,
    validateClientAssetManifest } from './client-publication-artifacts.mjs';

export const CLIENT_PUBLICATION_CAPABILITY = 'nassaj-dev-client-publication/v1';
export const CLIENT_PUBLICATION_RUNTIME_FILE = 'nassaj-client-publication-runtime-v1.json';

function write(file, value, replace = false) {
    const target = replace ? `${file}.${randomUUID()}.tmp` : file, fd = fs.openSync(target, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${canonical(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (replace) fs.renameSync(target, file);
    const parent = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

function commonDirectory(root) {
    const result = spawnSync('/usr/bin/git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('client_baseline_git_unavailable');
    const directory = result.stdout.trim();
    if (fs.realpathSync(directory) !== directory || fs.realpathSync(root) !== root) throw new Error('client_baseline_root_unsafe');
    return directory;
}

function readJson(file) { return JSON.parse(readClientPublicationFile(file, 16 * 1024 ** 2)); }

/** Check explicit support on every eligible rollback generation; no historical generation is deleted to qualify. */
export function qualifyClientPublicationRollback(directories) {
    if (!Array.isArray(directories) || !directories.length) return false;
    return directories.every(directory => {
        try {
            const manifest = readJson(path.join(directory, 'OID_CONTROL_MANIFEST.json'));
            return manifest.capabilities?.clientPublicationV1 === CLIENT_PUBLICATION_CAPABILITY;
        } catch { return false; }
    });
}

/** Record B1 after full serving, retaining prior A2 lineage and binding actual loaded process and manifest. */
export function recordFullClientPublicationBaseline(root, fullReceipt, options) {
    const git = commonDirectory(root), manifestFile = path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json');
    const manifestBytes = readClientPublicationFile(manifestFile), manifest = JSON.parse(manifestBytes);
    // Old full updates retain their established behavior; capability must be in the built loaded generation.
    if (manifest.capabilities?.clientPublicationV1 !== CLIENT_PUBLICATION_CAPABILITY) return null;
    const proofFile = path.join(git, `nassaj-oid-pair-serving-${fullReceipt.transactionNonce}.json`);
    const proofBytes = readClientPublicationFile(proofFile), stored = JSON.parse(proofBytes);
    if (canonical(stored) !== canonical(fullReceipt) || stored.outcome !== 'served'
        || stored.serverBuildId !== manifest.serverBuildId || !/^[a-f0-9]{40}$/.test(manifest.oid || '')
        || !/^[a-f0-9]{64}$/.test(stored.nodeModulesTreeSha256 || '') || !/^[a-f0-9]{64}$/.test(manifest.updateRuntimeBuildId || '')) throw new Error('client_baseline_full_receipt_invalid');
    const processStat = fs.readFileSync(`/proc/${stored.pid}/stat`, 'utf8');
    if (processStat.slice(processStat.lastIndexOf(')') + 2).split(/\s+/)[19] !== stored.startTime) throw new Error('client_baseline_loaded_process_changed');
    const baseReceiptDigest = digest(proofBytes), serverIdentity = { sourceOid: manifest.oid, buildId: stored.serverBuildId,
        pid: stored.pid, startTime: stored.startTime, controlManifestDigest: digest(manifestBytes), baseReceiptDigest };
    const runtimeFile = path.join(git, CLIENT_PUBLICATION_RUNTIME_FILE);
    let prior = null;
    try { prior = readJson(runtimeFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lineageFile = path.join(git, 'nassaj-client-publication-serving-v1.json');
    let previousServing = null;
    try { previousServing = readJson(lineageFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const baselineFile = path.join(git, `nassaj-client-publication-baseline-${baseReceiptDigest}.json`);
    let saved = null;
    try { saved = readJson(baselineFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved) {
        if (saved.binding?.baseReceiptDigest !== baseReceiptDigest || canonical(saved.binding.serverIdentity) !== canonical(serverIdentity)) throw new Error('client_baseline_replay_identity_changed');
        if (prior?.baseReceiptDigest === baseReceiptDigest && previousServing?.baseReceiptDigest === baseReceiptDigest) return prior;
        const repaired = { ...saved.lineage, receiptDigest: digest(readClientPublicationFile(baselineFile)) };
        write(runtimeFile, saved.binding, true); options.afterWrite?.('runtime');
        write(lineageFile, repaired, true); options.afterWrite?.('lineage');
        return saved.binding;
    }
    const sealed = validateClientAssetManifest(path.join(root, 'dist'), { sourceOid: manifest.oid, buildId: stored.clientBuildId }, options.verifyClosure);
    const capabilities = Object.fromEntries(['executor', 'state', 'static'].map(key => [key, CLIENT_PUBLICATION_CAPABILITY]));
    if (qualifyClientPublicationRollback(options.rollbackDirectories)) capabilities.rollback = CLIENT_PUBLICATION_CAPABILITY;
    const binding = { schema: 'nassaj-client-publication-runtime/v1', installationId: digest({ root, git, uid: process.getuid() }),
        canonicalProjectRoot: root, canonicalGitCommonDir: git, serviceIdentity: `nassaj:${process.getuid()}`, serviceUid: process.getuid(), capabilities,
        updateRuntimeBuildId: manifest.updateRuntimeBuildId,
        clientIdentity: { sourceOid: sealed.manifest.sourceOid, buildId: sealed.manifest.buildId, generationId: sealed.manifest.generationId,
            assetManifestDigest: sealed.manifestDigest, treeDigest: sealed.treeDigest },
        baseReceiptDigest, baselineOid: manifest.oid, dependencyIdentity: stored.nodeModulesTreeSha256,
        installedControlDigest: digest(manifestBytes), serverIdentity, fullReceipt: { sequence: stored.sequence, transactionNonce: stored.transactionNonce },
        previousServingReceiptDigest: previousServing?.receiptDigest ?? null };
    const lineage = { schema: 'nassaj-client-publication-serving/v1', baseReceiptDigest,
        sourceOid: manifest.oid, buildId: stored.clientBuildId, assetManifestDigest: sealed.manifestDigest,
        generationId: sealed.manifest.generationId, kind: 'full', transactionNonce: stored.transactionNonce, sequence: stored.sequence };
    write(baselineFile, { schema: 'nassaj-client-publication-baseline/v1', binding, lineage });
    options.afterWrite?.('baseline');
    lineage.receiptDigest = digest(readClientPublicationFile(baselineFile));
    write(runtimeFile, binding, true); options.afterWrite?.('runtime');
    write(lineageFile, lineage, true); options.afterWrite?.('lineage');
    return binding;
}


/** Capture existing authority and lineage; an unqualified legacy installation remains unqualified. */
export function captureClientPublicationBaseline(root, previous) {
    const git = commonDirectory(root);
    let binding;
    try { binding = readJson(path.join(git, CLIENT_PUBLICATION_RUNTIME_FILE)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const serving = readJson(path.join(git, 'nassaj-client-publication-serving-v1.json'));
    const proof = readClientPublicationFile(path.join(git, `nassaj-oid-pair-serving-${binding.fullReceipt?.transactionNonce}.json`));
    if (digest(proof) !== binding.baseReceiptDigest || serving.baseReceiptDigest !== binding.baseReceiptDigest
        || binding.serverIdentity.buildId !== previous.serverBuildId || binding.installedControlDigest !== previous.controlManifestSha256
        || serving.buildId !== previous.clientBuildId || serving.sourceOid !== previous.clientOid
        || binding.dependencyIdentity !== previous.nodeModulesTreeSha256) throw new Error('client_rollback_capture_changed');
    if (binding.serverIdentity.pid !== previous.runtime.pid || binding.serverIdentity.startTime !== previous.runtime.startTime) throw new Error('client_rollback_capture_process_changed');
    validateCapturedServing(root, serving);
    const snapshot = { schema: 'nassaj-client-publication-previous/v1', binding, serving };
    return { ...snapshot, snapshotDigest: digest(snapshot) };
}

function validateCapturedServing(root, serving) {
    const git = commonDirectory(root);
    if (serving.kind === 'full') {
        const bytes = readClientPublicationFile(path.join(git, `nassaj-client-publication-baseline-${serving.baseReceiptDigest}.json`));
        if (digest(bytes) !== serving.receiptDigest || Object.entries(JSON.parse(bytes).lineage).some(([key, value]) => serving[key] !== value)) throw new Error('client_rollback_capture_lineage_changed');
    } else if (serving.kind === 'client') {
        const file = path.join(git, `nassaj-oid-control-transaction-${serving.sequence}-${serving.transactionNonce}.json`);
        const checked = validateClientPublicationJournal(root, { file, value: readJson(file) });
        const selected = checked.receipt?.outcome === 'served' ? checked.intent.targetClientIdentity : checked.intent.previousClientIdentity;
        if (!checked.terminal || checked.receiptDigest !== serving.receiptDigest
            || ['sourceOid', 'buildId', 'assetManifestDigest'].some(key => serving[key] !== selected[key])) throw new Error('client_rollback_capture_lineage_changed');
    } else throw new Error('client_rollback_capture_lineage_changed');
}

/** Requalify the restored baseline using the actual typed rollback receipt, preserving historical full/client receipts. */
export function recordClientPublicationRollbackBaseline(root, transaction, options) {
    const previous = transaction.pair?.previous, snapshot = previous?.clientPublication;
    if (!snapshot) return null;
    const { snapshotDigest, ...captured } = snapshot;
    validateCapturedServing(root, snapshot.serving);
    if (digest(captured) !== snapshotDigest) throw new Error('client_rollback_snapshot_changed');
    if (transaction.state !== 'pair_rolled_back' || transaction.pair.databaseState !== 'PRE_CANDIDATE'
        || !options.validateTerminal(root, transaction)) throw new Error('client_rollback_terminal_unverified');
    const git = commonDirectory(root), receiptFile = path.join(git, `nassaj-oid-pair-receipt-${transaction.transactionNonce}.json`);
    const receiptBytes = readClientPublicationFile(receiptFile), receipt = JSON.parse(receiptBytes);
    if (digest(receiptBytes) !== transaction.pair.receiptSha256 || receipt.outcome !== 'rolled_back'
        || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1 || !/^\d+$/.test(receipt.startTime || '')
        || receipt.serverBuildId !== previous.serverBuildId || receipt.clientBuildId !== previous.clientBuildId
        || receipt.nodeModulesTreeSha256 !== previous.nodeModulesTreeSha256) throw new Error('client_rollback_receipt_changed');
    const stat = fs.readFileSync(`/proc/${receipt.pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19] !== receipt.startTime) throw new Error('client_rollback_process_changed');
    const manifestBytes = readClientPublicationFile(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'));
    if (digest(manifestBytes) !== snapshot.binding.installedControlDigest || digest(manifestBytes) !== previous.controlManifestSha256) throw new Error('client_rollback_control_changed');
    const original = readClientPublicationFile(path.join(git, `nassaj-oid-pair-serving-${snapshot.binding.fullReceipt.transactionNonce}.json`));
    if (digest(original) !== snapshot.binding.baseReceiptDigest || snapshot.serving.baseReceiptDigest !== snapshot.binding.baseReceiptDigest) throw new Error('client_rollback_original_baseline_changed');
    const immutable = readJson(path.join(git, `nassaj-client-publication-baseline-${snapshot.binding.baseReceiptDigest}.json`));
    const originalBinding = { ...snapshot.binding };
    delete originalBinding.processReceipt;
    originalBinding.serverIdentity = { ...originalBinding.serverIdentity, pid: immutable.binding.serverIdentity.pid, startTime: immutable.binding.serverIdentity.startTime };
    if (canonical(originalBinding) !== canonical(immutable.binding)) throw new Error('client_rollback_snapshot_binding_changed');
    const journalFile = path.join(git, `nassaj-oid-control-transaction-${transaction.sequence}-${transaction.transactionNonce}.json`);
    const journalBytes = readClientPublicationFile(journalFile);
    if (canonical(JSON.parse(journalBytes)) !== canonical(transaction)) throw new Error('client_rollback_journal_changed');
    if (receipt.serverOid !== snapshot.binding.baselineOid || receipt.clientBuildIdServed !== previous.clientBuildId
        || receipt.oidNodeModulesTreeSha256 !== previous.nodeModulesTreeSha256 || receipt.oidPairTargetDigest !== transaction.pair.targetDigest) throw new Error('client_rollback_http_proof_missing');
    const processReceipt = { schema: 'nassaj-client-publication-process-receipt/v1', sequence: transaction.sequence,
        transactionNonce: transaction.transactionNonce, receiptDigest: digest(receiptBytes), journalDigest: digest(journalBytes) };
    const binding = { ...snapshot.binding, serverIdentity: { ...snapshot.binding.serverIdentity, pid: receipt.pid, startTime: receipt.startTime }, processReceipt };
    const current = readJson(path.join(git, CLIENT_PUBLICATION_RUNTIME_FILE));
    const serving = readJson(path.join(git, 'nassaj-client-publication-serving-v1.json'));
    // A completed rollback qualification remains valid after a later client publication.
    if (canonical(current) === canonical(binding) && serving.baseReceiptDigest === binding.baseReceiptDigest) {
        const prior = readJson(path.join(git, `nassaj-client-publication-rollback-baseline-${transaction.transactionNonce}.json`));
        if (canonical(prior.binding) !== canonical(binding) || canonical(prior.serving) !== canonical(snapshot.serving)) throw new Error('client_rollback_qualification_changed');
        validateCapturedServing(root, serving);
        return current;
    }
    if (receipt.http?.schema !== 'nassaj-client-http-serving/v1' || receipt.http.files?.length !== 2
        || ['index.html', 'version.json'].some(name => {
            const entry = receipt.http.files.find(item => item.path === name);
            return entry?.status !== 200 || entry.sha256 !== digest(readClientPublicationFile(path.join(root, 'dist', name)));
        })) throw new Error('client_rollback_http_bytes_changed');
    const sealed = validateClientAssetManifest(path.join(root, 'dist'), { sourceOid: previous.clientOid, buildId: previous.clientBuildId }, options.verifyClosure);
    if (sealed.manifestDigest !== snapshot.serving.assetManifestDigest) throw new Error('client_rollback_client_changed');
    const qualification = { schema: 'nassaj-client-publication-rollback-baseline/v1', binding, serving: snapshot.serving };
    const file = path.join(git, `nassaj-client-publication-rollback-baseline-${transaction.transactionNonce}.json`);
    try { write(file, qualification); } catch (error) { if (error.code !== 'EEXIST' || canonical(readJson(file)) !== canonical(qualification)) throw error; }
    options.afterWrite?.('rollback');
    if (canonical(current) !== canonical(snapshot.binding) && canonical(current) !== canonical(binding)) throw new Error('client_rollback_runtime_cas_conflict');
    if (serving.receiptDigest !== snapshot.serving.receiptDigest) throw new Error('client_rollback_lineage_cas_conflict');
    write(path.join(git, CLIENT_PUBLICATION_RUNTIME_FILE), binding, true); options.afterWrite?.('runtime');
    write(path.join(git, 'nassaj-client-publication-serving-v1.json'), snapshot.serving, true); options.afterWrite?.('lineage');
    return binding;
}
