#!/usr/bin/env node
/**
 * Repair the one legacy OID rollback whose lifecycle ledger retained an
 * unrelated, historical runtime.  This is intentionally narrower than a
 * general ledger editor: every identity in the causal chain is pinned.
 */
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { listOidControlTransactions, OID_TERMINAL_STATES } from './oid-control-journal.mjs';
import { previewControlPaths, readPreviewLedger, applyPreviewLedgerEvent } from './local-preview-ledger.mjs';
import { settleTerminalOidControlLocked } from './oid-terminal-control-reconcile.mjs';

const BUILD = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LEGACY = Object.freeze({
    sequence: 29,
    oid: '878b86c2aeb400b82252ca84f132f02a8bbc3fe9',
    candidate: 'cc017f06f0c45c82ed8ff28dd26136f87b8ecaffd54cf7921f32cafe4cba01b0',
    previous: 'c5da8098aa7bea2aa5f71ec78f569ba19c5d5d0e53296871f4a00147c47cabae',
    stale: '5ab667a6c1233259b63c4bfa61e6832d2d73b299c454c1135450125b2f40910e',
});
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function regularJson(file) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('terminal_ledger_unsafe_file');
    return JSON.parse(readFileSync(file, 'utf8'));
}

function durableJson(file, value, exclusive = false) {
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    let fd;
    try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
        fsyncSync(fd); closeSync(fd); fd = undefined;
        if (exclusive) { linkSync(temporary, file); unlinkSync(temporary); } else renameSync(temporary, file);
        const directory = openSync(path.dirname(file), constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}

function parseStartTicks(raw) {
    const end = typeof raw === 'string' ? raw.lastIndexOf(')') : -1;
    const fields = end >= 2 ? raw.slice(end + 2).trim().split(/\s+/) : [];
    return /^\d+$/.test(fields[19] || '') ? fields[19] : null;
}

function listenerInodes(port) {
    const suffix = `:${port.toString(16).padStart(4, '0').toUpperCase()}`;
    const found = new Set();
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let rows;
        try { rows = readFileSync(file, 'utf8').trim().split('\n').slice(1); } catch { continue; }
        for (const row of rows) {
            const fields = row.trim().split(/\s+/);
            if (fields[1]?.endsWith(suffix) && fields[3] === '0A' && /^\d+$/.test(fields[9] || '')) found.add(fields[9]);
        }
    }
    return found;
}

function processIdentity(root, pid, port = 3004) {
    if (!Number.isSafeInteger(Number(pid)) || Number(pid) < 2) throw new Error('terminal_ledger_pid_invalid');
    const numeric = Number(pid);
    const ticks = parseStartTicks(readFileSync(`/proc/${numeric}/stat`, 'utf8'));
    const pidRoot = `/proc/${numeric}`;
    const cwd = realpathSync(path.join(pidRoot, 'cwd'));
    const executable = realpathSync(path.join(pidRoot, 'exe'));
    const command = readFileSync(path.join(pidRoot, 'cmdline'), 'utf8').split('\0').filter(Boolean);
    const tokens = command.flatMap((part) => part.trim().split(/\s+/).filter(Boolean));
    const expected = path.join(root, 'dist-server', 'server', 'index.js');
    const sockets = listenerInodes(port);
    const owned = new Set();
    for (const fd of readdirSync(path.join(pidRoot, 'fd'))) {
        try {
            const match = readlinkSync(path.join(pidRoot, 'fd', fd)).match(/^socket:\[(\d+)\]$/);
            if (match && sockets.has(match[1])) owned.add(match[1]);
        } catch { /* descriptor may close during observation */ }
    }
    if (!ticks || cwd !== root || !path.isAbsolute(executable)
        || !tokens.some((part) => path.resolve(cwd, part) === expected) || owned.size !== 1) {
        throw new Error('terminal_ledger_process_mismatch');
    }
    return { pid: numeric, ticks, cwd, executable, command, socketInode: [...owned][0] };
}

