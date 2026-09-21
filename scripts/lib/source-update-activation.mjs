/** Filesystem-only source-update activation primitives. Gate/PM2 remain caller-owned. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
    existsSync, fsyncSync, lstatSync, openSync, closeSync, readFileSync,
    realpathSync, renameSync, writeFileSync, mkdirSync, unlinkSync, readlinkSync, symlinkSync, chmodSync, rmdirSync,
    readdirSync,
} from 'node:fs';
import path from 'node:path';

import { gitlinkPaths, parseTreeEntries, sameEntry } from './source-update-gitlinks.mjs';
import { hashTree } from './source-update-tree-identity.mjs';
import { classifyGenerationExchange } from './update-generation-reconciliation.mjs';

const TX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function realDirectory(value, label) {
    const resolved = realpathSync(value);
    const metadata = lstatSync(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
    return resolved;
}

function readJsonFile(file, mode = null) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (mode !== null && (metadata.mode & 0o777) !== mode)
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error(`Unsafe activation file: ${path.basename(file)}`);
    }
    return JSON.parse(readFileSync(file, 'utf8'));
}

function durableJson(file, value) {
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    const directoryFd = openSync(path.dirname(file), 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

function provenance(directory) {
    return readJsonFile(path.join(directory, 'BUILD_PROVENANCE.json'));
}

/** Verify all content identities before the caller closes the final journal gate. */
export function validateCandidate(options) {
    const projectRoot = realDirectory(options.projectRoot, 'Project root');
    const candidateRoot = realDirectory(options.candidateRoot, 'Candidate root');
    if (!TX.test(options.transactionId || '') || path.basename(candidateRoot) !== options.transactionId
        || !SHA40.test(options.releaseCommit || '') || typeof options.version !== 'string') {
        throw new Error('Activation candidate identity is invalid.');
    }
    const manifestPath = path.resolve(options.manifestPath);
    if (manifestPath !== path.join(candidateRoot, 'candidate-manifest.json')) {
        throw new Error('Activation manifest path is not canonical.');
    }
    const manifestBytes = readFileSync(manifestPath);
    if (options.manifestSha256 && digest(manifestBytes) !== options.manifestSha256) {
        throw new Error('Activation manifest digest mismatch.');
    }
    const manifest = readJsonFile(manifestPath, 0o600);
    if (manifest.schemaVersion !== 1 || manifest.txId !== options.transactionId
        || manifest.releaseCommit !== options.releaseCommit || manifest.version !== options.version
        || !SHA256.test(manifest.clientBuildId || '') || !SHA256.test(manifest.serverBuildId || '')
        || manifest.sourceProvenance?.kind !== 'git-worktree'
        || manifest.sourceProvenance?.commit !== options.releaseCommit
        || manifest.sourceProvenance?.clean !== true
        || manifest.artifacts?.client?.commit !== options.releaseCommit
        || manifest.artifacts?.client?.buildId !== manifest.clientBuildId
        || manifest.artifacts?.server?.commit !== options.releaseCommit
        || manifest.artifacts?.server?.buildId !== manifest.serverBuildId
        || manifest.artifacts?.nodeModules?.commit !== options.releaseCommit) {
        throw new Error('Activation manifest identity mismatch.');
    }
    const candidates = {
        client: realDirectory(path.join(candidateRoot, 'client'), 'Client candidate'),
        server: realDirectory(path.join(candidateRoot, 'server'), 'Server candidate'),
        nodeModules: realDirectory(path.join(candidateRoot, 'node_modules'), 'Dependency candidate'),
    };
    const live = {
        client: realDirectory(path.join(projectRoot, 'dist'), 'Live client'),
        server: realDirectory(path.join(projectRoot, 'dist-server'), 'Live server'),
        nodeModules: realDirectory(path.join(projectRoot, 'node_modules'), 'Live dependencies'),
    };
    const promotedLocation = {};
    for (const name of Object.keys(candidates)) {
        const candidateTree = hashTree(candidates[name]);
        const liveTree = hashTree(live[name]);
        const expected = manifest.trees?.[name];
        if (candidateTree.sha256 === expected?.sha256 && candidateTree.files === expected.files) promotedLocation[name] = candidates[name];
        else if (liveTree.sha256 === expected?.sha256 && liveTree.files === expected.files) promotedLocation[name] = live[name];
        else throw new Error(`Activation ${name} tree is absent from both pending and live paths.`);
    }
    const clientProvenance = provenance(promotedLocation.client);
    const serverProvenance = provenance(promotedLocation.server);
    if (clientProvenance.commit !== options.releaseCommit || clientProvenance.version !== options.version
        || clientProvenance.buildId !== manifest.clientBuildId
        || serverProvenance.commit !== options.releaseCommit || serverProvenance.version !== options.version
        || serverProvenance.buildId !== manifest.serverBuildId) {
        throw new Error('Activation build provenance mismatch.');
    }
    return Object.freeze({ projectRoot, candidateRoot, manifestPath, manifest, candidates, live });
}

