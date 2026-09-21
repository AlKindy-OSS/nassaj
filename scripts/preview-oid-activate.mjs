#!/usr/bin/env node
/** Atomically install an exact OID preview candidate without restarting Node. */
import { assertLegacyNodePublication, assertStandaloneNodePublication } from './lib/node-update-mode.mjs';
import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { advancePreview, readPreviewState, resolvePreviewOid } from './preview-oid-pipeline.mjs';
import { listPreviewEvents, previewEventMutationLock } from './preview-oid-consumer.mjs';
import { assertOidSourceSnapshot } from './server-preview-from-oid.mjs';
import { recordPreviewLedgerEvent } from './local-preview-ledger.mjs';
import { assertNoNonterminalOidTransaction } from './oid-control-journal.mjs';
import { gitControlPath } from './git-control-root.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceGeneration(group) {
    const match = String(group || '').match(/^event-(\d{16})$/);
    return match ? Number(match[1]) : 0;
}

function safeGroup(group) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(group || '') || group.includes('..')) {
        throw new Error('OID activation group is invalid.');
    }
    return group;
}

function readProvenance(directory) {
    const file = path.join(directory, 'BUILD_PROVENANCE.json');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('OID candidate provenance is not a regular file.');
    return JSON.parse(readFileSync(file, 'utf8'));
}

function walkRegular(entry) {
    const metadata = lstatSync(entry);
    if (metadata.isSymbolicLink()) throw new Error(`OID candidate contains a symbolic link: ${entry}`);
    if (metadata.isDirectory()) {
        for (const child of readdirSync(entry)) walkRegular(path.join(entry, child));
    } else if (!metadata.isFile()) throw new Error(`OID candidate contains a special file: ${entry}`);
}

function identity(directory) {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`OID activation path is not a real directory: ${directory}`);
    return { dev: metadata.dev, ino: metadata.ino, ctimeMs: metadata.ctimeMs };
}

function sameIdentity(directory, expected) {
    const current = identity(directory);
    return current.dev === expected.dev && current.ino === expected.ino && current.ctimeMs === expected.ctimeMs;
}

function transactionPath(root, group) {
    return gitControlPath(root, `nassaj-preview-oid-activation-${safeGroup(group)}.json`);
}

function readTransaction(root, group) {
    const file = transactionPath(root, group);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
}

