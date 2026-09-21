/** Publication reservations extend the existing event store; no scheduler or expiry lease. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitControlPath } from '../git-control-root.mjs';
import { listPreviewEvents, withPreviewEventMutationLock } from '../local-preview-ledger.mjs';
import { assertNoNonterminalOidTransaction } from '../oid-control-journal.mjs';
import { clientPublicationDigest } from './client-publication-artifacts.mjs';
import { validateClientPublicationJournal } from './client-publication-journal.mjs';
import { assertClientPublicationPolicy } from './client-publication-policy.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const TERMINAL = new Set(['served', 'cancelled', 'superseded', 'build_failed', 'rolled_back']);
const PHASES = new Set(['reserved', 'building', 'prepared', 'publishing', 'verifying', 'served', 'waiting', 'recovery_required', 'cancelled', 'superseded', 'build_failed', 'rolled_back']);

function eventFile(root, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail('client_publication_sequence_invalid');
    return gitControlPath(root, `nassaj-preview-oid-event-control-${String(sequence).padStart(16, '0')}.json`);
}
function read(file) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail('client_publication_event_unsafe');
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function durable(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function all(root) {
    const directory = path.dirname(eventFile(root, 1));
    return fs.readdirSync(directory).filter(name => /^nassaj-preview-oid-event-control-\d{16}\.json$/.test(name))
        .map(name => read(path.join(directory, name)));
}
function validate(record) {
    const state = record?.clientPublication;
    if (!state) return null;
    if (record.schema !== 'nassaj-oid-control-event/v1' || state.schema !== 'nassaj-dev-client-publication/v1'
        || state.sequence !== record.sequence || state.sourceOid !== record.oid || !/^[a-f0-9]{40}$/.test(state.sourceOid || '')
        || !Number.isSafeInteger(state.revision) || state.revision < 1 || !PHASES.has(state.phase)
        || typeof state.reservationId !== 'string' || state.requestId !== state.reservationId
        || !['none', 'started', 'unknown', 'settled'].includes(state.effect)) fail('client_publication_event_invalid');
    return state;
}

/** Read all durable blockers, never treating age or process death as completion. */
export function readClientPublicationBlockers(root) {
    const records = all(root);
    const publications = records.map(validate).filter(state => state && (!TERMINAL.has(state.phase) || !['none', 'settled'].includes(state.effect)));
    const fullUpdates = records.filter(record => {
        const waiter = record.fullUpdateWaiter;
        if (waiter && (waiter.schema !== 'nassaj-full-update-waiter/v1' || !Number.isSafeInteger(waiter.revision)
            || !['waiting', 'effects_started', 'released'].includes(waiter.phase))) fail('full_update_waiter_invalid');
        return waiter && waiter.phase !== 'released';
    }).map(record => record.fullUpdateWaiter);
    return { publications, fullUpdates };
}

/** Read one publication independently of the update button's candidate and consent. */
export function readClientPublication(root, sequence) { return validate(read(eventFile(root, sequence))); }