function exchange(left, right) {
    const result = spawnSync('mv', ['--exchange', '--no-copy', '-T', left, right], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Activation atomic exchange failed: ${(result.stderr || result.stdout || '').trim()}`);
}

function syncExchangeParents(left, right) {
    for (const directory of new Set([path.dirname(left), path.dirname(right)])) {
        const fd = openSync(directory, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
    }
}

function receiptFile(validation) { return path.join(validation.candidateRoot, 'activation-receipt.json'); }

function readReceipt(validation) {
    const file = receiptFile(validation);
    if (!existsSync(file)) return null;
    const receipt = readJsonFile(file, 0o600);
    if (receipt.schemaVersion !== 1 || receipt.txId !== validation.manifest.txId) throw new Error('Activation receipt identity mismatch.');
    return receipt;
}

function persistReceipt(validation, receipt) {
    durableJson(receiptFile(validation), { ...receipt, updatedAt: new Date().toISOString() });
}

function generationPosition(validation, receipt, name) {
    return classifyGenerationExchange({ previous: receipt.previous[name].sha256,
        target: validation.manifest.trees[name].sha256,
        live: hashTree(validation.live[name]).sha256,
        candidate: hashTree(validation.candidates[name]).sha256 });
}

function assertGenerationPositions(validation, receipt) {
    for (const name of ['nodeModules', 'server', 'client']) {
        if (generationPosition(validation, receipt, name) === 'manual') {
            throw new Error(`Activation ${name} generation identity mismatch.`);
        }
    }
}

function prepareGenerationReceipt(validation) {
    const receipt = readReceipt(validation) || {
        schemaVersion: 1, txId: validation.manifest.txId, state: 'activating', steps: {},
    };
    if (receipt.previous) return receipt;
    const previous = {};
    for (const name of ['nodeModules', 'server', 'client']) {
        // Legacy receipts prove only their recorded steps. Never infer a lost old
        // generation from an already-promoted path without a durable old identity.
        const live = hashTree(validation.live[name]);
        const candidate = hashTree(validation.candidates[name]);
        if (receipt.steps[name]?.previous) previous[name] = receipt.steps[name].previous;
        else if (candidate.sha256 === validation.manifest.trees[name].sha256) previous[name] = live;
        else throw new Error(`Activation ${name} previous generation identity is unproven.`);
    }
    receipt.previous = previous;
    persistReceipt(validation, receipt);
    return receipt;
}

function mutateGeneration(validation, receipt, name, direction, injected) {
    const position = generationPosition(validation, receipt, name);
    if (position === 'manual') throw new Error(`Activation ${name} generation identity mismatch.`);
    const needed = direction === 'forward' ? 'pending' : 'exchanged';
    if (position === needed) {
        receipt.steps[name] = { state: `${direction}_intent`, previous: receipt.previous[name] };
        persistReceipt(validation, receipt); // Durable BEFORE the filesystem effect.
        (injected.exchange || exchange)(validation.live[name], validation.candidates[name]);
        syncExchangeParents(validation.live[name], validation.candidates[name]);
        injected.afterExchange?.(name); // Models process death before its completion receipt.
        const expected = direction === 'forward' ? 'exchanged' : 'pending';
        if (generationPosition(validation, receipt, name) !== expected) {
            throw new Error(`Activation ${name} verification failed after exchange.`);
        }
    }
    receipt.steps[name] = { state: direction === 'forward' ? 'exchanged' : 'rolled_back', previous: receipt.previous[name] };
    persistReceipt(validation, receipt);
    injected.afterStep?.(name);
}

/** Crash-resumable exchange, with all old identities and per-step intent durable before effects. */
export function exchangeGenerations(validation, injected = {}) {
    const names = injected.names || ['nodeModules', 'server', 'client'];
    if (!names.length || new Set(names).size !== names.length
        || names.some(name => !['nodeModules', 'server', 'client'].includes(name))) throw new Error('Activation generation selection invalid.');
    const receipt = prepareGenerationReceipt(validation);
    assertGenerationPositions(validation, receipt);
    for (const name of names) mutateGeneration(validation, receipt, name, 'forward', injected);
    receipt.state = names.includes('client') ? 'exchanged' : 'server_exchanged';
    persistReceipt(validation, receipt);
    return receipt;
}

/** Reconcile both physical sides even when the process died before writing the completion receipt. */
export function rollbackGenerations(validation, injected = {}) {
    if (!readReceipt(validation)) throw new Error('Activation rollback receipt is absent.');
    const receipt = prepareGenerationReceipt(validation);
    assertGenerationPositions(validation, receipt);
    for (const name of ['client', 'server', 'nodeModules']) {
        mutateGeneration(validation, receipt, name, 'rollback', injected);
    }
    receipt.state = 'rolled_back';
    persistReceipt(validation, receipt);
    return receipt;
}

/** Write the only descriptor bootstrap may consume; it contains no token bytes. */
export function prepareBootstrapDescriptor({ controlRoot, transactionId, epoch, tokenFilePath }) {
    const root = realDirectory(controlRoot, 'Update control root');
    const token = path.resolve(tokenFilePath);
    if (!TX.test(transactionId || '') || !/^[A-Za-z0-9_-]{16,128}$/.test(epoch || '')
        || token !== path.join(root, 'token')) throw new Error('Bootstrap descriptor identity is invalid.');
    const value = { schema: 'nassaj-source-update-bootstrap/v1', transactionId, epoch, tokenFilePath: token };
    const file = path.join(root, 'bootstrap-handoff.json');
    if (existsSync(file)) {
        if (JSON.stringify(readJsonFile(file, 0o600)) !== JSON.stringify(value)) throw new Error('Bootstrap descriptor collision.');
        return file;
    }
    durableJson(file, value);
    return file;
}

/** Confirm that all three promoted runtime paths still match the candidate manifest. */
export function verifyRuntimeIdentities(validation) {
    return Object.fromEntries(Object.keys(validation.live).map((name) => {
        const actual = hashTree(validation.live[name]);
        const expected = validation.manifest.trees[name];
        if (actual.sha256 !== expected.sha256 || actual.files !== expected.files) {
            throw new Error(`Runtime ${name} identity mismatch.`);
        }
        return [name, actual];
    }));
}

/** Compare all generation hashes without trusting object ordering or extra fields. */
function sameRuntimeTrees(left, right) {
    return ['client', 'server', 'nodeModules'].every((name) =>
        SHA256.test(left?.[name]?.sha256 || '') && left[name].sha256 === right?.[name]?.sha256
        && Number.isSafeInteger(left[name].files) && left[name].files === right[name].files);
}

/** Read and bind the immutable activation action to the durable job, never executing it. */
function recoveryValidation({ projectRoot, controlRoot, job }) {
    if (!TX.test(job.transaction_id || '')) throw new Error('recovery_transaction_invalid');
    const candidateRoot = path.join(controlRoot, 'candidates', job.transaction_id);
    const action = readJsonFile(path.join(candidateRoot, 'activation-action.json'), 0o600);
    if (action.schema !== 'nassaj-source-update-activation/v1'
        || digest(JSON.stringify(action)) !== job.activation_identity_sha256
        || action.transactionId !== job.transaction_id || action.targetCommit !== job.release_commit
        || action.version !== job.expected_version || action.expectedServerBuildId !== job.expected_server_build_id
        || !SHA40.test(action.originalHead || '')) throw new Error('recovery_action_mismatch');
    const validation = validateCandidate({ projectRoot, candidateRoot, transactionId: action.transactionId,
        releaseCommit: action.targetCommit, version: action.version,
        manifestPath: action.manifestPath, manifestSha256: action.manifestSha256 });
    if (validation.manifest.serverBuildId !== job.expected_server_build_id
        || validation.manifest.clientBuildId !== job.expected_client_build_id) throw new Error('recovery_build_mismatch');
    return { action, validation };
}

/** A completion receipt must bind the job and the exact three verified runtime trees. */
function hasRuntimeCompletionReceipt(job, receipts, identities) {
    return receipts.some((receipt) => {
        if (receipt.job_id !== job.id || receipt.phase !== 'runtime_verifying' || receipt.kind !== 'done'
            || typeof receipt.facts_json !== 'string' || digest(receipt.facts_json) !== receipt.facts_sha256) return false;
        try { return sameRuntimeTrees(JSON.parse(receipt.facts_json).runtimeIdentities, identities); }
        catch { return false; }
    });
}

/**
 * B-1147: prove a stranded Git job's outcome with read-only evidence. OPEN alone
 * proves nothing; missing, contradictory, or unsafe evidence leaves the job fenced.
 * `runtime` must be captured at process startup, never reread from promoted disk.
 */
export function inspectGitRuntimeRecovery({ projectRoot, controlRoot, job, journal, runtime, receipts = [] }) {
    const unresolved = { next: null, code: 'source_update_runtime_evidence_unresolved' };
    if (job.strategy !== 'git-checkout-v2' || job.state !== 'runtime_verifying'
        || journal?.state !== 'OPEN' || journal.gateClosed !== false || journal.degraded
        || (journal.transactionId && journal.transactionId !== job.transaction_id)) return unresolved;
    try {
        const { action, validation } = recoveryValidation({ projectRoot, controlRoot, job });
        if (journal.transactionId === job.transaction_id && journal.phase === 'ACTIVE_VERIFIED') {
            const identities = verifyRuntimeIdentities(validation);
            if (journal.identity?.targetCommit !== action.targetCommit || journal.identity?.originalHead !== action.originalHead
                || journal.identity?.expectedVersion !== action.version || runtime?.commit !== action.targetCommit
                || runtime?.serverBuildId !== validation.manifest.serverBuildId
                || runtime?.clientBuildId !== validation.manifest.clientBuildId
                || !sameRuntimeTrees(journal.runtimeIdentities, identities)
                || !hasRuntimeCompletionReceipt(job, receipts, identities)) return unresolved;
            return { next: 'activated', code: 'source_update_runtime_recovered', runtimeIdentities: identities };
        }
        return inspectGitRollbackRecovery({ job, journal, runtime, action, validation }) || unresolved;
    } catch { return unresolved; }
}

/** A rollback is final only when its receipt, source, loaded process and all previous trees agree. */
function inspectGitRollbackRecovery({ journal, runtime, action, validation }) {
    if (journal.databaseState !== 'PRE_CANDIDATE'
        || (journal.recovery && journal.recovery !== 'ROLLED_BACK')) return null;
    const receipt = readReceipt(validation);
    if (receipt?.state !== 'rolled_back' || runtime?.commit !== action.originalHead
        || git(validation.projectRoot, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== action.originalHead) return null;
    const identities = Object.fromEntries(Object.entries(validation.live).map(([name, directory]) => [name, hashTree(directory)]));
    const previous = Object.fromEntries(['client', 'server', 'nodeModules'].map((name) => [name, receipt.steps?.[name]?.previous]));
    if (!sameRuntimeTrees(previous, identities)) return null;
    const server = provenance(validation.live.server);
    const client = provenance(validation.live.client);
    if (server.commit !== action.originalHead || runtime.serverBuildId !== server.buildId
        || runtime.clientBuildId !== client.buildId || !SHA256.test(server.buildId || '')
        || !SHA256.test(client.buildId || '')) return null;
    return { next: 'rolled_back', code: 'source_update_rollback_recovered', runtimeIdentities: identities };
}

function git(root, args, options = {}) {
    const result = spawnSync('git', args, { cwd: root, encoding: options.encoding, input: options.input, maxBuffer: 128 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('Source activation Git operation failed.');
    return result.stdout;
}

function tree(root, commit) {
    const raw = git(root, ['ls-tree', '-rz', '--full-tree', commit], { encoding: 'buffer' });
    try {
        return parseTreeEntries(raw.toString('utf8'));
    } catch {
        throw new Error('Source activation tree is invalid.');
    }
}

function currentEntry(root, name) {
    const file = path.join(root, name);
    let stat;
    try { stat = lstatSync(file); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null; throw error; }
    if (stat.isSymbolicLink()) {
        const oid = git(root, ['hash-object', '--stdin'], { encoding: 'utf8', input: readlinkSync(file) }).trim();
        return { mode: '120000', oid };
    }
    if (stat.isDirectory()) return null;
    if (!stat.isFile()) throw new Error(`Source activation path is not a file: ${name}`);
    const oid = git(root, ['hash-object', '--no-filters', '--', name], { encoding: 'utf8' }).trim();
    return { mode: stat.mode & 0o111 ? '100755' : '100644', oid };
}

function indexEntry(root, name) {
    const raw = git(root, ['ls-files', '-s', '-z', '--', name], { encoding: 'utf8' });
    if (!raw) return null;
    const records = raw.split('\0').filter(Boolean);
    const exact = records.filter((record) => record.endsWith(`\t${name}`));
    if (exact.length === 0) return null;
    if (exact.length !== 1) throw new Error(`Source activation index is unmerged: ${name}`);
    const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}) 0\t([\s\S]+)$/.exec(exact[0]);
    if (!match || match[3] !== name) throw new Error(`Source activation index is invalid: ${name}`);
    return { mode: match[1], oid: match[2] };
}

/**
 * The IDENTITY half of the old `assertUnchangedGitlinks` (ADR-156 ب.1, ب.2).
 *
 * "The index no longer matches this direction's `from`" means the write would be
 * wrong, so it stays in both directions without exception. The POLICY half —
 * "this release changes a gitlink at all" — means the state is unsupported, so
 * it moved to the preparation gate and the pre-flight, where it is decided
 * before any write and cannot strand a rollback in MANUAL (B-1054).
 *
 * Gitlinked paths are returned so the caller leaves them untouched: their
 * working directory belongs to the submodule, never to this updater (G1).
 */
function assertGitlinkIndexIdentity(root, from, to) {
    const gitlinks = gitlinkPaths(from, to);
    for (const name of gitlinks) {
        if (!sameEntry(indexEntry(root, name), from.get(name))) {
            throw new Error(`Source activation gitlink index mismatch: ${name}`);
        }
    }
    return gitlinks;
}

function assertSafeParents(root, name) {
    let cursor = path.dirname(path.join(root, name));
    while (cursor !== root) {
        let metadata;
        try { metadata = lstatSync(cursor); } catch (error) {
            if (error?.code === 'ENOENT') { cursor = path.dirname(cursor); continue; }
            throw error;
        }
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Source activation parent is unsafe: ${name}`);
        cursor = path.dirname(cursor);
    }
}

