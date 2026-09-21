#!/usr/bin/env node
/**
 * Publish one committed client revision without ever reading the shared worktree.
 *
 * Inhibit lifecycle. On success this installs an inhibit record for the
 * mutable-tree watcher and deliberately leaves it in place, so a later debounce
 * cannot replace the verified generation with unrelated dirty files. The record
 * is owned by a per-operation `operationId`: only the operation that wrote it
 * (or a later publish that supersedes it — see below) removes it. The record
 * persists across process exit; it is a durable on-disk lease, not scratch
 * state, and reading its fields grants no authority to clear it.
 *
 * Supersede rule. A publish clears an existing inhibit only when the commit it
 * is publishing is a descendant of (or identical to) the recorded OID, proven
 * by `git merge-base --is-ancestor`. This is what makes the guard safe against
 * a concurrent session: republishing an unrelated or not-yet-merged commit
 * cannot silently retire another operation's inhibit and erase its live output.
 *
 * Scope of the guard. It protects the supported path only — every clear and
 * every publish flows through the lineage and main-HEAD checks here. It cannot
 * defend against someone deleting the inhibit file by hand: doing so bypasses
 * the lease and is a governance violation, not a condition this code can detect
 * or prevent.
 */
import { assertStandaloneNodePublication } from './lib/node-update-mode.mjs';
import {
    existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PREVIEW_BUILD_LOCK_NAME, recordPublishBaseGuardDecision } from './local-preview-ledger.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OID = /^[a-f0-9]{40}$/;
const BUILD_ID = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^[a-f0-9-]{36}$/;

function run(executable, args, options = {}) {
    const result = spawnSync(executable, args, { cwd: options.cwd, encoding: 'utf8', stdio: options.stdio ?? 'inherit', env: options.env, shell: false });
    if (result.status !== 0) throw new Error(`${path.basename(executable)} failed: ${String(result.stderr || result.stdout || '').trim()}`);
    return result;
}

function git(root, args) {
    return run('git', args, { cwd: root, stdio: 'pipe' }).stdout.trim();
}

/** Return the real shared git directory, including when invoked from a worktree. */
export function gitCommonDir(root = ROOT) {
    const value = git(root, ['rev-parse', '--git-common-dir']);
    return path.resolve(root, value);
}

export function mutableWatcherInhibitPath(root = ROOT) {
    return path.join(gitCommonDir(root), 'nassaj-client-mutable-publisher-inhibit-v1.json');
}

/** The exact lock held by the mutable-tree watcher while it can promote dist. */
export function sharedClientPublishLockPath(root = ROOT) {
    // The watcher owns this established preview-control lock.  Do not create a
    // second "isolated" lock: two locks turn the promotion check into a race.
    return path.join(path.resolve(root), '.git', PREVIEW_BUILD_LOCK_NAME);
}

export function readMutableWatcherInhibit(root = ROOT) {
    const file = mutableWatcherInhibitPath(root);
    if (!existsSync(file)) return null;
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Mutable client publisher inhibit record is unsafe.');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.schemaVersion !== 1 || !OID.test(value.oid || '') || !BUILD_ID.test(value.buildId || '')
        || !OPERATION_ID.test(value.operationId || '')) {
        throw new Error('Mutable client publisher inhibit record is invalid.');
    }
    return value;
}

export function assertFullSourceRef(sourceRef) {
    if (!OID.test(sourceRef || '')) throw new Error('--source-ref must be an exact 40-character commit SHA.');
    return sourceRef;
}

function ownedWorktree(root, oid) {
    return path.join(root, '.nassaj-client-snapshots', `.owned-${oid}-${process.pid}`);
}

function safeOwnedWorktree(root, worktree, oid) {
    const parent = path.resolve(root, '.nassaj-client-snapshots');
    const expected = path.join(parent, `.owned-${oid}-${process.pid}`);
    if (path.resolve(worktree) !== expected) throw new Error('Refusing to remove an unowned client snapshot worktree.');
}

function removeOwnedWorktree(root, worktree, oid) {
    safeOwnedWorktree(root, worktree, oid);
    if (!existsSync(worktree)) return;
    try { run('git', ['worktree', 'remove', '--force', worktree], { cwd: root }); }
    finally { rmSync(worktree, { recursive: true, force: true }); }
}

function provenance(directory) {
    const file = path.join(directory, 'BUILD_PROVENANCE.json');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Client candidate provenance is unsafe.');
    return JSON.parse(readFileSync(file, 'utf8'));
}

