#!/usr/bin/env node
/** Prepare one local-main candidate in the existing source-update store; never activate it. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readOidSourceInventory, verifyOidSourceInventory, verifyOidLinkedWorktree } from './lib/oid-candidate-source.mjs';
import { buildSourceUpdateCandidate, readCandidatePlan, hashTree } from './source-update-candidate.mjs';
import { resourcesSafe } from './server-build-atomic.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const RESERVE = 2 * 1024 ** 3;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = reason => { throw new Error(`local_source_recovery_${reason}`); };

function directory(file) {
    if (!fs.existsSync(file)) fs.mkdirSync(file, { mode: 0o700 });
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() || fs.realpathSync(file) !== file || stat.uid !== process.getuid() || stat.mode & 0o022) fail('unsafe_directory');
    return file;
}

function durable(file, value) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
            || !fs.readFileSync(file).equals(bytes)) fail('durable_record_conflict');
        return;
    }
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const parent = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

function treeBytes(root) {
    let total = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const file = path.join(root, entry.name), stat = fs.lstatSync(file);
        if (stat.isDirectory()) total += treeBytes(file);
        else if (stat.isFile() || stat.isSymbolicLink()) total += stat.size;
        else fail('unsupported_tree_entry');
    }
    return total;
}

function flushTree(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const child of fs.readdirSync(file)) flushTree(path.join(file, child));
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Measure a conservative installation/build/recovery budget on the actual source-update filesystem. */
export function measureLocalRecoveryCapacity(root, sourceBytes) {
    const dependencies = treeBytes(path.join(root, 'node_modules'));
    const artifacts = treeBytes(path.join(root, 'dist')) + treeBytes(path.join(root, 'dist-server'));
    const stat = fs.statfsSync(root), availableBytes = stat.bavail * stat.bsize;
    const candidateBytes = sourceBytes * 2 + dependencies * 2 + artifacts * 3;
    const recoveryBytes = dependencies + artifacts;
    const requiredBytes = candidateBytes + recoveryBytes + RESERVE;
    if (availableBytes < requiredBytes) fail('insufficient_capacity');
    return { availableBytes, sourceBytes, dependencies, artifacts, candidateBytes, recoveryBytes, reserveBytes: RESERVE, requiredBytes };
}

function preparationIdentity(options) {
    const root = path.resolve(options.root), oid = options.expectedOid, txId = options.txId;
    if (!SHA40.test(oid || '') || !SAFE_ID.test(txId || '')) fail('invalid_identity');
    directory(root);
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    if (common !== path.join(root, '.git') || fs.realpathSync(common) !== common) fail('integration_checkout_required');
    const branch = execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (branch !== 'refs/heads/main') fail('integration_checkout_required');
    const inventory = readOidSourceInventory(root, oid);
    const localSource = { schema: 'nassaj-local-source-recovery/v1', ref: 'refs/heads/main', oid,
        inventorySha256: digest(JSON.stringify(inventory)) };
    return { root, common, oid, txId, inventory, localSource };
}

function verifyWorktree(root, common, sourceRoot, oid, inventory) {
    verifyOidLinkedWorktree(sourceRoot, common, oid);
    const git = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim();
    if (git(['rev-parse', '--show-toplevel']) !== sourceRoot || git(['rev-parse', '--path-format=absolute', '--git-common-dir']) !== common
        || git(['rev-parse', 'HEAD']) !== oid || git(['status', '--porcelain=v1', '--untracked-files=all'])) fail('worktree_identity_changed');
    verifyOidSourceInventory(sourceRoot, oid, inventory, { allowGitMetadata: true });
    readOidSourceInventory(root, oid);
}