async function health(fetchImpl = fetch) {
    const url = process.env.NASSAJ_PREVIEW_HEALTH_URL || 'http://127.0.0.1:3004/health';
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error('terminal_ledger_health_unavailable');
    const value = await response.json();
    if (value?.status !== 'ok') throw new Error('terminal_ledger_health_unavailable');
    return value;
}

function expectedLedgerEvent() {
    return { target: 'server', publisher: 'oid', sourceGeneration: LEGACY.sequence, state: 'failed',
        sourceBuildId: LEGACY.candidate, candidateBuildId: LEGACY.candidate,
        promotedBuildId: LEGACY.previous, runtimeBuildId: LEGACY.previous,
        error: { code: 'oid_candidate_rolled_back', message: 'OID candidate was rolled back and is not an active restart target.' } };
}

function controlHashes(root, transaction) {
    const { gitDirectory } = previewControlPaths(root);
    const files = [
        'nassaj-preview-oid-control-request-v1.json',
        `nassaj-preview-oid-event-control-${String(LEGACY.sequence).padStart(16, '0')}.json`,
        'nassaj-preview-oid-consumer-v1.json',
    ];
    return Object.fromEntries(files.map((name) => {
        const file = path.join(gitDirectory, name);
        return [name, existsSync(file) ? digest(regularJson(file)) : null];
    }));
}

function exactHashMap(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)
            && (value[key] === null || SHA256.test(value[key])));
}

function sameHashMap(left, right, keys) {
    return exactHashMap(left, keys) && exactHashMap(right, keys)
        && keys.every((key) => left[key] === right[key]);
}

function terminalControlProof(root, nonce, expectedControls) {
    const gitDirectory = commonGitDirectory(root);
    const request = path.join(gitDirectory, 'nassaj-preview-oid-control-request-v1.json');
    const event = path.join(gitDirectory, `nassaj-preview-oid-event-control-${String(LEGACY.sequence).padStart(16, '0')}.json`);
    const consumerFile = path.join(gitDirectory, 'nassaj-preview-oid-consumer-v1.json');
    const receiptFile = path.join(gitDirectory, `nassaj-oid-terminal-control-${LEGACY.sequence}-${nonce}.json`);
    if (existsSync(request) || existsSync(event) || !existsSync(consumerFile) || !existsSync(receiptFile)) return null;
    const consumer = regularJson(consumerFile);
    const receipt = regularJson(receiptFile);
    const manifest = receipt?.controlManifestSha256;
    const keys = ['nassaj-preview-oid-control-request-v1.json', `nassaj-preview-oid-event-control-${String(LEGACY.sequence).padStart(16, '0')}.json`, 'nassaj-preview-oid-consumer-v1.json'];
    if (!exactHashMap(expectedControls, keys)
        || consumer?.schemaVersion !== 1 || consumer.acceptedSequence !== LEGACY.sequence || consumer.acceptedOid !== LEGACY.oid
        || consumer?.server?.sequence !== LEGACY.sequence || consumer.server.oid !== LEGACY.oid
        || consumer.server.buildId !== LEGACY.candidate || consumer.server.phase !== 'rolled_back'
        || !SHA256.test(manifest || '') || consumer.server.controlManifestSha256 !== manifest
        || receipt?.schema !== 'nassaj-oid-terminal-control/v1' || receipt.version !== 1
        || receipt.state !== 'controls_cleared' || receipt.sequence !== LEGACY.sequence || receipt.oid !== LEGACY.oid
        || receipt.buildId !== LEGACY.candidate || receipt.previousBuildId !== LEGACY.previous
        || receipt.transactionNonce !== nonce || receipt.reason !== 'legacy_v1_terminal_reconciliation'
        || receipt.requestSha256 !== expectedControls['nassaj-preview-oid-control-request-v1.json']
        || receipt.eventSha256 !== expectedControls[`nassaj-preview-oid-event-control-${String(LEGACY.sequence).padStart(16, '0')}.json`]
        || !SHA256.test(receipt.consumerSha256 || '') || receipt.consumerTerminalSha256 !== digest(consumer)) return null;
    return { request: null, event: null, consumer: digest(consumer), terminalReceipt: digest(receipt) };
}

