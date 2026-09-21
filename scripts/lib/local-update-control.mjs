/** ADR-160: request-driven preparation and durable consent; never activates runtime. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitControlPath } from '../git-control-root.mjs';
import { listPreviewEvents, previewEventRefs, withPreviewEventMutationLock } from '../local-preview-ledger.mjs';
import { assertNoNonterminalOidTransaction, listOidControlTransactions } from '../oid-control-journal.mjs';
import { validateOidTripleTargetDescriptor, computeOidTripleTargetDigest } from './oid-triple-target.mjs';
import { nextPreviewControlSequence } from './client-publication-control.mjs';
import { verifyOidDependencyCandidate } from './oid-dependency-candidate.mjs';
import { assertLocalUpdatePolicy, createLocalUpdatePolicyGrant, inspectLocalUpdatePolicyGrant } from './local-update-policy.mjs';

const HASH = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}$/;
const TERMINAL = new Set(['activated', 'cancelled', 'expired', 'superseded', 'failed', 'manual_recovery_required']);
const digest = value => createHash('sha256').update(value).digest('hex');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = code => { throw Object.assign(new Error(code), { code }); };

function controlPath(root, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail('local_update_invalid_sequence');
    return gitControlPath(root, `nassaj-preview-oid-event-control-${String(sequence).padStart(16, '0')}.json`);
}

function regularBytes(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        if (!fs.fstatSync(fd).isFile()) fail('local_update_unsafe_file');
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}

function readControl(root, sequence) {
    try { return JSON.parse(regularBytes(controlPath(root, sequence))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function durable(root, sequence, value) {
    const file = controlPath(root, sequence);
    if (fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })) regularBytes(file);
    const temporary = `${file}.tmp-${randomUUID()}`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function records(root) {
    return fs.readdirSync(path.dirname(gitControlPath(root, 'nassaj-preview-oid-consumer-v1.json')))
        .filter(name => /^nassaj-preview-oid-event-control-\d{16}\.json$/.test(name))
        .map(name => readControl(root, Number(name.match(/(\d{16})/)[1])))
        .filter(record => record?.localUpdate).sort((a, b) => a.sequence - b.sequence);
}

function validate(record) {
    const state = record?.localUpdate;
    if (!state || state.schema !== 'nassaj-local-update/v1' || state.mode !== 'local-main'
        || !Number.isSafeInteger(state.revision) || state.revision < 1
        || state.sequence !== record.sequence || state.oid !== record.oid || !OID.test(state.oid)
        || state.group !== `event-${String(state.sequence).padStart(16, '0')}`
        || JSON.stringify(state.domains) !== '["client","server"]') fail('local_update_invalid_control');
    return state;
}

/** Read the durable local event without exposing candidate filesystem paths. */
export function readLocalUpdate(root, sequence) {
    const record = sequence === undefined ? records(root).at(-1) : readControl(root, sequence);
    return record?.localUpdate ? validate(record) : null;
}

function releaseTerminalWaiter(record, state) {
    const waiter = record.fullUpdateWaiter;
    const reason = { cancelled: 'cancelled', superseded: 'superseded', failed: 'build_failed' }[state.phase];
    if (!waiter || !reason || state.activation || waiter.effect !== 'none' || waiter.phase === 'released') return record;
    return { ...record, fullUpdateWaiter: { ...waiter, revision: waiter.revision + 1, phase: 'released', reason } };
}

function requestInput(input) {
    if (input.mode !== 'local-main') fail('local_update_mode_required');
    if (!['string', 'number'].includes(typeof input.ownerId) || !String(input.ownerId).trim()) fail('local_update_owner_required');
}

function assertMain(root, oid) {
    if (!OID.test(oid || '') || git(root, 'rev-parse', '--verify', 'refs/heads/main^{commit}') !== oid) {
        fail('local_update_target_changed');
    }
}

