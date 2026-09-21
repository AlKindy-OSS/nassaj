/**
 * Isolated tests for the B-1032 adopted-live reconciliation tool and its fence
 * hook.  Every fixture is built under /var/tmp (never tmpfs), each with its own
 * `git init`, synthetic `.git/nassaj-*` control files, a fake `dist-server`/
 * `dist` with consistent provenance + manifest + sealed capsule, and (where the
 * process/health path is exercised) a real short-lived node process whose
 * `/proc` entry the tool cross-checks.  The public https health leg is injected,
 * exactly as sanctioned by the design (§4), so no real https endpoint is needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, statSync, chmodSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
    createReconcileAdoptedLiveSettler, planReconcileAdoptedLive, settleReconcileAdoptedLiveLocked,
    adoptedLiveProcess, observeAdoptedLiveHealth,
} from './oid-control-reconcile-adopted-live.mjs';
import {
    assertNoNonterminalOidTransaction, validateOidReconcileAdoptedLive, OID_RECONCILE_SCHEMA,
} from './oid-control-journal.mjs';
import { commonGitDir } from './git-control-root.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Fixed identities.  Candidate + previous are the abandoned generations; the
// live third generation must differ from both.
const NONCE = 'a'.repeat(64);
const ACTION_ID = '3ef03179-2357-46c5-b7c1-9a09ae14e149';
const CANDIDATE = { oid: 'd9b7de1f6b832c435aff2b9f76437b431417ec57', buildId: '06b0170d74372ce53253da2dbdd8c1308849f94950a17f051c577b05ba0c8736' };
const PREVIOUS = { oid: '292aaebc6440a4f47395e7e0139842842a829934', buildId: '093b496a33b3e67e4d465363cace6c50acecc7753312cbfa7263dd59125a0b9a' };
const THIRD = { oid: 'c785c6332d21e0d1fea02fd967cb03ac615efb7b', buildId: '0cb826afa3f83da47cd1ae371b0692ae8ca5c2323a0c71e4faf37cd73da76793' };
const CLIENT_BUILD = '900e3d1617a12b78337cab1b4685aec1d21151c98cba9757ccc39bc1041727b9';

const tmpRoots = [];
const liveChildren = [];

test.after(() => {
    for (const child of liveChildren) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    for (const root of tmpRoots) { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }

/** Build an isolated repo with control files + fake artifacts.  Returns paths and helpers. */
function buildFixture(overrides = {}) {
    const root = mkdtempSync(path.join('/var/tmp', 'b1032-reconcile-'));
    tmpRoots.push(root);
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0, 'git init');
    const git = commonGitDir(root);

    const serverRoot = path.join(root, 'dist-server');
    const clientRoot = path.join(root, 'dist');
    mkdirSync(path.join(serverRoot, 'server'), { recursive: true });
    mkdirSync(clientRoot, { recursive: true });

    const server = overrides.server || {};
    const serverProv = {
        artifact: 'server', version: '1.47.0.9',
        commit: server.commit || THIRD.oid, baseCommit: server.baseCommit || server.commit || THIRD.oid,
        commitShort: 'c785c633', branch: null, describe: '1.47.0.9',
        dirty: server.dirty ?? false, dirtyFiles: server.dirty ? 209 : 0,
        builtAt: '2026-09-10T16:58:25.827Z', buildId: server.buildId || THIRD.buildId,
    };
    writeFileSync(path.join(serverRoot, 'BUILD_PROVENANCE.json'), `${JSON.stringify(serverProv, null, 2)}\n`);

    // A tiny long-lived server entry: keeps /proc alive; content is hashed by the tool.
    writeFileSync(path.join(serverRoot, 'server', 'index.js'), 'setInterval(() => {}, 1e9);\n');

    const capsuleBytes = Buffer.from(overrides.capsuleBytes || '// sealed capsule stub for B-1032 test\n');
    writeFileSync(path.join(serverRoot, 'OID_CONTROL_CAPSULE.mjs'), capsuleBytes, { mode: 0o444 });

    const manifest = {
        schema: 'nassaj-oid-control-runtime/v1', protocol: 1,
        oid: overrides.manifestOid || serverProv.commit,
        serverBuildId: overrides.manifestBuildId || serverProv.buildId,
        capsuleSha256: overrides.manifestCapsuleSha256 || sha256(capsuleBytes),
        capsuleSize: capsuleBytes.length, capsuleMode: 292,
    };
    writeFileSync(path.join(serverRoot, 'OID_CONTROL_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const clientProv = { artifact: 'client', version: '1.47.0.9', commit: '6efffd41', dirty: true, dirtyFiles: 209, buildId: CLIENT_BUILD };
    writeFileSync(path.join(clientRoot, 'BUILD_PROVENANCE.json'), `${JSON.stringify(clientProv, null, 2)}\n`);

    // Control files.
    const seq = 174;
    const pad = String(seq).padStart(16, '0');
    const journalFile = path.join(git, `nassaj-oid-control-transaction-${seq}-${NONCE}.json`);
    const journal = {
        schema: 'nassaj-oid-control-transaction/v1', sequence: seq, group: `event-${pad}`, eventGroup: `event-${pad}`,
        oid: CANDIDATE.oid, buildId: CANDIDATE.buildId, previousOid: PREVIOUS.oid, previousBuildId: PREVIOUS.buildId,
        candidatePath: path.join(serverRoot, '.candidate'), livePath: serverRoot,
        transactionNonce: NONCE, controlManifestSha256: 'a0bed4d748e636a34a9d5f91d781624dde728bb403e40086a3a1bc2db53ecf32',
        oldPid: 3815531, oldStartTicks: '32969815', actionId: ACTION_ID,
        state: overrides.journalState || 'manual_recovery_required',
        reason: overrides.journalReason || 'previous_attestation_failed',
    };
    if (overrides.mutateJournal) overrides.mutateJournal(journal);
    writeJson(journalFile, journal);

    const requestFile = path.join(git, 'nassaj-preview-oid-control-request-v1.json');
    writeJson(requestFile, { schemaVersion: 1, action: 'promote-and-safe-restart', sequence: seq, oid: CANDIDATE.oid, buildId: CANDIDATE.buildId, group: `event-${pad}` });
    const eventFile = path.join(git, `nassaj-preview-oid-event-control-${pad}.json`);
    writeJson(eventFile, { schema: 'nassaj-oid-control-event/v1', sequence: seq, oid: CANDIDATE.oid, buildId: CANDIDATE.buildId });
    const consumerFile = path.join(git, 'nassaj-preview-oid-consumer-v1.json');
    writeJson(consumerFile, { schemaVersion: 1, acceptedSequence: seq, acceptedOid: CANDIDATE.oid, server: { sequence: seq, oid: CANDIDATE.oid, buildId: CANDIDATE.buildId, phase: 'awaiting_owner' } });

    const receiptFile = path.join(git, `nassaj-oid-control-reconcile-${NONCE}.json`);

    return { root, git, serverRoot, clientRoot, journalFile, requestFile, eventFile, consumerFile, receiptFile, serverProv, manifest };
}

function readProcStartTicks(pid) {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}

/** Spawn the fixture's server entry as a real process so /proc cross-checks pass. */
async function spawnLive(fx) {
    const entry = path.join(fx.serverRoot, 'server', 'index.js');
    const child = spawn(process.execPath, [entry], { stdio: 'ignore' });
    liveChildren.push(child);
    await delay(120);
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return { pid: child.pid, startTicks: readProcStartTicks(child.pid), bootId, entry, child };
}

/** Injected two-observation health matching the tool's `expected` shape. */
function healthHook(identity) {
    return (expected) => {
        assert.equal(expected.pid, identity.pid);
        const obs = {
            pid: expected.pid, serverLoadedOid: expected.commit, serverLoadedBuildId: expected.buildId,
            serverBuildIdOnDisk: expected.buildId, clientBuildIdServed: expected.clientBuildId,
            serverProcessStartTicks: String(expected.startTicks), serverTransactionNonce: NONCE,
        };
        return [obs, { ...obs }];
    };
}

function liveHooks(live) {
    return { identity: { pid: live.pid, startTicks: live.startTicks, bootId: live.bootId }, observeHealth: healthHook(live) };
}

// ===========================================================================
// Acceptance
// ===========================================================================

test('acceptance: exec settles, deletes controls first, mints write-once receipt, flips journal, fence passes', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    const hooks = liveHooks(live);

    // Fence blocks before reconciliation.
    assert.throws(() => assertNoNonterminalOidTransaction(fx.root), /manual_recovery_required/);

    const reconcile = createReconcileAdoptedLiveSettler();
    const result = await reconcile(fx.root, 'owner confirms adoption of live build (B-1032)', hooks);
    assert.equal(result.settled, true, JSON.stringify(result));
    assert.equal(result.code, 'oid_reconciled_adopted_live');

    // request + event gone; receipt present and write-once (0600).
    assert.equal(existsSync(fx.requestFile), false, 'request cleared');
    assert.equal(existsSync(fx.eventFile), false, 'event cleared');
    assert.equal(existsSync(fx.receiptFile), true, 'receipt present');
    assert.equal(statSync(fx.receiptFile).mode & 0o777, 0o600);

    const receipt = JSON.parse(readFileSync(fx.receiptFile, 'utf8'));
    assert.equal(receipt.schema, OID_RECONCILE_SCHEMA);
    assert.equal(receipt.version, 1);
    assert.equal(receipt.controlsClearedBeforeReceipt, true);
    assert.equal(receipt.transactionNonce, NONCE);
    assert.equal(receipt.adoptedLive.server.buildId, THIRD.buildId);
    assert.deepEqual(receipt.abandoned, { candidate: CANDIDATE, previous: PREVIOUS });
    assert.equal(receipt.health.length, 2);

    const journal = JSON.parse(readFileSync(fx.journalFile, 'utf8'));
    assert.equal(journal.state, 'reconciled_adopted_live');
    assert.equal(journal.reconcile.receiptSha256, sha256(readFileSync(fx.receiptFile)));
    assert.equal(journal.reconcile.adoptedBuildId, THIRD.buildId);
    // Original fields preserved.
    assert.equal(journal.oid, CANDIDATE.oid);

    // Fence now passes.
    assert.doesNotThrow(() => assertNoNonterminalOidTransaction(fx.root));

    // Idempotent re-run.
    const again = await reconcile(fx.root, 'owner confirms adoption of live build (B-1032)', hooks);
    assert.equal(again.settled, true);
    assert.equal(again.idempotent, true);
});

