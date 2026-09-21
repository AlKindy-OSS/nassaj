#!/usr/bin/env node
/** Build and atomically promote a client generation from one immutable OID snapshot. */
import { assertLegacyNodePublication, assertStandaloneNodePublication } from './lib/node-update-mode.mjs';
import {
    existsSync,
    closeSync,
    fsyncSync,
    openSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { advancePreview, readPreviewState, resolvePreviewOid } from './preview-oid-pipeline.mjs';
import {
    newestPreviewEvent, previewEventMutationLock, withPreviewEventMutationLock,
    listPreviewEvents, readConsumerState,
} from './preview-oid-consumer.mjs';
import { previewControlPaths, readPreviewLedger, recordOidClientServed } from './local-preview-ledger.mjs';
import { assertOidSourceSnapshot } from './server-preview-from-oid.mjs';
import { assertNoNonterminalOidTransaction } from './oid-control-journal.mjs';
import * as installedClientPublisher from './client-build-atomic.mjs';
import { createClientAssetManifest, clientPublicationDigest } from './lib/client-publication-artifacts.mjs';
import { runIsolatedClientBuild } from './lib/client-publication-isolation.mjs';

import { readBootstrapPublicationPacket, assertBootstrapPublicationContext,
    readBootstrapPublicationState, recordBootstrapPublicationState, assertBootstrapLoadedRuntime, inspectBootstrapServerAction } from './lib/node-update-publication-guard.mjs';

export { publishDevClient, reconcileDevClientPublication } from './lib/client-publication-executor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function command(executable, args, options = {}) {
    const result = spawnSync(executable, args, { encoding: 'utf8', stdio: 'inherit', ...options });
    if (result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.status ?? result.signal}).`);
}

function safeBuildId(value) {
    if (!/^[a-f0-9]{64}$/.test(value || '')) throw new Error('Client OID build id is invalid.');
    return value;
}

function provenance(directory) {
    const file = path.join(directory, 'BUILD_PROVENANCE.json');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Client OID provenance is invalid.');
    return JSON.parse(readFileSync(file, 'utf8'));
}

function candidateRecord(directory, buildId, oid = null) {
    if (path.basename(directory) !== buildId) throw new Error('Client candidate directory identity is invalid.');
    checkedRealDirectory(directory, 'Client candidate directory');
    const record = provenance(directory);
    if (record.buildId !== buildId || (oid && (record.commit !== oid || record.baseCommit !== oid))) {
        throw new Error('Existing client candidate identity conflict.');
    }
    return record;
}

function recoveryDirectory(root, buildId) {
    return path.join(root, '.nassaj-local-preview', 'client-recovery', `${buildId}-${randomUUID()}`);
}

function checkedRealDirectory(directory, label, injected = {}) {
    const inspect = injected.lstat || lstatSync;
    const resolveReal = injected.realpath || realpathSync;
    const resolved = path.resolve(directory);
    const metadata = inspect(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || resolveReal(resolved) !== resolved) {
        throw new Error(`${label} must be an existing real directory.`);
    }
    return resolved;
}

/** Prove every client build/runtime parent is real and on one atomic-rename filesystem. */
export function assertClientPreviewFilesystemLayout(paths, injected = {}) {
    const inspectDevice = injected.stat || statSync;
    const requested = [
        [paths.root, 'Canonical preview root'],
        [paths.stagingParent, 'Client staging parent'],
        [paths.staging, 'Client staging directory'],
        [paths.candidateParent, 'Client candidate parent'],
        [paths.candidate, 'Client candidate directory'],
        [paths.recoveryParent, 'Client recovery parent'],
        [paths.live, 'Live client directory'],
    ].filter(([directory]) => directory);
    const directories = requested.map(([directory, label]) => checkedRealDirectory(directory, label, injected));
    const devices = directories.map((directory) => inspectDevice(directory).dev);
    if (devices.some((device) => device !== devices[0])) {
        throw new Error('Client staging, candidate, and live parents must share one filesystem.');
    }
    return true;
}

function assertNewest(root, group, oid) {
    const match = group.match(/^event-(\d{16})$/);
    if (!match) throw new Error('Client OID promotion requires an event sequence group.');
    const latest = newestPreviewEvent(root, 'client');
    if (!latest || latest.sequence !== Number(match[1]) || latest.oid !== oid) throw new Error('preview_superseded');
    return latest;
}

function assertClientCandidateReplaceable(root, buildId) {
    assertNoNonterminalOidTransaction(root);
    const gitRoot = previewControlPaths(root).gitDirectory;
    for (const name of readdirSync(gitRoot).filter(value => /^nassaj-preview-oid-event-control-\d{16}\.json$/.test(value))) {
        const file = path.join(gitRoot, name), metadata = lstatSync(file);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Client candidate event control is unsafe.');
        const state = JSON.parse(readFileSync(file, 'utf8')).localUpdate;
        if (state?.target?.clientBuildId === buildId && !['activated','cancelled','expired','superseded','failed'].includes(state.phase)) {
            throw new Error('client_candidate_bound_to_local_update');
        }
    }
}

function syncClientCandidateParent(directory) {
    const fd = openSync(directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

function exchangeClientCandidates(left, right) {
    const result = spawnSync('/usr/bin/mv', ['--exchange','--no-copy','-T',left,right], {encoding:'utf8'});
    if (result.status !== 0) throw new Error('client_candidate_exchange_failed');
}

function storeRebuiltClientCandidate(root, staging, destination, expected, injected) {
    const { buildId, oid, previous } = expected;
    assertClientCandidateReplaceable(root, buildId);
    if (!previous) {
        if (existsSync(destination)) throw new Error('client_candidate_compare_exchange_conflict');
        renameSync(staging,destination); syncClientCandidateParent(path.dirname(destination));
        syncClientCandidateParent(path.dirname(staging)); return;
    }
    candidateRecord(destination, buildId, previous.oid);
    if (retainedClientInventory(destination).inventorySha256 !== previous.inventorySha256) throw new Error('client_candidate_compare_exchange_conflict');
    const exchange = injected.exchangeCandidate || exchangeClientCandidates;
    exchange(staging,destination);
    try {
        candidateRecord(destination,buildId,oid);
        syncClientCandidateParent(path.dirname(destination)); syncClientCandidateParent(path.dirname(staging));
    } catch(error) {
        try { exchange(staging,destination); syncClientCandidateParent(path.dirname(destination)); syncClientCandidateParent(path.dirname(staging)); }
        catch { throw Object.assign(new Error('client_candidate_restore_required'),{preserveClientStaging:true}); }
        throw error;
    }
}

/** Compile a candidate outside both the immutable source and live dist tree. */
export async function buildClientPreviewFromOid(options, injected = {}) {
    const root = path.resolve(options.root || ROOT);
    const oid = assertOidSourceSnapshot(root, path.resolve(options.sourceRoot), options.expectedOid);
    const state = readPreviewState(root, options.group);
    if (state.desired !== oid || state.client.desired !== oid || !state.coherent) {
        throw new Error('Client OID build is not the coherent desired preview.');
    }
    const contract = injected.contract || installedClientPublisher;
    const buildId = safeBuildId(contract.computeClientBuildId(options.sourceRoot));
    const generationId = clientPublicationDigest({ sourceOid: oid, buildId });
    const parent = path.join(root, '.nassaj-local-preview', 'client-candidates');
    const destination = path.join(parent, buildId);
    let previous = null;
    if (existsSync(destination)) {
        const record = candidateRecord(destination, buildId);
        if (!/^[a-f0-9]{40}$/.test(record.commit || '') || record.commit !== record.baseCommit
            || record.dirty !== false || record.artifact !== 'client') throw new Error('Existing client candidate provenance is invalid.');
        contract.verifyAssetClosure(destination); contract.verifyBuildIdentity(destination, buildId);
        previous = retainedClientInventory(destination);
        if (record.commit === oid) {
            advancePreview(root, { group: options.group, domain: 'client', state: 'candidate', oid });
            return { oid, buildId, candidatePath: destination };
        }
    }
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    // Keep the temporary name and parent inside the allow-list enforced by the
    // snapshot's Vite contract. The completed generation is moved to the
    // content-addressed candidate store only after every verification passes.
    const stagingParent = path.join(root, '.nassaj-local-preview', 'client');
    mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
    const staging = path.join(stagingParent, `dist.atomic.predeploy-staging-${buildId.slice(0, 12)}-${process.pid}`);
    mkdirSync(staging, { mode: 0o700 });
    let preserveStaging = false;
    try {
        const layout = {
            root, stagingParent, staging, candidateParent: parent, live: path.join(root, 'dist'),
        };
        assertClientPreviewFilesystemLayout(layout, injected.filesystem);
        const vite = contract.viteBuildInvocation(root);
        const buildEnvironment = {
            NASSAJ_ATOMIC_CLIENT_BUILD: '1', NASSAJ_LOCAL_PREVIEW: '1',
            NASSAJ_BUILD_ID: buildId, NASSAJ_CLIENT_OUT_DIR: staging,
            NASSAJ_CLIENT_PREVIEW_ROOT: root, NASSAJ_CLIENT_GENERATION_ID: generationId,
        };
        if (injected.run) {
            injected.run(path.join(root, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', path.join(options.sourceRoot, 'tsconfig.preview.json')], { cwd: options.sourceRoot });
            injected.run(vite.command, vite.args, { cwd: options.sourceRoot, env: buildEnvironment });
        } else {
            const scratch = path.join(stagingParent, `.scratch-${buildId}-${process.pid}`);
            mkdirSync(scratch, { mode: 0o700 });
            try {
                await runIsolatedClientBuild({ sourceRoot: path.resolve(options.sourceRoot), dependenciesRoot: path.join(root, 'node_modules'), outputRoot: staging, scratchRoot: scratch,
                    commands: [{ command: '/usr/bin/node', args: [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', path.join(options.sourceRoot, 'tsconfig.preview.json')] },
                        { ...vite, env: buildEnvironment }] });
            } finally { rmSync(scratch, { recursive: true, force: true }); }
        }
        assertOidSourceSnapshot(root, path.resolve(options.sourceRoot), oid);
        assertClientPreviewFilesystemLayout(layout, injected.filesystem);
        writeFileSync(path.join(staging, 'BUILD_PROVENANCE.json'), `${JSON.stringify({
            artifact: 'client', version: JSON.parse(readFileSync(path.join(options.sourceRoot, 'package.json'), 'utf8')).version,
            commit: oid, baseCommit: oid, commitShort: oid.slice(0, 8), branch: null,
            describe: oid.slice(0, 12), dirty: false, dirtyFiles: 0,
            builtAt: new Date().toISOString(), buildId, generationId,
        }, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
        contract.verifyAssetClosure(staging);
        contract.verifyBuildIdentity(staging, buildId);
        if (!injected.contract) createClientAssetManifest(staging, { generationId, sourceOid: oid, buildId }, contract.verifyAssetClosure);
        assertOidSourceSnapshot(root, path.resolve(options.sourceRoot), oid);
        assertClientPreviewFilesystemLayout(layout, injected.filesystem);
        await withPreviewEventMutationLock(root, () => {
            const current = readPreviewState(root, options.group);
            if (/^event-\d{16}$/.test(options.group)) assertNewest(root, options.group, oid);
            if (!current.coherent || current.desired !== oid || current.client.desired !== oid) throw new Error('preview_superseded');
            storeRebuiltClientCandidate(root, staging, destination, { buildId, oid, previous }, injected);
            advancePreview(root, { group: options.group, domain: 'client', state: 'candidate', oid });
        });
        return { oid, buildId, candidatePath: destination };
    } catch (error) { preserveStaging = error.preserveClientStaging === true; throw error; }
    finally { if (!preserveStaging) rmSync(staging, { recursive: true, force: true }); }
}

