/** Installed development-client executor. The consumer owns outer locks and all policy authority. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as publisher from '../client-build-atomic.mjs';
import { clientPublicationDigest as digest, createClientAssetManifest, validateClientAssetManifest,
    proveClientCompatibility, readClientPublicationFile, assertClientPublicationSnapshot } from './client-publication-artifacts.mjs';
import { runIsolatedClientBuild } from './client-publication-isolation.mjs';
import { CLIENT_PUBLICATION_JOURNAL_SCHEMA, writeClientPublicationIntent, advanceClientPublicationJournal,
    writeClientPublicationOutcome, validateClientPublicationJournal } from './client-publication-journal.mjs';

import { assertClientPublicationCapacity, prepareClientPublicationAssets as prepareAssets } from './client-publication-archive.mjs';
export { assertClientPublicationCapacity } from './client-publication-archive.mjs';

/** Prepare archived closure with the installed client verifier. */
export function prepareClientPublicationAssets(root, candidate, expected) {
    return prepareAssets(root, candidate, expected, publisher.verifyAssetClosure);
}

function mkdirReal(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error('client_publication_parent_unsafe');
}

function syncDirectory(directory) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function requiredContext(context) {
    for (const key of ['withEventLock', 'revalidate', 'readActualServerIdentity', 'readServingLineage', 'recordServingLineage', 'beforeEffect']) {
        if (typeof context[key] !== 'function') throw new Error('client_publication_loaded_authority_required');
    }
}

function servingIdentity(directory) {
    const sealed = validateClientAssetManifest(directory, {}, publisher.verifyAssetClosure);
    return { sourceOid: sealed.manifest.sourceOid, buildId: sealed.manifest.buildId,
        treeDigest: sealed.treeDigest, assetManifestDigest: sealed.manifestDigest };
}