test('acceptance: --plan is read-only, reports fenceWouldPass, writes nothing', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    const plan = planReconcileAdoptedLive(fx.root, liveHooks(live));
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.code, 'reconcile_plan_valid');
    assert.equal(plan.fenceWouldPass, true);
    assert.equal(plan.adoptedLive.server.buildId, THIRD.buildId);
    assert.equal(plan.receiptPreview.schema, OID_RECONCILE_SCHEMA);
    // No writes.
    assert.equal(existsSync(fx.receiptFile), false);
    assert.equal(existsSync(fx.requestFile), true);
    assert.equal(existsSync(fx.eventFile), true);
    // Fence still blocks (nothing changed).
    assert.throws(() => assertNoNonterminalOidTransaction(fx.root), /manual_recovery_required/);
});

// ===========================================================================
// Rejection (all fail-closed)
// ===========================================================================

async function expectReject(fx, hooks, codeMatch) {
    const result = await createReconcileAdoptedLiveSettler()(fx.root, 'owner ack', hooks);
    assert.equal(result.settled, false, JSON.stringify(result));
    assert.match(result.code, codeMatch);
    // Nothing mutated on rejection.
    assert.equal(existsSync(fx.receiptFile), false);
    assert.equal(JSON.parse(readFileSync(fx.journalFile, 'utf8')).state, 'manual_recovery_required');
    return result;
}