/** Exchange only while this OID remains the newest client event. */
export async function promoteClientPreviewFromOid(options, injected = {}) {
    const root = path.resolve(options.root || ROOT);
    if (!options.bootstrapPacket) assertStandaloneNodePublication(root);
    const binding = readBootstrapPublicationPacket(root, options.bootstrapPacket);
    assertBootstrapPublicationContext(root, binding, { oid: options.expectedOid, group: options.group, clientBuildId: options.buildId });
    const lock = injected.withEventLock || withPreviewEventMutationLock;
    return lock(root, async () => {
        await assertBootstrapLoadedRuntime(root, binding);
        const saved = readBootstrapPublicationState(root, binding);
        const server = readConsumerState(root).server;
        if (server?.sequence === binding.scope.sequence && ['loaded', 'rolled_back'].includes(server.phase)) throw new Error('bootstrap_publication_terminal');
        if (saved?.server !== 'prepared') throw new Error('bootstrap_publication_server_preparation_required');
        inspectBootstrapServerAction(root, binding, saved.actionId);
        if (saved.client) {
            await verifyBootstrapClientServed(root, binding, injected);
            if (saved.client !== 'published') recordBootstrapPublicationState(root, binding, { client: 'published' });
            return { oid: options.expectedOid, buildId: options.buildId, served: true, ledgerRecorded: true, replay: true };
        }
        recordBootstrapPublicationState(root, binding, { client: 'intent' });
        const result = await promoteExistingClientCandidate(options, { ...injected, withEventLock: async (_root, operation) => operation() });
        await verifyBootstrapClientServed(root, binding, injected);
        recordBootstrapPublicationState(root, binding, { client: 'published' });
        return result;
    });
}