/** Reserve a merged-main event only after checking the loaded policy and durable full waiters. */
export async function reserveClientPublication(root, event, binding) {
    return withPreviewEventMutationLock(root, () => {
        const policy = assertClientPublicationPolicy(root, binding);
        const file = eventFile(root, event.sequence), record = read(file);
        const current = validate(record);
        if (current) return current;
        const blockers = readClientPublicationBlockers(root);
        if (blockers.fullUpdates.length) fail('client_publication_full_update_waiting');
        if (blockers.publications.length) fail('client_publication_reservation_busy');
        assertNoNonterminalOidTransaction(root);
        if (record?.localUpdate) fail('client_publication_button_event_owned');
        const main = execFileSync('git', ['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: root, encoding: 'utf8' }).trim();
        if (main !== event.oid || !/^[a-f0-9]{40}$/.test(event.oid || '')) fail('client_publication_main_changed');
        if (record && (record.schema !== 'nassaj-oid-control-event/v1' || record.oid !== event.oid)) fail('client_publication_event_conflict');
        const reservationId = randomUUID();
        const state = { schema: 'nassaj-dev-client-publication/v1', reservationId, requestId: reservationId,
            sequence: event.sequence, revision: 1, sourceOid: event.oid, policyRevision: policy.revision,
            baseReceiptDigest: binding.baseReceiptDigest, parentServingReceiptDigest: binding.parentServingReceiptDigest ?? binding.baseReceiptDigest,
            candidateManifestDigest: null, compatibilityProofDigest: null, phase: 'reserved', effect: 'none', reason: null };
        durable(file, { ...record, schema: 'nassaj-oid-control-event/v1', sequence: event.sequence, oid: event.oid, clientPublication: state });
        return state;
    });
}

/** CAS transition; a caller cannot clear an unknown or started effect with a pre-effect terminal reason. */
export async function transitionClientPublication(root, expected, patch) {
    return withPreviewEventMutationLock(root, () => transitionClientPublicationUnlocked(root, expected, patch));
}

/** Same CAS for the installed executor already holding event EX; never acquire an outer lock here. */
export function transitionClientPublicationUnlocked(root, expected, patch) {
        const file = eventFile(root, expected.sequence), record = read(file), current = validate(record);
        if (!current || current.requestId !== expected.requestId || current.revision !== expected.revision) fail('client_publication_revision_conflict');
        if (Object.keys(patch).some(key => !['phase', 'effect', 'reason', 'candidateManifestDigest', 'compatibilityProofDigest', 'receiptDigest'].includes(key))) fail('client_publication_patch_invalid');
        if (['cancelled', 'superseded', 'build_failed'].includes(patch.phase) && current.effect !== 'none' && !(patch.phase === 'cancelled' && patch.effect === 'settled' && patch.receiptDigest)) fail('client_publication_recovery_required');
        if (['started', 'unknown'].includes(current.effect) && patch.effect === 'none') fail('client_publication_recovery_required');
        if (['served', 'rolled_back'].includes(patch.phase) && (!/^[a-f0-9]{64}$/.test(patch.receiptDigest || '') || patch.effect !== 'settled')) fail('client_publication_receipt_required');
        if (['served', 'rolled_back'].includes(patch.phase) || patch.phase === 'cancelled' && patch.effect === 'settled') {
            const directory = path.dirname(file);
            const journals = fs.readdirSync(directory).filter(name => name.startsWith(`nassaj-oid-control-transaction-${current.sequence}-`) && name.endsWith('.json'));
            const matching = journals.map(name => ({ file: path.join(directory, name), value: read(path.join(directory, name)) }))
                .filter(entry => entry.value?.kind === 'client-publication' && entry.value.reservationId === current.reservationId);
            if (matching.length !== 1) fail('client_publication_receipt_required');
            const checked = validateClientPublicationJournal(root, matching[0]);
            if (!checked.terminal || checked.receiptDigest !== patch.receiptDigest || checked.receipt.outcome !== patch.phase) fail('client_publication_receipt_required');
        }
        const state = { ...current, ...patch, revision: current.revision + 1 };
        validate({ ...record, clientPublication: state });
        durable(file, { ...record, clientPublication: state });
        return state;
}

/** Persist full priority under event EX before any caller waits for admission/build locks. */
export async function reserveFullUpdateWaiter(root, { sequence = null, requestId, ownerId, sourceOid }) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9:._-]{1,200}$/.test(requestId) || !/^[a-f0-9]{40}$/.test(sourceOid || '')) fail('full_update_waiter_identity');
    return withPreviewEventMutationLock(root, () => {
        if (sequence === null) {
            const records = all(root);
            const replay = records.find(item => item.fullUpdateWaiter?.requestId === requestId);
            sequence = replay?.sequence ?? Math.max(0, ...records.map(item => item.sequence), ...listPreviewEvents(root).map(item => item.sequence)) + 1;
        }
        const file = eventFile(root, sequence), record = read(file);
        if (record && (record.schema !== 'nassaj-oid-control-event/v1' || record.oid !== sourceOid)) fail('full_update_waiter_event_conflict');
        const previous = record?.fullUpdateWaiter;
        if (previous && previous.phase !== 'released') {
            if (previous.requestId !== requestId) fail('full_update_waiter_conflict');
            return previous;
        }
        const waiter = { schema: 'nassaj-full-update-waiter/v1', sequence, requestId, ownerId: String(ownerId),
            revision: (previous?.revision || 0) + 1, phase: 'waiting', effect: 'none', reason: 'full_update_priority' };
        durable(file, { ...record, schema: 'nassaj-oid-control-event/v1', sequence, oid: sourceOid, fullUpdateWaiter: waiter });
        return waiter;
    });
}

/** Release only an exact waiter with proven pre-effect termination or a durable completed transaction. */
export async function releaseFullUpdateWaiter(root, expected, proof) {
    return withPreviewEventMutationLock(root, () => {
        const file = eventFile(root, expected.sequence), record = read(file), current = record?.fullUpdateWaiter;
        if (!current || current.requestId !== expected.requestId || current.revision !== expected.revision) fail('full_update_waiter_revision_conflict');
        const local = record.localUpdate ?? record.releaseUpdate;
        const terminal = { cancelled: 'cancelled', superseded: 'superseded', failed: 'build_failed' }[local?.phase];
        if (current.effect !== 'none' || !terminal || local.activation || proof?.reason !== terminal) fail('full_update_waiter_recovery_required');
        const next = { ...current, revision: current.revision + 1, phase: 'released', reason: terminal };
        durable(file, { ...record, fullUpdateWaiter: next });
        return next;
    });
}