test('reject: live build equals abandoned previous generation', async () => {
    const fx = buildFixture({ server: { commit: THIRD.oid, buildId: PREVIOUS.buildId } });
    await expectReject(fx, {}, /reconcile_not_third_generation/);
});

test('reject: live build equals abandoned candidate generation', async () => {
    const fx = buildFixture({ server: { commit: CANDIDATE.oid, buildId: THIRD.buildId } });
    await expectReject(fx, {}, /reconcile_not_third_generation/);
});

test('reject: server provenance dirty', async () => {
    const fx = buildFixture({ server: { dirty: true } });
    await expectReject(fx, {}, /reconcile_server_provenance_invalid/);
});

test('reject: commit != baseCommit', async () => {
    const fx = buildFixture({ server: { commit: THIRD.oid, baseCommit: '0000000000000000000000000000000000000000' } });
    await expectReject(fx, {}, /reconcile_server_provenance_invalid/);
});

test('reject: manifest serverBuildId does not match on-disk provenance', async () => {
    const fx = buildFixture({ manifestBuildId: 'f'.repeat(64) });
    await expectReject(fx, {}, /reconcile_manifest_mismatch/);
});

test('reject: sealed capsule hash does not match manifest', async () => {
    const fx = buildFixture({ manifestCapsuleSha256: 'e'.repeat(64) });
    await expectReject(fx, {}, /reconcile_sealed_capsule_mismatch/);
});