async function verifyBootstrapClientServed(root, binding, injected) {
    const live = provenance(path.join(root, 'dist')), ledger = readPreviewLedger(root), scope = binding.scope;
    if (live.buildId !== scope.clientBuildId || live.commit !== scope.oid || live.baseCommit !== scope.oid || live.dirty !== false
        || ledger.clientServedBuildId !== scope.clientBuildId || ledger.clientSourceGeneration !== scope.sequence
        || ledger.clientState !== 'served') throw new Error('bootstrap_publication_client_reconciliation_required');
    const sourceRoot = path.join(root, '.nassaj-local-preview', 'oid-snapshots', scope.oid);
    assertOidSourceSnapshot(root, sourceRoot, scope.oid);
    const contract = injected.contract || installedClientPublisher;
    contract.verifyAssetClosure(path.join(root, 'dist'));
    contract.verifyBuildIdentity(path.join(root, 'dist'), scope.clientBuildId);
}

async function promoteExistingClientCandidate(options, injected, restorationContext = null) {
    const root = path.resolve(options.root || ROOT);
    assertLegacyNodePublication(root);
    const oid = resolvePreviewOid(root, options.expectedOid);
    if (oid !== options.expectedOid) throw new Error('Client OID promotion requires an exact commit.');
    const buildId = safeBuildId(options.buildId);
    const state = readPreviewState(root, options.group);
    if (state.client.candidate !== oid || state.desired !== oid || !state.coherent) {
        throw new Error('Client candidate is not ready for this OID.');
    }
    const candidate = path.join(root, '.nassaj-local-preview', 'client-candidates', buildId);
    const recoveryParent = path.join(root, '.nassaj-local-preview', 'client-recovery');
    mkdirSync(recoveryParent, { recursive: true, mode: 0o700 });
    const layout = {
        root, candidateParent: path.dirname(candidate), candidate, recoveryParent, live: path.join(root, 'dist'),
    };
    assertClientPreviewFilesystemLayout(layout, injected.filesystem);
    const record = candidateRecord(candidate, buildId, oid);
    if (record.dirty !== false) {
        throw new Error('Client candidate provenance does not match exact promotion identity.');
    }
    const sourceRoot = path.join(root, '.nassaj-local-preview', 'oid-snapshots', oid);
    if (restorationContext) restorationContext.beforeMerge();
    const contract = injected.contract || installedClientPublisher;
    const live = path.join(root, 'dist');
    assertClientPreviewFilesystemLayout(layout, injected.filesystem);
    if (restorationContext) restorationContext.beforeMerge();
    contract.mergeLegacyAssets(live, candidate, restorationContext ? { restoration: restorationContext.restoration } : {});
    const mergedInventory = restorationContext ? retainedClientInventory(candidate) : null;
    assertClientPreviewFilesystemLayout(layout, injected.filesystem);
    const lock = injected.withEventLock || withPreviewEventMutationLock;
    await lock(root, async () => {
        // Event enqueue takes this same lock, closing the final-check/exchange TOCTOU window.
        const event = assertNewest(root, options.group, oid);
        if (restorationContext) restorationContext.beforeExchange(mergedInventory);
        await contract.promoteWithSmokeRollback(candidate, live, async (directory) => {
            contract.verifyAssetClosure(directory);
            contract.verifyBuildIdentity(directory, buildId);
        }, { root, allowNonMain: false });
        const recovery = recoveryDirectory(root, buildId);
        renameSync(candidate, recovery);
        if (existsSync(candidate)) throw new Error('Promoted client candidate was not cleared.');
        advancePreview(root, { group: options.group, domain: 'client', state: 'promoted', oid });
        advancePreview(root, { group: options.group, domain: 'client', state: 'served', oid });
        recordOidClientServed(root, event, buildId);
    });
    return { oid, buildId, served: true, ledgerRecorded: true };
}