function terminalControlReceiptExists(root, nonce) {
    return existsSync(path.join(commonGitDirectory(root), `nassaj-oid-terminal-control-${LEGACY.sequence}-${nonce}.json`));
}

function receiptBaseMatches(receipt, proof, event) {
    return receipt?.schema === 'nassaj-oid-terminal-ledger-repair/v1' && receipt.version === 1 && receipt.sequence === LEGACY.sequence
        && receipt.transactionNonce === proof.transaction.transactionNonce && receipt.previousBuildId === LEGACY.previous
        && receipt.candidateBuildId === LEGACY.candidate && receipt.staleBuildId === LEGACY.stale
        && SHA256.test(receipt.ledgerBeforeSha256 || '') && receipt.eventSha256 === digest(event)
        && receipt.journalSha256 === digest(proof.transaction) && receipt.recoverySha256 === digest(proof.recovery)
        && receipt.liveProvenanceSha256 === digest(proof.provenance) && receipt.candidateProvenanceSha256 === digest(proof.candidate)
        && typeof receipt.preparedAt === 'string'
        && exactHashMap(receipt.controlBeforeSha256, ['nassaj-preview-oid-control-request-v1.json', `nassaj-preview-oid-event-control-${String(LEGACY.sequence).padStart(16, '0')}.json`, 'nassaj-preview-oid-consumer-v1.json']);
}

function validateReceiptState(receipt, proof, event, current) {
    if (!receiptBaseMatches(receipt, proof, event)) throw new Error('terminal_ledger_receipt_mismatch');
    if (receipt.state === 'prepared') {
        if (receipt.ledgerBeforeSha256 !== digest(current) || !exactStaleLedger(current)
            || !sameHashMap(receipt.controlBeforeSha256, proof.controls, Object.keys(proof.controls))) throw new Error('terminal_ledger_receipt_mismatch');
        return 'prepared';
    }
    if (receipt.state === 'ledger_repaired') {
        if (!SHA256.test(receipt.ledgerAfterSha256 || '') || receipt.ledgerAfterSha256 !== digest(current)
            || !exactRepairedLedger(current) || !sameHashMap(receipt.controlBeforeSha256, proof.controls, Object.keys(proof.controls))) {
            throw new Error('terminal_ledger_receipt_mismatch');
        }
        return 'ledger_repaired';
    }
    if (receipt.state === 'controls_settling') {
        if (!SHA256.test(receipt.ledgerAfterSha256 || '') || receipt.ledgerAfterSha256 !== digest(current)
            || !exactRepairedLedger(current)) throw new Error('terminal_ledger_receipt_mismatch');
        const terminal = terminalControlProof(proof.root, proof.transaction.transactionNonce, receipt.controlBeforeSha256);
        if (!terminal && terminalControlReceiptExists(proof.root, proof.transaction.transactionNonce)) {
            throw new Error('terminal_ledger_receipt_mismatch');
        }
        if (!terminal && !sameHashMap(receipt.controlBeforeSha256, proof.controls, Object.keys(proof.controls))) {
            throw new Error('terminal_ledger_receipt_mismatch');
        }
        return 'controls_settling';
    }
    if (receipt.state === 'settled') {
        const terminal = terminalControlProof(proof.root, proof.transaction.transactionNonce, receipt.controlBeforeSha256);
        if (!SHA256.test(receipt.ledgerAfterSha256 || '') || receipt.ledgerAfterSha256 !== digest(current)
            || !exactRepairedLedger(current) || !terminal
            || !sameHashMap(receipt.controlAfterSha256, terminal, Object.keys(terminal))) {
            throw new Error('terminal_ledger_receipt_mismatch');
        }
        return 'settled';
    }
    throw new Error('terminal_ledger_receipt_mismatch');
}

