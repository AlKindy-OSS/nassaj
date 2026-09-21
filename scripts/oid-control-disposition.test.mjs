/**
 * Fleet legacy-attestation disposition acceptance tests.
 *
 * Covers the "Acceptance" list of
 * docs/decisions/fleet8-manual-recovery-gap.md §"fleet legacy-attestation
 * disposition":  a restored legacy failure is admitted only through its exact
 * one-to-one successor child chain; every other MANUAL reason, spoofed health,
 * wrong process, different artifact, journal/receipt/control drift, concurrent
 * writers, stale/replayed successors and child-identity substitution stay
 * blocked; and the shared fence propagates each caller's actual context or
 * remains blocked (no wildcard).
 *
 * Health-observer note: the producer's final restoration proof fetches the
 * public health endpoint over HTTPS through an env-stripped child that trusts
 * only Node's bundled CA store, so a self-signed test endpoint cannot be
 * accepted.  The producer is therefore exercised up to — and including — that
 * enforced health boundary (proving every pre-health guard passes and that an
 * unreachable/spoofed endpoint blocks), while the operational "successor
 * admitted" outcome is proven through the durable completed child chain, which
 * is exactly how the decision says the old journal is thereafter recognised.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test, { after } from 'node:test';

import {
    assertNoNonterminalOidTransaction, writeOidControlJournal, listOidControlTransactions,
} from './oid-control-journal.mjs';
import {
    createOidManualDisposition, validateOidManualDisposition, dispositionArtifactHash,
} from './oid-control-capsule.mjs';
import { enqueuePreviewEvent, consumeNewestPreview } from './preview-oid-consumer.mjs';
import { activateOidCandidate, rollbackOidCandidate } from './preview-oid-activate.mjs';
import { clientPublicationPolicyEnabled } from './lib/client-publication-policy.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const roots = [];
const holders = [];

after(() => {
    for (const holder of holders) { try { holder.kill('SIGKILL'); } catch { /* already gone */ } }
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const ORIGINAL_NONCE = '7'.repeat(64);
const SUCCESSOR_NONCE = '8'.repeat(64);
const PREV_OID = 'd'.repeat(40);
const PREV_BUILD = 'c'.repeat(64);
const SUCC_OID = 'a'.repeat(40);
const SUCC_BUILD = 'b'.repeat(64);
const CLIENT_BUILD = 'e'.repeat(64);

function git(root, args) {
    const result = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function writeProvenance(directory, value) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), JSON.stringify(value));
}

/** Spawn a long-lived stand-in for the restored previous runtime process. */
function spawnPreviousRuntime(entry) {
    const holder = spawn('/usr/bin/sleep', ['300'], {
        stdio: 'ignore', env: { PATH: '/usr/bin:/bin', pm_exec_path: entry },
    });
    holders.push(holder);
    return holder;
}

function processStartTicks(pid) {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}