/** Inspect an owned generation without following links, recording an exact inventory. */
function retainedClientInventory(directory) {
    checkedRealDirectory(directory, 'Retained client');
    const digest = createHash('sha256');
    const content = createHash('sha256');
    const identity = lstatSync(directory);
    let bytes = 0;
    function walk(current) {
        const metadata = lstatSync(current);
        if (metadata.uid !== process.getuid() || metadata.isSymbolicLink()
            || (!metadata.isDirectory() && !metadata.isFile())) throw new Error('Unsafe retained client entry');
        content.update(JSON.stringify([path.relative(directory, current), metadata.mode]));
        digest.update(JSON.stringify([path.relative(directory, current), metadata.dev, metadata.ino,
            metadata.mode, metadata.size, metadata.mtimeMs, metadata.ctimeMs]));
        if (metadata.isDirectory()) {
            for (const name of readdirSync(current).sort()) walk(path.join(current, name));
        } else { bytes += metadata.size; const data = readFileSync(current); digest.update(data); content.update(data); }
    }
    walk(directory);
    const record = provenance(directory);
    const version = JSON.parse(readFileSync(path.join(directory, 'version.json'), 'utf8'));
    safeBuildId(record.buildId);
    if (record.artifact !== 'client' || !/^[a-f0-9]{40}$/.test(record.commit || '')
        || version.buildId !== record.buildId || !Number.isFinite(Date.parse(record.builtAt))) {
        throw new Error('Retained client identity is not verified');
    }
    return { directory, buildId: record.buildId, oid: record.commit, dirty: record.dirty,
        builtAt: record.builtAt, bytes, device: identity.dev, inode: identity.ino,
        contentSha256: content.digest('hex'), inventorySha256: digest.digest('hex') };
}

/** Archive only coherent fully terminal events; all other refs protect their OIDs. */
function referencedClientOids(root) {
    const events = listPreviewEvents(root);
    const consumer = readConsumerState(root);
    const ledger = readPreviewLedger(root);
    const latest = events.filter((event) => event.domains.includes('client')).at(-1);
    if (latest && (consumer.client?.sequence !== latest.sequence || consumer.client.oid !== latest.oid
        || ledger.clientSourceGeneration !== latest.sequence || consumer.client.phase !== 'served'
        || ledger.clientState !== 'served')) throw new Error('Client publication state is not coherent and idle');
    const archived = [];
    for (const event of events) {
        const state = readPreviewState(root, event.group);
        const terminal = state.coherent && state.desired === event.oid && event.domains.every((domain) =>
            ['desired', 'candidate', 'promoted', domain === 'client' ? 'served' : 'loaded']
                .every((key) => state[domain][key] === event.oid));
        if (terminal && event.sequence !== latest?.sequence) archived.push(event);
    }
    const result = spawnSync('git', ['for-each-ref', '--format=%(refname) %(objectname)',
        'refs/nassaj/previews/v1'], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Cannot prove preview references');
    const protectedOids = new Set([consumer.client?.oid, consumer.server?.oid].filter(Boolean));
    for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
        const [ref, oid] = line.split(' ');
        const old = archived.find((event) => ref.startsWith(`refs/nassaj/previews/v1/groups/${event.group}/`)
            || ref.startsWith(`refs/nassaj/previews/v1/events/${String(event.sequence).padStart(16, '0')}/`));
        if (!old) protectedOids.add(oid);
    }
    return { protectedOids, archived, ledger, consumer, refsSha256: createHash('sha256').update(result.stdout).digest('hex') };
}

/**
 * Read-only retention proposal. Historical refs classify pending work only;
 * they are not independent receipts proving a past runtime was served.
 * Recovery directory names describe the successor, never the contained identity.
 */