function commonGitDirectory(root) {
    const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return result.status === 0 ? path.resolve(root, String(result.stdout).trim()) : path.join(root, '.git');
}

function exactStaleLedger(ledger) {
    return ledger?.serverPublisher === 'oid' && ledger.serverSourceGeneration === LEGACY.sequence
        && ledger.serverState === 'built' && ledger.serverSourceBuildId === LEGACY.candidate
        && ledger.serverCandidateBuildId === LEGACY.candidate && ledger.serverPromotedBuildId === LEGACY.stale
        && ledger.serverLoadedBuildId === LEGACY.stale;
}

function exactRepairedLedger(ledger) {
    return ledger?.serverPublisher === 'oid' && ledger.serverSourceGeneration === LEGACY.sequence
        && ledger.serverState === 'failed' && ledger.serverSourceBuildId === LEGACY.candidate
        && ledger.serverCandidateBuildId === LEGACY.candidate && ledger.serverPromotedBuildId === LEGACY.previous
        && ledger.serverLoadedBuildId === LEGACY.previous && ledger.serverError?.code === 'oid_candidate_rolled_back';
}

function proveChain(root, ledger, healthA, healthB, processIdentityImpl = processIdentity) {
    if (!exactStaleLedger(ledger) && !exactRepairedLedger(ledger)) throw new Error('terminal_ledger_not_exact_legacy_state');
    for (const item of [healthA, healthB]) {
        if (item.serverLoadedBuildId !== LEGACY.previous || item.serverBuildIdOnDisk !== LEGACY.previous
            || item.serverCandidateBuildId !== LEGACY.candidate || !Number.isSafeInteger(Number(item.pid))) {
            throw new Error('terminal_ledger_runtime_mismatch');
        }
    }
    if (healthA.pid !== healthB.pid) throw new Error('terminal_ledger_health_changed');
    const process = processIdentityImpl(root, healthA.pid);
    const provenance = regularJson(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'));
    if (provenance?.artifact !== 'server' || provenance.buildId !== LEGACY.previous || !OID.test(provenance.commit || '')) {
        throw new Error('terminal_ledger_disk_provenance_mismatch');
    }
    const transactions = listOidControlTransactions(root);
    if (transactions.some(({ value }) => !OID_TERMINAL_STATES.has(value?.state))) throw new Error('terminal_ledger_nonterminal_transaction');
    const terminal = transactions.filter(({ value }) => value?.state === 'rolled_back' && value.sequence === LEGACY.sequence
        && value.oid === LEGACY.oid && value.buildId === LEGACY.candidate && value.previousBuildId === LEGACY.previous
        && BUILD.test(value.transactionNonce || '') && value.previousOid === provenance.commit);
    if (terminal.length !== 1) throw new Error('terminal_ledger_journal_mismatch');
    const { gitDirectory } = previewControlPaths(root);
    const candidate = regularJson(path.join(root, '.nassaj-local-preview', 'server-candidates', LEGACY.candidate, 'BUILD_PROVENANCE.json'));
    if (candidate?.artifact !== 'server' || candidate.buildId !== LEGACY.candidate || candidate.commit !== LEGACY.oid || candidate.baseCommit !== LEGACY.oid || candidate.dirty !== false) {
        throw new Error('terminal_ledger_candidate_provenance_mismatch');
    }
    if (statSync(path.join(root, 'dist-server')).dev !== statSync(path.join(root, '.nassaj-local-preview', 'server-candidates', LEGACY.candidate)).dev) {
        throw new Error('terminal_ledger_layout_device_mismatch');
    }
    const recoveryFiles = readdirSync(gitDirectory).filter((name) => new RegExp(`^nassaj-oid-rollback-recovery-${LEGACY.sequence}-[a-f0-9-]+\\.json$`).test(name))
        .map((name) => path.join(gitDirectory, name));
    if (recoveryFiles.length !== 1) throw new Error('terminal_ledger_recovery_ambiguous');
    const recovery = regularJson(recoveryFiles[0]);
    if (recovery?.schema !== 'nassaj-oid-rollback-recovery/v1' || recovery.state !== 'rolled_back'
        || recovery.sequence !== LEGACY.sequence || recovery.originalActionId !== terminal[0].value.actionId
        || recovery.process?.command?.some((part) => part.endsWith('/dist-server/server/index.js')) !== true) {
        throw new Error('terminal_ledger_recovery_mismatch');
    }
    const predecessor = regularJson(path.join(gitDirectory, `nassaj-preview-oid-activation-event-${String(22).padStart(16, '0')}.json`));
    if (predecessor?.state !== 'promoted' || predecessor.buildId !== LEGACY.stale || !String(predecessor.previousPath || '').startsWith(`${root}/.nassaj-local-preview/server-previous/`)) {
        throw new Error('terminal_ledger_stale_provenance_mismatch');
    }
    const staleCandidate = path.join(root, '.nassaj-local-preview', 'server-candidates', LEGACY.stale);
    if (existsSync(staleCandidate) || healthA.serverLoadedBuildId === LEGACY.stale || transactions.some(({ value }) => value?.buildId === LEGACY.stale)) {
        throw new Error('terminal_ledger_stale_identity_not_retired');
    }
    return { root, process, transaction: terminal[0].value, recovery, provenance, candidate,
        controls: controlHashes(root, terminal[0].value) };
}

/** Prove and repair the pinned legacy provenance, then settle its controls. */
async function repairLocked(root, { fetchImpl = fetch, testHooks = undefined } = {}) {
    const absoluteRoot = path.resolve(root);
    const firstHealth = await health(fetchImpl);
    const initial = readPreviewLedger(absoluteRoot);
    const proof = proveChain(absoluteRoot, initial, firstHealth, await health(fetchImpl), testHooks?.processIdentity);
    const { gitDirectory } = previewControlPaths(absoluteRoot);
    const receiptFile = path.join(gitDirectory, `nassaj-oid-terminal-ledger-repair-${LEGACY.sequence}-${proof.transaction.transactionNonce}.json`);
    let receipt = existsSync(receiptFile) ? regularJson(receiptFile) : null;
    const event = expectedLedgerEvent();
    if (!receipt) {
        receipt = { schema: 'nassaj-oid-terminal-ledger-repair/v1', version: 1, state: 'prepared', sequence: LEGACY.sequence,
            transactionNonce: proof.transaction.transactionNonce, previousBuildId: LEGACY.previous, candidateBuildId: LEGACY.candidate,
            staleBuildId: LEGACY.stale, ledgerBeforeSha256: digest(initial), eventSha256: digest(event),
            journalSha256: digest(proof.transaction), recoverySha256: digest(proof.recovery),
            liveProvenanceSha256: digest(proof.provenance), candidateProvenanceSha256: digest(proof.candidate),
            controlBeforeSha256: proof.controls, preparedAt: new Date().toISOString() };
        durableJson(receiptFile, receipt, true);
    }
    const current = readPreviewLedger(absoluteRoot);
    const state = validateReceiptState(receipt, proof, event, current);
    if (state === 'prepared') {
        if (!exactStaleLedger(current)) {
            if (!exactRepairedLedger(current)) throw new Error('terminal_ledger_changed');
        } else {
            // Test hook models an attempted competing writer.  Because this
            // code runs under both kernel locks, a real writer cannot enter;
            // the re-read below still makes the intended invariant explicit.
            await testHooks?.beforeLedgerWrite?.({ root: absoluteRoot });
            if (!exactStaleLedger(readPreviewLedger(absoluteRoot))) throw new Error('terminal_ledger_changed');
            applyPreviewLedgerEvent(absoluteRoot, event);
        }
    }
    const after = readPreviewLedger(absoluteRoot);
    if (!exactRepairedLedger(after)) throw new Error('terminal_ledger_write_unverified');
    if (state === 'prepared') {
        receipt = { ...receipt, state: 'ledger_repaired', ledgerAfterSha256: digest(after), repairedAt: new Date().toISOString() };
        durableJson(receiptFile, receipt);
    }
    if (receipt.state === 'ledger_repaired') {
        receipt = { ...receipt, state: 'controls_settling', controlsSettlingAt: new Date().toISOString() };
        durableJson(receiptFile, receipt);
    }
    let terminal = terminalControlProof(absoluteRoot, proof.transaction.transactionNonce, receipt.controlBeforeSha256);
    let settled = { settled: true, code: 'oid_candidate_rolled_back' };
    if (!terminal) {
        settled = settleTerminalOidControlLocked(absoluteRoot, { sequence: LEGACY.sequence, oid: LEGACY.oid,
            buildId: LEGACY.candidate, previousBuildId: LEGACY.previous, nonce: proof.transaction.transactionNonce,
            // The ledger was durably repaired above under the same lock pair.
            // Passing no event also prevents a control-resume from replaying it.
        });
        if (!settled.settled) throw new Error(`terminal_ledger_control_settlement_failed:${settled.code}`);
        terminal = terminalControlProof(absoluteRoot, proof.transaction.transactionNonce, receipt.controlBeforeSha256);
    }
    if (!terminal) throw new Error('terminal_ledger_terminal_controls_unverified');
    if (receipt.state === 'controls_settling') durableJson(receiptFile, { ...receipt, state: 'settled', controlAfterSha256: terminal, settledAt: new Date().toISOString() });
    return { repaired: true, settled: settled.code, pid: proof.process.pid, ticks: proof.process.ticks };
}

/**
 * Repair the one pinned legacy provenance discrepancy.  Production enters a
 * child that owns event then ledger locks for the whole proof/write/settle
 * transaction.  Tests can supply an in-process health implementation.
 */
export async function repairTerminalLedgerProvenance(root, options = {}) {
    if (options.fetchImpl || options.testHooks) return repairLocked(root, options);
    const absoluteRoot = path.resolve(root);
    const gitDirectory = commonGitDirectory(absoluteRoot);
    const result = spawnSync('flock', ['-x', '-w', '10', '-F', path.join(gitDirectory, 'nassaj-preview-event-mutation.lock'),
        'flock', '-x', '-w', '10', '-F', path.join(gitDirectory, 'nassaj-local-preview-ledger.lock'),
        process.execPath, fileURLToPath(import.meta.url), '--apply-locked', absoluteRoot], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(String(result.stderr || 'terminal_ledger_lock_failed').trim());
    try { return JSON.parse(String(result.stdout).trim()); } catch { throw new Error('terminal_ledger_invalid_result'); }
}

/** Test adapter: production callers cannot bypass the kernel lock wrapper. */
export function createTerminalLedgerProvenanceRepair({ fetchImpl, processIdentity: identity, beforeLedgerWrite } = {}) {
    return (root) => repairLocked(root, { fetchImpl, testHooks: { processIdentity: identity, beforeLedgerWrite } });
}

async function main() {
    if (process.argv[2] === '--apply-locked' && process.argv.length === 4) {
        process.stdout.write(`${JSON.stringify(await repairLocked(process.argv[3]))}\n`);
        return;
    }
    if (process.argv[2] === '--check' && process.argv.length === 3) {
        const first = await health();
        const proof = proveChain(process.cwd(), readPreviewLedger(process.cwd()), first, await health());
        process.stdout.write(`${JSON.stringify({ checked: true, pid: proof.process.pid, ticks: proof.process.ticks })}\n`);
        return;
    }
    if (process.argv[2] !== '--exec' || process.argv[3] !== '--acknowledge-terminal-ledger-repair' || process.argv.length !== 4) {
        throw new Error('Acknowledgement required: oid-terminal-ledger-provenance-repair.mjs --exec --acknowledge-terminal-ledger-repair');
    }
    process.stdout.write(`${JSON.stringify(await repairTerminalLedgerProvenance(process.cwd()))}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
