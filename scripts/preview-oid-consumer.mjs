#!/usr/bin/env node
/** Button-requested local preparation, plus one exact approved server-only bootstrap cycle.
 * Ordinary release events never publish or queue an activation through this consumer.
 */
import { resolveNodeUpdateMode, resolveConsumerUpdateMode } from './lib/node-update-mode.mjs';
import { readClientPublicationPolicy, assertClientPublicationPolicy, clientPublicationPolicyEnabled } from './lib/client-publication-policy.mjs';
import { readClientPublicationRuntime, readClientPublicationServing, recordClientPublicationServing } from './lib/client-publication-runtime.mjs';
import { readClientPublicationBlockers, reserveClientPublication, readClientPublication, transitionClientPublication, transitionClientPublicationUnlocked, reconcileReleaseUpdateWaiters } from './lib/client-publication-control.mjs';
import { verifyUpdateRuntimeBundle } from './lib/update-runtime-bundle.mjs';
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readLocalUpdatePolicy, assertLocalUpdatePolicy, verifyLocalUpdatePolicyCapability } from './lib/local-update-policy.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    advancePreview,
    materializePreviewSnapshot,
} from './preview-oid-pipeline.mjs';
import { readPreviewLedger, recordOidClientServed, recordPreviewLedgerEvent, git, previewEventMutationLock, withPreviewEventMutationLock, withPreviewMutationLock, exactSequence, normalizeDomains, previewEventRefs, listPreviewEvents, enqueuePreviewEvent, readConsumerState, statePath, readJson } from './local-preview-ledger.mjs';
import { assertNoNonterminalOidTransaction } from './oid-control-journal.mjs';
import { gitControlPath } from './git-control-root.mjs';
import { readBootstrapPublicationPacket, assertBootstrapPublicationContext,
    readBootstrapPublicationState, recordBootstrapPublicationState, assertBootstrapLoadedRuntime, inspectBootstrapServerAction, verifyBootstrapServerCandidate } from './lib/node-update-publication-guard.mjs';

export { previewEventMutationLock, withPreviewEventMutationLock, previewEventRefs, listPreviewEvents, enqueuePreviewEvent, readConsumerState, statePath, readJson };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLICATION_BOOT = (() => {
    const artifactRoot = path.dirname(ROOT);
    if (path.basename(ROOT) !== 'UPDATE_RUNTIME_BUNDLE' || !/^[a-f0-9]{64}$/.test(path.basename(artifactRoot))
        || path.basename(path.dirname(artifactRoot)) !== 'client-consumer-runtimes') return null;
    const bundle = verifyUpdateRuntimeBundle(artifactRoot);
    if (bundle.manifest.buildId !== path.basename(artifactRoot)) throw new Error('client_publication_boot_bundle_invalid');
    return Object.freeze({ artifactRoot, bundleRoot: bundle.bundleRoot, buildId: bundle.manifest.buildId });
})();
const CONTROL_NAME = 'nassaj-preview-oid-control-request-v1.json';

/** Serialize canonical candidate storage with both builders and the final event mutation. */
export async function withPreviewCandidateMutationLocks(root, operation) {
    return withPreviewMutationLock(root, gitControlPath(root, 'nassaj-local-preview-build.lock'),
        () => withPreviewMutationLock(root, gitControlPath(root, 'nassaj-client-build.lock'),
            () => withPreviewEventMutationLock(root, operation)));
}

/** Parse the explicitly authorized consumer scope; missing or mixed-invalid input fails closed. */
export function parseConsumerDomains(value) {
    const domains = typeof value === 'string' ? value.split(',').map((item) => item.trim()) : value;
    return normalizeDomains(domains);
}

function controlPath(root) {
    return gitControlPath(root, CONTROL_NAME);
}

function eventControlPath(root, sequence) {
    return gitControlPath(root, `nassaj-preview-oid-event-control-${String(sequence).padStart(16, '0')}.json`);
}