async function buildCandidate(options, context) {
    const { root, sourceRoot, event } = options, sourceOid = event.oid;
    if (!/^[a-f0-9]{40}$/.test(sourceOid || '') || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error('client_publication_event_invalid');
    const sourceDigest = assertClientPublicationSnapshot(root, sourceRoot, sourceOid);
    const buildId = publisher.computeClientBuildId(sourceRoot), generationId = digest({ sourceOid, buildId });
    const parent = path.join(root, '.nassaj-local-preview/client'), candidateParent = path.join(root, '.nassaj-local-preview/dev-client-candidates');
    mkdirReal(parent); mkdirReal(candidateParent);
    const staging = path.join(parent, `dist.atomic.predeploy-staging-${buildId.slice(0, 12)}-${process.pid}`);
    const candidate = path.join(candidateParent, `${event.sequence}-${generationId}`), scratch = path.join(candidateParent, `.scratch-${event.sequence}-${generationId}`);
    if (fs.existsSync(candidate)) {
        validateClientAssetManifest(candidate, { generationId, sourceOid, buildId }, publisher.verifyAssetClosure);
        return { candidate, buildId, generationId, sourceOid, sourceDigest };
    }
    assertClientPublicationCapacity(root);
    mkdirReal(staging); mkdirReal(scratch);
    const env = { NASSAJ_ATOMIC_CLIENT_BUILD: '1', NASSAJ_LOCAL_PREVIEW: '1', NASSAJ_BUILD_ID: buildId,
        NASSAJ_CLIENT_OUT_DIR: staging, NASSAJ_CLIENT_PREVIEW_ROOT: root, NASSAJ_CLIENT_GENERATION_ID: generationId };
    const vite = publisher.viteBuildInvocation(root);
    await runIsolatedClientBuild({ sourceRoot, dependenciesRoot: path.join(root, 'node_modules'), outputRoot: staging, scratchRoot: scratch,
        commands: [{ command: '/usr/bin/node', args: [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', path.join(sourceRoot, 'tsconfig.preview.json')] },
            { ...vite, env }] });
    if (assertClientPublicationSnapshot(root, sourceRoot, sourceOid) !== sourceDigest) throw new Error('client_snapshot_changed_during_build');
    const version = JSON.parse(readClientPublicationFile(path.join(sourceRoot, 'package.json'))).version;
    fs.writeFileSync(path.join(staging, 'BUILD_PROVENANCE.json'), `${JSON.stringify({ artifact: 'client', commit: sourceOid,
        baseCommit: sourceOid, commitShort: sourceOid.slice(0, 8), version, buildId, generationId, dirty: false, builtAt: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o444 });
    publisher.verifyBuildIdentity(staging, buildId);
    createClientAssetManifest(staging, { generationId, sourceOid, buildId }, publisher.verifyAssetClosure);
    await context.revalidate(options);
    fs.renameSync(staging, candidate); syncDirectory(candidateParent); syncDirectory(parent);
    // Only this operation's private scratch, after all namespace children terminated.
    fs.rmSync(scratch, { recursive: true });
    return { candidate, buildId, generationId, sourceOid, sourceDigest };
}

function makeIntent(options, built, previous, target, compatibility) {
    return { schema: CLIENT_PUBLICATION_JOURNAL_SCHEMA, kind: 'client-publication', transactionNonce: randomBytes(32).toString('hex'),
        sequence: options.event.sequence, sourceOid: built.sourceOid, policyRevision: options.policy.revision,
        reservationId: options.reservationId, baseReceiptDigest: options.baseline.baseReceiptDigest,
        parentServingReceiptDigest: options.parentServingReceiptDigest, serverIdentity: options.baseline.serverIdentity,
        dependencyIdentity: options.baseline.dependencyIdentity, previousClientIdentity: previous, targetClientIdentity: target,
        candidateManifestDigest: target.treeDigest, compatibilityProofDigest: compatibility.proofDigest, assetManifestDigest: target.assetManifestDigest };
}

/** Fetch uncached live HTML/version and bind HTTP response bytes to the selected sealed generation. */
export async function probeClientPublicationHttp(root, context = {}) {
    const origin = new URL(context.servingOrigin || 'http://127.0.0.1:3004');
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname) || origin.username || origin.password) throw new Error('client_publication_serving_origin_invalid');
    const files = [];
    for (const relative of ['index.html', 'version.json']) {
        const url = new URL(relative === 'index.html' ? '/' : '/version.json', origin);
        let response, bytes;
        try {
            response = await (context.fetchServing || fetch)(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
            bytes = Buffer.from(await response.arrayBuffer());
        } catch (cause) { throw new Error('client_publication_http_fetch_failed', { cause }); }
        if (response.status !== 200 || digest(bytes) !== digest(readClientPublicationFile(path.join(root, 'dist', relative)))) throw new Error('client_publication_http_serving_mismatch');
        files.push({ path: relative, status: response.status, sha256: digest(bytes) });
    }
    return { schema: 'nassaj-client-http-serving/v1', origin: origin.origin, files };
}

async function finishOutcome(options, context, journal, outcome, parentDigest) {
    const servingEvidence = outcome === 'cancelled' ? undefined : await probeClientPublicationHttp(options.root, context);
    return writeClientPublicationOutcome(options.root, journal, { outcome, actualServerIdentity: await context.readActualServerIdentity(options.root),
        parentServingReceiptDigest: parentDigest, servingEvidence });
}

async function restoreFailedServing(options, context, built, journal, parent) {
    const root = options.root, live = path.join(root, 'dist');
    const lineage = await context.readServingLineage(root);
    if (lineage.receiptDigest !== parent.receiptDigest || digest(servingIdentity(live)) !== digest(journal.targetClientIdentity)
        || digest(servingIdentity(built.candidate)) !== digest(journal.previousClientIdentity)) throw new Error('client_publication_rollback_cas_conflict');
    publisher.promoteWithExchange(built.candidate, live);
    syncDirectory(root); syncDirectory(path.dirname(built.candidate));
    return finishOutcome(options, context, journal, 'rolled_back', parent.receiptDigest);
}

async function publishPrepared(options, context, built, intent) {
    const root = options.root, live = path.join(root, 'dist');
    return context.withEventLock(root, async () => {
        await context.revalidate(options);
        const parent = await context.readServingLineage(root);
        if (parent.receiptDigest !== intent.parentServingReceiptDigest || digest(servingIdentity(live)) !== digest(intent.previousClientIdentity)) throw new Error('client_publication_serving_cas_conflict');
        let journal = writeClientPublicationIntent(root, intent);
        try {
            prepareClientPublicationAssets(root, live, { manifestDigest: intent.previousClientIdentity.assetManifestDigest });
            prepareClientPublicationAssets(root, built.candidate, { manifestDigest: intent.assetManifestDigest });
            await context.revalidate(options);
            await context.beforeEffect(journal);
        } catch (error) {
            await finishOutcome(options, context, journal, 'cancelled', parent.receiptDigest);
            throw Object.assign(error, { clientPublicationPreEffectCancelled: true });
        }
        journal = advanceClientPublicationJournal(root, journal, 'publishing');
        let terminal = null;
        try {
            publisher.promoteWithExchange(built.candidate, live);
            syncDirectory(root); syncDirectory(path.dirname(built.candidate));
            journal = advanceClientPublicationJournal(root, journal, 'verifying');
            try { terminal = await finishOutcome(options, context, journal, 'served', parent.receiptDigest); }
            catch (error) {
                if (!String(error.message).includes('http_')) throw error;
                terminal = await restoreFailedServing(options, context, built, journal, parent);
            }
            await context.recordServingLineage(root, terminal, { expectedParentReceiptDigest: parent.receiptDigest });
            return terminal;
        } catch (error) {
            if (!terminal && ['publishing', 'verifying'].includes(journal.state)) advanceClientPublicationJournal(root, journal, 'recovery_required');
            throw Object.assign(error, { clientPublicationRecoveryRequired: true, transactionNonce: intent.transactionNonce });
        }
    });
}

/** Build merged-main client input under isolation and publish using the installed authority and existing locks. */
export async function publishDevClient(options, context) {
    requiredContext(context);
    await context.revalidate(options);
    const previous = servingIdentity(path.join(options.root, 'dist'));
    const built = await buildCandidate(options, context), target = servingIdentity(built.candidate);
    const compatibility = proveClientCompatibility({ root: options.root, sourceOid: built.sourceOid, ...options.baseline,
        candidateManifestDigest: target.treeDigest, assetManifestDigest: target.assetManifestDigest });
    const intent = makeIntent(options, built, previous, target, compatibility);
    return publishPrepared(options, context, built, intent);
}

/** Reconcile an interrupted exchange by exact identities and lineage CAS, never by blindly exchanging again. */
export async function reconcileDevClientPublication(options, context) {
    requiredContext(context);
    return context.withEventLock(options.root, async () => {
        const checked = validateClientPublicationJournal(options.root, options.journal), value = options.journal.value ?? options.journal;
        const parent = await context.readServingLineage(options.root);
        if (checked.terminal) {
            if (checked.receipt.outcome === 'cancelled') return checked;
            if (parent.receiptDigest === checked.receiptDigest) return checked;
            if (parent.receiptDigest !== checked.intent.parentServingReceiptDigest) throw new Error('client_publication_recovery_lineage_conflict');
            await context.recordServingLineage(options.root, checked, { expectedParentReceiptDigest: parent.receiptDigest });
            return checked;
        }
        if (parent.receiptDigest !== checked.intent.parentServingReceiptDigest) throw new Error('client_publication_recovery_lineage_conflict');
        const actual = servingIdentity(path.join(options.root, 'dist'));
        const outcome = digest(actual) === digest(checked.intent.targetClientIdentity) ? 'served'
            : digest(actual) === digest(checked.intent.previousClientIdentity) ? 'rolled_back' : null;
        if (!outcome) throw new Error('client_publication_recovery_layout_unknown');
        let journal = value;
        if (journal.state === 'publishing') journal = advanceClientPublicationJournal(options.root, journal, 'verifying');
        if (journal.state === 'prepared') return finishOutcome(options, context, journal, 'cancelled', parent.receiptDigest);
        let result;
        try { result = await finishOutcome(options, context, journal, outcome, parent.receiptDigest); }
        catch (error) {
            if (outcome !== 'served' || !String(error.message).includes('http_')) throw error;
            const generationId = digest({ sourceOid: journal.sourceOid, buildId: journal.targetClientIdentity.buildId });
            const candidate = path.join(options.root, '.nassaj-local-preview/dev-client-candidates', `${journal.sequence}-${generationId}`);
            result = await restoreFailedServing(options, context, { candidate }, journal, parent);
        }
        await context.recordServingLineage(options.root, result, { expectedParentReceiptDigest: parent.receiptDigest });
        return result;
    });
}