export function planClientPreviewRetention(options = {}) {
    safeBuildId(options.startupBuildId);
    const root = checkedRealDirectory(path.resolve(options.root || ROOT), 'Client root');
    const parent = checkedRealDirectory(path.join(root, '.nassaj-local-preview'), 'Preview parent');
    const recoveries = checkedRealDirectory(path.join(parent, 'client-recovery'), 'Recovery parent');
    const candidates = checkedRealDirectory(path.join(parent, 'client-candidates'), 'Candidate parent');
    for (const directory of [root, parent, recoveries, candidates]) {
        if (lstatSync(directory).uid !== process.getuid()) throw new Error('Preview parent ownership mismatch');
    }
    const references = referencedClientOids(root);
    const referenced = references.protectedOids;
    const protectedBuilds = new Set([retainedClientInventory(path.join(root, 'dist')).buildId, options.startupBuildId]);
    for (const key of ['clientSourceBuildId', 'clientCandidateBuildId', 'clientPromotedBuildId', 'clientServedBuildId']) {
        if (references.ledger[key]) protectedBuilds.add(safeBuildId(references.ledger[key]));
    }
    const retained = [];
    // Every candidate is protected, including unknown/unreferenced in-flight builds.
    for (const name of readdirSync(candidates)) {
        const directory = path.join(candidates, name);
        try { protectedBuilds.add(retainedClientInventory(directory).buildId); }
        catch { throw new Error('Cannot prove candidate protection'); }
    }
    const verified = [];
    for (const name of readdirSync(recoveries).sort()) {
        const directory = path.join(recoveries, name);
        if (!/^[a-f0-9]{64}-[a-f0-9-]{36}$/.test(name)) {
            retained.push({ directory, reason: 'unrecognized-name' }); continue;
        }
        try { verified.push(retainedClientInventory(directory)); }
        catch { retained.push({ directory, reason: 'unverified-generation' }); }
    }
    verified.sort((a, b) => Date.parse(b.builtAt) - Date.parse(a.builtAt)
        || a.directory.localeCompare(b.directory));
    const remove = [];
    for (const [index, entry] of verified.entries()) {
        const reason = index < 3 ? 'latest-three' : protectedBuilds.has(entry.buildId)
            ? 'live-or-candidate' : referenced.has(entry.oid) ? 'preview-reference'
                : entry.dirty !== false ? 'unsealed-provenance' : null;
        if (reason) retained.push({ ...entry, reason }); else remove.push(entry);
    }
    return { schema: 'nassaj-client-retention-plan/v1', dryRun: true,
        executionBlocked: 'retention_apply_requires_reviewed_manifest', root,
        refsSha256: references.refsSha256,
        archivedGroups: references.archived, retained, remove, reclaimableBytes: remove.reduce((sum, item) => sum + item.bytes, 0) };
}

/** Hold the existing build lock before the event lock; no private lock domain. */
async function withRetentionLocks(root, operation) {
    const control = previewControlPaths(root);
    checkedRealDirectory(control.gitDirectory, 'Git control directory');
    for (const file of [control.buildLock, path.join(control.gitDirectory, 'nassaj-client-build.lock'), previewEventMutationLock(root)]) {
        if (!existsSync(file)) continue;
        const st = lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o022) !== 0) {
            throw new Error('Unsafe existing retention lock');
        }
    }
    const holder = spawn('flock', ['-x', '-w', '10', previewControlPaths(root).buildLock,
        'flock', '-x', '-w', '10', path.join(previewControlPaths(root).gitDirectory, 'nassaj-client-build.lock'),
        'flock', '-x', '-w', '10', previewEventMutationLock(root), process.execPath, '-e',
        "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
        holder.stdout.once('data', (bytes) => bytes.toString() === 'locked\n' ? resolve()
            : reject(new Error('Unexpected retention lock handshake')));
        holder.once('error', reject);
        holder.once('exit', () => reject(new Error('Retention locks unavailable')));
    });
    const assertHeld = () => {
        if (holder.exitCode !== null || holder.signalCode !== null) throw new Error('Retention lock lost');
    };
    try { return await operation(assertHeld); }
    finally {
        const finished = new Promise((resolve) => holder.once('exit', resolve));
        holder.stdin.end();
        if (holder.exitCode === null && holder.signalCode === null) await finished;
    }
}