function ensureRefs(root, state) {
    const refs = previewEventRefs(state.sequence, state.domains).refs;
    const present = listPreviewEvents(root).find(event => event.sequence === state.sequence);
    if (present) {
        if (present.oid !== state.oid || JSON.stringify(present.domains) !== JSON.stringify(state.domains)) fail('local_update_event_conflict');
        return;
    }
    execFileSync('git', ['update-ref', '--stdin'], { cwd: root,
        input: `start\n${refs.map(ref => `create ${ref} ${state.oid}`).join('\n')}\nprepare\ncommit\n`, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Create one owner-requested main event, or replay exactly the same idempotent request. */
export async function prepareLocalUpdate(root, input) {
    requestInput(input);
    if (typeof input.idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(input.idempotencyKey)) fail('local_update_invalid_idempotency_key');
    return withPreviewEventMutationLock(root, () => {
        let origin = null;
        if (input.origin !== undefined) {
            const policy = assertLocalUpdatePolicy(root, { revision: input.origin.policyRevision,
                receiptDigest: input.origin.receiptDigest, ownerId: Number(input.ownerId) });
            if (input.origin.kind !== 'policy') fail('local_update_policy_origin_invalid');
            origin = { kind: 'policy', policyRevision: policy.revision, receiptDigest: policy.receiptDigest };
        }
        // Request preparation only establishes priority; the consumer still waits for client effects to settle.
        const publishing = listOidControlTransactions(root).filter(entry => entry.value?.kind === 'client-publication'
            && !['served', 'rolled_back', 'cancelled'].includes(entry.value.state));
        assertNoNonterminalOidTransaction(root, publishing.length === 1 ? publishing[0].value.transactionNonce : null);
        const all = records(root);
        const keyHash = digest(input.idempotencyKey);
        const fingerprint = digest(JSON.stringify([String(input.ownerId), input.expectedOid, 'local-main', ...(origin ? [origin] : [])]));
        const replay = all.find(record => record.localUpdate.prepare.idempotencyKeyHash === keyHash);
        if (replay) {
            const state = validate(replay);
            if (state.prepare.requestFingerprint !== fingerprint) fail('local_update_idempotency_conflict');
            if (state.phase === 'preparing') { assertMain(root, state.oid); ensureRefs(root, state); }
            return state;
        }
        assertMain(root, input.expectedOid);
        if (all.some(record => !TERMINAL.has(validate(record).phase))) fail('local_update_in_progress');
        const sequence = nextPreviewControlSequence(root);
        const group = previewEventRefs(sequence, ['client', 'server']).group;
        const state = { schema: 'nassaj-local-update/v1', revision: 1, mode: 'local-main', sequence, group,
            oid: input.expectedOid, domains: ['client', 'server'],
            prepare: { ownerId: String(input.ownerId), requestedAt: input.now ?? Date.now(), idempotencyKeyHash: keyHash, requestFingerprint: fingerprint,
                ...(origin ? { origin } : {}) },
            phase: 'preparing', target: null, targetDigest: null, consent: null, activation: null, receipt: null };
        durable(root, sequence, { schema: 'nassaj-oid-control-event/v1', sequence, oid: state.oid, snapshotOid: state.oid, localUpdate: state, fullUpdateWaiter: { schema: 'nassaj-full-update-waiter/v1', sequence,
            requestId: `local-update:${sequence}`, ownerId: String(input.ownerId), revision: 1, phase: 'waiting', effect: 'none', reason: 'full_update_priority' } });
        ensureRefs(root, state);
        return state;
    });
}

function withCandidateDirectory(root, domain, buildId, operation) {
    if (!['client', 'server'].includes(domain)) fail('local_update_invalid_domain');
    const descriptors = [];
    let directory = root;
    try {
        for (const part of ['', '.nassaj-local-preview', `${domain}-candidates`, buildId]) {
            const fd = fs.openSync(path.join(directory, part), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            descriptors.push(fd);
            directory = `/proc/self/fd/${fd}`;
        }
        return operation(directory);
    } finally { for (const fd of descriptors.reverse()) fs.closeSync(fd); }
}

function treeEntries(directory, prefix = '') {
    const entries = [];
    for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name), relative = `${prefix}${name}`;
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const stat = fs.fstatSync(fd);
            if (stat.isDirectory()) entries.push(...treeEntries(`/proc/self/fd/${fd}`, `${relative}/`));
            else if (stat.isFile()) entries.push([relative, digest(fs.readFileSync(fd))]);
            else fail('local_update_unsafe_candidate');
        } finally { fs.closeSync(fd); }
    }
    return entries;
}

/** Verify pinned regular candidate files and exact same-OID provenance without changing them. */
export function verifyLocalCandidate(root, state, domain, buildId) {
    if (!HASH.test(buildId || '')) fail('local_update_invalid_build_id');
    return withCandidateDirectory(root, domain, buildId, directory => {
        const provenance = JSON.parse(regularBytes(path.join(directory, 'BUILD_PROVENANCE.json')));
        if (provenance.artifact !== domain || provenance.commit !== state.oid || provenance.baseCommit !== state.oid
            || provenance.dirty !== false || provenance.buildId !== buildId) fail('local_update_candidate_identity_mismatch');
        return { treeSha256: digest(JSON.stringify(treeEntries(directory))), controlManifestSha256: domain === 'server'
            ? digest(regularBytes(path.join(directory, 'OID_CONTROL_MANIFEST.json'))) : null };
    });
}

function targetDigest(state, target) {
    if (target.schema === 'nassaj-oid-triple-target/v2') return computeOidTripleTargetDigest({
        sequence: state.sequence, group: state.group, sourceOid: state.oid, target });
    return digest(JSON.stringify({ sequence: state.sequence, group: state.group, oid: state.oid, domains: state.domains, target }));
}

function inspectTarget(root, state, target) {
    const client = verifyLocalCandidate(root, state, 'client', target.clientBuildId);
    const server = verifyLocalCandidate(root, state, 'server', target.serverBuildId);
    const pair = { clientBuildId: target.clientBuildId, serverBuildId: target.serverBuildId,
        clientTreeSha256: client.treeSha256, serverTreeSha256: server.treeSha256,
        controlManifestSha256: server.controlManifestSha256 };
    if (target.schema !== undefined) {
        validateOidTripleTargetDescriptor(target);
        verifyOidDependencyCandidate(root, target);
        for (const [key, value] of Object.entries(pair)) if (target[key] !== value) fail('local_update_candidate_changed');
        return { ...target, ...pair };
    }
    if (Object.keys(target).some(key => !Object.hasOwn(pair, key))) fail('local_update_invalid_triple_target');
    return pair;
}

/** Seal the prepared pair under the event lock; this does not authorize activation. */
export async function completeLocalUpdatePreparation(root, sequence, target) {
    return withPreviewEventMutationLock(root, () => {
        const record = readControl(root, sequence), state = validate(record);
        assertMain(root, state.oid);
        if (state.phase !== 'preparing') fail('local_update_not_preparing');
        const inspected = inspectTarget(root, state, target);
        const next = { ...state, revision: state.revision + 1, phase: 'prepared', target: inspected, targetDigest: targetDigest(state, inspected) };
        durable(root, sequence, { ...record, buildId: inspected.serverBuildId,
            controlManifestSha256: inspected.controlManifestSha256, localUpdate: next });
        return next;
    });
}

function revalidate(root, state) {
    assertMain(root, state.oid);
    const target = inspectTarget(root, state, state.target);
    if (targetDigest(state, target) !== state.targetDigest) fail('local_update_candidate_changed');
}

/** CAS-persist 24-hour consent for a sealed pair; no command or runtime effect is created. */
export async function confirmLocalUpdate(root, input) {
    requestInput(input);
    return withPreviewEventMutationLock(root, () => {
        const record = readControl(root, input.sequence), state = validate(record), now = input.now ?? Date.now();
        if (state.prepare.origin?.kind === 'policy' || state.policyAuthorization) fail('local_update_policy_manual_conflict');
        if (state.targetDigest !== input.targetDigest || !HASH.test(input.targetDigest || '')) fail('local_update_target_changed');
        if (!['prepared', 'awaiting_sessions'].includes(state.phase)) fail('local_update_not_prepared');
        revalidate(root, state);
        if (state.consent?.ownerId === String(input.ownerId) && state.consent.expiresAt > now
            && state.consent.expectedRevision === input.expectedRevision) return state;
        if (state.revision !== input.expectedRevision) fail('local_update_revision_conflict');
        const next = { ...state, revision: state.revision + 1, phase: 'awaiting_sessions',
            consent: { ownerId: String(input.ownerId), expectedRevision: input.expectedRevision, confirmedAt: now, expiresAt: now + 86_400_000, targetDigest: state.targetDigest } };
        durable(root, input.sequence, { ...releaseTerminalWaiter(record, next), localUpdate: next });
        return next;
    });
}

/** Authorize a sealed automatic target under policy, never through the manual consent operation. */
export async function authorizeLocalUpdateByPolicy(root, input) {
    return withPreviewEventMutationLock(root, () => {
        const record = readControl(root, input.sequence), state = validate(record), now = input.now ?? Date.now();
        if (!['prepared', 'awaiting_sessions'].includes(state.phase) || state.activation) fail('local_update_not_prepared');
        if (state.revision !== input.expectedRevision) fail('local_update_revision_conflict');
        revalidate(root, state);
        if (state.policyAuthorization?.expiresAt > now) {
            inspectLocalUpdatePolicyGrant(root, state, now);
            return state;
        }
        const policyAuthorization = createLocalUpdatePolicyGrant(root, state, input.capability, now);
        const entry = { schema: 'nassaj-local-update-policy-grant-receipt/v1',
            kind: state.policyAuthorization ? 'renewed' : 'issued', at: now,
            previousGrantDigest: state.policyAuthorization?.grantDigest ?? null, grant: policyAuthorization };
        const policyGrantReceipts = [...(state.policyGrantReceipts || []), entry];
        const next = { ...state, revision: state.revision + 1, phase: 'awaiting_sessions', policyAuthorization, policyGrantReceipts };
        durable(root, input.sequence, { ...record, localUpdate: next });
        return next;
    });
}

/** Withdraw obsolete policy preparation before an activation claim; in-flight recovery keeps its authority. */
export async function retireChangedLocalPolicy(root, sequence) {
    return withPreviewEventMutationLock(root, () => {
        const record = readControl(root, sequence), state = validate(record);
        if (state.prepare.origin?.kind !== 'policy' || state.activation
            || !['preparing', 'prepared', 'awaiting_sessions'].includes(state.phase)) return state;
        try {
            assertLocalUpdatePolicy(root, { revision: state.prepare.origin.policyRevision,
                receiptDigest: state.prepare.origin.receiptDigest, ownerId: Number(state.prepare.ownerId) });
            return state;
        } catch (error) {
            if (!['local_update_policy_disabled', 'local_update_policy_changed', 'local_update_policy_client_conflict'].includes(error.code)) throw error;
            const next = { ...state, revision: state.revision + 1, phase: 'superseded',
                policyAuthorization: null, consent: null, policyRetirementReason: error.code };
            durable(root, sequence, { ...releaseTerminalWaiter(record, next), localUpdate: next });
            return next;
        }
    });
}

/** Cancel only before an activation claim, with revision fencing. */
export async function cancelLocalUpdate(root, input) {
    requestInput(input);
    return withPreviewEventMutationLock(root, () => {
        const record = readControl(root, input.sequence), state = validate(record);
        if (state.prepare.ownerId !== String(input.ownerId)) fail('local_update_owner_mismatch');
        if (state.phase === 'cancelled') return state;
        if (state.revision !== input.expectedRevision) fail('local_update_revision_conflict');
        if (!['preparing', 'prepared', 'awaiting_sessions'].includes(state.phase) || state.activation) fail('local_update_cannot_cancel');
        const next = { ...state, revision: state.revision + 1, phase: 'cancelled', consent: null,
            ...(state.policyAuthorization ? { policyAuthorization: null } : {}) };
        durable(root, input.sequence, { ...releaseTerminalWaiter(record, next), localUpdate: next });
        return next;
    });
}

/** Read local main and loaded pair identity; dirty files are intentionally not included. */
export function readLocalMainTarget(root, runtime = null) {
    const oid = git(root, 'rev-parse', '--verify', 'refs/heads/main^{commit}');
    if (!OID.test(oid)) fail('local_update_target_unavailable');
    let client = null, server = null;
    try { client = JSON.parse(regularBytes(path.join(root, 'dist', 'BUILD_PROVENANCE.json'))); } catch {}
    try { server = JSON.parse(regularBytes(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'))); } catch {}
    return { oid, available: client?.commit !== oid || server?.commit !== oid
            || runtime?.serverLoadedOid !== oid || runtime?.serverLoadedBuildId !== server?.buildId
            || runtime?.clientBuildIdServed !== client?.buildId,
        identitySource: 'disk', runtimeVerified: Boolean(HASH.test(server?.buildId || '') && HASH.test(client?.buildId || '') && runtime?.serverLoadedOid === oid
            && runtime?.serverLoadedBuildId === server?.buildId && runtime?.clientBuildIdServed === client?.buildId),
        clientBuildId: HASH.test(client?.buildId || '') ? client.buildId : null,
        serverBuildId: HASH.test(server?.buildId || '') ? server.buildId : null };
}

/** Retire an unactivated preparation when main changes, preserving all evidence. */
export async function retireChangedLocalPreparation(root, sequence) {
    return withPreviewEventMutationLock(root, () => {
        const record = readControl(root, sequence), state = validate(record);
        if (state.activation || !['preparing', 'prepared', 'awaiting_sessions'].includes(state.phase)) return state;
        if (git(root, 'rev-parse', '--verify', 'refs/heads/main^{commit}') === state.oid) return state;
        const next = { ...state, revision: state.revision + 1, phase: 'superseded', consent: null,
            ...(state.policyAuthorization ? { policyAuthorization: null } : {}) };
        durable(root, sequence, { ...releaseTerminalWaiter(record, next), localUpdate: next });
        return next;
    });
}

/** Persist bounded preparation failures; resource deferral never counts as successful work. */
export async function recordLocalPreparationFailure(root, sequence, error) {
    return withPreviewEventMutationLock(root, () => {
        const record = readControl(root, sequence), state = validate(record);
        if (state.phase !== 'preparing') return state;
        const deferred = ['resource_ceiling', 'insufficient_disk', 'update_lock_contended',
            'local_update_resources_busy', 'local_update_build_recovery_required', 'local_update_build_capacity_wait',
            'local_update_build_capacity_unknown', 'local_update_build_profile_required', 'local_update_build_inputs_unqualified',
            'local_update_build_cache_missing', 'local_update_build_headers_missing'].includes(error?.code);
        const attempts = (state.preparationFailure?.attempts || 0) + (deferred ? 0 : 1);
        const code = deferred ? error.code : 'local_update_preparation_failed';
        const next = { ...state, revision: state.revision + 1, phase: attempts >= 3 ? 'failed' : 'preparing',
            preparationFailure: { code, attempts, retryable: attempts < 3, deferred, at: Date.now() } };
        durable(root, sequence, { ...releaseTerminalWaiter(record, next), localUpdate: next });
        return next;
    });
}