function writeDurableJson(file, value) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    let descriptor;
    try {
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
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

function newestEvent(root, domain = null) {
    const events = listPreviewEvents(root);
    return (domain ? events.filter((event) => event.domains.includes(domain)) : events).at(-1) || null;
}

/** Newest immutable event for one independent build domain. */
export function newestPreviewEvent(root, domain) {
    return newestEvent(root, parseConsumerDomains([domain])[0]);
}

function assertStillNewest(root, event, domains) {
    const stale = domains.some((domain) => {
        const newest = newestEvent(root, domain);
        return !newest || newest.sequence !== event.sequence || newest.oid !== event.oid;
    });
    if (stale) {
        throw new Error('preview_superseded');
    }
}

function persistPhase(root, state, event, domain, phase, extra = {}) {
    const next = {
        ...state,
        schemaVersion: 1,
        acceptedSequence: Math.max(state.acceptedSequence, event.sequence),
        acceptedOid: event.sequence >= state.acceptedSequence ? event.oid : state.acceptedOid,
        [domain]: { sequence: event.sequence, oid: event.oid, phase, ...extra },
        updatedAt: new Date().toISOString(),
    };
    writeDurableJson(statePath(root), next);
    return next;
}

function readClientRuntimeIdentity(root) {
    try {
        const version = readJson(path.join(root, 'dist', 'version.json'), null);
        const provenance = readJson(path.join(root, 'dist', 'BUILD_PROVENANCE.json'), null);
        if (!/^[a-f0-9]{64}$/.test(version?.buildId || '') || provenance?.artifact !== 'client'
            || provenance.buildId !== version.buildId || !/^[a-f0-9]{40}$/.test(provenance.commit || '')) return null;
        return { oid: provenance.commit, buildId: version.buildId };
    } catch {
        return null;
    }
}

/** Reconcile a proven served OID after a consumer/ledger write interruption or publisher migration. */
export function reconcileClientRuntimeLedger(root) {
    const state = readConsumerState(root);
    if (state.client?.phase !== 'served') return { status: 'idle', state };
    const newest = newestEvent(root, 'client');
    const runtime = readClientRuntimeIdentity(root);
    if (!newest || newest.sequence !== state.client.sequence || newest.oid !== state.client.oid
        || runtime?.oid !== state.client.oid || runtime.buildId !== state.client.buildId) {
        return { status: 'unproven', state };
    }
    const ledger = readPreviewLedger(root);
    if (ledger.clientPublisher === 'oid' && ledger.clientSourceGeneration === state.client.sequence
        && ledger.clientState === 'served' && ledger.clientServedBuildId === runtime.buildId) {
        return { status: 'current', state, ledger };
    }
    recordOidClientServed(root, newest, runtime.buildId);
    return { status: 'reconciled', state, ledger: readPreviewLedger(root) };
}

function readOptionalPublicationRuntime(root) {
    try { return readClientPublicationRuntime(root); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function publicationSharedLease(root, name) {
    const child = spawn('flock', ['-s', '-w', '10', gitControlPath(root, 'nassaj-source-update') + `/${name}.lock`,
        process.execPath, '-e', "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('error', reject);
        child.once('exit', () => reject(new Error('client_publication_lock_contended')));
    });
    return () => new Promise((resolve, reject) => {
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('client_publication_lock_release')));
        child.stdin.end();
    });
}

async function withPublicationLocks(root, operation) {
    const releaseAdmission = await publicationSharedLease(root, 'admission');
    let releaseActivity;
    try { releaseActivity = await publicationSharedLease(root, 'activity'); }
    finally { await releaseAdmission(); }
    try {
        return await withPreviewMutationLock(root, gitControlPath(root, 'nassaj-local-preview-build.lock'),
            () => withPreviewMutationLock(root, gitControlPath(root, 'nassaj-client-build.lock'), operation));
    } finally { await releaseActivity(); }
}

function clientPublicationContext(root, event, getReservation, setReservation) {
    const revalidate = () => {
        const loaded = readClientPublicationRuntime(root);
        if (loaded.updateRuntimeBuildId !== PUBLICATION_BOOT.buildId
            || verifyUpdateRuntimeBundle(PUBLICATION_BOOT.artifactRoot).manifest.buildId !== PUBLICATION_BOOT.buildId) throw new Error('client_publication_loaded_bundle_changed');
        assertClientPublicationPolicy(root, loaded, getReservation().policyRevision);
        if (git(root, ['rev-parse', '--verify', 'refs/heads/main^{commit}']) !== event.oid) throw new Error('client_publication_main_changed');
        const current = readClientPublication(root, event.sequence);
        if (current.reservationId !== getReservation().reservationId || current.revision !== getReservation().revision) throw new Error('client_publication_revision_conflict');
        if (readClientPublicationBlockers(root).fullUpdates.length && current.effect === 'none') throw new Error('client_publication_full_update_waiting');
    };
    return { withEventLock: withPreviewEventMutationLock, revalidate,
        readActualServerIdentity: () => readClientPublicationRuntime(root).serverIdentity,
        readServingLineage: readClientPublicationServing, recordServingLineage: recordClientPublicationServing,
        beforeEffect: () => setReservation(transitionClientPublicationUnlocked(root, getReservation(), { phase: 'publishing', effect: 'started' })) };
}

function publicationRecoveryJournal(root, reservation) {
    const directory = path.dirname(eventControlPath(root, reservation.sequence));
    const names = readdirSync(directory).filter(name => name.startsWith(`nassaj-oid-control-transaction-${reservation.sequence}-`) && name.endsWith('.json'));
    const journals = names.map(name => ({ file: path.join(directory, name), value: readJson(path.join(directory, name), null) }))
        .filter(entry => entry.value?.kind === 'client-publication' && entry.value.reservationId === reservation.reservationId);
    if (journals.length !== 1) throw new Error('client_publication_recovery_journal_required');
    return journals[0];
}

async function recordPublicationFailure(root, reservation, error) {
    const directory = path.dirname(eventControlPath(root, reservation.sequence));
    const intentExists = readdirSync(directory).some(name => name.startsWith(`nassaj-oid-control-transaction-${reservation.sequence}-`));
    const superseded = ['client_publication_main_changed', 'client_publication_policy_changed', 'client_publication_policy_disabled', 'client_publication_full_update_waiting'];
    const phase = reservation.effect !== 'none' || intentExists ? 'recovery_required' : superseded.includes(error.message) ? 'superseded'
        : /capacity|resource|lock|waiting/.test(error.message) ? 'waiting' : 'build_failed';
    await transitionClientPublication(root, reservation, { phase, reason: error.code || 'client_publication_blocked',
        ...(phase === 'recovery_required' ? { effect: 'unknown' } : {}) });
}

/** Consume only installation-authorized merged main, preserving button events and started-effect recovery. */
export async function consumeDevClientPublication(root, operations = {}) {
    await reconcileReleaseUpdateWaiters(root);
    const blockers = readClientPublicationBlockers(root);
    const pending = blockers.publications[0];
    if (!pending && !clientPublicationPolicyEnabled(root)) return null;
    const binding = readOptionalPublicationRuntime(root);
    const policy = readClientPublicationPolicy(root, binding);
    if (policy.mode !== 'dev-client-auto' && !pending) return null;
    if (!binding) throw new Error('client_publication_loaded_baseline_unproven');
    if (!PUBLICATION_BOOT) throw new Error('client_publication_installed_consumer_required');
    const bundle = verifyUpdateRuntimeBundle(PUBLICATION_BOOT.artifactRoot);
    if (bundle.manifest.buildId !== PUBLICATION_BOOT.buildId
        || !pending && binding.updateRuntimeBuildId !== PUBLICATION_BOOT.buildId) throw new Error('client_publication_installed_consumer_changed');
    const { publishDevClient, reconcileDevClientPublication } = await import(pathToFileURL(path.join(PUBLICATION_BOOT.bundleRoot, 'scripts/lib/client-publication-executor.mjs')).href);
    if (!pending && blockers.fullUpdates.length) return null;
    const event = pending ? listPreviewEvents(root).find(item => item.sequence === pending.sequence)
        : listPreviewEvents(root).filter(item => item.domains.includes('client') && !readJson(eventControlPath(root, item.sequence), null)?.localUpdate).at(-1);
    if (!event) return null;
    let reservation = pending ?? await reserveClientPublication(root, event, binding);
    if (['served', 'rolled_back', 'cancelled', 'superseded', 'build_failed'].includes(reservation.phase)) return { status: 'idle' };
    const lineage = readClientPublicationServing(root);
    const context = clientPublicationContext(root, event, () => reservation, value => { reservation = value; });
    const options = { root, event, policy, reservationId: reservation.reservationId, baseline: binding,
        parentServingReceiptDigest: lineage.receiptDigest };
    try {
        const outcome = await withPublicationLocks(root, async () => {
            if (['started', 'unknown'].includes(reservation.effect)) {
                return reconcileDevClientPublication({ ...options, journal: publicationRecoveryJournal(root, reservation) }, context);
            }
            context.revalidate();
            reservation = await transitionClientPublication(root, reservation, { phase: 'building' });
            options.sourceRoot = await (operations.materialize || materializePreviewSnapshot)(root, event.oid);
            return publishDevClient(options, context);
        });
        const phase = outcome.receipt?.outcome ?? 'served';
        reservation = await transitionClientPublication(root, reservation, { phase, effect: 'settled', receiptDigest: outcome.receiptDigest });
        return { status: 'consumed', event, publication: reservation };
    } catch (error) {
        await recordPublicationFailure(root, reservation, error);
        throw error;
    }
}

/**
 * Build the oldest pending item among each authorized domain's newest OID.
 * Client promotion may be atomic; server promotion only records an exact
 * owner-control request and therefore returns pending.
 */
export async function consumeNewestPreview(root, operations, options = {}) {
    const mode = resolveConsumerUpdateMode(root, options.mode);
    const fullPolicy = readLocalUpdatePolicy(root);
    if (fullPolicy.mode === 'dev-full-auto') assertLocalUpdatePolicy(root);
    if (!options.bootstrapPacket && fullPolicy.mode !== 'dev-full-auto') {
        const publication = await consumeDevClientPublication(root, operations);
        if (publication) return publication;
    }
    if (mode === 'release' && !options.bootstrapPacket) throw new Error('node_update_button_required');
    assertNoNonterminalOidTransaction(root, null, options.disposition || null);
    if (mode === 'local-main') {
        const local = await import('./lib/local-update-control.mjs');
        return withPreviewMutationLock(root, gitControlPath(root, 'nassaj-local-preview-consume.lock'),
            () => consumeGovernedLocalUpdate(root, operations, options, local));
    }
    return consumeBootstrapServer(root, operations, options);
}

async function consumeBootstrapServer(root, operations, options) {
    if (parseConsumerDomains(options.domains).join(',') !== 'server') throw new Error('bootstrap_publication_server_only');
    const binding = readBootstrapPublicationPacket(root, options.bootstrapPacket), scope = binding.scope;
    const event = listPreviewEvents(root).find(item => item.sequence === scope.sequence);
    if (!event || event.oid !== scope.oid || event.group !== scope.group || !event.domains.includes('server')) throw new Error('bootstrap_publication_event_context');
    await assertBootstrapLoadedRuntime(root, binding);
    const claim = await withPreviewEventMutationLock(root, () => {
        assertBootstrapPublicationContext(root, binding, {});
        const saved = readBootstrapPublicationState(root, binding);
        const server = readConsumerState(root).server;
        if (server?.sequence === scope.sequence && server.oid === scope.oid && ['loaded', 'rolled_back'].includes(server.phase)) throw new Error('bootstrap_publication_terminal');
        if (saved?.server === 'prepared') { verifyBootstrapPrepared(root, binding, saved); return saved; }
        if (saved?.server) throw new Error('bootstrap_publication_incomplete_step_requires_reconciliation');
        assertStillNewest(root, event, ['server']);
        recordBootstrapPublicationState(root, binding, { server: 'claimed' }); return null;
    });
    if (claim) return { status: 'waiting', event, state: readConsumerState(root), bootstrap: claim };
    const sourceRoot = await (operations.materialize || materializePreviewSnapshot)(root, event.oid);
    assertBootstrapPublicationContext(root, binding, {}); assertStillNewest(root, event, ['server']);
    const candidate = await operations.buildServer({ root, sourceRoot, event });
    assertBootstrapPublicationContext(root, binding, { serverBuildId: candidate.buildId });
    if (!/^[a-f0-9]{64}$/.test(candidate.controlManifestSha256 || '')) throw new Error('OID server candidate omitted its external control manifest identity.');
    const request = { schemaVersion: 1, action: 'promote-and-safe-restart', sequence: event.sequence, oid: event.oid,
        buildId: candidate.buildId, controlManifestSha256: candidate.controlManifestSha256, snapshotOid: event.oid,
        group: event.group, requestedAt: new Date().toISOString() };
    await withPreviewEventMutationLock(root, () => {
        assertStillNewest(root, event, ['server']); assertBootstrapPublicationContext(root, binding, {});
        recordBootstrapPublicationState(root, binding, { server: 'queue_intent', request });
        const previous = readJson(eventControlPath(root, event.sequence), {});
        writeDurableJson(eventControlPath(root, event.sequence), { ...previous, buildId: candidate.buildId,
            snapshotOid: event.oid, controlManifestSha256: candidate.controlManifestSha256 });
        writeDurableJson(controlPath(root), request);
    });
    return withPreviewEventMutationLock(root, async () => {
        await assertBootstrapLoadedRuntime(root, binding);
        assertStillNewest(root, event, ['server']); assertBootstrapPublicationContext(root, binding, {});
        const queued = await operations.requestServerControlPlane({ root, sourceRoot, event, candidate, request });
        const action = inspectBootstrapServerAction(root, binding, queued?.actionId);
        if (JSON.stringify(readJson(controlPath(root), null)) !== JSON.stringify(request)) throw new Error('preview_owner_control_changed');
        const state = persistPhase(root, readConsumerState(root), event, 'server', 'awaiting_owner', {
            buildId: candidate.buildId, controlManifestSha256: request.controlManifestSha256 });
        const bootstrap = recordBootstrapPublicationState(root, binding, { server: 'prepared', actionId: action.id });
        return { status: 'consumed', event, state, bootstrap };
    });
}

function verifyBootstrapPrepared(root, binding, saved) {
    inspectBootstrapServerAction(root, binding, saved.actionId);
    const scope = binding.scope, state = readConsumerState(root).server, request = readJson(controlPath(root), null);
    if (!request || JSON.stringify(request) !== JSON.stringify(saved.request) || request.oid !== scope.oid
        || request.sequence !== scope.sequence || request.group !== scope.group || request.buildId !== scope.serverBuildId
        || state?.sequence !== scope.sequence || state.oid !== scope.oid || state.phase !== 'awaiting_owner'
        || state.buildId !== scope.serverBuildId || state.controlManifestSha256 !== request.controlManifestSha256) throw new Error('bootstrap_publication_prepared_evidence_changed');
    try { verifyBootstrapServerCandidate(root, binding, request.controlManifestSha256); }
    catch { throw new Error('bootstrap_publication_candidate_changed'); }
}

const LOCAL_TERMINAL = new Set(['activated', 'cancelled', 'expired', 'superseded', 'failed', 'manual_recovery_required']);

async function readPolicyHealth() {
    const port = process.env.HEALTH_PORT || '3004';
    const url = process.env.NASSAJ_PREVIEW_HEALTH_URL || process.env.HEALTH_URL || `http://127.0.0.1:${port}/health`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error('local_update_policy_health_unavailable');
    return response.json();
}

async function savePolicyObservation(root, request, reason) {
    return withPreviewEventMutationLock(root, () => {
        const mainOid = git(root, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
        const devFull = { schema: 'nassaj-dev-full-consumer/v1', targetMainOid: mainOid,
            buildingOid: request?.phase === 'preparing' ? request.oid : null,
            pendingOid: request?.oid !== mainOid ? mainOid : null, waitReason: reason, observedAt: Date.now() };
        writeDurableJson(statePath(root), { ...readConsumerState(root), devFull });
    });
}

async function preparePolicyTarget(root, local, policy, request, health) {
    const target = local.readLocalMainTarget(root, health);
    if (!target.available) return null;
    if (request && !LOCAL_TERMINAL.has(request.phase)) return request;
    if (request?.phase === 'manual_recovery_required') return request;
    const key = createHash('sha256').update(JSON.stringify([policy.installationId, policy.revision, target.oid])).digest('hex');
    return local.prepareLocalUpdate(root, { mode: 'local-main', expectedOid: target.oid,
        ownerId: String(policy.ownerId), idempotencyKey: `dev-full:${key}`,
        origin: { kind: 'policy', policyRevision: policy.revision, receiptDigest: policy.receiptDigest } });
}

async function consumeGovernedLocalUpdate(root, operations, options, local) {
    let request = local.readLocalUpdate(root);
    if (request) request = await local.retireChangedLocalPolicy(root, request.sequence);
    if (request) request = await local.retireChangedLocalPreparation(root, request.sequence);
    const policy = readLocalUpdatePolicy(root);
    if (policy.mode !== 'dev-full-auto' || (request && !LOCAL_TERMINAL.has(request.phase)
        && request.prepare.origin?.kind !== 'policy')) return consumeRequestedLocalUpdate(root, operations, options, local);
    assertLocalUpdatePolicy(root);
    const health = await (operations.fetchPolicyHealth || readPolicyHealth)();
    const capability = verifyLocalUpdatePolicyCapability(root, health);
    request = await preparePolicyTarget(root, local, policy, request, health);
    if (!request || request.prepare.origin?.kind !== 'policy' || LOCAL_TERMINAL.has(request.phase)) {
        const reason = !request ? null : request.prepare.origin?.kind !== 'policy' ? 'manual_update_pending' : request.phase;
        await savePolicyObservation(root, request, reason);
        return { status: request ? 'waiting' : 'idle', reason, localUpdate: request };
    }
    await savePolicyObservation(root, request, request.phase);
    let result;
    try { result = await consumeRequestedLocalUpdate(root, operations, options, local); }
    catch (error) {
        if (error.code !== 'local_update_target_changed') throw error;
        request = await local.retireChangedLocalPreparation(root, request.sequence);
        await savePolicyObservation(root, request, 'newer_main_pending');
        return { status: 'waiting', reason: 'newer_main_pending', localUpdate: request };
    }
    request = await local.retireChangedLocalPolicy(root, request.sequence);
    request = await local.retireChangedLocalPreparation(root, request.sequence);
    if (['prepared', 'awaiting_sessions'].includes(request.phase) && !request.activation) {
        request = await local.authorizeLocalUpdateByPolicy(root, { sequence: request.sequence,
            expectedRevision: request.revision, capability });
    }
    await savePolicyObservation(root, request, request.phase);
    return { ...result, localUpdate: request };
}

async function consumeRequestedLocalUpdate(root, operations, options, local) {
    const request = local.readLocalUpdate(root);
    try { return await consumeLocalUpdate(root, operations, options, local); }
    catch (error) {
        if (request && error.code !== 'local_update_target_changed') {
            await local.recordLocalPreparationFailure(root, request.sequence, error);
        }
        throw error;
    }
}

/** Prepare a requested pair only; neither legacy publication nor restart can run. */
async function consumeLocalUpdate(root, operations, options, local) {
    const domains = parseConsumerDomains(options.domains || ['client', 'server']);
    if (domains.join(',') !== 'client,server') throw new Error('local_update_pair_scope_required');
    let request = local.readLocalUpdate(root);
    if (request) request = await local.retireChangedLocalPreparation(root, request.sequence);
    if (!request || request.phase !== 'preparing') return { status: request ? 'waiting' : 'idle', localUpdate: request };
    if (readClientPublicationBlockers(root).publications.length) return { status: 'waiting', reason: 'client_publication_recovery_required', localUpdate: request };
    const event = { sequence: request.sequence, oid: request.oid, domains: request.domains, group: request.group };
    if (operations.buildTriple) {
        await withPreviewEventMutationLock(root, () => {
            if (local.readLocalUpdate(root, event.sequence)?.phase !== 'preparing') throw new Error('local_update_not_preparing');
            for (const domain of domains) persistPhase(root, readConsumerState(root), event, domain, 'building');
        });
        const target = await operations.buildTriple({ root, event });
        if (target?.schema !== 'nassaj-oid-triple-target/v2') throw new Error('local_update_triple_candidate_required');
        const prepared = await local.completeLocalUpdatePreparation(root, event.sequence, target);
        return { status: 'consumed', event, state: readConsumerState(root), localUpdate: prepared };
    }
    const sourceRoot = await (operations.materialize || materializePreviewSnapshot)(root, event.oid);
    for (const domain of domains) {
        const saved = readConsumerState(root)[domain];
        if (saved?.sequence === event.sequence && saved.phase === 'candidate') {
            const identity = local.verifyLocalCandidate(root, request, domain, saved.buildId);
            if (identity.treeSha256 !== saved.treeSha256) throw new Error('local_update_candidate_changed');
            continue;
        }
        await withPreviewEventMutationLock(root, () => {
            if (local.readLocalUpdate(root, event.sequence)?.phase !== 'preparing') throw new Error('local_update_not_preparing');
            persistPhase(root, readConsumerState(root), event, domain, 'building');
        });
        const candidate = await operations[domain === 'client' ? 'buildClient' : 'buildServer']({ root, sourceRoot, event });
        const identity = local.verifyLocalCandidate(root, request, domain, candidate.buildId);
        await withPreviewEventMutationLock(root, () => {
            if (local.readLocalUpdate(root, event.sequence)?.phase !== 'preparing') throw new Error('local_update_not_preparing');
            persistPhase(root, readConsumerState(root), event, domain, 'candidate', { buildId: candidate.buildId, treeSha256: identity.treeSha256 });
        });
    }
    const state = readConsumerState(root);
    const prepared = await local.completeLocalUpdatePreparation(root, event.sequence, {
        clientBuildId: state.client.buildId, serverBuildId: state.server.buildId,
    });
    return { status: 'consumed', event, state, localUpdate: prepared };
}

/** Mark loaded only after health proves the exact control-plane tuple. */
export async function confirmServerLoaded(root, health) {
    const request = readJson(controlPath(root), null);
    if (!request) throw new Error('No pending OID server control request.');
    const next = await withPreviewEventMutationLock(root, () => {
        if (JSON.stringify(readJson(controlPath(root), null)) !== JSON.stringify(request)) {
            throw new Error('preview_owner_control_changed');
        }
        const newest = newestEvent(root, 'server');
        if (!newest || newest.sequence !== request.sequence || newest.oid !== request.oid) {
            throw new Error('preview_superseded');
        }
        if (health?.status !== 'ok' || health.serverLoadedOid !== request.oid
            || health.serverLoadedBuildId !== request.buildId) {
            throw new Error('Server health did not prove the exact OID/build identity.');
        }
        advancePreview(root, { group: request.group, domain: 'server', state: 'promoted', oid: request.oid });
        advancePreview(root, { group: request.group, domain: 'server', state: 'loaded', oid: request.oid });
        const loaded = persistPhase(root, readConsumerState(root), newest, 'server', 'loaded', { buildId: request.buildId });
        rmSync(controlPath(root), { force: true });
        return loaded;
    });
    // Ledger locking must never nest inside the event lock.
    recordPreviewLedgerEvent(root, {
        target: 'server', publisher: 'oid', sourceGeneration: request.sequence, state: 'loaded',
        sourceBuildId: request.buildId, candidateBuildId: request.buildId,
        promotedBuildId: request.buildId, runtimeBuildId: request.buildId,
    });
    return next;
}

/** Polling-side caller for confirmServerLoaded; mismatch is pending, never proof. */
export async function reconcileServerRuntime(root, fetchHealth = async () => {
    const port = process.env.HEALTH_PORT || '3004';
    const url = process.env.NASSAJ_PREVIEW_HEALTH_URL || process.env.HEALTH_URL
        || `http://127.0.0.1:${port}/health`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.ok ? response.json() : null;
}) {
    const state = readConsumerState(root);
    if (state.server?.phase !== 'awaiting_owner' || !existsSync(controlPath(root))) {
        return { status: 'idle', state };
    }
    try {
        const health = await fetchHealth();
        const loaded = await confirmServerLoaded(root, health);
        return { status: 'loaded', state: loaded };
    } catch (error) {
        if (error?.message === 'preview_superseded') throw error;
        return { status: 'awaiting_owner', state, detail: error?.message || 'health_unavailable' };
    }
}

/** One scoped polling iteration; client authorization cannot reach server health reconciliation. */
export async function runConsumerIteration(root, operations, options = {}) {
    const domains = parseConsumerDomains(options.domains);
    const mode = resolveConsumerUpdateMode(root, options.mode);
    const result = await consumeNewestPreview(root, operations, { ...options, domains, mode });
    if (mode !== 'local-main' && options.bootstrapPacket && domains.includes('server')) {
        await (options.reconcile || reconcileServerRuntime)(root);
    }
    return result;
}

/** Rollback remains an owner-control request; this process never swaps runtime bytes. */
export async function requestRuntimeRollback(root, expected, operation) {
    const state = readConsumerState(root);
    if (state.server?.phase !== 'loaded' || state.server.oid !== expected.oid
        || state.server.buildId !== expected.buildId) throw new Error('Rollback identity mismatch.');
    return operation({ action: 'rollback-and-safe-restart', ...expected });
}

/** Select trusted full-build orchestration from the verified retained closure, never mutable source. */
export function retainedLocalBuilderEntry(boot = PUBLICATION_BOOT) {
    if (!boot) throw Object.assign(new Error('local_update_retained_builder_required'), { code: 'local_update_retained_builder_required' });
    const bundle = verifyUpdateRuntimeBundle(boot.artifactRoot);
    const entry = 'scripts/oid-update-candidate.mjs';
    if (bundle.manifest.buildId !== boot.buildId || !bundle.manifest.entries.includes(entry)
        || !bundle.manifest.files.some(file => file.path === entry)) {
        throw Object.assign(new Error('local_update_retained_builder_changed'), { code: 'local_update_retained_builder_changed' });
    }
    return { entry: path.join(bundle.bundleRoot, entry), orchestrationBuildId: bundle.manifest.buildId };
}

function parseArguments(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        if (!argv[index]?.startsWith('--') || argv[index + 1] == null) throw new Error('Invalid consumer argument.');
        values[argv[index].slice(2)] = argv[index + 1];
    }
    return values;
}

/** Preserve bounded builder diagnostics across the executable boundary without exposing stderr. */
export function invokeCandidateExecutable(root, entry, values, env = process.env) {
    const result = spawnSync(process.execPath, [entry, ...values], {
        env, cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.error) {
        const allowed = new Set(['local_update_build_profile_required', 'local_update_build_inputs_unqualified',
            'local_update_build_cache_missing', 'local_update_build_headers_missing', 'local_update_build_capacity_wait',
            'local_update_build_capacity_unknown', 'local_update_build_recovery_required', 'local_update_resources_busy']);
        let diagnostic;
        try { diagnostic = JSON.parse((result.stderr || '').trim().split('\n').at(-1)); } catch { /* unstructured failure */ }
        const code = !result.error && result.status === 1 && diagnostic?.event === 'local_update_candidate_failed'
            && allowed.has(diagnostic.code) ? diagnostic.code : 'local_update_candidate_failed';
        throw Object.assign(new Error(code), { code });
    }
    return JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1));
}