async function retentionHealth(fetchHealth) {
    const value = fetchHealth ? await fetchHealth() : await fetch('http://127.0.0.1:3004/health', {
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
    }).then((response) => { if (!response.ok) throw new Error('Health unavailable'); return response.json(); });
    if (value.status !== 'ok' || value.service !== 'nassaj-server'
        || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error('Unverified live client health');
    return { pid: value.pid, liveBuildId: safeBuildId(value.clientBuildIdServed),
        startupBuildId: safeBuildId(value.clientBuildIdAtServerStartup) };
}

/**
 * Preserve every published resource. Only the retired generation's entry HTML
 * and its three identity records differ by design: they are never served from
 * client-recovery, and the live index/version describe the current generation.
 */
function assertRecoveryAssetsPreserved(root, entry) {
    const excluded = new Set(['index.html', 'version.json', 'BUILD_PROVENANCE.json', 'ATOMIC_GENERATION.json']);
    function walk(directory) {
        for (const name of readdirSync(directory)) {
            const file = path.join(directory, name); const st = lstatSync(file);
            if (st.isDirectory() && !st.isSymbolicLink()) walk(file);
            else {
                if (!st.isFile() || st.isSymbolicLink()) throw new Error('Unsafe recovery asset');
                const relative = path.relative(entry.directory, file);
                if (excluded.has(relative)) continue;
                const live = path.join(root, 'dist', relative);
                if (realpathSync(live) !== live || !lstatSync(live).isFile()
                    || !readFileSync(file).equals(readFileSync(live))) throw new Error('Historical resource is not preserved live');
            }
        }
    }
    walk(entry.directory);
}

async function lockedRetentionPlan(root, injected, assertHeld) {
    const health = await retentionHealth(injected.fetchHealth); assertHeld();
    const plan = planClientPreviewRetention({ root, startupBuildId: health.startupBuildId });
    const live = retainedClientInventory(path.join(root, 'dist'));
    const state = readConsumerState(root); const ledger = readPreviewLedger(root);
    if (state.client && (state.client.buildId !== live.buildId || ledger.clientServedBuildId !== live.buildId)) {
        throw new Error('Live client and publication ledger disagree');
    }
    if (live.buildId !== health.liveBuildId) throw new Error('Live client health/provenance mismatch');
    plan.remove = plan.remove.filter((entry) => {
        try { assertRecoveryAssetsPreserved(root, entry); return true; }
        catch { plan.retained.push({ ...entry, reason: 'published-resource-coverage-unproved' }); return false; }
    });
    plan.reclaimableBytes = plan.remove.reduce((sum, entry) => sum + entry.bytes, 0);
    const after = await retentionHealth(injected.fetchHealth); assertHeld();
    if (JSON.stringify(health) !== JSON.stringify(after)) throw new Error('Live client changed during retention proof');
    return { ...plan, executionBlocked: null, health, liveInventorySha256: live.inventorySha256,
        contract: 'Historical cache liveness only; refs are not served receipts; all published resources except retired entry HTML and identity records remain live' };
}

/** Return a locked, fresh-health proposal without modifying client generations. */
export async function prepareClientPreviewRetention(options = {}, injected = {}) {
    const root = checkedRealDirectory(path.resolve(options.root || ROOT), 'Client root');
    return withRetentionLocks(root, (held) => lockedRetentionPlan(root, injected, held));
}

function durableRetentionJournal(file, record, first = false) {
    const output = first ? file : `${file}.tmp-${randomUUID()}`;
    const fd = openSync(output, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    if (!first) renameSync(output, file);
    const parent = openSync(path.dirname(file), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
}

function quarantineRecovery(entry, journal, record) {
    if (retainedClientInventory(entry.directory).inventorySha256 !== entry.inventorySha256) {
        throw new Error('Recovery changed before quarantine');
    }
    const quarantine = path.join(path.dirname(entry.directory), `.retention-quarantine-${randomUUID()}`);
    durableRetentionJournal(journal, { ...record, intent: { source: entry.directory, quarantine } });
    renameSync(entry.directory, quarantine);
    const actual = retainedClientInventory(quarantine);
    if (actual.device !== entry.device || actual.inode !== entry.inode
        || actual.contentSha256 !== entry.contentSha256) throw new Error('Quarantined recovery changed; manual review required');
    // Unknown/pre-existing quarantine is never a plan candidate or resumed deletion.
    rmSync(quarantine, { recursive: true });
}

/** Apply only the exact reviewed proposal after fresh proof under both existing locks. */
export async function applyClientPreviewRetention(options, injected = {}) {
    const root = checkedRealDirectory(path.resolve(options.root || ROOT), 'Client root');
    const file = path.resolve(options.manifestFile || '');
    if (!file.startsWith(`${path.join(root, '.artifacts')}${path.sep}`)
        || realpathSync(file) !== file) throw new Error('Retention manifest must be project-owned');
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o022) !== 0 || st.size > 5_000_000) {
        throw new Error('Unsafe retention manifest');
    }
    const bytes = readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== options.expectedManifestSha256) {
        throw new Error('Retention approval manifest digest mismatch');
    }
    const expected = JSON.parse(bytes);
    return withRetentionLocks(root, async (held) => {
        const actual = await lockedRetentionPlan(root, injected, held);
        if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Retention proposal changed; review again');
        if (referencedClientOids(root).refsSha256 !== actual.refsSha256
            || retainedClientInventory(path.join(root, 'dist')).inventorySha256 !== actual.liveInventorySha256) {
            throw new Error('Retention references or live inventory changed before mutation');
        }
        const journal = path.join(root, '.artifacts', `b896-retention-${options.expectedManifestSha256}.json`);
        const removed = [];
        const record = { schema: 'nassaj-client-retention-journal/v1', manifestSha256: options.expectedManifestSha256, removed };
        durableRetentionJournal(journal, record, true);
        // Synchronous quarantine/validation/removal while both established locks
        // remain held; no candidate tree is ever a deletion target.
        for (const entry of actual.remove) {
            held();
            quarantineRecovery(entry, journal, record);
            removed.push({ directory: entry.directory, bytes: entry.bytes });
            durableRetentionJournal(journal, record);
        }
        return { schema: 'nassaj-client-retention-result/v1', removed,
            removedBytes: removed.reduce((sum, entry) => sum + entry.bytes, 0), health: actual.health };
    });
}