/** Persist a release-preparation failure only while its durable waiter proves no activation effect. */
export async function failReleaseUpdateWaiter(root, expected) {
    return withPreviewEventMutationLock(root, () => {
        const file = eventFile(root, expected.sequence), record = read(file), current = record?.fullUpdateWaiter;
        if (!current || current.requestId !== expected.requestId || current.revision !== expected.revision) fail('full_update_waiter_revision_conflict');
        if (current.effect !== 'none' || current.phase !== 'waiting') fail('full_update_waiter_recovery_required');
        const waiter = { ...current, phase: 'released', revision: current.revision + 1, reason: 'build_failed' };
        durable(file, { ...record, releaseUpdate: { phase: 'failed', activation: null }, fullUpdateWaiter: waiter });
        return waiter;
    });
}

/** Settle a release waiter from the exact durable runtime-verifying receipt after the gate reopens. */
export async function settleReleaseUpdateWaiter(root, { jobId, transactionId, receiptFile }) {
    return withPreviewEventMutationLock(root, () => {
        const record = all(root).find(item => item.fullUpdateWaiter?.requestId === `release-update:${jobId}`);
        if (!record || record.fullUpdateWaiter.phase === 'released') return null;
        const receiptRoot = path.join(path.dirname(eventFile(root, record.sequence)), 'nassaj-source-update/job-receipts');
        if (path.dirname(receiptFile) !== receiptRoot || !path.basename(receiptFile).startsWith(`${jobId}.`)) fail('full_update_receipt_path');
        const receipt = read(receiptFile), maintenance = read(path.join(path.dirname(receiptRoot), 'journal.json'));
        const { checksum, ...maintenancePayload } = maintenance ?? {};
        if (maintenance?.schema !== 'nassaj-source-update-maintenance/v1' || clientPublicationDigest(maintenancePayload) !== checksum) fail('full_update_maintenance_invalid');
        if (receipt?.schemaVersion !== 2 || receipt.jobId !== jobId || receipt.phase !== 'runtime_verifying'
            || !['done', 'recovery'].includes(receipt.kind) || typeof receipt.factsJson !== 'string'
            || createHash('sha256').update(receipt.factsJson).digest('hex') !== receipt.factsSha256
            || maintenance?.transactionId !== transactionId || maintenance.state !== 'OPEN' || maintenance.phase !== 'ACTIVE_VERIFIED'
            || maintenance.identity?.targetCommit !== record.oid
            || JSON.stringify(JSON.parse(receipt.factsJson).runtimeIdentities) !== JSON.stringify(maintenance.runtimeIdentities)) fail('full_update_receipt_invalid');
        const waiter = { ...record.fullUpdateWaiter, revision: record.fullUpdateWaiter.revision + 1,
            phase: 'released', effect: 'settled', reason: 'served', receiptDigest: createHash('sha256').update(fs.readFileSync(receiptFile)).digest('hex') };
        durable(eventFile(root, record.sequence), { ...record, fullUpdateWaiter: waiter });
        return waiter;
    });
}

/** Reconcile the crash window after full serving proof but before waiter settlement, using existing receipts. */
export async function reconcileReleaseUpdateWaiters(root) {
    const pending = all(root).filter(record => record.fullUpdateWaiter?.phase !== 'released'
        && record.fullUpdateWaiter?.requestId?.startsWith('release-update:'));
    if (!pending.length) return;
    const directory = path.join(path.dirname(eventFile(root, 1)), 'nassaj-source-update');
    const maintenance = read(path.join(directory, 'journal.json'));
    if (maintenance?.state !== 'OPEN' || maintenance.phase !== 'ACTIVE_VERIFIED') return;
    const receiptRoot = path.join(directory, 'job-receipts');
    if (!fs.existsSync(receiptRoot)) return;
    for (const record of pending) {
        if (record.oid !== maintenance.identity?.targetCommit) continue;
        const jobId = record.fullUpdateWaiter.requestId.slice('release-update:'.length);
        const files = fs.readdirSync(receiptRoot).filter(name => name.startsWith(`${jobId}.`) && name.endsWith('.json')).sort().reverse();
        for (const name of files) {
            const receiptFile = path.join(receiptRoot, name), receipt = read(receiptFile);
            if (receipt?.phase !== 'runtime_verifying' || !['done', 'recovery'].includes(receipt.kind)) continue;
            await settleReleaseUpdateWaiter(root, { jobId, transactionId: maintenance.transactionId, receiptFile });
            break;
        }
    }
}

/** Allocate across every extension writer, including release waiters without preview refs; caller holds event EX. */
export function nextPreviewControlSequence(root) {
    return Math.max(0, ...all(root).map(record => record.sequence), ...listPreviewEvents(root).map(event => event.sequence)) + 1;
}