async function main() {
    if (process.env.NASSAJ_PREVIEW_OID_ENFORCEMENT !== '1') {
        throw new Error('OID consumer is disabled until NASSAJ_PREVIEW_OID_ENFORCEMENT=1 is explicitly installed.');
    }
    const args = parseArguments(process.argv.slice(2));
    const root = path.resolve(args.repo || ROOT);
    const domains = parseConsumerDomains(process.env.NASSAJ_PREVIEW_OID_DOMAINS);
    const mode = resolveNodeUpdateMode(root);
    if (!['release', 'local-main'].includes(mode)) throw new Error('local_update_invalid_mode');
    if (mode === 'release' && !args['bootstrap-packet'] && !clientPublicationPolicyEnabled(root) && !readClientPublicationBlockers(root).publications.length) throw new Error('node_update_button_required');
    if (mode === 'release' && args['bootstrap-packet'] && domains.join(',') !== 'server') throw new Error('bootstrap_publication_server_only');
    // Production operations are intentionally separate executables. The
    // service invokes this loop only after their reviewed installation.
    const invoke = (script, values) => {
        const retained = script === 'oid-update-candidate.mjs' ? retainedLocalBuilderEntry() : null;
        const entry = retained?.entry || path.join(root, 'scripts', script);
        if (retained) return invokeCandidateExecutable(root, entry, values,
            { ...process.env, NASSAJ_LOCAL_BUILD_ORCHESTRATION_ID: retained.orchestrationBuildId });
        const result = spawnSync(process.execPath, [entry, ...values], {
            env: { ...process.env, ...(retained ? { NASSAJ_LOCAL_BUILD_ORCHESTRATION_ID: retained.orchestrationBuildId } : {}) },
            cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
        });
        if (result.status !== 0) throw new Error(`${script} failed.`);
        const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
        return JSON.parse(line);
    };
    while (true) {
        const operations = {
            ...(mode === 'local-main' ? { buildTriple: ({ event }) => invoke('oid-update-candidate.mjs', [
                '--oid', event.oid, '--sequence', String(event.sequence),
            ]) } : {}),
            buildClient: ({ sourceRoot, event }) => invoke('client-preview-from-oid.mjs', [
                'build', '--source-root', sourceRoot, '--expected-oid', event.oid, '--group', event.group,
            ]),
        };
        if (domains.includes('server')) Object.assign(operations, {
            buildServer: ({ sourceRoot, event }) => invoke('server-preview-from-oid.mjs', [
                'build', '--source-root', sourceRoot, '--expected-oid', event.oid, '--group', event.group,
            ]),
            requestServerControlPlane: async ({ event, candidate }) => {
                const result = spawnSync(process.execPath, [
                    path.join(root, 'scripts', 'request-server-action.mjs'),
                    '--action', 'safe-restart',
                    '--session', `preview-oid-${event.sequence}`,
                    '--expected-server-build-id', candidate.buildId,
                    '--reason', `OID preview seq=${event.sequence} oid=${event.oid} buildId=${candidate.buildId}`,
                    '--requested-by', 'preview-oid-consumer',
                ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
                if (result.status !== 0) throw new Error('Existing server-action control plane rejected the OID candidate.');
                const actionId = result.stdout.match(/^\s*(?:queuedId|id)\s*:\s*([A-Za-z0-9-]+)\s*$/m)?.[1];
                if (!actionId) throw new Error('bootstrap_publication_action_identity_missing');
                return { actionId };
            },
        });
        const result = await runConsumerIteration(root, operations, { domains, mode, bootstrapPacket: args['bootstrap-packet'] });
        if (mode === 'release' && args['bootstrap-packet']) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
        // Poll at a bounded cadence even immediately after build.  This also
        // makes confirmServerLoaded reachable in production without a busy loop.
        await new Promise((resolve) => setTimeout(resolve, result.status === 'consumed' ? 250 : 1_000));
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