const RESTORATION_SCHEMA = 'nassaj-client-restoration-plan/v1';
const RESTORATION_POLICY = 'reviewed-protected-recovery-atomic/v1';
const bytesSha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function restorationAsset(directory, relative) {
    if (!/^assets\/[A-Za-z0-9_./-]+$/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Restoration asset path unsafe');
    }
    let current = checkedRealDirectory(directory, 'Restoration asset root');
    const rootStat = lstatSync(current);
    if (rootStat.uid !== process.getuid() || rootStat.mode & 0o022) throw new Error('Restoration root unsafe');
    for (const [index, part] of relative.split('/').entries()) {
        current = path.join(current, part); let st;
        try { st = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o022) !== 0
            || (index === relative.split('/').length - 1 ? !st.isFile() : !st.isDirectory())) throw new Error('Restoration asset unsafe');
    }
    const data = readFileSync(current); return { data, size: data.length, sha256: bytesSha256(data) };
}
function restorationSelection(root, options, health) {
    const classification = planClientPreviewRetention({ root, startupBuildId: health.startupBuildId });
    const survivor = classification.retained.find(entry => entry.directory === options.recoveryDirectory
        && entry.dirty === false && ['latest-three', 'live-or-candidate', 'preview-reference'].includes(entry.reason));
    if (!survivor) throw new Error('Restoration requires a verified protected recovery');
    const metadataFile = path.join(survivor.directory, 'ATOMIC_GENERATION.json');
    let metadata = {};
    try { metadata = JSON.parse(readFileSync(metadataFile)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || (metadata.assets !== undefined && !Array.isArray(metadata.assets))) throw new Error('Restoration age metadata invalid');
    const times = new Map();
    for (const record of metadata.assets || []) {
        if (!record || typeof record.path !== 'string' || times.has(record.path)) throw new Error('Restoration age metadata invalid');
        const source = restorationAsset(survivor.directory, record.path);
        if (!source || !Number.isSafeInteger(record.size) || record.size !== source.size
            || (record.lastFreshAt !== null && (!Number.isFinite(record.lastFreshAt) || record.lastFreshAt < 0))) {
            throw new Error('Restoration age metadata invalid');
        }
        times.set(record.path, record.lastFreshAt);
    }
    const assets = [];
    function walk(directory) {
        for (const name of readdirSync(directory).sort()) {
            const file = path.join(directory, name),st = lstatSync(file);
            if (st.isDirectory() && !st.isSymbolicLink()) { walk(file); continue; }
            const relative = path.relative(survivor.directory, file).split(path.sep).join('/');
            const source = restorationAsset(survivor.directory, relative),live = restorationAsset(path.join(root, 'dist'), relative);
            if (!source) throw new Error('Restoration source missing');
            if (live) { if (!live.data.equals(source.data)) throw new Error('Restoration live conflict'); continue; }
            const lastFreshAt = times.get(relative);
            if (lastFreshAt !== undefined && lastFreshAt !== null && (!Number.isFinite(lastFreshAt) || lastFreshAt < 0)) throw new Error('Restoration age invalid');
            assets.push({ path: relative, size: source.size, sha256: source.sha256, lastFreshAt: lastFreshAt ?? null,
                survivorDirectory: survivor.directory });
        }
    }
    walk(checkedRealDirectory(path.join(survivor.directory, 'assets'), 'Recovery assets'));
    return { refsSha256: classification.refsSha256, assets, survivors: [survivor] };
}
async function lockedRestorationPlan(root, options, injected, held) {
    const sourceRoot = checkedRealDirectory(path.resolve(options.sourceRoot || ''), 'Restoration snapshot');
    const oid = assertOidSourceSnapshot(root, sourceRoot, options.expectedOid);
    if (sourceRoot !== path.join(root, '.nassaj-local-preview/oid-snapshots', oid)) throw new Error('Restoration snapshot placement invalid');
    assertNewest(root, options.group, oid);
    const state = readPreviewState(root, options.group);
    if (!state.coherent || state.desired !== oid || state.client.candidate !== oid) throw new Error('Restoration candidate state invalid');
    const buildId = safeBuildId(options.buildId);
    const candidatePath = path.join(root, '.nassaj-local-preview/client-candidates', buildId);
    if (candidateRecord(candidatePath, buildId, oid).dirty !== false) throw new Error('Restoration candidate unsealed');
    const health = await retentionHealth(injected.fetchHealth); held();
    const live = retainedClientInventory(path.join(root, 'dist'));
    if (live.buildId !== health.liveBuildId) throw new Error('Restoration live health mismatch');
    const selected = restorationSelection(root, options, health);
    const contractPath = path.join(sourceRoot, 'scripts/client-build-atomic.mjs');
    if (realpathSync(contractPath) !== contractPath || !lstatSync(contractPath).isFile()) throw new Error('Restoration contract unsafe');
    const plan = { schema: RESTORATION_SCHEMA, policy: RESTORATION_POLICY, root, sourceRoot, oid, group: options.group,
        buildId, mergeContract: { path: contractPath, sha256: bytesSha256(readFileSync(contractPath)) },
        health, live, candidate: retainedClientInventory(candidatePath), ...selected };
    const after = await retentionHealth(injected.fetchHealth); held();
    if (JSON.stringify(after) !== JSON.stringify(health)) throw new Error('Restoration health changed');
    return plan;
}
/** Prepare a reviewable plan for an already built candidate; never builds or copies assets. */
export async function prepareClientAssetRestoration(options, injected = {}) {
    const root = checkedRealDirectory(path.resolve(options.root || ROOT), 'Client root');
    return withRetentionLocks(root, held => lockedRestorationPlan(root, options, injected, held));
}
function recheckRestoration(plan, candidate) {
    assertOidSourceSnapshot(plan.root, plan.sourceRoot, plan.oid); assertNewest(plan.root, plan.group, plan.oid);
    if (bytesSha256(readFileSync(plan.mergeContract.path)) !== plan.mergeContract.sha256
        || retainedClientInventory(path.join(plan.root, 'dist')).inventorySha256 !== plan.live.inventorySha256
        || retainedClientInventory(candidate.directory).inventorySha256 !== candidate.inventorySha256) throw new Error('Restoration input drift');
    const selected = restorationSelection(plan.root, { recoveryDirectory: plan.survivors[0].directory }, plan.health);
    if (JSON.stringify(selected) !== JSON.stringify({ refsSha256: plan.refsSha256, assets: plan.assets, survivors: plan.survivors })) throw new Error('Restoration witness or references drift');
}
/** Apply one exact reviewed plan through the existing promotion path; never builds or changes dist directly. */
export async function restorePublishedClientAssets(options, injected = {}) {
    const root = checkedRealDirectory(path.resolve(options.root || ROOT), 'Client root');
    const file = path.resolve(options.manifestFile || '');
    if (!file.startsWith(path.join(root, '.artifacts') + path.sep) || realpathSync(file) !== file) throw new Error('Restoration manifest unsafe');
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o022 || st.size > 5000000) throw new Error('Restoration manifest unsafe');
    const bytes = readFileSync(file);
    if (bytesSha256(bytes) !== options.expectedManifestSha256) throw new Error('Restoration approval digest mismatch');
    const expected = JSON.parse(bytes);
    if (expected.schema !== RESTORATION_SCHEMA || expected.policy !== RESTORATION_POLICY || expected.root !== root) throw new Error('Restoration policy mismatch');
    return withRetentionLocks(root, async held => {
        const actual = await lockedRestorationPlan(root, { sourceRoot: expected.sourceRoot, expectedOid: expected.oid,
            group: expected.group, buildId: expected.buildId, recoveryDirectory: expected.survivors?.[0]?.directory }, injected, held);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Restoration plan changed; review again');
        const context = { restoration: { schema: 'nassaj-client-asset-restoration/v1', assets: actual.assets, survivors: actual.survivors },
            beforeMerge: () => { held(); recheckRestoration(actual, actual.candidate); },
            beforeExchange: candidate => {
                held(); recheckRestoration(actual, candidate);
                for (const asset of actual.assets) {
                    const copied = restorationAsset(candidate.directory, asset.path);
                    if (!copied || copied.size !== asset.size || copied.sha256 !== asset.sha256) throw new Error('Restoration merge omitted reviewed asset');
                }
            } };
        return promoteExistingClientCandidate({ root, sourceRoot: actual.sourceRoot, expectedOid: actual.oid,
            group: actual.group, buildId: actual.buildId }, { ...injected, withEventLock: async (_root, operation) => { held(); return operation(); } }, context);
    });
}