test('reject: journal reason is not previous_attestation_failed', async () => {
    const fx = buildFixture({ journalReason: 'resume_layout_ambiguous' });
    // The single non-terminal is not the expected manual target.
    const result = await createReconcileAdoptedLiveSettler()(fx.root, 'owner ack', {});
    assert.equal(result.settled, false);
    assert.match(result.code, /reconcile_target_state_invalid/);
});

test('reject: empty owner-ack', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    const result = await createReconcileAdoptedLiveSettler()(fx.root, '   ', liveHooks(live));
    assert.equal(result.settled, false);
    assert.match(result.code, /reconcile_owner_ack_invalid/);
});

test('reject: control file changes between snapshot and settle -> legacy_control_changed', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    const reconcile = createReconcileAdoptedLiveSettler({
        testHooks: { afterInitialSnapshot: async () => { await delay(20); writeJson(fx.requestFile, { tampered: true, at: Date.now() }); } },
    });
    const result = await reconcile(fx.root, 'owner ack', liveHooks(live));
    assert.equal(result.settled, false);
    assert.match(result.code, /legacy_control_changed/);
});

test('reject: pre-existing receipt with different content -> receipt_conflict', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    // A receipt already present but load-bearing content differs.
    writeJson(fx.receiptFile, { schema: OID_RECONCILE_SCHEMA, version: 1, controlsClearedBeforeReceipt: true,
        transactionNonce: NONCE, sequence: 174, group: 'event-0000000000000174', ownerOperation: 'DIFFERENT', createdAt: 'x' });
    const result = await createReconcileAdoptedLiveSettler()(fx.root, 'owner ack', liveHooks(live));
    assert.equal(result.settled, false);
    assert.match(result.code, /reconcile_receipt_conflict/);
});

test('reject: health observation count != 2', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    const hooks = { identity: { pid: live.pid, startTicks: live.startTicks, bootId: live.bootId }, observeHealth: () => [{ one: true }] };
    await expectReject(fx, hooks, /reconcile_health_observation_count/);
});

test('reject: live process startTicks mismatch (pid reused with different startTicks)', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    // Real process probe runs; identity carries a stale startTicks.
    const hooks = { identity: { pid: live.pid, startTicks: '999999999', bootId: live.bootId }, observeHealth: healthHook(live) };
    await expectReject(fx, hooks, /reconcile_process_changed/);
});

test('reject: dead pid', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    live.child.kill('SIGKILL');
    await delay(80);
    const hooks = { identity: { pid: live.pid, startTicks: live.startTicks, bootId: live.bootId }, observeHealth: healthHook(live) };
    await expectReject(fx, hooks, /reconcile_process_changed/);
});

// ===========================================================================
// qa #7 mandatory extra cases
// ===========================================================================

test('qa#7.1: a receipt for a different transaction is refused by the fence', async () => {
    const fx = buildFixture();
    // Flip the journal by hand to reconciled_adopted_live, with a receipt whose
    // transactionNonce belongs to a different transaction.
    const bogusReceipt = { schema: OID_RECONCILE_SCHEMA, version: 1, controlsClearedBeforeReceipt: true,
        transactionNonce: 'b'.repeat(64), sequence: 999, group: 'event-0000000000000999',
        originalJournalSha256: 'c'.repeat(64) };
    const bytes = Buffer.from(`${JSON.stringify(bogusReceipt, null, 2)}\n`);
    writeFileSync(fx.receiptFile, bytes, { mode: 0o600 });
    const journal = JSON.parse(readFileSync(fx.journalFile, 'utf8'));
    journal.state = 'reconciled_adopted_live';
    journal.reconcile = { receiptSha256: sha256(bytes), originalJournalSha256: bogusReceipt.originalJournalSha256, adoptedOid: THIRD.oid, adoptedBuildId: THIRD.buildId };
    writeJson(fx.journalFile, journal);

    assert.equal(validateOidReconcileAdoptedLive(fx.root, { value: journal }), false);
    assert.throws(() => assertNoNonterminalOidTransaction(fx.root), /reconciled_adopted_live_unverified/);
});