/** Best-effort live base commit for audit context; null when absent or unreadable. */
function liveBaseCommit(root) {
    try {
        const record = JSON.parse(readFileSync(path.join(root, 'dist', 'BUILD_PROVENANCE.json'), 'utf8'));
        return OID.test(record?.commit || '') ? record.commit : null;
    } catch {
        return null;
    }
}

function writeInhibit(root, record) {
    const file = mutableWatcherInhibitPath(root);
    const temporary = `${file}.tmp-${process.pid}`;
    try {
        writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
    } finally {
        rmSync(temporary, { force: true });
    }
}

/** Remove only the inhibit installed by this exact publish operation. */
export function removeOwnedMutableWatcherInhibit(root, operationId) {
    if (!OPERATION_ID.test(operationId || '')) throw new Error('Mutable client publisher inhibit ownership is invalid.');
    const record = readMutableWatcherInhibit(root);
    if (!record) return false;
    if (record.operationId !== operationId) return false;
    rmSync(mutableWatcherInhibitPath(root), { force: true });
    return true;
}

/** Resolve the local `main` branch tip through the shared git dir, never a remote. */
export function localMainHead(root = ROOT) {
    const commonDir = gitCommonDir(root);
    const result = spawnSync('git', ['--git-dir', commonDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const value = (result.stdout || '').trim();
    if (result.status !== 0 || !OID.test(value)) return null;
    return value;
}

/**
 * A client publish replaces live for everyone, so it must be the integration
 * branch (local `main` HEAD) unless the owner explicitly opts out. A missing
 * `main` ref fails closed rather than defaulting to "publish anything".
 */
export function assertPublishingMainHead(root, sourceRef, options = {}) {
    if (options.allowNonMain) return;
    const mainHead = localMainHead(root);
    if (!mainHead) {
        throw new Error('Refusing to publish: cannot resolve local main HEAD (missing refs/heads/main). '
            + 'Pass --allow-non-main only with explicit owner permission.');
    }
    if (sourceRef !== mainHead) {
        throw new Error('Refusing to publish a non-main commit: --source-ref is not the local main HEAD. '
            + 'Merge it into main first, or pass --allow-non-main with explicit owner permission.');
    }
}

/**
 * Lineage gate for retiring an inhibit. The recorded OID may be released only
 * when the commit now being published supersedes it: identical (self-release)
 * or a proven ancestor. Values in the record are readable, so equality is no
 * barrier; ancestry cannot be forged. Uses spawnSync directly because the run()
 * helper throws on a status-1 "not an ancestor" answer, which is a real result
 * here, not a failure. 0 = supersedes (allow), 1 = not merged (refuse),
 * anything else (128, missing object, unspawnable) = fail closed, untouched.
 */
export function assertRecordedOidSuperseded(root, recordOid, sourceRef) {
    if (recordOid === sourceRef) return;
    const result = spawnSync('git', ['merge-base', '--is-ancestor', recordOid, sourceRef],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    if (result.status === 0) return;
    if (result.status === 1) {
        throw new Error('Refusing to clear the mutable client publisher inhibit: its recorded OID is not '
            + 'merged into the target — merge it into main first or escalate to the owner.');
    }
    throw new Error('Refusing to clear the mutable client publisher inhibit: could not prove its recorded '
        + 'OID is an ancestor of the target (missing object or git failure); leaving the record untouched.');
}

/**
 * Reviewed post-success transition: release the watcher when the commit now
 * live supersedes the recorded one (self-release or a proven descendant). The
 * build-identity match is kept only as a self-release integrity check, where
 * the same commit must reproduce the same build id.
 */
export function clearMutableWatcherInhibit(root, sourceRef, buildId, options = {}) {
    assertFullSourceRef(sourceRef);
    if (!BUILD_ID.test(buildId || '')) throw new Error('--build-id must be an exact 64-character build SHA.');
    assertPublishingMainHead(root, sourceRef, options);
    const record = readMutableWatcherInhibit(root);
    if (!record) return false;
    assertRecordedOidSuperseded(root, record.oid, sourceRef);
    if (record.oid === sourceRef && record.buildId !== buildId) {
        throw new Error('Refusing to clear an inhibit: same source commit but a different build identity.');
    }
    return removeOwnedMutableWatcherInhibit(root, record.operationId);
}

/** Build a source/publish/live-separated candidate from a detached worktree. */
export async function publishIsolatedClient(options, injected = {}) {
    const root = path.resolve(options.root || ROOT);
    assertStandaloneNodePublication(root);
    const oid = assertFullSourceRef(options.sourceRef);
    if (git(root, ['rev-parse', '--verify', `${oid}^{commit}`]) !== oid) throw new Error('--source-ref is not a commit object.');
    assertPublishingMainHead(root, oid, { allowNonMain: options.allowNonMain });
    // Layer-1 audit: when --allow-non-main bypasses the main-HEAD check for a
    // commit that is not actually main HEAD, record the override so the bypass
    // leaves a trace even if the layer-2 chokepoint guard later finds the live
    // base an ancestor and would otherwise log only `allowed`. Overridden audits
    // stay fail-closed, matching the owner-authorised nature of the bypass.
    if (options.allowNonMain && oid !== localMainHead(root)) {
        recordPublishBaseGuardDecision(root, {
            liveCommit: liveBaseCommit(root), sourceOid: oid, result: 'overridden', dirty: false, dropped: [],
        });
    }
    // Combine supersede + clear + publish inside this single locked invocation.
    // An existing inhibit is retired here only if the commit we are publishing
    // supersedes its recorded OID; otherwise we refuse and leave it untouched.
    // Fail fast before building; the actual removal happens just before we write
    // our own record, so a build failure never strands another lease.
    const priorInhibit = readMutableWatcherInhibit(root);
    if (priorInhibit) assertRecordedOidSuperseded(root, priorInhibit.oid, oid);

    const snapshotParent = path.join(root, '.nassaj-client-snapshots');
    const sourceRoot = ownedWorktree(root, oid);
    // Vite accepts only the source tree itself as a release staging parent.
    // The detached worktree is that source tree, while the exact name remains
    // compatible with the atomic-build outDir guard.
    const candidate = path.join(sourceRoot, `dist.atomic.predeploy-staging-${oid.slice(0, 12)}-${process.pid}`);
    const liveRoot = path.join(root, 'dist');
    mkdirSync(snapshotParent, { recursive: true, mode: 0o700 });
    const exec = injected.run || run;
    let worktreeCreated = false;
    let candidateOwned = false;
    let inhibitOperationId = null;
    let priorInhibitCleared = false;
    try {
        exec('git', ['worktree', 'add', '--detach', sourceRoot, oid], { cwd: root });
        worktreeCreated = true;
        const contract = injected.contract || await import(`${pathToFileURL(path.join(sourceRoot, 'scripts', 'client-build-atomic.mjs')).href}?source=${oid}`);
        const buildId = contract.computeClientBuildId(sourceRoot);
        if (!BUILD_ID.test(buildId)) throw new Error('Client source produced an invalid build identity.');
        if (existsSync(candidate)) throw new Error('Exact client candidate already exists; refusing to overwrite it.');
        mkdirSync(candidate, { mode: 0o700 });
        candidateOwned = true;
        const vite = contract.viteBuildInvocation(root);
        exec(path.join(root, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', path.join(sourceRoot, 'tsconfig.preview.json')], { cwd: sourceRoot });
        exec(vite.command, vite.args, {
            cwd: sourceRoot,
            env: { ...process.env, NASSAJ_ATOMIC_CLIENT_BUILD: '1', NASSAJ_BUILD_ID: buildId, NASSAJ_CLIENT_OUT_DIR: candidate },
        });
        writeFileSync(path.join(candidate, 'BUILD_PROVENANCE.json'), `${JSON.stringify({
            schemaVersion: 1, artifact: 'client', commit: oid, baseCommit: oid,
            dirty: false, dirtyFiles: 0, buildId, builtAt: new Date().toISOString(),
        }, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
        contract.verifyAssetClosure(candidate);
        contract.verifyBuildIdentity(candidate, buildId);
        const record = provenance(candidate);
        if (record.commit !== oid || record.baseCommit !== oid || record.dirty !== false || record.dirtyFiles !== 0 || record.buildId !== buildId) {
            throw new Error('Client candidate provenance does not attest the exact clean source commit.');
        }
        // The inhibit is installed before the only live mutation and deliberately
        // remains after success. The old mutable watcher checks this same record.
        // A superseded prior lease (verified above) is retired here, in the same
        // lock, immediately before ours replaces it. If the exchange later refuses
        // (chokepoint guard) or rolls back, live is unchanged and the catch
        // restores this exact prior record — never leaving the unchanged live copy
        // unprotected.
        if (priorInhibit) {
            removeOwnedMutableWatcherInhibit(root, priorInhibit.operationId);
            priorInhibitCleared = true;
        }
        inhibitOperationId = randomUUID();
        writeInhibit(root, {
            schemaVersion: 1, oid, buildId, operationId: inhibitOperationId,
            sourceRoot: '.nassaj-client-snapshots', publishedAt: new Date().toISOString(),
        });
        await contract.promoteWithSmokeRollback(candidate, liveRoot, async (directory) => {
            contract.verifyAssetClosure(directory);
            contract.verifyBuildIdentity(directory, buildId);
        }, { root, allowNonMain: options.allowNonMain === true });
        // Point of no return: live now serves the new generation and the success
        // inhibit is installed. The exchange moved the displaced live generation
        // into `candidate`, which is no longer ours to delete, so clear ownership
        // before any further step. A failure from here must never remove the
        // inhibit nor report an already-succeeded publish as failed — it warns.
        candidateOwned = false;
        let retained = null;
        try {
            // Retain the displaced generation under the real repo root (not the
            // about-to-be-removed worktree) as a rollback target that survives
            // bounded pruning.
            retained = contract.retainPrevious(candidate, buildId, root);
        } catch (retentionError) {
            console.warn(`[isolated-publish] published ${buildId}; retaining the displaced generation failed: ${retentionError.message}`);
        }
        return { oid, buildId, sourceRoot, liveRoot, retained };
    } catch (error) {
        // Never remove a pre-existing candidate: it may be another operation's
        // retained generation.  Likewise, remove only our own inhibit.
        let cleanupError = null;
        try {
            if (inhibitOperationId) removeOwnedMutableWatcherInhibit(root, inhibitOperationId);
            // The exchange did not complete (guard refusal, build failure, or a
            // rolled-back smoke), so live is unchanged and still the generation the
            // prior lease protected. Restore that exact record rather than leaving
            // the unchanged live copy with no inhibit at all.
            if (priorInhibitCleared && !existsSync(mutableWatcherInhibitPath(root))) writeInhibit(root, priorInhibit);
            if (candidateOwned && existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
        } catch (failureCleanupError) {
            cleanupError = failureCleanupError;
        }
        if (cleanupError) throw new AggregateError([error, cleanupError], 'Isolated client publish failed and lifecycle cleanup was incomplete.');
        throw error;
    } finally {
        if (worktreeCreated) removeOwnedWorktree(root, sourceRoot, oid);
    }
}

export function runWithSharedPublishLock(options) {
    const root = path.resolve(options.root || ROOT);
    if (!options.clearInhibit) assertStandaloneNodePublication(root);
    const oid = assertFullSourceRef(options.sourceRef);
    const script = fileURLToPath(import.meta.url);
    const args = ['-x', sharedClientPublishLockPath(root), process.execPath, script,
        '--locked', '--repo', root, '--source-ref', oid];
    if (options.clearInhibit) args.push('--clear-inhibit', '--build-id', options.buildId);
    if (options.allowNonMain) args.push('--allow-non-main');
    run('flock', args, { cwd: root });
}

function args(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        if (!argv[index].startsWith('--')) throw new Error('Invalid isolated client publish argument.');
        if (argv[index] === '--locked') { values.locked = true; continue; }
        if (argv[index] === '--clear-inhibit') { values['clear-inhibit'] = true; continue; }
        if (argv[index] === '--allow-non-main') { values['allow-non-main'] = true; continue; }
        if (argv[index + 1] == null) throw new Error('Missing isolated client publish value.');
        values[argv[index].slice(2)] = argv[index + 1]; index += 1;
    }
    return values;
}

async function main() {
    const values = args(process.argv.slice(2));
    const options = {
        root: values.repo || ROOT, sourceRef: values['source-ref'],
        clearInhibit: values['clear-inhibit'] === true, buildId: values['build-id'],
        allowNonMain: values['allow-non-main'] === true,
    };
    if (!options.clearInhibit) assertStandaloneNodePublication(path.resolve(options.root));
    if (!values.locked) return runWithSharedPublishLock(options);
    if (options.clearInhibit) {
        process.stdout.write(`${JSON.stringify({ cleared: clearMutableWatcherInhibit(options.root, options.sourceRef, options.buildId, { allowNonMain: options.allowNonMain }) })}\n`);
        return;
    }
    process.stdout.write(`${JSON.stringify(await publishIsolatedClient(options))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