function removeEmptyParents(root, name) {
    let cursor = path.dirname(path.join(root, name));
    while (cursor !== root) {
        try { rmdirSync(cursor); } catch { return; }
        cursor = path.dirname(cursor);
    }
}

function installEntry(root, name, entry, commit) {
    const file = path.join(root, name);
    assertSafeParents(root, name);
    if (!entry) {
        try { unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        removeEmptyParents(root, name);
        return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const content = git(root, ['show', `${commit}:${name}`], { encoding: 'buffer' });
    const temporary = `${file}.nassaj-update-${process.pid}`;
    if (entry.mode === '120000') {
        symlinkSync(content.toString('utf8'), temporary);
    } else {
        writeFileSync(temporary, content, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
        chmodSync(temporary, entry.mode === '100755' ? 0o755 : 0o644);
    }
    renameSync(temporary, file);
}

/**
 * Every ancestor of `name` must be a real directory or absent. The one
 * exception is an ancestor this direction itself removes first (a file that
 * becomes a directory): nothing can exist below a file, so the walk stops.
 */
function assertPlannedParents(root, name, removed) {
    const parts = name.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
        const ancestor = parts.slice(0, depth).join('/');
        let metadata;
        try { metadata = lstatSync(path.join(root, ancestor)); } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) continue;
        if (!removed.has(ancestor)) throw new Error(`Source activation parent is unsafe: ${name}`);
        return;
    }
}

/**
 * The first file below the directory at `name` that this direction does not
 * remove itself — an untracked or IGNORED file the cleanliness gate never saw,
 * which would make a directory-to-file replacement fail after other writes.
 *
 * An EMPTY directory is an occupant too (B-1128): the write only removes the
 * parents of files it removes, so an empty one survives, and renaming a file
 * over it fails with EISDIR after other paths were already written.
 */
function firstOccupant(root, name, removed) {
    const pending = [name];
    while (pending.length) {
        const directory = pending.pop();
        const entries = readdirSync(path.join(root, directory), { withFileTypes: true });
        if (!entries.length) return directory;
        for (const entry of entries) {
            const child = `${directory}/${entry.name}`;
            if (entry.isDirectory()) pending.push(child);
            else if (!removed.has(child)) return child;
        }
    }
    return null;
}

/**
 * Write-free plan of one direction (qa-critic H1). Every reason the write could
 * stop half way is decided here, before its first byte: worktree and index CAS,
 * a file or symlink where a parent directory must be, and foreign files inside
 * a directory that a file must replace. Ignored files are covered because the
 * checks read the tree on disk, not `git status`.
 */
function planDirection(root, fromCommit, toCommit) {
    const from = tree(root, fromCommit); const to = tree(root, toCommit);
    const gitlinks = assertGitlinkIndexIdentity(root, from, to);
    const names = [...new Set([...from.keys(), ...to.keys()])]
        .filter((name) => !gitlinks.has(name) && !sameEntry(from.get(name), to.get(name)));
    const removed = new Set(names.filter((name) => !to.has(name)));
    for (const name of names) {
        const current = currentEntry(root, name);
        const indexed = indexEntry(root, name);
        if (!sameEntry(current, from.get(name)) && !sameEntry(current, to.get(name))) throw new Error(`Source activation CAS mismatch: ${name}`);
        if (!sameEntry(indexed, from.get(name)) && !sameEntry(indexed, to.get(name))) throw new Error(`Source activation index CAS mismatch: ${name}`);
        // Already in its `to` state: nothing is written at this path, so its
        // surroundings are not a hazard (an idempotent re-apply or resume).
        if (sameEntry(current, to.get(name))) continue;
        assertPlannedParents(root, name, removed);
        if (to.has(name) && !current && existsSync(path.join(root, name)) && firstOccupant(root, name, removed)) {
            throw new Error(`Source activation path is occupied: ${name}`);
        }
    }
    const parents = new Set(names.flatMap((name) => name.split('/').slice(0, -1)
        .map((_part, index, parts) => parts.slice(0, index + 1).join('/'))));
    const removals = names.filter((name) => !to.has(name) || parents.has(name))
        .sort((left, right) => right.split('/').length - left.split('/').length || left.localeCompare(right));
    const installs = names.filter((name) => to.has(name))
        .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
    return { names, from, to, removals, installs };
}

/** Plan the forward direction without writing anything; throws what apply would throw. */
export function planSourceManifest(options) {
    const plan = planDirection(realDirectory(options.projectRoot, 'Project root'), options.originalHead, options.targetCommit);
    return { paths: plan.names.length };
}

/** Plan the rollback direction without writing anything. */
export function planSourceRollback(options) {
    const plan = planDirection(realDirectory(options.projectRoot, 'Project root'), options.targetCommit, options.originalHead);
    return { paths: plan.names.length };
}

function applySourceDirection(options, fromCommit, toCommit) {
    const root = realDirectory(options.projectRoot, 'Project root');
    const { names, to, removals, installs } = planDirection(root, fromCommit, toCommit);
    // The plan passed, so nothing above wrote. A caller that must distinguish a
    // refused write from a partial one (rollback of a pre-write failure is a
    // no-op) learns the boundary here.
    options.beforeWrite?.();
    for (const name of removals) {
        if (!sameEntry(currentEntry(root, name), to.get(name))) installEntry(root, name, null, toCommit);
        options.progress?.(name, 'worktree-removed');
    }
    for (const name of installs) {
        if (!sameEntry(currentEntry(root, name), to.get(name))) installEntry(root, name, to.get(name), toCommit);
        if (!sameEntry(currentEntry(root, name), to.get(name))) throw new Error(`Source activation verification failed: ${name}`);
        options.progress?.(name, 'worktree-applied');
    }
    const indexPayload = Buffer.from(names.sort().map((name) => {
        const entry = to.get(name);
        return entry ? `${entry.mode} ${entry.oid}\t${name}\0` : `0 ${'0'.repeat(40)}\t${name}\0`;
    }).join(''));
    git(root, ['update-index', '-z', '--index-info'], { encoding: 'buffer', input: indexPayload });
    for (const name of names) if (!sameEntry(indexEntry(root, name), to.get(name))) throw new Error(`Source activation index verification failed: ${name}`);
    options.progress?.(null, 'index-applied');
    const branchRef = git(root, ['symbolic-ref', '-q', 'HEAD'], { encoding: 'utf8' }).trim();
    if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(branchRef)) throw new Error('Source activation branch is invalid.');
    const head = git(root, ['rev-parse', '--verify', `${branchRef}^{commit}`], { encoding: 'utf8' }).trim();
    if (head === toCommit) return { branchRef, paths: names.length };
    if (head !== fromCommit) throw new Error('Source activation branch CAS mismatch.');
    git(root, ['update-ref', branchRef, toCommit, fromCommit], { encoding: 'utf8' });
    return { branchRef, paths: names.length };
}

/** Journal-callback-driven, idempotent manifest-only source activation. */
export function applySourceManifest(options) {
    return applySourceDirection(options, options.originalHead, options.targetCommit);
}

/** Symmetric rollback; any external path mismatch fails before overwrite. */
export function rollbackSourceManifest(options) {
    return applySourceDirection(options, options.targetCommit, options.originalHead);
}