function parseArguments(argv) {
    const values = { locked: argv.includes('--locked') };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--locked') continue;
        if (!argv[index]?.startsWith('--') || argv[index + 1] == null) throw new Error('Invalid client OID argument.');
        values[argv[index].slice(2)] = argv[++index];
    }
    return values;
}

async function main() {
    const [action = 'build', ...argv] = process.argv.slice(2);
    if (['restoration-plan', 'restore-published-assets'].includes(action)) {
        const allowed = action === 'restoration-plan'
            ? ['repo', 'source-root', 'expected-oid', 'group', 'build-id', 'recovery']
            : ['repo', 'restoration-plan', 'expected-restoration-sha256'];
        const seen = new Set();
        for (let index = 0; index < argv.length; index += 2) {
            const key = argv[index]?.slice(2);
            if (!argv[index]?.startsWith('--') || !allowed.includes(key) || seen.has(key)
                || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Invalid restoration argument');
            seen.add(key);
        }
        if (allowed.some(key => !seen.has(key))) throw new Error('Missing restoration argument');
    }
    const args = parseArguments(argv);
    if (action === 'retention-plan') {
        process.stdout.write(`${JSON.stringify(await prepareClientPreviewRetention({ root: args.repo || ROOT }))}\n`);
        return;
    }
    if (action === 'retention-apply') {
        const result = await applyClientPreviewRetention({ root: args.repo || ROOT,
            manifestFile: args.manifest, expectedManifestSha256: args['expected-manifest-sha256'] });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    if (action === 'restoration-plan') {
        const result = await prepareClientAssetRestoration({ root: args.repo || ROOT, sourceRoot: args['source-root'],
            expectedOid: args['expected-oid'], group: args.group, buildId: args['build-id'], bootstrapPacket: args['bootstrap-packet'], recoveryDirectory: args.recovery });
        process.stdout.write(`${JSON.stringify(result)}\n`); return;
    }
    if (action === 'restore-published-assets') {
        const result = await restorePublishedClientAssets({ root: args.repo || ROOT, manifestFile: args['restoration-plan'],
            expectedManifestSha256: args['expected-restoration-sha256'] });
        process.stdout.write(`${JSON.stringify(result)}\n`); return;
    }
    const options = {
        root: path.resolve(args.repo || ROOT), sourceRoot: args['source-root'],
        expectedOid: args['expected-oid'], group: args.group, buildId: args['build-id'], bootstrapPacket: args['bootstrap-packet'],
    };
    if (action === 'promote' && !options.bootstrapPacket) assertStandaloneNodePublication(options.root);
    if (action === 'promote' && !args.locked) {
        const result = spawnSync('flock', [
            '-x', '-w', '10', '-F', previewEventMutationLock(options.root),
            process.execPath, fileURLToPath(import.meta.url), action, ...argv, '--locked',
        ], { cwd: options.root, encoding: 'utf8', stdio: 'inherit' });
        if (result.status !== 0) throw new Error(`Client OID promotion lock failed (${result.status ?? result.signal}).`);
        return;
    }
    const result = action === 'promote'
        ? await promoteClientPreviewFromOid(options, { withEventLock: async (_root, operation) => operation() })
        : await buildClientPreviewFromOid(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
