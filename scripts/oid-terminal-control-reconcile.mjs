/** Settle stale owner-control remnants after an exactly proven OID rollback. */
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { listOidControlTransactions, OID_TERMINAL_STATES } from './oid-control-journal.mjs';
import { applyPreviewLedgerEvent } from './local-preview-ledger.mjs';
import { commonGitDir, gitControlPath } from './git-control-root.mjs';

const BUILD = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LEGACY_V1 = Object.freeze({ sequence: 29, oid: '878b86c2aeb400b82252ca84f132f02a8bbc3fe9',
    buildId: 'cc017f06f0c45c82ed8ff28dd26136f87b8ecaffd54cf7921f32cafe4cba01b0',
    previousBuildId: 'c5da8098aa7bea2aa5f71ec78f569ba19c5d5d0e53296871f4a00147c47cabae' });
const realFs = Object.freeze({ closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync });

function readRegularJson(file) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('oid_terminal_control_unsafe_file');
    return JSON.parse(readFileSync(file, 'utf8'));
}

function durableJson(file, value, exclusive = false) {
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    let fd;
    try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        if (exclusive) {
            linkSync(temporary, file);
            unlinkSync(temporary);
        } else renameSync(temporary, file);
        const directory = openSync(path.dirname(file), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}

function unlinkDurable(file) {
    if (!existsSync(file)) return;
    unlinkSync(file);
    const directory = openSync(path.dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
}

function paths(root, sequence, nonce) {
    const git = commonGitDir(root);
    const pad = String(sequence).padStart(16, '0');
    return {
        git,
        request: gitControlPath(root, 'nassaj-preview-oid-control-request-v1.json'),
        event: gitControlPath(root, `nassaj-preview-oid-event-control-${pad}.json`),
        consumer: gitControlPath(root, 'nassaj-preview-oid-consumer-v1.json'),
        receipt: gitControlPath(root, `nassaj-oid-terminal-control-${sequence}-${nonce}.json`),
        lock: gitControlPath(root, 'nassaj-preview-event-mutation.lock'),
    };
}

function stableControlSnapshot(fs, file) {
    if (!fs.existsSync(file)) return { present: false };
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('oid_terminal_control_unsafe_file');
    const bytes = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs) throw new Error('legacy_control_changed');
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('legacy_control_changed'); }
    return { present: true, dev: String(before.dev), ino: String(before.ino), size: before.size,
        mode: before.mode, mtimeMs: before.mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex'), value };
}

function snapshotControls(root, facts, fs = realFs) {
    const files = paths(root, facts.sequence, facts.nonce);
    return { request: stableControlSnapshot(fs, files.request), event: stableControlSnapshot(fs, files.event),
        consumer: stableControlSnapshot(fs, files.consumer), receipt: stableControlSnapshot(fs, files.receipt) };
}

function sameSnapshot(left, right) {
    return ['request', 'event', 'consumer', 'receipt'].every((key) => {
        const a = left?.[key]; const b = right?.[key];
        return a?.present === b?.present && (!a?.present || (a.dev === b.dev && a.ino === b.ino
            && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.sha256 === b.sha256));
    });
}

function exactTransaction(root, facts) {
    const transactions = listOidControlTransactions(root);
    if (transactions.some(({ value }) => !OID_TERMINAL_STATES.has(value?.state))) return null;
    const matched = transactions.filter(({ value }) => value?.state === 'rolled_back'
        && value.sequence === facts.sequence && value.oid === facts.oid && value.buildId === facts.buildId
        && value.previousBuildId === facts.previousBuildId && value.transactionNonce === facts.nonce);
    return matched.length === 1 ? matched[0].value : null;
}

function matchingRequest(value, facts) {
    return value?.schemaVersion === 1 && value.action === 'promote-and-safe-restart'
        && value.sequence === facts.sequence && value.oid === facts.oid && value.buildId === facts.buildId
        && value.snapshotOid === facts.oid && value.group === `event-${String(facts.sequence).padStart(16, '0')}`
        && BUILD.test(value.controlManifestSha256 || '');
}

function matchingEvent(value, facts, request) {
    return value?.schema === 'nassaj-oid-control-event/v1' && value.sequence === facts.sequence
        && value.oid === facts.oid && value.buildId === facts.buildId && value.snapshotOid === facts.oid
        && value.controlManifestSha256 === request.controlManifestSha256;
}

function matchingConsumer(value, facts, request, terminal = false) {
    const phase = value?.server?.phase;
    return value?.schemaVersion === 1 && value.acceptedSequence === facts.sequence && value.acceptedOid === facts.oid
        && value.server?.sequence === facts.sequence
        && value.server?.oid === facts.oid && value.server?.buildId === facts.buildId
        && value.server?.controlManifestSha256 === request.controlManifestSha256
        && (terminal ? phase === 'rolled_back' : phase === 'awaiting_owner');
}

function controlsBindNonce(request, event, consumer, facts) {
    const values = [request?.transactionNonce, event?.transactionNonce, consumer?.server?.transactionNonce];
    if (values.every((value) => value === facts.nonce)) return true;
    const legacy = facts.sequence === LEGACY_V1.sequence && facts.oid === LEGACY_V1.oid
        && facts.buildId === LEGACY_V1.buildId && facts.previousBuildId === LEGACY_V1.previousBuildId;
    return legacy && values.every((value) => value == null);
}

function isLegacyV1Facts(facts) {
    return facts.sequence === LEGACY_V1.sequence && facts.oid === LEGACY_V1.oid
        && facts.buildId === LEGACY_V1.buildId && facts.previousBuildId === LEGACY_V1.previousBuildId;
}

function receiptMatches(value, facts) {
    return value?.schema === 'nassaj-oid-terminal-control/v1' && value.version === 1 && value.sequence === facts.sequence
        && value.oid === facts.oid && value.buildId === facts.buildId
        && value.previousBuildId === facts.previousBuildId && value.transactionNonce === facts.nonce
        && BUILD.test(value.controlManifestSha256 || '') && SHA256.test(value.requestSha256 || '')
        && SHA256.test(value.eventSha256 || '') && SHA256.test(value.consumerSha256 || '')
        && (value.reason === (isLegacyV1Facts(facts) ? 'legacy_v1_terminal_reconciliation' : 'terminal_reconciliation'))
        && ['receipt_created', 'consumer_terminal', 'controls_clear_started', 'controls_cleared'].includes(value.state)
        && (value.state === 'receipt_created' || SHA256.test(value.consumerTerminalSha256 || ''));
}

function verifyReceiptStage(receipt, facts, request, event, consumer) {
    if (!receiptMatches(receipt, facts)) return false;
    if (receipt.state === 'receipt_created') {
        return receipt.requestSha256 === sha256(request) && receipt.eventSha256 === sha256(event)
            && receipt.consumerSha256 === sha256(consumer);
    }
    if (!matchingConsumer(consumer, facts, { controlManifestSha256: receipt.controlManifestSha256 }, true)
        || receipt.consumerTerminalSha256 !== sha256(consumer)) return false;
    if (receipt.state === 'consumer_terminal') {
        return receipt.requestSha256 === sha256(request) && receipt.eventSha256 === sha256(event);
    }
    if (receipt.state === 'controls_clear_started') {
        return (request == null || receipt.requestSha256 === sha256(request))
            && (event == null || receipt.eventSha256 === sha256(event));
    }
    return request == null && event == null;
}

function settleLocked(root, facts, initialSnapshot = null, fs = realFs) {
    if (!Number.isSafeInteger(facts.sequence) || facts.sequence < 1 || !OID.test(facts.oid || '')
        || !BUILD.test(facts.buildId || '') || !BUILD.test(facts.previousBuildId || '') || !BUILD.test(facts.nonce || '')) {
        return { settled: false, code: 'oid_terminal_control_invalid_facts' };
    }
    let freshSnapshot;
    try { freshSnapshot = snapshotControls(root, facts, fs); } catch (error) {
        return { settled: false, code: error.message === 'legacy_control_changed' ? 'legacy_control_changed' : 'oid_terminal_control_snapshot_invalid' };
    }
    if (initialSnapshot && !sameSnapshot(initialSnapshot, freshSnapshot)) return { settled: false, code: 'legacy_control_changed' };
    const transaction = exactTransaction(root, facts);
    if (!transaction) return { settled: false, code: 'oid_terminal_control_unproven' };
    const files = paths(root, facts.sequence, facts.nonce);
    let receipt = freshSnapshot.receipt.present ? freshSnapshot.receipt.value : null;
    if (receipt && !receiptMatches(receipt, facts)) return { settled: false, code: 'oid_terminal_control_receipt_mismatch' };
    const request = freshSnapshot.request.present ? freshSnapshot.request.value : null;
    const event = freshSnapshot.event.present ? freshSnapshot.event.value : null;
    const consumer = freshSnapshot.consumer.present ? freshSnapshot.consumer.value : null;

    if (!receipt) {
        if (!matchingRequest(request, facts) || !matchingEvent(event, facts, request)
            || !matchingConsumer(consumer, facts, request) || !controlsBindNonce(request, event, consumer, facts)) return { settled: false, code: 'oid_terminal_control_remnant_mismatch' };
        receipt = { schema: 'nassaj-oid-terminal-control/v1', version: 1, state: 'receipt_created',
            sequence: facts.sequence, oid: facts.oid, buildId: facts.buildId, previousBuildId: facts.previousBuildId,
            transactionNonce: facts.nonce, controlManifestSha256: request.controlManifestSha256,
            requestSha256: sha256(request), eventSha256: sha256(event), consumerSha256: sha256(consumer),
            reason: isLegacyV1Facts(facts) && request.transactionNonce == null
                ? 'legacy_v1_terminal_reconciliation' : 'terminal_reconciliation',
            createdAt: new Date().toISOString() };
        durableJson(files.receipt, receipt, true);
    }
    const receiptRequest = { ...request, controlManifestSha256: receipt.controlManifestSha256 };
    if (receipt.state === 'receipt_created') {
        if (!verifyReceiptStage(receipt, facts, request, event, consumer)) {
            return { settled: false, code: 'oid_terminal_control_receipt_hash_mismatch' };
        }
        if (matchingConsumer(consumer, facts, receiptRequest)) {
            const next = { ...consumer, server: { ...consumer.server, phase: 'rolled_back', terminalAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
            durableJson(files.consumer, next);
        } else if (!matchingConsumer(consumer, facts, receiptRequest, true)) {
            return { settled: false, code: 'oid_terminal_control_consumer_mismatch' };
        }
        const terminalConsumer = readRegularJson(files.consumer);
        receipt = { ...receipt, state: 'consumer_terminal', consumerTerminalSha256: sha256(terminalConsumer), consumerTerminalAt: new Date().toISOString() };
        durableJson(files.receipt, receipt);
    }
    if (receipt.state === 'consumer_terminal') {
        const terminalConsumer = readRegularJson(files.consumer);
        if (!verifyReceiptStage(receipt, facts, request, event, terminalConsumer)) return { settled: false, code: 'oid_terminal_control_receipt_hash_mismatch' };
        if (request && !matchingRequest(request, facts)) return { settled: false, code: 'oid_terminal_control_request_mismatch' };
        if (event && !matchingEvent(event, facts, receiptRequest)) return { settled: false, code: 'oid_terminal_control_event_mismatch' };
        receipt = { ...receipt, state: 'controls_clear_started', controlsClearingAt: new Date().toISOString() };
        durableJson(files.receipt, receipt);
    }
    if (receipt.state === 'controls_clear_started') {
        const terminalConsumer = readRegularJson(files.consumer);
        if (!verifyReceiptStage(receipt, facts, request, event, terminalConsumer)) return { settled: false, code: 'oid_terminal_control_receipt_hash_mismatch' };
        unlinkDurable(files.request); unlinkDurable(files.event);
        receipt = { ...receipt, state: 'controls_cleared', controlsClearedAt: new Date().toISOString() };
        durableJson(files.receipt, receipt);
    }
    const finalConsumer = readRegularJson(files.consumer);
    if (receipt.state === 'controls_cleared' && verifyReceiptStage(receipt, facts, null, null, finalConsumer)
        && matchingConsumer(finalConsumer, facts, receiptRequest, true) && !existsSync(files.request) && !existsSync(files.event)) {
        // Never acquire the ledger lock while this child owns the event lock:
        // flock locks are not re-entrant across processes.  The parent records
        // this exact durable terminal outcome after the event lock is released.
        if (facts.ledgerEvent) applyPreviewLedgerEvent(root, facts.ledgerEvent);
        return { settled: true, code: 'oid_candidate_rolled_back' };
    }
    return { settled: false, code: 'oid_terminal_control_incomplete' };
}

/**
 * Settle an exactly-proven control remnant while the caller already owns the
 * shared event and ledger locks.  This is deliberately separate from the
 * public wrapper so compound recoveries never attempt a non-reentrant flock.
 */
export function settleTerminalOidControlLocked(root, facts, initialSnapshot = null) {
    return settleLocked(root, facts, initialSnapshot);
}

/** Lock, prove, and settle only exact terminal OID owner-control remnants. */
export function reconcileTerminalOidControl(root, facts) {
    let initialSnapshot;
    try { initialSnapshot = snapshotControls(root, facts); } catch { return { settled: false, code: 'legacy_control_changed' }; }
    const files = paths(root, facts.sequence, facts.nonce);
    const payload = Buffer.from(JSON.stringify({ facts, initialSnapshot })).toString('base64url');
    const ledgerLock = gitControlPath(root, 'nassaj-local-preview-ledger.lock');
    const result = spawnSync('flock', ['-x', '-w', '5', '-F', files.lock, 'flock', '-x', '-w', '5', '-F', ledgerLock,
        process.execPath, fileURLToPath(import.meta.url), '--apply', root, payload], { encoding: 'utf8' });
    if (result.status !== 0) return { settled: false, code: 'oid_terminal_control_lock_failed' };
    try { return JSON.parse(String(result.stdout).trim()); } catch { return { settled: false, code: 'oid_terminal_control_invalid_result' }; }
}

async function withEventLock(root, operation) {
    const lock = paths(root, 1, '0'.repeat(64)).lock;
    const holder = spawn('flock', ['-x', '-w', '10', lock, process.execPath, '-e',
        "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    holder.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
        let stdout = '';
        const ready = (chunk) => { stdout += chunk; if (stdout.includes('locked\n')) { holder.stdout.off('data', ready); resolve(); } };
        holder.stdout.on('data', ready);
        holder.once('error', reject);
        holder.once('exit', (code) => reject(new Error(`terminal event lock exited before acquisition (${code}): ${stderr}`)));
    });
    try { return await operation(); } finally {
        holder.stdin.end();
        await new Promise((resolve, reject) => {
            holder.once('error', reject);
            holder.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`terminal event lock release failed (${code}): ${stderr}`)));
        });
    }
}

/** Test-only factory. Production always uses the fixed synchronous wrapper above. */
export function createTerminalOidControlReconciler({ fs = realFs, testHooks = undefined } = {}) {
    return async function reconcileForTest(root, facts) {
        let initialSnapshot;
        try { initialSnapshot = snapshotControls(root, facts, fs); } catch { return { settled: false, code: 'legacy_control_changed' }; }
        if (testHooks?.afterInitialSnapshot) await testHooks.afterInitialSnapshot({ root, facts });
        return withEventLock(root, () => settleLocked(root, facts, initialSnapshot, fs));
    };
}

function main() {
    if (process.argv[2] !== '--apply') return;
    const payload = JSON.parse(Buffer.from(process.argv[4], 'base64url').toString('utf8'));
    const result = settleLocked(path.resolve(process.argv[3]), payload.facts, payload.initialSnapshot);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