/** Snapshot main without changing HEAD/index, and persist an exact, replayable candidate plan. */
export async function prepareLocalSourceRecoveryCandidate(options, injected = {}) {
    const identity = preparationIdentity(options);
    const { root, common, oid, txId, inventory, localSource } = identity;
    if (!(injected.resourcesSafe || resourcesSafe)()) fail('resources_busy');
    const control = directory(path.join(common, 'nassaj-source-update'));
    const parent = directory(path.join(control, 'candidates'));
    const candidateRoot = directory(path.join(parent, txId));
    const sourceRoot = path.join(candidateRoot, 'source');
    const planFile = path.join(candidateRoot, 'local-candidate-plan.json');
    const tree = execFileSync('git', ['ls-tree', '-rlz', oid], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const sourceBytes = tree.split('\0').filter(Boolean).reduce((size, entry) => size + Number(entry.match(/^\d+ blob [a-f0-9]+\s+(\d+)\t/)[1]), 0);
    const capacity = (injected.measureCapacity || measureLocalRecoveryCapacity)(root, sourceBytes);
    const operationBinding = options.operationBinding;
    const operationBindingSha256 = digest(JSON.stringify(operationBinding ?? null));
    durable(path.join(candidateRoot, 'local-source-intent.json'), { schema: 'nassaj-local-source-recovery-intent/v1', root, txId, localSource, operationBindingSha256 });
    if (fs.existsSync(planFile)) {
        const plan = readCandidatePlan(planFile, { root });
        if (JSON.stringify(plan.localSource) !== JSON.stringify(localSource)) fail('plan_identity_changed');
        return { planFile, capacity, reused: true };
    }
    if (!fs.existsSync(sourceRoot)) execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', sourceRoot, oid], { cwd: root, stdio: 'pipe' });
    verifyWorktree(root, common, sourceRoot, oid, inventory);
    const version = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'))).version;
    const outputs = { client: path.join(candidateRoot, 'client'), server: path.join(candidateRoot, 'server'),
        nodeModules: path.join(candidateRoot, 'node_modules'), manifest: path.join(candidateRoot, 'candidate-manifest.json') };
    durable(planFile, { schemaVersion: 1, txId, sourceRoot, candidateRoot, releaseCommit: oid, version, localSource,
        ...(operationBinding ? { operationBinding } : {}), outputs });
    readOidSourceInventory(root, oid);
    return { planFile, capacity, reused: false };
}

/** Verify a sealed local candidate and emit its idempotent registration input; no database is opened. */
export function readPreparedLocalRecoveryCandidate(planFile, options = {}) {
    const plan = readCandidatePlan(planFile, options);
    if (!plan.localSource) fail('local_source_required');
    const metadata = fs.lstatSync(plan.outputs.manifest);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o600) fail('manifest_file_unsafe');
    const bytes = fs.readFileSync(plan.outputs.manifest), manifest = JSON.parse(bytes);
    if (manifest.schemaVersion !== 1 || manifest.txId !== plan.txId || manifest.releaseCommit !== plan.releaseCommit || manifest.version !== plan.version
        || JSON.stringify(manifest.localSource) !== JSON.stringify(plan.localSource)
        || JSON.stringify(manifest.operationBinding ?? null) !== JSON.stringify(plan.operationBinding ?? null)
        || manifest.sourceProvenance?.kind !== 'git-worktree'
        || manifest.sourceProvenance?.clean !== true || manifest.sourceProvenance?.commit !== plan.releaseCommit
        || manifest.sourceProvenance?.treeSha256 !== plan.localSource.inventorySha256
        || !/^[a-f0-9]{64}$/.test(manifest.serverBuildId || '') || !/^[a-f0-9]{64}$/.test(manifest.clientBuildId || '')) fail('manifest_identity_changed');
    const inventory = readOidSourceInventory(path.dirname(plan.commonDir), plan.releaseCommit);
    if (digest(JSON.stringify(inventory)) !== plan.localSource.inventorySha256) fail('source_inventory_changed');
    verifyWorktree(path.dirname(plan.commonDir), plan.commonDir, plan.sourceRoot, plan.releaseCommit, inventory);
    for (const key of ['client', 'server', 'nodeModules']) {
        if (fs.realpathSync(plan.outputs[key]) !== plan.outputs[key] || !fs.lstatSync(plan.outputs[key]).isDirectory()) fail('candidate_tree_unsafe');
        if (JSON.stringify(hashTree(plan.outputs[key])) !== JSON.stringify(manifest.trees?.[key])) fail('candidate_tree_changed');
        if (!options.existingOnly) flushTree(plan.outputs[key]);
    }
    const receipt = { schema: 'nassaj-prepared-local-source-recovery/v1', transactionId: plan.txId,
        localSource: plan.localSource, version: plan.version, manifestPath: plan.outputs.manifest,
        manifestSha256: digest(bytes), expectedServerBuildId: manifest.serverBuildId,
        expectedClientBuildId: manifest.clientBuildId, trees: manifest.trees };
    const receiptFile = path.join(plan.candidateRoot, 'local-source-recovery-receipt.json');
    if (options.existingOnly) {
        const stat = fs.lstatSync(receiptFile), expected = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
            || fs.realpathSync(receiptFile) !== receiptFile || !fs.readFileSync(receiptFile).equals(expected)) fail('existing_receipt_changed');
    } else durable(receiptFile, receipt);
    return receipt;
}

/** Build once, or verify the same sealed result after interruption before SQLite registration. */
export async function buildLocalSourceRecoveryCandidate(planFile, injected = {}) {
    const plan = readCandidatePlan(planFile, injected);
    if (!plan.localSource) fail('local_source_required');
    if (!fs.existsSync(plan.outputs.manifest)) await buildSourceUpdateCandidate(planFile, injected);
    return readPreparedLocalRecoveryCandidate(planFile, injected);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [operation, planFile] = process.argv.slice(2);
    if (operation !== '--build-plan' || !planFile || process.argv.length !== 4) throw new Error('Usage: local-source-recovery-candidate.mjs --build-plan <plan>');
    buildLocalSourceRecoveryCandidate(planFile).then(result => console.log(JSON.stringify(result))).catch(error => {
        console.error(error.message); process.exitCode = 1;
    });
}