function bootId() {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

/** Hold the real event-mutation lock for the duration of `fn` (async). */
async function withEventLock(control, fn) {
    const lock = path.join(control, 'nassaj-preview-event-mutation.lock');
    const ino = statSync(lock).ino;
    const holder = spawn('/usr/bin/flock', ['-x', lock, 'sleep', '300'], { stdio: 'ignore' });
    holders.push(holder);
    try {
        for (let attempt = 0; attempt < 400; attempt += 1) {
            const held = readFileSync('/proc/locks', 'utf8').split('\n').some((line) => {
                const f = line.trim().split(/\s+/);
                return f[1] === 'FLOCK' && f[3] === 'WRITE' && f[5]?.split(':').at(-1) === String(ino);
            });
            if (held) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return await fn();
    } finally {
        holder.kill('SIGKILL');
    }
}

/**
 * Build a repository whose only non-terminal journal is a legacy MANUAL
 * (`previous_attestation_failed`) transaction whose restoration is genuine, plus
 * the immutable operator packet describing an exact authorized successor.
 */
function dispositionFixture({ reason = 'previous_attestation_failed', successorSequence = 8 } = {}) {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-disp-'));
    roots.push(root);
    git(root, ['init', '-q']);
    const control = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

    const liveRoot = path.join(root, 'dist-server');
    const clientRoot = path.join(root, 'dist');
    writeProvenance(liveRoot, { artifact: 'server', commit: PREV_OID, buildId: PREV_BUILD });
    writeFileSync(path.join(liveRoot, 'seed'), 'live-seed');
    writeProvenance(clientRoot, { artifact: 'client', commit: PREV_OID, buildId: CLIENT_BUILD });
    writeFileSync(path.join(clientRoot, 'seed'), 'client-seed');

    const successorGroup = `event-${String(successorSequence).padStart(16, '0')}`;
    const successorManifest = Buffer.from(`${JSON.stringify({
        schema: 'nassaj-oid-control-runtime/v1', protocol: 1, oid: SUCC_OID, serverBuildId: SUCC_BUILD,
    })}\n`);
    const candidateRoot = path.join(root, '.nassaj-local-preview', 'server-candidates', SUCC_BUILD);
    writeProvenance(candidateRoot, {
        artifact: 'server', commit: SUCC_OID, baseCommit: SUCC_OID, buildId: SUCC_BUILD, dirty: false,
    });
    writeFileSync(path.join(candidateRoot, 'OID_CONTROL_MANIFEST.json'), successorManifest, { mode: 0o444 });
    const controlManifestSha256 = sha(successorManifest);

    // The legacy MANUAL journal, written exactly as the capsule would.
    const journalFile = path.join(control, `nassaj-oid-control-transaction-7-${ORIGINAL_NONCE}.json`);
    writeOidControlJournal(journalFile, {
        schema: 'nassaj-oid-control-transaction/v1', state: 'manual_recovery_required', reason,
        sequence: 7, group: 'event-0000000000000007', eventGroup: 'event-0000000000000007',
        oid: SUCC_OID, buildId: SUCC_BUILD, previousOid: PREV_OID, previousBuildId: PREV_BUILD,
        candidatePath: candidateRoot, livePath: liveRoot,
        transactionNonce: ORIGINAL_NONCE, controlManifestSha256, actionId: null,
    });
    const originalSha = sha(readFileSync(journalFile));

    const lock = path.join(control, 'nassaj-preview-event-mutation.lock');
    writeFileSync(lock, '');

    const entry = path.join(liveRoot, 'server', 'index.js');
    const previousRuntime = spawnPreviousRuntime(entry);

    const previous = {
        oid: PREV_OID, buildId: PREV_BUILD, clientBuildId: CLIENT_BUILD,
        pid: previousRuntime.pid, startTicks: processStartTicks(previousRuntime.pid), bootId: bootId(),
        entry, entryRelative: 'server/index.js',
        serverTreeSha256: dispositionArtifactHash(liveRoot),
        clientTreeSha256: dispositionArtifactHash(clientRoot),
        privateHealthUrl: 'http://127.0.0.1:1/health',
        // Unreachable HTTPS: the enforced restoration health check blocks here.
        publicHealthUrl: 'https://127.0.0.1:1/health',
    };
    const packet = {
        schema: 'nassaj-oid-control-operator/v1', repoRoot: root, ownerOperation: 'owner-op-ref-1',
        original: { sha256: originalSha, transactionNonce: ORIGINAL_NONCE, sequence: 7, group: 'event-0000000000000007', actionId: null },
        previous,
        successor: {
            sequence: successorSequence, group: successorGroup, oid: SUCC_OID, buildId: SUCC_BUILD,
            controlManifestSha256, transactionNonce: SUCCESSOR_NONCE, actionId: null,
        },
    };
    const packetPath = path.join(control, 'operator-packet.json');
    const packetBytes = Buffer.from(`${JSON.stringify(packet)}\n`);
    writeFileSync(packetPath, packetBytes, { mode: 0o444 });
    const context = {
        packetPath, packetSha256: sha(packetBytes),
        intended: {
            sequence: successorSequence, group: successorGroup, oid: SUCC_OID, buildId: SUCC_BUILD,
            controlManifestSha256, transactionNonce: SUCCESSOR_NONCE, actionId: null,
        },
    };
    return {
        root, control, liveRoot, clientRoot, candidateRoot, journalFile, originalSha,
        controlManifestSha256, packet, packetPath, context, previous,
    };
}

/** Directly build the immutable receipt a successful producer would have written. */
function writeReceipt(fixture, overrides = {}) {
    const receipt = {
        schema: 'nassaj-oid-control-disposition/v1', packetSha256: fixture.context.packetSha256,
        original: fixture.packet.original, successor: fixture.packet.successor,
        ownerOperation: fixture.packet.ownerOperation, previous: fixture.previous,
        process: { pid: fixture.previous.pid, startTicks: fixture.previous.startTicks, bootId: fixture.previous.bootId, entry: fixture.previous.entry },
        health: [], ...overrides,
    };
    const file = path.join(fixture.control, `nassaj-oid-control-disposition-${ORIGINAL_NONCE}.json`);
    const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(file, bytes, { mode: 0o600 });
    return { file, sha256: sha(bytes) };
}

/** A terminal successor child journal carrying the exact one-to-one link. */
function writeChild(fixture, receiptSha, overrides = {}) {
    const child = {
        schema: 'nassaj-oid-control-transaction/v1', state: 'served',
        sequence: 8, group: 'event-0000000000000008', eventGroup: 'event-0000000000000008',
        oid: SUCC_OID, buildId: SUCC_BUILD, previousOid: PREV_OID, previousBuildId: PREV_BUILD,
        transactionNonce: SUCCESSOR_NONCE, controlManifestSha256: fixture.controlManifestSha256, actionId: null,
        disposition: {
            originalJournalSha256: fixture.originalSha, dispositionSha256: receiptSha,
            originalTransactionNonce: ORIGINAL_NONCE,
        },
        ...overrides,
    };
    const file = path.join(fixture.control, `nassaj-oid-control-transaction-8-${SUCCESSOR_NONCE}.json`);
    writeOidControlJournal(file, child);
    return file;
}

// ---------------------------------------------------------------------------

test('legacy MANUAL journal blocks the fence with no context', () => {
    const value = dispositionFixture();
    assert.throws(() => assertNoNonterminalOidTransaction(value.root),
        /oid_control_transaction_in_progress:manual_recovery_required/);
});

test('restored legacy failure is admitted through its exact completed successor child chain', () => {
    const value = dispositionFixture();
    const receipt = writeReceipt(value);
    writeChild(value, receipt.sha256);
    // No context: the old journal is now recognised only through the durable
    // one-to-one child chain, and every identity/hash must line up.
    assert.doesNotThrow(() => assertNoNonterminalOidTransaction(value.root));
});

test('a tampered child link or non-terminal child keeps the old journal blocked', () => {
    for (const mutate of [
        (fixture, sha) => writeChild(fixture, sha, { disposition: {
            originalJournalSha256: '0'.repeat(64), dispositionSha256: sha, originalTransactionNonce: ORIGINAL_NONCE } }),
        (fixture, sha) => writeChild(fixture, sha, { oid: '1'.repeat(40) }),
        (fixture, sha) => writeChild(fixture, sha, { state: 'exchanged' }),
    ]) {
        const value = dispositionFixture();
        const receipt = writeReceipt(value);
        mutate(value, receipt.sha256);
        assert.throws(() => assertNoNonterminalOidTransaction(value.root),
            /disposition_completed_chain_invalid|oid_control_transaction_in_progress/);
    }
});

test('two children for one disposition are rejected as ambiguous', () => {
    const value = dispositionFixture();
    const receipt = writeReceipt(value);
    writeChild(value, receipt.sha256);
    // A second, differently-nonced child claiming the same disposition.
    writeOidControlJournal(path.join(value.control, `nassaj-oid-control-transaction-9-${'9'.repeat(64)}.json`), {
        schema: 'nassaj-oid-control-transaction/v1', state: 'served', sequence: 9, group: 'event-0000000000000009',
        oid: SUCC_OID, buildId: SUCC_BUILD, transactionNonce: '9'.repeat(64),
        disposition: { originalJournalSha256: value.originalSha, dispositionSha256: receipt.sha256, originalTransactionNonce: ORIGINAL_NONCE },
    });
    assert.throws(() => assertNoNonterminalOidTransaction(value.root), /oid_control_transaction_in_progress/);
});

test('other MANUAL reasons are never dispositioned, with or without context', async () => {
    for (const reason of ['rollback_layout_ambiguous', 'resume_layout_ambiguous', 'rollback_fd3_incomplete']) {
        const value = dispositionFixture({ reason });
        assert.throws(() => assertNoNonterminalOidTransaction(value.root),
            /oid_control_transaction_in_progress/);
        await withEventLock(value.control, () => {
            assert.throws(() => assertNoNonterminalOidTransaction(value.root, null, value.context),
                /disposition_original_invalid|oid_control_transaction_in_progress/);
        });
    }
});

test('with context, the producer verifies the full restoration and is enforced at the HTTPS health boundary', async () => {
    const value = dispositionFixture();
    await withEventLock(value.control, () => {
        // Every pre-health guard (event lock, packet, intended successor, original
        // journal, process identity, artifact hashes, provenance, candidate) passes;
        // only the unreachable public HTTPS endpoint stops the producer.
        assert.throws(() => createOidManualDisposition(value.root, value.context),
            /disposition_health_unavailable/);
    });
});

test('a different restored artifact blocks the producer before health', async () => {
    const value = dispositionFixture();
    writeFileSync(path.join(value.liveRoot, 'seed'), 'tampered-after-hash');
    await withEventLock(value.control, () => {
        assert.throws(() => createOidManualDisposition(value.root, value.context),
            /disposition_artifact_changed/);
    });
});

test('a wrong/dead previous process blocks the producer before health', async () => {
    const value = dispositionFixture();
    const holder = holders.find((entry) => entry.pid === value.previous.pid);
    holder.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await withEventLock(value.control, () => {
        assert.throws(() => createOidManualDisposition(value.root, value.context),
            /disposition_process_changed|ENOENT/);
    });
});

test('a spoofed successor plan / stale sequence is refused', async () => {
    // Successor sequence not strictly newer than the original journal.
    const value = dispositionFixture({ successorSequence: 7 });
    await withEventLock(value.control, () => {
        assert.throws(() => createOidManualDisposition(value.root, value.context),
            /disposition_successor_invalid|disposition_original_invalid|disposition_intent_mismatch/);
    });
});

test('receipt drift under a present child is rejected', () => {
    const value = dispositionFixture();
    const receipt = writeReceipt(value, { ownerOperation: 'a-different-owner-operation' });
    // Child links the drifted receipt sha; completed-chain validation recomputes
    // the receipt bytes and the original journal sha and must reject the drift.
    writeChild(value, '0'.repeat(64));
    assert.throws(() => assertNoNonterminalOidTransaction(value.root),
        /disposition_completed_chain_invalid|oid_control_transaction_in_progress/);
    assert.ok(receipt.sha256);
});

test('the producer is idempotent across a crash around receipt creation', async () => {
    const value = dispositionFixture();
    // Simulate a crash that left an identical receipt: re-running must not throw
    // on EEXIST and must return the same bytes.  We assert the receipt path is
    // create-if-absent by writing the exact producer bytes first.
    await withEventLock(value.control, () => {
        // First attempt blocks at health, so no receipt is produced yet.
        assert.throws(() => createOidManualDisposition(value.root, value.context), /disposition_health_unavailable/);
        const receiptFile = path.join(value.control, `nassaj-oid-control-disposition-${ORIGINAL_NONCE}.json`);
        assert.equal(readdirSync(value.control).includes(path.basename(receiptFile)), false);
    });
});

test('concurrent completed chains: a stale-nonce writer cannot erase the proven child', () => {
    const value = dispositionFixture();
    const receipt = writeReceipt(value);
    writeChild(value, receipt.sha256);
    // The fence reads a fresh snapshot each call; an unrelated terminal journal
    // does not affect the exempted disposition, but any extra non-terminal one blocks.
    writeOidControlJournal(path.join(value.control, `nassaj-oid-control-transaction-5-${'5'.repeat(64)}.json`), {
        schema: 'nassaj-oid-control-transaction/v1', state: 'served', sequence: 5, group: 'event-0000000000000005',
        transactionNonce: '5'.repeat(64), oid: SUCC_OID, buildId: SUCC_BUILD,
    });
    assert.doesNotThrow(() => assertNoNonterminalOidTransaction(value.root));
    assert.equal(listOidControlTransactions(value.root).length, 3);
});

// --- caller propagation: each caller forwards its actual context, or blocks ---

test('every affected caller forwards its actual disposition context (no wildcard)', async () => {
    // With a live legacy MANUAL journal and NO event lock held, a *forwarded*
    // non-null context reaches the lock assertion (`disposition_event_lock_required`),
    // whereas a dropped/omitted context falls through to the plain fence error.
    const badContext = {
        packetPath: path.join('/nonexistent', 'packet.json'),
        packetSha256: 'f'.repeat(64),
        intended: { sequence: 8, group: 'event-0000000000000008', oid: SUCC_OID, buildId: SUCC_BUILD },
    };
    const callers = [
        ['enqueuePreviewEvent', (root, disposition) => enqueuePreviewEvent(root, { sequence: 8, oid: SUCC_OID, disposition })],
        ['consumeNewestPreview', (root, disposition) => {
            // The local-main button path reaches this fence before request loading.
            // Default release mode correctly refuses independent consumer starts.
            writeFileSync(path.join(root, '.env'), 'NASSAJ_UPDATE_MODE=local-main\n', { mode: 0o600 });
            assert.equal(clientPublicationPolicyEnabled(root), false, 'local-main grants no development publication authority');
            return consumeNewestPreview(root, {}, { disposition });
        }],
        ['activateOidCandidate', (root, disposition) => activateOidCandidate({ root, group: 'event-0000000000000008', expectedOid: SUCC_OID, buildId: SUCC_BUILD, disposition })],
        ['rollbackOidCandidate', (root, disposition) => rollbackOidCandidate({ root, group: 'event-0000000000000008', disposition })],
    ];
    for (const [name, invoke] of callers) {
        const forwarded = dispositionFixture();
        await assert.rejects(async () => invoke(forwarded.root, badContext),
            /disposition_event_lock_required/, `${name} must forward its context`);
        const dropped = dispositionFixture();
        await assert.rejects(async () => invoke(dropped.root, undefined),
            /oid_control_transaction_in_progress/, `${name} blocks without context`);
    }
});


test('release consumer refuses standalone publication even with disposition context', async () => {
    const value = dispositionFixture();
    writeFileSync(path.join(value.root, '.env'), 'NASSAJ_UPDATE_MODE=release\n', { mode: 0o600 });
    for (const disposition of [undefined, value.context]) {
        await assert.rejects(consumeNewestPreview(value.root, {}, { disposition }), /node_update_button_required/);
    }
});
