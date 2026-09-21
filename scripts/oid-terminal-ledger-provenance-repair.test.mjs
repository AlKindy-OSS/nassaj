#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTerminalLedgerProvenanceRepair, repairTerminalLedgerProvenance } from './oid-terminal-ledger-provenance-repair.mjs';
import { applyPreviewLedgerEvent, readPreviewLedger } from './local-preview-ledger.mjs';

const OID = '878b86c2aeb400b82252ca84f132f02a8bbc3fe9';
const CANDIDATE = 'cc017f06f0c45c82ed8ff28dd26136f87b8ecaffd54cf7921f32cafe4cba01b0';
const PREVIOUS = 'c5da8098aa7bea2aa5f71ec78f569ba19c5d5d0e53296871f4a00147c47cabae';
const STALE = '5ab667a6c1233259b63c4bfa61e6832d2d73b299c454c1135450125b2f40910e';
const NONCE = 'a'.repeat(64);
const jsonSha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture() {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-ledger-repair-'));
    const git = path.join(root, '.git'); const candidateRoot = path.join(root, '.nassaj-local-preview', 'server-candidates', CANDIDATE);
    mkdirSync(path.join(root, 'dist-server'), { recursive: true }); mkdirSync(candidateRoot, { recursive: true });
    execFileSync('git', ['init', '--quiet', root]);
    assert.equal(execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(), git);
    writeFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', buildId: PREVIOUS, commit: 'b'.repeat(40) }));
    writeFileSync(path.join(candidateRoot, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', buildId: CANDIDATE, commit: OID, baseCommit: OID, dirty: false }));
    const request = { schemaVersion: 1, action: 'promote-and-safe-restart', sequence: 29, oid: OID, buildId: CANDIDATE, snapshotOid: OID, group: 'event-0000000000000029', controlManifestSha256: 'c'.repeat(64) };
    const event = { schema: 'nassaj-oid-control-event/v1', sequence: 29, oid: OID, buildId: CANDIDATE, snapshotOid: OID, controlManifestSha256: request.controlManifestSha256 };
    const consumer = { schemaVersion: 1, acceptedSequence: 29, acceptedOid: OID, server: { sequence: 29, oid: OID, buildId: CANDIDATE, phase: 'awaiting_owner', controlManifestSha256: request.controlManifestSha256 } };
    writeFileSync(path.join(git, 'nassaj-preview-oid-control-request-v1.json'), JSON.stringify(request));
    writeFileSync(path.join(git, 'nassaj-preview-oid-event-control-0000000000000029.json'), JSON.stringify(event));
    writeFileSync(path.join(git, 'nassaj-preview-oid-consumer-v1.json'), JSON.stringify(consumer));
    writeFileSync(path.join(git, `nassaj-oid-control-transaction-29-${NONCE}.json`), JSON.stringify({ schema: 'nassaj-oid-control-transaction/v1', state: 'rolled_back', sequence: 29, oid: OID, buildId: CANDIDATE, previousBuildId: PREVIOUS, previousOid: 'b'.repeat(40), transactionNonce: NONCE, actionId: 'action-29' }));
    writeFileSync(path.join(git, 'nassaj-oid-rollback-recovery-29-00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ schema: 'nassaj-oid-rollback-recovery/v1', state: 'rolled_back', sequence: 29, originalActionId: 'action-29', process: { command: [path.join(root, 'dist-server', 'server', 'index.js')] } }));
    writeFileSync(path.join(git, 'nassaj-preview-oid-activation-event-0000000000000022.json'), JSON.stringify({ state: 'promoted', buildId: STALE, previousPath: path.join(root, '.nassaj-local-preview', 'server-previous', 'old') }));
    applyPreviewLedgerEvent(root, { target: 'server', publisher: 'oid', sourceGeneration: 29, state: 'built', sourceBuildId: CANDIDATE, candidateBuildId: CANDIDATE, promotedBuildId: STALE, runtimeBuildId: STALE });
    const health = { status: 'ok', pid: 777, serverLoadedBuildId: PREVIOUS, serverBuildIdOnDisk: PREVIOUS, serverCandidateBuildId: CANDIDATE };
    return { root, git, health };
}

function repairForTest(health, hook) {
    return createTerminalLedgerProvenanceRepair({ fetchImpl: async () => ({ ok: true, json: async () => health }), processIdentity: () => ({ pid: health.pid, ticks: '1' }), beforeLedgerWrite: hook });
}

test('refuses any root which is not the pinned legacy provenance chain', async () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-ledger-repair-'));
    try {
        mkdirSync(path.join(root, '.git'), { recursive: true });
        await assert.rejects(() => repairTerminalLedgerProvenance(root, { fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }) }), /terminal_ledger_not_exact_legacy_state/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI refuses mutation without its exact acknowledgement', () => {
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'oid-terminal-ledger-provenance-repair.mjs');
    const result = (() => { try { execFileSync(process.execPath, [script, '--exec'], { encoding: 'utf8' }); } catch (error) { return error; } })();
    assert.match(String(result?.stderr || ''), /Acknowledgement required/);
    assert.ok(typeof repairTerminalLedgerProvenance === 'function');
});

test('repairs the exact terminal chain, then settles its controls idempotently', async () => {
    const value = fixture();
    try {
        const repair = repairForTest(value.health);
        assert.equal((await repair(value.root)).settled, 'oid_candidate_rolled_back');
        assert.equal(readPreviewLedger(value.root).serverState, 'failed');
        assert.equal(existsSync(path.join(value.git, 'nassaj-preview-oid-control-request-v1.json')), false);
        assert.equal(JSON.parse(readFileSync(path.join(value.git, 'nassaj-preview-oid-consumer-v1.json'))).server.phase, 'rolled_back');
        assert.equal((await repair(value.root)).repaired, true, 'durable receipt resumes rather than reapplying a mutation');
    } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('rejects a tampered receipt and a proof/write race without clearing controls', async () => {
    for (const mode of ['receipt', 'race']) {
        const value = fixture();
        try {
            if (mode === 'receipt') writeFileSync(path.join(value.git, `nassaj-oid-terminal-ledger-repair-29-${NONCE}.json`), JSON.stringify({ schema: 'nassaj-oid-terminal-ledger-repair/v1', state: 'prepared', sequence: 29, transactionNonce: NONCE, eventSha256: '0'.repeat(64) }));
            const repair = repairForTest(value.health, mode === 'race' ? () => applyPreviewLedgerEvent(value.root, { target: 'server', publisher: 'oid', sourceGeneration: 29, state: 'observed', sourceBuildId: CANDIDATE, candidateBuildId: CANDIDATE, promotedBuildId: PREVIOUS, runtimeBuildId: PREVIOUS }) : undefined);
            await assert.rejects(() => repair(value.root), mode === 'receipt' ? /receipt_mismatch/ : /terminal_ledger_changed/);
            assert.equal(existsSync(path.join(value.git, 'nassaj-preview-oid-control-request-v1.json')), true);
        } finally { rmSync(value.root, { recursive: true, force: true }); }
    }
});

test('rejects incomplete and out-of-stage durable receipts on resume', async () => {
    const value = fixture();
    const receiptFile = path.join(value.git, `nassaj-oid-terminal-ledger-repair-29-${NONCE}.json`);
    try {
        const repair = repairForTest(value.health);
        await repair(value.root);
        const settled = JSON.parse(readFileSync(receiptFile));
        for (const mutate of [
            (receipt) => ({ ...receipt, state: 'unknown' }),
            ({ controlAfterSha256, ...receipt }) => receipt,
            (receipt) => ({ ...receipt, state: 'ledger_repaired' }),
        ]) {
            writeFileSync(receiptFile, JSON.stringify(mutate(settled)));
            await assert.rejects(() => repair(value.root), /terminal_ledger_receipt_mismatch/);
        }
    } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('rejects forged terminal-control hashes while controls are settling or settled', async () => {
    for (const state of ['controls_settling', 'settled']) {
        const value = fixture();
        const receiptFile = path.join(value.git, `nassaj-oid-terminal-ledger-repair-29-${NONCE}.json`);
        const controlReceiptFile = path.join(value.git, `nassaj-oid-terminal-control-29-${NONCE}.json`);
        try {
            const repair = repairForTest(value.health);
            await repair(value.root);
            const controlReceipt = JSON.parse(readFileSync(controlReceiptFile));
            controlReceipt.requestSha256 = '0'.repeat(64);
            controlReceipt.eventSha256 = '1'.repeat(64);
            writeFileSync(controlReceiptFile, JSON.stringify(controlReceipt));
            const receipt = JSON.parse(readFileSync(receiptFile));
            const forged = {
                ...receipt,
                state,
                // An attacker can recompute the outer proof digest, so this
                // regression verifies the terminal receipt's own pre-clear
                // request/event hashes are independently pinned.
                ...(state === 'settled' ? { controlAfterSha256: { ...receipt.controlAfterSha256, terminalReceipt: jsonSha256(controlReceipt) } } : {}),
            };
            writeFileSync(receiptFile, JSON.stringify(forged));
            await assert.rejects(() => repair(value.root), /terminal_ledger_receipt_mismatch/);
        } finally { rmSync(value.root, { recursive: true, force: true }); }
    }
});

test('requires ledger repair receipt version one for every resume state', async () => {
    const value = fixture();
    const receiptFile = path.join(value.git, `nassaj-oid-terminal-ledger-repair-29-${NONCE}.json`);
    try {
        const repair = repairForTest(value.health);
        await repair(value.root);
        const settled = JSON.parse(readFileSync(receiptFile));
        for (const version of [undefined, 0, 2]) {
            const forged = { ...settled, version };
            writeFileSync(receiptFile, JSON.stringify(forged));
            await assert.rejects(() => repair(value.root), /terminal_ledger_receipt_mismatch/);
        }
    } finally { rmSync(value.root, { recursive: true, force: true }); }
});