test('qa#7.2: after flip, controls are gone so no resume path can re-poison; state stays terminal + idempotent', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    const reconcile = createReconcileAdoptedLiveSettler();
    assert.equal((await reconcile(fx.root, 'owner ack', liveHooks(live))).settled, true);

    // Simulate the launcher/capsule owner-action path finding no request (cleared).
    assert.equal(existsSync(fx.requestFile), false);
    assert.equal(existsSync(fx.eventFile), false);

    // A second run does not rewrite the journal to any non-terminal state.
    const again = await reconcile(fx.root, 'owner ack', liveHooks(live));
    assert.equal(again.settled, true);
    assert.equal(JSON.parse(readFileSync(fx.journalFile, 'utf8')).state, 'reconciled_adopted_live');
    assert.doesNotThrow(() => assertNoNonterminalOidTransaction(fx.root));
});

test('qa#7.3: journal flipped without a valid receipt -> fence unverified', async () => {
    const fx = buildFixture();
    const journal = JSON.parse(readFileSync(fx.journalFile, 'utf8'));
    journal.state = 'reconciled_adopted_live';
    journal.reconcile = { receiptSha256: 'd'.repeat(64), originalJournalSha256: 'e'.repeat(64), adoptedOid: THIRD.oid, adoptedBuildId: THIRD.buildId };
    writeJson(fx.journalFile, journal);
    // No receipt file at all.
    assert.equal(existsSync(fx.receiptFile), false);
    assert.equal(validateOidReconcileAdoptedLive(fx.root, { value: journal }), false);
    assert.throws(() => assertNoNonterminalOidTransaction(fx.root), /reconciled_adopted_live_unverified/);
});

test('qa#7.4: a symlinked receipt is refused (O_NOFOLLOW / lstat)', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    assert.equal((await createReconcileAdoptedLiveSettler()(fx.root, 'owner ack', liveHooks(live))).settled, true);

    // Replace the real receipt with a symlink to a copy.
    const realBytes = readFileSync(fx.receiptFile);
    const sideCopy = path.join(fx.git, 'reconcile-copy.json');
    writeFileSync(sideCopy, realBytes, { mode: 0o600 });
    rmSync(fx.receiptFile);
    symlinkSync(sideCopy, fx.receiptFile);

    const journal = JSON.parse(readFileSync(fx.journalFile, 'utf8'));
    assert.equal(validateOidReconcileAdoptedLive(fx.root, { value: journal }), false);
    assert.throws(() => assertNoNonterminalOidTransaction(fx.root), /reconciled_adopted_live_unverified/);
});

test('qa#7.5: concurrent double exec is serialized; both succeed (one idempotent)', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    const reconcile = createReconcileAdoptedLiveSettler();
    const hooks = liveHooks(live);
    const [a, b] = await Promise.all([
        reconcile(fx.root, 'owner ack', hooks),
        reconcile(fx.root, 'owner ack', hooks),
    ]);
    assert.equal(a.settled, true, JSON.stringify(a));
    assert.equal(b.settled, true, JSON.stringify(b));
    assert.equal(JSON.parse(readFileSync(fx.journalFile, 'utf8')).state, 'reconciled_adopted_live');
    // Exactly one receipt file, valid.
    const journal = JSON.parse(readFileSync(fx.journalFile, 'utf8'));
    assert.ok(validateOidReconcileAdoptedLive(fx.root, { value: journal }));
});

test('qa#7.6: direct adoptedLiveProcess accepts a real process and rejects a changed one', async () => {
    const fx = buildFixture();
    const live = await spawnLive(fx);
    const good = { pid: live.pid, startTicks: live.startTicks, bootId: live.bootId, entry: live.entry };
    assert.deepEqual(adoptedLiveProcess(good).pid, live.pid);
    assert.throws(() => adoptedLiveProcess({ ...good, startTicks: '1' }), /reconcile_process_changed/);
    assert.throws(() => adoptedLiveProcess({ ...good, entry: '/nonexistent/entry.js' }), /reconcile_process_changed/);
    assert.throws(() => adoptedLiveProcess({ ...good, pid: 1 }), /reconcile_pid_invalid/);
});

test('observeAdoptedLiveHealth enforces private-http / public-https and rejects userinfo', () => {
    const expected = { pid: 2, startTicks: '1', buildId: THIRD.buildId, commit: THIRD.oid, clientBuildId: CLIENT_BUILD };
    assert.throws(() => observeAdoptedLiveHealth(expected, ['https://127.0.0.1/health', 'https://x/health']), /reconcile_health_url_invalid/);
    assert.throws(() => observeAdoptedLiveHealth(expected, ['http://127.0.0.1/health', 'http://x/health']), /reconcile_health_url_invalid/);
    assert.throws(() => observeAdoptedLiveHealth(expected, ['http://user:pass@127.0.0.1/health', 'https://x/health']), /reconcile_health_url_invalid/);
});