function writeTransaction(root, group, transaction) {
    const file = transactionPath(root, group);
    const temporary = `${file}.tmp-${process.pid}`;
    let descriptor;
    try {
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, ...transaction, updatedAt: new Date().toISOString() }, null, 2)}\n`);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, file);
        const directory = openSync(path.dirname(file), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        rmSync(temporary, { force: true });
    }
}

function exchange(left, right, run = spawnSync) {
    const result = run('mv', ['--exchange', '--no-copy', '-T', left, right], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`OID candidate atomic exchange failed: ${(result.stderr || result.stdout || '').trim()}`);
}

function fsyncDirectory(directory) {
    const result = spawnSync('sync', ['-d', directory], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('OID activation directory sync failed.');
}

async function loadSnapshotContract(sourceRoot, oid, injected) {
    if (injected.contract) return injected.contract;
    const url = `${pathToFileURL(path.join(sourceRoot, 'scripts', 'server-build-atomic.mjs')).href}?activate=${oid}`;
    return import(url);
}

function validateProvenance(provenance, oid, buildId, version) {
    if (provenance.artifact !== 'server' || provenance.commit !== oid || provenance.baseCommit !== oid
        || provenance.buildId !== buildId || provenance.version !== version
        || provenance.dirty !== false || provenance.dirtyFiles !== 0) {
        throw new Error('OID candidate provenance does not match the requested commit/build/version.');
    }
}

function buildAt(directory) {
    if (!existsSync(directory)) return null;
    return readProvenance(directory).buildId;
}

function assertGloballyNewest(root, group, oid) {
    const sequence = sourceGeneration(group);
    if (!sequence) return;
    const newest = listPreviewEvents(root).filter((event) => event.domains.includes('server')).at(-1);
    if (!newest || newest.sequence !== sequence || newest.oid !== oid) {
        throw new Error('preview_superseded_before_promotion');
    }
}

/** Restore the durable prepared layout to live=previous,candidate=requested. */
function restorePreparedLayout({ live, candidate, previous, buildId, previousBuildId, run }) {
    const liveBuild = buildAt(live);
    const candidateBuild = buildAt(candidate);
    const retainedBuild = buildAt(previous);
    if (liveBuild === buildId && candidateBuild === previousBuildId) {
        exchange(candidate, live, run);
    } else if (liveBuild === buildId && retainedBuild === previousBuildId && candidateBuild === null) {
        exchange(previous, live, run);
        renameSync(previous, candidate);
    } else if (liveBuild === previousBuildId && retainedBuild === buildId && candidateBuild === null) {
        renameSync(previous, candidate);
    } else if (!(liveBuild === previousBuildId && candidateBuild === buildId && retainedBuild === null)) {
        throw new Error('OID prepared activation layout cannot be reconciled safely.');
    }
    if (buildAt(live) !== previousBuildId || buildAt(candidate) !== buildId || buildAt(previous) !== null) {
        throw new Error('OID prepared activation rollback identity verification failed.');
    }
    fsyncDirectory(path.dirname(live));
    fsyncDirectory(path.dirname(candidate));
}

function promotedLayout(transaction) {
    return buildAt(transaction.livePath) === transaction.buildId
        && buildAt(transaction.previousPath) === transaction.previousBuildId;
}

function rolledBackLayout(transaction) {
    return buildAt(transaction.livePath) === transaction.previousBuildId
        && buildAt(transaction.previousPath) === transaction.buildId;
}

/** Complete a durably requested rollback from either side of its exchange. */
function reconcileRollbackIntent(root, group, transaction, persist, run) {
    if (promotedLayout(transaction)) {
        exchange(transaction.livePath, transaction.previousPath, run);
    } else if (!rolledBackLayout(transaction)) {
        throw new Error('OID rollback-prepared layout cannot be reconciled safely.');
    }
    if (!rolledBackLayout(transaction)) throw new Error('OID rollback reconciliation identity mismatch.');
    fsyncDirectory(path.dirname(transaction.livePath));
    fsyncDirectory(path.dirname(transaction.previousPath));
    const rolledBack = {
        ...transaction, state: 'rolled_back', rolledBackAt: transaction.rolledBackAt || new Date().toISOString(),
    };
    persist(root, group, rolledBack);
    return rolledBack;
}

function recordRollbackLedger(root, group, transaction) {
    recordPreviewLedgerEvent(root, {
        target: 'server', publisher: 'oid', sourceGeneration: sourceGeneration(group), state: 'failed',
        sourceBuildId: transaction.buildId, candidateBuildId: transaction.buildId,
        promotedBuildId: transaction.buildId, runtimeBuildId: transaction.previousBuildId,
        error: { code: 'runtime_attestation_failed', message: 'Promoted OID generation was rolled back before it was accepted as loaded.' },
    });
}

/** Install candidate to dist-server, retaining the previous generation for rollback. */
export async function activateOidCandidate(options, injected = {}) {
    const root = path.resolve(options.root || ROOT);
    assertLegacyNodePublication(root);
    // Propagate this caller's actual disposition context, or remain blocked.
    assertNoNonterminalOidTransaction(root, options.transactionNonce || null, options.disposition || null);
    const group = safeGroup(options.group);
    const oid = resolvePreviewOid(root, options.expectedOid);
    if (oid !== options.expectedOid) throw new Error('OID activation requires the full exact commit.');
    if (!/^[a-f0-9]{64}$/.test(options.buildId || '')) throw new Error('OID activation build id is invalid.');
    const state = readPreviewState(root, group);
    if (state.desired !== oid || state.server.desired !== oid || state.server.candidate !== oid || !state.coherent) {
        throw new Error('OID activation candidate ref does not match the exact desired commit.');
    }
    const sourceRoot = path.join(root, '.nassaj-local-preview', 'oid-snapshots', oid);
    assertOidSourceSnapshot(root, sourceRoot, oid);
    const candidate = path.join(root, '.nassaj-local-preview', 'server-candidates', options.buildId);
    const live = path.join(root, 'dist-server');
    const previousParent = path.join(root, '.nassaj-local-preview', 'server-previous');
    const previous = path.join(previousParent, `${group}-${options.buildId}`);
    const persistTransaction = injected.writeTransaction || writeTransaction;
    let existing = readTransaction(root, group);
    if (existing?.state === 'rollback_prepared' && existing.oid === oid && existing.buildId === options.buildId) {
        existing = reconcileRollbackIntent(root, group, existing, persistTransaction, injected.run);
    }
    if (existing?.state === 'promoted' && existing.oid === oid && existing.buildId === options.buildId
        && !promotedLayout(existing)) {
        // Compatibility/recovery for a crash in the pre-journal rollback
        // implementation: disk proves the exchange completed although the old
        // promoted journal survived.
        if (!rolledBackLayout(existing)) throw new Error('OID promoted transaction layout identity mismatch.');
        existing = { ...existing, state: 'rolled_back', rolledBackAt: new Date().toISOString() };
        persistTransaction(root, group, existing);
    }
    if (existing?.state === 'prepared' && existing.oid === oid && existing.buildId === options.buildId) {
        restorePreparedLayout({
            live, candidate, previous, buildId: options.buildId,
            previousBuildId: existing.previousBuildId, run: injected.run,
        });
        existing = null;
    }
    // Production holds previewEventMutationLock around this entire invocation;
    // this final check is therefore serialized with every event-ref creation.
    assertGloballyNewest(root, group, oid);
    if (existing && existing.oid === oid && existing.buildId === options.buildId
        && existing.state === 'promoted') {
        if (!promotedLayout(existing)) throw new Error('OID promoted transaction layout identity mismatch.');
        return existing;
    }
    // A failed runtime attestation rolls disk back before the action is exposed
    // for retry.  The retained path then contains this candidate; restore it to
    // the candidate store and run a fresh identity-checked exchange.
    if (existing && existing.oid === oid && existing.buildId === options.buildId
        && existing.state === 'rolled_back') {
        const candidateReady = buildAt(candidate) === options.buildId
            && readProvenance(candidate).commit === oid && !existsSync(existing.previousPath);
        if (!candidateReady) {
            if (existsSync(candidate) || !existsSync(existing.previousPath)
                || readProvenance(existing.previousPath).buildId !== options.buildId
                || readProvenance(existing.previousPath).commit !== oid) {
                throw new Error('OID activation retry candidate identity mismatch.');
            }
            renameSync(existing.previousPath, candidate);
            fsyncDirectory(path.dirname(candidate));
        }
    }
    const packageVersion = JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
    const contract = await loadSnapshotContract(sourceRoot, oid, injected);
    if (typeof contract.verifyServerArtefact !== 'function') throw new Error('Snapshot activation contract is incomplete.');

    walkRegular(candidate);
    const provenance = readProvenance(candidate);
    validateProvenance(provenance, oid, options.buildId, packageVersion);
    contract.verifyServerArtefact(candidate, {
        root: sourceRoot, version: packageVersion, expectedCommit: oid, expectedBuildId: options.buildId,
    });
    const candidateIdentity = identity(candidate);
    const liveIdentity = identity(live);
    if (candidateIdentity.dev !== liveIdentity.dev || statSync(root).dev !== liveIdentity.dev) {
        throw new Error('OID activation candidate and live server are on different filesystems.');
    }
    const previousBuildId = readProvenance(live).buildId;
    const prepared = {
        state: 'prepared', group, oid, buildId: options.buildId, version: packageVersion,
        candidatePath: candidate, livePath: live, previousBuildId,
    };
    persistTransaction(root, group, prepared);
    injected.beforeExchange?.();
    if (!sameIdentity(candidate, candidateIdentity) || !sameIdentity(live, liveIdentity)) {
        throw new Error('OID activation path changed before atomic exchange.');
    }
    // Recheck at the last possible point. The production CLI holds the same
    // flock used by event creation, so a newer event cannot appear after this
    // check and before exchange.
    assertGloballyNewest(root, group, oid);
    assertLegacyNodePublication(root);
    exchange(candidate, live, injected.run);
    try {
        injected.afterExchange?.();
        if (readProvenance(live).buildId !== options.buildId || readProvenance(live).commit !== oid
            || readProvenance(candidate).buildId !== previousBuildId) {
            throw new Error('OID activation identity verification failed after exchange.');
        }
        mkdirSync(previousParent, { recursive: true, mode: 0o700 });
        if (existsSync(previous)) throw new Error('OID activation previous-generation collision.');
        renameSync(candidate, previous);
        injected.afterPreviousRename?.();
        fsyncDirectory(path.dirname(live));
        injected.afterLiveFsync?.();
        fsyncDirectory(previousParent);
        injected.afterPreviousFsync?.();
        const promoted = { ...prepared, state: 'promoted', previousPath: previous };
        persistTransaction(root, group, promoted);
    } catch (error) {
        restorePreparedLayout({
            live, candidate, previous, buildId: options.buildId,
            previousBuildId, run: injected.run,
        });
        throw error;
    }
    // A crash after the durable promoted journal is recoverable by returning
    // that transaction on the next invocation; do not roll bytes back here.
    injected.afterPromotedWrite?.();
    const promoted = { ...prepared, state: 'promoted', previousPath: previous };
    advancePreview(root, { group, domain: 'server', state: 'promoted', oid });
    recordPreviewLedgerEvent(root, {
        target: 'server', publisher: 'oid', sourceGeneration: sourceGeneration(group), state: 'promoted',
        sourceBuildId: options.buildId, candidateBuildId: options.buildId,
        promotedBuildId: options.buildId, runtimeBuildId: previousBuildId,
    });
    return promoted;
}

/** Restore the retained previous generation atomically; no restart is attempted. */
export function rollbackOidCandidate(options, injected = {}) {
    const root = path.resolve(options.root || ROOT);
    // Propagate this caller's actual disposition context, or remain blocked.
    assertNoNonterminalOidTransaction(root, options.transactionNonce || null, options.disposition || null);
    const group = safeGroup(options.group);
    const persistTransaction = injected.writeTransaction || writeTransaction;
    let transaction = readTransaction(root, group);
    if (!transaction) throw new Error('OID rollback has no promoted transaction.');
    if (transaction.state === 'rolled_back') {
        if (!rolledBackLayout(transaction)) throw new Error('OID rolled-back transaction layout identity mismatch.');
        recordRollbackLedger(root, group, transaction);
        return transaction;
    }
    if (transaction.state === 'rollback_prepared') {
        transaction = reconcileRollbackIntent(root, group, transaction, persistTransaction, injected.run);
    } else if (transaction.state !== 'promoted') {
        throw new Error('OID rollback has no promoted transaction.');
    }
    if (transaction.state === 'rolled_back') {
        recordRollbackLedger(root, group, transaction);
        return transaction;
    }
    const live = transaction.livePath;
    const previous = transaction.previousPath;
    if (!promotedLayout(transaction)) {
        throw new Error('OID rollback generation identity mismatch.');
    }
    const rollbackPrepared = {
        ...transaction, state: 'rollback_prepared', rollbackRequestedAt: new Date().toISOString(),
    };
    persistTransaction(root, group, rollbackPrepared);
    injected.beforeRollbackExchange?.();
    exchange(live, previous, injected.run);
    injected.afterRollbackExchange?.();
    if (!rolledBackLayout(transaction)) throw new Error('OID rollback identity verification failed.');
    fsyncDirectory(path.dirname(live));
    fsyncDirectory(path.dirname(previous));
    const rolledBack = { ...rollbackPrepared, state: 'rolled_back', rolledBackAt: new Date().toISOString() };
    persistTransaction(root, group, rolledBack);
    injected.afterRolledBackWrite?.();
    recordRollbackLedger(root, group, transaction);
    return rolledBack;
}

function parseArguments(argv) {
    const locked = argv.includes('--locked');
    const values = { locked };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--locked') continue;
        if (!argv[index]?.startsWith('--') || argv[index + 1] == null) throw new Error('Invalid OID activation argument.');
        values[argv[index].slice(2)] = argv[index + 1];
        index += 1;
    }
    return values;
}

async function main() {
    const [action = 'activate', ...argv] = process.argv.slice(2);
    const args = parseArguments(argv);
    const root = path.resolve(args.repo || ROOT);
    const existing = readTransaction(root, safeGroup(args.group));
    const recoveryState = action === 'activate' ? 'prepared' : action === 'rollback' ? 'rollback_prepared' : null;
    if (!recoveryState || existing?.state !== recoveryState || existing.group !== args.group
        || existing.oid !== args['expected-oid'] || existing.buildId !== args['build-id']) {
        assertStandaloneNodePublication(root);
    }
    if (!args.locked) {
        const lock = previewEventMutationLock(root);
        const result = spawnSync('flock', [
            '-x', '-w', '10', '-F', lock, process.execPath, fileURLToPath(import.meta.url),
            action, ...argv, '--locked',
        ], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
        if (result.status !== 0) throw new Error(`OID activation lock failed (${result.status ?? result.signal}).`);
        return;
    }
    const options = { root, group: args.group, expectedOid: args['expected-oid'], buildId: args['build-id'] };
    const result = action === 'rollback'
        ? rollbackOidCandidate(options)
        : await activateOidCandidate(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
